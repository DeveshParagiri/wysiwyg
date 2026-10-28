import { relative } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import type { ScanResult, Severity } from "../../core/types.js";

/**
 * SARIF 2.1.0 output for GitHub code scanning and other SARIF consumers.
 * Every finding becomes a result; rules are derived from the ruleIds seen.
 */

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  warning: "warning",
  info: "note",
};

export function formatSARIF(results: ScanResult[], cwd = process.cwd()): string {
  const rules = new Map<string, { id: string; shortDescription: { text: string } }>();
  const sarifResults = results.flatMap((r) =>
    r.findings.map((f) => {
      if (!rules.has(f.ruleId)) rules.set(f.ruleId, { id: f.ruleId, shortDescription: { text: f.ruleId } });
      const uri = /^(stdin|clipboard|https?:)/.test(r.source)
        ? r.source
        : relative(cwd, r.source).split("\\").join("/");
      return {
        ruleId: f.ruleId,
        level: LEVEL[f.severity],
        message: {
          text:
            f.message +
            (f.hiddenText && !f.message.includes(f.hiddenText) ? `\nHidden text: ${f.hiddenText}` : ""),
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri },
              ...(f.line
                ? { region: { startLine: f.line, ...(f.column ? { startColumn: f.column } : {}) } }
                : {}),
            },
            ...(f.location ? { message: { text: f.location } } : {}),
          },
        ],
        properties: { severity: f.severity, type: f.type, ...(f.intent ? { intent: f.intent } : {}) },
      };
    }),
  );
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "wysiwyg",
              version: pkg.version,
              informationUri: "https://github.com/DeveshParagiri/wysiwyg",
              rules: [...rules.values()],
            },
          },
          results: sarifResults,
        },
      ],
    },
    null,
    2,
  );
}
