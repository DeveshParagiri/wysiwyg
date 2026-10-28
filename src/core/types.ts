/** Severity levels for findings */
export type Severity = "critical" | "warning" | "info";

/** Coarse finding groups (one per detection layer) */
export type FindingType =
  | "unicode_tags" // U+E0000–U+E007F smuggling
  | "unicode_smuggling" // variation-selector or invisible-binary encodings
  | "zero_width" // zero-width / default-ignorable / private-use characters
  | "bidi_override" // bidi embeddings, overrides, isolates, marks
  | "variation_selector" // stray variation selectors
  | "terminal" // ANSI escapes, CR/BS overwrites
  | "layout" // content pushed out of view (whitespace padding)
  | "encoded" // base64/hex blobs that decode to text
  | "hidden_rendered" // rendered formats: text styled out of view
  | "html_comment" // comments and other agent-only markup channels
  | "document_hidden" // PDF / Office hidden content
  | "cloaking" // different content per client
  | "agent_channel" // channels only agents read (llms.txt, headers, tool descriptions)
  | "config_injection" // visible injection phrase in an agent instruction file
  | "clipboard_hidden" // rich clipboard hides content the plain text lacks
  | "scanner_evasion"; // content arranged to make scanners skip it

/**
 * How the content is concealed. Drives severity together with intent.
 *
 *   smuggling — an encoding with no innocent reading (Unicode Tags, VS bytes, invisible binary)
 *   hidden    — rendered out of view (CSS, PDF render mode, w:vanish, terminal overwrite)
 *   channel   — a place humans rarely look but with everyday legitimate uses
 *               (comments, alt/title, metadata, collapsed sections, encoded blobs)
 *   evasion   — arranged to make tooling skip or misread the file
 */
export type Concealment = "smuggling" | "hidden" | "channel" | "evasion";

/** What the concealed text looks like (see core/intent.ts). */
export type IntentLevel = "instruction" | "prose" | "trivial";

/** A single finding from any scanner */
export interface Finding {
  ruleId: string; // stable id, e.g. "html/css-hidden"; used for SARIF and docs
  type: FindingType;
  severity: Severity;
  line?: number; // 1-indexed line in the source, when known
  column?: number; // 1-indexed column, when known
  offset?: number; // character offset, when known
  location?: string; // non-line locations: "page 2", "slide 3", "sheet Notes"
  message: string; // one-line description
  hiddenText?: string; // the concealed content, as the model would read it
  intent?: IntentLevel;
  humanView: string; // what the human sees
  agentView: string; // what the agent sees
  detail?: string; // technique detail (codepoints, CSS rule, PDF operator…)
}

/** Result of scanning a single source */
export interface ScanResult {
  source: string; // file path, URL, or "clipboard"/"stdin"
  findings: Finding[];
  clean: boolean; // true if no findings at warning or above
}

/** .wysiwygrc config schema */
export interface WysiwygConfig {
  expected_scripts?: string[]; // ["Latin", "Arabic"]
  ignore?: string[]; // glob patterns to skip
  fail_on?: "critical" | "warning" | "info";
}

/** CLI output format */
export type OutputFormat = "pretty" | "json" | "sarif";
