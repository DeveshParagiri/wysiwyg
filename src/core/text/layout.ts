import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { LineIndex } from "./lines.js";

/**
 * Layout layer: content that is present but pushed out of view in an editor,
 * diff viewer, or code review UI — e.g. hundreds of spaces before an
 * instruction on the same line, or a payload after a long run of blank lines.
 */

const H_PADDING = /[ \t  - 　]{100,}(?=\S)/g;
const MIN_BLANK_LINES = 60;

export function scanLayout(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const idx = new LineIndex(content);

  for (let n = 1; n <= idx.lines.length; n++) {
    const text = idx.line(n);
    if (text.length < 100) continue;
    H_PADDING.lastIndex = 0;
    const m = H_PADDING.exec(text);
    if (!m) continue;
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    findings.push(
      concealedFinding({
        ruleId: "layout/horizontal-padding",
        type: "layout",
        concealment: "hidden",
        technique: `Text pushed off-screen by ${m[0].length} whitespace characters`,
        hiddenText: after,
        line: n,
        column: m.index + m[0].length + 1,
        humanView: before,
        agentView: `${before} ⟨${m[0].length} spaces⟩ ${after}`,
        instructionFile: opts.instructionFile,
      }),
    );
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
