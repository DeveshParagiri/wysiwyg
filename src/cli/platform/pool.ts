import { existsSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Finding, ScanResult } from "../../core/types.js";
import { type FileScanOptions, scanFile } from "../scan-file.js";
import type { WalkedFile } from "./fs.js";

/**
 * Scan files across CPU cores.
 *
 * Small jobs run on the main thread (worker start-up isn't free). Large jobs
 * use a pool of workers fed from a shared queue. Each file has a time limit:
 * a file that stalls a worker is reported (evasion/scan-timeout) and the
 * worker replaced, so a crafted slow file is flagged instead of hanging CI.
 */

const MIN_FILES_FOR_WORKERS = 64;
const FILE_TIMEOUT_MS = 30_000;

export type ProgressFn = (done: number, total: number) => void;

/**
 * CPU count, defensively: under Bun, availableParallelism() returns undefined
 * once pdfjs has run (it replaces `navigator`), which would size the pool to NaN.
 */
function cores(): number {
  const n = Number(availableParallelism?.());
  return Number.isFinite(n) && n > 0 ? n : Math.max(1, cpus().length);
}

/** The worker script: compiled `scan-worker.js` next to the bundle, or the .ts source under Bun. */
function workerPath(): string | null {
  for (const name of ["./scan-worker.js", "./scan-worker.ts"]) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

function failure(file: WalkedFile, ruleId: string, message: string): ScanResult {
  const finding: Finding = {
    ruleId,
    type: "scanner_evasion",
    severity: "warning",
    message,
    humanView: "",
    agentView: "",
  };
  return { source: file.display ?? file.path, findings: [finding], clean: false };
}

async function scanSequential(
  files: WalkedFile[],
  opts: FileScanOptions,
  onProgress: ProgressFn,
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const [i, file] of files.entries()) {
    try {
      results.push(await scanFile(file, opts));
    } catch (err) {
      results.push(
        failure(file, "scan/error", `Could not scan: ${err instanceof Error ? err.message : err}`),
      );
    }
    onProgress(i + 1, files.length);
  }
  return results;
}

export async function scanFiles(
  files: WalkedFile[],
  opts: FileScanOptions,
  onProgress: ProgressFn = () => {},
): Promise<ScanResult[]> {
  const size = Math.min(Math.max(1, cores() - 1), 8, Math.ceil(files.length / 32));
  const script = workerPath();
  if (files.length < MIN_FILES_FOR_WORKERS || size <= 1 || !script) {
    return scanSequential(files, opts, onProgress);
  }

  const results: ScanResult[] = new Array(files.length);
  let next = 0;
  let done = 0;

  await new Promise<void>((resolveAll) => {
    const finish = (i: number, r: ScanResult) => {
      if (results[i]) return;
      results[i] = r;
      done++;
      onProgress(done, files.length);
      if (done === files.length) resolveAll();
    };

    const spawn = () => {
      if (next >= files.length) return;
      const worker = new Worker(script);
      let current = -1;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const feed = () => {
        if (next >= files.length) {
          void worker.terminate();
          return;
        }
        current = next++;
        timer = setTimeout(() => {
          // Stalled: report the file, replace the worker, keep going.
          void worker.terminate();
          finish(
            current,
            failure(
              files[current],
              "evasion/scan-timeout",
              `Scanning took over ${FILE_TIMEOUT_MS / 1000}s and was stopped — inspect this file manually`,
            ),
          );
          spawn();
        }, FILE_TIMEOUT_MS);
        worker.postMessage({ id: current, file: files[current], opts });
      };

      worker.on("message", ({ id, result, error }: { id: number; result?: ScanResult; error?: string }) => {
        clearTimeout(timer);
        finish(id, result ?? failure(files[id], "scan/error", `Could not scan: ${error}`));
        feed();
      });
      worker.on("error", (err: Error) => {
        clearTimeout(timer);
        if (current >= 0)
          finish(current, failure(files[current], "scan/error", `Worker crashed: ${err.message}`));
        void worker.terminate();
        spawn();
      });
      feed();
    };

    for (let k = 0; k < size; k++) spawn();
  });
  return results;
}
