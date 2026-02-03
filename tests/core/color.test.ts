import { describe, test, expect } from "bun:test";
import { parseColor, isColorHidden, luminance, isLowContrast } from "../../src/core/utils/color.js";

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
