import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { isAgentInstructionFile } from "../../core/constants/agent-files.js";
import { DEFAULT_CONFIG } from "../../core/constants/index.js";
import type { Finding, WysiwygConfig } from "../../core/types.js";
import { matchesIgnorePattern } from "../platform/fs.js";

const CONFIG_FILENAME = ".wysiwygrc";

/**
 * Config trust model.
 *
 * A .wysiwygrc inside the scanned tree is written by whoever controls that
 * tree — in CI, possibly the attacker. It may narrow what is scanned only in
 * limited ways: patterns that match everything are refused, and agent
 * instruction files are always scanned regardless of ignore patterns. A
 * config given with --config or found in the home directory is trusted.
 */
export interface LoadedConfig {
  config: Required<WysiwygConfig>;
  path: string | null;
  trusted: boolean;
  /** Problems with the config itself, reported like any other finding. */
  findings: Finding[];
}

/** Find a .wysiwygrc by walking up from startDir; falls back to ~/.wysiwygrc. */
export function findConfigFile(startDir: string): { path: string; trusted: boolean } | null {
  let dir = resolve(startDir);
  const home = homedir();
  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return { path: candidate, trusted: dir === home };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const homeConfig = join(home, CONFIG_FILENAME);
  return existsSync(homeConfig) ? { path: homeConfig, trusted: true } : null;
}

/** Validate and type-check a raw config object. */
export function validateConfig(raw: unknown): WysiwygConfig {
  if (typeof raw !== "object" || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const config: WysiwygConfig = {};
  if (Array.isArray(obj.expected_scripts)) {
    config.expected_scripts = obj.expected_scripts.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(obj.ignore)) {
    config.ignore = obj.ignore.filter((s): s is string => typeof s === "string");
  }
  if (obj.fail_on === "critical" || obj.fail_on === "warning" || obj.fail_on === "info") {
    config.fail_on = obj.fail_on;
  }
  return config;
}

/** Merge a base config with overrides. */
export function mergeConfig(base: Required<WysiwygConfig>, override: WysiwygConfig): Required<WysiwygConfig> {
  return {
    expected_scripts: override.expected_scripts ?? base.expected_scripts,
    ignore: override.ignore ?? base.ignore,
    fail_on: override.fail_on ?? base.fail_on,
  };
}

/** Ignore patterns from an untrusted config that would hide everything or an agent file. */
function overbroad(pattern: string): boolean {
  if (matchesIgnorePattern("any/file.txt", [pattern]) && matchesIgnorePattern("README.md", [pattern]))
    return true;
  const probes = [
    "CLAUDE.md",
    "AGENTS.md",
    ".cursorrules",
    ".claude/skills/x/SKILL.md",
    ".cursor/rules/x.mdc",
  ];
  return probes.some((p) => isAgentInstructionFile(p) && matchesIgnorePattern(p, [pattern]));
}

export function loadConfig(startDir?: string, explicitPath?: string): LoadedConfig {
  const found = explicitPath
    ? { path: resolve(explicitPath), trusted: true }
    : findConfigFile(startDir ?? process.cwd());
  if (!found) return { config: { ...DEFAULT_CONFIG }, path: null, trusted: true, findings: [] };

  const findings: Finding[] = [];
  let validated: WysiwygConfig;
  try {
    validated = validateConfig(YAML.parse(readFileSync(found.path, "utf-8")));
  } catch (err) {
    if (explicitPath) throw err;
    findings.push({
      ruleId: "config/parse-error",
      type: "scanner_evasion",
      severity: "warning",
      message: `Could not parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)} — using defaults`,
      humanView: "",
      agentView: "",
    });
    return { config: { ...DEFAULT_CONFIG }, path: found.path, trusted: found.trusted, findings };
  }

  if (!found.trusted && validated.ignore) {
    const refused = validated.ignore.filter(overbroad);
    if (refused.length) {
      validated.ignore = validated.ignore.filter((p) => !refused.includes(p));
      findings.push({
        ruleId: "config/overbroad-ignore",
        type: "scanner_evasion",
        severity: "warning",
        message: `${CONFIG_FILENAME} in the scanned tree tries to ignore everything or agent instruction files (${refused.map((p) => JSON.stringify(p)).join(", ")}) — patterns refused`,
        humanView: "",
        agentView: "",
        detail: "Use --config to supply a trusted configuration, or --no-config in CI.",
      });
    }
  }
  return {
    config: mergeConfig({ ...DEFAULT_CONFIG }, validated),
    path: found.path,
    trusted: found.trusted,
    findings,
  };
}
