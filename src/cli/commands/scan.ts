import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { analyzeClipboardHTML } from "../../core/clipboard.js";
import { DEFAULT_CONFIG, MAX_FILE_SIZE } from "../../core/constants/index.js";
import { detectKind, scanBytes, scanText } from "../../core/pipeline.js";
import { isClean, meetsThreshold } from "../../core/policy.js";
import type { Finding, OutputFormat, ScanResult, Severity } from "../../core/types.js";
import { type LoadedConfig, loadConfig } from "../config/loader.js";
import { formatFindings } from "../output/formatter.js";
import { writeOut } from "../output/write.js";
import { readClipboardHTML } from "../platform/clipboard.js";
import { readFileForScan, type WalkedFile, walkDirectory } from "../platform/fs.js";
import { changedFiles } from "../platform/git.js";

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

/** Scan one file from disk. */
export async function scanFile(
  file: WalkedFile,
  opts: { expectedScripts?: string[]; maxBytes?: number } = {},
): Promise<ScanResult> {
  const read = await readFileForScan(file.path, opts.maxBytes);
  const findings = await scanBytes(read.bytes, { path: file.rel, expectedScripts: opts.expectedScripts });
  if (read.truncated && detectKind(file.rel, read.bytes) !== "binary") {
    findings.push({
      ruleId: "evasion/oversized",
      type: "scanner_evasion",
      severity: "warning",
      message: `File is ${(read.size / 1048576).toFixed(1)} MB; only the first ${(read.bytes.length / 1048576).toFixed(1)} MB were scanned`,
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
  return result(file.path, findings);
}

export async function scanCommand(target: string | undefined, options: ScanOptions): Promise<void> {
  const format = (options.format || "pretty") as OutputFormat;
  const targetPath = resolve(target || ".");
  const maxBytes = options.maxSize ? Math.round(parseFloat(options.maxSize) * 1048576) : MAX_FILE_SIZE;

  let loaded: Pick<LoadedConfig, "config" | "findings" | "path">;
  try {
    const startDir = statSync(targetPath, { throwIfNoEntry: false })?.isDirectory()
      ? targetPath
      : dirname(targetPath);
    loaded =
      options.config === false
        ? { config: { ...DEFAULT_CONFIG }, findings: [], path: null }
        : loadConfig(startDir, typeof options.config === "string" ? options.config : undefined);
  } catch (err) {
    console.error(`Error: cannot read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { config } = loaded;
  const failOn = (options.failOn || config.fail_on || "critical") as Severity;
  const scanOpts = { expectedScripts: config.expected_scripts, maxBytes };

  const results: ScanResult[] = [];
  if (loaded.findings.length) results.push(result(loaded.path ?? ".wysiwygrc", loaded.findings));

  try {
    if (options.stdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const findings = await scanBytes(bytes, {
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
      const st = statSync(targetPath, { throwIfNoEntry: false });
      if (!st) {
        console.error(`Error: Cannot access "${targetPath}"`);
        process.exit(2);
      }
      if (st.isFile()) {
        results.push(await scanFile({ path: targetPath, rel: basename(targetPath) }, scanOpts));
      } else {
        let files = await walkDirectory(targetPath, config.ignore ?? []);
        if (options.recursive === false) files = files.filter((f) => !f.rel.includes("/"));
        if (options.diff || options.staged) {
          const changed = await changedFiles(targetPath, { diff: options.diff, staged: options.staged });
          files = files.filter((f) => changed.has(resolve(f.path)));
        }
        if (format === "pretty")
          console.error(`Scanning ${files.length} file${files.length === 1 ? "" : "s"}…`);
        for (const file of files) results.push(await scanFile(file, scanOpts));
      }
    }

    await writeOut(formatFindings(results, format, { verbose: options.verbose, cwd: process.cwd() }));
    // exitCode, not exit(): exiting immediately can truncate large output on a pipe
    if (
      meetsThreshold(
        results.flatMap((r) => r.findings),
        failOn,
      )
    )
      process.exitCode = 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
