/**
 * Office Open XML (DOCX / PPTX / XLSX) hidden-content scanner.
 *
 * Unzips the package with fflate (XML and .rels parts only, size-capped) and
 * walks each part's DOM (cheerio in XML mode) looking for text a human
 * viewing the document in Office would not see but a text extractor would.
 */

import { load } from "cheerio";
import { unzipSync } from "fflate";
import { classifyIntent } from "../intent.js";
import { concealedFinding } from "../policy.js";
import type { Concealment, Finding } from "../types.js";

type Opts = { instructionFile?: boolean };
type Parts = Map<string, string>;

const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const VIEW_MAX = 200;

// ─── Minimal DOM helpers ────────────────────────────────────────────

interface XNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: XNode[];
  parent?: XNode | null;
  data?: string;
}

function parseXml(xml: string): XNode {
  const $ = load(xml, { xml: true });
  return $.root()[0] as unknown as XNode;
}

const isEl = (n: XNode): boolean => n.type === "tag" || n.type === "script" || n.type === "style";

function kids(el: XNode | undefined, name?: string): XNode[] {
  if (!el?.children) return [];
  return el.children.filter((c) => isEl(c) && (!name || c.name === name));
}

function child(el: XNode | undefined, name: string): XNode | undefined {
  return el?.children?.find((c) => isEl(c) && c.name === name);
}

/** Descendants named `name`, in document order. */
function desc(el: XNode | undefined, name: string | ((n: XNode) => boolean)): XNode[] {
  const out: XNode[] = [];
  const test = typeof name === "string" ? (n: XNode) => n.name === name : name;
  const walk = (n: XNode) => {
    for (const c of n.children ?? []) {
      if (!isEl(c)) continue;
      if (test(c)) out.push(c);
      walk(c);
    }
  };
  if (el) walk(el);
  return out;
}

function first(el: XNode | undefined, name: string): XNode | undefined {
  return desc(el, name)[0];
}

function attr(el: XNode | undefined, name: string): string | undefined {
  return el?.attribs?.[name];
}

function textContent(el: XNode | undefined): string {
  if (!el) return "";
  if (el.type === "text" || el.type === "cdata") return el.data ?? "";
  return (el.children ?? []).map(textContent).join("");
}

function ancestor(el: XNode, name: string): XNode | undefined {
  let p = el.parent ?? undefined;
  while (p) {
    if (p.name === name) return p;
    p = p.parent ?? undefined;
  }
  return undefined;
}

function rootEl(doc: XNode): XNode | undefined {
  return kids(doc)[0];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const trimView = (s: string, max = VIEW_MAX) => {
  const t = norm(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** The end of the visible text, as context leading into hidden content. */
const tailView = (s: string, max = 120) => {
  const t = norm(s);
  return t.length > max ? `…${t.slice(-max)}` : t;
};
const isTrue = (v: string | undefined) => v !== undefined && !/^(0|false|off)$/i.test(v);

// ─── Package handling ───────────────────────────────────────────────

function u8ToString(u8: Uint8Array): string {
  // UTF-16 parts exist but are rare; honour a BOM.
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder("utf-16le").decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder("utf-16be").decode(u8);
  return new TextDecoder("utf-8").decode(u8);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function listNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      names.push(f.name);
      return false;
    },
  });
  return names;
}

/** True for a ZIP package that looks like DOCX, PPTX or XLSX. */
export function isOoxml(bytes: Uint8Array): boolean {
  if (!isZip(bytes)) return false;
  try {
    const names = listNames(bytes);
    const hasCT = names.includes("[Content_Types].xml");
    const main = names.some(
      (n) => n === "word/document.xml" || n === "ppt/presentation.xml" || n === "xl/workbook.xml",
    );
    return hasCT && main;
  } catch {
    return false;
  }
}

function unzipParts(bytes: Uint8Array): Parts {
  let total = 0;
  const raw = unzipSync(bytes, {
    filter: (f) => {
      if (!/\.(xml|rels)$/i.test(f.name)) return false;
      if (f.originalSize > MAX_PART_BYTES) return false;
      total += f.originalSize;
      return total <= MAX_TOTAL_BYTES;
    },
  });
  const parts: Parts = new Map();
  for (const [name, data] of Object.entries(raw)) parts.set(name, u8ToString(data));
  return parts;
}

/** Resolve a relationship target relative to the part that owns the .rels. */
function resolveTarget(ownerPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = ownerPart.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") base.pop();
    else if (seg && seg !== ".") base.push(seg);
  }
  return base.join("/");
}

function relsPath(part: string): string {
  const segs = part.split("/");
  const file = segs.pop()!;
  return [...segs, "_rels", `${file}.rels`].join("/");
}

/** Map of relationship Id -> {target part, type}. */
function readRels(parts: Parts, ownerPart: string): Map<string, { target: string; type: string }> {
  const out = new Map<string, { target: string; type: string }>();
  const xml = parts.get(relsPath(ownerPart));
  if (!xml) return out;
  try {
    for (const r of desc(parseXml(xml), "Relationship")) {
      const id = attr(r, "Id");
      const target = attr(r, "Target");
      if (!id || !target || attr(r, "TargetMode") === "External") continue;
      out.set(id, { target: resolveTarget(ownerPart, target), type: attr(r, "Type") ?? "" });
    }
  } catch {
    /* ignore */
  }
  return out;
}

const numericSuffix = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);

function parseError(err: unknown, location?: string): Finding {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ruleId: "document/parse-error",
    type: "document_hidden",
    severity: "info",
    location,
    message: `Could not fully parse Office document${location ? ` (${location})` : ""}: ${msg}`,
    humanView: "",
    agentView: "",
    detail: msg,
  };
}

