import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles } from "../../src/cli/platform/pool.js";
import { scanFile } from "../../src/cli/scan-file.js";
import { SHORT_PAYLOAD, toTags } from "../redteam/cases.js";

const dir = () => mkdtempSync(join(tmpdir(), "wys-sf-"));
const file = (root: string, rel: string, content: string | Uint8Array) => {
  writeFileSync(join(root, rel), content);
  return { path: join(root, rel), rel };
};

describe("scanFile", () => {
  test("binaries are skipped after sniffing (no findings, no full read)", async () => {
    const root = dir();
    const png = new Uint8Array(200_000).fill(0);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    const r = await scanFile(file(root, "img.png", png));
    expect(r.findings).toEqual([]);
  });

  test("only the head of an oversized file is scanned, and that is reported", async () => {
    const root = dir();
    const f = file(root, "big.md", `Intro${toTags(SHORT_PAYLOAD)}\n${"filler text ".repeat(5_000)}`);
    const r = await scanFile(f, { maxBytes: 4096 });
    const rules = r.findings.map((x) => x.ruleId);
    expect(rules).toContain("unicode/tags");
    expect(rules).toContain("evasion/oversized");
  });

  test("results use the display path when given", async () => {
    const root = dir();
    const r = await scanFile({ ...file(root, "a.txt", "hello"), display: "docs/a.txt" });
    expect(r.source).toBe("docs/a.txt");
  });
});

describe("scanFiles (pool)", () => {
  test("many files are scanned in parallel, results in input order", async () => {
    const root = dir();
    const files = Array.from({ length: 120 }, (_, i) =>
      file(root, `f${i}.md`, i % 10 === 0 ? `x${toTags(SHORT_PAYLOAD)}` : `plain ${i}`),
    );
    let lastProgress = 0;
    const results = await scanFiles(files, {}, (done) => {
      lastProgress = done;
    });
    expect(results.map((r) => r.source)).toEqual(files.map((f) => f.path));
    expect(results.filter((r) => !r.clean).length).toBe(12);
    expect(lastProgress).toBe(120);
  });
});
