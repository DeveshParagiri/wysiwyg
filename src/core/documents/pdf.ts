/**
 * PDF hidden-content scanner.
 *
 * Walks each page's operator list (pdfjs-dist legacy build, run on the main
 * thread so it works under Bun/Node with no browser globals) and tracks the
 * graphics state itself: CTM, text matrices, font size, render mode, fill and
 * stroke colour, alpha, clip box, optional-content visibility and the regions
 * painted so far. Every glyph run is then classified as visible or hidden by
 * one technique, and hidden runs are reported once per technique per page.
 *
 * getTextContent() is not used for detection: it drops render-mode-3 text and
 * exposes neither colour nor render mode.
 */

import { classifyIntent } from "../intent.js";
import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { installDomPolyfills } from "./dom-polyfill.js";

type Matrix = [number, number, number, number, number, number];
type Box = [number, number, number, number]; // x1, y1, x2, y2 (normalized)

type Technique =
  | "render-mode"
  | "hidden-layer"
  | "transparent"
  | "off-page"
  | "clipped"
  | "covered"
  | "background-match"
  | "tiny"
  | "ocr-layer";

interface TechInfo {
  ruleId: string;
  label: string;
  concealment: "hidden" | "channel";
}

const TECH: Record<Technique, TechInfo> = {
  "render-mode": {
    ruleId: "pdf/invisible-render-mode",
    label: "PDF invisible text (render mode 3/7)",
    concealment: "hidden",
  },
  "hidden-layer": {
    ruleId: "pdf/hidden-layer",
    label: "PDF text in a hidden optional-content layer",
    concealment: "hidden",
  },
  transparent: {
    ruleId: "pdf/transparent-text",
    label: "PDF fully transparent text (alpha 0)",
    concealment: "hidden",
  },
  "off-page": {
    ruleId: "pdf/off-page",
    label: "PDF text positioned outside the visible page box",
    concealment: "hidden",
  },
  clipped: { ruleId: "pdf/off-page", label: "PDF text outside its clipping path", concealment: "hidden" },
  covered: {
    ruleId: "pdf/covered-text",
    label: "PDF text covered by an opaque shape drawn on top",
    concealment: "hidden",
  },
  "background-match": {
    ruleId: "pdf/white-text",
    label: "PDF text coloured like its background",
    concealment: "hidden",
  },
  tiny: { ruleId: "pdf/tiny-text", label: "PDF microscopic text", concealment: "hidden" },
  "ocr-layer": {
    ruleId: "pdf/invisible-render-mode",
    label: "PDF invisible text over a page image (likely OCR layer)",
    concealment: "channel",
  },
};

