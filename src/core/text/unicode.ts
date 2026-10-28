import { concealedFinding } from "../policy.js";
import type { Finding, Severity } from "../types.js";
import { getDominantScript, isJoiningScript } from "../utils/script-detect.js";
import { hex, isInvisibleChar, LineIndex, stripInvisible, visualize } from "./lines.js";

/**
 * Invisible-character layer.
 *
 * Consecutive invisible codepoints are grouped into runs. Each run is either
 * decoded (Unicode Tags, variation-selector bytes, two-symbol binary), let
 * through as a known legitimate use (flag emoji, emoji ZWJ sequences, joiners
 * in joining scripts, RTL marks in RTL text), or reported with the codepoints
 * it contains.
 */

export interface UnicodeScanOptions {
  instructionFile?: boolean;
  /** Scripts the project expects (.wysiwygrc expected_scripts); joiners in them are legitimate. */
  expectedScripts?: string[];
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const RTL =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Scripts written without spaces, where ZWSP / WORD JOINER mark line-break opportunities. */
const NO_SPACE_SCRIPTS = new Set(["CJK", "Thai", "Myanmar", "Tibetan"]);

const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isVS = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isBidiEmbed = (cp: number) => cp >= 0x202a && cp <= 0x202e;
const isBidiIsolate = (cp: number) => cp >= 0x2066 && cp <= 0x2069;
const isBidiMark = (cp: number) => cp === 0x200e || cp === 0x200f || cp === 0x061c;
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isPUA = (ch: string) => /\p{Co}/u.test(ch);

const NAMES: Record<number, string> = {
  173: "SOFT HYPHEN",
  847: "COMBINING GRAPHEME JOINER",
  1564: "ARABIC LETTER MARK",
  4447: "HANGUL CHOSEONG FILLER",
  4448: "HANGUL JUNGSEONG FILLER",
  6158: "MONGOLIAN VOWEL SEPARATOR",
  8203: "ZERO WIDTH SPACE",
  8204: "ZERO WIDTH NON-JOINER",
  8205: "ZERO WIDTH JOINER",
  8206: "LEFT-TO-RIGHT MARK",
  8207: "RIGHT-TO-LEFT MARK",
  8234: "LEFT-TO-RIGHT EMBEDDING",
  8235: "RIGHT-TO-LEFT EMBEDDING",
  8236: "POP DIRECTIONAL FORMATTING",
  8237: "LEFT-TO-RIGHT OVERRIDE",
  8238: "RIGHT-TO-LEFT OVERRIDE",
  8288: "WORD JOINER",
  8289: "FUNCTION APPLICATION",
  8290: "INVISIBLE TIMES",
  8291: "INVISIBLE SEPARATOR",
  8292: "INVISIBLE PLUS",
  8294: "LEFT-TO-RIGHT ISOLATE",
  8295: "RIGHT-TO-LEFT ISOLATE",
  8296: "FIRST STRONG ISOLATE",
  8297: "POP DIRECTIONAL ISOLATE",
  10240: "BRAILLE PATTERN BLANK",
  12644: "HANGUL FILLER",
  65279: "ZERO WIDTH NO-BREAK SPACE (BOM)",
  65440: "HALFWIDTH HANGUL FILLER",
  65529: "INTERLINEAR ANNOTATION ANCHOR",
  65530: "INTERLINEAR ANNOTATION SEPARATOR",
  65531: "INTERLINEAR ANNOTATION TERMINATOR",
};

export function codepointName(cp: number): string {
  return NAMES[cp] ? `${hex(cp)} ${NAMES[cp]}` : hex(cp);
}

/** Decode Unicode Tags (U+E0000–U+E007F) to the ASCII they shadow. */
export function decodeUnicodeTags(chars: string): string {
  let decoded = "";
  for (const ch of chars) {
    const cp = ch.codePointAt(0)!;
    if (isTag(cp) && cp - 0xe0000 >= 0x20 && cp - 0xe0000 <= 0x7e)
      decoded += String.fromCharCode(cp - 0xe0000);
  }
  return decoded;
}

/** Decode variation-selector byte smuggling: VS1–16 → 0–15, VS17–256 → 16–255. */
export function decodeVariationSelectors(cps: number[]): string | null {
  const bytes = new Uint8Array(cps.map((cp) => (cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16)));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decode a two-symbol run as 8-bit binary; tries both symbol→bit mappings. */
export function decodeInvisibleBinary(cps: number[]): string | null {
  const symbols = [...new Set(cps)];
  if (symbols.length !== 2 || cps.length < 16) return null;
  let best: string | null = null;
  for (const one of symbols) {
    let out = "";
    for (let i = 0; i + 8 <= cps.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (cps[i + j] === one ? 1 : 0);
      out += String.fromCharCode(byte);
    }
    if (printableRatio(out) > (best ? printableRatio(best) : 0)) best = out;
  }
  return best && printableRatio(best) >= 0.85 ? best : null;
}

export function printableRatio(s: string): number {
  if (!s.length) return 0;
  let ok = 0;
  for (const ch of s) if (/[\p{L}\p{N}\p{P}\p{Zs}\p{S}\n\t]/u.test(ch)) ok++;
  return ok / [...s].length;
}

interface Run {
  start: number; // UTF-16 offset of first codepoint
  end: number; // offset after last codepoint
  cps: number[];
  prev: string; // visible character before the run ("" at start)
  next: string; // visible character after the run
}

function collectRuns(content: string): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let prev = "";
  let i = 0;
  for (const ch of content) {
    const cp = ch.codePointAt(0)!;
    if (isInvisibleChar(ch) && ch !== "\t") {
      if (!cur) cur = { start: i, end: i, cps: [], prev, next: "" };
      cur.cps.push(cp);
      cur.end = i + ch.length;
    } else {
      if (cur) {
        cur.next = ch;
        runs.push(cur);
        cur = null;
      }
      prev = ch;
    }
    i += ch.length;
  }
  if (cur) runs.push(cur);
  return runs;
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const MAX_PER_RULE = 25;

export function scanUnicode(content: string, opts: UnicodeScanOptions = {}): Finding[] {
  if (!/[^\x00-\x7f]/.test(content)) return [];
  const idx = new LineIndex(content);
  const hasRTL = RTL.test(content);
  const findings: Finding[] = [];

  const views = (run: Run, replacement: string) => {
    const line = idx.lineOf(run.start);
    const lineStart = run.start - (idx.columnOf(run.start) - 1);
    const text = idx.line(line);
    const a = run.start - lineStart;
    const b = run.end - lineStart;
    const lo = Math.max(0, a - 80);
    const hi = Math.min(text.length, b + 80);
    const pre = (lo > 0 ? "…" : "") + text.slice(lo, a);
    const post = text.slice(b, hi) + (hi < text.length ? "…" : "");
    return {
      line,
      column: a + 1,
      humanView: stripInvisible(pre + post),
      agentView: visualize(pre) + replacement + visualize(post),
    };
  };

  for (const run of collectRuns(content)) {
    let cps = run.cps;

    // Flag emoji: 🏴 + tag letters/digits + CANCEL TAG (e.g. England, Scotland, Wales)
    if (run.prev.codePointAt(0) === 0x1f3f4) {
      const cancel = cps.indexOf(0xe007f);
      const body = cps.slice(0, cancel);
      if (cancel > 0 && cancel <= 7 && body.every((cp) => cp >= 0xe0020 && cp <= 0xe007e)) {
        cps = cps.slice(cancel + 1);
      }
    }
    if (!cps.length) continue;

    // 1. Unicode Tags — always smuggling
    const tags = cps.filter(isTag);
    if (tags.length) {
      const decoded = decodeUnicodeTags(String.fromCodePoint(...tags));
      const v = views(run, `⟦${decoded}⟧`);
      if (decoded.trim()) {
        findings.push(
          concealedFinding({
            ruleId: "unicode/tags",
            type: "unicode_tags",
            concealment: "smuggling",
            technique: `Unicode Tags (${tags.length} invisible characters) encode hidden text`,
            hiddenText: decoded,
            offset: run.start,
            ...v,
            detail: `U+E0000–U+E007F; decodes to "${decoded}"`,
            instructionFile: opts.instructionFile,
          }),
        );
        continue;
      }
    }

    // 2. Variation selectors
    const vs = cps.filter(isVS);
    if (vs.length >= 2) {
      const decoded = decodeVariationSelectors(vs);
      if (decoded?.trim() && printableRatio(decoded) >= 0.85) {
        findings.push(
          concealedFinding({
            ruleId: "unicode/variation-selector-smuggling",
            type: "unicode_smuggling",
            concealment: "smuggling",
            technique: `${vs.length} variation selectors after "${run.prev}" encode hidden bytes`,
            hiddenText: decoded,
            offset: run.start,
            ...views(run, `⟦${decoded}⟧`),
            detail: "VS1–VS16 → 0–15, VS17–VS256 → 16–255 (UTF-8)",
          }),
        );
        continue;
      }
    }

    // 3. Two-symbol binary encoding
    const rest = cps.filter((cp) => !isTag(cp) && !isVS(cp));
    const binary = decodeInvisibleBinary(rest);
    if (binary) {
      const syms = [...new Set(rest)].map(codepointName).join(" / ");
      findings.push(
        concealedFinding({
          ruleId: "unicode/invisible-binary",
          type: "unicode_smuggling",
          concealment: "smuggling",
          technique: `${rest.length} invisible characters encode text as binary`,
          hiddenText: binary,
          offset: run.start,
          ...views(run, `⟦${binary}⟧`),
          detail: `symbols: ${syms}`,
        }),
      );
      continue;
    }

    // 4. Individual characters with legitimate uses
    let severity: Severity | null = null;
    let ruleId = "unicode/invisible";
    let type: Finding["type"] = "zero_width";
    const flagged: number[] = [];
    const raise = (s: Severity, id: string, t: Finding["type"], cp: number) => {
      flagged.push(cp);
      if (!severity || RANK[s] > RANK[severity]) {
        severity = s;
        ruleId = id;
        type = t;
      }
    };

    const prevCp = run.prev.codePointAt(0) ?? 0;
    for (const cp of cps) {
      if (isTag(cp)) {
        raise("warning", "unicode/tags", "unicode_tags", cp); // tag chars with no printable payload
      } else if (isVS(cp)) {
        // Presentation selectors after emoji, keycaps, CJK ideographic variation sequences: normal.
        if (
          vs.length === 1 &&
          (cp >= 0xfe0e ||
            PICTOGRAPHIC.test(run.prev) ||
            CJK.test(run.prev) ||
            /[0-9#*]/.test(run.prev) ||
            !/[A-Za-z]/.test(run.prev))
        )
          continue;
        raise(vs.length >= 2 ? "warning" : "info", "unicode/variation-selector", "variation_selector", cp);
      } else if (cp === 0x200d || cp === 0x200c) {
        const emojiSeq =
          cp === 0x200d &&
          (PICTOGRAPHIC.test(run.prev) || isSkinTone(prevCp) || vs.length > 0) &&
          PICTOGRAPHIC.test(run.next);
        if (emojiSeq) continue;
        const script = getDominantScript(content, run.start);
        if (isJoiningScript(script) || opts.expectedScripts?.includes(script)) continue;
        raise("warning", "unicode/zero-width", "zero_width", cp);
      } else if (
        (cp === 0x200b || cp === 0x2060) &&
        cps.length <= 2 &&
        NO_SPACE_SCRIPTS.has(getDominantScript(content, run.start))
      ) {
      } else if (cp === 0xfeff && run.start === 0) {
      } else if (cp === 0x00ad && cps.length === 1 && /\p{L}/u.test(run.prev) && /\p{L}/u.test(run.next)) {
      } else if (isBidiMark(cp) || isBidiIsolate(cp)) {
        if (hasRTL) continue;
        raise("warning", "unicode/bidi", "bidi_override", cp);
      } else if (isBidiEmbed(cp)) {
        // Critical only when the reordered span (up to POP DIRECTIONAL FORMATTING or end of line)
        // contains letters or digits — otherwise nothing a reader relies on changes on screen.
        const rest = content.slice(run.end);
        const span = rest.slice(
          0,
          Math.min(...[rest.indexOf("\u202c"), rest.indexOf("\n")].filter((n) => n >= 0), rest.length),
        );
        const reorders = /[\p{L}\p{N}]/u.test(span);
        raise(hasRTL || !reorders ? "warning" : "critical", "unicode/bidi-override", "bidi_override", cp);
      } else if (isPUA(String.fromCodePoint(cp))) {
        const puaRun = cps.filter((c) => isPUA(String.fromCodePoint(c))).length;
        raise(puaRun >= 3 ? "warning" : "info", "unicode/private-use", "zero_width", cp);
      } else {
        raise("warning", "unicode/invisible", "zero_width", cp);
      }
    }
    if (!severity) continue;
    // One or two zero-width characters cannot carry a payload; outside agent instruction
    // files (where they could split a keyword past a filter) they are informational.
    if (
      flagged.length <= 2 &&
      !opts.instructionFile &&
      severity === "warning" &&
      (ruleId === "unicode/invisible" || ruleId === "unicode/zero-width")
    ) {
      severity = "info";
    }
    // Long runs with no innocent reading, even if we could not decode them
    if (flagged.length >= 16 && RANK[severity as Severity] < 2) {
      severity = "critical";
      ruleId = "unicode/invisible-run";
    }

    const unique = [...new Set(flagged)];
    const v = views(
      run,
      unique.length
        ? visualize(String.fromCodePoint(...flagged.slice(0, 12))) + (flagged.length > 12 ? "…" : "")
        : "",
    );
    findings.push({
      ruleId,
      type,
      severity: severity as Severity,
      offset: run.start,
      ...v,
      message:
        ruleId === "unicode/bidi-override"
          ? `Bidirectional override can display text in a different order than it is read (${unique.map(codepointName).join(", ")})`
          : `${flagged.length} invisible character${flagged.length > 1 ? "s" : ""}: ${unique.slice(0, 4).map(codepointName).join(", ")}${unique.length > 4 ? ", …" : ""}`,
      detail: unique.map(codepointName).join(", "),
    });
  }

  return capPerRule(findings);
}

/** Keep the first MAX_PER_RULE findings per rule and summarise the rest. */
export function capPerRule(findings: Finding[]): Finding[] {
  const counts = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = counts.get(f.ruleId) ?? [];
    list.push(f);
    counts.set(f.ruleId, list);
  }
  const out: Finding[] = [];
  for (const [ruleId, list] of counts) {
    out.push(...list.slice(0, MAX_PER_RULE));
    if (list.length > MAX_PER_RULE) {
      const extra = list.slice(MAX_PER_RULE);
      const worst = extra.reduce<Severity>((m, f) => (RANK[f.severity] > RANK[m] ? f.severity : m), "info");
      out.push({
        ruleId,
        type: extra[0].type,
        severity: worst,
        line: extra[0].line,
        message: `…and ${extra.length} more ${ruleId} findings (lines ${extra
          .slice(0, 8)
          .map((f) => f.line)
          .join(", ")}${extra.length > 8 ? ", …" : ""})`,
        humanView: "",
        agentView: "",
      });
    }
  }
  return out;
}
