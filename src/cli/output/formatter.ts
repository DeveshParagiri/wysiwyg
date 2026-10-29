import { relative } from "node:path";
import { diffWordsWithSpace } from "diff";
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
  /** Wall time of the scan, shown in the summary. */
  elapsedMs?: number;
}

// ─── Layout ──────────────────────────────────────────────────────────

const color = pc.isColorSupported;
/** Hidden text: dark red background, so the payload stands out inside the "AI reads" row. */
const hl = (s: string) => (color ? `\x1b[48;5;52m\x1b[38;5;217m${s}\x1b[0m` : `⟦${s}⟧`);
/** Text the human sees but the agent's copy replaced (e.g. a terminal overwrite). */
const lo = (s: string) => (color ? pc.dim(pc.strikethrough(s)) : s);

const INDENT = " ".repeat(12);
const LABEL_WIDTH = 10;
const MAX_ROW_LINES = 6;

function termWidth(): number {
  return Math.max(60, process.stdout.columns || 100);
}

function displayPath(source: string, cwd?: string): string {
  if (source === "stdin" || source === "clipboard" || /^(https?|mcp):/.test(source)) return visualize(source);
  const rel = relative(cwd ?? process.cwd(), source);
  return visualize(rel && !rel.startsWith("..") ? rel : source);
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

function visible(findings: Finding[], opts: FormatOptions): Finding[] {
  return opts.verbose ? findings : findings.filter((f) => f.severity !== "info");
}

// ─── Wrapped, highlighted rows ───────────────────────────────────────

interface Segment {
  text: string;
  style?: (s: string) => string;
}

/**
 * Wrap styled segments to `width` columns (breaking at spaces where possible),
 * splitting on newlines. Returns at most `maxLines` lines plus a truncation note.
 */
function wrap(segments: Segment[], width: number, maxLines = MAX_ROW_LINES): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  const flush = () => {
    lines.push(line);
    line = "";
    used = 0;
  };
  for (const seg of segments) {
    for (const [i, part] of seg.text.split("\n").entries()) {
      if (i > 0) flush();
      let rest = part;
      while (rest.length) {
        const room = width - used;
        let take = rest.length <= room ? rest.length : rest.lastIndexOf(" ", room);
        if (take <= 0) take = used === 0 ? room : 0;
        if (take === 0) {
          flush();
          rest = rest.replace(/^ /, "");
          continue;
        }
        const chunk = rest.slice(0, take);
        line += seg.style ? seg.style(chunk) : chunk;
        used += chunk.length;
        rest = rest.slice(take);
        if (rest.length) {
          flush();
          rest = rest.replace(/^ /, "");
        }
      }
    }
  }
  if (line || !lines.length) flush();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept.push(pc.dim(`… ${lines.length - maxLines} more line(s) — use --format json for the full text`));
    return kept;
  }
  return lines;
}

/** "you see" / "AI reads" rows, with the agent-only text highlighted. */
function formatViews(finding: Finding): string[] {
  const tidy = (v: string) =>
    visualize(v)
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .trim();
  const human = tidy(finding.humanView || "");
  const agent = tidy(finding.agentView || "");
  if (!human && !agent) return [];
  const width = termWidth() - INDENT.length - LABEL_WIDTH - 2;
  const row = (label: string, segments: Segment[]) =>
    wrap(segments, width).map(
      (l, i) => `${INDENT}${i === 0 ? pc.dim(label.padEnd(LABEL_WIDTH)) : " ".repeat(LABEL_WIDTH)}${l}`,
    );

  if (human === agent) return row("text", [{ text: agent }]);

  const humanSegs: Segment[] = [];
  const agentSegs: Segment[] = [];
  for (const part of diffWordsWithSpace(human, agent)) {
    if (part.added) {
      // Keep surrounding whitespace outside the highlight
      const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.value)!;
      agentSegs.push({ text: lead }, { text: body, style: hl }, { text: trail });
    } else if (part.removed) humanSegs.push({ text: part.value, style: lo });
    else {
      humanSegs.push({ text: part.value });
      agentSegs.push({ text: part.value });
    }
  }
  return [
    ...(human ? row("you see", humanSegs) : row("you see", [{ text: "(nothing)", style: pc.dim }])),
    ...row("AI reads", agentSegs),
  ];
}

