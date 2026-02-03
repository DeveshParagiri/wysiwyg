/** Unicode codepoint ranges for detection */
export const UNICODE_RANGES = {
  // Always malicious — encode ASCII invisibly
  tags: { start: 0xe0000, end: 0xe007f, severity: "critical" as const },

  // Zero-width characters — context-dependent
  zeroWidth: [0x200b, 0x200c, 0x200d, 0xfeff, 0x2060] as const,

  // Bidirectional overrides — critical in source code
  bidiOverrides: [0x202a, 0x202b, 0x202c, 0x202d, 0x202e] as const,
  bidiIsolates: [0x2066, 0x2067, 0x2068, 0x2069] as const,

  // Variation selectors — usually benign
  variationSelectors: { start: 0xfe00, end: 0xfe0f },
  variationSelectorsSupp: { start: 0xe0100, end: 0xe01ef },

  // Other invisible characters
  softHyphen: 0x00ad,
  bom: 0xfeff,
  invisibleMath: [0x2061, 0x2062, 0x2063, 0x2064] as const,
} as const;

/** Scripts where ZWJ/ZWNJ are legitimate */
export const JOINING_SCRIPTS = [
  "Arabic",
  "Syriac",
  "Mandaic",
  "Mongolian",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Thai",
  "Tibetan",
  "Myanmar",
] as const;
