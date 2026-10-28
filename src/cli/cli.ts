import { Option, program } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { fetchCommand } from "./commands/fetch.js";
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
  .version(pkg.version);

program
  .command("scan [target]")
  .description("Scan files or directories (default: current directory)")
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

await program.parseAsync();
