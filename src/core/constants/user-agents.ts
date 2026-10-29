/**
 * Clients used for cloaking detection. The browser profile is the human
 * baseline; every other profile is something an agent pipeline sends.
 */
export interface ClientProfile {
  name: string;
  headers: Record<string, string>;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

const bot = (name: string, ua: string): ClientProfile => ({
  name,
  headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
});

export const BROWSER: ClientProfile = {
  name: "browser",
  headers: { "User-Agent": BROWSER_UA, Accept: BROWSER_ACCEPT, "Accept-Language": "en-US,en;q=0.9" },
};

export const AGENT_CLIENTS: ClientProfile[] = [
  bot(
    "ClaudeBot",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  ),
  bot(
    "Claude-User",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
  ),
  bot(
    "ChatGPT-User",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  ),
  bot(
    "GPTBot",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
  ),
  bot(
    "OAI-SearchBot",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  ),
  bot(
    "PerplexityBot",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  ),
  bot(
    "Perplexity-User",
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
  ),
  bot("Googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
  bot("curl", "curl/8.7.1"),
  bot("python-requests", "python-requests/2.32.3"),
  bot("node-fetch", "node"),
  // Same browser identity, but asking for Markdown (content negotiation used by agent-friendly sites)
  {
    name: "markdown-negotiation",
    headers: { ...BROWSER.headers, Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.5" },
  },
];

/** v0.1 export: name → User-Agent string. */
export const USER_AGENTS: Record<string, string> = Object.fromEntries(
  [BROWSER, ...AGENT_CLIENTS].map((c) => [c.name, c.headers["User-Agent"]]),
);
