import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { LineIndex, visualize } from "./lines.js";
import { capPerRule } from "./unicode.js";

/**
 * Terminal layer.
 *
 * A human who runs `cat`, `less -R`, or reads tool output in a terminal sees
 * the *rendered* result of control sequences; an agent reading the file gets
 * every byte. This module renders the text with a minimal terminal emulator
 * (CR, BS, TAB, CSI cursor/erase/SGR, OSC) and records every source character
 * the human never sees: overwritten, erased, concealed, or drawn in the
 * background colour. Tracking losses during rendering keeps this linear and
 * attributes each hidden character to its source line.
 */

const TRIGGER = /\x1b|\x08|\r(?!\n)|\x9b/;

/** True when the text contains sequences a terminal would act on (ESC, CSI, BS, bare CR). */
export function hasTerminalControls(content: string): boolean {
  return TRIGGER.test(content);
}

/** Cursor moves are clamped so `ESC[99999999B` cannot allocate millions of rows. */
const MAX_MOVE = 1000;
/** Screen width: like a real terminal, text wraps here (bounds row length and erase cost). */
const DEFAULT_WIDTH = 400;

interface Cell {
  ch: string;
  hidden: boolean;
  /** Offset of the character in the source; -1 for padding. */
  src: number;
}

export interface Lost {
  src: number;
  ch: string;
}

export interface RenderResult {
  /** What a human sees. */
  screen: string;
  techniques: Set<string>;
  /** OSC strings (titles, hyperlink targets) that are never shown inline. */
  oscPayloads: { text: string; src: number }[];
  /** Source characters that never reach the screen. */
  lost: Lost[];
}

/**
 * Render `input` on a minimal terminal. `width` (default 400) is where text
 * wraps; the visible-text renderer widens it to the longest source line so
 * ordinary long lines keep their structure.
 */
