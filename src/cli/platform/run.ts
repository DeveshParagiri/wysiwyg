import { spawnSync } from "node:child_process";

/** Run a command synchronously (works under Node and Bun). */
export function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? String(r.error ?? ""),
  };
}
