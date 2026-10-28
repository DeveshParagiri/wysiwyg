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

export function scanMarkdown(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  // Front matter is metadata, not rendered prose; blank it out but keep line numbers.
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, (fm) => fm.replace(/[^\n]/g, " "));
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
    const isComment = /^(#|<>|\/\/)$/.test(target) || /^(\/\/|comment|#|_)$/i.test(label);
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
