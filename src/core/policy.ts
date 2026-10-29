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
  /**
   * Text that describes something the reader can see (alt text, a tooltip, an
   * aria label). Not raised just because it sits in an agent instruction file.
   */
  describesVisible?: boolean;
}

/** Build a Finding for concealed content, deriving intent and severity. */
/**
 * Replace lone surrogates (from truncating text mid-emoji) with U+FFFD, so
 * findings serialize to JSON that every parser accepts.
 */
export function wellFormed(s: string): string;
export function wellFormed(s: string | undefined): string | undefined;
export function wellFormed(s: string | undefined): string | undefined {
  return s?.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Build a Finding for concealed content, deriving intent and severity. */
export function concealedFinding(input: ConcealedInput): Finding {
  const hidden = wellFormed(input.hiddenText.replace(/\s+/g, " ").trim());
  const intent = classifyIntent(hidden);
  // A shell command in a comment or collapsed section is documentation; it only
  // counts as an instruction to the agent when the text is actually hidden.
  const level =
    intent.level === "instruction" && intent.kind === "command" && input.concealment === "channel"
      ? "prose"
      : intent.level;
  const severity = severityFor(input.concealment, level, {
    instructionFile: input.instructionFile && !input.describesVisible,
  });
  const preview =
    hidden.length > PREVIEW_SHORT ? `${[...hidden].slice(0, PREVIEW_SHORT - 1).join("")}…` : hidden;
  const why = level === "instruction" ? ` — agent-directed ("${intent.match}")` : "";
  return {
    ruleId: input.ruleId,
    type: input.type,
    severity,
    line: input.line,
    column: input.column,
    offset: input.offset,
    location: wellFormed(input.location),
    message: wellFormed(`${input.technique}: "${preview}"${why}`),
    hiddenText: hidden,
    intent: level,
    technique: wellFormed(input.technique),
    trigger: level === "instruction" ? intent.match : undefined,
    humanView: wellFormed(input.humanView ?? ""),
    agentView: wellFormed(input.agentView ?? hidden),
    detail: wellFormed(input.detail),
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
