/**
 * Build the Claude Code plugin's self-contained CLI bundle:
 *
 *   plugin/dist/wysiwyg.mjs   the CLI with every dependency inlined
 *
 * Hooks scan a handful of files, so the worker pool isn't shipped; without
 * scan-worker.js next to the bundle the pool scans sequentially.
 *
 * The plugin installs straight from GitHub (no npm install), so the bundle is
 * committed. CI rebuilds it and fails if the committed copy is stale.
 */
import { rmSync } from "node:fs";

rmSync("plugin/dist", { recursive: true, force: true });
const out = await Bun.build({
  entrypoints: ["src/cli/cli.ts"],
  outdir: "plugin/dist",
  naming: "wysiwyg.mjs",
  target: "node",
  format: "esm",
  minify: true,
  banner: "#!/usr/bin/env node",
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  process.exit(1);
}
console.log("built plugin/dist/");