/** Channel findings are only worth reporting when the text says something. */
function channelFinding(
  ruleId: string,
  technique: string,
  text: string,
  location: string,
  opts: Opts,
  extra: { humanView?: string; detail?: string } = {},
): Finding | null {
  const t = norm(text);
  if (!t || classifyIntent(t).level === "trivial") return null;
  return concealedFinding({
    ruleId,
    type: "document_hidden",
    concealment: "channel",
    technique,
    hiddenText: t,
    location,
    humanView: extra.humanView ?? "",
    agentView: t,
    detail: extra.detail,
    instructionFile: opts.instructionFile,
  });
}

function hiddenFinding(
  ruleId: string,
  technique: string,
  text: string,
  location: string,
  humanView: string,
  agentView: string,
  opts: Opts,
  detail?: string,
  concealment: Concealment = "hidden",
): Finding | null {
  const t = norm(text);
  if (!t) return null;
  return concealedFinding({
    ruleId,
    type: "document_hidden",
    concealment,
    technique,
    hiddenText: t,
    location,
    humanView: trimView(humanView),
    agentView: trimView(agentView, Math.max(VIEW_MAX, t.length + 120)),
    detail,
    instructionFile: opts.instructionFile,
  });
}

// ─── Public API ─────────────────────────────────────────────────────

export function scanOoxml(bytes: Uint8Array, opts: Opts = {}): Finding[] {
  return analyzeOoxml(bytes, opts).findings;
}

/**
 * Findings plus the text a human sees in Office: DOCX paragraphs in order
 * (with the headers/footers the document references, and footnotes) minus
 * vanished, background-coloured and microscopic runs; PPTX slides in order,
 * skipping hidden slides and hidden, off-slide or microscopic text; XLSX
 * visible sheets, minus hidden rows/columns and cells whose number format
 * hides them. Comments, notes, alt text and properties are not document text.
 */
export function analyzeOoxml(bytes: Uint8Array, opts: Opts = {}): { findings: Finding[]; text: string } {
  let parts: Parts;
  try {
    parts = unzipParts(bytes);
  } catch (err) {
    return { findings: [parseError(err)], text: "" };
  }
  const findings: Finding[] = [];
  const texts: string[] = [];
  const run = (label: string, fn: () => Finding[]) => {
    try {
      findings.push(...fn());
    } catch (err) {
      findings.push(parseError(err, label));
    }
  };

  if (parts.has("word/document.xml")) run("docx", () => scanDocx(parts, opts, texts));
  if (parts.has("ppt/presentation.xml") || [...parts.keys()].some((k) => k.startsWith("ppt/slides/"))) {
    run("pptx", () => scanPptx(parts, opts, texts));
  }
  if (parts.has("xl/workbook.xml")) run("xlsx", () => scanXlsx(parts, opts, texts));
  run("docProps", () => scanDocProps(parts, opts));
  return { findings, text: joinBlocks(texts) };
}

