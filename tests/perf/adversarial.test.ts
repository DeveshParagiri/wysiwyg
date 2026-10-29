/**
 * Adversarial performance: inputs shaped to trigger quadratic behaviour in a
 * layer. A scanner that can be made to hang is a scanner an attacker can turn
 * off (CI timeouts), so each case has a time budget.
 */
import { describe, expect, test } from "bun:test";
import { scanText } from "../../src/core/pipeline.ts";

const MB = 1_048_576;
const BUDGET_MS = 4000;

function timed(name: string, path: string, content: string) {
  test(`${name} (${(content.length / MB).toFixed(1)} MB) scans within ${BUDGET_MS} ms`, () => {
    const start = performance.now();
    scanText(content, { path });
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });
}

describe("adversarial inputs", () => {
  timed("one long line of single spaces", "README.md", "lorem ipsum dolor sit amet ".repeat(80_000));
  timed("many short whitespace runs with tabs", "notes.txt", "a\t\t b \t c\t".repeat(200_000));
  timed(
    "carriage-return progress output",
    "build.log",
    "Downloading 10%\rDownloading 55%\rDownloading 100%\n".repeat(40_000),
  );
  timed("cursor movement without newlines", "out.txt", "x\x1b[1Ay\x1b[2K".repeat(150_000));
  timed("alternating zero-width characters", "notes.txt", "a​b‌".repeat(300_000));
  timed("long variation-selector run", "notes.txt", `a${"︁".repeat(500_000)}`);
  timed("Unicode Tags run", "notes.txt", "\u{e0041}".repeat(300_000));
  timed(
    "thousands of hidden spans",
    "page.html",
    `<html><body>${'<span style="display:none">hidden words here</span> visible '.repeat(20_000)}</body></html>`,
  );
  timed(
    "deeply nested elements",
    "page.html",
    `<html><body>${"<div>".repeat(5_000)}text${"</div>".repeat(5_000)}</body></html>`,
  );
  timed(
    "many style rules",
    "page.html",
    `<html><head><style>${Array.from({ length: 5_000 }, (_, i) => `.c${i}{color:#${(i % 4096).toString(16).padStart(3, "0")}}`).join("")}</style></head><body>${'<p class="c1">x</p>'.repeat(5_000)}</body></html>`,
  );
  timed("thousands of Markdown comments", "README.md", "text <!-- note --> more\n".repeat(30_000));
  timed("base64-like noise", "data.txt", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo ".repeat(60_000));
  timed("hex-like noise", "data.txt", "deadbeef".repeat(200_000));
  timed("100k sibling elements", "page.html", `<html><body>${"<div>x</div>".repeat(100_000)}</body></html>`);
  timed("80k HTML comments", "page.html", `<html><body>${"<p>a<!-- c --></p>".repeat(80_000)}</body></html>`);
  timed("200k bidi overrides on one line", "notes.txt", "ab\u202ecd".repeat(200_000));
  timed("unterminated HTML comment", "page.html", `<html><body><!--${"x ".repeat(500_000)}</body></html>`);
});
