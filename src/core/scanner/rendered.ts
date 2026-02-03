import type { Finding } from "../types.js";
import {
  HIDDEN_CSS_INDICATORS,
  FILE_TYPE_MAP,
  PREVIEW_SHORT,
  PREVIEW_LONG,
  CSS_FG_COLOR_RE,
  CSS_BG_COLOR_RE,
  HTML_COMMENT_RE,
} from "../constants/index.js";
import { isColorHidden } from "../utils/color.js";
import { getSourceContext, buildDiffViews } from "../utils/context.js";
import MarkdownIt from "markdown-it";
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

const md = new MarkdownIt();

/**
 * Determine scanner type from file path or content.
 */
function detectFileType(
  filePath: string,
  content?: string,
): "markdown" | "html" | "pdf" | null {
  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex > 0 ? filePath.slice(dotIndex).toLowerCase() : "";
  if (FILE_TYPE_MAP.markdown.includes(ext as (typeof FILE_TYPE_MAP.markdown)[number]))
    return "markdown";
  if (FILE_TYPE_MAP.html.includes(ext as (typeof FILE_TYPE_MAP.html)[number])) return "html";
  if (FILE_TYPE_MAP.pdf.includes(ext as (typeof FILE_TYPE_MAP.pdf)[number])) return "pdf";

  // Fallback: check content for HTML markers
  if (content && (/<!DOCTYPE/i.test(content) || /<html/i.test(content))) {
    return "html";
  }

  return null;
}

/**
 * Extract visible text from an HTML string (strip all tags, keeping only text content).
 */
export function extractVisibleText(html: string): string {
  const $ = cheerio.load(html);

  // Remove elements that are not visible
  $("script, style, noscript").remove();

  // Remove elements with hidden styles
  $("[style]").each((_i, el) => {
    const style = $(el).attr("style") || "";
    for (const indicator of Object.values(HIDDEN_CSS_INDICATORS)) {
      if (indicator.test(style)) {
        $(el).remove();
        return;
      }
    }
  });

  // Remove elements with hidden attribute
  $("[hidden]").remove();

  // Remove HTML comments (cheerio keeps them as comment nodes)
  $("*")
    .contents()
    .filter(function () {
      return this.type === "comment";
    })
    .remove();

  return $.text().replace(/\s+/g, " ").trim();
}

/**
 * Extract ALL text from HTML (including hidden elements, comments, scripts).
 */
export function extractAllText(html: string): string {
  const $ = cheerio.load(html);
  let text = $.text().replace(/\s+/g, " ").trim();

  // Also extract comment text
  const comments: string[] = [];
  $("*")
    .contents()
    .filter(function () {
      return this.type === "comment";
    })
    .each(function () {
      const data = (this as unknown as { data: string }).data?.trim();
      if (data) comments.push(data);
    });

  if (comments.length > 0) {
    text += " " + comments.join(" ");
  }

  return text;
}

/**
 * Scan Markdown content for hidden elements.
 */
