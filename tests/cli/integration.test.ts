import { describe, test, expect } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/cli.ts");
const fixturesDir = join(import.meta.dir, "../fixtures");

function run(args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env },
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

describe("CLI integration: scan", () => {
  test("clean file exits 0", () => {
    const result = run(["scan", join(fixturesDir, "clean.txt")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No hidden content detected");
  });

  test("unicode-tags file exits 1 with findings", () => {
    const result = run(["scan", join(fixturesDir, "unicode-tags.txt")]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("unicode-tags.txt");
    expect(result.stdout).toContain("Unicode Tags");
  });

  test("JSON format outputs valid JSON", () => {
    const result = run([
      "scan",
      join(fixturesDir, "unicode-tags.txt"),
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toBeDefined();
    expect(parsed.results.length).toBe(1);
    expect(parsed.results[0].clean).toBe(false);
    expect(parsed.summary.critical).toBeGreaterThan(0);
  });

  test("HTML with display:none is detected", () => {
    const result = run([
      "scan",
      join(fixturesDir, "hidden-display-none.html"),
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("CRITICAL");
  });

  test("recursive scan finds multiple issues", () => {
    const result = run([
      "scan",
      fixturesDir,
      "-r",
      "--format",
      "json",
      "--no-config",
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.filesScanned).toBeGreaterThan(1);
    expect(parsed.summary.totalFindings).toBeGreaterThan(0);
  });

  test("stdin mode works", () => {
    const proc = Bun.spawnSync(["bun", CLI, "scan", "--stdin"], {
      cwd: join(import.meta.dir, "../.."),
      stdin: Buffer.from("Normal text, nothing hidden."),
      env: { ...process.env },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("No hidden content detected");
  });

  test("nonexistent file exits 2", () => {
    const result = run(["scan", "/nonexistent/path/file.txt"]);
    expect(result.exitCode).toBe(2);
  });
});

describe("CLI integration: help", () => {
  test("shows help text", () => {
    const result = run(["--help"]);
    expect(result.stdout).toContain("wysiwyg");
    expect(result.stdout).toContain("scan");
    expect(result.stdout).toContain("fetch");
  });

  test("scan --help shows options", () => {
    const result = run(["scan", "--help"]);
    expect(result.stdout).toContain("--recursive");
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("--clipboard");
    expect(result.stdout).toContain("--stdin");
  });
});
