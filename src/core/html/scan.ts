import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { LOW_CONTRAST_THRESHOLD } from "../constants/index.js";
import { concealedFinding } from "../policy.js";
import { LineIndex } from "../text/lines.js";
import { capPerRule } from "../text/unicode.js";
import type { Concealment, Finding } from "../types.js";
import { contrastRatio, parseColor, type RGBA } from "../utils/color.js";
import { computeDeclaredStyles, type StyleMap, toPx } from "./style.js";

/**
 * HTML / SVG projection.
 *
 * Computes, for every text node, whether a human would perceive it once the
 * page is rendered, by running a small cascade (stylesheets, inline styles,
 * presentational attributes, UA defaults) and walking the tree with inherited
 * state: visibility, cumulative opacity, font size, color and the effective
 * background. Text that is in the document but not perceivable is grouped by
 * the element that hides it and reported with the technique.
 *
 * Separately, agent-only channels — comments, alt/title/aria text, meta tags,
 * templates, collapsed <details> — are reported as channels so their
 * severity depends on what they say.
 */

export interface HtmlScanOptions {
  /** Parse as XML (SVG files). */
  xml?: boolean;
  instructionFile?: boolean;
  /**
   * Source used to locate findings when the HTML was generated (e.g. rendered
   * from Markdown). Lines are found by searching for the hidden text.
   */
  source?: string;
  /** Document cannot run scripts (Markdown, SVG files, email): toggleable UI never toggles. */
  staticDocument?: boolean;
  /** Prefix for ruleIds ("html" or "markdown"). */
  rulePrefix?: string;
}

interface State {
  hiddenBy: { el: Element; technique: string; toggleable: boolean; srOnly: boolean } | null;
  visibility: "visible" | "hidden";
  opacity: number;
  fontPx: number;
  color: RGBA;
  background: RGBA | null; // null = unknown (image/gradient)
  svg: boolean;
}