export function scanMarkdown(content: string): Finding[] {
  const findings: Finding[] = [];

  // Check for Markdown comments: [//]: # (hidden text)
  const commentPattern = /\[\/\/\]:\s*#\s*\(([^)]+)\)/g;
  let match;
  while ((match = commentPattern.exec(content)) !== null) {
    const hiddenText = match[1];
    const line = content.substring(0, match.index).split("\n").length;
    const ctx = getSourceContext(content, line);
    const agentTargetLines = ctx.target.map((l) => `[AGENT SEES] ${hiddenText}`);
    const views = buildDiffViews(ctx, agentTargetLines);
    findings.push({
      type: "html_comment",
      severity: "warning",
      line,
      offset: match.index,
      message: "Markdown comment with hidden content",
      humanView: views.humanView,
      agentView: views.agentView,
      detail: `Markdown comment: [//]: # (${hiddenText})`,
    });
  }

  // Check for HTML comments embedded in Markdown
  const htmlCommentPattern = new RegExp(HTML_COMMENT_RE.source, "g");
  while ((match = htmlCommentPattern.exec(content)) !== null) {
    const commentText = match[1].trim();
    if (!commentText) continue;
    const line = content.substring(0, match.index).split("\n").length;
    const ctx = getSourceContext(content, line);
    const agentTargetLines = ctx.target.map((l) => `[AGENT SEES] ${commentText}`);
    const views = buildDiffViews(ctx, agentTargetLines);
    findings.push({
      type: "html_comment",
      severity: "warning",
      line,
      offset: match.index,
      message: "HTML comment in Markdown with hidden content",
      humanView: views.humanView,
      agentView: views.agentView,
      detail: `HTML comment: <!-- ${commentText.slice(0, PREVIEW_LONG)}${commentText.length > PREVIEW_LONG ? "..." : ""} -->`,
    });
  }

  // Check for HTML elements with hidden styles embedded in Markdown
  const htmlInMd = /<[^>]+style\s*=\s*["'][^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi;
  while ((match = htmlInMd.exec(content)) !== null) {
    const snippet = match[0];
    const $snip = cheerio.load(snippet);
    $snip("[style]").each((_i, el) => {
      const style = $snip(el).attr("style") || "";
      for (const [name, indicator] of Object.entries(HIDDEN_CSS_INDICATORS)) {
        if (indicator.test(style)) {
          const hiddenText = $snip(el).text().trim();
          if (!hiddenText) return;
          const line = content.substring(0, match!.index).split("\n").length;
          const ctx = getSourceContext(content, line);
          const agentTargetLines = ctx.target.map((l) => `[AGENT SEES] ${hiddenText}`);
          const views = buildDiffViews(ctx, agentTargetLines);
          findings.push({
            type: "hidden_rendered",
            severity: "critical",
            line,
            offset: match!.index,
            message: `Hidden HTML element in Markdown (${name})`,
            humanView: views.humanView,
            agentView: views.agentView,
            detail: `CSS: ${style.slice(0, PREVIEW_LONG)}`,
          });
        }
      }
    });
  }

  return findings;
}

/**
 * Get the line number of an element in the source HTML.
 */
function getElementLine(content: string, $: cheerio.CheerioAPI, el: AnyNode): number {
  const html = $.html(el) || "";
  const idx = content.indexOf(html);
  if (idx === -1) return 1;
  return content.substring(0, idx).split("\n").length;
}

/**
 * Build humanView/agentView for an HTML finding.
 * humanView = context lines WITHOUT the hidden target (human can't see it).
 * agentView = context lines WITH the hidden text revealed on the target line.
 */
function htmlFindingViews(
  content: string,
  line: number,
  hiddenText: string,
): { humanView: string; agentView: string; startLine: number } {
  const ctx = getSourceContext(content, line);
  // Human sees the surrounding lines but the target line is invisible to them
  const humanLines = [
    ...ctx.before.map((l) => l.text),
    ...ctx.target.map((l) => l.text),
    ...ctx.after.map((l) => l.text),
  ];
  // Agent sees the target replaced with the extracted hidden content
  const agentLines = [
    ...ctx.before.map((l) => l.text),
    ...ctx.target.map((l) => `[AGENT SEES] ${hiddenText}`),
    ...ctx.after.map((l) => l.text),
  ];
  return {
    humanView: humanLines.join("\n"),
    agentView: agentLines.join("\n"),
    startLine: ctx.startLine,
  };
}

/**
 * Scan HTML content for hidden elements.
 */
export function scanHTML(content: string): Finding[] {
  const findings: Finding[] = [];
  const $ = cheerio.load(content);

  // Check for hidden elements via inline styles
  $("[style]").each((_i, el) => {
    const style = $(el).attr("style") || "";
    const text = $(el).text().trim();
    if (!text) return;

    for (const [name, indicator] of Object.entries(HIDDEN_CSS_INDICATORS)) {
      if (indicator.test(style)) {
        const line = getElementLine(content, $, el);
        const views = htmlFindingViews(content, line, text);
        findings.push({
          type: "hidden_rendered",
          severity: "critical",
          line,
          message: `Hidden element detected (${name}): "${text.slice(0, PREVIEW_SHORT)}"`,
          humanView: views.humanView,
          agentView: views.agentView,
          detail: `CSS property: ${style}`,
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
        const line = getElementLine(content, $, el);
        const views = htmlFindingViews(content, line, text);
        findings.push({
          type: "hidden_rendered",
          severity: "critical",
          line,
          message: `Hidden text via color: "${text.slice(0, PREVIEW_SHORT)}"`,
          humanView: views.humanView,
          agentView: views.agentView,
          detail: `color: ${fgColor}${bgColor ? `, background: ${bgColor}` : ""}`,
        });
      }
    }
  });

  // Check for hidden attribute
  $("[hidden]").each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    const line = getElementLine(content, $, el);
    const views = htmlFindingViews(content, line, text);
    findings.push({
      type: "hidden_rendered",
      severity: "critical",
      line,
      message: `Hidden element (hidden attribute): "${text.slice(0, PREVIEW_SHORT)}"`,
      humanView: views.humanView,
      agentView: views.agentView,
      detail: "HTML hidden attribute",
    });
  });

  // Check for HTML comments
  const commentPattern = new RegExp(HTML_COMMENT_RE.source, "g");
  let match;
  while ((match = commentPattern.exec(content)) !== null) {
    const commentText = match[1].trim();
    if (!commentText) continue;
    const line = content.substring(0, match.index).split("\n").length;
    const views = htmlFindingViews(content, line, commentText);
    findings.push({
      type: "html_comment",
      severity: "warning",
      line,
      offset: match.index,
      message: `HTML comment with content: "${commentText.slice(0, PREVIEW_SHORT)}"`,
      humanView: views.humanView,
      agentView: views.agentView,
      detail: `<!-- ${commentText.slice(0, PREVIEW_LONG)}${commentText.length > PREVIEW_LONG ? "..." : ""} -->`,
    });
  }

  // Check for script/style tag content
  $("script").each((_i, el) => {
    const text = $(el).text().trim();
    if (!text) return;
    findings.push({
      type: "hidden_rendered",
      severity: "info",
      message: `Script tag content (not visible to humans): ${text.slice(0, PREVIEW_SHORT)}`,
      humanView: "",
      agentView: text.slice(0, PREVIEW_LONG),
      detail: "Content inside <script> tag",
    });
  });

  return findings;
}

/**
 * Scan PDF content for hidden text.
 * Uses pdfjs-dist to extract text items with position/style info.
 */
export async function scanPDF(
  buffer: Uint8Array,
  filePath: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  try {
    // Dynamic import to avoid loading pdfjs-dist when not needed
    const pdfjsLib = await import("pdfjs-dist");
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if (!("str" in item)) continue;
        const textItem = item as { str: string; transform: number[] };
        const text = textItem.str;

        // Check for very small text (transform[0] and transform[3] are scale values)
        if (textItem.transform) {
          const scaleX = Math.abs(textItem.transform[0]);
          const scaleY = Math.abs(textItem.transform[3]);
          if ((scaleX < 1 || scaleY < 1) && text.trim().length > 0) {
            findings.push({
              type: "hidden_rendered",
              severity: "warning",
              message: `Very small text in PDF page ${pageNum}: "${text.slice(0, PREVIEW_SHORT)}"`,
              humanView: "(not visible at normal zoom)",
              agentView: text,
              detail: `Font scale: ${scaleX.toFixed(2)}x${scaleY.toFixed(2)} on page ${pageNum}`,
            });
          }
        }
      }
    }
  } catch (err) {
    findings.push({
      type: "hidden_rendered",
      severity: "info",
      message: `Could not fully parse PDF: ${filePath}`,
      humanView: "",
      agentView: "",
      detail: String(err),
    });
  }

  return findings;
}

/**
 * Main entry point: scan content for rendering-layer hidden content.
 */
export function scanRendered(content: string, filePath: string): Finding[] {
  const fileType = detectFileType(filePath, content);

  switch (fileType) {
    case "markdown":
      return scanMarkdown(content);
    case "html":
      return scanHTML(content);
    // PDF is handled separately via scanPDF (needs buffer)
    default:
      return [];
  }
}
