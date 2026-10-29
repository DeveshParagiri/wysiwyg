/**
 * Standalone executables (no Node or Bun needed) for GitHub Releases.
 *
 *   bun scripts/build-binary.ts [target…]   e.g. bun-linux-x64 bun-darwin-arm64
 *
 * With no targets, builds for the current platform into dist/wysiwyg.
 */
import { mkdirSync } from "node:fs";

const targets = process.argv.slice(2);
mkdirSync("dist/bin", { recursive: true });

for (const target of targets.length ? targets : [undefined]) {
  const outfile = target ? `dist/bin/wysiwyg-${target.replace(/^bun-/, "")}` : "dist/wysiwyg";
  const args = ["build", "--compile", "--minify", "src/cli/cli.ts", "--outfile", outfile];
  if (target) args.push(`--target=${target}`);
  const proc = Bun.spawnSync(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}