const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** Elements never rendered (UA stylesheet display:none) whose text agents may still read. */
const NEVER_RENDERED = new Set(["datalist", "param", "source", "track", "area", "map"]);
/** Elements whose content is code, not text: skipped entirely. */
const CODE = new Set(["script", "style"]);
/** Document head: <title> shows in the tab; <meta> is handled as a channel. */
const HEAD = new Set(["head", "title"]);
/** Elements handled as channels instead of by the walk. */
const CHANNEL_ELEMENTS = new Set(["template", "noscript", "desc", "metadata"]);

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Decide whether this element hides its content; returns a technique label or null. */
function hidingTechnique(
  el: Element,
  s: StyleMap,
  parent: State,
): { technique: string; toggleable: boolean; srOnly: boolean } | null {
  const tag = el.tagName?.toLowerCase();
  const attr = el.attribs ?? {};
  const display = s.get("display")?.toLowerCase();
  if (display === "none") return { technique: "display:none", toggleable: true, srOnly: false };
  if (attr.hidden !== undefined) return { technique: "hidden attribute", toggleable: true, srOnly: false };
  if (tag === "dialog" && attr.open === undefined)
    return { technique: "closed <dialog>", toggleable: true, srOnly: false };
  if (NEVER_RENDERED.has(tag))
    return { technique: `<${tag}> is not rendered`, toggleable: false, srOnly: false };
  if (s.get("content-visibility") === "hidden")
    return { technique: "content-visibility:hidden", toggleable: true, srOnly: false };

  const transform = s.get("transform") ?? "";
  const scale = /scale[xy3d]*\(\s*(-?[\d.]+)/i.exec(transform);
  if (scale && Math.abs(parseFloat(scale[1])) <= 0.05)
    return { technique: `transform:${transform}`, toggleable: false, srOnly: false };
  if (/matrix\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0/.test(transform))
    return { technique: `transform:${transform}`, toggleable: false, srOnly: false };

  const position = s.get("position");
  const overflow = [s.get("overflow"), s.get("overflow-x"), s.get("overflow-y")].join(" ");
  const clipsOverflow = /hidden|clip/.test(overflow);
  const px = (p: string) => {
    const v = s.get(p);
    return v === undefined ? null : toPx(v, parent.fontPx);
  };

  // Screen-reader-only pattern: tiny absolutely-positioned box with clipping
  const tinyBox = (px("width") ?? 99) <= 1 && (px("height") ?? 99) <= 1;
  const clip = s.get("clip") ?? "";
  const clipPath = s.get("clip-path") ?? "";
  const clipZero = /rect\(\s*(0|1px)[\s,]+(0|1px)[\s,]+(0|1px)[\s,]+(0|1px)\s*\)/i.test(clip);
  const clipPathHides =
    /inset\(\s*(5\d|[6-9]\d|100)%/i.test(clipPath) ||
    /circle\(\s*0/i.test(clipPath) ||
    /polygon\(\s*0\S*\s+0\S*\s*,\s*0\S*\s+0\S*\s*,\s*0/i.test(clipPath);
  if (
    (position === "absolute" || position === "fixed") &&
    (tinyBox || clipZero) &&
    (clipsOverflow || clipZero || clipPathHides)
  ) {
    return { technique: "visually hidden (screen-reader-only pattern)", toggleable: false, srOnly: true };
  }
  if (clipZero && (position === "absolute" || position === "fixed"))
    return { technique: `clip:${clip}`, toggleable: false, srOnly: false };
  if (clipPathHides) return { technique: `clip-path:${clipPath}`, toggleable: false, srOnly: false };

  // Collapsed box
  const zero = (p: string) => {
    const v = px(p);
    return v !== null && v <= 0.5;
  };
  if (clipsOverflow && (zero("height") || zero("max-height") || zero("width") || zero("max-width"))) {
    return { technique: "zero-size box with overflow:hidden", toggleable: true, srOnly: false };
  }

  // Off-screen
  if (position === "absolute" || position === "fixed" || position === "relative") {
    for (const p of ["left", "top", "right", "bottom"]) {
      const v = s.get(p);
      if (!v) continue;
      const n = toPx(v, parent.fontPx);
      if ((n !== null && n <= -500) || /^-\s*\d{2,}(\.\d+)?%$/.test(v.trim())) {
        return { technique: `positioned off-screen (${p}:${v})`, toggleable: false, srOnly: false };
      }
    }
  }
  for (const p of ["margin-left", "margin-top", "text-indent"]) {
    const n = px(p);
    if (n !== null && n <= -500) return { technique: `${p}:${s.get(p)}`, toggleable: false, srOnly: false };
  }
  return null;
}

export function scanHtml(html: string, opts: HtmlScanOptions = {}): Finding[] {
  const prefix = opts.rulePrefix ?? (opts.xml ? "svg" : "html");
  const $: CheerioAPI = opts.xml
    ? cheerio.load(html, { xml: { xmlMode: true, withStartIndices: true } } as cheerio.CheerioOptions)
    : cheerio.load(html, { sourceCodeLocationInfo: true } as cheerio.CheerioOptions);
  const source = opts.source ?? html;
  const idx = new LineIndex(source);
  const styles = computeDeclaredStyles($);

  const scripted =
    !opts.staticDocument &&
    $("script").filter(
      (_i, el) => !/json|template|text\/(x-)?(template|html)/i.test($(el).attr("type") ?? ""),
    ).length > 0;

  const findings: Finding[] = [];
  const lineFor = (node: AnyNode | null, text: string): number | undefined => {
    if (!opts.source && node) {
      const loc =
        (node as Element & { sourceCodeLocation?: { startOffset: number } }).sourceCodeLocation
          ?.startOffset ?? (node as Element).startIndex;
      if (typeof loc === "number" && loc >= 0) return idx.lineOf(loc);
    }
    const probe = text.replace(/\s+/g, " ").trim().slice(0, 40);
    return idx.find(probe) ?? idx.find(probe.split(" ").slice(0, 3).join(" "));
  };

  // ── Walk ──
  interface HiddenGroup {
    root: Element;
    technique: string;
    toggleable: boolean;
    srOnly: boolean;
    parts: string[];
  }
  const groups = new Map<Element, HiddenGroup>();

  const walk = (node: AnyNode, state: State) => {
    if (node.type === "text") {
      const text = (node as unknown as { data: string }).data;
      if (!text.trim()) return;
      const reason = textHidden(state);
      if (!reason) return;
      const g = groups.get(reason.el) ?? {
        root: reason.el,
        technique: reason.technique,
        toggleable: reason.toggleable,
        srOnly: reason.srOnly,
        parts: [],
      };
      g.parts.push(text);
      groups.set(reason.el, g);
      return;
    }
    if (node.type !== "tag" && node.type !== "root" && node.type !== "script" && node.type !== "style")
      return;
    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? "";
    if (CODE.has(tag) || CHANNEL_ELEMENTS.has(tag) || (HEAD.has(tag) && !opts.xml)) return;

    const s = styles.get(el) ?? new Map();
    const next: State = { ...state, svg: state.svg || tag === "svg" };

    // Inherited / cumulative properties
    const vis = s.get("visibility");
    if (vis === "hidden" || vis === "collapse") next.visibility = "hidden";
    else if (vis === "visible") next.visibility = "visible";
    const op = num(s.get("opacity"));
    if (op !== null) next.opacity *= s.get("opacity")!.trim().endsWith("%") ? op / 100 : op;
    const fs = s.get("font-size");
    if (fs) {
      const px = toPx(fs, state.fontPx);
      if (px !== null) next.fontPx = px;
    }
    const colorProp = next.svg ? s.get("fill") : (s.get("-webkit-text-fill-color") ?? s.get("color"));
    if (colorProp) {
      if (/^none$/i.test(colorProp)) next.color = { ...BLACK, a: 0 };
      else {
        const c = parseColor(colorProp);
        if (c) next.color = c;
      }
    }
    const fo = num(s.get("fill-opacity"));
    if (fo !== null && next.svg) next.color = { ...next.color, a: next.color.a * fo };
    const bgImage = s.get("background-image");
    const hasImage = Boolean(bgImage && !/^none$/i.test(bgImage));
    if (hasImage) next.background = null; // contrast against an image is unknown
    const bgc = s.get("background-color");
    if (bgc && !hasImage) {
      const c = parseColor(bgc);
      if (c && c.a > 0.5) next.background = { ...c, a: 1 };
    }

    if (!state.hiddenBy && tag) {
      const h = hidingTechnique(el, s, state);
      if (h) next.hiddenBy = { el, ...h };
    }
    // Remember the element for per-element hiding (color, size, opacity, visibility)
    (next as State & { el?: Element }).el = el;

    // Closed <details>: everything except the summary is a channel
    if (tag === "details" && el.attribs?.open === undefined) {
      for (const child of el.children) {
        if (child.type === "tag" && (child as Element).tagName?.toLowerCase() === "summary")
          walk(child, next);
      }
      return;
    }
    for (const child of el.children ?? []) walk(child, next);
  };

  const textHidden = (state: State & { el?: Element }) => {
    if (state.hiddenBy) return state.hiddenBy;
    const el = state.el!;
    if (state.visibility === "hidden")
      return { el, technique: "visibility:hidden", toggleable: true, srOnly: false };
    if (state.opacity <= 0.05)
      return { el, technique: `opacity:${+state.opacity.toFixed(3)}`, toggleable: false, srOnly: false };
    if (state.fontPx <= 2)
      return { el, technique: `font-size:${+state.fontPx.toFixed(2)}px`, toggleable: false, srOnly: false };
    if (state.color.a <= 0.05)
      return {
        el,
        technique: state.svg ? "transparent fill" : "transparent text color",
        toggleable: false,
        srOnly: false,
      };
    if (state.background) {
      const ratio = contrastRatio(state.color, state.background);
      if (ratio < LOW_CONTRAST_THRESHOLD) {
        return {
          el,
          technique: `text color matches background (contrast ${ratio.toFixed(2)}:1)`,
          toggleable: false,
          srOnly: false,
        };
      }
    }
    return null;
  };

  const rootState: State & { el?: Element } = {
    hiddenBy: null,
    visibility: "visible",
    opacity: 1,
    fontPx: 16,
    color: BLACK,
    background: opts.xml ? null : WHITE,
    svg: Boolean(opts.xml),
  };
  walk($.root()[0] as AnyNode, rootState);

  for (const g of groups.values()) {
    const hiddenText = g.parts.join(" ").replace(/\s+/g, " ").trim();
    if (!hiddenText) continue;
    let concealment: Concealment = "hidden";
    if (g.srOnly) concealment = "channel";
    else if (g.toggleable && scripted) concealment = "channel";
    const technique = g.srOnly
      ? "Visually hidden (screen-reader-only) text"
      : g.toggleable && scripted
        ? `Hidden until revealed by script (${g.technique})`
        : `Hidden text (${g.technique}${describeEl(g.root)})`;
    const context = blockContext(g.root, groups);
    findings.push(
      concealedFinding({
        ruleId: `${prefix}/hidden-text`,
        type: "hidden_rendered",
        concealment,
        technique,
        hiddenText,
        line: lineFor(g.root, hiddenText),
        humanView: context.human,
        agentView: context.agent,
        detail: g.technique,
        instructionFile: opts.instructionFile,
      }),
    );
  }

  // ── Channels ──
  const channel = (ruleId: string, technique: string, text: string, node: AnyNode | null) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    findings.push(
      concealedFinding({
        ruleId: `${prefix}/${ruleId}`,
        type: "html_comment",
        concealment: "channel",
        technique,
        hiddenText: t,
        line: lineFor(node, t),
        humanView: "",
        agentView: t,
        instructionFile: opts.instructionFile,
      }),
    );
  };

  $("*")
    .contents()
    .each((_i, node) => {
      if (node.type === "comment")
        channel("comment", "HTML comment", (node as unknown as { data: string }).data, node);
    });
  $.root()
    .contents()
    .each((_i, node) => {
      if (node.type === "comment")
        channel("comment", "HTML comment", (node as unknown as { data: string }).data, node);
    });
  $("template").each((_i, el) =>
    channel(
      "template",
      "<template> content (never rendered)",
      $(el).text() || cheerio.load($(el).html() ?? "").text(),
      el,
    ),
  );
  $("noscript").each((_i, el) => {
    const inner = cheerio.load($(el).html() ?? "").text();
    channel("noscript", "<noscript> content (shown only without JavaScript)", inner, el);
  });
  $("details:not([open])").each((_i, el) => {
    const body = $(el).clone();
    body.children("summary").remove();
    channel("collapsed-details", "Collapsed <details> content", body.text(), el);
  });
  $("[alt]").each((_i, el) => channel("alt-text", "Image alt text", $(el).attr("alt") ?? "", el));
  $("[title]").each((_i, el) => {
    if ((el as Element).tagName?.toLowerCase() === "title") return;
    channel("title-attribute", "title attribute (tooltip only)", $(el).attr("title") ?? "", el);
  });
  $("[aria-label], [aria-description]").each((_i, el) => {
    const visible = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
    for (const a of ["aria-label", "aria-description"]) {
      const v = $(el).attr(a);
      if (v && v.trim().toLowerCase() !== visible)
        channel("aria-label", `${a} differs from visible text`, v, el);
    }
  });
  $("meta[content]").each((_i, el) => {
    const name = ($(el).attr("name") ?? $(el).attr("property") ?? "").toLowerCase();
    if (!/description|keywords|author|subject|abstract|summary|^og:|^twitter:/.test(name)) return;
    channel("meta", `<meta ${name}>`, $(el).attr("content") ?? "", el);
  });
  $("input[type=hidden][value]").each((_i, el) =>
    channel("hidden-input", "Hidden form field value", $(el).attr("value") ?? "", el),
  );
  if (opts.xml) {
    $("desc, metadata").each((_i, el) =>
      channel("svg-metadata", `<${(el as Element).tagName}> (not rendered)`, $(el).text(), el),
    );
  }
  $("title").each((_i, el) => {
    if (opts.xml) channel("svg-metadata", "<title> (tooltip only)", $(el).text(), el);
  });

  return capPerRule(findings);
}

function describeEl(el: Element): string {
  const tag = el.tagName?.toLowerCase();
  if (!tag) return "";
  const id = el.attribs?.id ? `#${el.attribs.id}` : "";
  const cls = el.attribs?.class ? `.${el.attribs.class.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
  return ` on <${tag}${id}${cls}>`;
}

/** Visible vs full text of the nearest block ancestor, for the H/A diff. */
/**
 * Human vs agent text around a hidden element: its own text plus neighbouring
 * siblings (≈160 characters each side). Bounded, so pages with thousands of
 * hidden elements stay linear, and always centred on the hidden content.
 */
function blockContext(root: Element, groups: Map<Element, unknown>): { human: string; agent: string } {
  const WINDOW = 160;
  const text = (node: AnyNode, skipHidden: boolean, budget: number): string => {
    if (node.type === "text") return (node as unknown as { data: string }).data.slice(0, budget);
    if (node.type !== "tag") return "";
    const el = node as Element;
    if (CODE.has(el.tagName?.toLowerCase())) return "";
    if (skipHidden && groups.has(el)) return " ";
    let out = "";
    for (const child of el.children ?? []) {
      if (out.length >= budget) break;
      out += text(child, skipHidden, budget - out.length);
    }
    return out;
  };
  const side = (dir: "prev" | "next", skipHidden: boolean) => {
    const parts: string[] = [];
    let len = 0;
    for (
      let n = dir === "prev" ? root.prev : root.next;
      n && len < WINDOW;
      n = dir === "prev" ? n.prev : n.next
    ) {
      const t = text(n, skipHidden, WINDOW - len);
      parts.push(t);
      len += t.length;
    }
    return dir === "prev" ? parts.reverse().join("") : parts.join("");
  };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const human = norm(`${side("prev", true)} ${side("next", true)}`);
  const agent = norm(`${side("prev", false)} ${text(root, false, 2000)} ${side("next", false)}`);
  return { human: clip(human, 400), agent: clip(agent, 400) };
}

function clip(s: string, max = 240): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
