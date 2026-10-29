import MarkdownIt from "markdown-it";
import { scanHtml } from "../html/scan.js";
import { concealedFinding } from "../policy.js";
import { LineIndex } from "../text/lines.js";
import type { Finding } from "../types.js";

/**
 * Markdown projection: render the Markdown the way a viewer would (raw HTML
 * allowed, as on GitHub, VS Code and most doc sites), then run the HTML
 * engine over the result as a static document. Reference definitions are
 * dropped by every renderer, so their titles — the classic `[//]: # (...)`
 * comment idiom — are handled from the source.
 */

const md = new MarkdownIt({ html: true, linkify: false });

const REF_DEF =
  /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+("([^"\n]*)"|'([^'\n]*)'|\(([^)\n]*)\)))?[ \t]*$/;

/** Front matter is metadata, not rendered prose; blank it out but keep line numbers. */
function blankFrontMatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, (fm) => fm.replace(/[^\n]/g, " "));
}

/** Comment-style reference definitions (`[//]: # (...)`, `[comment]: <> (...)`). */
function isRefComment(label: string, target: string): boolean {
  return /^(#|<>|\/\/)$/.test(target) || /^(\/\/|comment|#|_)$/i.test(label);
}

/**
 * The HTML a Markdown viewer renders (same markdown-it setup as the scanner),
 * with front matter and comment-style reference definitions removed so they
 * can never surface as text even where a parser would not recognise them.
 */
export function renderMarkdownHtml(content: string): string {
  const lines = blankFrontMatter(content).split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = REF_DEF.exec(lines[i]);
    if (m && isRefComment(m[1], m[2])) lines[i] = "";
  }
  return md.render(lines.join("\n"));
}

export function scanMarkdown(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  const body = blankFrontMatter(content);
  const findings = scanHtml(md.render(body), {
    source: content,
    staticDocument: true,
    instructionFile: opts.instructionFile,
    rulePrefix: "markdown",
  });

  const idx = new LineIndex(content);
  let inFence = false;
  for (let n = 1; n <= idx.lines.length; n++) {
    const line = idx.line(n);
    if (/^ {0,3}(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = REF_DEF.exec(line);
    if (!m) continue;
    const [, label, target] = m;
    const title = m[4] ?? m[5] ?? m[6];
    const isComment = isRefComment(label, target);
    const hidden = title ?? (isComment ? label : undefined);
    if (!hidden) continue;
    findings.push(
      concealedFinding({
        ruleId: isComment ? "markdown/reference-comment" : "markdown/reference-title",
        type: "html_comment",
        concealment: "channel",
        technique: isComment
          ? "Markdown comment (reference definition, never rendered)"
          : "Reference-link title (tooltip only)",
        hiddenText: hidden,
        line: n,
        humanView: "",
        agentView: line,
        instructionFile: opts.instructionFile,
      }),
    );
  }
  return findings;
}
