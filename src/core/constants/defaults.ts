import type { WysiwygConfig } from "../types.js";

/** Default config when no .wysiwygrc is found */
export const DEFAULT_CONFIG: Readonly<Required<WysiwygConfig>> = {
  expected_scripts: ["Latin"],
  ignore: ["node_modules/**", ".git/**", "dist/**", "build/**", "*.lock"],
  fail_on: "critical",
} as const;

/** Bytes scanned per file (10 MB); larger files are scanned up to this and reported. */
export const MAX_FILE_SIZE = 10 * 1_048_576;

/** Fetch timeout for cloaking detection (ms) */
export const FETCH_TIMEOUT = 10_000;

/** Contrast ratio below which text is treated as invisible (WCAG AA is 4.5:1) */
export const LOW_CONTRAST_THRESHOLD = 1.5;

/** RGB component threshold for "near-white" text when no background is known (0–255) */
export const NEAR_WHITE_THRESHOLD = 250;

/** Preview length for hidden text quoted in finding messages */
export const PREVIEW_SHORT = 80;
