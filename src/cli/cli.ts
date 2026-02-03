#!/usr/bin/env bun

import { program } from "commander";
import { scanCommand } from "./commands/scan.js";
import { fetchCommand } from "./commands/fetch.js";

program
  .name("wysiwyg")
  .description(
    "Detect hidden prompt injection payloads before they reach your AI agent",
  )
  .version("0.1.0");

program
  .command("scan [target]")
  .description("Scan files for hidden content")
  .option("-r, --recursive", "Scan directory recursively")
  .option("--stdin", "Read from stdin")
  .option("--clipboard", "Read from system clipboard (rich HTML)")
  .option(
    "--format <format>",
    "Output format: pretty | json",
    "pretty",
  )
  .option(
    "--fail-on <severity>",
    "Exit code threshold: critical | warning | info",
  )
  .option("--no-config", "Ignore .wysiwygrc")
  .action(scanCommand);

program
  .command("fetch <url>")
  .description("Check URL for agent-targeted cloaking")
  .option(
    "--format <format>",
    "Output format: pretty | json",
    "pretty",
  )
  .option("--timeout <ms>", "Request timeout in ms", "10000")
  .option("--fail-on <severity>", "Exit code threshold")
  .action(fetchCommand);

program.parse();
