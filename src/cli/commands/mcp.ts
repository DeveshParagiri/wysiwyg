import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  type ListResult,
  listHttpServer,
  listStdioServer,
  type StdioServer,
} from "../../core/mcp/client.js";
import { type McpCatalog, scanMcpServers } from "../../core/mcp/scan.js";
import { isClean, meetsThreshold } from "../../core/policy.js";
import { visualize } from "../../core/text/lines.js";
import type { OutputFormat, ScanResult, Severity } from "../../core/types.js";
import { formatFindings } from "../output/formatter.js";
import { writeOut } from "../output/write.js";

/**
 * `wysiwyg mcp`: connect to MCP servers and scan what they show the model.
 *
 * Three ways to pick servers:
 *   wysiwyg mcp -- <command> [args...]      one stdio server
 *   wysiwyg mcp --url <url>                 one Streamable HTTP server
 *   wysiwyg mcp --config .mcp.json --yes    every server in a client config
 *
 * --config starts commands written in a file, which may not be yours (a
 * cloned repo's .mcp.json). It lists them and refuses to run without --yes.
 */

export interface McpOptions {
  url?: string;
  header?: string[];
  config?: string;
  server?: string;
  yes?: boolean;
  timeout?: string;
  format?: string;
  failOn?: string;
  verbose?: boolean;
}

interface Target {
  name: string;
  /** ScanResult.source: "mcp:<name>" or the URL. */
  source: string;
  /** What will run, for the --config confirmation. */
  describe: string;
  stdio?: StdioServer;
  url?: string;
  headers?: Record<string, string>;
  /** Config entry we cannot scan (e.g. the deprecated SSE transport). */
  unsupported?: string;
}

class UsageError extends Error {}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const commandLine = (s: StdioServer) => [s.command, ...(s.args ?? [])].map(shellQuote).join(" ");

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in .mcp.json. */
function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? "",
  );
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = expandEnv(v);
  return out;
}

function parseHeaders(list: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list) {
    const i = h.indexOf(":");
    if (i <= 0) throw new UsageError(`invalid --header "${h}" (expected "Name: value")`);
    out[h.slice(0, i).trim()] = expandEnv(h.slice(i + 1).trim());
  }
  return out;
}

function checkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`invalid URL "${url}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new UsageError(`only http(s) URLs are supported: "${url}"`);
}

/** Read `mcpServers` (Claude, Cursor, Windsurf) or `servers` (VS Code) from a client config. */
function configTargets(path: string, only?: string): Target[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UsageError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const root = (raw ?? {}) as Record<string, unknown>;
  const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers))
    throw new UsageError(`${path} has no "mcpServers" object`);

  const targets: Target[] = [];
  for (const [name, def] of Object.entries(servers)) {
    if (only && name !== only) continue;
    const d = (def ?? {}) as Record<string, unknown>;
    const source = `mcp:${name}`;
    if (typeof d.command === "string") {
      const stdio: StdioServer = {
        command: expandEnv(d.command),
        args: Array.isArray(d.args) ? d.args.filter((a) => typeof a === "string").map(expandEnv) : [],
        env: stringMap(d.env),
        cwd: typeof d.cwd === "string" ? resolve(expandEnv(d.cwd)) : undefined,
      };
      targets.push({ name, source, describe: commandLine(stdio), stdio });
    } else if (typeof d.url === "string") {
      const url = expandEnv(d.url);
      if (d.type === "sse")
        targets.push({ name, source, describe: `GET ${url}`, unsupported: "the deprecated SSE transport" });
      else targets.push({ name, source, describe: `POST ${url}`, url, headers: stringMap(d.headers) });
    } else {
      targets.push({
        name,
        source,
        describe: "(no command or url)",
        unsupported: "an entry without command or url",
      });
    }
  }
  if (only && !targets.length) {
    const names = Object.keys(servers).join(", ") || "none";
    throw new UsageError(`no server named "${only}" in ${path} (found: ${names})`);
  }
  return targets;
}

function resolveTargets(command: string[], options: McpOptions): Target[] {
  const modes = [command.length > 0, !!options.url, !!options.config].filter(Boolean).length;
  if (modes === 0)
    throw new UsageError(
      "nothing to scan: use `wysiwyg mcp -- <command> [args...]`, `--url <url>` or `--config <file>`",
    );
  if (modes > 1) throw new UsageError("use only one of: a command after --, --url, --config");
  if (options.server && !options.config) throw new UsageError("--server only applies with --config");
  if (options.header?.length && !options.url) throw new UsageError("--header only applies with --url");

  if (options.config) return configTargets(options.config, options.server);
  if (options.url) {
    checkUrl(options.url);
    const headers = parseHeaders(options.header);
    return [
      { name: options.url, source: options.url, describe: `POST ${options.url}`, url: options.url, headers },
    ];
  }
  const stdio = { command: command[0], args: command.slice(1) };
  return [{ name: command[0], source: `mcp:${commandLine(stdio)}`, describe: commandLine(stdio), stdio }];
}

function summary(name: string, r: ListResult): string {
  const n = (k: keyof McpCatalog) => (Array.isArray(r.catalog[k]) ? (r.catalog[k] as unknown[]).length : 0);
  const parts = [
    `${n("tools")} tools`,
    `${n("prompts")} prompts`,
    `${n("resources") + n("resourceTemplates")} resources`,
  ];
  return `${visualize(name)}: ${parts.join(", ")} (MCP ${r.protocolVersion})`;
}

export async function mcpCommand(command: string[], options: McpOptions): Promise<void> {
  const format = (options.format || "pretty") as OutputFormat;
  const failOn = (options.failOn || "critical") as Severity;
  const timeoutMs = Number(options.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(`Error: invalid --timeout "${options.timeout}"`);
    process.exit(2);
  }

  let targets: Target[];
  try {
    targets = resolveTargets(command, options);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (options.config) {
    const pad = Math.max(...targets.map((t) => t.name.length), 4) + 2;
    console.error(`wysiwyg mcp will start these MCP servers from ${options.config}:`);
    for (const t of targets) console.error(`  ${visualize(t.name).padEnd(pad)}${visualize(t.describe)}`);
    if (!options.yes) {
      console.error("These commands come from a file. Review them, then re-run with --yes to scan.");
      process.exit(2);
    }
  }

  const scanned: { name: string; source: string; catalog: McpCatalog }[] = [];
  let failed = 0;
  for (const t of targets) {
    if (t.unsupported) {
      console.error(`Skipped ${visualize(t.name)}: ${t.unsupported} is not supported`);
      failed++;
      continue;
    }
    try {
      const listed = t.url
        ? await listHttpServer(t.url, { timeoutMs, headers: t.headers })
        : await listStdioServer(t.stdio!, { timeoutMs });
      if (format === "pretty") console.error(summary(t.name, listed));
      for (const note of listed.notes) console.error(`  note: ${visualize(note)}`);
      scanned.push({ name: t.name, source: t.source, catalog: listed.catalog });
    } catch (err) {
      failed++;
      console.error(
        `Error: ${visualize(t.name)}: ${visualize(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }
  if (!scanned.length) process.exit(2);

  try {
    const sources = new Map(scanned.map((s) => [s.name, s.source]));
    const results: ScanResult[] = scanMcpServers(scanned).map(({ name, findings }) => ({
      source: sources.get(name) ?? name,
      findings,
      clean: isClean(findings),
    }));
    await writeOut(formatFindings(results, format, { verbose: options.verbose }));
    // exitCode, not exit(): exiting immediately can truncate large output on a pipe
    if (failed) process.exitCode = 2;
    else if (
      meetsThreshold(
        results.flatMap((r) => r.findings),
        failOn,
      )
    )
      process.exitCode = 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
