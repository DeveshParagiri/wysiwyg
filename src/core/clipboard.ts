import * as cheerio from "cheerio";
import { diffWords } from "diff";
import { scanHtml } from "./html/scan.js";
import { concealedFinding } from "./policy.js";
import type { Finding } from "./types.js";

/**
 * Clipboard projection.
 *
 * Rich copies carry two flavours: the HTML a paste target renders and the
 * plain text a terminal or chat box receives. Hidden content in the HTML is
 * found with the HTML engine; text present in the HTML flavour but absent
 * from the plain-text flavour is a second, independent signal.
 *
 * Pure function — reading the OS clipboard lives in cli/platform/clipboard.ts.
 */
export function analyzeClipboardHTML(html: string, plainText: string): Finding[] {
  if (!html) return [];
  const findings: Finding[] = scanHtml(html, { staticDocument: true, rulePrefix: "clipboard" }).map((f) => ({
    ...f,
    type: "clipboard_hidden",
  }));

  const $ = cheerio.load(html);
  $("script, style, head").remove();
  const htmlText = $.text().replace(/\s+/g, " ").trim();
  const plain = plainText.replace(/\s+/g, " ").trim();
  if (plain && htmlText.length > plain.length + 20) {
    const extra = diffWords(plain, htmlText)
      .filter((p) => p.added)
      .map((p) => p.value.trim())
      .filter(Boolean)
      .join(" ");
    const alreadyReported = findings.some((f) => f.hiddenText && extra.includes(f.hiddenText.slice(0, 30)));
    if (extra.length >= 20 && !alreadyReported) {
      findings.push(
        concealedFinding({
          ruleId: "clipboard/html-only-text",
          type: "clipboard_hidden",
          concealment: "channel",
          technique: "Text present in the clipboard's HTML but not in its plain text",
          hiddenText: extra,
          humanView: plain.slice(0, 200),
          agentView: htmlText.slice(0, 200),
        }),
      );
    }
  }
  return findings;
}
