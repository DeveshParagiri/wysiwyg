/**
 * Build the npm package (runs on Node ≥ 20, no Bun needed):
 *
 *   dist/cli.js          CLI entry (node shebang)
 *   dist/scan-worker.js  worker for parallel scanning (next to cli.js, see pool.ts)
 *   dist/index.js        library entry
 *   dist/types/…         type declarations for the library
 *
 * Dependencies stay external; npm installs them.
 */
import { chmodSync, rmSync } from "node:fs";

// Overwrite in place rather than deleting dist/: `npm publish` checks the bin
// target while prepublishOnly runs, and drops it if dist/cli.js is briefly missing.
rmSync("dist/types", { recursive: true, force: true });

const common = {
  target: "node",
  format: "esm",
  packages: "external",
  minify: false,
  sourcemap: "none",
} as const;

const builds = [
  { entrypoints: ["src/cli/cli.ts"], naming: "cli.js", banner: "#!/usr/bin/env node" },
  { entrypoints: ["src/cli/platform/scan-worker.ts"], naming: "scan-worker.js" },
  { entrypoints: ["src/core/index.ts"], naming: "index.js" },
];

for (const b of builds) {
  const out = await Bun.build({ ...common, ...b, outdir: "dist" });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    process.exit(1);
  }
}
chmodSync("dist/cli.js", 0o755);

const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);
console.log("built dist/");
