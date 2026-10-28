import { diffWords } from "diff";
import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { LineIndex, visualize } from "./lines.js";

/**
 * Terminal layer.
 *
 * A human who runs `cat`, `less -R`, or reads tool output in a terminal sees
 * the *rendered* result of control sequences; an agent reading the file gets
 * every byte. This module renders the text with a minimal terminal emulator
 * (CR, BS, TAB, CSI cursor/erase/SGR, OSC) and diffs the screen against the
 * raw text. Whatever the screen lost is what the human never saw.
 */

// eslint-disable-next-line no-control-regex
const TRIGGER = /\x1b|\x08|\r(?!\n)|\x9b/;

interface Cell {
  ch: string;
  hidden: boolean;
}

interface RenderResult {
  screen: string; // what a human sees
  raw: string; // text with escape sequences removed (what an agent reads)
  techniques: Set<string>;
  oscPayloads: string[]; // OSC strings (titles, hyperlink targets) never shown inline
}

export function renderTerminal(input: string): RenderResult {
  const text = input.replace(/\r\n/g, "\n");
  const rows: Cell[][] = [[]];
  let r = 0;
  let c = 0;
  let conceal = false;
  let fg: string | null = null;
  let bg: string | null = null;
  let saved: [number, number] = [0, 0];
  const techniques = new Set<string>();
  const oscPayloads: string[] = [];
  let raw = "";

  const row = (n: number) => {
    while (rows.length <= n) rows.push([]);
    return rows[n];
  };
  const put = (ch: string) => {
    const line = row(r);
    while (line.length < c) line.push({ ch: " ", hidden: false });
    const hidden = conceal || (fg !== null && fg === bg);
    if (line[c] && line[c].ch !== " " && !line[c].hidden) {
      // overwriting visible text: the earlier content is lost to the human
    }
    line[c] = { ch, hidden };
    c++;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (ch === "\x1b" || code === 0x9b) {
      // CSI: ESC [ params final   (or 8-bit CSI 0x9B)
      const csiStart = ch === "\x1b" && text[i + 1] === "[" ? i + 2 : code === 0x9b ? i + 1 : -1;
      if (csiStart !== -1) {
        let j = csiStart;
        while (j < text.length && /[0-9;?:<=>]/.test(text[j])) j++;
        const params = text
          .slice(csiStart, j)
          .replace(/[?<=>]/g, "")
          .split(/[;:]/)
          .map((p) => parseInt(p, 10));
        const n = Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1;
        const final = text[j] ?? "";
        switch (final) {
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
                const v = String(ps[k + 2]);
                if (p === 38) fg = v;
                else bg = v;
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
            c += n;
            break;
          case "D":
            c = Math.max(0, c - n);
            techniques.add("ANSI cursor movement");
            break;
          case "G":
            c = Math.max(0, n - 1);
            techniques.add("ANSI cursor movement");
            break;
          case "H":
          case "f": {
            r = Math.max(0, (Number.isFinite(params[0]) ? params[0] : 1) - 1);
            c = Math.max(0, (Number.isFinite(params[1]) ? params[1] : 1) - 1);
            techniques.add("ANSI cursor positioning");
            break;
          }
          case "K": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            const line = row(r);
            if (mode === 0) line.length = Math.min(line.length, c);
            else if (mode === 1)
              for (let k = 0; k <= c && k < line.length; k++) line[k] = { ch: " ", hidden: false };
            else line.length = 0;
            techniques.add("ANSI erase line");
            break;
          }
          case "J": {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            if (mode === 2 || mode === 3) {
              rows.length = 0;
              rows.push([]);
              r = 0;
              c = 0;
            } else if (mode === 0) {
              row(r).length = Math.min(row(r).length, c);
              rows.length = r + 1;
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
      if (text[i + 1] === "]") {
        let j = i + 2;
        while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++;
        const payload = text.slice(i + 2, j);
        // OSC 8 hyperlinks: show the link text, hide the target
        const m = /^8;[^;]*;(.*)$/.exec(payload);
        if (m) {
          if (m[1]) oscPayloads.push(m[1]);
          techniques.add("OSC 8 hyperlink target");
        } else if (payload) {
          oscPayloads.push(payload.replace(/^\d+;/, ""));
          techniques.add("OSC sequence");
        }
        i = text[j] === "\x1b" ? j + 1 : j;
        continue;
      }
      // Two-character escapes: ESC 7 / ESC 8 (save/restore), ESC c (reset), others ignored
      const nxt = text[i + 1];
      if (nxt === "7") saved = [r, c];
      else if (nxt === "8") {
        [r, c] = saved;
        techniques.add("ANSI cursor movement");
      } else if (nxt === "c") {
        rows.length = 0;
        rows.push([]);
        r = 0;
        c = 0;
        techniques.add("ANSI reset");
      }
      i += 1;
      continue;
    }

    if (ch === "\n") {
      r++;
      c = 0;
      row(r);
      raw += ch;
      continue;
    }
    if (ch === "\r") {
      c = 0;
      techniques.add("carriage-return overwrite");
      raw += " ";
      continue;
    }
    if (ch === "\b") {
      c = Math.max(0, c - 1);
      techniques.add("backspace overwrite");
      continue;
    }
    if (ch === "\t") {
      c = (Math.floor(c / 8) + 1) * 8;
      raw += ch;
      continue;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(ch)) continue;
    put(ch);
    raw += ch;
  }

  const screen = rows
    .map((line) =>
      line
        .map((cell) => (cell.hidden ? " " : cell.ch))
        .join("")
        .replace(/\s+$/, ""),
    )
    .join("\n");
  return { screen, raw, techniques, oscPayloads };
}

export function scanTerminal(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  if (!TRIGGER.test(content)) return [];
  const { screen, raw, techniques, oscPayloads } = renderTerminal(content);
  const findings: Finding[] = [];
  const idx = new LineIndex(content);

  // Words present in the raw text but missing from the rendered screen
  const hiddenParts: string[] = [];
  for (const part of diffWords(screen, raw)) {
    if (part.added && part.value.trim()) hiddenParts.push(part.value.trim());
  }
  const hidden = hiddenParts.join(" ").trim();
  const technique = [...techniques].filter((t) => !t.startsWith("OSC")).join(", ");

  if (hidden && technique) {
    const firstWord = hiddenParts[0].split(/\s+/)[0];
    const line = idx.find(firstWord) ?? 1;
    findings.push(
      concealedFinding({
        ruleId: "terminal/hidden-text",
        type: "terminal",
        concealment: "hidden",
        technique: `Hidden in terminal output (${technique})`,
        hiddenText: hidden,
        line,
        humanView: screen
          .split("\n")
          .slice(Math.max(0, line - 2), line + 1)
          .join("\n"),
        agentView: visualize(content.replace(/\r\n/g, "\n"))
          .split("\n")
          .slice(Math.max(0, line - 2), line + 1)
          .join("\n"),
        detail: `rendered with a terminal emulator; ${hiddenParts.length} hidden segment(s)`,
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
        hiddenText: payload,
        line: idx.find(payload) ?? 1,
        humanView: "",
        agentView: visualize(payload),
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
      message: `Terminal control sequences present (${[...techniques].join(", ")}) — rendered output matches the raw text`,
      humanView: "",
      agentView: "",
    });
  }
  return findings;
}