/** Join text blocks with one blank line, trimming trailing spaces and runs of blank lines. */
function joinBlocks(blocks: string[]): string {
  return blocks
    .join("\n\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Colours ────────────────────────────────────────────────────────

type RGB = [number, number, number];

const HIGHLIGHT: Record<string, string> = {
  black: "000000",
  blue: "0000FF",
  cyan: "00FFFF",
  green: "00FF00",
  magenta: "FF00FF",
  red: "FF0000",
  yellow: "FFFF00",
  white: "FFFFFF",
  darkBlue: "000080",
  darkCyan: "008080",
  darkGreen: "008000",
  darkMagenta: "800080",
  darkRed: "800000",
  darkYellow: "808000",
  darkGray: "808080",
  lightGray: "C0C0C0",
};

function rgb(hex: string | undefined): RGB | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function sameColor(a: RGB, b: RGB, tol = 0x12): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

// ─── DOCX ───────────────────────────────────────────────────────────

interface RProps {
  vanish?: boolean;
  color?: string; // hex, undefined = auto
  sz?: number; // half-points
  shd?: string; // hex background
  highlight?: string; // hex background
}

interface StyleDef {
  type: string;
  basedOn?: string;
  rPr: RProps;
  pShd?: string;
}

function readRPr(rPr: XNode | undefined): RProps {
  const out: RProps = {};
  if (!rPr) return out;
  for (const tag of ["w:vanish", "w:specVanish"]) {
    const el = child(rPr, tag);
    if (el) out.vanish = attr(el, "w:val") === undefined || isTrue(attr(el, "w:val"));
  }
  const color = child(rPr, "w:color");
  if (color) {
    const v = attr(color, "w:val");
    out.color = v && v.toLowerCase() !== "auto" ? v : "auto";
  }
  const sz = child(rPr, "w:sz");
  if (sz && attr(sz, "w:val")) {
    const n = Number(attr(sz, "w:val"));
    if (Number.isFinite(n)) out.sz = n;
  }
  const shd = child(rPr, "w:shd");
  const fill = attr(shd, "w:fill");
  if (fill && fill.toLowerCase() !== "auto") out.shd = fill;
  const hl = attr(child(rPr, "w:highlight"), "w:val");
  if (hl && hl !== "none") out.highlight = HIGHLIGHT[hl] ?? undefined;
  return out;
}

function merge(...layers: RProps[]): RProps {
  const out: RProps = {};
  for (const l of layers) {
    for (const [k, v] of Object.entries(l)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

class DocxStyles {
  private styles = new Map<string, StyleDef>();
  defaults: RProps = {};
  defaultPara?: string;
  defaultChar?: string;

  constructor(xml: string | undefined) {
    if (!xml) return;
    const doc = parseXml(xml);
    this.defaults = readRPr(first(first(doc, "w:rPrDefault"), "w:rPr"));
    for (const s of desc(doc, "w:style")) {
      const id = attr(s, "w:styleId");
      if (!id) continue;
      const type = attr(s, "w:type") ?? "paragraph";
      this.styles.set(id, {
        type,
        basedOn: attr(child(s, "w:basedOn"), "w:val"),
        rPr: readRPr(child(s, "w:rPr")),
        pShd: attr(child(child(s, "w:pPr"), "w:shd"), "w:fill"),
      });
      if (isTrue(attr(s, "w:default"))) {
        if (type === "paragraph") this.defaultPara = id;
        if (type === "character") this.defaultChar = id;
      }
    }
  }

  /** Run properties of a style, following basedOn (base first). */
  chain(id: string | undefined): { rPr: RProps; pShd?: string; names: string[] } {
    const layers: StyleDef[] = [];
    const names: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur) && this.styles.has(cur)) {
      seen.add(cur);
      const def = this.styles.get(cur)!;
      layers.unshift(def);
      names.push(cur);
      cur = def.basedOn;
    }
    let pShd: string | undefined;
    for (const l of layers) if (l.pShd && l.pShd.toLowerCase() !== "auto") pShd = l.pShd;
    return { rPr: merge(...layers.map((l) => l.rPr)), pShd, names };
  }
}

type DocxTech = "vanish" | "color" | "tiny";

const DOCX_TECH: Record<DocxTech, { ruleId: string; label: string }> = {
  vanish: { ruleId: "docx/vanish", label: "DOCX hidden text (w:vanish)" },
  color: { ruleId: "docx/white-text", label: "DOCX text coloured like its background" },
  tiny: { ruleId: "docx/tiny-text", label: "DOCX microscopic text" },
};

interface DocxPara {
  index: number;
  visible: string;
  full: string;
  hidden: Partial<Record<DocxTech, { text: string; details: Set<string> }>>;
}

function runText(r: XNode): string {
  let s = "";
  for (const c of kids(r)) {
    if (c.name === "w:t") s += textContent(c);
    else if (c.name === "w:tab" || c.name === "w:ptab") s += "\t";
    else if (c.name === "w:br" || c.name === "w:cr") s += "\n";
    else if (c.name === "w:noBreakHyphen") s += "-";
  }
  return s;
}

function scanDocx(parts: Parts, opts: Opts, texts: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const styles = new DocxStyles(parts.get("word/styles.xml"));
  const visible = new Map<string, string>();

  const bodyParts = [...parts.keys()]
    .filter((k) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(k))
    .sort((a, b) => (a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)));

  for (const part of bodyParts) {
    try {
      const r = scanDocxPart(part, parseXml(parts.get(part)!), styles, opts);
      findings.push(...r.findings);
      visible.set(part, r.paras.map((p) => p.visible).join("\n"));
    } catch (err) {
      findings.push(parseError(err, part));
    }
  }

  // Visible text in page order: headers, body, footnotes/endnotes, footers. Only header and
  // footer parts the document links to are shown on a page.
  const linked = [...readRels(parts, "word/document.xml").values()];
  const ofType = (type: string) =>
    linked
      .filter((r) => new RegExp(`/${type}$`).test(r.type))
      .map((r) => r.target)
      .filter((t, i, a) => a.indexOf(t) === i)
      .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  for (const part of [
    ...ofType("header"),
    "word/document.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
    ...ofType("footer"),
  ]) {
    const t = visible.get(part);
    if (t?.trim()) texts.push(t);
  }

  // Comments
  const comments = parts.get("word/comments.xml");
  if (comments) {
    for (const c of desc(parseXml(comments), "w:comment")) {
      const text = desc(c, "w:p")
        .map((p) => desc(p, "w:t").map(textContent).join(""))
        .join(" ");
      const author = attr(c, "w:author");
      const f = channelFinding(
        "docx/comment",
        "DOCX comment",
        text,
        `word/comments.xml comment${author ? ` by ${author}` : ""}`,
        opts,
      );
      if (f) findings.push(f);
    }
  }
  return findings;
}

function scanDocxPart(
  part: string,
  doc: XNode,
  styles: DocxStyles,
  opts: Opts,
): { findings: Finding[]; paras: DocxPara[] } {
  const findings: Finding[] = [];
  const root = rootEl(doc);
  const docBg = rgb(attr(child(root, "w:background"), "w:color"));

  const paras: DocxPara[] = [];
  // Word writes each text box twice (DrawingML in mc:Choice, VML in mc:Fallback); read it once.
  const bodyParas = desc(doc, "w:p").filter((p) => !ancestor(p, "mc:Fallback"));
  bodyParas.forEach((p, idx) => {
    const pPr = child(p, "w:pPr");
    const pStyleId = attr(child(pPr, "w:pStyle"), "w:val") ?? styles.defaultPara;
    const pStyle = styles.chain(pStyleId);
    const pShdRaw = attr(child(pPr, "w:shd"), "w:fill");
    const pShd = pShdRaw && pShdRaw.toLowerCase() !== "auto" ? pShdRaw : pStyle.pShd;
    const tc = ancestor(p, "w:tc");
    const cellShdRaw = attr(child(child(tc, "w:tcPr"), "w:shd"), "w:fill");
    const cellShd = cellShdRaw && cellShdRaw.toLowerCase() !== "auto" ? cellShdRaw : undefined;
    // Text boxes: the shape's own fill is the background. If it isn't a plain
    // sRGB fill (theme colour, gradient, picture, VML) the colour is unknown.
    let boxFill: string | undefined;
    let boxUnknown = false;
    if (ancestor(p, "w:txbxContent")) {
      const wsp = ancestor(p, "wps:wsp");
      const spPr = child(wsp, "wps:spPr");
      const solid = child(spPr, "a:solidFill");
      const srgb = attr(child(solid, "a:srgbClr"), "val");
      if (srgb) boxFill = srgb;
      else if (!child(spPr, "a:noFill")) boxUnknown = true; // explicit noFill shows the page behind
    }

    const para: DocxPara = { index: idx + 1, visible: "", full: "", hidden: {} };
    for (const r of desc(p, "w:r")) {
      if (ancestor(r, "w:p") !== p) continue; // nested text box paragraphs are handled on their own
      if (ancestor(r, "w:del") || ancestor(r, "w:moveFrom")) continue;
      const text = runText(r);
      if (!text) continue;
      const rPr = child(r, "w:rPr");
      const rStyleId = attr(child(rPr, "w:rStyle"), "w:val") ?? styles.defaultChar;
      const rStyle = styles.chain(rStyleId);
      const direct = readRPr(rPr);
      const eff = merge(styles.defaults, pStyle.rPr, rStyle.rPr, direct);
      const via = (key: keyof RProps) =>
        direct[key] !== undefined
          ? "direct formatting"
          : rStyle.rPr[key] !== undefined
            ? `character style "${rStyle.names[0]}"`
            : pStyle.rPr[key] !== undefined
              ? `paragraph style "${pStyle.names[0]}"`
              : "document defaults";

      let tech: DocxTech | null = null;
      let detail = "";
      if (eff.vanish) {
        tech = "vanish";
        detail = `w:vanish via ${via("vanish")}`;
      } else {
        const fg = eff.color && eff.color !== "auto" ? rgb(eff.color) : null;
        const bgHex = eff.shd ?? eff.highlight ?? pShd ?? cellShd ?? boxFill;
        const bg = rgb(bgHex) ?? docBg ?? [255, 255, 255];
        const bgKnown = Boolean(eff.shd ?? eff.highlight ?? pShd ?? cellShd ?? boxFill) || !boxUnknown;
        if (fg && bgKnown && sameColor(fg, bg)) {
          tech = "color";
          detail = `w:color ${eff.color} via ${via("color")} on ${bgHex ? `shading ${bgHex}` : docBg ? "page background" : "white page"}`;
        } else if (eff.sz !== undefined && eff.sz <= 4) {
          tech = "tiny";
          detail = `w:sz ${eff.sz} (${eff.sz / 2}pt) via ${via("sz")}`;
        }
      }
      para.full += text;
      if (tech) {
        let h = para.hidden[tech];
        if (!h) {
          h = { text: "", details: new Set() };
          para.hidden[tech] = h;
        }
        h.text += text;
        h.details.add(detail);
      } else {
        para.visible += text;
      }
    }
    paras.push(para);
  });

  // Group consecutive paragraphs carrying hidden text of the same technique.
  for (const tech of Object.keys(DOCX_TECH) as DocxTech[]) {
    let group: DocxPara[] = [];
    const flush = () => {
      if (group.length === 0) return;
      const hiddenText = group.map((p) => p.hidden[tech]!.text).join(" ");
      let humanView = group.map((p) => p.visible).join(" ");
      let context = "";
      if (!norm(humanView)) {
        const prev = [...paras.slice(0, group[0].index - 1)].reverse().find((p) => norm(p.visible));
        humanView = prev?.visible ?? "";
        context = humanView;
      }
      const agentView = [context, ...group.map((p) => p.full)].filter((s) => norm(s)).join(" ");
      const details = [...new Set(group.flatMap((p) => [...p.hidden[tech]!.details]))].slice(0, 3).join("; ");
      const where =
        group.length > 1
          ? `${part} paragraphs ${group[0].index}-${group[group.length - 1].index}`
          : `${part} paragraph ${group[0].index}`;
      const f = hiddenFinding(
        DOCX_TECH[tech].ruleId,
        DOCX_TECH[tech].label,
        hiddenText,
        where,
        humanView,
        agentView,
        opts,
        details,
      );
      if (f) findings.push(f);
      group = [];
    };
    for (const p of paras) {
      if (p.hidden[tech] && norm(p.hidden[tech]!.text)) group.push(p);
      else if (norm(p.full)) flush(); // empty paragraphs don't break a group
    }
    flush();
  }

  // Image / drawing alt text
  for (const el of desc(doc, (n) => n.name === "wp:docPr" || n.name === "pic:cNvPr")) {
    const text = [attr(el, "title"), attr(el, "descr")].filter(Boolean).join(" — ");
    const f = channelFinding(
      "docx/alt-text",
      "DOCX image alt text",
      text,
      `${part} image "${attr(el, "name") ?? attr(el, "id") ?? ""}"`,
      opts,
    );
    if (f && !findings.some((x) => x.ruleId === f.ruleId && x.hiddenText === f.hiddenText)) findings.push(f);
  }
  return { findings, paras };
}

// ─── PPTX ───────────────────────────────────────────────────────────

const EMU_PER_PT = 12700;

interface Xform {
  // child coords -> slide coords: x' = ax * x + bx
  ax: number;
  bx: number;
  ay: number;
  by: number;
}

const ID_XFORM: Xform = { ax: 1, bx: 0, ay: 1, by: 0 };

type PptxTech = "hidden-shape" | "off-slide" | "tiny";

const PPTX_TECH: Record<PptxTech, { ruleId: string; label: string }> = {
  "hidden-shape": { ruleId: "pptx/hidden-shape", label: "PPTX hidden shape" },
  "off-slide": { ruleId: "pptx/off-slide", label: "PPTX shape positioned outside the slide" },
  tiny: { ruleId: "pptx/tiny-text", label: "PPTX microscopic text" },
};

function slideOrder(parts: Parts): string[] {
  const pres = parts.get("ppt/presentation.xml");
  const ordered: string[] = [];
  if (pres) {
    const rels = readRels(parts, "ppt/presentation.xml");
    for (const s of desc(parseXml(pres), "p:sldId")) {
      const target = rels.get(attr(s, "r:id") ?? "")?.target;
      if (target && parts.has(target)) ordered.push(target);
    }
  }
  const all = [...parts.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  for (const s of all) if (!ordered.includes(s)) ordered.push(s);
  return ordered;
}

function paragraphsText(el: XNode | undefined): string {
  return desc(el, "a:p")
    .map((p) => desc(p, "a:t").map(textContent).join(""))
    .filter((s) => s.trim())
    .join("\n");
}

function scanPptx(parts: Parts, opts: Opts, texts: string[] = []): Finding[] {
  const findings: Finding[] = [];
  let cx = 9144000;
  let cy = 6858000;
  const pres = parts.get("ppt/presentation.xml");
  if (pres) {
    const sz = first(parseXml(pres), "p:sldSz");
    cx = Number(attr(sz, "cx") ?? cx) || cx;
    cy = Number(attr(sz, "cy") ?? cy) || cy;
  }

  const slides = slideOrder(parts);
  const slideNumber = new Map(slides.map((s, i) => [s, i + 1]));

  slides.forEach((part, i) => {
    const n = i + 1;
    try {
      const doc = parseXml(parts.get(part)!);
      const sld = rootEl(doc);
      const spTree = first(sld, "p:spTree");
      const allText = paragraphsText(spTree);

      if (sld && /^(0|false)$/i.test(attr(sld, "show") ?? "")) {
        const f = hiddenFinding(
          "pptx/hidden-slide",
          "PPTX hidden slide (skipped in the slideshow)",
          allText,
          `slide ${n}`,
          "",
          allText,
          opts,
          `<p:sld show="0"> in ${part}`,
        );
        if (f) findings.push(f);
        return;
      }

      const hidden: Partial<Record<PptxTech, { texts: string[]; details: string[] }>> = {};
      const visibleTexts: string[] = [];
      const altTexts: string[] = [];
      const add = (tech: PptxTech, text: string, detail: string) => {
        let h = hidden[tech];
        if (!h) {
          h = { texts: [], details: [] };
          hidden[tech] = h;
        }
        h.texts.push(text);
        h.details.push(detail);
      };

      const walk = (container: XNode, xf: Xform, parentHidden: boolean) => {
        for (const el of kids(container)) {
          if (el.name === "mc:AlternateContent") {
            const branch = child(el, "mc:Choice") ?? child(el, "mc:Fallback");
            if (branch) walk(branch, xf, parentHidden);
            continue;
          }
          if (!["p:sp", "p:grpSp", "p:pic", "p:graphicFrame", "p:cxnSp"].includes(el.name ?? "")) continue;
          const nv = kids(el).find((k) => /^p:nv/.test(k.name ?? ""));
          const cNvPr = child(nv, "p:cNvPr");
          const name = attr(cNvPr, "name") ?? attr(cNvPr, "id") ?? "shape";
          const isHidden = parentHidden || isTrue(attr(cNvPr, "hidden"));
          const descr = [attr(cNvPr, "title"), attr(cNvPr, "descr")].filter(Boolean).join(" — ");
          if (descr) altTexts.push(descr);

          const spPr = kids(el).find((k) => k.name === "p:spPr" || k.name === "p:grpSpPr");
          const xfrm = el.name === "p:graphicFrame" ? child(el, "p:xfrm") : child(spPr, "a:xfrm");
          const off = child(xfrm, "a:off");
          const ext = child(xfrm, "a:ext");
          let box: [number, number, number, number] | null = null;
          if (off && ext) {
            const x = Number(attr(off, "x") ?? 0);
            const y = Number(attr(off, "y") ?? 0);
            const w = Number(attr(ext, "cx") ?? 0);
            const h = Number(attr(ext, "cy") ?? 0);
            const x1 = xf.ax * x + xf.bx;
            const y1 = xf.ay * y + xf.by;
            const x2 = xf.ax * (x + w) + xf.bx;
            const y2 = xf.ay * (y + h) + xf.by;
            box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
          }
          const offSlide = box !== null && (box[2] <= 0 || box[0] >= cx || box[3] <= 0 || box[1] >= cy);

          if (el.name === "p:grpSp") {
            let childXf = xf;
            const chOff = child(xfrm, "a:chOff");
            const chExt = child(xfrm, "a:chExt");
            if (off && ext && chOff && chExt) {
              const sx = Number(attr(chExt, "cx")) ? Number(attr(ext, "cx")) / Number(attr(chExt, "cx")) : 1;
              const sy = Number(attr(chExt, "cy")) ? Number(attr(ext, "cy")) / Number(attr(chExt, "cy")) : 1;
              const gx = Number(attr(off, "x")) - sx * Number(attr(chOff, "x"));
              const gy = Number(attr(off, "y")) - sy * Number(attr(chOff, "y"));
              childXf = { ax: xf.ax * sx, bx: xf.ax * gx + xf.bx, ay: xf.ay * sy, by: xf.ay * gy + xf.by };
            }
            walk(el, childXf, isHidden);
            continue;
          }

          const body =
            el.name === "p:sp" ? child(el, "p:txBody") : el.name === "p:graphicFrame" ? el : undefined;
          if (!body) continue;
          const text = paragraphsText(body);
          if (!text.trim()) continue;

          if (isHidden) {
            add("hidden-shape", text, `<p:cNvPr hidden="1"> on "${name}"`);
            continue;
          }
          if (offSlide) {
            const pt = (v: number) => (v / EMU_PER_PT).toFixed(0);
            add(
              "off-slide",
              text,
              `"${name}" at (${pt(box![0])}, ${pt(box![1])})pt, slide is ${pt(cx)}×${pt(cy)}pt`,
            );
            continue;
          }
          // Per-run tiny text
          const scaleAttr = attr(first(child(body, "a:bodyPr"), "a:normAutofit"), "fontScale");
          const fontScale = scaleAttr ? Number(scaleAttr) / 100000 : 1;
          const lstStyle = child(body, "a:lstStyle");
          const shown: string[] = [];
          const tiny: string[] = [];
          let tinyDetail = "";
          for (const p of desc(body, "a:p")) {
            const lvl = Number(attr(child(p, "a:pPr"), "lvl") ?? 0);
            const defSz = attr(child(child(lstStyle, `a:lvl${lvl + 1}pPr`), "a:defRPr"), "sz");
            for (const r of kids(p).filter(
              (k) => k.name === "a:r" || k.name === "a:fld" || k.name === "a:br",
            )) {
              if (r.name === "a:br") {
                shown.push("\n");
                continue;
              }
              const t = desc(r, "a:t").map(textContent).join("");
              if (!t) continue;
              const szAttr = attr(child(r, "a:rPr"), "sz") ?? defSz;
              const sz = szAttr ? Number(szAttr) * fontScale : NaN;
              if (Number.isFinite(sz) && sz < 200) {
                tiny.push(t);
                tinyDetail ||= `"${name}" font size ${(sz / 100).toFixed(2)}pt`;
              } else {
                shown.push(t);
              }
            }
            shown.push("\n");
          }
          if (norm(tiny.join(" "))) add("tiny", tiny.join(" "), tinyDetail);
          if (norm(shown.join(""))) visibleTexts.push(shown.join(""));
        }
      };
      if (spTree) walk(spTree, ID_XFORM, false);

      const humanView = visibleTexts.join(" ");
      texts.push(visibleTexts.map((t) => t.replace(/\n+$/, "")).join("\n"));
      for (const tech of Object.keys(PPTX_TECH) as PptxTech[]) {
        const h = hidden[tech];
        if (!h) continue;
        const hiddenText = h.texts.join(" ");
        const f = hiddenFinding(
          PPTX_TECH[tech].ruleId,
          PPTX_TECH[tech].label,
          hiddenText,
          `slide ${n}`,
          humanView,
          `${humanView} ${hiddenText}`,
          opts,
          [...new Set(h.details)].slice(0, 3).join("; "),
        );
        if (f) findings.push(f);
      }
      for (const alt of [...new Set(altTexts)]) {
        const f = channelFinding("pptx/alt-text", "PPTX shape alt text", alt, `slide ${n}`, opts, {
          humanView: trimView(humanView),
        });
        if (f) findings.push(f);
      }
    } catch (err) {
      findings.push(parseError(err, `slide ${n}`));
    }
  });

  // Speaker notes
  const notes = [...parts.keys()]
    .filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k))
    .sort((a, b) => numericSuffix(a) - numericSuffix(b));
  for (const part of notes) {
    try {
      const rels = readRels(parts, part);
      const slidePart = [...rels.values()].find(
        (r) => /\/slide$/.test(r.type) || /slides\/slide\d+\.xml$/.test(r.target),
      )?.target;
      const n = slidePart ? slideNumber.get(slidePart) : undefined;
      const doc = parseXml(parts.get(part)!);
      const texts: string[] = [];
      for (const sp of desc(doc, "p:sp")) {
        const ph = first(sp, "p:ph");
        const type = attr(ph, "type");
        if (type && type !== "body") continue; // skip slide image, number, header/footer placeholders
        texts.push(paragraphsText(child(sp, "p:txBody")));
      }
      const f = channelFinding(
        "pptx/notes",
        "PPTX speaker notes",
        texts.join(" "),
        n ? `slide ${n} notes` : part,
        opts,
      );
      if (f) findings.push(f);
    } catch (err) {
      findings.push(parseError(err, part));
    }
  }

  // Comments (legacy and modern)
  for (const part of [...parts.keys()].filter((k) => /^ppt\/comments\/.*\.xml$/.test(k))) {
    try {
      const doc = parseXml(parts.get(part)!);
      const items = desc(doc, (x) => x.name === "p:cm" || /:cm$/.test(x.name ?? ""));
      for (const cm of items) {
        const text = first(cm, "p:text")
          ? textContent(first(cm, "p:text"))
          : desc(cm, "a:t").map(textContent).join(" ");
        const f = channelFinding("pptx/comment", "PPTX comment", text, part, opts);
        if (f) findings.push(f);
      }
    } catch (err) {
      findings.push(parseError(err, part));
    }
  }
  return findings;
}

// ─── XLSX ───────────────────────────────────────────────────────────

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase() ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Text of a <si> / <is> rich string, excluding phonetic runs. */
function richText(el: XNode | undefined): string {
  return desc(el, "t")
    .filter((t) => !ancestor(t, "rPh"))
    .map(textContent)
    .join("");
}

/** True when a number format hides text values (4th section present and empty, e.g. ";;;"). */
function formatHidesText(code: string): boolean {
  const sections: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') quoted = !quoted;
    if (ch === "\\" && i + 1 < code.length) {
      cur += ch + code[++i];
      continue;
    }
    if (ch === ";" && !quoted) {
      sections.push(cur);
      cur = "";
    } else cur += ch;
  }
  sections.push(cur);
  return sections.length >= 4 && sections[3].trim() === "";
}

