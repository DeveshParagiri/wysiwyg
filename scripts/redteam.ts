/**
 * Score a wysiwyg build against the red-team corpus.
 *
 *   bun scripts/redteam.ts [repoDir] [--json] [--verbose]
 *
 * repoDir defaults to this repo; point it at another checkout to compare
 * versions. Each case is written to its own temp directory and scanned via
 * the CLI from inside that directory (so a planted .wysiwygrc is honoured
 * exactly as it would be in CI).
 *
 * Two runs:
 *   attack   — agent-directed payload; every detect case must reach warning+,
 *              every benign control must stay below warning.
 *   neutral  — the same hiding techniques carrying harmless prose; "strong"
 *              cases must still reach warning+, "channel" cases must at least
 *              be reported (info+). This keeps scores honest: a case cannot
 *              pass only because the payload happens to match a phrase list.
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { cases, neutralCases, CHANNEL_IDS, type RedteamCase } from "../tests/redteam/cases.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const verbose = args.includes("--verbose");
const repoDir = resolve(args.find((a) => !a.startsWith("--")) ?? join(import.meta.dir, ".."));
const cli = join(repoDir, "src/cli/cli.ts");

const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
const NAMES = ["info", "warning", "critical"];

function writeCase(c: RedteamCase): string {
  const tmp = mkdtempSync(join(tmpdir(), `wys-${c.id}-`));
  const dir = join(tmp, "repo");
  mkdirSync(dir, { recursive: true });
  const put = (p: string, data: string | Uint8Array, base = dir) => {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), data);
  };
  for (const [p, data] of Object.entries(c.outside ?? {})) put(p, data, join(tmp, "outside"));
  for (const [p, data] of Object.entries(c.extra ?? {})) put(p, data);
  if (c.symlinks?.[c.path]) {
    mkdirSync(dirname(join(dir, c.path)), { recursive: true });
    symlinkSync(c.symlinks[c.path], join(dir, c.path));
  } else {
    put(c.path, c.content);
  }
  return dir;
}

function collectSeverities(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) x.forEach((v) => collectSeverities(v, out));
  else if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.severity === "string" && (o.type || o.ruleId)) out.push(o.severity);
    Object.values(o).forEach((v) => collectSeverities(v, out));
  }
  return out;
}

interface Row {
  run: "attack" | "neutral";
  id: string;
  category: string;
  expect: string;
  outcome: "pass" | "FAIL" | "error";
  top: string;
  note: string;
}

function score(c: RedteamCase, run: Row["run"]): Row {
  const dir = writeCase(c);
  const proc = Bun.spawnSync(["bun", "run", cli, "scan", ".", "--format", "json"], { cwd: dir, stderr: "pipe" });
  rmSync(dirname(dir), { recursive: true, force: true });
  let top = "none";
  let outcome: Row["outcome"];
  try {
    const sev = collectSeverities(JSON.parse(proc.stdout.toString()));
    const max = sev.reduce((m, s) => Math.max(m, RANK[s] ?? 0), -1);
    top = max < 0 ? "none" : NAMES[max];
    let ok: boolean;
    if (c.expect === "clean") ok = max < 1;
    else if (run === "neutral" && CHANNEL_IDS.has(c.id)) ok = max >= 0;
    else ok = max >= 1;
    outcome = ok ? "pass" : "FAIL";
  } catch {
    outcome = "error";
    top = proc.stderr.toString().trim().split("\n").pop()?.slice(0, 60) ?? "";
  }
  return { run, id: c.id, category: c.category, expect: c.expect, outcome, top, note: c.note };
}

const rows: Row[] = [
  ...cases.map((c) => score(c, "attack")),
  ...neutralCases.map((c) => score(c, "neutral")),
];

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    if (!verbose && r.outcome === "pass") continue;
    console.log(`${r.outcome === "pass" ? "✓" : "✗"} ${r.run.padEnd(7)} ${r.id.padEnd(4)} ${r.expect.padEnd(6)} ${r.top.padEnd(9)} ${r.note}`);
  }
  const pass = (rs: Row[]) => rs.filter((r) => r.outcome === "pass").length;
  const attack = rows.filter((r) => r.run === "attack" && r.expect === "detect");
  const benign = rows.filter((r) => r.expect === "clean");
  const neutral = rows.filter((r) => r.run === "neutral");
  console.log(
    `\nattacks detected ${pass(attack)}/${attack.length} · concealment-only (neutral payload) ${pass(neutral)}/${neutral.length} · benign clean ${pass(benign)}/${benign.length}`,
  );
  const cats = [...new Set(rows.map((r) => r.category))];
  console.log(
    cats
      .map((cat) => {
        const rs = rows.filter((r) => r.category === cat);
        return `${cat} ${pass(rs)}/${rs.length}`;
      })
      .join(" · "),
  );
}