export function renderTerminal(input: string, opts: { width?: number } = {}): RenderResult {
  const WIDTH = Math.max(DEFAULT_WIDTH, opts.width ?? DEFAULT_WIDTH);
  const PAD: Cell = { ch: " ", hidden: false, src: -1 };
  const rows: Cell[][] = [[]];
  let r = 0;
  let c = 0;
  let conceal = false;
  let fg: string | null = null;
  let bg: string | null = null;
  let saved: [number, number] = [0, 0];
  const techniques = new Set<string>();
  const oscPayloads: { text: string; src: number }[] = [];
  const lost: Lost[] = [];

  /** A real source character (not padding, not whitespace). */
  const real = (cell: Cell | undefined): cell is Cell => Boolean(cell && cell.src >= 0 && cell.ch.trim());
  const row = (n: number) => {
    while (rows.length <= n) rows.push([]);
    return rows[n];
  };
  const erase = (cells: Cell[]) => {
    for (const cell of cells) if (real(cell)) lost.push({ src: cell.src, ch: cell.ch });
  };
  const put = (ch: string, src: number) => {
    if (c >= WIDTH) {
      r++;
      c = 0;
    }
    const line = row(r);
    while (line.length < c) line.push(PAD);
    const old = line[c];
    if (real(old) && (old.hidden || old.ch !== ch)) lost.push({ src: old.src, ch: old.ch });
    line[c] = { ch, hidden: conceal || (fg !== null && fg === bg), src };
    c++;
  };
  const move = (n: number) => Math.min(n, MAX_MOVE);

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const code = input.charCodeAt(i);

    if (ch === "\x1b" || code === 0x9b) {
      // CSI: ESC [ params final   (or 8-bit CSI 0x9B)
      const csiStart = ch === "\x1b" && input[i + 1] === "[" ? i + 2 : code === 0x9b ? i + 1 : -1;
      if (csiStart !== -1) {
        let j = csiStart;
        while (j < input.length && /[0-9;?:<=>]/.test(input[j])) j++;
        const params = input
          .slice(csiStart, j)
          .replace(/[?<=>]/g, "")
          .split(/[;:]/)
          .map((p) => parseInt(p, 10));
        const n = move(Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1);
        switch (input[j] ?? "") {
          case "m": {
            const ps = params.length ? params.map((p) => (Number.isFinite(p) ? p : 0)) : [0];
            for (let k = 0; k < ps.length; k++) {
              const p = ps[k];
              if (p === 0) {
                conceal = false;
                fg = null;
                bg = null;
              } else if (p === 8) {
                conceal = true;
                techniques.add("ANSI conceal (ESC[8m)");
              } else if (p === 28) conceal = false;
              else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97))
                fg = String((p % 10) + (p >= 90 ? 8 : 0));
              else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107))
                bg = String((p % 10) + (p >= 100 ? 8 : 0));
              else if (p === 39) fg = null;
              else if (p === 49) bg = null;
              else if ((p === 38 || p === 48) && ps[k + 1] === 5) {
                if (p === 38) fg = String(ps[k + 2]);
                else bg = String(ps[k + 2]);
                k += 2;
              } else if ((p === 38 || p === 48) && ps[k + 1] === 2) {
                const v = `rgb${ps[k + 2]},${ps[k + 3]},${ps[k + 4]}`;
                if (p === 38) fg = v;
                else bg = v;
                k += 4;
              }
            }
            if (fg !== null && fg === bg) techniques.add("ANSI foreground = background");
            break;
          }
          case "A":
            r = Math.max(0, r - n);
            techniques.add("ANSI cursor movement");
            break;
          case "B":
            r += n;
            break;
          case "C":
            c = Math.min(WIDTH - 1, c + n);
            break;
          case "D":
            c = Math.max(0, c - n);
            techniques.add("ANSI cursor movement");
            break;
          case "G":
            c = Math.min(WIDTH - 1, Math.max(0, n - 1));
            techniques.add("ANSI cursor movement");
            break;
          case "H":
          case "f":
            r = Math.max(0, move(Number.isFinite(params[0]) ? params[0] : 1) - 1);
            c = Math.min(WIDTH - 1, Math.max(0, move(Number.isFinite(params[1]) ? params[1] : 1) - 1));
            techniques.add("ANSI cursor positioning");
            break;
          case "K": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            const line = row(r);
            if (mode === 0) erase(line.splice(c));
            else if (mode === 1) {
              erase(line.slice(0, c + 1));
              for (let k = 0; k <= c && k < line.length; k++) line[k] = PAD;
            } else erase(line.splice(0));
            techniques.add("ANSI erase line");
            break;
          }
          case "J": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            if (mode === 2 || mode === 3) {
              for (const line of rows) erase(line);
              rows.length = 0;
              rows.push([]);
              r = 0;
              c = 0;
            } else if (mode === 0) {
              erase(row(r).splice(c));
              for (const line of rows.splice(r + 1)) erase(line);
            }
            techniques.add("ANSI erase display");
            break;
          }
          case "s":
            saved = [r, c];
            break;
          case "u":
            [r, c] = saved;
            techniques.add("ANSI cursor movement");
            break;
        }
        i = j;
        continue;
      }
      // OSC: ESC ] ... (BEL | ESC \)
      if (input[i + 1] === "]") {
        let j = i + 2;
        while (j < input.length && input[j] !== "\x07" && !(input[j] === "\x1b" && input[j + 1] === "\\"))
          j++;
        const payload = input.slice(i + 2, j);
        // OSC 8 hyperlinks show the link text and hide the target
        const link = /^8;[^;]*;(.*)$/.exec(payload);
        if (link) {
          if (link[1]) oscPayloads.push({ text: link[1], src: i });
          techniques.add("OSC 8 hyperlink target");
        } else if (payload) {
          oscPayloads.push({ text: payload.replace(/^\d+;/, ""), src: i });
          techniques.add("OSC sequence");
        }
        i = input[j] === "\x1b" ? j + 1 : j;
        continue;
      }
      // Two-character escapes: ESC 7 / ESC 8 (save/restore), ESC c (reset)
      const next = input[i + 1];
      if (next === "7") saved = [r, c];
      else if (next === "8") {
        [r, c] = saved;
        techniques.add("ANSI cursor movement");
      } else if (next === "c") {
        for (const line of rows) erase(line);
        rows.length = 0;
        rows.push([]);
        r = 0;
        c = 0;
        techniques.add("ANSI reset");
      }
      i += 1;
      continue;
    }

    if (ch === "\r" && input[i + 1] === "\n") continue; // CRLF is a plain newline
    if (ch === "\n") {
      r++;
      c = 0;
      row(r);
      continue;
    }
    if (ch === "\r") {
      c = 0;
      techniques.add("carriage-return overwrite");
      continue;
    }
    if (ch === "\b") {
      c = Math.max(0, c - 1);
      techniques.add("backspace overwrite");
      continue;
    }
    if (ch === "\t") {
      c = Math.min(WIDTH - 1, (Math.floor(c / 8) + 1) * 8);
      continue;
    }
    if (/[\x00-\x1f\x7f]/.test(ch)) continue;
    put(ch, i);
  }

  for (const line of rows) {
    for (const cell of line)
      if (cell.hidden && cell.src >= 0 && cell.ch.trim()) lost.push({ src: cell.src, ch: cell.ch });
  }
  const screen = rows
    .map((line) =>
      line
        .map((cell) => (cell.hidden ? " " : cell.ch))
        .join("")
        .trimEnd(),
    )
    .join("\n");
  return { screen, techniques, oscPayloads, lost };
}

