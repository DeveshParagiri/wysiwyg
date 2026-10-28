import type { IntentLevel } from "./types.js";

/**
 * Intent analysis for concealed text.
 *
 * wysiwyg's job is the perception gap, not judging visible text. But the same
 * concealment can be innocent (a hidden dropdown menu, a lint directive in a
 * comment) or an attack (hidden "ignore previous instructions"). These
 * patterns are only applied to content a human would not see, which is what
 * keeps them precise enough to drive severity.
 */

/**
 * Phrases that address an agent or try to make it act.
 *
 * Calibrated against real documentation (Wikipedia, docs sites, llms-full.txt
 * dumps): bare mentions of "system prompt", "user agent should", "use this
 * tool" or "send the cookies" are ordinary prose and must not match.
 */
const RAW_PATTERNS: readonly RegExp[] = [
  // Override / jailbreak
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|system)\b[^.\n]{0,20}\b(instructions?|rules|guidelines|prompts?|directives|constraints)\b/i,
  /\byou are now (an? |no longer |free |unrestricted |jailbroken |in (developer|god|dan|unrestricted) mode)/i,
  /\b(here are |these are )?(your )?new (system )?instructions?\s*[:-]/i,
  /\b(reveal|print|output|repeat|show|leak|disclose|ignore)\b[^.\n]{0,30}\b(your|the) system\s*prompt\b/i,
  /\b(developer|god|dan|jailbreak|unrestricted) mode\b/i,
  /\b(pretend|roleplay)\b[^.\n]{0,20}\b(you are|to be)\b/i,
  // Addressing the model
  /\b(ai|llm|ai agent|coding agent|language model|ai model|ai assistant|chatbot|claude|chatgpt|gpt-?\d|gemini|copilot)s?\b[^.\n]{0,40}\b(must|shall|needs? to|is required to|are required to|should always|should never)\b/i,
  /\b(note|message|instructions?|reminder) (to|for) (the |any )?(ai|llm|assistant|ai agent|language model|bot|reviewer|summari[sz]er)s?\b/i,
  /\bif you are an? (ai|llm|language model|assistant|ai agent|bot)\b/i,
  /<\/?(important|system|instructions?|admin|sudo)>/i,
  /\[(system|inst|\/inst)\]/i,
  /^\s*(system|assistant)\s*:/im,
  // Secrecy from the user
  /\b(do not|don't|never)\s+(tell|inform|mention|reveal|disclose|alert|notify|show)\b[^.\n]{0,30}\b(the user|the human|anyone|the developer)\b/i,
  /\bwithout\s+(telling|informing|asking|notifying|alerting)\s+(the )?(user|human|developer|them)\b/i,
  // Command execution
  /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]{0,160}\|\s*(ba|z|da)?sh\b/i,
  /\bbase64\s+(-d|--decode)\b[^\n]{0,40}\|\s*(ba|z|da)?sh\b/i,
  /\brm\s+-rf\s+[/~$]/i,
  /\bpowershell(\.exe)?\s+-(e|enc|encodedcommand)\b/i,
  /\b(execute|run) (this|the following|these) (command|commands|code|script) (now|immediately|silently|without)\b/i,
  /\b(call|invoke) the [\w.-]+ tool\b/i,
  // Exfiltration: secret + destination
  /\b(send|post|upload|exfiltrate|forward|transmit|leak|append)\b[^.\n]{0,60}\b(\.env|ssh keys?|id_rsa|credentials?|api[ _-]?keys?|secrets?|access tokens?|passwords?|private keys?|conversation|chat history)\b[^.\n]{0,60}\bto\s+(https?:\/\/|(this|the following|my|our|an?) (url|endpoint|server|address|email|webhook)\b|webhook\b)/i,
  /\b(read|cat|open|print)\b[^.\n]{0,30}(~\/\.ssh|\.env\b|\.aws\/|\.npmrc|\.netrc|id_rsa|\.git-credentials)/i,
  /!\[[^\]]*\]\(https?:\/\/[^)]*\{[^)]*\}/, // markdown image exfil template
  // Evaluation manipulation (résumés, papers, reviews)
  /\b(give|write|provide|leave)\b[^.\n]{0,20}\b(positive|favou?rable|glowing) (review|rating|assessment|recommendation|evaluation)\b/i,
  /\b(rank|rate|score|recommend|select|hire|approve|shortlist)\b[^.\n]{0,30}\b(this (candidate|applicant|paper|product|submission|resume|résumé)|me)\b/i,
];

/** `[^.\n]` keeps a match inside one sentence; let it cross dots in paths and URLs (no space after). */
const IN_SENTENCE = "(?:[^.\\n]|\\.(?=\\S))";
export const INSTRUCTION_PATTERNS: readonly RegExp[] = RAW_PATTERNS.map(
  (re) => new RegExp(re.source.replaceAll("[^.\\n]", IN_SENTENCE), re.flags),
);

/** Hidden text that is routine tooling or site chrome. */
const BOILERPLATE = new RegExp(
  "^\\s*(" +
    [
      "markdownlint",
      "prettier-ignore",
      "eslint",
      "stylelint",
      "textlint",
      "vale",
      "cspell",
      "spell-?checker",
      "lint",
      "@ts-",
      "istanbul",
      "c8 ",
      "todo",
      "fixme",
      "xxx",
      "hack",
      "#?region",
      "#?endregion",
      "begin",
      "end",
      "start",
      "stop",
      "generated",
      "auto-?generated",
      "this (file|section|page) (is|was) (auto(matically)?[- ]?)?generated",
      "do not edit",
      "spdx-license",
      "copyright",
      "\\(c\\)",
      "license",
      "toc",
      "table of contents",
      "omit in toc",
      "more",
      "readmore",
      "alex",
      "allcontributors",
      "all-contributors",
      "badges?",
      "doctoc",
      "insert",
      "section",
      "skip to",
      "menu",
      "close",
      "open",
      "loading",
      "cookie",
      "accept",
      "subscribe",
      "search",
      "toggle",
      "navigation",
      "back to top",
    ].join("|") +
    ")",
  "i",
);

export interface IntentResult {
  level: IntentLevel;
  /** The phrase that triggered "instruction", for display. */
  match?: string;
}

/**
 * Classify concealed text.
 *   instruction — addresses an agent or asks it to act
 *   prose       — meaningful natural language (≥ 5 words or ≥ 30 letters)
 *   trivial     — short labels, lint directives, site chrome
 */
export function classifyIntent(text: string): IntentResult {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return { level: "trivial" };

  for (const re of INSTRUCTION_PATTERNS) {
    const m = re.exec(t);
    if (m) return { level: "instruction", match: m[0].trim() };
  }

  const words = t.split(" ").filter((w) => /\p{L}{2,}/u.test(w)).length;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (BOILERPLATE.test(t) && words <= 12) return { level: "trivial" };
  if (words >= 5 || letters >= 30) return { level: "prose" };
  return { level: "trivial" };
}
