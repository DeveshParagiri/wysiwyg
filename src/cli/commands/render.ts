import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { renderVisible } from "../../core/render.js";
import type { Finding } from "../../core/types.js";
import { writeOut } from "../output/write.js";

interface RenderOptions {
  as?: string;
  format?: string;
  report?: boolean;
}

/**
 * `wysiwyg render <file|->`: print the text a human sees in a document, for
 * pipelines that should give the model exactly what the reviewer saw.
 * Exit 0 on success (even when content was removed), 2 on errors.
 */
export async function renderCommand(file: string, options: RenderOptions): Promise<void> {
  const format = options.format || "text";
  try {
    let bytes: Uint8Array;
    let path: string;
    if (file === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      bytes = new Uint8Array(Buffer.concat(chunks));
      path = options.as ?? "stdin";
    } else {
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st) throw new Error(`cannot access "${file}"`);
      if (!st.isFile()) throw new Error(`"${file}" is not a file`);
      bytes = new Uint8Array(readFileSync(file));
      path = options.as ?? basename(file);
    }

    const result = await renderVisible(bytes, { path });
    if (options.report) console.error(summary(result.removed, result.kind));
    await writeOut(format === "json" ? JSON.stringify(result, null, 2) : result.text);
  } catch (err) {
    console.error(`wysiwyg: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

/** One line for stderr: counts and rule ids only — never the removed text, which may carry escapes. */
function summary(removed: Finding[], kind: string): string {
  if (!removed.length) return `wysiwyg: nothing hidden removed (${kind})`;
  const byRule = new Map<string, number>();
  for (const f of removed) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  const worst = removed.some((f) => f.severity === "critical")
    ? "critical"
    : removed.some((f) => f.severity === "warning")
      ? "warning"
      : "info";
  const rules = [...byRule].map(([id, n]) => (n > 1 ? `${id} ×${n}` : id)).join(", ");
  return `wysiwyg: removed ${removed.length} hidden item${removed.length > 1 ? "s" : ""} (${kind}, worst ${worst}): ${rules}`;
}
