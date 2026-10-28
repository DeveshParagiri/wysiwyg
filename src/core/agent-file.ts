import { LineIndex, visualize } from "./text/lines.js";
import type { Finding } from "./types.js";

/**
 * Visible injection phrases in agent instruction files.
 *
 * Everything else in wysiwyg is about the perception gap; this check is the
 * one exception, kept deliberately narrow. Instruction files legitimately say
 * things like "you are working on…" or "do not reveal secrets in logs", so
 * only phrases with no place in a legitimate rules file are matched.
 */
const PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|any|system)\b[^.\n]{0,20}\b(instructions?|rules|guidelines|prompts?)\b/i,
  /\b(do not|don't|never)\s+(tell|inform|mention|alert|notify)\b[^.\n]{0,30}\bthe (user|human|developer)\b/i,
  /\bwithout\s+(telling|informing|notifying|alerting)\s+the (user|human|developer)\b/i,
  /\b(curl|wget|iwr)\b[^\n]{0,160}\|\s*(ba|z|da)?sh\b/i,
  /\b(send|post|upload|exfiltrate|transmit)\b[^.\n]{0,60}\b(\.env|ssh keys?|id_rsa|credentials|api[ _-]?keys?|private keys?)\b[^.\n]{0,40}\b(to|https?:)/i,
];

export function scanVisibleInjection(content: string): Finding[] {
  const idx = new LineIndex(content);
  const findings: Finding[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(content);
    if (!m) continue;
    const line = idx.lineOf(m.index);
    findings.push({
      ruleId: "agent-file/injection-phrase",
      type: "config_injection",
      severity: "warning",
      line,
      offset: m.index,
      message: `Injection phrase in an agent instruction file: "${m[0].trim()}"`,
      humanView: visualize(idx.line(line)),
      agentView: visualize(idx.line(line)),
      detail: "Visible text; review whether this instruction belongs in the file.",
    });
  }
  return findings;
}
