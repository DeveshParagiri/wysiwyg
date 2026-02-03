/** CSS properties that indicate hidden content */
export const HIDDEN_CSS_INDICATORS = {
  displayNone: /display\s*:\s*none/i,
  visibilityHidden: /visibility\s*:\s*hidden/i,
  opacityZero: /opacity\s*:\s*0(?:[;\s]|$)/i,
  fontSizeZero: /font-size\s*:\s*0(?:px|em|rem|pt)?(?:[;\s]|$)/i,
  clipHidden: /clip\s*:\s*rect\(0/i,
  positionOffscreen: /(?:left|top)\s*:\s*-\d{4,}px/i,
} as const;

/** Color values likely indicating hidden text */
export const HIDDEN_COLOR_KEYWORDS = [
  "white",
  "transparent",
  "#fff",
  "#ffffff",
  "#fefefe",
  "#fdfdfd",
  "#fcfcfc",
  "rgb(255,255,255)",
  "rgb(255, 255, 255)",
  "rgba(0,0,0,0)",
  "rgba(255,255,255,0)",
] as const;
