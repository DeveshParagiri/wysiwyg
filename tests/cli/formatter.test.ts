import { describe, test, expect } from "bun:test";
import {
  formatFindings,
  formatBox,
  formatDiff,
  formatSummary,
  formatJSON,
} from "../../src/cli/output/formatter.js";
import type { ScanResult } from "../../src/core/types.js";

describe("formatBox", () => {
  test("renders a box with title and content", () => {
    const box = formatBox("Test Title", ["Line 1", "Line 2"]);
    expect(box).toContain("┌");
    expect(box).toContain("┘");
    expect(box).toContain("Test Title");
    expect(box).toContain("Line 1");
    expect(box).toContain("Line 2");
  });

  test("renders with single line", () => {
    const box = formatBox("Title", ["Content"]);
    expect(box).toContain("Title");
    expect(box).toContain("Content");
  });
});

describe("formatDiff", () => {
  test("highlights added content", () => {
    const result = formatDiff("Hello world", "Hello world hidden text");
    expect(result).toContain("hidden text");
  });

  test("returns original for identical strings", () => {
    const result = formatDiff("same text", "same text");
    expect(result).toBe("same text");
  });
});

describe("formatJSON", () => {
  test("produces valid JSON with correct schema", () => {
    const results: ScanResult[] = [
      {
        source: "test.txt",
        clean: false,
        findings: [
          {
            type: "unicode_tags",
            severity: "critical",
            line: 1,
            message: "Test finding",
            humanView: "visible",
            agentView: "visible + hidden",
          },
        ],
      },
    ];

    const json = formatJSON(results);
    const parsed = JSON.parse(json);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].source).toBe("test.txt");
    expect(parsed.results[0].clean).toBe(false);
    expect(parsed.results[0].findings).toHaveLength(1);
    expect(parsed.summary.totalFindings).toBe(1);
    expect(parsed.summary.critical).toBe(1);
    expect(parsed.summary.warning).toBe(0);
    expect(parsed.summary.info).toBe(0);
  });

  test("produces correct summary for multiple results", () => {
    const results: ScanResult[] = [
      { source: "clean.txt", clean: true, findings: [] },
      {
        source: "dirty.txt",
        clean: false,
        findings: [
          {
            type: "zero_width",
            severity: "warning",
            message: "test",
            humanView: "",
            agentView: "",
          },
          {
            type: "bidi_override",
            severity: "critical",
            message: "test",
            humanView: "",
            agentView: "",
          },
        ],
      },
    ];

    const json = formatJSON(results);
    const parsed = JSON.parse(json);
    expect(parsed.summary.filesScanned).toBe(2);
    expect(parsed.summary.filesClean).toBe(1);
    expect(parsed.summary.totalFindings).toBe(2);
    expect(parsed.summary.critical).toBe(1);
    expect(parsed.summary.warning).toBe(1);
  });
});

describe("formatSummary", () => {
  test("shows file count", () => {
    const results: ScanResult[] = [
      { source: "a.txt", clean: true, findings: [] },
      { source: "b.txt", clean: true, findings: [] },
    ];
    const summary = formatSummary(results);
    expect(summary).toContain("0/2");
  });

  test("shows dirty files", () => {
    const results: ScanResult[] = [
      {
        source: "dirty.txt",
        clean: false,
        findings: [
          {
            type: "unicode_tags",
            severity: "critical",
            message: "test",
            humanView: "",
            agentView: "",
          },
        ],
      },
      { source: "clean.txt", clean: true, findings: [] },
    ];
    const summary = formatSummary(results);
    expect(summary).toContain("dirty.txt");
    expect(summary).toContain("1 critical");
  });
});

describe("formatFindings", () => {
  test("shows clean message for no findings", () => {
    const results: ScanResult[] = [
      { source: "clean.txt", clean: true, findings: [] },
    ];
    const output = formatFindings(results, "pretty");
    expect(output).toContain("No hidden content detected");
  });

  test("shows findings in pretty format", () => {
    const results: ScanResult[] = [
      {
        source: "test.txt",
        clean: false,
        findings: [
          {
            type: "unicode_tags",
            severity: "critical",
            line: 5,
            message: "Hidden Unicode Tags",
            humanView: "visible text",
            agentView: "visible text + hidden",
          },
        ],
      },
    ];
    const output = formatFindings(results, "pretty");
    expect(output).toContain("test.txt");
    expect(output).toContain("Hidden Unicode Tags");
  });

  test("outputs valid JSON in json format", () => {
    const results: ScanResult[] = [
      { source: "test.txt", clean: true, findings: [] },
    ];
    const output = formatFindings(results, "json");
    const parsed = JSON.parse(output);
    expect(parsed.results).toBeDefined();
    expect(parsed.summary).toBeDefined();
  });

  test("shows no files message when empty", () => {
    const output = formatFindings([], "pretty");
    expect(output).toContain("No files to scan");
  });
});