/** Effective glyph size (pt) below which text is unreadable. */
const TINY_PT = 1.5;
/** Max per-channel difference for "same colour as background". */
const COLOR_TOLERANCE = 0x12;
/** An image covering this share of the page is treated as a scanned page. */
const PAGE_IMAGE_SHARE = 0.5;
const HUMAN_VIEW_MAX = 200;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(a: Matrix | ArrayLike<number>, b: Matrix | ArrayLike<number>): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function boxOf(m: Matrix, x1: number, y1: number, x2: number, y2: number): Box {
  const pts = [apply(m, x1, y1), apply(m, x2, y1), apply(m, x1, y2), apply(m, x2, y2)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function intersect(a: Box, b: Box): Box {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function disjoint(a: Box, b: Box, tol = 0.5): boolean {
  return a[2] < b[0] - tol || a[0] > b[2] + tol || a[3] < b[1] - tol || a[1] > b[3] + tol;
}

function contains(outer: Box, inner: Box, tol = 0.5): boolean {
  return (
    inner[0] >= outer[0] - tol &&
    inner[1] >= outer[1] - tol &&
    inner[2] <= outer[2] + tol &&
    inner[3] <= outer[3] + tol
  );
}

function containsPoint(b: Box, x: number, y: number): boolean {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

function area(b: Box): number {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

type RGB = [number, number, number];

function parseColor(v: unknown): RGB | null {
  if (typeof v === "string") {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
    if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }
  return null;
}

const WHITE: RGB = [255, 255, 255];

function sameColor(a: RGB, b: RGB): boolean {
  return (
    Math.abs(a[0] - b[0]) <= COLOR_TOLERANCE &&
    Math.abs(a[1] - b[1]) <= COLOR_TOLERANCE &&
    Math.abs(a[2] - b[2]) <= COLOR_TOLERANCE
  );
}

function hex(c: RGB | null): string {
  return c ? `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}` : "unknown";
}

interface GState {
  ctm: Matrix;
  clip: Box | null;
  fill: RGB | null; // null = pattern / unknown
  stroke: RGB | null;
  fillAlpha: number;
  /** Set by pdfjs's setFillTransparent / setStrokeTransparent: nothing is painted. */
  fillNone: boolean;
  strokeNone: boolean;
  strokeAlpha: number;
  font: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

interface Region {
  op: number;
  box: Box;
  color: RGB | null; // null for images / shadings (unknown colour)
  opaque: boolean;
  image: boolean;
  /** Inner subpaths of a compound path (frames, rings): treated as unpainted. */
  holes?: Box[];
}

function inRegion(r: Region, x: number, y: number): boolean {
  return containsPoint(r.box, x, y) && !(r.holes ?? []).some((h) => containsPoint(h, x, y));
}

/** Bounding boxes (path space) of each subpath in pdfjs's packed path data. */
function subpathBoxes(data: unknown): Box[] {
  const arrays: ArrayLike<number>[] = [];
  const collect = (v: unknown) => {
    if (ArrayBuffer.isView(v)) arrays.push(v as unknown as ArrayLike<number>);
    else if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "number")) arrays.push(v as number[]);
      else v.forEach(collect);
    }
  };
  collect(data);
  const boxes: Box[] = [];
  let cur: Box | null = null;
  const addPt = (x: number, y: number) => {
    if (!cur) {
      cur = [x, y, x, y];
      boxes.push(cur);
    } else {
      cur[0] = Math.min(cur[0], x);
      cur[1] = Math.min(cur[1], y);
      cur[2] = Math.max(cur[2], x);
      cur[3] = Math.max(cur[3], y);
    }
  };
  for (const d of arrays) {
    for (let k = 0; k < d.length; ) {
      const op = d[k];
      const n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : op === 4 ? 0 : -1;
      if (n < 0) return []; // unknown encoding: let the caller fall back to minMax
      if (op === 0) cur = null;
      for (let j = 0; j < n; j += 2) addPt(d[k + 1 + j], d[k + 2 + j]);
      k += 1 + n;
    }
  }
  return boxes;
}

interface Run {
  op: number;
  text: string;
  box: Box;
  start: [number, number];
  end: [number, number];
  size: number;
  tech: Technique | null;
  detail?: string;
}

// ─── pdfjs loading ──────────────────────────────────────────────────

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | null = null;

async function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      installDomPolyfills(); // before pdfjs looks for DOMMatrix (see dom-polyfill.ts)
      // pdfjs warns at import time when the optional native canvas package is
      // absent; we never render, so drop exactly those messages while it loads.
      const warn = console.warn;
      console.warn = (...args: unknown[]) => {
        if (!/^Warning: Cannot (load "@napi-rs\/canvas"|access the `require`|polyfill)/.test(String(args[0])))
          warn(...args);
      };
      let lib: PdfJs;
      try {
        lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
      } finally {
        console.warn = warn;
      }
      // Run the worker in-process: no Worker/DOM needed, and it bundles into
      // `bun build --compile` because the specifier is static.
      const g = globalThis as { pdfjsWorker?: unknown };
      if (!g.pdfjsWorker) {
        // @ts-expect-error -- the worker module ships without type declarations
        g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      }
      return lib;
    })();
  }
  return pdfjsPromise;
}

