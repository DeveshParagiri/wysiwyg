import type { Finding } from "../types.js";
import { UNICODE_RANGES } from "../constants/index.js";
import { getDominantScript, isJoiningScript } from "../utils/script-detect.js";
import { getSourceContext, buildDiffViews } from "../utils/context.js";

/**
 * Decode Unicode Tags (U+E0000–U+E007F) to their hidden ASCII text.
 */
export function decodeUnicodeTags(chars: string): string {
  let decoded = "";
  for (const char of chars) {
    const cp = char.codePointAt(0)!;
    if (cp >= 0xe0000 && cp <= 0xe007f) {
      const ascii = cp - 0xe0000;
      if (ascii >= 0x20 && ascii <= 0x7e) {
        decoded += String.fromCharCode(ascii);
      }
    }
  }
  return decoded;
}

/**
 * Get the line number (1-indexed) for a character offset in a string.
 */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Get a codepoint description string like "U+200B (ZERO WIDTH SPACE)".
 */
function codepointName(cp: number): string {
  const hex = "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  const names: Record<number, string> = {
    0x200b: "ZERO WIDTH SPACE",
    0x200c: "ZERO WIDTH NON-JOINER",
    0x200d: "ZERO WIDTH JOINER",
    0xfeff: "BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE",
    0x2060: "WORD JOINER",
    0x202a: "LEFT-TO-RIGHT EMBEDDING",
    0x202b: "RIGHT-TO-LEFT EMBEDDING",
    0x202c: "POP DIRECTIONAL FORMATTING",
    0x202d: "LEFT-TO-RIGHT OVERRIDE",
    0x202e: "RIGHT-TO-LEFT OVERRIDE",
    0x2066: "LEFT-TO-RIGHT ISOLATE",
    0x2067: "RIGHT-TO-LEFT ISOLATE",
    0x2068: "FIRST STRONG ISOLATE",
    0x2069: "POP DIRECTIONAL ISOLATE",
    0x00ad: "SOFT HYPHEN",
    0x2061: "FUNCTION APPLICATION",
    0x2062: "INVISIBLE TIMES",
    0x2063: "INVISIBLE SEPARATOR",
    0x2064: "INVISIBLE PLUS",
  };
  return names[cp] ? `${hex} (${names[cp]})` : hex;
}

/**
 * Strip invisible codepoints from a string, leaving only visible chars.
 */
function stripInvisible(str: string): string {
  let result = "";
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    const charLen = cp > 0xffff ? 2 : 1;
    if (!isInvisibleCodepoint(cp)) {
      result += String.fromCodePoint(cp);
    }
    i += charLen;
  }
  return result;
}

/**
 * Build humanView/agentView from source lines around a finding.
 * Human sees lines with invisible chars stripped.
 * Agent sees lines with invisible chars stripped + decoded hidden text revealed.
 */
function unicodeFindingViews(
  content: string,
  line: number,
  decodedHidden?: string,
): { humanView: string; agentView: string; startLine: number } {
  const ctx = getSourceContext(content, line);
  // Human view: source lines with invisible chars stripped
  const allLines = [...ctx.before, ...ctx.target, ...ctx.after];
  const humanView = allLines.map((l) => stripInvisible(l.text)).join("\n");

  if (!decodedHidden) {
    return { humanView, agentView: humanView, startLine: ctx.startLine };
  }

  // Agent view: same but target lines show decoded hidden content
  const agentLines = [
    ...ctx.before.map((l) => stripInvisible(l.text)),
    ...ctx.target.map((l) => stripInvisible(l.text) + decodedHidden),
    ...ctx.after.map((l) => stripInvisible(l.text)),
  ];
  return { humanView, agentView: agentLines.join("\n"), startLine: ctx.startLine };
}

function isInvisibleCodepoint(cp: number): boolean {
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  if ((UNICODE_RANGES.zeroWidth as readonly number[]).includes(cp)) return true;
  if ((UNICODE_RANGES.bidiOverrides as readonly number[]).includes(cp)) return true;
  if ((UNICODE_RANGES.bidiIsolates as readonly number[]).includes(cp)) return true;
  if (cp >= UNICODE_RANGES.variationSelectors.start && cp <= UNICODE_RANGES.variationSelectors.end)
    return true;
  if (
    cp >= UNICODE_RANGES.variationSelectorsSupp.start &&
    cp <= UNICODE_RANGES.variationSelectorsSupp.end
  )
    return true;
  if (cp === UNICODE_RANGES.softHyphen) return true;
  if ((UNICODE_RANGES.invisibleMath as readonly number[]).includes(cp)) return true;
  return false;
}

/**
 * Scan content for hidden Unicode characters.
 * Returns findings with context-aware severity.
 */
