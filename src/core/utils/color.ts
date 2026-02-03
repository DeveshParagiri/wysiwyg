import { LOW_CONTRAST_THRESHOLD, NEAR_WHITE_THRESHOLD } from "../constants/index.js";

/** Named color map (subset commonly used for hiding text) */
const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  transparent: [0, 0, 0], // alpha=0, but we track that separately
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parse a CSS color value into RGBA components.
 * Handles hex (#fff, #ffffff), rgb(), rgba(), and named colors.
 */
export function parseColor(value: string): RGBA | null {
  const trimmed = value.trim().toLowerCase();

  // Named colors
  if (trimmed === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const named = NAMED_COLORS[trimmed];
  if (named) {
    return { r: named[0], g: named[1], b: named[2], a: 1 };
  }

  // Hex: #fff or #ffffff
  const hex3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(trimmed);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
      a: 1,
    };
  }

  const hex6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(trimmed);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16),
      a: 1,
    };
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(
      trimmed,
    );
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    if (r > 255 || g > 255 || b > 255) return null;
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    if (a < 0 || a > 1) return null;
    return { r, g, b, a };
  }

  return null;
}

/**
 * Calculate relative luminance of a color (0-1 scale).
 * Based on WCAG 2.0 formula.
 */
export function luminance(color: RGBA): number {
  const srgb = [color.r / 255, color.g / 255, color.b / 255];
  const linear = srgb.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Check if two colors are too similar to distinguish (hidden text).
 * Returns true if the colors have very low contrast ratio.
 */
export function isLowContrast(fg: RGBA, bg: RGBA): boolean {
  const fgLum = luminance(fg);
  const bgLum = luminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  // WCAG AA requires 4.5:1 for normal text; we flag below our threshold as hidden
  return ratio < LOW_CONTRAST_THRESHOLD;
}

/**
 * Check if a color value indicates hidden text.
 * Simple heuristic: white/near-white text or transparent text is likely hidden.
 */
export function isColorHidden(
  color: string,
  bgColor?: string,
): boolean {
  const fg = parseColor(color);
  if (!fg) return false;

  // Fully transparent = hidden
  if (fg.a === 0) return true;

  // If we have a background color, check contrast
  if (bgColor) {
    const bg = parseColor(bgColor);
    if (bg) {
      return isLowContrast(fg, bg);
    }
  }

  // Without background context, flag white/near-white text
  // (assumes white background as default)
  if (fg.r >= NEAR_WHITE_THRESHOLD && fg.g >= NEAR_WHITE_THRESHOLD && fg.b >= NEAR_WHITE_THRESHOLD) return true;

  return false;
}
