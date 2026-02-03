import type { OutputFormat, Severity } from "../../core/types.js";
import { fetchWithAgents } from "../../core/scanner/cloaking.js";
import { scanUnicode } from "../../core/scanner/unicode.js";
import { formatFindings } from "../output/formatter.js";

interface FetchOptions {
  format?: string;
  timeout?: string;
  failOn?: string;
}

/**
 * The fetch command handler.
 */
export async function fetchCommand(
  url: string,
  options: FetchOptions,
): Promise<void> {
  const format = (options.format || "pretty") as OutputFormat;
  const timeout = parseInt(options.timeout || "10000", 10);
  const failOn = (options.failOn || "critical") as Severity;

  // Validate URL
  try {
    new URL(url);
  } catch {
    console.error(`Error: Invalid URL "${url}"`);
    process.exit(2);
  }

  try {
    if (format === "pretty") {
      console.log(`Fetching ${url} with multiple user-agents...\n`);
    }

    // Run cloaking detection
    const result = await fetchWithAgents(url, fetch, timeout);

    // Also run unicode scan on the response bodies
    // (re-fetch once as Chrome to get the body for unicode scanning)
    try {
      const response = await fetch(url);
      const body = await response.text();
      const unicodeFindings = scanUnicode(body, url);
      result.findings.push(...unicodeFindings);
      result.clean = result.findings.length === 0;
    } catch (err) {
      if (format === "pretty") {
        console.warn(`Warning: Unicode scan skipped (re-fetch failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    }

    console.log(formatFindings([result], format));

    // Exit code
    const severityRank: Record<Severity, number> = {
      info: 0,
      warning: 1,
      critical: 2,
    };
    const thresholdRank = severityRank[failOn];
    const hasFindings = result.findings.some(
      (f) => severityRank[f.severity] >= thresholdRank,
    );

    if (hasFindings) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(2);
  }
}
