import * as cheerio from "cheerio";
import MarkdownIt from "markdown-it";
import { FETCH_TIMEOUT } from "../constants/index.js";
import { AGENT_CLIENTS, BROWSER, type ClientProfile } from "../constants/user-agents.js";
import { descendants } from "../html/dom.js";
import { classifyIntent } from "../intent.js";
import { scanText } from "../pipeline.js";
import { concealedFinding, isClean } from "../policy.js";
import type { Finding, ScanResult } from "../types.js";

/**
 * Delivery layer: does the server hand agents something different from what
 * a person's browser gets?
 *
 * The page is fetched as a browser (twice) and as each agent profile. The
 * *words* of each response are compared as sets, so markup churn, reordered
 * or rotating content don't matter and Markdown served by content negotiation
 * is comparable to HTML. A difference is re-verified before it is reported:
 * the agent is asked again and the browser a third time, and only text that
 * persists for the agent and never appears for the browser counts. Hidden
 * content on the page itself, instruction-like response headers and the
 * agent-only /llms.txt files are reported too.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  fetchFn?: FetchFn;
  timeout?: number;
  llmsTxt?: boolean;
  /** Max bytes read per response. */
  maxBytes?: number;
}

interface Fetched {
  client: string;
  status: number;
  contentType: string;
  headers: Headers | null;
  body: string;
  error?: string;
}

const MD = new MarkdownIt({ html: true });
const MIN_NOVEL_WORDS = 8;
const MIN_NOVEL_CHARS = 40;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    all.set(c.subarray(0, all.length - off), off);
    off += c.length;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

