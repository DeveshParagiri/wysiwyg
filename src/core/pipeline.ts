import { scanVisibleInjection } from "./agent-file.js";
import { isAgentInstructionFile } from "./constants/agent-files.js";
import { scanHtml } from "./html/scan.js";
import { scanMarkdown } from "./markdown/scan.js";
import { scanEncoded } from "./text/encoded.js";
import { scanLayout } from "./text/layout.js";
import { scanTerminal } from "./text/terminal.js";
import { scanUnicode } from "./text/unicode.js";
import type { Finding } from "./types.js";

/**
 * Format detection and the per-file scanning pipeline.
 *
 * Every text format goes through the text layers (Unicode, terminal, layout,
 * encoded blobs) on its raw source, then through its renderer projection
 * (Markdown, HTML, SVG). Binary documents (PDF, Office) have their own
 * projections in core/documents.
 */

export type DocKind = "text" | "markdown" | "html" | "svg" | "pdf" | "ooxml" | "binary";

const MARKDOWN_EXT = /\.(md|mdx|markdown|mdown|mkd|mkdn|mdc)$/i;
const HTML_EXT = /\.(html?|xhtml|shtml)$/i;
const OOXML_EXT = /\.(docx|docm|dotx|pptx|pptm|potx|xlsx|xlsm|xltx)$/i;
/** Source code and bundles (escape sequences there are usually string literals). */
const CODE_EXT =
  /\.(m?[jt]sx?|cjs|cts|mts|py|rb|go|rs|java|kts?|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|ps1|lua|pl|r|scala|dart|map)$/i;
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|heic|mp[34]|m4a|mov|avi|mkv|webm|wav|ogg|flac|aac|zip|gz|tgz|bz2|xz|zst|7z|rar|jar|war|ear|class|so|dylib|dll|exe|bin|o|a|lib|obj|woff2?|ttf|otf|eot|wasm|pyc|pyo|lockb|sqlite3?|db|parquet|arrow|npy|npz|pt|pth|onnx|safetensors|ckpt|h5|pkl|DS_Store)$/i;

export interface ScanOptions {
  /** Path used for format detection and agent-file classification (relative paths work best). */
  path: string;
  expectedScripts?: string[];
  /** Override format detection. */
  kind?: DocKind;
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

export function detectKind(path: string, bytes: Uint8Array): DocKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]))
    return OOXML_EXT.test(path) || /\.zip$/i.test(path) ? "ooxml" : "binary";
  if (BINARY_EXT.test(path)) return "binary";
  if (/\.svg$/i.test(path)) return "svg";
  if (HTML_EXT.test(path)) return "html";
  if (MARKDOWN_EXT.test(path)) return "markdown";

  const head = new TextDecoder("utf-8")
    .decode(bytes.subarray(0, 1024))
    .replace(/^\ufeff/, "")
    .trimStart();
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return "svg";
  if (/^<!doctype html|^<html[\s>]/i.test(head)) return "html";
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return "text"; // UTF-16 with BOM
  if (looksBinary(bytes)) return "binary";
  return "text";
}

/**
 * Binary = NUL-heavy, or not valid UTF-8. Control characters alone never make
 * a file binary: padding text with them is itself an evasion technique, and a
 * few NULs in otherwise valid text are reported (evasion/nul-bytes), not skipped.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (!n) return false;
  let nul = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  if (nul / n > 0.1) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n), { stream: true });
    return false;
  } catch {
    return true;
  }
}

export function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(bytes);
}

/** Scan text content (sync): text layers + Markdown/HTML/SVG projection. */
export function scanText(content: string, opts: ScanOptions): Finding[] {
  const kind = opts.kind ?? detectKind(opts.path, new TextEncoder().encode(content.slice(0, 1024)));
  const instructionFile = isAgentInstructionFile(opts.path);
  const findings: Finding[] = [];

  // NUL bytes: strip so the rest of the pipeline sees what an agent sees
  if (content.includes("\0")) {
    const count = content.split("\0").length - 1;
    content = content.replace(/\0/g, "");
    findings.push({
      ruleId: "evasion/nul-bytes",
      type: "scanner_evasion",
      severity: "warning",
      line: 1,
      message: `${count} NUL byte${count > 1 ? "s" : ""} in a text file — many tools then treat it as binary and skip it`,
      humanView: "",
      agentView: "",
    });
  }

  const textOpts = { instructionFile };
  findings.push(...scanUnicode(content, { instructionFile, expectedScripts: opts.expectedScripts }));
  findings.push(...scanTerminal(content, { ...textOpts, codeFile: CODE_EXT.test(opts.path) }));
  findings.push(...scanLayout(content, textOpts));
  findings.push(...scanEncoded(content, textOpts));

  if (kind === "markdown") findings.push(...scanMarkdown(content, textOpts));
  else if (kind === "html") findings.push(...scanHtml(content, textOpts));
  else if (kind === "svg")
    findings.push(...scanHtml(content, { ...textOpts, xml: true, staticDocument: true }));

  if (instructionFile) findings.push(...scanVisibleInjection(content));
  return dedupeFindings(findings);
}

/** Scan any file content (async: PDF and Office parsing). */
export async function scanBytes(bytes: Uint8Array, opts: ScanOptions): Promise<Finding[]> {
  const kind = opts.kind ?? detectKind(opts.path, bytes);
  const instructionFile = isAgentInstructionFile(opts.path);
  if (kind === "binary") return [];
  if (kind === "pdf") {
    const { scanPdf } = await import("./documents/pdf.js");
    return dedupeFindings(await scanPdf(bytes, { instructionFile }));
  }
  if (kind === "ooxml") {
    const { scanOoxml, isOoxml } = await import("./documents/ooxml.js");
    return isOoxml(bytes) ? dedupeFindings(scanOoxml(bytes, { instructionFile })) : [];
  }
  return scanText(decodeText(bytes), { ...opts, kind });
}

export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.ruleId}|${f.line ?? ""}|${f.location ?? ""}|${f.hiddenText ?? f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
