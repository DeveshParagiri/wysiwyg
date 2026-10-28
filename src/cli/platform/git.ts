import { resolve } from "node:path";

/**
 * Files changed relative to a git ref (--diff) or staged for commit
 * (--staged), as absolute paths. Deleted files are excluded.
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
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  const args = opts.staged
    ? ["diff", "--name-only", "--diff-filter=ACMRT", "--cached", "-z"]
    : ["diff", "--name-only", "--diff-filter=ACMRT", "-z", opts.diff!];
  const names = git(args).split("\0").filter(Boolean);
  return new Set(names.map((n) => resolve(top, n)));
}
