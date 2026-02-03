// Types
export type {
  Finding,
  FindingType,
  ScanResult,
  Severity,
  WysiwygConfig,
  OutputFormat,
} from "./types.js";

// Constants
export * from "./constants/index.js";

// Scanners
export * from "./scanner/index.js";

// Utilities
export { parseColor, isColorHidden, luminance, isLowContrast } from "./utils/color.js";
export { detectScript, getDominantScript, isJoiningScript } from "./utils/script-detect.js";
