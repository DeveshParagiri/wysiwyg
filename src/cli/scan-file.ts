import { open, stat } from "node:fs/promises";
import { isAgentInstructionFile } from "../core/constants/agent-files.js";
import { MAX_FILE_SIZE } from "../core/constants/index.js";
import { detectKind, scanBytes } from "../core/pipeline.js";
import { isClean } from "../core/policy.js";
import type { Finding, ScanResult } from "../core/types.js";
import type { WalkedFile } from "./platform/fs.js";

/**
 * Scan one file from disk. Shared by the main thread and the worker pool, so
 * it must not depend on CLI state.
 */

export interface FileScanOptions {
  expectedScripts?: string[];
  maxBytes?: number;
}

const SNIFF_BYTES = 8192;

async function readRange(path: string, length: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

export async function scanFile(file: WalkedFile, opts: FileScanOptions = {}): Promise<ScanResult> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_SIZE;
  const findings: Finding[] = [];
  const done = () => ({ source: file.display ?? file.path, findings, clean: isClean(findings) });

  // Sniff first: binaries (by extension or content) are never read in full.
  const { size } = await stat(file.path);
  const head = await readRange(file.path, Math.min(size, SNIFF_BYTES));
  if (detectKind(file.rel, head) === "binary") return done();
  const bytes = size <= SNIFF_BYTES ? head : await readRange(file.path, Math.min(size, maxBytes));

  findings.push(...(await scanBytes(bytes, { path: file.rel, expectedScripts: opts.expectedScripts })));

  if (size > maxBytes) {
    // Not proof of anything hidden — just that we couldn't look. It matters most for
    // files agents act on, so it's a warning there and context elsewhere.
    findings.push({
      ruleId: "evasion/oversized",
      type: "scanner_evasion",
      severity: isAgentInstructionFile(file.rel) ? "warning" : "info",
      message: `Only the first ${(maxBytes / 1048576).toFixed(0)} MB of ${(size / 1048576).toFixed(1)} MB were scanned`,
      humanView: "",
      agentView: "",
      detail: "Raise the limit with --max-size if this file is fed to agents.",
    });
  }
  if (file.outsideTarget) {
    findings.push({
      ruleId: "evasion/symlink-outside-root",
      type: "scanner_evasion",
      severity: "info",
      message: `Symlink resolves outside the scanned tree (${file.outsideTarget})`,
      humanView: "",
      agentView: "",
    });
  }
  return done();
}
