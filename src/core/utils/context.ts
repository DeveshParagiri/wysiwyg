/**
 * Extract source lines around a given line number for diff context.
 *
 * Returns { before, targetLines, after } where:
 * - before: lines before the target (context)
 * - targetLines: the line(s) at the finding
 * - after: lines after the target (context)
 *
 * All returned as arrays of { lineNum, text }.
 */

interface ContextLine {
  lineNum: number;
  text: string;
}

interface SourceContext {
  before: ContextLine[];
  target: ContextLine[];
  after: ContextLine[];
  startLine: number; // first line number in the full excerpt
}

const CONTEXT_LINES = 2;

/**
 * Get source lines around a finding for humanView/agentView.
 * @param content   Full file content
 * @param line      1-indexed line number of the finding
 * @param span      How many lines the finding spans (default 1)
 */
export function getSourceContext(
  content: string,
  line: number,
  span: number = 1,
): SourceContext {
  const allLines = content.split("\n");
  const targetStart = Math.max(0, line - 1); // convert to 0-indexed
  const targetEnd = Math.min(allLines.length, targetStart + span);
  const beforeStart = Math.max(0, targetStart - CONTEXT_LINES);
  const afterEnd = Math.min(allLines.length, targetEnd + CONTEXT_LINES);

  const before: ContextLine[] = [];
  for (let i = beforeStart; i < targetStart; i++) {
    before.push({ lineNum: i + 1, text: allLines[i] });
  }

  const target: ContextLine[] = [];
  for (let i = targetStart; i < targetEnd; i++) {
    target.push({ lineNum: i + 1, text: allLines[i] });
  }

  const after: ContextLine[] = [];
  for (let i = targetEnd; i < afterEnd; i++) {
    after.push({ lineNum: i + 1, text: allLines[i] });
  }

  return {
    before,
    target,
    after,
    startLine: beforeStart + 1,
  };
}

/**
 * Build humanView and agentView strings from source context.
 * The humanView shows the source lines as a human would see them.
 * The agentView replaces the target line(s) with the injected/hidden content.
 */
export function buildDiffViews(
  context: SourceContext,
  agentTargetLines: string[],
): { humanView: string; agentView: string; startLine: number } {
  const contextLines = [...context.before, ...context.target, ...context.after];
  const humanView = contextLines.map((l) => l.text).join("\n");

  const agentContextLines = [
    ...context.before.map((l) => l.text),
    ...agentTargetLines,
    ...context.after.map((l) => l.text),
  ];
  const agentView = agentContextLines.join("\n");

  return { humanView, agentView, startLine: context.startLine };
}
