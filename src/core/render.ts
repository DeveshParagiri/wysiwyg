import { renderHtml } from "./html/scan.js";
import { renderMarkdownHtml } from "./markdown/scan.js";
import { type DocKind, decodeText, dedupeFindings, detectKind, scanText } from "./pipeline.js";
import { scanLayout } from "./text/layout.js";
import { CONTROL_CLASS, INVISIBLE_CLASS } from "./text/lines.js";
import { hasTerminalControls, renderTerminal } from "./text/terminal.js";
import type { Finding } from "./types.js";
import { getDominantScript, isJoiningScript } from "./utils/script-detect.js";

/**
 * Visible-text rendering: the other half of the detector. Where the scanners
 * report what an agent reads but a human doesn't see, this returns the text a
 * human *does* see, so a pipeline (résumé screening, RAG ingestion, email
 * triage) can hand the model exactly what the reviewer saw.
 *
 *   text      — invisible/format/private-use/control characters removed (legitimate
 *               emoji sequences, flag tags and joiners in joining scripts are kept),
 *               terminal control sequences rendered to the screen text, text pushed
 *               off-screen by whitespace padding dropped; line structure kept
 *   markdown  — rendered like the scanner renders it, then the HTML path; front matter
 *               and comment-style reference definitions are dropped
 *   html/svg  — the cascade walk's visible text: no hidden or screen-reader-only text,
 *               comments, alt/title/aria, meta, <template>, <noscript> or closed <details>
 *   pdf       — visible glyph runs per page, pages separated by a blank line
 *   ooxml     — visible paragraphs / slides / cells (see core/documents/ooxml.ts)
 *   binary    — empty
 *
 * `removed` lists the scanner findings for content that was dropped. Findings for
 * content that stays in the text (encoded blobs, visible instructions in agent files)
 * are not included.
 */

/** Lines longer than this wrap when terminal sequences are present (400 with cursor moves). */
const MAX_TERMINAL_WIDTH = 8192;

export interface RenderOptions {
  /** Path used for format detection (and agent-file classification of the findings). */
  path: string;
  /** Override format detection. */
  kind?: DocKind;
  /** Scripts the project expects; passed to the Unicode scanner for `removed`. */
  expectedScripts?: string[];
}

export interface RenderedDocument {
  /** What a human sees. */
  text: string;
  kind: DocKind;
  /** Findings for what was left out of `text`. */
  removed: Finding[];
}

/** Render any file's visible text (async: PDF and Office parsing). Never throws on bad input. */
export async function renderVisible(bytes: Uint8Array, opts: RenderOptions): Promise<RenderedDocument> {
  const kind = opts.kind ?? detectKind(opts.path, bytes);
  if (kind === "binary") return { text: "", kind, removed: [] };
  if (kind === "pdf") {
    const { analyzePdf } = await import("./documents/pdf.js");
    const { findings, pages } = await analyzePdf(bytes);
    const text = pages
      .map((p) => trimLines(stripHidden(p)).trim())
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, kind, removed: removedOnly(dedupeFindings(findings), kind) };
  }
  if (kind === "ooxml") {
    const { analyzeOoxml, isOoxml } = await import("./documents/ooxml.js");
    if (!isOoxml(bytes)) return { text: "", kind, removed: [] };
    const { findings, text } = analyzeOoxml(bytes);
    return {
      text: trimLines(stripHidden(text)).trim(),
      kind,
      removed: removedOnly(dedupeFindings(findings), kind),
    };
  }
  return renderVisibleText(decodeText(bytes), { ...opts, kind });
}

/**
 * Render a text format's visible text (sync). PDF, Office and binary content
 * cannot be rendered from a string: they yield empty text — use renderVisible.
 */
export function renderVisibleText(content: string, opts: RenderOptions): RenderedDocument {
  const kind = opts.kind ?? detectKind(opts.path, new TextEncoder().encode(content.slice(0, 1024)));
  if (kind === "binary" || kind === "pdf" || kind === "ooxml") return { text: "", kind, removed: [] };
  const removed = removedOnly(
    scanText(content, { path: opts.path, kind, expectedScripts: opts.expectedScripts }),
    kind,
  );

  // 1. Bytes no viewer shows; a leading BOM; CRLF. A bare CR is a terminal overwrite (as for the scanner).
  let src = content.replace(/\0/g, "").replace(/^﻿/, "").replace(/\r\n/g, "\n");

  // 2. Terminal control sequences, rendered on the raw source (a reader who `cat`s it sees the screen).
  if (hasTerminalControls(src)) {
    // Wide enough that long lines (e.g. coloured logs) don't wrap. Horizontal cursor moves pad rows up
    // to the width, so with those present keep the scanner's 400 columns to bound memory.
    const moves = /(?:\x1b\[|\x9b)[0-9;:?<=>]*[CGHf]/.test(src);
    const longest = moves ? 0 : src.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    const width = Math.min(longest + 1, MAX_TERMINAL_WIDTH);
    src = renderTerminal(src, { width }).screen;
  }

  // 3. Format projection.
  let text: string;
  if (kind === "markdown") text = renderHtml(renderMarkdownHtml(src), { staticDocument: true });
  else if (kind === "html") text = renderHtml(src);
  else if (kind === "svg") text = renderHtml(src, { xml: true, staticDocument: true });
  else text = cutOffscreen(src); // 4. Whitespace padding only hides text where the source is what's shown.

  // 5. Invisible characters.
  text = trimLines(stripHidden(text));
  return { text: text.replace(/^\n+/, ""), kind, removed };
}

/** Trailing whitespace is invisible; so are blank lines at the end. */
function trimLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0\u2000-\u200a\u3000]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

