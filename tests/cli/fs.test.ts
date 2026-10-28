import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { matchesIgnorePattern, readFileForScan, walkDirectory } from "../../src/cli/platform/fs.js";
import { DEFAULT_CONFIG } from "../../src/core/constants/index.js";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "wysiwyg-fs-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmp, "t-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return base;
}
const rels = async (root: string, ignore: string[] = []) =>
  (await walkDirectory(root, ignore)).map((f) => f.rel).sort();

describe("matchesIgnorePattern", () => {
  test("dir/** matches the directory at any depth", () => {
    expect(matchesIgnorePattern("dist/a.js", ["dist/**"])).toBe(true);
    expect(matchesIgnorePattern("pkg/dist/a.js", ["dist/**"])).toBe(true);
    expect(matchesIgnorePattern("dist", ["dist/**"])).toBe(true);
    expect(matchesIgnorePattern("distribution/a.js", ["dist/**"])).toBe(false);
  });

  test("**/dir matches the directory", () => {
    expect(matchesIgnorePattern("a/b/build", ["**/build"])).toBe(true);
  });

  test("*.ext matches extensions", () => {
    expect(matchesIgnorePattern("bun.lock", ["*.lock"])).toBe(true);
    expect(matchesIgnorePattern("a/yarn.lock", ["*.lock"])).toBe(true);
    expect(matchesIgnorePattern("lockfile.txt", ["*.lock"])).toBe(false);
  });

  test("everything patterns", () => {
    for (const p of ["**", "*", "**/*"]) expect(matchesIgnorePattern("x/y.txt", [p])).toBe(true);
  });

  test("Windows separators are normalised", () => {
    expect(matchesIgnorePattern("dist\\a.js", ["dist/**"])).toBe(true);
  });

  test("no patterns → no match", () => {
    expect(matchesIgnorePattern("a.txt", [])).toBe(false);
  });
});

describe("walkDirectory", () => {
  test("lists files recursively with / separated relative paths", async () => {
    const root = tree({ "a.txt": "a", "sub/b.md": "b", "sub/deeper/c.html": "c" });
    expect(await rels(root)).toEqual(["a.txt", "sub/b.md", "sub/deeper/c.html"]);
  });

  test("node_modules and .git are never descended into", async () => {
    const root = tree({
      "a.txt": "a",
      "node_modules/pkg/index.js": "x",
      ".git/config": "x",
      "pkg/node_modules/x/CLAUDE.md": "x",
    });
    expect(await rels(root)).toEqual(["a.txt"]);
  });

  test("ignore patterns skip files and directories", async () => {
    const root = tree({ "a.txt": "a", "dist/out.js": "x", "bun.lock": "x" });
    expect(await rels(root, [...DEFAULT_CONFIG.ignore])).toEqual(["a.txt"]);
  });

  test("an ignored dir still yields .claude/skills/build/SKILL.md", async () => {
    const root = tree({
      ".claude/skills/build/SKILL.md": "skill",
      ".claude/skills/build/run.sh": "echo",
      "build/out.js": "x",
    });
    expect(await rels(root, [...DEFAULT_CONFIG.ignore])).toEqual([
      ".claude/skills/build/SKILL.md",
      ".claude/skills/build/run.sh",
    ]);
  });

  test("ignore patterns never hide top-level agent files", async () => {
    const root = tree({ "CLAUDE.md": "x", "README.md": "x", ".cursorrules": "x" });
    expect(await rels(root, ["*.md", ".cursorrules"])).toEqual([".cursorrules", "CLAUDE.md"]);
  });

  // Regression: ignore patterns can never hide agent instruction files.
  test("ignoring .claude/** still yields the agent files inside it", async () => {
    const root = tree({ ".claude/commands/deploy.md": "x", ".claude/settings.json": "{}" });
    expect(await rels(root, [".claude/**"])).toEqual([".claude/commands/deploy.md", ".claude/settings.json"]);
  });

  // Regression: agent files nested anywhere inside an ignored directory are still found.
  test("ignoring a directory still yields nested agent files (packages/x/AGENTS.md)", async () => {
    const root = tree({ "packages/x/AGENTS.md": "x", "packages/x/index.js": "x" });
    expect(await rels(root, ["packages/**"])).toEqual(["packages/x/AGENTS.md"]);
  });

  test("symlink cycles do not hang", async () => {
    const root = tree({ "a/b/file.txt": "x" });
    symlinkSync("../../a", join(root, "a/b/loop"));
    symlinkSync(".", join(root, "self"));
    const files = await walkDirectory(root, []);
    expect(files.map((f) => f.rel)).toEqual(["a/b/file.txt"]);
  });

  test("symlinked files are followed; outside targets are flagged", async () => {
    const outside = tree({ "notes.md": "x" });
    const root = tree({ "inside.txt": "x" });
    symlinkSync(join(outside, "notes.md"), join(root, "AGENTS.md"));
    symlinkSync("inside.txt", join(root, "alias.txt"));
    const files = await walkDirectory(root, []);
    const agents = files.find((f) => f.rel === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.outsideTarget).toContain("notes.md");
    expect(files.find((f) => f.rel === "alias.txt")?.outsideTarget).toBeUndefined();
  });

  test("dangling symlinks are skipped", async () => {
    const root = tree({ "a.txt": "x" });
    symlinkSync("does-not-exist", join(root, "dangling.txt"));
    expect(await rels(root)).toEqual(["a.txt"]);
  });
});

describe("readFileForScan", () => {
  test("reads small files whole", async () => {
    const root = tree({ "a.txt": "hello" });
    const r = await readFileForScan(join(root, "a.txt"));
    expect(new TextDecoder().decode(r.bytes)).toBe("hello");
    expect(r.size).toBe(5);
    expect(r.truncated).toBe(false);
  });

  test("caps at maxBytes and reports truncation", async () => {
    const root = tree({ "big.txt": "x".repeat(1000) });
    const r = await readFileForScan(join(root, "big.txt"), 100);
    expect(r.bytes.length).toBe(100);
    expect(r.size).toBe(1000);
    expect(r.truncated).toBe(true);
  });
});
