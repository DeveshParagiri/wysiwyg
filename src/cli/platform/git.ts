import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Files changed relative to a git ref (--diff) or staged for commit
 * (--staged), as absolute real paths (symlinks resolved, so callers must
 * compare against realpath() too). Deleted files are excluded.
 */
export async function changedFiles(
  dir: string,
  opts: { diff?: string; staged?: boolean },
): Promise<Set<string>> {
  const git = (args: string[]) => {
    const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
    }
    return proc.stdout.toString();
  };
  const top = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
  const args = opts.staged
    ? ["diff", "--name-only", "--diff-filter=ACMRT", "--cached", "-z"]
    : ["diff", "--name-only", "--diff-filter=ACMRT", "-z", opts.diff!];
  const names = git(args).split("\0").filter(Boolean);
  return new Set(names.map((n) => resolve(top, n)));
}