// ─── Public API ─────────────────────────────────────────────────────

export async function scanPdf(
  bytes: Uint8Array,
  opts: { instructionFile?: boolean } = {},
): Promise<Finding[]> {
  return (await analyzePdf(bytes, opts)).findings;
}

/**
 * Findings plus the text a human sees on each page: glyph runs classified as
 * visible, in content-stream order, one line per text line. Invisible, white,
 * tiny, off-page, clipped, covered and hidden-layer text is left out, as is
 * render-mode-3 text over a page image (an OCR layer: the reader sees the
 * image, not this text). Annotations and metadata are not page text.
 */
export async function analyzePdf(
  bytes: Uint8Array,
  opts: { instructionFile?: boolean } = {},
): Promise<{ findings: Finding[]; pages: string[] }> {
  const findings: Finding[] = [];
  const pages: string[] = [];
  let doc: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]> | undefined;
  try {
    const pdfjs = await loadPdfJs();
    doc = await pdfjs.getDocument({
      // A real copy as a plain Uint8Array: pdfjs rejects Node Buffers and may detach
      // what it's given (Buffer#slice would return a shared Buffer view).
      data: new Uint8Array(bytes),
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
    }).promise;

    findings.push(...(await scanMetadata(doc, opts)));

    let ocConfig: { isVisible(props: unknown): boolean } | null = null;
    try {
      ocConfig = await doc.getOptionalContentConfig();
    } catch {
      ocConfig = null;
    }

    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const page = await doc.getPage(n);
        const runs = await pageRuns(pdfjs, page, ocConfig);
        findings.push(...buildPageFindings(runs, n, opts));
        pages.push(renderRuns(runs.filter((r) => r.tech === null)));
        findings.push(...(await scanAnnotations(page, n, opts)));
        page.cleanup();
      } catch (err) {
        findings.push(parseError(err, `page ${n}`));
      }
    }
  } catch (err) {
    findings.push(parseError(err));
  } finally {
    try {
      await doc?.destroy();
    } catch {
      /* ignore */
    }
  }
  return { findings, pages };
}

function parseError(err: unknown, location?: string): Finding {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    ruleId: "document/parse-error",
    type: "document_hidden",
    severity: "info",
    location,
    message: `Could not fully parse PDF${location ? ` (${location})` : ""}: ${msg}`,
    humanView: "",
    agentView: "",
    detail: msg,
  };
}

// ─── Page walk ──────────────────────────────────────────────────────

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>["getPage"]>>;

interface Glyph {
  unicode?: string;
  fontChar?: string;
  width?: number;
  isSpace?: boolean;
}

