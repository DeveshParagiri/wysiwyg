import { describe, expect, test } from "bun:test";
import { formatFindings, formatJSON, formatSummary } from "../../src/cli/output/formatter.js";
import { formatSARIF } from "../../src/cli/output/sarif.js";
import type { Finding, ScanResult, Severity } from "../../src/core/types.js";

const finding = (severity: Severity, extra: Partial<Finding> = {}): Finding => ({
  ruleId: `test/${severity}`,
  type: "hidden_rendered",
  severity,
  line: 3,
  message: `${severity} finding`,
  humanView: "",
  agentView: "",
  ...extra,
});
const result = (source: string, findings: Finding[]): ScanResult => ({
  source,
  findings,
  clean: !findings.some((f) => f.severity !== "info"),
});
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatJSON", () => {
  test("schema and summary", () => {
    const parsed = JSON.parse(
      formatJSON([
        result("clean.txt", []),
        result("dirty.txt", [finding("critical"), finding("warning"), finding("info")]),
      ]),
    );
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[1]).toMatchObject({ source: "dirty.txt", clean: false });
    expect(parsed.results[1].findings).toHaveLength(3);
    expect(parsed.results[1].findings[0].ruleId).toBe("test/critical");
    expect(parsed.summary).toEqual({
      filesScanned: 2,
      filesClean: 1,
      totalFindings: 3,
      critical: 1,
      warning: 1,
      info: 1,
    });
  });

  test("formatFindings json matches formatJSON", () => {
    const rs = [result("a.txt", [finding("warning")])];
    expect(formatFindings(rs, "json")).toBe(formatJSON(rs));
  });
});

describe("formatSummary", () => {
  test("counts dirty files", () => {
    expect(stripSgr(formatSummary([result("a.txt", []), result("b.txt", [])]))).toContain("0 of 2 files");
  });

  test("totals only, when few files have findings", () => {
    const s = stripSgr(
      formatSummary([result("dirty.txt", [finding("critical"), finding("info")]), result("clean.txt", [])], {
        cwd: "/",
      }),
    );
    expect(s).toContain("1 of 2 files");
    expect(s).toContain("1 critical");
    expect(s).toContain("1 info");
    expect(s).not.toContain("dirty.txt");
  });

  test("recaps each dirty file when there are many", () => {
    const dirty = ["a", "b", "c", "d"].map((n) => result(`${n}.txt`, [finding("warning")]));
    const s = stripSgr(formatSummary([...dirty, result("clean.txt", [])], { cwd: "/" }));
    expect(s).toContain("4 of 5 files");
    for (const n of ["a", "b", "c", "d"]) expect(s).toContain(`${n}.txt`);
    expect(s).not.toContain("clean.txt");
  });
});

