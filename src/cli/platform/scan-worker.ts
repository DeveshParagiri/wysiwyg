/**
 * Worker entry point for the scan pool: receives { id, file, opts }, replies
 * with { id, result } or { id, error }. Uses node:worker_threads so it runs
 * under both Node and Bun.
 */
import { parentPort } from "node:worker_threads";
import { type FileScanOptions, scanFile } from "../scan-file.js";
import type { WalkedFile } from "./fs.js";

parentPort?.on(
  "message",
  async ({ id, file, opts }: { id: number; file: WalkedFile; opts: FileScanOptions }) => {
    try {
      parentPort?.postMessage({ id, result: await scanFile(file, opts) });
    } catch (err) {
      parentPort?.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
  },
);
