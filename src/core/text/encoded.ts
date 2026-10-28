import { concealedFinding } from "../policy.js";
import type { Finding } from "../types.js";
import { LineIndex } from "./lines.js";
import { printableRatio } from "./unicode.js";

/**
 * Encoded-text layer: blobs a human reads as noise but a model decodes on
 * sight (base64, hex, escape sequences, numeric entities). Only blobs that
 * decode to natural-language text are reported; hashes, keys and binary data
 * decode to bytes and are ignored.
 */

const BASE64 = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{24,}={0,2}(?![A-Za-z0-9+/=_-])/g;
const HEX = /(?<![0-9a-fA-F])(?:[0-9a-fA-F]{2}){16,}(?![0-9a-fA-F])/g;
const ESCAPES = /(?:\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|&#x?[0-9a-fA-F]+;|%[0-9a-fA-F]{2}){12,}/g;

function looksLikeText(s: string): boolean {
  if (s.length < 12) return false;
  if (printableRatio(s) < 0.95) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(s)) return false;
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= 3;
}

function decodeBase64(s: string): string | null {
  try {
    const bytes = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeEscapes(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function scanEncoded(content: string, opts: { instructionFile?: boolean } = {}): Finding[] {
  const findings: Finding[] = [];
  const idx = new LineIndex(content);
  const seen = new Set<string>();

  const report = (ruleId: string, kind: string, blob: string, decoded: string, offset: number) => {
    if (seen.has(decoded)) return;
    seen.add(decoded);
    const line = idx.lineOf(offset);
    findings.push(
      concealedFinding({
        ruleId,
        type: "encoded",
        concealment: "channel",
        technique: `${kind} blob decodes to text`,
        hiddenText: decoded,
        line,
        column: idx.columnOf(offset),
        offset,
        humanView: blob.length > 60 ? `${blob.slice(0, 59)}…` : blob,
        agentView: decoded,
        instructionFile: opts.instructionFile,
      }),
    );
  };

  for (const m of content.matchAll(BASE64)) {
    const blob = m[0];
    if (/^[0-9a-f]+$/i.test(blob)) continue; // hex: handled below
    if (/base64,$/.test(content.slice(Math.max(0, m.index! - 7), m.index))) continue; // data URI
    const decoded = decodeBase64(blob);
    if (decoded && looksLikeText(decoded)) report("encoded/base64", "Base64", blob, decoded, m.index!);
  }
  for (const m of content.matchAll(HEX)) {
    const decoded = Buffer.from(m[0], "hex").toString("utf-8");
    if (looksLikeText(decoded)) report("encoded/hex", "Hex", m[0], decoded, m.index!);
  }
  for (const m of content.matchAll(ESCAPES)) {
    const decoded = decodeEscapes(m[0]);
    if (looksLikeText(decoded)) report("encoded/escapes", "Escape-sequence", m[0], decoded, m.index!);
  }
  return findings;
}
