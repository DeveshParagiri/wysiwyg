/**
 * Public library API. Everything here works without the CLI, so agents and
 * hooks can scan content in-process before it reaches a model.
 */

export { analyzeClipboardHTML } from "./clipboard.js";

export * from "./constants/index.js";
export { diffResponses, fetchWithAgents, normalizeResponse, responseText } from "./fetch/cloaking.js";
export { scanHtml } from "./html/scan.js";
export { classifyIntent, INSTRUCTION_PATTERNS } from "./intent.js";
export { scanMarkdown } from "./markdown/scan.js";
// Pipeline
export { type DocKind, decodeText, detectKind, type ScanOptions, scanBytes, scanText } from "./pipeline.js";
export { concealedFinding, isClean, meetsThreshold, severityFor } from "./policy.js";
export { type RenderedDocument, type RenderOptions, renderVisible, renderVisibleText } from "./render.js";
export { scanEncoded } from "./text/encoded.js";
export { scanLayout } from "./text/layout.js";
export { stripInvisible, visualize } from "./text/lines.js";
export { renderTerminal, scanTerminal } from "./text/terminal.js";
// Layers
export {
  decodeInvisibleBinary,
  decodeUnicodeTags,
  decodeVariationSelectors,
  scanUnicode,
} from "./text/unicode.js";
export type {
  Concealment,
  Finding,
  FindingType,
  IntentLevel,
  OutputFormat,
  ScanResult,
  Severity,
  WysiwygConfig,
} from "./types.js";
// Utilities
export { contrastRatio, isColorHidden, isLowContrast, luminance, parseColor } from "./utils/color.js";
export { detectScript, getDominantScript, isJoiningScript } from "./utils/script-detect.js";
