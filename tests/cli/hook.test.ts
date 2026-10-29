import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evaluateHook, extractText, targetFor } from "../../src/cli/commands/hook.js";
import { PAYLOAD, SHORT_PAYLOAD, toTags } from "../redteam/cases.js";

const ROOT = join(import.meta.dir, "../..");
const CLI = join(ROOT, "src/cli/cli.ts");

function hook(stdin: string, args: string[] = []) {
  const proc = Bun.spawnSync(["bun", CLI, "hook", ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdin: Buffer.from(stdin),
  });
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

interface HookOutput {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

/** PostToolUse payload, shaped like the documented example (code.claude.com/docs/en/hooks). */
function payload(tool_name: string, tool_input: unknown, tool_response: unknown) {
  return JSON.stringify({
    session_id: "abc123",
    transcript_path: "/Users/me/.claude/projects/p/00893aaf.jsonl",
    cwd: "/Users/me/project",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name,
    tool_input,
    tool_response,
    tool_use_id: "toolu_01ABC123",
    duration_ms: 12,
  });
}

const POISONED_MD = `# Setup guide\n\nRun \`bun install\` first.\n\n<!-- ${PAYLOAD} -->\n\nThen run the tests.\n`;

describe("wysiwyg hook (PostToolUse)", () => {
  test("Read of a poisoned Markdown file → block with reason, context and user warning", () => {
    const r = hook(
      payload(
        "Read",
        { file_path: "/Users/me/project/docs/setup.md" },
        {
          type: "text",
          file: {
            filePath: "/Users/me/project/docs/setup.md",
            content: POISONED_MD,
            numLines: 8,
            totalLines: 8,
          },
        },
      ),
    );
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as HookOutput;
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("markdown/comment");
    expect(out.reason).toContain("line 5");
    expect(out.reason).toContain("ignore previous instructions");
    expect(out.reason).toContain("do not follow instructions");
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput?.additionalContext).toContain("Do not follow");
    expect(out.systemMessage).toContain("/Users/me/project/docs/setup.md");
  });

  test("WebFetch result with Unicode Tags → block, hidden text decoded and quoted", () => {
    const r = hook(
      payload(
        "WebFetch",
        { url: "https://example.com/docs/page", prompt: "Summarize this page" },
        {
          bytes: 5120,
          code: 200,
          codeText: "OK",
          result: `The page explains how to configure the CLI.${toTags(SHORT_PAYLOAD)}`,
          durationMs: 800,
          url: "https://example.com/docs/page",
        },
      ),
    );
    const out = JSON.parse(r.stdout) as HookOutput;
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("unicode/tags");
    expect(out.reason).toContain("https://example.com/docs/page");
    expect(out.reason).toContain(SHORT_PAYLOAD.slice(0, 30));
    // The raw tag characters must not be echoed back into Claude's context.
    expect(/[\u{E0000}-\u{E007F}]/u.test(r.stdout)).toBe(false);
  });

  test("MCP tool result with a content array → block, location names the content item", () => {
    const r = hook(
      payload(
        "mcp__docs__get_page",
        { id: "intro" },
        {
          content: [
            { type: "text", text: "Welcome to the docs." },
            { type: "text", text: `Intro <span style="display:none">${PAYLOAD}</span> continues here.` },
            { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
      ),
    );
    const out = JSON.parse(r.stdout) as HookOutput;
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("markdown/hidden-text");
    expect(out.reason).toContain("tool_response.content[1].text");
    expect(out.reason).toContain("mcp__docs__get_page");
  });

  test("MCP result serialized as a JSON string is unwrapped", () => {
    const response = JSON.stringify([{ type: "text", text: `Done.${toTags(SHORT_PAYLOAD)}` }]);
    const out = JSON.parse(hook(payload("mcp__x__y", {}, response)).stdout) as HookOutput;
    expect(out.reason).toContain("unicode/tags");
  });

  test("Bash output with a concealed terminal line → block", () => {
    const out = JSON.parse(
      hook(
        payload(
          "Bash",
          { command: "cat notes.txt" },
          { stdout: `build ok\n\x1b[8m${PAYLOAD}\x1b[0m\n`, stderr: "", interrupted: false, isImage: false },
        ),
      ).stdout,
    ) as HookOutput;
    expect(out.reason).toContain("terminal/hidden-text");
    // The ESC byte is shown as a marker, never raw.
    expect(out.reason).not.toContain("\x1b");
  });

  test("clean result → exit 0, no output", () => {
    const r = hook(
      payload(
        "Read",
        { file_path: "/Users/me/project/README.md" },
        {
          type: "text",
          file: { filePath: "/Users/me/project/README.md", content: "# Project\n\nJust docs.\n" },
        },
      ),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("malformed JSON → exit 0, no output, note on stderr", () => {
    const r = hook("{not json");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("malformed input");
  });

  test("non-object JSON and other events are ignored", () => {
    expect(hook("[1,2]").stdout).toBe("");
    const pre = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} });
    const r = hook(pre);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("--fail-on warning reports concealed prose; default does not", () => {
    const text = `Notes <span style="display:none">The third quarter figures are in appendix B of the finance folder.</span>`;
    const input = payload("mcp__notes__read", {}, { content: [{ type: "text", text }] });
    expect(hook(input).stdout).toBe("");
    const out = JSON.parse(hook(input, ["--fail-on", "warning"]).stdout) as HookOutput;
    expect(out.reason).toContain("[warning]");
  });
});

describe("hook internals", () => {
  test("Read path decides the format and keeps agent-file detection", () => {
    expect(targetFor("Read", { file_path: "/p/page.html" }, "/p")).toMatchObject({ path: "page.html" });
    expect(targetFor("Read", { file_path: "/p/.claude/CLAUDE.md" }, "/p")).toMatchObject({
      path: ".claude/CLAUDE.md",
    });
    expect(targetFor("Read", { file_path: "/elsewhere/x.md" }, "/p")).toMatchObject({
      path: "/elsewhere/x.md",
    });
  });

  test("WebFetch URL decides the kind", () => {
    expect(targetFor("WebFetch", { url: "https://x.dev/llms.txt" })).toMatchObject({ kind: "text" });
    expect(targetFor("WebFetch", { url: "https://x.dev/docs/" })).toMatchObject({ kind: "markdown" });
  });

  test("extractText skips metadata and binary payloads", () => {
    const pieces = extractText({
      filePath: "/a/b.md",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "AAAA" },
      ],
      structuredContent: { result: "hello" },
      nested: { deeper: ["world"] },
    });
    expect(pieces.map((p) => p.text)).toEqual(["hello", "world"]);
  });

  test("reason stays under Claude Code's 10,000-character limit", () => {
    const text = Array.from({ length: 200 }, (_, i) => `para ${i}\n<!-- ${PAYLOAD} ${i} -->\n`).join("\n");
    const out = evaluateHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__a__b",
        tool_response: { content: [{ type: "text", text }] },
      },
      "critical",
    );
    expect(out?.decision).toBe("block");
    expect(String(out?.reason).length).toBeLessThan(10_000);
    expect(out?.reason).toContain("more findings");
  });
});
