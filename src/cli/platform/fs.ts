import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isAgentInstructionFile } from "../../core/constants/agent-files.js";
import { MAX_FILE_SIZE } from "../../core/constants/index.js";

export interface WalkedFile {
  /** Absolute path as reached through the tree (may be a symlink). */
  path: string;
  /** Path relative to the scan root, "/"-separated. */
  rel: string;
  /** Set when the file was reached through a symlink pointing outside the scan root. */
  outsideTarget?: string;
}

/** Directories never worth descending into. */
const NEVER_DESCEND = new Set([".git", "node_modules"]);

/**
 * Simple glob matching for ignore patterns:
 *   "dir/**"  — the directory at any depth
 *   "*.ext"   — extension
 *   "**" / "*" — everything
 *   other     — substring of the relative path
 */
export function matchesIgnorePattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (pattern === "**" || pattern === "*" || pattern === "**/*") return true;
    if (pattern.includes("**")) {
      const prefix = pattern.replace(/\/\*\*$/, "").replace(/^\*\*\//, "");
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return true;
      if (normalized.includes(`/${prefix}/`) || normalized.endsWith(`/${prefix}`)) return true;
    } else if (pattern.startsWith("*.")) {
      if (normalized.endsWith(pattern.slice(1))) return true;
    } else if (normalized === pattern || normalized.endsWith(`/${pattern}`) || normalized.includes(pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a directory. Follows symlinks (agents do), guards against cycles, and
 * never lets ignore patterns hide agent instruction files.
 */
export async function walkDirectory(root: string, ignorePatterns: string[]): Promise<WalkedFile[]> {
  const rootReal = await realpath(root);
  const files: WalkedFile[] = [];
  const visitedDirs = new Set<string>([rootReal]);

  const walk = async (dir: string, agentFilesOnly: boolean) => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (NEVER_DESCEND.has(entry.name)) continue;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let outsideTarget: string | undefined;
      if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(full);
          const st = await stat(target);
          isDir = st.isDirectory();
          isFile = st.isFile();
          if (target !== rootReal && !target.startsWith(rootReal + sep)) outsideTarget = target;
        } catch {
          continue; // dangling link
        }
      }

      const ignored = matchesIgnorePattern(rel, ignorePatterns);
      if (isDir) {
        const real = await realpath(full).catch(() => full);
        if (visitedDirs.has(real)) continue;
        visitedDirs.add(real);
        if (ignored || agentFilesOnly) {
          // Agent instruction files can live anywhere (vendor/AGENTS.md, build/SKILL.md…)
          await walk(full, true);
          continue;
        }
        await walk(full, false);
      } else if (isFile) {
        const agentFile = isAgentInstructionFile(rel);
        if ((ignored || agentFilesOnly) && !agentFile) continue;
        files.push({ path: full, rel, outsideTarget });
      }
    }
  };

  await walk(root, false);
  return files;
}

export interface ReadResult {
  bytes: Uint8Array;
  /** Total size on disk; larger than bytes.length when truncated. */
  size: number;
  truncated: boolean;
}

/** Read a file, capped at maxBytes (the head is scanned, the rest reported). */
export async function readFileForScan(filePath: string, maxBytes = MAX_FILE_SIZE): Promise<ReadResult> {
  const { size } = await stat(filePath);
  const length = Math.min(size, maxBytes);
  const handle = await open(filePath, "r");
  try {
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(bytes, read, length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { bytes: bytes.subarray(0, read), size, truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}
