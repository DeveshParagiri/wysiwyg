import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile, loadConfig, mergeConfig, validateConfig } from "../../src/cli/config/loader.js";
import { DEFAULT_CONFIG } from "../../src/core/constants/index.js";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "wysiwyg-config-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dirWith(rc?: string): string {
  const d = mkdtempSync(join(tmp, "d-"));
  if (rc !== undefined) writeFileSync(join(d, ".wysiwygrc"), rc);
  return d;
}

describe("validateConfig", () => {
  test("keeps valid fields", () => {
    expect(
      validateConfig({ expected_scripts: ["Latin", "Arabic"], ignore: ["dist/**"], fail_on: "warning" }),
    ).toEqual({
      expected_scripts: ["Latin", "Arabic"],
      ignore: ["dist/**"],
      fail_on: "warning",
    });
  });

  test("drops wrong types and unknown values", () => {
    expect(
      validateConfig({ expected_scripts: "Latin", ignore: [1, "a", null], fail_on: "error", extra: true }),
    ).toEqual({ ignore: ["a"] });
  });

  test("non-objects become empty config", () => {
    expect(validateConfig(null)).toEqual({});
    expect(validateConfig("ignore: x")).toEqual({});
    expect(validateConfig(42)).toEqual({});
  });
});

describe("mergeConfig", () => {
  test("overrides replace, missing fields keep defaults", () => {
    const merged = mergeConfig({ ...DEFAULT_CONFIG }, { fail_on: "info" });
    expect(merged.fail_on).toBe("info");
    expect(merged.ignore).toEqual(DEFAULT_CONFIG.ignore);
    expect(merged.expected_scripts).toEqual(DEFAULT_CONFIG.expected_scripts);
  });
});

describe("findConfigFile", () => {
  test("finds .wysiwygrc in the start dir", () => {
    const d = dirWith("fail_on: warning\n");
    expect(findConfigFile(d)?.path).toBe(join(d, ".wysiwygrc"));
  });

  test("walks up to a parent", () => {
    const d = dirWith("fail_on: warning\n");
    const child = join(d, "a/b");
    mkdirSync(child, { recursive: true });
    expect(findConfigFile(child)?.path).toBe(join(d, ".wysiwygrc"));
  });

  test("a config inside the scanned tree is untrusted", () => {
    expect(findConfigFile(dirWith("fail_on: warning\n"))?.trusted).toBe(false);
  });
});

describe("loadConfig", () => {
  test("loads and merges a valid config", () => {
    const d = dirWith("fail_on: warning\nexpected_scripts: [Latin, Cyrillic]\nignore:\n  - vendor/**\n");
    const c = loadConfig(d);
    expect(c.findings).toEqual([]);
    expect(c.path).toBe(join(d, ".wysiwygrc"));
    expect(c.config).toEqual({
      fail_on: "warning",
      expected_scripts: ["Latin", "Cyrillic"],
      ignore: ["vendor/**"],
    });
  });

  test("no config in the tree → defaults (or the user's home config)", () => {
    const c = loadConfig(dirWith());
    expect(c.findings).toEqual([]);
    if (c.path === null) expect(c.config).toEqual({ ...DEFAULT_CONFIG });
    else expect(c.trusted).toBe(true);
  });

  const overbroad = [
    "**",
    "*",
    "**/*",
    "*.md",
    "CLAUDE.md",
    ".claude/**",
    ".cursor/**",
    "AGENTS.md",
    "*.mdc",
  ];
  for (const pattern of overbroad) {
    test(`untrusted overbroad ignore ${JSON.stringify(pattern)} is refused`, () => {
      const c = loadConfig(dirWith(`ignore:\n  - "${pattern}"\n  - "dist/**"\n`));
      expect(c.config.ignore).toEqual(["dist/**"]);
      expect(c.findings).toHaveLength(1);
      expect(c.findings[0].ruleId).toBe("config/overbroad-ignore");
      expect(c.findings[0].severity).toBe("warning");
      expect(c.findings[0].message).toContain(JSON.stringify(pattern));
    });
  }

  test("narrow patterns from an untrusted config are kept", () => {
    const c = loadConfig(dirWith('ignore:\n  - "dist/**"\n  - "*.lock"\n  - "fixtures/**"\n'));
    expect(c.findings).toEqual([]);
    expect(c.config.ignore).toEqual(["dist/**", "*.lock", "fixtures/**"]);
  });

  test("an explicit --config path is trusted (overbroad patterns kept)", () => {
    const d = dirWith();
    const p = join(d, "trusted.yml");
    writeFileSync(p, 'ignore:\n  - "**"\n');
    const c = loadConfig(d, p);
    expect(c.trusted).toBe(true);
    expect(c.findings).toEqual([]);
    expect(c.config.ignore).toEqual(["**"]);
  });

  test("unparseable in-tree config → config/parse-error and defaults", () => {
    const c = loadConfig(dirWith("ignore: [unclosed\n  fail_on: : :\n"));
    expect(c.findings.map((f) => f.ruleId)).toEqual(["config/parse-error"]);
    expect(c.findings[0].severity).toBe("warning");
    expect(c.config).toEqual({ ...DEFAULT_CONFIG });
  });

  test("unparseable explicit config throws", () => {
    const d = dirWith();
    const p = join(d, "bad.yml");
    writeFileSync(p, "ignore: [unclosed\n");
    expect(() => loadConfig(d, p)).toThrow();
  });

  test("missing explicit config throws", () => {
    expect(() => loadConfig(dirWith(), join(tmp, "nope.yml"))).toThrow();
  });

  test("empty config file → defaults", () => {
    const c = loadConfig(dirWith(""));
    expect(c.findings).toEqual([]);
    expect(c.config).toEqual({ ...DEFAULT_CONFIG });
  });
});
