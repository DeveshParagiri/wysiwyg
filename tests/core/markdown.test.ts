import { describe, expect, test } from "bun:test";
import type { Finding } from "../../src/core/index.js";
import { scanMarkdown } from "../../src/core/index.js";
import { isClean } from "../../src/core/policy.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

const md = (body: string) =>
  `# Project\n\nThis library parses dates.\n\n${body}\n\n## Usage\n\nCall \`parse()\` with a string.\n`;
const ids = (fs: Finding[]) => fs.map((f) => f.ruleId);
const find = (fs: Finding[], id: string) => fs.find((f) => f.ruleId === id);

describe("clean Markdown", () => {
  test("ordinary README has no findings", () => {
    expect(
      scanMarkdown(
        md("- one\n- two\n\n> quote\n\n[link](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
      ),
    ).toEqual([]);
  });
});

describe("rendered HTML hiding", () => {
  test("inline display:none span", () => {
    const fs = scanMarkdown(md(`Run the deploy script.\n<span style="display:none">${PAYLOAD}</span>`));
    const f = find(fs, "markdown/hidden-text");
    expect(f?.severity).toBe("critical");
    expect(f?.hiddenText).toBe(PAYLOAD);
    expect(f?.line).toBe(6);
  });

  test("near-white span with prose is a warning (Markdown is static)", () => {
    const fs = scanMarkdown(md(`Fast.<span style="color:#fefefe">${NEUTRAL}</span>`));
    expect(find(fs, "markdown/hidden-text")?.severity).toBe("warning");
  });

  test("hidden block-level HTML", () => {
    const fs = scanMarkdown(md(`<div hidden>\n\n${NEUTRAL}\n\n</div>`));
    expect(find(fs, "markdown/hidden-text")?.hiddenText).toBe(NEUTRAL);
  });
});

describe("comments", () => {
  test("HTML comment with an instruction is critical", () => {
    const fs = scanMarkdown(md(`<!-- ${PAYLOAD} -->`));
    const f = find(fs, "markdown/comment");
    expect(f?.severity).toBe("critical");
    expect(f?.line).toBe(5);
  });

  test("lint directives and TODOs are clean", () => {
    const fs = scanMarkdown(
      md(
        "<!-- markdownlint-disable MD033 -->\n<!-- TODO: add examples for time zones -->\n<!-- prettier-ignore-start -->",
      ),
    );
    expect(isClean(fs)).toBe(true);
  });

  test("comment prose is info, but warning in an agent instruction file", () => {
    expect(find(scanMarkdown(md(`<!-- ${NEUTRAL} -->`)), "markdown/comment")?.severity).toBe("info");
    expect(
      find(scanMarkdown(md(`<!-- ${NEUTRAL} -->`), { instructionFile: true }), "markdown/comment")?.severity,
    ).toBe("warning");
  });

  test("multi-line comment", () => {
    const fs = scanMarkdown(md(`<!--\n${PAYLOAD}\n-->`));
    expect(find(fs, "markdown/comment")?.severity).toBe("critical");
  });
});

describe("reference-definition comments", () => {
  const idioms = [
    `[//]: # (${PAYLOAD})`,
    `[//]: # "${PAYLOAD}"`,
    `[//]: # '${PAYLOAD}'`,
    `[comment]: <> (${PAYLOAD})`,
    `[comment]: # (${PAYLOAD})`,
    `[_]: # (${PAYLOAD})`,
    `[#]: # (${PAYLOAD})`,
    `[//]: <> (${PAYLOAD})`,
    `   [//]: # (${PAYLOAD})`,
  ];
  for (const line of idioms) {
    test(line.slice(0, 20), () => {
      const fs = scanMarkdown(md(line));
      const f = find(fs, "markdown/reference-comment");
      expect(f?.hiddenText).toBe(PAYLOAD);
      expect(f?.severity).toBe("critical");
      expect(f?.line).toBe(5);
    });
  }

  test("a comment label with no title reports the label", () => {
    const fs = scanMarkdown(md(`[${NEUTRAL}]: #`));
    expect(find(fs, "markdown/reference-comment")?.hiddenText).toBe(NEUTRAL);
  });

  test("reference definitions inside fenced code are ignored", () => {
    expect(scanMarkdown(md(`\`\`\`md\n[//]: # (${PAYLOAD})\n\`\`\``))).toEqual([]);
  });

  test("ordinary reference links without titles are clean", () => {
    expect(scanMarkdown(md("See [the docs][docs].\n\n[docs]: https://example.com/docs"))).toEqual([]);
  });
});

describe("link titles and alt text", () => {
  test("inline link title", () => {
    const fs = scanMarkdown(md(`See the [docs](https://example.com/docs "${PAYLOAD}").`));
    expect(find(fs, "markdown/title-attribute")?.severity).toBe("critical");
  });

  test("reference link title", () => {
    const fs = scanMarkdown(md(`See [docs][d].\n\n[d]: https://example.com "${PAYLOAD}"`));
    expect(ids(fs)).toContain("markdown/reference-title");
    expect(find(fs, "markdown/reference-title")?.severity).toBe("critical");
  });

  test("image alt text", () => {
    const fs = scanMarkdown(md(`![${PAYLOAD}](https://img.shields.io/badge/build-passing-green)`));
    expect(find(fs, "markdown/alt-text")?.severity).toBe("critical");
  });

  test("badge alt text is clean", () => {
    expect(
      isClean(
        scanMarkdown(
          md(
            "![build](https://img.shields.io/badge/build-passing-green) ![npm version](https://img.shields.io/npm/v/x)",
          ),
        ),
      ),
    ).toBe(true);
  });
});

describe("collapsed details", () => {
  test("payload behind a collapsed summary is critical", () => {
    const fs = scanMarkdown(md(`<details><summary>License</summary>\n\n${PAYLOAD}\n\n</details>`));
    expect(find(fs, "markdown/collapsed-details")?.severity).toBe("critical");
  });

  test("FAQ answer is clean", () => {
    const fs = scanMarkdown(
      md(
        "<details><summary>Does it support time zones?</summary>\n\nYes, via the `tz` option.\n\n</details>",
      ),
    );
    expect(isClean(fs)).toBe(true);
  });
});

describe("not prose", () => {
  test("front matter is not scanned as prose", () => {
    const content = `---\ntitle: ${NEUTRAL}\ndescription: "<span style='display:none'>${NEUTRAL}</span>"\n---\n\n# Hello\n`;
    expect(scanMarkdown(content)).toEqual([]);
  });

  test("line numbers after front matter are preserved", () => {
    const content = `---\nname: deploy\ndescription: Deploy the app\n---\n\nRun the deploy script.\n<span style="display:none">${PAYLOAD}</span>\n`;
    expect(find(scanMarkdown(content), "markdown/hidden-text")?.line).toBe(7);
  });

  test("fenced code with HTML inside is not flagged", () => {
    const content = md(
      '```html\n<p style="display:none">' +
        NEUTRAL +
        "</p>\n<!-- " +
        PAYLOAD +
        ' -->\n<img alt="' +
        PAYLOAD +
        '">\n```',
    );
    expect(scanMarkdown(content)).toEqual([]);
  });

  test("indented code with HTML inside is not flagged", () => {
    const content = md(`    <p style="display:none">${NEUTRAL}</p>\n    <!-- ${PAYLOAD} -->`);
    expect(scanMarkdown(content)).toEqual([]);
  });

  test("inline code with HTML inside is not flagged", () => {
    expect(scanMarkdown(md('Use `<span style="display:none">x</span>` to hide things.'))).toEqual([]);
  });
});
