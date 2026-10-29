import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { analyzeClipboardHTML } from "../../core/clipboard.js";
import { DEFAULT_CONFIG, MAX_FILE_SIZE } from "../../core/constants/index.js";
import { scanBytes, scanText } from "../../core/pipeline.js";
import { isClean, meetsThreshold } from "../../core/policy.js";
import type { Finding, OutputFormat, ScanResult, Severity } from "../../core/types.js";
import { type LoadedConfig, loadConfig } from "../config/loader.js";
import { formatFindings } from "../output/formatter.js";
import { fmtCount, Progress } from "../output/progress.js";
import { writeOut } from "../output/write.js";
import { readClipboardHTML } from "../platform/clipboard.js";
import { type WalkedFile, walkDirectory } from "../platform/fs.js";
import { changedFiles } from "../platform/git.js";
import { scanFiles } from "../platform/pool.js";

export interface ScanOptions {
  recursive?: boolean;
  stdin?: boolean;
  clipboard?: boolean;
  format?: string;
  failOn?: string;
  config?: boolean | string; // --no-config → false, --config <path> → string
  verbose?: boolean;
  maxSize?: string;
  diff?: string;
  staged?: boolean;
  as?: string;
}

function result(source: string, findings: Finding[]): ScanResult {
  return { source, findings, clean: isClean(findings) };
}

function fail(message: string): never {
  console.error(`wysiwyg: ${message}`);
  process.exit(2);
}

/** Expand the targets the user named into files, shown with the paths they typed. */
async function collectFiles(
  targets: string[],
  ignore: string[],
  options: ScanOptions,
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  for (const target of targets) {
    const abs = resolve(target);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) fail(`cannot access "${target}"`);
    if (st.isFile()) {
      files.push({ path: abs, rel: basename(abs), display: target });
      continue;
    }
    let found = await walkDirectory(abs, ignore);
    if (options.recursive === false) found = found.filter((f) => !f.rel.includes("/"));
    if (options.diff || options.staged) {
      const changed = await changedFiles(abs, { diff: options.diff, staged: options.staged });
      found = found.filter((f) => changed.has(realpathSync(f.path)));
    }
    const shown = (rel: string) => (target === "." ? rel : join(target, rel));
    files.push(...found.map((f) => ({ ...f, display: shown(f.rel) })));
  }
  return files;
}

export async function scanCommand(
  targetArgs: string[] | string | undefined,
  options: ScanOptions,
): Promise<void> {
  const started = performance.now();
  const format = (options.format || "pretty") as OutputFormat;
  const targets = [targetArgs ?? []].flat();
  if (!targets.length) targets.push(".");
  const maxBytes = options.maxSize ? Math.round(parseFloat(options.maxSize) * 1048576) : MAX_FILE_SIZE;

  let loaded: Pick<LoadedConfig, "config" | "findings" | "path">;
  try {
    const first = resolve(targets[0]);
    const startDir = statSync(first, { throwIfNoEntry: false })?.isDirectory() ? first : dirname(first);
    loaded =
      options.config === false
        ? { config: { ...DEFAULT_CONFIG }, findings: [], path: null }
        : loadConfig(startDir, typeof options.config === "string" ? options.config : undefined);
  } catch (err) {
    fail(`cannot read config: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { config } = loaded;
  const failOn = (options.failOn || config.fail_on || "critical") as Severity;

  const results: ScanResult[] = [];
  if (loaded.findings.length) results.push(result(loaded.path ?? ".wysiwygrc", loaded.findings));

  const progress = new Progress();
  try {
    if (options.stdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const findings = await scanBytes(new Uint8Array(Buffer.concat(chunks)), {
        path: options.as ?? "stdin",
        expectedScripts: config.expected_scripts,
      });
      results.push(result("stdin", findings));
    } else if (options.clipboard) {
      const clipboard = await readClipboardHTML();
      const findings = scanText(clipboard.plainText, {
        path: "clipboard.txt",
        expectedScripts: config.expected_scripts,
      });
      if (clipboard.html) findings.push(...analyzeClipboardHTML(clipboard.html, clipboard.plainText));
      results.push(result("clipboard", findings));
    } else {
      progress.update("Finding files…", true);
      const files = await collectFiles(targets, config.ignore ?? [], options);
      const label = (done: number) => `Scanning ${fmtCount(done)} / ${fmtCount(files.length)} files`;
      const scanned = await scanFiles(files, { expectedScripts: config.expected_scripts, maxBytes }, (done) =>
        progress.update(label(done)),
      );
      results.push(...scanned);
    }
    progress.clear();

    const elapsedMs = performance.now() - started;
    await writeOut(
      formatFindings(results, format, { verbose: options.verbose, cwd: process.cwd(), elapsedMs }),
    );
    // exitCode, not exit(): exiting immediately can truncate large output on a pipe
    if (
      meetsThreshold(
        results.flatMap((r) => r.findings),
        failOn,
      )
    )
      process.exitCode = 1;
  } catch (err) {
    progress.clear();
    fail(err instanceof Error ? err.message : String(err));
  }
}
