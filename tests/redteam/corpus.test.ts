/**
 * The red-team corpora as regression tests.
 *
 * Content cases run in-process; evasion cases (which depend on the file
 * walker, config loading and symlinks) run through the real CLI in a temp
 * directory, exactly as scripts/redteam.ts scores them.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanBytes } from "../../src/core/pipeline.ts";
import type { Severity } from "../../src/core/types.ts";
import { CHANNEL_IDS, cases, neutralCases, type RedteamCase } from "./cases.ts";
import { holdoutCases } from "./holdout.ts";

const CLI = join(import.meta.dir, "../../src/cli/cli.ts");
const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

function writeCase(c: RedteamCase): string {
  const tmp = mkdtempSync(join(tmpdir(), `wys-${c.id}-`));
  const dir = join(tmp, "repo");
  const put = (p: string, data: string | Uint8Array, base = dir) => {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), data);
  };
  mkdirSync(dir, { recursive: true });
  for (const [p, data] of Object.entries(c.outside ?? {})) put(p, data, join(tmp, "outside"));
  for (const [p, data] of Object.entries(c.extra ?? {})) put(p, data);
  if (c.symlinks?.[c.path]) {
    mkdirSync(dirname(join(dir, c.path)), { recursive: true });
    symlinkSync(c.symlinks[c.path], join(dir, c.path));
  } else put(c.path, c.content);
  return dir;
}

/** Highest severity reported for a case (-1 = nothing). */
async function topSeverity(c: RedteamCase): Promise<number> {
  if (c.category === "evasion") {
    const dir = writeCase(c);
    try {
      const proc = Bun.spawnSync(["bun", CLI, "scan", ".", "--format", "json"], { cwd: dir });
      const out = JSON.parse(proc.stdout.toString()) as { results: { findings: { severity: Severity }[] }[] };
      return Math.max(-1, ...out.results.flatMap((r) => r.findings.map((f) => RANK[f.severity])));
    } finally {
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  }
  const bytes = typeof c.content === "string" ? new TextEncoder().encode(c.content) : c.content;
  const findings = await scanBytes(bytes, { path: c.path });
  return Math.max(-1, ...findings.map((f) => RANK[f.severity]));
}

const label = (c: RedteamCase) => `${c.id} ${c.note}`;

describe("corpus: attacks are detected at warning or above", () => {
  for (const c of [...cases, ...holdoutCases].filter((c) => c.expect === "detect")) {
    test(label(c), async () => expect(await topSeverity(c)).toBeGreaterThanOrEqual(1));
  }
});

describe("corpus: concealment alone is detected (neutral payload)", () => {
  for (const c of neutralCases) {
    const min = CHANNEL_IDS.has(c.id) ? 0 : 1;
    test(label(c), async () => expect(await topSeverity(c)).toBeGreaterThanOrEqual(min));
  }
});

describe("corpus: benign controls stay below warning", () => {
  for (const c of [...cases, ...holdoutCases].filter((c) => c.expect === "clean")) {
    test(label(c), async () => expect(await topSeverity(c)).toBeLessThan(1));
  }
});
