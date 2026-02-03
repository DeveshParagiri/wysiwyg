import type { WysiwygConfig } from "../types.js";

/** Default config when no .wysiwygrc is found */
export const DEFAULT_CONFIG: Readonly<Required<WysiwygConfig>> = {
  expected_scripts: ["Latin"],
  ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
  fail_on: "critical",
} as const;

/** File extension to scanner type mapping */
export const FILE_TYPE_MAP = {
  markdown: [".md", ".mdx", ".markdown"],
  html: [".html", ".htm", ".xhtml"],
  pdf: [".pdf"],
} as const;

/** Max file size to scan (bytes) — 1MB */
export const MAX_FILE_SIZE = 1_048_576;

/** Fetch timeout for cloaking detection (ms) */
export const FETCH_TIMEOUT = 10_000;

/** Minimum character difference to flag cloaking (filters trivial diffs) */
export const MIN_CLOAKING_DIFF_CHARS = 10;

/** Contrast ratio threshold for hidden text detection (WCAG AA is 4.5:1; we flag below 1.5:1) */
export const LOW_CONTRAST_THRESHOLD = 1.5;

/** RGB component threshold for "near-white" color detection (0–255 scale) */
export const NEAR_WHITE_THRESHOLD = 250;

/** Number of characters of surrounding context for unicode scanner */
export const UNICODE_CONTEXT_RADIUS = 30;

/** Buffer size (bytes) to check for binary file detection */
export const BINARY_CHECK_BYTES = 8192;

/** Text preview truncation lengths used across scanner output */
export const PREVIEW_SHORT = 80;
export const PREVIEW_MEDIUM = 100;
export const PREVIEW_LONG = 200;
export const PREVIEW_DETAIL = 500;

/** Config file extensions expected to be ASCII-only */
export const ASCII_ONLY_EXTENSIONS = [".json", ".cursorrules", ".mcprc"] as const;

/** Regex for extracting foreground color from inline CSS */
export const CSS_FG_COLOR_RE = /(?:^|;)\s*color\s*:\s*([^;]+)/i;

/** Regex for extracting background color from inline CSS */
export const CSS_BG_COLOR_RE = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i;

/** Regex for matching HTML comments */
export const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