describe("formatFindings: pretty", () => {
  test("no results", () => {
    expect(stripSgr(formatFindings([], "pretty"))).toContain("No files to scan");
  });

  test("clean result", () => {
    expect(stripSgr(formatFindings([result("clean.txt", [])], "pretty"))).toContain(
      "No hidden content detected",
    );
  });

  test("clean across many files mentions the count", () => {
    const out = stripSgr(formatFindings([result("a", []), result("b", []), result("c", [])], "pretty"));
    expect(out).toContain("3 files");
  });

  test("single file shows severity, line, message and rule", () => {
    const out = stripSgr(
      formatFindings(
        [result("test.txt", [finding("critical", { line: 5, message: "Hidden Unicode Tags" })])],
        "pretty",
        { cwd: "/" },
      ),
    );
    expect(out).toContain("test.txt");
    expect(out).toContain("CRITICAL");
    expect(out).toContain("line 5");
    expect(out).toContain("Hidden Unicode Tags");
    expect(out).toContain("test/critical");
  });

  test("location is shown when there is no line", () => {
    const out = stripSgr(
      formatFindings(
        [result("deck.pptx", [finding("warning", { line: undefined, location: "slide 3" })])],
        "pretty",
      ),
    );
    expect(out).toContain("slide 3");
  });

  test("findings are sorted by severity", () => {
    const out = stripSgr(
      formatFindings([result("a.txt", [finding("warning"), finding("critical")])], "pretty"),
    );
    expect(out.indexOf("CRITICAL")).toBeLessThan(out.indexOf("WARNING"));
  });

  test("info findings are hidden unless verbose", () => {
    const rs = [result("a.md", [finding("info", { message: "an info note" })])];
    const quiet = stripSgr(formatFindings(rs, "pretty"));
    expect(quiet).toContain("No hidden content detected");
    expect(quiet).toContain("1 info hidden (--verbose)");
    expect(quiet).not.toContain("an info note");
    const verbose = stripSgr(formatFindings(rs, "pretty", { verbose: true }));
    expect(verbose).toContain("INFO");
    expect(verbose).toContain("an info note");
  });

  test("multiple files end with a summary", () => {
    const out = stripSgr(
      formatFindings(
        [result("a.txt", [finding("critical")]), result("b.txt", []), result("c.txt", [finding("warning")])],
        "pretty",
        { cwd: "/" },
      ),
    );
    expect(out).toContain("2 of 3 files");
    expect(out).toContain("a.txt");
    expect(out).toContain("c.txt");
  });

  test("H/A diff shows what each side sees", () => {
    const out = stripSgr(
      formatFindings(
        [
          result("a.html", [
            finding("warning", { humanView: "Hello world", agentView: "Hello world SECRET" }),
          ]),
        ],
        "pretty",
      ),
    );
    expect(out).toMatch(/you see\s+Hello world\n/);
    // the agent-only text is highlighted (⟦…⟧ when colour is off)
    expect(out).toMatch(/AI reads\s+Hello world ⟦?SECRET/);
  });

  test("paths are shown relative to cwd", () => {
    const out = stripSgr(
      formatFindings([result("/repo/src/a.txt", [finding("critical")])], "pretty", { cwd: "/repo" }),
    );
    expect(out).toContain("src/a.txt");
    expect(out).not.toContain("/repo/src");
  });

  test("URLs, stdin and clipboard sources are shown as-is", () => {
    const out = stripSgr(
      formatFindings([result("https://x.example/p", [finding("critical")])], "pretty", { cwd: "/repo" }),
    );
    expect(out).toContain("https://x.example/p");
  });

  // Regression: \r must be escaped too, or a CR payload re-hides itself in the report.
  test("hostile content is visualised, never printed raw", () => {
    const evil = "a\x1b[2J\x1b]0;pwned\x07\rb\u202Ec\u200B";
    const out = formatFindings(
      [
        result(`/tmp/x\x1b[31m.txt`, [
          finding("critical", {
            message: evil,
            humanView: evil,
            agentView: `${evil}!`,
            location: evil,
            line: undefined,
          }),
        ]),
      ],
      "pretty",
      { verbose: true, cwd: "/" },
    );
    expect(stripSgr(out)).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\u202E");
    expect(out).not.toContain("\u200B");
    expect(out).toContain("⟨U+001B⟩");
  });
});

describe("formatSARIF", () => {
  const rs = [
    result("/repo/src/a.md", [
      finding("critical", {
        ruleId: "unicode/tags",
        line: 4,
        column: 7,
        hiddenText: "secret",
        message: "tags",
      }),
      finding("info", { ruleId: "markdown/comment", line: 9 }),
    ]),
    result("https://x.example/", [finding("warning", { ruleId: "fetch/cloaking", line: undefined })]),
    result("/repo/deck.pptx", [
      finding("warning", { ruleId: "office/hidden-slide", line: undefined, location: "slide 2" }),
    ]),
  ];
  const sarif = JSON.parse(formatSARIF(rs, "/repo"));

  test("top-level structure", () => {
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toMatch(/sarif-2\.1\.0/);
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("wysiwyg");
    expect(typeof sarif.runs[0].tool.driver.version).toBe("string");
  });

  test("one result per finding, with rules derived from ruleIds", () => {
    const run = sarif.runs[0];
    expect(run.results).toHaveLength(4);
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual([
      "fetch/cloaking",
      "markdown/comment",
      "office/hidden-slide",
      "unicode/tags",
    ]);
  });

  test("levels map from severity", () => {
    const levels = sarif.runs[0].results.map((r: { level: string }) => r.level);
    expect(levels).toEqual(["error", "note", "warning", "warning"]);
  });

  test("locations: relative URIs, line and column", () => {
    const [first, , url, pptx] = sarif.runs[0].results;
    expect(first.locations[0].physicalLocation.artifactLocation.uri).toBe("src/a.md");
    expect(first.locations[0].physicalLocation.region).toEqual({ startLine: 4, startColumn: 7 });
    expect(url.locations[0].physicalLocation.artifactLocation.uri).toBe("https://x.example/");
    expect(url.locations[0].physicalLocation.region).toBeUndefined();
    expect(pptx.locations[0].message.text).toBe("slide 2");
  });

  test("hidden text is included in the message", () => {
    expect(sarif.runs[0].results[0].message.text).toContain("secret");
  });

  test("properties carry severity and type", () => {
    expect(sarif.runs[0].results[0].properties).toMatchObject({
      severity: "critical",
      type: "hidden_rendered",
    });
  });

  test("formatFindings sarif delegates to formatSARIF", () => {
    expect(formatFindings(rs, "sarif", { cwd: "/repo" })).toBe(formatSARIF(rs, "/repo"));
  });
});