// ─── Findings ────────────────────────────────────────────────────────

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "critical":
      return pc.red(pc.bold("CRITICAL".padEnd(INDENT.length - 2)));
    case "warning":
      return pc.yellow(pc.bold("WARNING".padEnd(INDENT.length - 2)));
    case "info":
      return pc.dim("INFO".padEnd(INDENT.length - 2));
  }
}

function formatFinding(finding: Finding): string {
  const where = finding.line ? `line ${finding.line}` : finding.location ? visualize(finding.location) : "";
  const headline = visualize(finding.technique ?? finding.message);
  const lines = [
    `  ${severityLabel(finding.severity)}${where ? `${pc.dim(where)} ${pc.dim("·")} ` : ""}${headline}  ${pc.dim(finding.ruleId)}`,
    ...formatViews(finding),
  ];
  if (finding.trigger) {
    lines.push(`${INDENT}${pc.yellow("⚠")} ${pc.dim("instructs the AI:")} "${visualize(finding.trigger)}"`);
  }
  return lines.join("\n");
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function counts(findings: Finding[], colored: boolean): string {
  const parts: string[] = [];
  const c = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const paint = (s: Severity, text: string) =>
    !colored ? text : s === "critical" ? pc.red(text) : s === "warning" ? pc.yellow(text) : pc.dim(text);
  for (const s of ["critical", "warning", "info"] as Severity[]) {
    // "2 critical, 3 warnings, 5 info"
    if (c(s))
      parts.push(paint(s, s === "warning" ? plural(c(s), s) : `${c(s).toLocaleString("en-US")} ${s}`));
  }
  return parts.join(colored ? pc.dim(", ") : ", ");
}

function worst(findings: Finding[]): Severity | null {
  return findings.reduce<Severity | null>(
    (w, f) => (!w || RANK[f.severity] > RANK[w] ? f.severity : w),
    null,
  );
}

function marker(findings: Finding[]): string {
  const w = worst(findings);
  return w === "critical" ? pc.red("●") : w === "warning" ? pc.yellow("●") : pc.dim("○");
}

function formatSource(result: ScanResult, opts: FormatOptions): string {
  const shown = visible(result.findings, opts).sort(
    (a, b) => RANK[b.severity] - RANK[a.severity] || (a.line ?? 0) - (b.line ?? 0),
  );
  const header = `${marker(result.findings)} ${pc.bold(displayPath(result.source, opts.cwd))}  ${counts(result.findings, true)}`;
  // Findings sit directly under their file; a blank line separates findings
  return [header, shown.map(formatFinding).join("\n\n")].join("\n");
}

function elapsed(opts: FormatOptions): string {
  if (opts.elapsedMs === undefined) return "";
  const ms = opts.elapsedMs;
  return pc.dim(` · ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}`);
}

// ─── Public API ──────────────────────────────────────────────────────

/** Totals line; with many affected files, a compact per-file recap after the details. */
export function formatSummary(results: ScanResult[], opts: FormatOptions = {}, note = ""): string {
  const all = results.flatMap((r) => r.findings);
  const dirty = results.filter((r) => !r.clean);
  const lines = [
    `${pc.bold(`${dirty.length.toLocaleString("en-US")} of ${plural(results.length, "file")}`)} with findings  ${counts(all, true)}${elapsed(opts)}${note}`,
  ];
  if (dirty.length >= 4) {
    for (const r of dirty)
      lines.push(
        `  ${marker(r.findings)} ${displayPath(r.source, opts.cwd)}  ${pc.dim(counts(r.findings, false))}`,
      );
  }
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

  if (results.length === 0) return `${pc.yellow("!")} No files to scan.`;

  const withOutput = results.filter((r) => !r.clean || visible(r.findings, opts).length > 0);
  const infoCount = results.flatMap((r) => r.findings).filter((f) => f.severity === "info").length;
  const infoNote = !opts.verbose && infoCount ? pc.dim(` · ${infoCount} info hidden (--verbose)`) : "";

  if (!withOutput.length) {
    const where = results.length === 1 ? "" : pc.dim(` · ${plural(results.length, "file")}`);
    return `${pc.green("✓")} No hidden content detected${where}${elapsed(opts)}${infoNote}`;
  }
  const blocks = withOutput.map((r) => formatSource(r, opts));
  return [...blocks, formatSummary(results, opts, infoNote)].join("\n\n");
}
