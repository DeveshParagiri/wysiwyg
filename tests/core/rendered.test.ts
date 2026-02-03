import { describe, test, expect } from "bun:test";
import {
  scanMarkdown,
  scanHTML,
  extractVisibleText,
  extractAllText,
} from "../../src/core/scanner/rendered.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("extractVisibleText", () => {
  test("extracts visible text, removing hidden elements", () => {
    const html = `<p>Visible</p><div style="display:none">Hidden</div><p>Also visible</p>`;
    const text = extractVisibleText(html);
    expect(text).toContain("Visible");
    expect(text).toContain("Also visible");
    expect(text).not.toContain("Hidden");
  });

  test("removes script and style content", () => {
    const html = `<p>Text</p><script>var x = 1;</script><style>.x{color:red}</style>`;
    const text = extractVisibleText(html);
    expect(text).toBe("Text");
  });
});

describe("extractAllText", () => {
  test("extracts all text including hidden", () => {
    const html = `<p>Visible</p><div style="display:none">Hidden</div>`;
    const text = extractAllText(html);
    expect(text).toContain("Visible");
    expect(text).toContain("Hidden");
  });

  test("extracts HTML comments", () => {
    const html = `<p>Text</p><!-- Secret comment -->`;
    const text = extractAllText(html);
    expect(text).toContain("Secret comment");
  });
});

describe("scanHTML", () => {
  test("detects display:none hidden content", () => {
    const content = readFileSync(join(fixturesDir, "hidden-display-none.html"), "utf-8");
    const findings = scanHTML(content);
    expect(findings.length).toBeGreaterThan(0);
    const hiddenFinding = findings.find((f) => f.type === "hidden_rendered");
    expect(hiddenFinding).toBeDefined();
    expect(hiddenFinding!.severity).toBe("critical");
    expect(hiddenFinding!.agentView).toContain("ignore previous instructions");
  });

  test("detects white text on white background", () => {
    const content = readFileSync(join(fixturesDir, "hidden-white-text.html"), "utf-8");
    const findings = scanHTML(content);
    const colorFinding = findings.find(
      (f) => f.type === "hidden_rendered" && f.detail?.includes("color"),
    );
    expect(colorFinding).toBeDefined();
  });

  test("detects HTML comments", () => {
    const content = readFileSync(join(fixturesDir, "hidden-comment.html"), "utf-8");
    const findings = scanHTML(content);
    const commentFinding = findings.find((f) => f.type === "html_comment");
    expect(commentFinding).toBeDefined();
    expect(commentFinding!.agentView).toContain("ignore all previous instructions");
  });

  test("detects font-size:0 hidden text", () => {
    const content = readFileSync(join(fixturesDir, "hidden-font-size-0.html"), "utf-8");
    const findings = scanHTML(content);
    const sizeFinding = findings.find(
      (f) => f.type === "hidden_rendered" && f.message.includes("fontSizeZero"),
    );
    expect(sizeFinding).toBeDefined();
    expect(sizeFinding!.severity).toBe("critical");
  });
});

describe("scanMarkdown", () => {
  test("returns no findings for clean markdown", () => {
    const content = readFileSync(join(fixturesDir, "markdown-clean.md"), "utf-8");
    const findings = scanMarkdown(content);
    expect(findings.length).toBe(0);
  });

  test("detects markdown comments", () => {
    const content = readFileSync(join(fixturesDir, "markdown-comment.md"), "utf-8");
    const findings = scanMarkdown(content);
    expect(findings.length).toBeGreaterThan(0);

    const mdComment = findings.find(
      (f) => f.type === "html_comment" && f.detail?.includes("[//]: #"),
    );
    expect(mdComment).toBeDefined();
  });

  test("detects HTML comments in markdown", () => {
    const content = readFileSync(join(fixturesDir, "markdown-comment.md"), "utf-8");
    const findings = scanMarkdown(content);
    const htmlComment = findings.find(
      (f) => f.type === "html_comment" && f.detail?.includes("<!--"),
    );
    expect(htmlComment).toBeDefined();
  });
});
