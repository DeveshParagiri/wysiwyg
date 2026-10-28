import { LOW_CONTRAST_THRESHOLD, NEAR_WHITE_THRESHOLD } from "../constants/index.js";
import { NAMED_COLORS } from "./named-colors.js";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hexToRgba(hex: string): RGBA | null {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  const full =
    h.length === 3 || h.length === 4
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (full.length !== 6 && full.length !== 8) return null;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

function parseComponent(v: string, max: number): number {
  return v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v);
}

function parseAlpha(v: string | undefined): number {
  if (v === undefined) return 1;
  return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/**
 * Parse a CSS color into RGBA. Handles hex (3/4/6/8 digits), rgb()/rgba() and
 * hsl()/hsla() in both comma and space syntax, the 148 named colors, and
 * `transparent`. Returns null for anything else (var(), currentColor, …).
 */
export function parseColor(value: string): RGBA | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important$/, "");
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith("#")) return hexToRgba(v);
  if (NAMED_COLORS[v]) return hexToRgba(NAMED_COLORS[v]);

  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;

  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => parseComponent(p, 255));
    const a = parseAlpha(parts[3]);
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    if (r > 255 || g > 255 || b > 255 || a < 0 || a > 1) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
  }
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  const a = parseAlpha(parts[3]);
  if ([h, s, l, a].some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, s, l);
  return { r, g, b, a };
}

/** Relative luminance (WCAG 2.x), 0–1. */
export function luminance(color: RGBA): number {
  const srgb = [color.r / 255, color.g / 255, color.b / 255];
  const linear = srgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Composite a (possibly translucent) foreground over an opaque background. */
export function blend(fg: RGBA, bg: RGBA): RGBA {
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

export function contrastRatio(fg: RGBA, bg: RGBA): number {
  const a = luminance(blend(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** True if the two colors are too close to tell apart. */
export function isLowContrast(fg: RGBA, bg: RGBA): boolean {
  return contrastRatio(fg, bg) < LOW_CONTRAST_THRESHOLD;
}

/**
 * Check if a text color is effectively invisible. With a background, compares
 * contrast; without one, assumes a white page.
 */
export function isColorHidden(color: string, bgColor?: string): boolean {
  const fg = parseColor(color);
  if (!fg) return false;
  if (fg.a <= 0.05) return true;
  const bg = (bgColor && parseColor(bgColor)) || { r: 255, g: 255, b: 255, a: 1 };
  if (bgColor && bg.a === 0) return isColorHidden(color);
  if (
    !bgColor &&
    fg.r >= NEAR_WHITE_THRESHOLD &&
    fg.g >= NEAR_WHITE_THRESHOLD &&
    fg.b >= NEAR_WHITE_THRESHOLD
  )
    return true;
  return isLowContrast(fg, { ...bg, a: 1 });
}
