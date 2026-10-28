import { relative } from "node:path";
import { createPatch } from "diff";
import pc from "picocolors";
import { visualize } from "../../core/text/lines.js";
import type { Finding, OutputFormat, ScanResult, Severity } from "../../core/types.js";
import { formatSARIF } from "./sarif.js";

/**
 * Terminal and JSON output.
 *
 * Every string that originates from scanned content goes through
 * visualize() before printing: a payload containing ANSI escapes must not be
 * able to rewrite or hide the report itself.
 */

export interface FormatOptions {
  /** Show info-level findings in pretty output (always included in JSON/SARIF). */
  verbose?: boolean;
  /** Paths are printed relative to this directory. */
  cwd?: string;
}

// ─── Layout ──────────────────────────────────────────────────────────

const REMOVED_BG = "\x1b[48;5;52m";
const REMOVED_FG = "\x1b[38;5;210m";
const ADDED_BG = "\x1b[48;5;22m";
const ADDED_FG = "\x1b[38;5;114m";
const RESET = "\x1b[0m";
const LEFT_PAD = 3;
const RIGHT_PAD = 2;

function termWidth(): number {
  return process.stdout.columns || 100;
}

/** Pad or truncate to an exact width so background colors form even bars. */
function fitToWidth(str: string, width: number): string {
  const chars = [...str];
  if (chars.length > width) return `${chars.slice(0, width - 1).join("")}…`;
  return str + " ".repeat(width - chars.length);
}

function displayPath(source: string, cwd?: string): string {
  if (source === "stdin" || source === "clipboard" || /^https?:/.test(source)) return visualize(source);
  return visualize(relative(cwd ?? process.cwd(), source) || source);
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

function visible(findings: Finding[], opts: FormatOptions): Finding[] {
  return opts.verbose ? findings : findings.filter((f) => f.severity !== "info");
}

// ─── Diff block ──────────────────────────────────────────────────────

/** Unified H/A diff of what the human sees vs what the agent reads. */
function formatDiffBlock(finding: Finding): string {
  const barWidth = termWidth() - LEFT_PAD - RIGHT_PAD;
  const indent = " ".repeat(LEFT_PAD);
  const human = visualize(finding.humanView || "");
  const agent = visualize(finding.agentView || "");

  if (human === agent) {
    return human
      .split("\n")
      .map((line) => `${indent}${pc.dim(fitToWidth(`       ${line}`, barWidth))}`)
      .join("\n");
  }

  const out: string[] = [];
  const patch = createPatch("view", `${human}\n`, `${agent}\n`, "", "", { context: 3 });
  for (const line of patch.split("\n")) {
    if (/^(Index:|===|---|\+\+\+|@@|\\ No newline)/.test(line)) continue;
    if (line.startsWith("-")) {
      out.push(`${indent}${REMOVED_BG}${REMOVED_FG}${fitToWidth(`  H  ${line.slice(1)}`, barWidth)}${RESET}`);
    } else if (line.startsWith("+")) {
      out.push(`${indent}${ADDED_BG}${ADDED_FG}${fitToWidth(`  A  ${line.slice(1)}`, barWidth)}${RESET}`);
    } else if (line.startsWith(" ")) {
      out.push(`${indent}${pc.dim(fitToWidth(`     ${line.slice(1)}`, barWidth))}`);
    }
  }
  return out.join("\n");
}

// ─── Findings ────────────────────────────────────────────────────────

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "critical":
      return pc.red(pc.bold("CRITICAL"));
    case "warning":
      return pc.yellow(pc.bold("WARNING"));
    case "info":
      return pc.dim("INFO");
  }
}

function formatFinding(finding: Finding, isFirst: boolean): string {
  const prefix = isFirst ? `${pc.dim("└─")} ` : "   ";
  const where = finding.line ? `:${finding.line}` : finding.location ? ` ${visualize(finding.location)}` : "";
  const lines = [
    `${prefix}${severityLabel(finding.severity)}${pc.dim(where)} ${visualize(finding.message)} ${pc.dim(`[${finding.ruleId}]`)}`,
  ];
  if (finding.humanView || finding.agentView) lines.push(formatDiffBlock(finding));
  return lines.join("\n");
}

