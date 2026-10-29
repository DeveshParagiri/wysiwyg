/**
 * Line bookkeeping and safe display helpers shared by all text scanners.
 */

/** Maps character offsets to 1-indexed lines in O(log n). */
export class LineIndex {
  private starts: number[] = [0];
  readonly lines: string[];

  constructor(readonly content: string) {
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
    this.lines = content.split("\n");
  }

  lineOf(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  columnOf(offset: number): number {
    return offset - this.starts[this.lineOf(offset) - 1] + 1;
  }

  /** Line text (1-indexed), without a trailing CR. */
  line(n: number): string {
    return (this.lines[n - 1] ?? "").replace(/\r$/, "");
  }

  /** Lines [n - radius, n + radius] as { lineNum, text }. */
  around(n: number, radius = 1): { lineNum: number; text: string }[] {
    const out = [];
    for (let i = Math.max(1, n - radius); i <= Math.min(this.lines.length, n + radius); i++) {
      out.push({ lineNum: i, text: this.line(i) });
    }
    return out;
  }

  /**
   * Line where normalised text (whitespace collapsed, e.g. a hidden element's
   * text) starts in the source: its first words, allowing any whitespace or
   * Markdown emphasis between them. Short texts return undefined rather than
   * risk matching an unrelated earlier occurrence.
   */
  findText(text: string, minLength = 6): number | undefined {
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (words.join(" ").length < minLength) return undefined;
    const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(words.map(escape).join("(?:\\s|[*_`~>])+")).exec(this.content);
    return m ? this.lineOf(m.index) : undefined;
  }

  /** First line containing `needle` (searching from `from`), or undefined. */
  find(needle: string, from = 0): number | undefined {
    if (!needle) return undefined;
    const i = this.content.indexOf(needle, from);
    return i === -1 ? undefined : this.lineOf(i);
  }
}

/** Characters that never render visibly: format, default-ignorable, private use, controls. */
export const INVISIBLE_CLASS =
  "\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Co}\\u2800\\u3164\\uffa0\\u115f\\u1160";
export const CONTROL_CLASS = "\\x00-\\x08\\x0b-\\x1f\\x7f\\x80-\\x9f"; // all C0/C1 controls except \\t and \\n
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CLASS}]`, "u");
const HIDDEN_GLOBAL = new RegExp(`[${CONTROL_CLASS}${INVISIBLE_CLASS}]`, "gu");

export function isInvisibleChar(ch: string): boolean {
  return INVISIBLE_RE.test(ch);
}

/**
 * Make a string safe to print and show what is really there: control and
 * invisible characters become ⟨U+XXXX⟩ markers. Scanned content must never
 * reach the terminal raw — an ANSI payload could rewrite the report itself.
 */
export function visualize(s: string): string {
  return s.replace(HIDDEN_GLOBAL, (ch) => codepointLabel(ch.codePointAt(0)!));
}

/** Remove invisible and control characters: roughly what a human sees. */
export function stripInvisible(s: string): string {
  return s.replace(HIDDEN_GLOBAL, "");
}

export function codepointLabel(cp: number): string {
  return `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
}

export function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}
