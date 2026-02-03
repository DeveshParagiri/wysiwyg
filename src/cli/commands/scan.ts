import type { ScanResult, OutputFormat, Severity } from "../../core/types.js";
import { scanUnicode } from "../../core/scanner/unicode.js";
import { scanRendered, scanPDF } from "../../core/scanner/rendered.js";
import { scanConfigFile, isKnownConfigFile } from "../../core/scanner/configfile.js";
import { analyzeClipboardHTML } from "../../core/scanner/clipboard.js";
import { FILE_TYPE_MAP } from "../../core/constants/index.js";
import { formatFindings, formatSummary } from "../output/formatter.js";
import { loadConfig } from "../config/loader.js";
import { readClipboardHTML } from "../platform/clipboard.js";
import {
  walkDirectory,
  readFileForScan,
  matchesIgnorePattern,
} from "../platform/fs.js";
import { statSync } from "node:fs";
import { resolve, relative } from "node:path";

interface ScanOptions {
  recursive?: boolean;
  stdin?: boolean;
  clipboard?: boolean;
  format?: string;
  failOn?: string;
  config?: boolean; // --no-config sets this to false
}

/**
 * Determine if a file extension is a rendered file type.
 */
function isRenderedFileType(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex > 0 ? filePath.slice(dotIndex).toLowerCase() : "";
  return (
    FILE_TYPE_MAP.markdown.includes(ext as (typeof FILE_TYPE_MAP.markdown)[number]) ||
    FILE_TYPE_MAP.html.includes(ext as (typeof FILE_TYPE_MAP.html)[number]) ||
    FILE_TYPE_MAP.pdf.includes(ext as (typeof FILE_TYPE_MAP.pdf)[number])
  );
}

function isPdfFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * Scan a single file and return results.
 */
async function scanFile(filePath: string): Promise<ScanResult> {
  const result = await readFileForScan(filePath);

  if ("skip" in result) {
    return { source: filePath, findings: [], clean: true };
  }

  const findings = [];

  // Layer 1: Unicode scan — always
  findings.push(...scanUnicode(result.content, filePath));

  // Layer 2: Rendered scan — if applicable
  if (isPdfFile(filePath)) {
    findings.push(...(await scanPDF(result.buffer, filePath)));
  } else if (isRenderedFileType(filePath)) {
    findings.push(...scanRendered(result.content, filePath));
  }

  // Layer 4: Config file scan — if it's a known config file
  if (isKnownConfigFile(filePath)) {
    findings.push(...scanConfigFile(result.content, filePath));
  }

  return {
    source: filePath,
    findings,
    clean: findings.length === 0,
  };
}

/**
 * Check if severity meets threshold.
 */
function meetsThreshold(
  findings: ScanResult["findings"],
  threshold: Severity,
): boolean {
  const severityRank: Record<Severity, number> = {
    info: 0,
    warning: 1,
    critical: 2,
  };
  const thresholdRank = severityRank[threshold];
  return findings.some(
    (f) => severityRank[f.severity] >= thresholdRank,
  );
}

/**
 * The scan command handler.
 */
export async function scanCommand(
  target: string | undefined,
  options: ScanOptions,
): Promise<void> {
  const format = (options.format || "pretty") as OutputFormat;
  const useConfig = options.config !== false;
  const config = useConfig ? loadConfig() : {
    expected_scripts: ["Latin"] as string[],
    ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"] as string[],
    fail_on: "critical" as const,
  };
  const failOn = (options.failOn || config.fail_on || "critical") as Severity;

  const results: ScanResult[] = [];

  try {
    // --- Stdin mode ---
    if (options.stdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString("utf-8");
      const findings = scanUnicode(content, "stdin");
      results.push({
        source: "stdin",
        findings,
        clean: findings.length === 0,
      });
    }
    // --- Clipboard mode ---
    else if (options.clipboard) {
      const clipboard = await readClipboardHTML();
      const findings = [];

      // Run unicode scan on plain text
      findings.push(...scanUnicode(clipboard.plainText, "clipboard"));

      // Run clipboard HTML analysis if HTML is available
      if (clipboard.html) {
        findings.push(
          ...analyzeClipboardHTML(clipboard.html, clipboard.plainText),
        );
      }

      results.push({
        source: "clipboard",
        findings,
        clean: findings.length === 0,
      });
    }
    // --- File/directory mode ---
    else {
      const targetPath = resolve(target || ".");

      let fileStat;
      try {
        fileStat = statSync(targetPath);
      } catch {
        console.error(`Error: Cannot access "${targetPath}"`);
        process.exit(2);
      }

      if (fileStat.isFile()) {
        results.push(await scanFile(targetPath));
      } else if (fileStat.isDirectory()) {
        if (options.recursive || !target) {
          // Recursive scan (default when scanning a directory)
          const files = await walkDirectory(
            targetPath,
            config.ignore ?? [],
          );
          if (format === "pretty") {
            console.log(`Scanning ${files.length} files...`);
          }
          for (const file of files) {
            results.push(await scanFile(file));
          }
        } else {
          // Non-recursive: scan only files directly in the directory
          const { readdirSync } = await import("node:fs");
          const entries = readdirSync(targetPath, {
            withFileTypes: true,
          });
          const files = entries
            .filter((e) => e.isFile())
            .map((e) => resolve(targetPath, e.name))
            .filter(
              (f) =>
                !matchesIgnorePattern(
                  relative(targetPath, f),
                  config.ignore ?? [],
                ),
            );
          for (const file of files) {
            results.push(await scanFile(file));
          }
        }
      }
    }

    // Output
    console.log(formatFindings(results, format));

    // Exit code
    const allFindings = results.flatMap((r) => r.findings);
    if (meetsThreshold(allFindings, failOn)) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(2);
  }
}
