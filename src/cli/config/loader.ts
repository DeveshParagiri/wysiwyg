import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import type { WysiwygConfig } from "../../core/types.js";
import { DEFAULT_CONFIG } from "../../core/constants/index.js";

const CONFIG_FILENAME = ".wysiwygrc";

/**
 * Find a .wysiwygrc config file by walking up from startDir.
 */
export function findConfigFile(startDir: string): string | null {
  let dir = startDir;

  while (true) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  // Check home directory
  const homeConfig = join(homedir(), CONFIG_FILENAME);
  if (existsSync(homeConfig)) {
    return homeConfig;
  }

  return null;
}

/**
 * Validate and type-check a raw config object.
 */
export function validateConfig(raw: unknown): WysiwygConfig {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const config: WysiwygConfig = {};

  if (Array.isArray(obj.expected_scripts)) {
    config.expected_scripts = obj.expected_scripts.filter(
      (s): s is string => typeof s === "string",
    );
  }

  if (Array.isArray(obj.ignore)) {
    config.ignore = obj.ignore.filter(
      (s): s is string => typeof s === "string",
    );
  }

  if (
    obj.fail_on === "critical" ||
    obj.fail_on === "warning" ||
    obj.fail_on === "info"
  ) {
    config.fail_on = obj.fail_on;
  }

  return config;
}

/**
 * Merge a base config with overrides.
 */
export function mergeConfig(
  base: Required<WysiwygConfig>,
  override: WysiwygConfig,
): Required<WysiwygConfig> {
  return {
    expected_scripts:
      override.expected_scripts ?? base.expected_scripts,
    ignore: override.ignore ?? base.ignore,
    fail_on: override.fail_on ?? base.fail_on,
  };
}

/**
 * Load config from .wysiwygrc, merging with defaults.
 */
export function loadConfig(startDir?: string): Required<WysiwygConfig> {
  const dir = startDir ?? process.cwd();
  const configPath = findConfigFile(dir);

  if (!configPath) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw);
    const validated = validateConfig(parsed);
    return mergeConfig({ ...DEFAULT_CONFIG }, validated);
  } catch (err) {
    console.warn(`Warning: Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}. Using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}