// ─── removed ────────────────────────────────────────────────────────

/** Findings whose content is not in the rendered text. */
function removedOnly(findings: Finding[], kind: DocKind): Finding[] {
  return findings.filter((f) => {
    if (f.type === "encoded") return false; // the blob itself stays visible
    if (f.type === "config_injection") return false; // visible by definition
    if (f.ruleId === "terminal/escape-sequences" || f.ruleId === "document/parse-error") return false;
    if (f.type === "layout" && kind !== "text") return false; // rendered formats collapse whitespace
    return true;
  });
}

// ─── Layout ─────────────────────────────────────────────────────────

/** Drop text pushed off-screen by whitespace padding (same thresholds as the layout scanner). */
function cutOffscreen(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  for (const f of scanLayout(text)) {
    if (!f.line) continue;
    if (f.ruleId === "layout/horizontal-padding" && f.column) {
      lines[f.line - 1] = lines[f.line - 1].slice(0, f.column - 1).replace(/[\s  - 　]+$/, "");
    } else if (f.ruleId === "layout/vertical-padding") {
      end = Math.min(end, f.line - 1);
    }
  }
  return lines.slice(0, end).join("\n");
}

// ─── Invisible characters ───────────────────────────────────────────

const HIDDEN_RUN = new RegExp(`[${CONTROL_CLASS}${INVISIBLE_CLASS}]+`, "gu");
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const RTL =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;
const isVS = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;

/**
 * Remove characters that never render, keeping the few that change how
 * visible text is drawn — the same legitimate uses the Unicode scanner lets
 * through: flag tag sequences, emoji ZWJ sequences, a single presentation
 * selector, ZWJ/ZWNJ in joining scripts. A right-to-left override in
 * left-to-right text is applied (its span reversed) before the controls go.
 */
export function stripHidden(text: string): string {
  if (!/[^\x20-\x7e\t\n]/.test(text)) return text;
  if (text.includes("‮")) text = text.split("\n").map(applyOverride).join("\n");
  return text.replace(HIDDEN_RUN, (run: string, offset: number) => keepLegitimate(run, text, offset));
}

function applyOverride(line: string): string {
  if (!line.includes("\u202e") || RTL.test(line)) return line;
  let out = "";
  let pos = 0;
  for (let i = line.indexOf("\u202e"); i !== -1; i = line.indexOf("\u202e", pos)) {
    const close = line.indexOf("\u202c", i + 1);
    const end = close === -1 ? line.length : close;
    out += line.slice(pos, i + 1) + [...line.slice(i + 1, end)].reverse().join("");
    pos = end;
  }
  return out + line.slice(pos);
}

function keepLegitimate(run: string, text: string, offset: number): string {
  let cps = [...run].map((c) => c.codePointAt(0)!);
  const prev = [...text.slice(Math.max(0, offset - 2), offset)].pop() ?? "";
  const prevCp = prev.codePointAt(0) ?? 0;
  const next = String.fromCodePoint(text.codePointAt(offset + run.length) ?? 0x20);
  let kept = "";

  // Subdivision flags: 🏴 + tag letters + CANCEL TAG
  if (prevCp === 0x1f3f4) {
    const cancel = cps.indexOf(0xe007f);
    if (cancel > 0 && cancel <= 7 && cps.slice(0, cancel).every((cp) => cp >= 0xe0020 && cp <= 0xe007e)) {
      kept = String.fromCodePoint(...cps.slice(0, cancel + 1));
      cps = cps.slice(cancel + 1);
    }
  }
  // Longer runs carry encodings (tags, binary, variation-selector bytes): never legitimate.
  if (!cps.length || cps.length > 2) return kept;

  const vsCount = cps.filter(isVS).length;
  for (const cp of cps) {
    if (isVS(cp)) {
      if (
        vsCount === 1 &&
        (cp >= 0xfe0e ||
          PICTOGRAPHIC.test(prev) ||
          CJK.test(prev) ||
          /[0-9#*]/.test(prev) ||
          !/[A-Za-z]/.test(prev))
      )
        kept += String.fromCodePoint(cp);
    } else if (cp === 0x200d || cp === 0x200c) {
      const emoji =
        cp === 0x200d &&
        (PICTOGRAPHIC.test(prev) || isSkinTone(prevCp) || vsCount > 0) &&
        PICTOGRAPHIC.test(next);
      if (emoji || isJoiningScript(getDominantScript(text, offset))) kept += String.fromCodePoint(cp);
    }
  }
  return kept;
}