export function scanUnicode(content: string, filename?: string): Finding[] {
  const findings: Finding[] = [];

  // Track runs of Unicode Tags for decoding
  let tagRun = "";
  let tagRunStart = -1;

  // Check if visible content is ASCII-only (affects severity of some findings)
  // Strip invisible characters before checking, since files with injected
  // invisible chars should still be considered "ASCII-only" for severity purposes
  const visibleContent = [...content]
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return !isInvisibleCodepoint(cp);
    })
    .join("");
  const isAsciiOnly = /^[\x00-\x7F]*$/.test(visibleContent);

  let charIndex = 0;
  for (const char of content) {
    const cp = char.codePointAt(0)!;

    // --- Unicode Tags (U+E0000–U+E007F) ---
    if (cp >= UNICODE_RANGES.tags.start && cp <= UNICODE_RANGES.tags.end) {
      if (tagRunStart === -1) tagRunStart = charIndex;
      tagRun += char;
      charIndex += char.length;
      continue;
    }

    // If we were in a tag run and hit a non-tag char, flush
    if (tagRun.length > 0) {
      const decoded = decodeUnicodeTags(tagRun);
      const line = getLineNumber(content, tagRunStart);
      const views = unicodeFindingViews(content, line, decoded);
      findings.push({
        type: "unicode_tags",
        severity: "critical",
        line,
        offset: tagRunStart,
        message: `Unicode Tags block encoding detected: hidden text "${decoded}"`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: `${tagRun.length} tag characters encoding "${decoded}" (U+E0000–U+E007F range)`,
      });
      tagRun = "";
      tagRunStart = -1;
    }

    // --- Zero-width characters ---
    if ((UNICODE_RANGES.zeroWidth as readonly number[]).includes(cp)) {
      // BOM at start of file is info/suppressed
      if (cp === UNICODE_RANGES.bom && charIndex === 0) {
        charIndex += char.length;
        continue;
      }

      const script = getDominantScript(content, charIndex);
      const isJoining = isJoiningScript(script);

      // ZWJ (U+200D) and ZWNJ (U+200C) in joining scripts are legitimate
      if ((cp === 0x200c || cp === 0x200d) && isJoining) {
        charIndex += char.length;
        continue;
      }

      const severity = isAsciiOnly ? "critical" : "warning";
      const line = getLineNumber(content, charIndex);
      const views = unicodeFindingViews(content, line);

      findings.push({
        type: "zero_width",
        severity: severity as "critical" | "warning",
        line,
        offset: charIndex,
        message: `Zero-width character found: ${codepointName(cp)}`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: `${codepointName(cp)} in ${script} context${isAsciiOnly ? " (ASCII-only file — elevated severity)" : ""}`,
      });
    }

    // --- Bidi overrides ---
    if ((UNICODE_RANGES.bidiOverrides as readonly number[]).includes(cp)) {
      const line = getLineNumber(content, charIndex);
      const views = unicodeFindingViews(content, line);
      findings.push({
        type: "bidi_override",
        severity: "critical",
        line,
        offset: charIndex,
        message: `Bidirectional override character found: ${codepointName(cp)}`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: `${codepointName(cp)} — can be used to reverse text display order, hiding malicious content`,
      });
    }

    // --- Bidi isolates ---
    if ((UNICODE_RANGES.bidiIsolates as readonly number[]).includes(cp)) {
      const line = getLineNumber(content, charIndex);
      const views = unicodeFindingViews(content, line);
      findings.push({
        type: "bidi_override",
        severity: "warning",
        line,
        offset: charIndex,
        message: `Bidirectional isolate character found: ${codepointName(cp)}`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: codepointName(cp),
      });
    }

    // --- Variation selectors ---
    if (
      (cp >= UNICODE_RANGES.variationSelectors.start &&
        cp <= UNICODE_RANGES.variationSelectors.end) ||
      (cp >= UNICODE_RANGES.variationSelectorsSupp.start &&
        cp <= UNICODE_RANGES.variationSelectorsSupp.end)
    ) {
      const line = getLineNumber(content, charIndex);
      const views = unicodeFindingViews(content, line);
      findings.push({
        type: "variation_selector",
        severity: "info",
        line,
        offset: charIndex,
        message: `Variation selector found: ${codepointName(cp)}`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: codepointName(cp),
      });
    }

    // --- Invisible math operators ---
    if ((UNICODE_RANGES.invisibleMath as readonly number[]).includes(cp)) {
      const line = getLineNumber(content, charIndex);
      const views = unicodeFindingViews(content, line);
      findings.push({
        type: "zero_width",
        severity: "warning",
        line,
        offset: charIndex,
        message: `Invisible math operator found: ${codepointName(cp)}`,
        humanView: views.humanView,
        agentView: views.agentView,
        detail: codepointName(cp),
      });
    }

    charIndex += char.length;
  }

  // Flush any remaining tag run at end of content
  if (tagRun.length > 0) {
    const decoded = decodeUnicodeTags(tagRun);
    const line = getLineNumber(content, tagRunStart);
    const views = unicodeFindingViews(content, line, decoded);
    findings.push({
      type: "unicode_tags",
      severity: "critical",
      line,
      offset: tagRunStart,
      message: `Unicode Tags block encoding detected: hidden text "${decoded}"`,
      humanView: views.humanView,
      agentView: views.agentView,
      detail: `${tagRun.length} tag characters encoding "${decoded}" (U+E0000–U+E007F range)`,
    });
  }

  return findings;
}
