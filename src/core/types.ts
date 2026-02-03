/** Severity levels for findings */
export type Severity = "critical" | "warning" | "info";

/** Finding types corresponding to each scanning layer */
export type FindingType =
  | "unicode_tags"        // U+E0000–U+E007F
  | "zero_width"          // U+200B, U+200C, U+200D, U+FEFF
  | "bidi_override"       // U+202A–U+202E, U+2066–U+2069
  | "variation_selector"  // U+FE00–U+FE0F, U+E0100–U+E01EF
  | "hidden_rendered"     // display:none, visibility:hidden, etc.
  | "html_comment"        // <!-- hidden content -->
  | "cloaking"            // different content per user-agent
  | "config_non_ascii"    // non-ASCII in ASCII-expected config
  | "config_obfuscated"   // instruction pattern + obfuscation
  | "clipboard_hidden";   // rendering-layer hiding in clipboard

/** A single finding from any scanner */
export interface Finding {
  type: FindingType;
  severity: Severity;
  line?: number;          // line number (1-indexed) if applicable
  offset?: number;        // character offset if applicable
  message: string;        // human-readable description
  humanView: string;      // what the human sees
  agentView: string;      // what the agent sees
  detail?: string;        // additional context (codepoint info, CSS property, etc.)
}

/** Result of scanning a single source */
export interface ScanResult {
  source: string;         // file path, URL, or "clipboard"/"stdin"
  findings: Finding[];
  clean: boolean;         // true if no findings
}

/** .wysiwygrc config schema */
export interface WysiwygConfig {
  expected_scripts?: string[];    // ["Latin", "Arabic"]
  ignore?: string[];              // glob patterns to skip
  fail_on?: "critical" | "warning" | "info";
}

/** CLI output format */
export type OutputFormat = "pretty" | "json";
