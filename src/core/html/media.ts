/**
 * Media query evaluation against the viewport a reviewer is assumed to use:
 * a desktop screen, 1280×800, light color scheme.
 *
 * Rules inside media queries apply only when the query matches. A query we
 * cannot evaluate is treated as not matching, so an unknown condition can
 * never hide text by itself — and a responsive "hide on mobile" rule doesn't
 * count as hiding content from a desktop reader.
 */

export const VIEWPORT = { width: 1280, height: 800 } as const;

const FEATURES: Record<string, string> = {
  "prefers-color-scheme": "light",
  orientation: "landscape",
  hover: "hover",
  "any-hover": "hover",
  pointer: "fine",
  "any-pointer": "fine",
  "prefers-reduced-motion": "no-preference",
  "prefers-contrast": "no-preference",
  scan: "progressive",
  "display-mode": "browser",
};

function lengthPx(v: string): number | null {
  const m = /^(-?[\d.]+)(px|em|rem)?$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === "em" || m[2] === "rem" ? n * 16 : n;
}

function dimension(name: string): number | null {
  if (name === "width" || name === "device-width") return VIEWPORT.width;
  if (name === "height" || name === "device-height") return VIEWPORT.height;
  return null;
}

function compare(a: number, op: string, b: number): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return a === b;
  }
}

function evalFeature(expr: string): boolean {
  const e = expr.trim().toLowerCase();

  // Range syntax: (width >= 600px), (400px <= width <= 900px)
  const range = e.split(/\s*(<=|>=|<|>|=)\s*/);
  if (range.length === 3 || range.length === 5) {
    const value = (s: string) => dimension(s) ?? lengthPx(s);
    for (let i = 0; i + 2 < range.length; i += 2) {
      const a = value(range[i]);
      const b = value(range[i + 2]);
      if (a === null || b === null || !compare(a, range[i + 1], b)) return false;
    }
    return true;
  }

  const [name, rawValue] = e.split(/\s*:\s*/);
  if (rawValue === undefined) return name === "color" || name in FEATURES;
  const minMax = /^(min|max)-(.+)$/.exec(name);
  if (minMax) {
    const actual = dimension(minMax[2]);
    const limit = lengthPx(rawValue);
    if (actual === null || limit === null) return false;
    return minMax[1] === "min" ? actual >= limit : actual <= limit;
  }
  const dim = dimension(name);
  if (dim !== null) return lengthPx(rawValue) === dim;
  return FEATURES[name] === rawValue;
}

function evalQuery(query: string): boolean {
  let q = query.trim().toLowerCase();
  let negate = false;
  if (q.startsWith("not ")) {
    negate = true;
    q = q.slice(4);
  }
  q = q.replace(/^only\s+/, "");
  let ok = true;
  const type = /^([a-z-]+)(\s|$)/.exec(q);
  if (type && !q.startsWith("(")) {
    ok = type[1] === "all" || type[1] === "screen";
    q = q.slice(type[0].length);
  }
  for (const m of q.matchAll(/\(([^()]+)\)/g)) ok &&= evalFeature(m[1]);
  return negate ? !ok : ok;
}

/** Does a media query list (an @media prelude) match the reviewer's viewport? */
export function mediaMatches(prelude: string): boolean {
  if (!prelude.trim()) return true;
  return prelude.split(",").some(evalQuery);
}
