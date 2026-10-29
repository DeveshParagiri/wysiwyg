import type { CheerioAPI } from "cheerio";
import * as csstree from "css-tree/dist/csstree.esm";
import type { Element } from "domhandler";
import { descendants } from "./dom.js";
import { mediaMatches } from "./media.js";

/**
 * A small CSS cascade: enough to know, for every element, the declared value
 * of the properties that can hide text. Stylesheet rules (from <style>),
 * inline styles and presentational attributes are combined by importance,
 * origin, specificity and source order.
 */

export type StyleMap = Map<string, string>;

interface Decl {
  prop: string;
  value: string;
  important: boolean;
  /** [inline, ids, classes, types, order] — compared lexicographically */
  weight: number[];
}

/** Properties we care about (others are dropped to keep the cascade cheap). */
const TRACKED = new Set([
  "display",
  "visibility",
  "opacity",
  "font-size",
  "font",
  "color",
  "-webkit-text-fill-color",
  "background",
  "background-color",
  "background-image",
  "transform",
  "clip",
  "clip-path",
  "height",
  "max-height",
  "width",
  "max-width",
  "overflow",
  "overflow-x",
  "overflow-y",
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "margin-left",
  "margin-top",
  "text-indent",
  "content-visibility",
  "fill",
  "fill-opacity",
  "line-height",
  "white-space",
]);

function specificity(selector: string): [number, number, number] {
  const s = selector.replace(/\([^)]*\)/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (
    s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|:{1,2}[\w-]+/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []
  ).length;
  return [ids, classes, types];
}

