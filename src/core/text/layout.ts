import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { LineIndex } from "./lines.js";

/**
 * Layout layer: content that is present but pushed out of view in an editor,
 * diff viewer, or code review UI — e.g. hundreds of spaces before an
 * instruction on the same line, or a payload after a long run of blank lines.
 */

/** Whitespace run that pushes the rest of a line past this many display columns. */
const MIN_PADDING_COLUMNS = 100;
const WHITESPACE_RUN = /[ \t\u00a0\u2000-\u200a\u3000]+(?=\S)/g;
const MIN_BLANK_LINES = 60;
const TAB_WIDTH = 8;

/** Display columns a whitespace run occupies starting at `startCol` (tabs advance to the next stop). */
function columnsOf(run: string, startCol: number): number {
  let col = startCol;
  for (const ch of run)
    col = ch === "\t" ? (Math.floor(col / TAB_WIDTH) + 1) * TAB_WIDTH : col + (ch === "\u3000" ? 2 : 1);
  return col - startCol;
}

export function scanLayout(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const idx = new LineIndex(content);

  for (let n = 1; n <= idx.lines.length; n++) {
    const text = idx.line(n);
    if (text.length < 13) continue; // 12 tabs is the shortest run that can reach 100 columns
    let col = 0; // display column of `pos`, advanced incrementally (linear in line length)
    let pos = 0;
    for (const m of text.matchAll(WHITESPACE_RUN)) {
      // A run of n characters spans at most n * TAB_WIDTH columns; skip short runs without measuring.
      if (m[0].length * TAB_WIDTH < MIN_PADDING_COLUMNS) continue;
      col += columnsOf(text.slice(pos, m.index), col);
      pos = m.index;
      const width = columnsOf(m[0], col);
      if (width < MIN_PADDING_COLUMNS) continue;
      // Formatter-aligned Markdown table columns: the padding sits before the next cell border
      if (/^\s*\|/.test(text) && text[m.index + m[0].length] === "|") continue;
      const before = (m.index > 120 ? "…" : "") + text.slice(Math.max(0, m.index - 120), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2000);
      findings.push(
        concealedFinding({
          ruleId: "layout/horizontal-padding",
          type: "layout",
          concealment: "hidden",
          technique: `Text pushed off-screen by ${width} columns of whitespace`,
          hiddenText: after,
          line: n,
          column: m.index + m[0].length + 1,
          humanView: before,
          agentView: `${before} ⟨${width} columns of whitespace⟩ ${after}`,
          instructionFile: opts.instructionFile,
        }),
      );
      break;
    }
  }

  // Trailing payload after a long run of blank lines
  const tail = /(\n[ \t]*){60,}(\S[\s\S]*)$/.exec(content);
  if (tail) {
    const blank = tail[0].slice(0, tail[0].length - tail[2].length).split("\n").length - 1;
    if (blank >= MIN_BLANK_LINES) {
      const line = idx.lineOf(content.length - tail[2].length);
      findings.push(
        concealedFinding({
          ruleId: "layout/vertical-padding",
          type: "layout",
          concealment: "channel",
          technique: `Content after ${blank} blank lines at the end of the file`,
          hiddenText: tail[2].slice(0, 2000),
          line,
          humanView: "",
          agentView: tail[2].slice(0, 400),
          instructionFile: opts.instructionFile,
        }),
      );
    }
  }
  return findings;
}
