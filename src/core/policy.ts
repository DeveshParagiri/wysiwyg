import { PREVIEW_SHORT } from "./constants/index.js";
import { classifyIntent } from "./intent.js";
import type { Concealment, Finding, FindingType, IntentLevel, Severity } from "./types.js";

/**
 * Severity = how it is concealed × what is concealed.
 *
 *                 instruction   prose     trivial
 *   smuggling     critical      critical  critical
 *   hidden        critical      warning   info
 *   channel       critical      info      info
 *   evasion       warning       warning   warning
 *
 * In agent instruction files (CLAUDE.md, rules, skills…) every line is
 * executed by an agent, so concealed prose in a channel is raised to warning.
 */
export function severityFor(
  concealment: Concealment,
  intent: IntentLevel,
  opts: { instructionFile?: boolean } = {},
): Severity {
  if (concealment === "smuggling") return "critical";
  if (concealment === "evasion") return "warning";
  if (intent === "instruction") return "critical";
  if (concealment === "hidden") return intent === "prose" ? "warning" : "info";
  // channel
  if (intent === "prose" && opts.instructionFile) return "warning";
  return "info";
}

export interface ConcealedInput {
  ruleId: string;
  type: FindingType;
  concealment: Concealment;
  /** Short description of the technique, e.g. "display:none (via .note)". */
  technique: string;
  /** The concealed text as the model would read it. */
  hiddenText: string;
  line?: number;
  column?: number;
  offset?: number;
  location?: string;
  humanView?: string;
  agentView?: string;
  detail?: string;
  instructionFile?: boolean;
}

/** Build a Finding for concealed content, deriving intent and severity. */
export function concealedFinding(input: ConcealedInput): Finding {
  const hidden = input.hiddenText.replace(/\s+/g, " ").trim();
  const intent = classifyIntent(hidden);
  const severity = severityFor(input.concealment, intent.level, {
    instructionFile: input.instructionFile,
  });
  const preview = hidden.length > PREVIEW_SHORT ? `${hidden.slice(0, PREVIEW_SHORT - 1)}…` : hidden;
  const why = intent.level === "instruction" ? ` — agent-directed ("${intent.match}")` : "";
  return {
    ruleId: input.ruleId,
    type: input.type,
    severity,
    line: input.line,
    column: input.column,
    offset: input.offset,
    location: input.location,
    message: `${input.technique}: "${preview}"${why}`,
    hiddenText: hidden,
    intent: intent.level,
    humanView: input.humanView ?? "",
    agentView: input.agentView ?? hidden,
    detail: input.detail,
  };
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

export function meetsThreshold(findings: Finding[], threshold: Severity): boolean {
  return findings.some((f) => RANK[f.severity] >= RANK[threshold]);
}

/** A result is clean when nothing reaches warning. Info findings are context, not alarms. */
export function isClean(findings: Finding[]): boolean {
  return !meetsThreshold(findings, "warning");
}