/** Parse "prop: value; ..." into declarations. */
export function parseDeclarations(css: string): { prop: string; value: string; important: boolean }[] {
  try {
    const ast = csstree.parse(css, {
      context: "declarationList",
      parseValue: false,
    }) as csstree.DeclarationList;
    return ast.children.toArray().flatMap((d) =>
      d.type === "Declaration"
        ? [
            {
              prop: d.property.toLowerCase(),
              value: csstree.generate(d.value).trim(),
              important: Boolean(d.important),
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}

/** Elements by id, class and tag, built once per document. */
interface ElementIndex {
  byId: Map<string, Element[]>;
  byClass: Map<string, Element[]>;
  byTag: Map<string, Element[]>;
}

function buildIndex($: CheerioAPI): ElementIndex {
  const index: ElementIndex = { byId: new Map(), byClass: new Map(), byTag: new Map() };
  const push = (map: Map<string, Element[]>, key: string, el: Element) => {
    const list = map.get(key);
    if (list) list.push(el);
    else map.set(key, [el]);
  };
  for (const node of descendants($.root()[0])) {
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
    const el = node as Element;
    push(index.byTag, el.tagName.toLowerCase(), el);
    if (el.attribs?.id) push(index.byId, el.attribs.id, el);
    for (const c of el.attribs?.class?.split(/\s+/) ?? []) if (c) push(index.byClass, c, el);
  }
  return index;
}

const SIMPLE_SELECTOR = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+)*)$/;

/**
 * Match a compound selector made only of a tag, ids and classes (`p`, `.note`,
 * `div#x.a.b`) from the index. Running a full selector query per stylesheet
 * rule is O(rules × elements) — a page with thousands of rules and elements
 * took seconds. Anything more complex returns null and goes through cheerio.
 */
function matchSimple(sel: string, index: ElementIndex): Element[] | null {
  const m = SIMPLE_SELECTOR.exec(sel);
  if (!m || !sel) return null;
  const tag = m[1]?.toLowerCase();
  const parts = m[2].match(/[#.][\w-]+/g) ?? [];
  const ids = parts.filter((p) => p[0] === "#").map((p) => p.slice(1));
  const classes = parts.filter((p) => p[0] === ".").map((p) => p.slice(1));
  const candidates = ids.length
    ? index.byId.get(ids[0])
    : classes.length
      ? index.byClass.get(classes[0])
      : index.byTag.get(tag!);
  return (candidates ?? []).filter((el) => {
    if (tag && el.tagName.toLowerCase() !== tag) return false;
    if (!ids.every((id) => el.attribs?.id === id)) return false;
    const own = el.attribs?.class?.split(/\s+/) ?? [];
    return classes.every((c) => own.includes(c));
  });
}

/** Resolve declared styles for every element in the document. */
export function computeDeclaredStyles($: CheerioAPI): Map<Element, StyleMap> {
  const decls = new Map<Element, Decl[]>();
  const add = (el: Element, d: Decl) => {
    if (!TRACKED.has(d.prop)) return;
    const list = decls.get(el) ?? [];
    list.push(d);
    decls.set(el, list);
  };

  let order = 0;
  let index: ElementIndex | undefined;
  $("style").each((_i, styleEl) => {
    const css = $(styleEl).text();
    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(css, { parseValue: false, parseCustomProperty: false });
    } catch {
      return;
    }
    csstree.walk(ast, {
      visit: "Rule",
      enter(this: csstree.WalkContext, rule: csstree.Rule) {
        const at = this.atrule;
        if (at?.name === "media" && !mediaMatches(at.prelude ? csstree.generate(at.prelude) : "")) return;
        // @container depends on layout we don't compute; other at-rules don't hold style rules we can apply.
        if (at && !["media", "supports", "layer"].includes(at.name)) return;
        const ruleDecls = (rule.block.children.toArray() as csstree.CssNode[]).flatMap((d) =>
          d.type === "Declaration"
            ? [
                {
                  prop: d.property.toLowerCase(),
                  value: csstree.generate(d.value).trim(),
                  important: Boolean(d.important),
                },
              ]
            : [],
        );
        if (!ruleDecls.some((d) => TRACKED.has(d.prop))) return;
        const selectors = csstree.generate(rule.prelude).split(",");
        for (const raw of selectors) {
          const sel = raw.trim();
          // Pseudo-elements generate content humans see but agents don't (the reverse gap);
          // interaction states are not the default rendering.
          if (/::|:(before|after|hover|focus|active|visited|focus-within|focus-visible|target)\b/i.test(sel))
            continue;
          index ??= buildIndex($);
          let matched: Element[] | null = matchSimple(sel, index);
          if (!matched) {
            try {
              matched = $(sel).toArray() as Element[];
            } catch {
              continue;
            }
          }
          const [ids, classes, types] = specificity(sel);
          order++;
          for (const el of matched) {
            for (const d of ruleDecls) add(el, { ...d, weight: [0, ids, classes, types, order] });
          }
        }
      },
    });
  });

  // Presentational attributes (lowest author priority) and inline styles (highest)
  $("*").each((_i, node) => {
    const el = node as Element;
    const attr = el.attribs ?? {};
    const pres = (prop: string, value: string) =>
      add(el, { prop, value, important: false, weight: [-1, 0, 0, 0, 0] });
    if (el.tagName === "font" && attr.color) pres("color", attr.color);
    if (attr.bgcolor) pres("background-color", attr.bgcolor);
    if (inSvg(el)) {
      for (const p of [
        "fill",
        "fill-opacity",
        "opacity",
        "visibility",
        "display",
        "font-size",
        "transform",
      ]) {
        if (attr[p] !== undefined) pres(p, attr[p]);
      }
    }
    if (attr.style) {
      for (const d of parseDeclarations(attr.style)) add(el, { ...d, weight: [1, 0, 0, 0, 0] });
    }
  });

  const result = new Map<Element, StyleMap>();
  for (const [el, list] of decls) {
    list.sort((a, b) => {
      if (a.important !== b.important) return a.important ? 1 : -1;
      for (let i = 0; i < a.weight.length; i++)
        if (a.weight[i] !== b.weight[i]) return a.weight[i] - b.weight[i];
      return 0;
    });
    const map: StyleMap = new Map();
    for (const d of list) map.set(d.prop, d.value);
    // Shorthands we read through
    if (map.has("background") && !map.has("background-color")) {
      const bg = map.get("background")!;
      if (/url\(|gradient\(/i.test(bg)) map.set("background-image", bg);
      const color = firstColorToken(bg);
      if (color) map.set("background-color", color);
    }
    if (map.has("font") && !map.has("font-size")) {
      const m = /(?:^|\s)([\d.]+(?:px|pt|em|rem|%)|0)(?:\/[\S]+)?\s/.exec(`${map.get("font")!} `);
      if (m) map.set("font-size", m[1]);
    }
    result.set(el, map);
  }
  return result;
}

/** True for <svg> and its descendants (namespace is not set in XML mode). */
function inSvg(el: Element): boolean {
  if (el.namespace === "http://www.w3.org/2000/svg") return true;
  for (let cur: Element | null = el; cur && cur.type === "tag"; cur = cur.parent as Element | null) {
    if (cur.tagName?.toLowerCase() === "svg") return true;
  }
  return false;
}

function firstColorToken(value: string): string | null {
  const m = /(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b[a-z]+\b)/i.exec(
    value.replace(/url\([^)]*\)/gi, ""),
  );
  if (!m) return null;
  return m[1];
}

/** Convert a CSS length to px. Returns null for values we can't resolve. */
export function toPx(value: string, parentPx: number, rootPx = 16): number | null {
  const v = value.trim().toLowerCase();
  if (v === "0") return 0;
  const keywords: Record<string, number> = {
    "xx-small": 9,
    "x-small": 10,
    small: 13,
    medium: 16,
    large: 18,
    "x-large": 24,
    "xx-large": 32,
    smaller: parentPx * 0.83,
    larger: parentPx * 1.2,
  };
  if (v in keywords) return keywords[v];
  const m = /^(-?[\d.]+)(px|pt|em|rem|%|vw|vh|ch|ex|pc|in|cm|mm|q)?$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case undefined:
      return n; // unitless (SVG attributes)
    case "px":
      return n;
    case "pt":
      return (n * 4) / 3;
    case "pc":
      return n * 16;
    case "in":
      return n * 96;
    case "cm":
      return (n * 96) / 2.54;
    case "mm":
      return (n * 96) / 25.4;
    case "q":
      return (n * 96) / 101.6;
    case "em":
      return n * parentPx;
    case "ex":
    case "ch":
      return n * parentPx * 0.5;
    case "rem":
      return n * rootPx;
    case "%":
      return (n / 100) * parentPx;
    case "vw":
      return (n / 100) * 1280;
    case "vh":
      return (n / 100) * 800;
  }
  return null;
}
