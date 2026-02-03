import type { Finding } from "../types.js";
import {
  KNOWN_CONFIG_FILES,
  INJECTION_PATTERNS,
  ASCII_ONLY_EXTENSIONS,
} from "../constants/index.js";
import { scanUnicode } from "./unicode.js";

/**
 * Check if a file path matches a known AI agent config file pattern.
 */
export function isKnownConfigFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of KNOWN_CONFIG_FILES) {
    // Handle glob patterns
    if (pattern.includes("**")) {
      const prefix = pattern.replace("/**", "");
      if (normalized.includes(prefix)) return true;
    } else if (normalized.endsWith(pattern) || normalized.endsWith("/" + pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect prompt injection patterns in text content.
 */
export function detectInstructionPatterns(content: string): Finding[] {
  const findings: Finding[] = [];

  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      const line =
        content.substring(0, match.index).split("\n").length;
      const contextStart = Math.max(0, match.index - 40);
      const contextEnd = Math.min(
        content.length,
        match.index + match[0].length + 40,
      );
      const context = content.substring(contextStart, contextEnd);

      findings.push({
        type: "config_obfuscated",
        severity: "critical",
        line,
        offset: match.index,
        message: `Prompt injection pattern detected: "${match[0]}"`,
        humanView: context,
        agentView: context,
        detail: `Pattern: ${pattern.toString()} matched "${match[0]}"`,
      });
    }
  }

  return findings;
}

/**
 * Check for non-ASCII characters in ASCII-expected config files.
 */
function detectNonAscii(
  content: string,
  filePath: string,
): Finding[] {
  const findings: Finding[] = [];

  // Only flag non-ASCII in config files that should be ASCII-only
  const isAsciiExpected = (ASCII_ONLY_EXTENSIONS as readonly string[]).some(
    (ext) => filePath.endsWith(ext),
  );

  if (!isAsciiExpected) return findings;

  for (let i = 0; i < content.length; i++) {
    const cp = content.codePointAt(i)!;
    if (cp > 0x7e && cp !== 0x0a && cp !== 0x0d && cp !== 0x09) {
      // Non-ASCII character found
      const line = content.substring(0, i).split("\n").length;
      const contextStart = Math.max(0, i - 20);
      const contextEnd = Math.min(content.length, i + 20);
      const context = content.substring(contextStart, contextEnd);

      findings.push({
        type: "config_non_ascii",
        severity: "warning",
        line,
        offset: i,
        message: `Non-ASCII character in ASCII-expected config file`,
        humanView: context.replace(/[^\x20-\x7e\n]/g, "?"),
        agentView: context,
        detail: `U+${cp.toString(16).toUpperCase().padStart(4, "0")} at offset ${i} in ${filePath}`,
      });

      // Only report first occurrence to avoid flooding
      break;
    }

    // Skip surrogate pair
    if (cp > 0xffff) i++;
  }

  return findings;
}

/**
 * Scan a config file for hidden content and prompt injection.
 */
export function scanConfigFile(
  content: string,
  filePath: string,
): Finding[] {
  const findings: Finding[] = [];

  // Check for non-ASCII in ASCII-expected files
  findings.push(...detectNonAscii(content, filePath));

  // Run unicode scanner with elevated severity
  const unicodeFindings = scanUnicode(content, filePath);
  for (const finding of unicodeFindings) {
    // Elevate warnings to critical in config files
    findings.push({
      ...finding,
      severity:
        finding.severity === "warning" ? "critical" : finding.severity,
      message: `[Config file] ${finding.message}`,
    });
  }

  // Detect prompt injection patterns
  findings.push(...detectInstructionPatterns(content));

  return findings;
}
