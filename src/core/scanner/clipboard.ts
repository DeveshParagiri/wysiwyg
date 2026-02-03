import type { Finding } from "../types.js";
import {
  HIDDEN_CSS_INDICATORS,
  PREVIEW_SHORT,
  PREVIEW_MEDIUM,
  PREVIEW_LONG,
  CSS_FG_COLOR_RE,
  CSS_BG_COLOR_RE,
} from "../constants/index.js";
import { isColorHidden } from "../utils/color.js";
import * as cheerio from "cheerio";

/**
 * Analyze clipboard HTML for rendering-layer hidden content.
 * Pure function: takes HTML and plainText strings, returns findings.
 * No OS calls — platform clipboard reading is handled by cli/platform/clipboard.ts.
 */
export function analyzeClipboardHTML(
  html: string,
  plainText: string,
): Finding[] {
  const findings: Finding[] = [];

  if (!html) return findings;

  const $ = cheerio.load(html);

  // Check all elements with inline styles
  $("[style]").each((_i, el) => {
    const style = $(el).attr("style") || "";
    const text = $(el).text().trim();
    if (!text) return;

    // Check CSS hiding indicators
    for (const [name, indicator] of Object.entries(HIDDEN_CSS_INDICATORS)) {
      if (indicator.test(style)) {
        findings.push({
          type: "clipboard_hidden",
          severity: "critical",
          message: `Hidden text in clipboard via ${name}: "${text.slice(0, PREVIEW_SHORT)}"`,
          humanView: plainText.slice(0, PREVIEW_MEDIUM),
          agentView: text.slice(0, PREVIEW_LONG),
          detail: `CSS: ${style.slice(0, PREVIEW_LONG)}`,
        });
        return; // One finding per element
      }
    }

    // Check for color-based hiding
    const colorMatch = CSS_FG_COLOR_RE.exec(style);
    const bgMatch = CSS_BG_COLOR_RE.exec(style);
    if (colorMatch) {
      const fgColor = colorMatch[1].trim();
      const bgColor = bgMatch ? bgMatch[1].trim() : undefined;
      if (isColorHidden(fgColor, bgColor)) {
        findings.push({
          type: "clipboard_hidden",
          severity: "critical",
          message: `Hidden text in clipboard via color matching: "${text.slice(0, PREVIEW_SHORT)}"`,
          humanView: plainText.slice(0, PREVIEW_MEDIUM),
          agentView: text.slice(0, PREVIEW_LONG),
          detail: `color: ${fgColor}${bgColor ? `, background: ${bgColor}` : ""}`,
        });
      }
    }
  });

  // Check for elements with hidden attribute
  $("[hidden]").each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    findings.push({
      type: "clipboard_hidden",
      severity: "critical",
      message: `Hidden element in clipboard (hidden attribute): "${text.slice(0, PREVIEW_SHORT)}"`,
      humanView: plainText.slice(0, PREVIEW_MEDIUM),
      agentView: text.slice(0, PREVIEW_LONG),
      detail: "HTML hidden attribute",
    });
  });

  // Check for aria-hidden elements
  $('[aria-hidden="true"]').each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    findings.push({
      type: "clipboard_hidden",
      severity: "warning",
      message: `Aria-hidden element in clipboard: "${text.slice(0, PREVIEW_SHORT)}"`,
      humanView: plainText.slice(0, PREVIEW_MEDIUM),
      agentView: text.slice(0, PREVIEW_LONG),
      detail: 'aria-hidden="true"',
    });
  });

  // Compare plain text vs HTML text content to find discrepancies
  const allHtmlText = $.text().replace(/\s+/g, " ").trim();
  const normalizedPlain = plainText.replace(/\s+/g, " ").trim();

  // If HTML contains significantly more text than plain text, flag it
  if (
    allHtmlText.length > normalizedPlain.length + 50 &&
    normalizedPlain.length > 0
  ) {
    // Find the extra text
    const extraLength = allHtmlText.length - normalizedPlain.length;
    findings.push({
      type: "clipboard_hidden",
      severity: "warning",
      message: `Clipboard HTML contains ~${extraLength} more characters than plain text`,
      humanView: normalizedPlain.slice(0, PREVIEW_MEDIUM),
      agentView: allHtmlText.slice(0, PREVIEW_LONG),
      detail: `Plain text: ${normalizedPlain.length} chars, HTML text: ${allHtmlText.length} chars`,
    });
  }

  return findings;
}
