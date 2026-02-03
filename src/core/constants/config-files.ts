/** Known AI agent config files */
export const KNOWN_CONFIG_FILES = [
  ".cursorrules",
  ".github/copilot-instructions.md",
  ".copilot-codegeneration-instructions.md",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/commands/**",
  "mcp.json",
  ".mcprc",
  ".windsurfrules",
  "AGENTS.md",
] as const;

/** Prompt injection indicator patterns */
export const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+(instructions|rules|guidelines)/i,
  /disregard\s+(previous|above|all)/i,
  /forget\s+(your|previous|all)\s+(instructions|rules)/i,
  /you\s+are\s+now/i,
  /new\s+instructions/i,
  /system\s*prompt/i,
  /do\s+not\s+(reveal|mention|tell|disclose)/i,
  /override\s+(previous|system)/i,
  /act\s+as\s+(if|though)/i,
  /pretend\s+(you|to\s+be)/i,
] as const;
