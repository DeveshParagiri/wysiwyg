import type { ScanResult, OutputFormat, Finding, Severity } from "../../core/types.js";
import pc from "picocolors";
import { createPatch, diffLines } from "diff";
import { relative } from "node:path";

/**
 * Get terminal width, with fallback.
 */
function getTermWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Truncate a string (with ANSI codes) to a visible width, adding ellipsis if needed.
 */
function truncateVisible(str: string, maxVisible: number): string {
  const stripped = stripAnsi(str);
  if (stripped.length <= maxVisible) return str;

  let visible = 0;
  let i = 0;
  while (i < str.length && visible < maxVisible - 1) {
    if (str[i] === "\u001b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible++;
    i++;
  }
  return str.slice(0, i) + pc.dim("…");
}

// ─── Unified diff rendering ──────────────────────────────────────────

// Muted background colors using ANSI 256-color codes.
const REMOVED_BG = "\x1b[48;5;52m";  // dark muted red bg
const REMOVED_FG = "\x1b[38;5;210m"; // soft red text
const ADDED_BG = "\x1b[48;5;22m";    // dark muted green bg
const ADDED_FG = "\x1b[38;5;114m";   // soft green text
const RESET = "\x1b[0m";

// Layout constants
const LEFT_PAD = 3;   // "   " indent for diff block (under └─)
const RIGHT_PAD = 2;  // 2 chars margin from terminal right edge

/**
 * Pad a plain string to exact width with trailing spaces,
 * truncating with ellipsis if too long.
 */
function fitToWidth(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + "…";
  }
  return str + " ".repeat(width - str.length);
}

/**
 * Render a unified diff for a finding using `createPatch` from the `diff` library.
 *
 * All diff lines (context, H, A) are padded to a fixed width:
 *   termWidth - LEFT_PAD - RIGHT_PAD
 * so colored backgrounds form clean, equal-length bars.
 */
function formatDiffBlock(finding: Finding): string {
  const termWidth = getTermWidth();
  const barWidth = termWidth - LEFT_PAD - RIGHT_PAD;
  const indent = " ".repeat(LEFT_PAD);
  const humanView = finding.humanView || "";
  const agentView = finding.agentView || "";

  // If identical, just show context lines with line numbers
  if (humanView === agentView) {
    const startLine = Math.max(1, (finding.line || 1) - 2);
    return humanView.split("\n").map((line, i) => {
      const row = fitToWidth(`${String(startLine + i).padStart(4)}  ${line}`, barWidth);
      return `${indent}${pc.dim(row)}`;
    }).join("\n");
  }

  // Generate a proper unified diff patch
  const patch = createPatch(
    "human",
    humanView + "\n",
    agentView + "\n",
    "",
    "",
    { context: 3 },
  );

  const patchLines = patch.split("\n");
  const out: string[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const patchLine of patchLines) {
    // Skip file headers
    if (
      patchLine.startsWith("Index:") ||
      patchLine.startsWith("===") ||
      patchLine.startsWith("---") ||
      patchLine.startsWith("+++")
    ) {
      continue;
    }

    // Parse @@ hunk header for line numbers
    const hunkMatch = patchLine.match(/^@@\s+-(\d+)/);
    if (hunkMatch) {
      const contextStart = Math.max(1, (finding.line || 1) - 2);
      oldLine = contextStart;
      newLine = contextStart;
      continue;
    }

    if (patchLine === "\\ No newline at end of file") continue;

    if (patchLine.startsWith("-")) {
      const content = patchLine.slice(1);
      const row = fitToWidth(`${String(oldLine).padStart(4)} H ${content}`, barWidth);
      out.push(`${indent}${REMOVED_BG}${REMOVED_FG}${row}${RESET}`);
      oldLine++;
    } else if (patchLine.startsWith("+")) {
      const content = patchLine.slice(1);
      const row = fitToWidth(`${String(newLine).padStart(4)} A ${content}`, barWidth);
      out.push(`${indent}${ADDED_BG}${ADDED_FG}${row}${RESET}`);
      newLine++;
    } else if (patchLine.startsWith(" ")) {
      const content = patchLine.slice(1);
      const row = fitToWidth(`${String(oldLine).padStart(4)}   ${content}`, barWidth);
      out.push(`${indent}${pc.dim(row)}`);
      oldLine++;
      newLine++;
    }
  }

  return out.join("\n");
}

