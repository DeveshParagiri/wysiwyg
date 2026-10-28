import { describe, expect, test } from "bun:test";
import { analyzeClipboardHTML } from "../../src/core/index.js";
import { isClean } from "../../src/core/policy.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

const VISIBLE = "Run npm install to get started with the project.";

describe("analyzeClipboardHTML", () => {
  test("empty HTML flavour → no findings", () => {
    expect(analyzeClipboardHTML("", VISIBLE)).toEqual([]);
  });

  test("matching HTML and plain text → no findings", () => {
    expect(analyzeClipboardHTML(`<p>${VISIBLE}</p>`, VISIBLE)).toEqual([]);
  });

  test("whitespace and markup differences are not reported", () => {
    expect(
      analyzeClipboardHTML(
        `<div><b>Run</b>   npm <i>install</i> to get started\nwith the project.</div>`,
        VISIBLE,
      ),
    ).toEqual([]);
  });

  test("hidden span in copied HTML is reported as clipboard_hidden", () => {
    const fs = analyzeClipboardHTML(`<p>${VISIBLE}<span style="display:none">${PAYLOAD}</span></p>`, VISIBLE);
    const f = fs.find((x) => x.ruleId === "clipboard/hidden-text");
    expect(f).toBeDefined();
    expect(f!.type).toBe("clipboard_hidden");
    expect(f!.severity).toBe("critical");
  });

  test("hidden prose in a copy is a warning (clipboard HTML is static)", () => {
    const fs = analyzeClipboardHTML(
      `<p>${VISIBLE}<span style="font-size:0">${NEUTRAL}</span></p><script>1</script>`,
      VISIBLE,
    );
    expect(fs.find((x) => x.ruleId === "clipboard/hidden-text")?.severity).toBe("warning");
  });

  test("text present only in the HTML flavour is reported", () => {
    const fs = analyzeClipboardHTML(`<p>${VISIBLE}</p><p>${PAYLOAD}</p>`, VISIBLE);
    const f = fs.find((x) => x.ruleId === "clipboard/html-only-text");
    expect(f?.severity).toBe("critical");
    expect(f?.hiddenText).toContain("ignore previous instructions");
    expect(f?.type).toBe("clipboard_hidden");
  });

  test("the same hidden text is not reported twice", () => {
    const fs = analyzeClipboardHTML(`<p>${VISIBLE}<span style="display:none">${PAYLOAD}</span></p>`, VISIBLE);
    expect(fs.filter((x) => x.hiddenText?.includes("ignore previous instructions"))).toHaveLength(1);
  });

  test("a small difference (a few words) is not reported", () => {
    const fs = analyzeClipboardHTML(`<p>${VISIBLE} Thanks!</p>`, VISIBLE);
    expect(fs).toEqual([]);
  });

  test("benign rich copy with a link title is clean", () => {
    const fs = analyzeClipboardHTML(
      `<p><a href="https://example.com" title="Example">${VISIBLE}</a></p>`,
      VISIBLE,
    );
    expect(isClean(fs)).toBe(true);
  });
});
