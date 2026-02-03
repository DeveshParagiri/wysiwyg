import type { Finding, ScanResult } from "../types.js";
import { USER_AGENTS, FETCH_TIMEOUT, MIN_CLOAKING_DIFF_CHARS, PREVIEW_LONG, PREVIEW_DETAIL } from "../constants/index.js";
import { diffWords } from "diff";

type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

interface FetchResult {
  agent: string;
  body: string;
  status: number;
  byteLength: number;
  error?: string;
}

/**
 * Normalize HTML response for comparison.
 * Strips dynamic content that changes per request.
 */
export function normalizeResponse(html: string): string {
  let normalized = html;

  // Remove script and style blocks (often contain dynamic hashes/nonces)
  normalized = normalized.replace(/<script[\s\S]*?<\/script>/gi, "");
  normalized = normalized.replace(/<style[\s\S]*?<\/style>/gi, "");

  // Strip CSRF tokens
  normalized = normalized.replace(
    /name=["']csrf[^"']*["']\s+(?:value|content)=["'][^"']*["']/gi,
    "",
  );
  normalized = normalized.replace(
    /(?:value|content)=["'][^"']*["']\s+name=["']csrf[^"']*["']/gi,
    "",
  );

  // Strip nonces
  normalized = normalized.replace(/nonce=["'][^"']*["']/gi, "");

  // Strip session-like IDs in URLs
  normalized = normalized.replace(
    /(?:session|sid|token|nonce|csrf)[_-]?(?:id)?=[\w-]+/gi,
    "",
  );

  // Strip timestamps and cache busters
  normalized = normalized.replace(/[?&](?:t|ts|_|v|cb|cachebuster)=\d+/gi, "");

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

/**
 * Fetch a URL with a specific user-agent string.
 */
async function fetchWithAgent(
  url: string,
  agentName: string,
  agentString: string,
  fetchFn: FetchFn,
  timeout: number,
): Promise<FetchResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetchFn(url, {
      headers: {
        "User-Agent": agentString,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timer);
    const body = await response.text();
    return {
      agent: agentName,
      body,
      status: response.status,
      byteLength: new TextEncoder().encode(body).length,
    };
  } catch (err) {
    return {
      agent: agentName,
      body: "",
      status: 0,
      byteLength: 0,
      error: String(err),
    };
  }
}

/**
 * Compare two responses and produce findings if they differ materially.
 */
export function diffResponses(
  baseline: string,
  variant: string,
  agentName: string,
): Finding[] {
  const findings: Finding[] = [];
  const normalizedBaseline = normalizeResponse(baseline);
  const normalizedVariant = normalizeResponse(variant);

  if (normalizedBaseline === normalizedVariant) {
    return [];
  }

  // Use word-level diff to measure the actual amount of changed content
  const changes = diffWords(normalizedBaseline, normalizedVariant);
  const added: string[] = [];
  const removed: string[] = [];
  let totalChangedChars = 0;

  for (const change of changes) {
    if (change.added) {
      const trimmed = change.value.trim();
      if (trimmed) {
        added.push(trimmed);
        totalChangedChars += trimmed.length;
      }
    }
    if (change.removed) {
      const trimmed = change.value.trim();
      if (trimmed) {
        removed.push(trimmed);
        totalChangedChars += trimmed.length;
      }
    }
  }

  // Filter out trivial diffs
  if (totalChangedChars < MIN_CLOAKING_DIFF_CHARS) {
    return [];
  }

  const addedText = added.join("\n").slice(0, PREVIEW_DETAIL);
  const removedText = removed.join("\n").slice(0, PREVIEW_DETAIL);

  findings.push({
    type: "cloaking",
    severity: "critical",
    message: `Cloaking detected: ${agentName} receives different content`,
    humanView: removedText
      ? `Content removed for ${agentName}: ${removedText.slice(0, PREVIEW_LONG)}`
      : "(same content)",
    agentView: addedText
      ? `Content added for ${agentName}: ${addedText.slice(0, PREVIEW_LONG)}`
      : "(same content)",
    detail: `${added.length} sections added, ${removed.length} sections removed for ${agentName} vs Chrome`,
  });

  return findings;
}

/**
 * Fetch a URL with multiple user-agents and compare responses.
 * Takes a fetch function as parameter for platform agnosticism.
 */
export async function fetchWithAgents(
  url: string,
  fetchFn: FetchFn,
  timeout: number = FETCH_TIMEOUT,
): Promise<ScanResult> {
  const findings: Finding[] = [];
  const results: FetchResult[] = [];

  // Fetch with all user-agents
  const agents = Object.entries(USER_AGENTS);
  for (const [name, ua] of agents) {
    const result = await fetchWithAgent(url, name, ua, fetchFn, timeout);
    results.push(result);
  }

  // Use Chrome as baseline
  const baseline = results.find((r) => r.agent === "chrome");
  if (!baseline || baseline.error) {
    return {
      source: url,
      findings: [
        {
          type: "cloaking",
          severity: "info",
          message: `Could not fetch URL as Chrome: ${baseline?.error ?? "no response"}`,
          humanView: "",
          agentView: "",
        },
      ],
      clean: true,
    };
  }

  // Compare each bot response against Chrome baseline
  for (const result of results) {
    if (result.agent === "chrome") continue;
    if (result.error) continue;

    const diffs = diffResponses(baseline.body, result.body, result.agent);
    findings.push(...diffs);
  }

  return {
    source: url,
    findings,
    clean: findings.length === 0,
  };
}
