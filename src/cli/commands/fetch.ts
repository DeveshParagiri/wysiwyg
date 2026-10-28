import { fetchWithAgents } from "../../core/fetch/cloaking.js";
import { meetsThreshold } from "../../core/policy.js";
import type { OutputFormat, Severity } from "../../core/types.js";
import { formatFindings } from "../output/formatter.js";
import { writeOut } from "../output/write.js";

interface FetchOptions {
  format?: string;
  timeout?: string;
  failOn?: string;
  llmsTxt?: boolean;
  verbose?: boolean;
}

export async function fetchCommand(url: string, options: FetchOptions): Promise<void> {
  const format = (options.format || "pretty") as OutputFormat;
  const timeout = parseInt(options.timeout || "10000", 10);
  const failOn = (options.failOn || "critical") as Severity;

  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("only http(s) URLs are supported");
  } catch (err) {
    console.error(
      `Error: Invalid URL "${url}"${err instanceof Error && err.message.startsWith("only") ? `: ${err.message}` : ""}`,
    );
    process.exit(2);
  }

  try {
    if (format === "pretty") console.error(`Fetching ${url} as a browser and as AI agents…`);
    const results = await fetchWithAgents(url, { timeout, llmsTxt: options.llmsTxt !== false });
    await writeOut(formatFindings(results, format, { verbose: options.verbose }));
    // exitCode, not exit(): exiting immediately can truncate large output on a pipe
    if (
      meetsThreshold(
        results.flatMap((r) => r.findings),
        failOn,
      )
    )
      process.exitCode = 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