/**
 * Convert a file path to a relative path from cwd.
 * Keeps special sources like "stdin" and "clipboard" as-is.
 */
function toRelativePath(source: string): string {
  if (source === "stdin" || source === "clipboard") return source;
  const rel = relative(process.cwd(), source);
  return rel || source;
}

// ─── Finding / Source / Summary formatting ─────────────────────────────

/**
 * Severity label with color.
 */
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

/**
 * Format a single finding with └─ tree connector.
 */
function formatFinding(finding: Finding, isFirst: boolean): string {
  const lines: string[] = [];

  // Tree connector only on first finding
  const prefix = isFirst ? pc.dim("└─") + " " : "   ";
  const lineInfo = finding.line ? pc.dim(`:${finding.line}`) : "";
  lines.push(
    `${prefix}${severityLabel(finding.severity)}${lineInfo} ${finding.message}`,
  );

  // Diff block
  if (finding.humanView || finding.agentView) {
    lines.push(formatDiffBlock(finding));
  }

  return lines.join("\n");
}

/**
 * Format findings for a single source.
 */
function formatSource(result: ScanResult): string {
  if (result.clean) {
    return `${pc.green("✓")} ${pc.dim(toRelativePath(result.source))} — No hidden content detected.`;
  }

  const lines: string[] = [];
  const critCount = result.findings.filter((f) => f.severity === "critical").length;
  const warnCount = result.findings.filter((f) => f.severity === "warning").length;
  const infoCount = result.findings.filter((f) => f.severity === "info").length;

  const parts: string[] = [];
  if (critCount > 0) parts.push(pc.red(`${critCount} critical`));
  if (warnCount > 0) parts.push(pc.yellow(`${warnCount} warning`));
  if (infoCount > 0) parts.push(pc.dim(`${infoCount} info`));

  const filePath = toRelativePath(result.source);
  lines.push(
    `${pc.red("●")} ${pc.bold(filePath)} ${pc.dim("—")} ${parts.join(pc.dim(", "))}`,
  );

  for (let i = 0; i < result.findings.length; i++) {
    lines.push(formatFinding(result.findings[i], i === 0));
  }

  return lines.join("\n");
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Format a summary line for multiple scan results.
 */
export function formatSummary(results: ScanResult[]): string {
  const lines: string[] = [];
  const totalFiles = results.length;
  const cleanFiles = results.filter((r) => r.clean).length;
  const dirtyFiles = totalFiles - cleanFiles;
  const allFindings = results.flatMap((r) => r.findings);
  const critCount = allFindings.filter((f) => f.severity === "critical").length;
  const warnCount = allFindings.filter((f) => f.severity === "warning").length;
  const infoCount = allFindings.filter((f) => f.severity === "info").length;

  // Header: "13/20 files with findings (16 critical, 5 warning)"
  const totalCounts: string[] = [];
  if (critCount > 0) totalCounts.push(pc.red(`${critCount} critical`));
  if (warnCount > 0) totalCounts.push(pc.yellow(`${warnCount} warning`));
  if (infoCount > 0) totalCounts.push(pc.dim(`${infoCount} info`));

  lines.push(
    `${pc.bold(`${dirtyFiles}/${totalFiles}`)} file${dirtyFiles !== 1 ? "s" : ""} with findings ${pc.dim("(")}${totalCounts.join(pc.dim(", "))}${pc.dim(")")}`,
  );

  // File list with dynamic padding based on longest path
  const dirtyResults = results.filter((r) => !r.clean);
  if (dirtyResults.length === 0) {
    return lines.join("\n");
  }
  const relPaths = dirtyResults.map((r) => toRelativePath(r.source));
  const maxPathLen = Math.max(...relPaths.map((p) => p.length));
  const padWidth = Math.min(maxPathLen + 2, 60); // cap at 60

  for (let i = 0; i < dirtyResults.length; i++) {
    const result = dirtyResults[i];
    const rCrit = result.findings.filter((f) => f.severity === "critical").length;
    const rWarn = result.findings.filter((f) => f.severity === "warning").length;
    const counts: string[] = [];
    if (rCrit > 0) counts.push(`${rCrit} critical`);
    if (rWarn > 0) counts.push(`${rWarn} warning`);
    const n = result.findings.length;
    lines.push(
      `${pc.red("●")} ${relPaths[i].padEnd(padWidth)} ${n} finding${n !== 1 ? "s" : ""} (${counts.join(", ")})`,
    );
  }

  return lines.join("\n");
}

/**
 * Format results as JSON.
 */
export function formatJSON(results: ScanResult[]): string {
  const allFindings = results.flatMap((r) => r.findings);
  return JSON.stringify(
    {
      results: results.map((r) => ({
        source: r.source,
        clean: r.clean,
        findings: r.findings,
      })),
      summary: {
        filesScanned: results.length,
        filesClean: results.filter((r) => r.clean).length,
        totalFindings: allFindings.length,
        critical: allFindings.filter((f) => f.severity === "critical").length,
        warning: allFindings.filter((f) => f.severity === "warning").length,
        info: allFindings.filter((f) => f.severity === "info").length,
      },
    },
    null,
    2,
  );
}

/**
 * Kept for backward compat with tests — renders a titled box.
 */
export function formatBox(title: string, lines: string[]): string {
  const width = Math.min(getTermWidth() - 4, 76);
  const innerWidth = width - 4;
  const titleLine = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}┐`;
  const bottomLine = `└${"─".repeat(width - 2)}┘`;

  const wrappedLines: string[] = [];
  for (const line of lines) {
    const stripped = stripAnsi(line);
    if (stripped.length <= innerWidth) {
      const padding = " ".repeat(Math.max(0, innerWidth - stripped.length));
      wrappedLines.push(`│ ${line}${padding} │`);
    } else {
      const visibleChunk = truncateVisible(line, innerWidth);
      const visibleStripped = stripAnsi(visibleChunk);
      const padding = " ".repeat(Math.max(0, innerWidth - visibleStripped.length));
      wrappedLines.push(`│ ${visibleChunk}${padding} │`);
    }
  }

  return [titleLine, ...wrappedLines, bottomLine].join("\n");
}

/**
 * Kept for backward compat with tests.
 */
export function formatDiff(humanView: string, agentView: string): string {
  if (humanView === agentView) return agentView;
  const changes = diffLines(humanView, agentView);
  let result = "";
  for (const change of changes) {
    if (change.added) result += pc.red(pc.bold(change.value));
    else if (!change.removed) result += change.value;
  }
  return result;
}

/**
 * Main formatting entry point.
 */
export function formatFindings(
  results: ScanResult[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return formatJSON(results);
  }

  if (results.length === 0) {
    return `${pc.green("✓")} No files to scan.`;
  }

  const allClean = results.every((r) => r.clean);
  if (allClean) {
    if (results.length === 1) {
      return `${pc.green("✓")} No hidden content detected.`;
    }
    return `${pc.green("✓")} No hidden content detected in ${results.length} files.`;
  }

  if (results.length === 1) {
    return formatSource(results[0]);
  }

  const lines: string[] = [];
  for (const result of results) {
    if (!result.clean) {
      lines.push(formatSource(result));
      lines.push("");
    }
  }
  lines.push(formatSummary(results));
  return lines.join("\n");
}
