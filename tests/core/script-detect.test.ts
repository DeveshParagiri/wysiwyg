import { describe, test, expect } from "bun:test";
import {
  detectScript,
  getDominantScript,
  isJoiningScript,
} from "../../src/core/utils/script-detect.js";

describe("detectScript", () => {
  test("detects Latin characters", () => {
    expect(detectScript("A".codePointAt(0)!)).toBe("Latin");
    expect(detectScript("z".codePointAt(0)!)).toBe("Latin");
  });

  test("detects Arabic characters", () => {
    expect(detectScript(0x0627)).toBe("Arabic"); // Alef
    expect(detectScript(0x0645)).toBe("Arabic"); // Meem
  });

  test("detects Devanagari characters", () => {
    expect(detectScript(0x0905)).toBe("Devanagari"); // A
  });

  test("detects CJK characters", () => {
    expect(detectScript(0x4e00)).toBe("CJK");
  });

  test("detects Cyrillic characters", () => {
    expect(detectScript(0x0410)).toBe("Cyrillic"); // A
  });

  test("returns Common for digits", () => {
    expect(detectScript("0".codePointAt(0)!)).toBe("Common");
    expect(detectScript("9".codePointAt(0)!)).toBe("Common");
  });

  test("returns Common for punctuation", () => {
    expect(detectScript(".".codePointAt(0)!)).toBe("Common");
    expect(detectScript(",".codePointAt(0)!)).toBe("Common");
  });
});

describe("getDominantScript", () => {
  test("returns Latin for English text", () => {
    const text = "Hello, this is English text.";
    expect(getDominantScript(text, 10)).toBe("Latin");
  });

  test("returns Arabic for Arabic text", () => {
    const text = "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645";
    expect(getDominantScript(text, 5)).toBe("Arabic");
  });

  test("defaults to Latin when no script characters nearby", () => {
    const text = "12345";
    expect(getDominantScript(text, 2)).toBe("Latin");
  });
});

describe("isJoiningScript", () => {
  test("Arabic is a joining script", () => {
    expect(isJoiningScript("Arabic")).toBe(true);
  });

  test("Devanagari is a joining script", () => {
    expect(isJoiningScript("Devanagari")).toBe(true);
  });

  test("Latin is not a joining script", () => {
    expect(isJoiningScript("Latin")).toBe(false);
  });

  test("CJK is not a joining script", () => {
    expect(isJoiningScript("CJK")).toBe(false);
  });
});
