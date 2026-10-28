import { describe, expect, test } from "bun:test";
import type { Concealment, Finding, IntentLevel, Severity } from "../../src/core/index.js";
import { concealedFinding, isClean, meetsThreshold, severityFor } from "../../src/core/index.js";
import { NEUTRAL, PAYLOAD } from "../redteam/cases.js";

describe("severityFor: concealment × intent", () => {
  const table: [Concealment, IntentLevel, Severity][] = [
    ["smuggling", "instruction", "critical"],
    ["smuggling", "prose", "critical"],
    ["smuggling", "trivial", "critical"],
    ["hidden", "instruction", "critical"],
    ["hidden", "prose", "warning"],
    ["hidden", "trivial", "info"],
    ["channel", "instruction", "critical"],
    ["channel", "prose", "info"],
    ["channel", "trivial", "info"],
    ["evasion", "instruction", "warning"],
    ["evasion", "prose", "warning"],
    ["evasion", "trivial", "warning"],
  ];
  for (const [concealment, intent, expected] of table) {
    test(`${concealment} × ${intent} → ${expected}`, () => {
      expect(severityFor(concealment, intent)).toBe(expected);
    });
  }

  test("channel prose in an agent instruction file is raised to warning", () => {
    expect(severityFor("channel", "prose", { instructionFile: true })).toBe("warning");
  });

  test("instruction files do not raise trivial channel content", () => {
    expect(severityFor("channel", "trivial", { instructionFile: true })).toBe("info");
  });

  test("instruction files do not change the other rows", () => {
    expect(severityFor("hidden", "prose", { instructionFile: true })).toBe("warning");
    expect(severityFor("hidden", "trivial", { instructionFile: true })).toBe("info");
    expect(severityFor("smuggling", "trivial", { instructionFile: true })).toBe("critical");
  });
});

describe("concealedFinding", () => {
  test("derives intent and severity from the hidden text", () => {
    const f = concealedFinding({
      ruleId: "test/x",
      type: "hidden_rendered",
      concealment: "hidden",
      technique: "display:none",
      hiddenText: PAYLOAD,
    });
    expect(f.intent).toBe("instruction");
    expect(f.severity).toBe("critical");
    expect(f.message).toContain("display:none");
    expect(f.message).toContain("agent-directed");
    expect(f.ruleId).toBe("test/x");
  });

  test("normalises whitespace in hidden text", () => {
    const f = concealedFinding({
      ruleId: "test/x",
      type: "hidden_rendered",
      concealment: "hidden",
      technique: "t",
      hiddenText: `  ${NEUTRAL.replace(/ /g, "\n\n  ")}  `,
    });
    expect(f.hiddenText).toBe(NEUTRAL);
    expect(f.intent).toBe("prose");
    expect(f.severity).toBe("warning");
  });

  test("truncates long hidden text in the message, not in hiddenText", () => {
    const long = NEUTRAL.repeat(5);
    const f = concealedFinding({
      ruleId: "t",
      type: "encoded",
      concealment: "channel",
      technique: "t",
      hiddenText: long,
    });
    expect(f.message.length).toBeLessThan(long.length);
    expect(f.message).toContain("…");
    expect(f.hiddenText).toBe(long);
  });

  test("agentView defaults to the hidden text", () => {
    const f = concealedFinding({
      ruleId: "t",
      type: "encoded",
      concealment: "channel",
      technique: "t",
      hiddenText: "abc",
    });
    expect(f.agentView).toBe("abc");
    expect(f.humanView).toBe("");
  });

  test("passes instructionFile through to severity", () => {
    const base = {
      ruleId: "t",
      type: "html_comment" as const,
      concealment: "channel" as const,
      technique: "c",
      hiddenText: NEUTRAL,
    };
    expect(concealedFinding(base).severity).toBe("info");
    expect(concealedFinding({ ...base, instructionFile: true }).severity).toBe("warning");
  });
});

describe("thresholds", () => {
  const f = (severity: Severity): Finding => ({
    ruleId: "t",
    type: "encoded",
    severity,
    message: "",
    humanView: "",
    agentView: "",
  });

  test("meetsThreshold compares by rank", () => {
    expect(meetsThreshold([f("warning")], "critical")).toBe(false);
    expect(meetsThreshold([f("warning")], "warning")).toBe(true);
    expect(meetsThreshold([f("critical")], "info")).toBe(true);
    expect(meetsThreshold([f("info")], "info")).toBe(true);
    expect(meetsThreshold([], "info")).toBe(false);
  });

  test("isClean ignores info findings", () => {
    expect(isClean([])).toBe(true);
    expect(isClean([f("info"), f("info")])).toBe(true);
    expect(isClean([f("info"), f("warning")])).toBe(false);
    expect(isClean([f("critical")])).toBe(false);
  });
});