/** True when the number format section that applies to `n` is empty (e.g. ";;;"). */
function formatHidesNumber(code: string, n: number): boolean {
  if (!code.includes(";") || !Number.isFinite(n)) return false;
  const sections = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const section = n > 0 ? sections[0] : n < 0 ? (sections[1] ?? sections[0]) : (sections[2] ?? sections[0]);
  return section.trim() === "";
}

function scanXlsx(parts: Parts, opts: Opts, texts: string[] = []): Finding[] {
  const findings: Finding[] = [];
  const wb = parseXml(parts.get("xl/workbook.xml")!);
  const wbRels = readRels(parts, "xl/workbook.xml");

  const sst: string[] = [];
  const sstXml = parts.get("xl/sharedStrings.xml");
  if (sstXml) for (const si of desc(parseXml(sstXml), "si")) sst.push(richText(si));

  // Styles whose number format hides text (and the format code of each style, for numbers).
  const hidingXf = new Set<number>();
  const xfFormat: string[] = [];
  const stylesXml = parts.get("xl/styles.xml");
  if (stylesXml) {
    const st = parseXml(stylesXml);
    const hidingFmt = new Set<string>();
    const codes = new Map<string, string>();
    for (const nf of desc(st, "numFmt")) {
      codes.set(attr(nf, "numFmtId") ?? "", attr(nf, "formatCode") ?? "");
      if (formatHidesText(attr(nf, "formatCode") ?? "")) hidingFmt.add(attr(nf, "numFmtId") ?? "");
    }
    kids(first(st, "cellXfs"), "xf").forEach((xf, i) => {
      if (hidingFmt.has(attr(xf, "numFmtId") ?? "")) hidingXf.add(i);
      xfFormat[i] = codes.get(attr(xf, "numFmtId") ?? "") ?? "";
    });
  }
  /** Displayed value of a non-string cell (raw: number formats other than hiding ones are not applied). */
  const valueText = (c: XNode): string => {
    const t = attr(c, "t");
    const v = textContent(child(c, "v")).trim();
    if (!v || t === "s" || t === "inlineStr" || t === "str") return "";
    if (t === "b") return v === "1" ? "TRUE" : "FALSE";
    if (t === "e") return v;
    const n = Number(v);
    return formatHidesNumber(xfFormat[Number(attr(c, "s") ?? 0)] ?? "", n) ? "" : v;
  };

  const sheets = desc(wb, "sheet").map((s, i) => {
    const rid = attr(s, "r:id") ?? "";
    const target = wbRels.get(rid)?.target ?? `xl/worksheets/sheet${i + 1}.xml`;
    return { name: attr(s, "name") ?? `Sheet${i + 1}`, state: attr(s, "state") ?? "visible", part: target };
  });
  const visibleNames = sheets.filter((s) => s.state === "visible").map((s) => s.name);

  const cellText = (c: XNode): string => {
    const t = attr(c, "t");
    if (t === "s") return sst[Number(textContent(child(c, "v")))] ?? "";
    if (t === "inlineStr") return richText(child(c, "is"));
    if (t === "str") return textContent(child(c, "v"));
    return "";
  };

  for (const sheet of sheets) {
    const xml = parts.get(sheet.part);
    if (!xml) continue;
    const loc = `sheet "${sheet.name}"`;
    try {
      const doc = parseXml(xml);
      const cells = desc(doc, "c");

      if (sheet.state === "hidden" || sheet.state === "veryHidden") {
        const text = cells
          .map(cellText)
          .filter((s) => s.trim())
          .join(" ");
        const f = hiddenFinding(
          "xlsx/hidden-sheet",
          `XLSX ${sheet.state === "veryHidden" ? "very hidden" : "hidden"} sheet "${sheet.name}"`,
          text,
          loc,
          `Workbook shows sheets: ${visibleNames.join(", ")}`,
          text,
          opts,
          `state="${sheet.state}" in xl/workbook.xml`,
          // A hidden sheet is one right-click away (Unhide); veryHidden needs the VBA editor.
          sheet.state === "veryHidden" ? "hidden" : "channel",
        );
        if (f) findings.push(f);
      } else {
        // Rows/columns hidden by an AutoFilter or a collapsed outline group are
        // everyday spreadsheet use: report them as a channel, not as concealment.
        const hasFilter = desc(doc, "autoFilter").length > 0;
        const hiddenCols: Array<{ min: number; max: number; soft: boolean }> = [];
        for (const col of desc(doc, "col")) {
          const width = attr(col, "width");
          if (isTrue(attr(col, "hidden")) || (width !== undefined && Number(width) < 0.1)) {
            hiddenCols.push({
              min: Number(attr(col, "min") ?? 0),
              max: Number(attr(col, "max") ?? 0),
              soft: Number(attr(col, "outlineLevel") ?? 0) > 0,
            });
          }
        }
        type Bucket = { texts: string[]; refs: string[]; reasons: Set<string> };
        const strong: Bucket = { texts: [], refs: [], reasons: new Set() };
        const soft: Bucket = { texts: [], refs: [], reasons: new Set() };
        const visibleTexts: string[] = [];
        const visibleRows: string[] = [];
        for (const row of desc(doc, "row")) {
          const ht = attr(row, "ht");
          const rowHidden = isTrue(attr(row, "hidden")) || (ht !== undefined && Number(ht) < 0.5);
          const rowSoft = rowHidden && (hasFilter || Number(attr(row, "outlineLevel") ?? 0) > 0);
          const rowCells: string[] = [];
          for (const c of kids(row, "c")) {
            const text = cellText(c);
            const ref = attr(c, "r") ?? "";
            const ci = colIndex(ref);
            const col = hiddenCols.find((h) => ci >= h.min && ci <= h.max);
            if (!text.trim()) {
              const value = rowHidden || col ? "" : valueText(c);
              if (value) rowCells.push(value);
              continue;
            }
            const fmtHidden = hidingXf.has(Number(attr(c, "s") ?? -1));
            if (!rowHidden && !col && !fmtHidden) {
              visibleTexts.push(text);
              rowCells.push(text.replace(/\s*\n\s*/g, " "));
              continue;
            }
            // Hidden rows/columns are everyday Excel and one click to unhide (a channel); a ";;;"
            // number format makes a cell look empty with no UI cue at all (concealment).
            const isStrong = fmtHidden;
            const b = isStrong ? strong : soft;
            b.texts.push(text);
            b.refs.push(ref);
            if (fmtHidden) b.reasons.add('number format ";;;"');
            if (rowHidden)
              b.reasons.add(
                rowSoft ? (hasFilter ? "row hidden by filter" : "collapsed outline row") : "hidden row",
              );
            if (col) b.reasons.add(col.soft ? "collapsed outline column" : "hidden column");
          }
          if (rowCells.length) visibleRows.push(rowCells.join("\t"));
        }
        texts.push(visibleRows.join("\n"));
        for (const [b, concealment] of [
          [strong, "hidden"],
          [soft, "channel"],
        ] as const) {
          if (!b.texts.length) continue;
          const hiddenText = norm(b.texts.join(" "));
          if (concealment === "channel" && classifyIntent(hiddenText).level === "trivial") continue;
          findings.push(
            concealedFinding({
              ruleId: "xlsx/hidden-cells",
              type: "document_hidden",
              concealment,
              technique: `XLSX text in ${[...b.reasons].join(" / ")}`,
              hiddenText,
              location: loc,
              humanView: tailView(visibleTexts.join(" ")),
              agentView: trimView(
                `${tailView(visibleTexts.join(" "))} ${b.texts.join(" ")}`,
                Math.max(VIEW_MAX, hiddenText.length + 130),
              ),
              detail: `cells ${b.refs.slice(0, 8).join(", ")}${b.refs.length > 8 ? ", …" : ""}`,
              instructionFile: opts.instructionFile,
            }),
          );
        }
      }

      // Cell comments for this sheet
      for (const rel of readRels(parts, sheet.part).values()) {
        if (!/comments\d*\.xml$|threadedComment/i.test(rel.target)) continue;
        const cx = parts.get(rel.target);
        if (!cx) continue;
        for (const cm of desc(parseXml(cx), (x) => x.name === "comment" || x.name === "threadedComment")) {
          const text = cm.name === "comment" ? richText(child(cm, "text")) : textContent(child(cm, "text"));
          const f = channelFinding(
            "xlsx/comment",
            "XLSX cell comment",
            text,
            `${loc} ${attr(cm, "ref") ?? ""}`.trim(),
            opts,
          );
          if (f) findings.push(f);
        }
      }
    } catch (err) {
      findings.push(parseError(err, loc));
    }
  }

  // Comment parts not linked from any sheet (e.g. hand-built packages)
  const linked = new Set(sheets.flatMap((s) => [...readRels(parts, s.part).values()].map((r) => r.target)));
  for (const part of [...parts.keys()].filter((k) => /^xl\/comments\d*\.xml$/.test(k) && !linked.has(k))) {
    for (const cm of desc(parseXml(parts.get(part)!), "comment")) {
      const f = channelFinding(
        "xlsx/comment",
        "XLSX cell comment",
        richText(child(cm, "text")),
        `${part} ${attr(cm, "ref") ?? ""}`.trim(),
        opts,
      );
      if (f) findings.push(f);
    }
  }
  return findings;
}

// ─── docProps ───────────────────────────────────────────────────────

function scanDocProps(parts: Parts, opts: Opts): Finding[] {
  const findings: Finding[] = [];
  const core = parts.get("docProps/core.xml");
  if (core) {
    const doc = parseXml(core);
    for (const tag of ["dc:description", "cp:keywords", "dc:subject"]) {
      for (const el of desc(doc, tag)) {
        const f = channelFinding(
          "ooxml/metadata",
          `Document properties (${tag})`,
          textContent(el),
          "docProps/core.xml",
          opts,
          { detail: tag },
        );
        if (f) findings.push(f);
      }
    }
  }
  const custom = parts.get("docProps/custom.xml");
  if (custom) {
    for (const prop of desc(parseXml(custom), "property")) {
      const name = attr(prop, "name") ?? "property";
      const f = channelFinding(
        "ooxml/metadata",
        `Custom document property "${name}"`,
        textContent(prop),
        "docProps/custom.xml",
        opts,
        { detail: name },
      );
      if (f) findings.push(f);
    }
  }
  return findings;
}