function counts(findings: Finding[], colored: boolean): string {
  const parts: string[] = [];
  const c = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const paint = (s: Severity, text: string) =>
    !colored ? text : s === "critical" ? pc.red(text) : s === "warning" ? pc.yellow(text) : pc.dim(text);
  for (const s of ["critical", "warning", "info"] as Severity[]) {
    if (c(s)) parts.push(paint(s, `${c(s)} ${s}`));
  }
  return parts.join(colored ? pc.dim(", ") : ", ");
}

function formatSource(result: ScanResult, opts: FormatOptions): string {
  const shown = visible(result.findings, opts).sort(
    (a, b) => RANK[b.severity] - RANK[a.severity] || (a.line ?? 0) - (b.line ?? 0),
  );
  const marker = result.clean ? pc.dim("○") : pc.red("●");
  const lines = [
    `${marker} ${pc.bold(displayPath(result.source, opts.cwd))} ${pc.dim("—")} ${counts(result.findings, true)}`,
  ];
  for (const [i, f] of shown.entries()) lines.push(formatFinding(f, i === 0));
  return lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────

export function formatSummary(results: ScanResult[], opts: FormatOptions = {}): string {
  const all = results.flatMap((r) => r.findings);
  const dirty = results.filter((r) => !r.clean);
  const lines = [
    `${pc.bold(`${dirty.length}/${results.length}`)} file${dirty.length !== 1 ? "s" : ""} with findings ${pc.dim("(")}${counts(all, true)}${pc.dim(")")}`,
  ];
  if (!dirty.length) return lines.join("\n");
  const paths = dirty.map((r) => displayPath(r.source, opts.cwd));
  const pad = Math.min(Math.max(...paths.map((p) => p.length)) + 2, 60);
  dirty.forEach((r, i) => {
    const n = r.findings.length;
    lines.push(
      `${pc.red("●")} ${paths[i].padEnd(pad)} ${n} finding${n !== 1 ? "s" : ""} (${counts(r.findings, false)})`,
    );
  });
  return lines.join("\n");
}

export function formatJSON(results: ScanResult[]): string {
  const all = results.flatMap((r) => r.findings);
  return JSON.stringify(
    {
      results: results.map((r) => ({ source: r.source, clean: r.clean, findings: r.findings })),
      summary: {
        filesScanned: results.length,
        filesClean: results.filter((r) => r.clean).length,
        totalFindings: all.length,
        critical: all.filter((f) => f.severity === "critical").length,
        warning: all.filter((f) => f.severity === "warning").length,
        info: all.filter((f) => f.severity === "info").length,
      },
    },
    null,
    2,
  );
}

export function formatFindings(
  results: ScanResult[],
  format: OutputFormat,
  opts: FormatOptions = {},
): string {
  if (format === "json") return formatJSON(results);
  if (format === "sarif") return formatSARIF(results, opts.cwd);

  if (results.length === 0) return `${pc.green("✓")} No files to scan.`;

  const withOutput = results.filter((r) => !r.clean || visible(r.findings, opts).length > 0);
  const infoCount = results.flatMap((r) => r.findings).filter((f) => f.severity === "info").length;
  const infoNote =
    !opts.verbose && infoCount
      ? pc.dim(` (${infoCount} info finding${infoCount > 1 ? "s" : ""} hidden; use --verbose)`)
      : "";

  if (!withOutput.length) {
    const where = results.length === 1 ? "" : ` in ${results.length} files`;
    return `${pc.green("✓")} No hidden content detected${where}.${infoNote}`;
  }
  if (results.length === 1) return formatSource(results[0], opts) + (infoNote ? `\n${infoNote.trim()}` : "");

  const lines: string[] = [];
  for (const r of withOutput) lines.push(formatSource(r, opts), "");
  lines.push(formatSummary(results, opts) + infoNote);
  return lines.join("\n");
}
