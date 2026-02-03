import { JOINING_SCRIPTS } from "../constants/index.js";

/**
 * Simple Unicode script detection based on codepoint ranges.
 * Returns the script name for a given codepoint.
 */
export function detectScript(codepoint: number): string {
  // Latin
  if (
    (codepoint >= 0x0041 && codepoint <= 0x005a) ||
    (codepoint >= 0x0061 && codepoint <= 0x007a) ||
    (codepoint >= 0x00c0 && codepoint <= 0x024f)
  ) {
    return "Latin";
  }

  // Arabic
  if (
    (codepoint >= 0x0600 && codepoint <= 0x06ff) ||
    (codepoint >= 0x0750 && codepoint <= 0x077f) ||
    (codepoint >= 0x08a0 && codepoint <= 0x08ff) ||
    (codepoint >= 0xfb50 && codepoint <= 0xfdff) ||
    (codepoint >= 0xfe70 && codepoint <= 0xfeff)
  ) {
    return "Arabic";
  }

  // Syriac
  if (codepoint >= 0x0700 && codepoint <= 0x074f) {
    return "Syriac";
  }

  // Devanagari
  if (codepoint >= 0x0900 && codepoint <= 0x097f) {
    return "Devanagari";
  }

  // Bengali
  if (codepoint >= 0x0980 && codepoint <= 0x09ff) {
    return "Bengali";
  }

  // Gurmukhi
  if (codepoint >= 0x0a00 && codepoint <= 0x0a7f) {
    return "Gurmukhi";
  }

  // Gujarati
  if (codepoint >= 0x0a80 && codepoint <= 0x0aff) {
    return "Gujarati";
  }

  // Oriya
  if (codepoint >= 0x0b00 && codepoint <= 0x0b7f) {
    return "Oriya";
  }

  // Tamil
  if (codepoint >= 0x0b80 && codepoint <= 0x0bff) {
    return "Tamil";
  }

  // Telugu
  if (codepoint >= 0x0c00 && codepoint <= 0x0c7f) {
    return "Telugu";
  }

  // Kannada
  if (codepoint >= 0x0c80 && codepoint <= 0x0cff) {
    return "Kannada";
  }

  // Malayalam
  if (codepoint >= 0x0d00 && codepoint <= 0x0d7f) {
    return "Malayalam";
  }

  // Sinhala
  if (codepoint >= 0x0d80 && codepoint <= 0x0dff) {
    return "Sinhala";
  }

  // Thai
  if (codepoint >= 0x0e00 && codepoint <= 0x0e7f) {
    return "Thai";
  }

  // Tibetan
  if (codepoint >= 0x0f00 && codepoint <= 0x0fff) {
    return "Tibetan";
  }

  // Myanmar
  if (codepoint >= 0x1000 && codepoint <= 0x109f) {
    return "Myanmar";
  }

  // Mongolian
  if (codepoint >= 0x1800 && codepoint <= 0x18af) {
    return "Mongolian";
  }

  // CJK
  if (
    (codepoint >= 0x4e00 && codepoint <= 0x9fff) ||
    (codepoint >= 0x3400 && codepoint <= 0x4dbf) ||
    (codepoint >= 0x3000 && codepoint <= 0x303f)
  ) {
    return "CJK";
  }

  // Hangul (Korean)
  if (
    (codepoint >= 0xac00 && codepoint <= 0xd7af) ||
    (codepoint >= 0x1100 && codepoint <= 0x11ff)
  ) {
    return "Hangul";
  }

  // Cyrillic
  if (codepoint >= 0x0400 && codepoint <= 0x04ff) {
    return "Cyrillic";
  }

  // Greek
  if (codepoint >= 0x0370 && codepoint <= 0x03ff) {
    return "Greek";
  }

  // Hebrew
  if (codepoint >= 0x0590 && codepoint <= 0x05ff) {
    return "Hebrew";
  }

  // Mandaic
  if (codepoint >= 0x0840 && codepoint <= 0x085f) {
    return "Mandaic";
  }

  // Common (digits, punctuation, symbols)
  if (
    (codepoint >= 0x0030 && codepoint <= 0x0039) ||
    (codepoint >= 0x0020 && codepoint <= 0x002f) ||
    (codepoint >= 0x003a && codepoint <= 0x0040) ||
    (codepoint >= 0x005b && codepoint <= 0x0060) ||
    (codepoint >= 0x007b && codepoint <= 0x007e)
  ) {
    return "Common";
  }

  return "Unknown";
}

/**
 * Get the dominant script of characters surrounding a position.
 * Looks at `window` characters before and after the position.
 */
export function getDominantScript(
  content: string,
  position: number,
  window: number = 20,
): string {
  const scriptCounts = new Map<string, number>();
  const start = Math.max(0, position - window);
  const end = Math.min(content.length, position + window);

  for (let i = start; i < end; i++) {
    if (i === position) continue;
    const cp = content.codePointAt(i);
    if (cp === undefined) continue;
    // Skip surrogates
    if (cp > 0xffff) i++;
    const script = detectScript(cp);
    if (script !== "Common" && script !== "Unknown") {
      scriptCounts.set(script, (scriptCounts.get(script) ?? 0) + 1);
    }
  }

  let dominant = "Latin"; // default
  let maxCount = 0;
  for (const [script, count] of scriptCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominant = script;
    }
  }

  return dominant;
}

/**
 * Check if a script uses joining characters legitimately.
 */
export function isJoiningScript(script: string): boolean {
  return (JOINING_SCRIPTS as readonly string[]).includes(script);
}