/** Lost characters as text segments, split where the source skips more than a space. */
function segments(lost: Lost[], input: string): { src: number; text: string }[] {
  const sorted = [...lost].sort((a, b) => a.src - b.src);
  const out: { src: number; text: string }[] = [];
  for (const l of sorted) {
    const last = out[out.length - 1];
    const prevEnd = last ? last.src + last.text.length : -2;
    if (last && l.src - prevEnd <= 1) {
      last.text += input.slice(prevEnd, l.src) + l.ch;
    } else {
      out.push({ src: l.src, text: l.ch });
    }
  }
  return out;
}

/**
 * @param opts.codeFile Source code or bundles: escape sequences there are usually
 *   string literals (e.g. a terminal library's "\x1bc"), so hidden text is a channel.
 */
export function scanTerminal(
  content: string,
  opts: { instructionFile?: boolean; codeFile?: boolean } = {},
): Finding[] {
  if (!TRIGGER.test(content)) return [];
  const { screen, techniques, oscPayloads, lost } = renderTerminal(content);
  const findings: Finding[] = [];
  const idx = new LineIndex(content);
  const technique = [...techniques].filter((t) => !t.startsWith("OSC")).join(", ");

  // Group by source line so unrelated overwrites (e.g. several progress bars)
  // are judged separately rather than summed into one block of "prose".
  const byLine = new Map<number, string[]>();
  for (const seg of segments(lost, content)) {
    const line = idx.lineOf(seg.src);
    const parts = byLine.get(line) ?? [];
    parts.push(seg.text.replace(/[\x00-\x1f]/g, " ").trim());
    byLine.set(line, parts);
  }

  const screenLines = screen.split("\n");
  for (const [line, parts] of byLine) {
    const hiddenText = parts.filter(Boolean).join(" ");
    if (!hiddenText) continue;
    findings.push(
      concealedFinding({
        ruleId: "terminal/hidden-text",
        type: "terminal",
        concealment: opts.codeFile ? "channel" : "hidden",
        technique: `Hidden in terminal output (${technique || "control characters"})`,
        hiddenText,
        line,
        humanView: screenLines[line - 1]?.slice(0, 240) ?? "",
        agentView: visualize(idx.line(line).slice(0, 240)),
        detail: "rendered with a terminal emulator",
        instructionFile: opts.instructionFile,
      }),
    );
  }

  for (const payload of oscPayloads) {
    findings.push(
      concealedFinding({
        ruleId: "terminal/osc-payload",
        type: "terminal",
        concealment: "channel",
        technique: "Terminal escape payload (title / hyperlink target) not shown inline",
        hiddenText: payload.text,
        line: idx.lineOf(payload.src),
        humanView: "",
        agentView: visualize(payload.text),
        instructionFile: opts.instructionFile,
      }),
    );
  }

  if (!findings.length && techniques.size) {
    findings.push({
      ruleId: "terminal/escape-sequences",
      type: "terminal",
      severity: "info",
      line: 1,
      message: `Terminal control sequences present (${[...techniques].join(", ")}) — nothing is hidden by them`,
      humanView: "",
      agentView: "",
    });
  }
  return capPerRule(findings);
}
