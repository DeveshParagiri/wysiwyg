import { describe, expect, test } from "bun:test";
import { scanLayout } from "../../src/core/index.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

describe("horizontal padding", () => {
  test("instruction pushed off-screen by spaces is critical", () => {
    const fs = scanLayout(`Use 2-space indentation.${" ".repeat(400)}${PAYLOAD}\nPrefer named exports.\n`);
    expect(fs).toHaveLength(1);
    expect(fs[0].ruleId).toBe("layout/horizontal-padding");
    expect(fs[0].severity).toBe("critical");
    expect(fs[0].line).toBe(1);
    expect(fs[0].column).toBe("Use 2-space indentation.".length + 401);
    expect(fs[0].humanView).toBe("Use 2-space indentation.");
    expect(fs[0].hiddenText).toBe(PAYLOAD);
  });

  test("prose pushed off-screen is a warning", () => {
    const fs = scanLayout(`Use tabs.${" ".repeat(300)}${NEUTRAL}`);
    expect(fs[0].severity).toBe("warning");
  });

  test("tabs and non-breaking/ideographic spaces count as padding", () => {
    const pad = "\t \u00A0\u3000".repeat(40);
    const fs = scanLayout(`ok${pad}${NEUTRAL}`);
    expect(fs).toHaveLength(1);
  });

  test("fewer than 100 padding characters is not reported", () => {
    expect(scanLayout(`a${" ".repeat(99)}${NEUTRAL}`)).toEqual([]);
  });

  test("trailing whitespace alone is not reported", () => {
    expect(scanLayout(`line${" ".repeat(300)}\nnext`)).toEqual([]);
  });

  test("long lines without whitespace runs (CSV) are clean", () => {
    const csv = `id,${Array.from({ length: 200 }, (_, i) => `col${i}`).join(",")}\n`;
    expect(scanLayout(csv)).toEqual([]);
  });

  test("reports the right line", () => {
    const fs = scanLayout(`one\ntwo\nthree${" ".repeat(200)}${NEUTRAL}\n`);
    expect(fs[0].line).toBe(3);
  });
});

describe("vertical padding", () => {
  test("instruction after many blank lines is critical", () => {
    const fs = scanLayout(`# Readme\n\nNormal content.\n${"\n".repeat(80)}${PAYLOAD}\n`);
    expect(fs).toHaveLength(1);
    expect(fs[0].ruleId).toBe("layout/vertical-padding");
    expect(fs[0].severity).toBe("critical");
    expect(fs[0].line).toBe(84);
  });

  test("prose after many blank lines is a channel (info)", () => {
    const fs = scanLayout(`Readme\n${"\n".repeat(80)}${NEUTRAL}`);
    expect(fs).toHaveLength(1);
    expect(fs[0].severity).toBe("info");
  });

  test("blank lines containing only spaces still count", () => {
    const fs = scanLayout(`Readme\n${"   \n".repeat(80)}${PAYLOAD}`);
    expect(fs[0]?.ruleId).toBe("layout/vertical-padding");
  });

  test("a short gap is not reported", () => {
    expect(scanLayout(`Readme\n${"\n".repeat(20)}${PAYLOAD}`)).toEqual([]);
  });

  test("a short gap before more content is clean", () => {
    expect(scanLayout(`a\n${"\n".repeat(10)}b\n`)).toEqual([]);
  });
});