async function fetchAs(url: string, client: ClientProfile, opts: Required<FetchOptions>): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  try {
    const res = await opts.fetchFn(url, {
      headers: client.headers,
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await readCapped(res, opts.maxBytes);
    return {
      client: client.name,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      headers: res.headers,
      body,
    };
  } catch (err) {
    return {
      client: client.name,
      status: 0,
      contentType: "",
      headers: null,
      body: "",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Text a model would get from a response (HTML → text incl. hidden; Markdown → rendered text). */
export function responseText(body: string, contentType: string): string {
  const isMarkdown = /markdown|text\/plain/i.test(contentType) && !/<html/i.test(body.slice(0, 500));
  const html = isMarkdown ? MD.render(body.replace(/^---\n[\s\S]*?\n---\n/, "")) : body;
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  // Join text nodes with spaces: .text() glues adjacent elements ("Compute" + "AI" → "ComputeAI").
  const parts: string[] = [];
  for (const node of descendants($.root()[0])) {
    if (node.type === "text") parts.push((node as unknown as { data: string }).data);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Structured data and meta content a page serves to everyone (JSON-LD, <meta content>). */
export function metadataText(body: string): string {
  const $ = cheerio.load(body);
  const out: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    out.push($(el).text());
  });
  $("meta[content]").each((_i, el) => {
    out.push($(el).attr("content") ?? "");
  });
  return out.join(" ");
}

/** Strip per-request noise before comparing. */
export function normalizeResponse(text: string): string {
  return text
    .replace(/\b[0-9a-f]{16,}\b/gi, "") // hashes, ids, nonces
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, "") // ISO timestamps
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, "") // clock times
    .replace(/\b\d{10,13}\b/g, "") // epoch values
    .replace(/\s+/g, " ")
    .trim();
}

const tokenize = (text: string) => normalizeResponse(text).split(" ").filter(Boolean);
/** Alphanumeric parts of a word ("default.Read" → ["default", "read"]). */
const parts = (word: string) =>
  word
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** True if `k` is a concatenation of known words ("computeaistorage" = compute+ai+storage). */
function isGlued(k: string, known: Set<string>): boolean {
  if (k.length > 60) return false;
  const ok: boolean[] = [true];
  for (let end = 1; end <= k.length; end++) {
    ok[end] = false;
    for (let start = Math.max(0, end - 25); start < end; start++) {
      if (ok[start] && known.has(k.slice(start, end))) {
        ok[end] = true;
        break;
      }
    }
  }
  return ok[k.length];
}

/**
 * Text in `variant` made of words that never occur in any baseline response,
 * as maximal runs in the variant's own word order. Set-based, so content that
 * is merely reordered or rotated between requests does not count. With
 * `confirm`, a word must also occur there (a second response from the same client).
 */
export function novelText(
  baselines: string[],
  variant: string,
  confirm?: string,
): { text: string; words: number } {
  const known = new Set(baselines.flatMap(tokenize).flatMap(parts));
  const confirmed = confirm === undefined ? null : new Set(tokenize(confirm).flatMap(parts));
  const isNovel = (w: string) => {
    const ps = parts(w);
    return (
      ps.some((p) => !known.has(p) && !isGlued(p, known)) && (!confirmed || ps.every((p) => confirmed.has(p)))
    );
  };
  const runs: string[][] = [];
  let run: string[] = [];
  let words = 0;
  for (const w of tokenize(variant)) {
    if (isNovel(w)) {
      run.push(w);
      words++;
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return { text: runs.map((r) => r.join(" ")).join(" … "), words };
}

/** Compare one agent response against browser baselines. */
export function diffResponses(
  baselines: string | string[],
  variant: string,
  client: string,
  confirm?: string,
): Finding[] {
  const bases = Array.isArray(baselines) ? baselines : [baselines];
  const added = novelText(bases, variant, confirm);
  if (added.words < MIN_NOVEL_WORDS || added.text.length < MIN_NOVEL_CHARS) return [];
  return [
    concealedFinding({
      ruleId: "fetch/cloaking",
      type: "cloaking",
      concealment: "hidden",
      technique: `Served only to ${client}`,
      hiddenText: added.text,
      humanView: "",
      agentView: added.text.slice(0, 300),
      detail: `${added.words} words that no browser response contains`,
    }),
  ];
}

function headerFindings(f: Fetched): Finding[] {
  if (!f.headers) return [];
  const out: Finding[] = [];
  f.headers.forEach((value, name) => {
    if (classifyIntent(value).level !== "instruction") return;
    out.push(
      concealedFinding({
        ruleId: "fetch/header-injection",
        type: "agent_channel",
        concealment: "channel",
        technique: `HTTP response header "${name}" (sent to ${f.client})`,
        hiddenText: value,
        humanView: "",
        agentView: `${name}: ${value}`,
      }),
    );
  });
  return out;
}

/** /llms.txt files are written for agents; scan them like any Markdown document. */
function llmsTxtFindings(body: string): Finding[] {
  return scanText(body, { path: "llms.txt", kind: "markdown" });
}

export async function fetchWithAgents(url: string, options: FetchOptions = {}): Promise<ScanResult[]> {
  const opts: Required<FetchOptions> = {
    fetchFn: options.fetchFn ?? fetch,
    timeout: options.timeout ?? FETCH_TIMEOUT,
    llmsTxt: options.llmsTxt ?? true,
    maxBytes: options.maxBytes ?? 5 * 1048576,
  };
  const [first, second, ...agents] = await Promise.all([
    fetchAs(url, BROWSER, opts),
    fetchAs(url, BROWSER, opts),
    ...AGENT_CLIENTS.map((c) => fetchAs(url, c, opts)),
  ]);

  const findings: Finding[] = [];
  if (first.error || first.status === 0) {
    findings.push({
      ruleId: "fetch/error",
      type: "cloaking",
      severity: "info",
      message: `Could not fetch as a browser: ${first.error ?? "no response"}`,
      humanView: "",
      agentView: "",
    });
    return [{ source: url, findings, clean: true }];
  }

  const baselines = [first, second]
    .filter((b) => !b.error)
    .flatMap((b) => [responseText(b.body, b.contentType), metadataText(b.body)]);

  for (const a of agents) {
    if (a.error) continue;
    if (a.status !== first.status) {
      findings.push({
        ruleId: "fetch/status-differs",
        type: "cloaking",
        severity: "info",
        message: `${a.client} gets HTTP ${a.status}; a browser gets ${first.status}`,
        humanView: "",
        agentView: "",
      });
      if (a.status >= 400) continue;
    }
    findings.push(...headerFindings(a));
    if (!diffResponses(baselines, responseText(a.body, a.contentType), a.client).length) continue;

    // Re-verify: ask the agent again and the browser a third time.
    const client = AGENT_CLIENTS.find((c) => c.name === a.client)!;
    const [again, third] = await Promise.all([fetchAs(url, client, opts), fetchAs(url, BROWSER, opts)]);
    if (!third.error) baselines.push(responseText(third.body, third.contentType));
    if (again.error) continue;
    const persistent = diffResponses(
      baselines,
      responseText(a.body, a.contentType),
      a.client,
      responseText(again.body, again.contentType),
    );
    findings.push(...persistent);
  }
  findings.push(...headerFindings(first));

  // Hidden content on the page itself, as served to a browser
  const isHtml = /html/i.test(first.contentType) || /^\s*<(!doctype|html)/i.test(first.body);
  findings.push(...scanText(first.body, { path: isHtml ? "page.html" : "page.txt" }));

  const results: ScanResult[] = [{ source: url, findings: dedupeByText(findings), clean: false }];

  if (opts.llmsTxt) {
    for (const path of ["/llms.txt", "/llms-full.txt"]) {
      const target = new URL(path, url).toString();
      const res = await fetchAs(target, AGENT_CLIENTS[1], opts);
      if (res.status === 200 && !/html/i.test(res.contentType) && res.body.trim()) {
        results.push({ source: target, findings: llmsTxtFindings(res.body), clean: false });
      }
    }
  }
  for (const r of results) r.clean = isClean(r.findings);
  return results;
}

/** Many agent profiles usually receive the same cloaked text; report it once, naming them all. */
function dedupeByText(findings: Finding[]): Finding[] {
  const clients = new Map<string, { finding: Finding; names: string[] }>();
  const out: Finding[] = [];
  for (const f of findings) {
    const name = /^Served only to ([^:]+):/.exec(f.message)?.[1];
    if (f.ruleId !== "fetch/cloaking" || !f.hiddenText || !name) {
      out.push(f);
      continue;
    }
    const seen = clients.get(f.hiddenText);
    if (seen) {
      seen.names.push(name);
      continue;
    }
    clients.set(f.hiddenText, { finding: f, names: [name] });
    out.push(f);
  }
  for (const { finding, names } of clients.values()) {
    if (names.length > 1)
      finding.message = finding.message.replace(
        `Served only to ${names[0]}`,
        `Served only to ${names.join(", ")}`,
      );
  }
  return out;
}
