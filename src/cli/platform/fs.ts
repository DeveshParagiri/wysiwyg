import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { MAX_FILE_SIZE, BINARY_CHECK_BYTES } from "../../core/constants/index.js";

/**
 * Check if a file appears to be binary by looking at the first bytes.
 */
export function isBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Check if a filename matches any of the ignore patterns (simple glob matching).
 */
export function matchesIgnorePattern(
  filePath: string,
  patterns: string[],
): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (pattern.includes("**")) {
      // Match directory prefix
      const prefix = pattern.replace("/**", "").replace("**", "");
      if (normalized.includes(prefix)) return true;
    } else if (pattern.startsWith("*.")) {
      // Extension match
      const ext = pattern.slice(1);
      if (normalized.endsWith(ext)) return true;
    } else if (normalized.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively walk a directory and yield file paths.
 */
export async function walkDirectory(
  dir: string,
  ignorePatterns: string[],
  baseDir?: string,
): Promise<string[]> {
  const base = baseDir ?? dir;
  const files: string[] = [];

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(base, fullPath);

    if (matchesIgnorePattern(relativePath, ignorePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await walkDirectory(fullPath, ignorePatterns, base);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Read a file, checking size and binary content.
 * Returns the content as a string, or null if the file should be skipped.
 */
export async function readFileForScan(
  filePath: string,
): Promise<{ content: string; buffer: Buffer } | { skip: string }> {
  const fileStat = await stat(filePath);

  if (fileStat.size > MAX_FILE_SIZE) {
    return { skip: `File too large (${(fileStat.size / 1024 / 1024).toFixed(1)}MB > ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB limit)` };
  }

  const buffer = Buffer.from(await readFile(filePath));

  if (isBinary(buffer)) {
    // Check if it's a PDF (which we can scan)
    if (filePath.endsWith(".pdf")) {
      return { content: "", buffer };
    }
    return { skip: "Binary file" };
  }

  return { content: buffer.toString("utf-8"), buffer };
}
