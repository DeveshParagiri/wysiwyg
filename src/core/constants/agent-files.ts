/**
 * Files that AI coding agents load as instructions or tool configuration.
 *
 * Concealed content here is executed rather than merely read, so findings
 * are raised, these paths can never be excluded by ignore patterns, and they
 * get a visible injection-phrase check on top of the concealment layers.
 */

/** Basenames that are instruction files wherever they appear. */
const BASENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENT.md",
  "GEMINI.md",
  "QWEN.md",
  "CONVENTIONS.md",
  "SKILL.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".roorules",
  ".goosehints",
  ".rules",
  "copilot-instructions.md",
  ".copilot-codegeneration-instructions.md",
  // Tool / MCP configuration
  ".mcp.json",
  "mcp.json",
  ".mcprc",
  "opencode.json",
]);

/** Directory prefixes (matched as path segments) whose files are instructions. */
const DIRS = [
  ".claude/commands",
  ".claude/agents",
  ".claude/skills",
  ".claude/output-styles",
  ".claude/rules",
  ".cursor/rules",
  ".windsurf/rules",
  ".windsurf/workflows",
  ".clinerules",
  ".roo",
  ".github/instructions",
  ".github/prompts",
  ".github/chatmodes",
  ".github/agents",
  ".kiro/steering",
  ".amazonq/rules",
  ".augment",
  ".continue",
  ".junie",
  ".gemini",
  ".codex",
  ".opencode",
  ".agents",
  ".trae/rules",
  ".qwen",
  ".zed/rules",
];

/** Exact relative paths. */
const PATHS = new Set([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
]);

/** Copilot-style suffixes: *.prompt.md, *.instructions.md, *.chatmode.md, *.agent.md */
const SUFFIXES = [".prompt.md", ".instructions.md", ".chatmode.md", ".agent.md", ".mdc"];

export function isAgentInstructionFile(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (BASENAMES.has(base)) return true;
  if (SUFFIXES.some((s) => base.endsWith(s))) return true;
  for (const exact of PATHS) {
    if (p === exact || p.endsWith(`/${exact}`)) return true;
  }
  for (const dir of DIRS) {
    if (p.startsWith(`${dir}/`) || p.includes(`/${dir}/`)) return true;
  }
  return false;
}

/** Back-compat alias for the v0.1 API. */
export const isKnownConfigFile = isAgentInstructionFile;
