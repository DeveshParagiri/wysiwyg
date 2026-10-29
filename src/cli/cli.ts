import { Option, program } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { fetchCommand } from "./commands/fetch.js";
import { hookCommand } from "./commands/hook.js";
import { mcpCommand } from "./commands/mcp.js";
import { scanCommand } from "./commands/scan.js";

const formatOption = () =>
  new Option("--format <format>", "output format").choices(["pretty", "json", "sarif"]).default("pretty");
const failOnOption = () =>
  new Option("--fail-on <severity>", "exit 1 at or above this severity").choices([
    "critical",
    "warning",
    "info",
  ]);

// Exit codes: 0 clean, 1 findings, 2 usage or runtime error. Commander exits 1 on
// usage errors by default, which CI would read as "findings".
program.exitOverride((err) => {
  process.exit(err.exitCode === 0 ? 0 : 2);
});

program
  .name("wysiwyg")
  .description(
    "Show what AI agents read that humans don't see — hidden prompt injection in files, pages and documents",
  )
  .version(pkg.version)
  .addHelpText(
    "after",
    `
Examples:
  $ wysiwyg                              scan the current directory
  $ wysiwyg README.md docs/              scan files and folders
  $ wysiwyg . --diff origin/main         only files changed on this branch (CI)
  $ wysiwyg --staged                     only staged files (pre-commit)
  $ wysiwyg . --format sarif > out.sarif GitHub code scanning
  $ pbpaste | wysiwyg --stdin --as page.html
  $ wysiwyg fetch https://example.com    compare what browsers and AI agents receive
  $ wysiwyg mcp -- npx some-mcp-server   read an MCP server's tool descriptions

Exit codes: 0 clean · 1 findings at or above --fail-on (default critical) · 2 error`,
  );

program
  // Default command: `wysiwyg docs/ README.md` is `wysiwyg scan docs/ README.md`
  .command("scan [targets...]", { isDefault: true })
  .description("Scan files and directories (default: current directory)")
  .option("--no-recursive", "only scan files directly inside a directory")
  .option("--stdin", "read content from stdin")
  .option("--as <filename>", "treat stdin as this filename (selects the format, e.g. page.html)")
  .option("--clipboard", "read the system clipboard (plain text and rich HTML)")
  .option("--diff <ref>", "only scan files changed relative to a git ref, e.g. origin/main")
  .option("--staged", "only scan files staged for commit (pre-commit hooks)")
  .option("--config <path>", "use this .wysiwygrc (trusted)")
  .option("--no-config", "ignore .wysiwygrc files")
  .option("--max-size <mb>", "bytes to scan per file, in MB", "10")
  .option("-v, --verbose", "also show info-level findings")
  .addOption(formatOption())
  .addOption(failOnOption())
  .action(scanCommand);

program
  .command("fetch <url>")
  .description("Fetch a URL as a browser and as AI agents; report cloaking and hidden content")
  .option("--timeout <ms>", "request timeout in ms", "10000")
  .option("--no-llms-txt", "skip /llms.txt and /llms-full.txt")
  .option("-v, --verbose", "also show info-level findings")
  .addOption(formatOption())
  .addOption(failOnOption())
  .action(fetchCommand);

program
  .command("mcp [command...]")
  .description(
    "Scan MCP servers' tool, prompt and resource metadata — what the model reads but the user never sees",
  )
  .usage("[options] -- <command> [args...] | --url <url> | --config <file> --yes")
  .option("--url <url>", "scan a Streamable HTTP server instead of a stdio command")
  .option("-H, --header <header...>", "HTTP header(s) for --url, e.g. 'Authorization: Bearer <token>'")
  .option("--config <file>", "scan every server in an MCP client config (mcpServers)")
  .option("--server <name>", "with --config: only this server")
  .option("--yes", "with --config: start the listed commands (they come from a file)")
  .option("--timeout <ms>", "per-server timeout in ms", "15000")
  .option("-v, --verbose", "also show info-level findings (every description the model reads)")
  .addOption(formatOption())
  .addOption(failOnOption())
  .action(mcpCommand);

program
  .command("hook")
  .description(
    "Claude Code hook: flag hidden content in tool results (PostToolUse) and in agent instruction files at session start (SessionStart). Reads the hook JSON on stdin",
  )
  .addOption(
    new Option("--fail-on <severity>", "report findings at or above this severity")
      .choices(["critical", "warning"])
      .default("critical"),
  )
  .addOption(
    new Option("--format <format>", "hook output format").choices(["claude-code"]).default("claude-code"),
  )
  .action(hookCommand);

await program.parseAsync();