/** Every glyph run on the page, each classified as visible (tech null) or hidden by one technique. */
async function pageRuns(
  pdfjs: PdfJs,
  page: PdfPage,
  ocConfig: { isVisible(props: unknown): boolean } | null,
): Promise<Run[]> {
  const OPS = pdfjs.OPS;
  const view = page.view as number[];
  const pageBox: Box = [
    Math.min(view[0], view[2]),
    Math.min(view[1], view[3]),
    Math.max(view[0], view[2]),
    Math.max(view[1], view[3]),
  ];
  const pageArea = area(pageBox);
  const ol = await page.getOperatorList();

  let gs: GState = {
    ctm: IDENTITY,
    clip: null,
    fill: [0, 0, 0],
    stroke: [0, 0, 0],
    fillAlpha: 1,
    strokeAlpha: 1,
    fillNone: false,
    strokeNone: false,
    font: "",
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
  };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let pendingClip = false;
  let annotDepth = 0;
  const marked: boolean[] = []; // visibility of each open marked-content section
  const regions: Region[] = [];
  const runs: Run[] = [];

  const push = () => stack.push({ ...gs });
  const pop = () => {
    const s = stack.pop();
    if (s) gs = s;
  };
  const moveText = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const addRegion = (
    op: number,
    box: Box,
    color: RGB | null,
    alpha: number,
    image: boolean,
    holes?: Box[],
  ) => {
    if (annotDepth > 0 || alpha <= 0.05) return;
    const b = gs.clip ? intersect(box, gs.clip) : box;
    if (b[2] <= b[0] || b[3] <= b[1]) return;
    regions.push({
      op,
      box: b,
      color,
      opaque: alpha >= 0.95,
      image,
      holes: holes?.length ? holes : undefined,
    });
  };

  const showText = (op: number, glyphs: Array<Glyph | number | null>) => {
    const fs = gs.fontSize;
    const hs = gs.hScale;
    let text = "";
    const startTm = tm;
    let adv = 0; // text-space advance from startTm
    for (const g of glyphs) {
      if (g == null) continue;
      if (typeof g === "number") {
        const d = (-g / 1000) * fs * hs;
        adv += d;
        if (-g >= 250 && !text.endsWith(" ")) text += " ";
        continue;
      }
      text += g.unicode || g.fontChar || "";
      const w = ((g.width ?? 0) / 1000) * fs;
      adv += (w + gs.charSpacing + (g.isSpace ? gs.wordSpacing : 0)) * hs;
    }
    tm = mul([1, 0, 0, 1, adv, 0], tm);
    if (annotDepth > 0 || !text.trim()) return;

    const trm = mul(startTm, gs.ctm);
    const ySize = Math.abs(fs) * Math.hypot(trm[2], trm[3]);
    const xSize = Math.abs(fs) * hs * Math.hypot(trm[0], trm[1]);
    const lo = gs.rise - 0.2 * Math.abs(fs);
    const hi = gs.rise + 0.8 * Math.abs(fs);
    const box = boxOf(trm, Math.min(0, adv), lo, Math.max(0, adv), hi);
    const run: Run = {
      op,
      text,
      box,
      start: apply(trm, 0, gs.rise),
      end: apply(trm, adv, gs.rise),
      size: ySize,
      tech: null,
    };
    classify(run, xSize, ySize);
    runs.push(run);
  };

  const classify = (run: Run, xSize: number, ySize: number) => {
    const mode = gs.renderMode;
    if (mode === 3 || mode === 7) {
      run.tech = "render-mode";
      run.detail = `${mode} Tr`;
      return;
    }
    if (marked.includes(false)) {
      run.tech = "hidden-layer";
      run.detail = "optional content group switched off";
      return;
    }
    const fills = mode === 0 || mode === 2 || mode === 4 || mode === 6;
    const strokes = mode === 1 || mode === 2 || mode === 5 || mode === 6;
    const fillGone = !fills || gs.fillAlpha <= 0.02 || gs.fillNone;
    const strokeGone = !strokes || gs.strokeAlpha <= 0.02 || gs.strokeNone;
    if (fillGone && strokeGone) {
      run.tech = "transparent";
      run.detail = `fill alpha ${gs.fillAlpha}, stroke alpha ${gs.strokeAlpha}, ${mode} Tr`;
      return;
    }
    if (disjoint(run.box, pageBox)) {
      run.tech = "off-page";
      run.detail = `text box [${run.box.map((v) => v.toFixed(0)).join(" ")}] outside page [${pageBox.join(" ")}]`;
      return;
    }
    if (gs.clip && disjoint(run.box, gs.clip)) {
      run.tech = "clipped";
      run.detail = `text box [${run.box.map((v) => v.toFixed(0)).join(" ")}] outside clip [${gs.clip.map((v) => v.toFixed(0)).join(" ")}]`;
      return;
    }
    // Colour vs. the topmost region already painted under the text.
    const cx = (run.box[0] + run.box[2]) / 2;
    const cy = (run.box[1] + run.box[3]) / 2;
    let bg: RGB | null = WHITE;
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (r.opaque && inRegion(r, cx, cy)) {
        bg = r.color;
        break;
      }
    }
    const visibleColors: RGB[] = [];
    let unknown = false;
    for (const [gone, color] of [
      [fillGone, gs.fill],
      [strokeGone, gs.stroke],
    ] as const) {
      if (gone) continue;
      if (color) visibleColors.push(color);
      else unknown = true;
    }
    if (bg && !unknown && visibleColors.length > 0 && visibleColors.every((c) => sameColor(c, bg!))) {
      run.tech = "background-match";
      run.detail = `text ${hex(visibleColors[0])} on ${bg === WHITE ? "page" : "background"} ${hex(bg)}`;
      return;
    }
    if (Math.min(xSize, ySize) < TINY_PT) {
      run.tech = "tiny";
      run.detail = `effective size ${ySize.toFixed(2)}pt tall × ${xSize.toFixed(2)}pt wide`;
    }
  };

  const FILL_COLOR_OPS = new Set([
    OPS.setFillRGBColor,
    OPS.setFillGray,
    OPS.setFillCMYKColor,
    OPS.setFillColor,
    OPS.setFillColorN,
  ]);
  const STROKE_COLOR_OPS = new Set([
    OPS.setStrokeRGBColor,
    OPS.setStrokeGray,
    OPS.setStrokeCMYKColor,
    OPS.setStrokeColor,
    OPS.setStrokeColorN,
  ]);
  const fns = ol.fnArray;
  const args = ol.argsArray as unknown[][];
  for (let i = 0; i < fns.length; i++) {
    const fn = fns[i];
    // biome-ignore lint/suspicious/noExplicitAny: pdfjs types operator-list arguments as any[]
    const a = (args[i] ?? []) as any[];
    if (FILL_COLOR_OPS.has(fn)) gs.fillNone = false;
    else if (STROKE_COLOR_OPS.has(fn)) gs.strokeNone = false;
    switch (fn) {
      case OPS.save:
        push();
        break;
      case OPS.restore:
        pop();
        break;
      case OPS.transform:
        gs.ctm = mul(a as unknown as Matrix, gs.ctm);
        break;
      case OPS.paintFormXObjectBegin: {
        push();
        if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) gs.ctm = mul(a[0] as Matrix, gs.ctm);
        const bb = a[1] as number[] | null;
        if (bb && bb.length === 4) {
          const b = boxOf(gs.ctm, bb[0], bb[1], bb[2], bb[3]);
          gs.clip = gs.clip ? intersect(gs.clip, b) : b;
        }
        break;
      }
      case OPS.paintFormXObjectEnd:
        pop();
        break;
      case OPS.beginGroup:
        push();
        break;
      case OPS.endGroup:
        pop();
        break;
      case OPS.beginAnnotation:
        annotDepth++;
        push();
        break;
      case OPS.endAnnotation:
        annotDepth = Math.max(0, annotDepth - 1);
        pop();
        break;
      case OPS.beginMarkedContent:
        marked.push(true);
        break;
      case OPS.beginMarkedContentProps: {
        let visible = true;
        if (a[0] === "OC" && ocConfig) {
          try {
            visible = ocConfig.isVisible(a[1]);
          } catch {
            visible = true;
          }
        }
        marked.push(visible);
        break;
      }
      case OPS.endMarkedContent:
        marked.pop();
        break;
      case OPS.setGState:
        for (const entry of (a[0] ?? []) as Array<[string, unknown]>) {
          const [k, v] = entry;
          if (k === "ca" && typeof v === "number") gs.fillAlpha = v;
          else if (k === "CA" && typeof v === "number") gs.strokeAlpha = v;
          else if (k === "Font" && Array.isArray(v)) {
            if (typeof v[0] === "string") gs.font = v[0];
            if (typeof v[1] === "number") gs.fontSize = v[1];
          }
        }
        break;
      case OPS.setFillRGBColor:
        gs.fill = parseColor(a[0]);
        break;
      case OPS.setStrokeRGBColor:
        gs.stroke = parseColor(a[0]);
        break;
      case OPS.setFillGray:
        gs.fill = typeof a[0] === "number" ? [a[0] * 255, a[0] * 255, a[0] * 255] : parseColor(a[0]);
        break;
      case OPS.setStrokeGray:
        gs.stroke = typeof a[0] === "number" ? [a[0] * 255, a[0] * 255, a[0] * 255] : parseColor(a[0]);
        break;
      case OPS.setFillCMYKColor:
      case OPS.setStrokeCMYKColor: {
        let c: RGB | null = parseColor(a[0]);
        if (!c && a.length >= 4 && a.every((x) => typeof x === "number")) {
          const k = a[3];
          c = [255 * (1 - a[0]) * (1 - k), 255 * (1 - a[1]) * (1 - k), 255 * (1 - a[2]) * (1 - k)];
        }
        if (fn === OPS.setFillCMYKColor) gs.fill = c;
        else gs.stroke = c;
        break;
      }
      case OPS.setFillColor:
      case OPS.setFillColorN:
        gs.fill = parseColor(a[0]);
        break;
      case OPS.setFillTransparent:
        gs.fill = null;
        gs.fillNone = true;
        break;
      case OPS.setStrokeColor:
      case OPS.setStrokeColorN:
        gs.stroke = parseColor(a[0]);
        break;
      case OPS.setStrokeTransparent:
        gs.stroke = null;
        gs.strokeNone = true;
        break;
      case OPS.clip:
      case OPS.eoClip:
        pendingClip = true;
        break;
      case OPS.constructPath: {
        const op = a[0] as number;
        const mm = a[2] as number[] | null | undefined;
        const box =
          mm && mm.length === 4 && mm.every(Number.isFinite)
            ? boxOf(gs.ctm, mm[0], mm[1], mm[2], mm[3])
            : null;
        if (box) {
          const fills =
            op === OPS.fill ||
            op === OPS.eoFill ||
            op === OPS.fillStroke ||
            op === OPS.eoFillStroke ||
            op === OPS.closeFillStroke ||
            op === OPS.closeEOFillStroke;
          if (fills && !gs.fillNone) {
            // Split compound paths: a subpath nested inside another is a hole
            // (frames, rings), so text inside it is not "on" this fill.
            const subs = subpathBoxes(a[1]).map((b) => boxOf(gs.ctm, b[0], b[1], b[2], b[3]));
            if (subs.length > 1) {
              const nested = (s: Box) => subs.some((o) => o !== s && contains(o, s, 0) && area(o) > area(s));
              for (const outer of subs.filter((s) => !nested(s))) {
                const holes = subs.filter((s) => s !== outer && contains(outer, s, 0));
                addRegion(i, outer, gs.fill, gs.fillAlpha, false, holes);
              }
            } else {
              addRegion(i, box, gs.fill, gs.fillAlpha, false);
            }
          }
        }
        if (pendingClip) {
          if (box) gs.clip = gs.clip ? intersect(gs.clip, box) : box;
          pendingClip = false;
        }
        break;
      }
      case OPS.endPath:
        pendingClip = false;
        break;
      case OPS.shadingFill:
        addRegion(i, gs.clip ?? pageBox, null, gs.fillAlpha, false);
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
        addRegion(i, boxOf(gs.ctm, 0, 0, 1, 1), null, gs.fillAlpha, true);
        break;
      case OPS.beginText:
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case OPS.setFont:
        gs.font = String(a[0]);
        gs.fontSize = typeof a[1] === "number" ? a[1] : gs.fontSize;
        break;
      case OPS.setCharSpacing:
        gs.charSpacing = a[0];
        break;
      case OPS.setWordSpacing:
        gs.wordSpacing = a[0];
        break;
      case OPS.setHScale:
        gs.hScale = a[0] / 100;
        break;
      case OPS.setLeading:
        gs.leading = a[0];
        break;
      case OPS.setTextRise:
        gs.rise = a[0];
        break;
      case OPS.setTextRenderingMode:
        gs.renderMode = a[0];
        break;
      case OPS.moveText:
        moveText(a[0], a[1]);
        break;
      case OPS.setLeadingMoveText:
        gs.leading = -a[1];
        moveText(a[0], a[1]);
        break;
      case OPS.setTextMatrix: {
        const m = (a.length === 1 ? a[0] : a) as ArrayLike<number>;
        tlm = [m[0], m[1], m[2], m[3], m[4], m[5]];
        tm = tlm;
        break;
      }
      case OPS.nextLine:
        moveText(0, -gs.leading);
        break;
      case OPS.nextLineShowText:
        moveText(0, -gs.leading);
        showText(i, a[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        gs.wordSpacing = a[0];
        gs.charSpacing = a[1];
        moveText(0, -gs.leading);
        showText(i, a[2]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(i, a[0]);
        break;
      default:
        break;
    }
  }

  // Second pass: text painted over by a later opaque region; invisible text on scanned pages.
  const pageImages = regions.filter((r) => r.image && area(r.box) >= PAGE_IMAGE_SHARE * pageArea);
  for (const run of runs) {
    if (run.tech === "render-mode") {
      if (pageImages.some((r) => contains(r.box, run.box, 2))) {
        run.tech = "ocr-layer";
      }
      continue;
    }
    if (run.tech !== null && run.tech !== "background-match" && run.tech !== "tiny") continue;
    const cover = regions.find(
      (r) =>
        r.op > run.op &&
        r.opaque &&
        contains(r.box, run.box) &&
        !(r.holes ?? []).some((h) => !disjoint(h, run.box, 0)),
    );
    if (cover) {
      if (cover.image && area(cover.box) >= PAGE_IMAGE_SHARE * pageArea) {
        run.tech = "ocr-layer";
        run.detail = "text drawn under a page-sized image";
      } else if (run.tech === null) {
        run.tech = "covered";
        run.detail = `covered by ${cover.image ? "an image" : `a ${hex(cover.color)} filled shape`} at [${cover.box.map((v) => v.toFixed(0)).join(" ")}]`;
      }
    }
  }

  return runs;
}

/** Visible runs as text: a new line wherever the baseline changes, spaces only at positional gaps. */
function renderRuns(runs: Run[]): string {
  const lines: Run[][] = [];
  let prev: Run | null = null;
  for (const r of runs) {
    const tol = Math.max(prev?.size ?? 0, r.size, 0.1);
    if (!prev || Math.abs(r.start[1] - prev.end[1]) >= 0.5 * tol) lines.push([]);
    lines[lines.length - 1].push(r);
    prev = r;
  }
  return lines.map(joinRuns).filter(Boolean).join("\n");
}

/** Join runs into readable text, adding spaces only where there is a positional gap. */
function joinRuns(runs: Run[]): string {
  let out = "";
  let prev: Run | null = null;
  for (const r of runs) {
    if (prev) {
      const dy = Math.abs(r.start[1] - prev.end[1]);
      const dx = r.start[0] - prev.end[0];
      const tol = Math.max(prev.size, r.size, 0.1);
      const sameLine = dy < 0.5 * tol;
      const adjoining = sameLine && dx > -0.5 * tol && dx < 0.25 * tol;
      if (!adjoining && !out.endsWith(" ") && !r.text.startsWith(" ")) out += " ";
    }
    out += r.text;
    prev = r;
  }
  return out.replace(/\s+/g, " ").trim();
}

function trim(s: string, max = HUMAN_VIEW_MAX): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildPageFindings(runs: Run[], pageNum: number, opts: { instructionFile?: boolean }): Finding[] {
  const visible = runs.filter((r) => r.tech === null);
  const humanView = trim(joinRuns(visible));
  const findings: Finding[] = [];
  const techs = [...new Set(runs.map((r) => r.tech).filter((t): t is Technique => t !== null))];

  for (const tech of techs) {
    const info = TECH[tech];
    const hiddenRuns = runs.filter((r) => r.tech === tech);
    const hiddenText = joinRuns(hiddenRuns);
    if (!hiddenText) continue;

    // Agent view: visible text with this technique's hidden runs where they occur.
    const combined = runs.filter((r) => r.tech === null || r.tech === tech);
    const firstIdx = combined.indexOf(hiddenRuns[0]);
    const before = joinRuns(combined.slice(0, firstIdx));
    const rest = joinRuns(combined.slice(firstIdx));
    const prefix = before.length > 100 ? `…${before.slice(-99)}` : before;
    const agentView = trim(
      [prefix, rest].filter(Boolean).join(" "),
      Math.max(HUMAN_VIEW_MAX, prefix.length + hiddenText.length + 80),
    );

    const details = [...new Set(hiddenRuns.map((r) => r.detail).filter(Boolean))].slice(0, 3).join("; ");
    findings.push(
      concealedFinding({
        ruleId: info.ruleId,
        type: "document_hidden",
        concealment: info.concealment,
        technique: info.label,
        hiddenText,
        location: `page ${pageNum}`,
        humanView,
        agentView,
        detail: details || undefined,
        instructionFile: opts.instructionFile,
      }),
    );
  }
  return findings;
}

// ─── Metadata & annotations (channels) ─────────────────────────────

async function scanMetadata(
  doc: { getMetadata(): Promise<{ info: unknown; metadata: unknown }> },
  opts: { instructionFile?: boolean },
): Promise<Finding[]> {
  const out: Finding[] = [];
  let md: { info: unknown; metadata: unknown };
  try {
    md = await doc.getMetadata();
  } catch {
    return out;
  }
  const info = (md.info ?? {}) as Record<string, unknown>;
  const fields: Array<[string, string]> = [];
  for (const key of ["Title", "Subject", "Keywords"]) {
    const v = info[key];
    if (typeof v === "string" && v.trim()) fields.push([`Info /${key}`, v]);
  }
  const xmp = md.metadata as { get?(name: string): unknown } | null;
  if (xmp && typeof xmp.get === "function") {
    for (const key of ["dc:description", "dc:subject", "pdf:keywords"]) {
      try {
        const v = xmp.get(key);
        const s = Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "";
        if (s.trim() && !fields.some(([, f]) => f.trim() === s.trim())) fields.push([`XMP ${key}`, s]);
      } catch {
        /* ignore */
      }
    }
  }
  for (const [where, text] of fields) {
    if (classifyIntent(text).level === "trivial") continue;
    out.push(
      concealedFinding({
        ruleId: "pdf/metadata",
        type: "document_hidden",
        concealment: "channel",
        technique: `PDF metadata (${where})`,
        hiddenText: text,
        location: "document metadata",
        humanView: "",
        agentView: text,
        detail: where,
        instructionFile: opts.instructionFile,
      }),
    );
  }
  return out;
}

async function scanAnnotations(
  page: PdfPage,
  pageNum: number,
  opts: { instructionFile?: boolean },
): Promise<Finding[]> {
  const out: Finding[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: pdfjs types getAnnotations() as any[]
  let annots: any[];
  try {
    annots = await page.getAnnotations();
  } catch {
    return out;
  }
  for (const a of annots) {
    const text = [a?.contentsObj?.str, a?.richText?.str]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .filter((s, i, arr) => arr.indexOf(s) === i)
      .join(" ");
    if (!text.trim() || classifyIntent(text).level === "trivial") continue;
    out.push(
      concealedFinding({
        ruleId: "pdf/annotation",
        type: "document_hidden",
        concealment: "channel",
        technique: `PDF ${a?.subtype ?? ""} annotation contents`.replace(/\s+/g, " "),
        hiddenText: text,
        location: `page ${pageNum}`,
        humanView: "",
        agentView: text,
        detail: a?.id ? `annotation ${a.id}` : undefined,
        instructionFile: opts.instructionFile,
      }),
    );
  }
  return out;
}
