import { describe, expect, test } from "bun:test";
import {
  blend,
  contrastRatio,
  isColorHidden,
  isLowContrast,
  luminance,
  parseColor,
} from "../../src/core/utils/color.js";

describe("parseColor", () => {
  test("parses 3-digit hex", () => {
    const color = parseColor("#fff");
    expect(color).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  test("parses 6-digit hex", () => {
    const color = parseColor("#ff0000");
    expect(color).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  test("parses rgb()", () => {
    const color = parseColor("rgb(128, 64, 32)");
    expect(color).toEqual({ r: 128, g: 64, b: 32, a: 1 });
  });

  test("parses rgba()", () => {
    const color = parseColor("rgba(255, 0, 0, 0.5)");
    expect(color).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
  });

  test("parses named color 'white'", () => {
    const color = parseColor("white");
    expect(color).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  test("parses 'transparent'", () => {
    const color = parseColor("transparent");
    expect(color).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  test("returns null for invalid color", () => {
    expect(parseColor("notacolor")).toBeNull();
  });

  test("returns null for out-of-range RGB values", () => {
    expect(parseColor("rgb(999, 0, 0)")).toBeNull();
    expect(parseColor("rgb(0, 256, 0)")).toBeNull();
    expect(parseColor("rgb(0, 0, 300)")).toBeNull();
  });

  test("returns null for out-of-range alpha", () => {
    expect(parseColor("rgba(0, 0, 0, 2)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0, -1)")).toBeNull();
  });

  test("handles whitespace", () => {
    const color = parseColor("  #abc  ");
    expect(color).toEqual({ r: 170, g: 187, b: 204, a: 1 });
  });
});

describe("luminance", () => {
  test("white has luminance ~1", () => {
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 1);
  });

  test("black has luminance ~0", () => {
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 1);
  });
});

describe("isLowContrast", () => {
  test("white on white is low contrast", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(isLowContrast(white, white)).toBe(true);
  });

  test("black on white is not low contrast", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(isLowContrast(black, white)).toBe(false);
  });

  test("near-white on white is low contrast", () => {
    const nearWhite = { r: 254, g: 254, b: 254, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(isLowContrast(nearWhite, white)).toBe(true);
  });
});

describe("isColorHidden", () => {
  test("white text is hidden (default bg)", () => {
    expect(isColorHidden("#ffffff")).toBe(true);
    expect(isColorHidden("#fff")).toBe(true);
    expect(isColorHidden("white")).toBe(true);
  });

  test("transparent text is hidden", () => {
    expect(isColorHidden("transparent")).toBe(true);
    expect(isColorHidden("rgba(0,0,0,0)")).toBe(true);
  });

  test("white on white is hidden", () => {
    expect(isColorHidden("#fff", "#fff")).toBe(true);
  });

  test("black on white is not hidden", () => {
    expect(isColorHidden("#000", "#fff")).toBe(false);
  });

  test("red text is not hidden", () => {
    expect(isColorHidden("red")).toBe(false);
    expect(isColorHidden("#ff0000")).toBe(false);
  });
});

describe("parseColor: modern syntax", () => {
  test("4- and 8-digit hex carry alpha", () => {
    expect(parseColor("#fff0")).toEqual({ r: 255, g: 255, b: 255, a: 0 });
    expect(parseColor("#00000080")?.a).toBeCloseTo(0.5, 2);
  });

  test("rejects malformed hex", () => {
    expect(parseColor("#ff")).toBeNull();
    expect(parseColor("#ggg")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });

  test("space-separated rgb() with slash alpha", () => {
    expect(parseColor("rgb(255 255 255)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgb(0 0 0 / 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgba(10 20 30 / 0.25)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
  });

  test("percentage rgb components", () => {
    expect(parseColor("rgb(100%, 0%, 50%)")).toEqual({ r: 255, g: 0, b: 128, a: 1 });
  });

  test("hsl() in comma and space syntax", () => {
    expect(parseColor("hsl(0, 0%, 100%)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("hsl(0 0% 100%)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("hsl(120, 100%, 50%)")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor("hsla(240 100% 50% / 0.5)")).toEqual({ r: 0, g: 0, b: 255, a: 0.5 });
    expect(parseColor("hsl(-120, 100%, 50%)")).toEqual({ r: 0, g: 0, b: 255, a: 1 });
  });

  test("named colours are case-insensitive", () => {
    expect(parseColor("GhostWhite")).toEqual({ r: 248, g: 248, b: 255, a: 1 });
    expect(parseColor("rebeccapurple")).toEqual({ r: 102, g: 51, b: 153, a: 1 });
  });

  test("!important suffix is tolerated", () => {
    expect(parseColor("#fff !important")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  test("unresolvable values return null", () => {
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("var(--fg)")).toBeNull();
    expect(parseColor("inherit")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
  });
});

describe("contrastRatio", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const black = { r: 0, g: 0, b: 0, a: 1 };

  test("black on white is 21:1", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 0);
  });

  test("same colour is 1:1", () => {
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
  });

  test("translucent text is blended over the background", () => {
    expect(contrastRatio({ ...black, a: 0 }, white)).toBeCloseTo(1, 5);
    expect(blend({ ...black, a: 0.5 }, white)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });
});

describe("isColorHidden: more cases", () => {
  test("near-white named colours are hidden on white", () => {
    expect(isColorHidden("ghostwhite")).toBe(true);
    expect(isColorHidden("snow")).toBe(true);
  });

  test("dark text on dark background is hidden", () => {
    expect(isColorHidden("#121212", "#111")).toBe(true);
  });

  test("light text on dark background is visible", () => {
    expect(isColorHidden("#ddd", "#111")).toBe(false);
  });

  test("a transparent background falls back to white", () => {
    expect(isColorHidden("#fff", "transparent")).toBe(true);
    expect(isColorHidden("#000", "transparent")).toBe(false);
  });

  test("unparseable colours are not hidden", () => {
    expect(isColorHidden("var(--x)")).toBe(false);
  });
});
