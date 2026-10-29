# Changelog

## 0.2.0

A rewrite around one idea: compute what a human sees and what an agent reads, for every format, and report the difference.

### Detection
- **Measured:** the red-team corpus went from 8/60 attacks detected with 4 of 15 benign files flagged, to 60/60 detected with no false alarms. The same hiding techniques carrying a harmless payload: 60/60. A held-out set written afterwards: 30/30.
- **HTML/SVG:** a CSS cascade engine: stylesheets, specificity, inheritance, media queries, contrast against the effective background, clip/transform/off-screen/zero-size hiding, screen-reader-only text.
- **Markdown** rendered like GitHub, then checked with the HTML engine; reference-definition comments, alt text, link titles.
- **PDF** via the pdfjs operator list. PDF scanning previously never ran under Bun or Node.
- **Word, PowerPoint and Excel** hidden content.
- **Unicode:** variation-selector and invisible-binary smuggling decoded; all default-ignorable and private-use characters; context-aware exemptions (flag emoji, emoji ZWJ, joining scripts, CJK line breaks).
- **Terminal:** overwrite, erase and conceal tricks found by rendering with a terminal emulator.
- **Layout and encoded text:** off-screen padding; base64, hex and escape blobs that decode to prose.
- **Cloaking:** verified detection across current AI clients and Markdown negotiation; header injection; `llms.txt`.
- **MCP:** `wysiwyg mcp` scans server metadata, over stdio or Streamable HTTP.
- **Severity:** concealment × intent. Hidden instructions are critical, hidden prose is a warning, hidden UI chrome is info.

### Ways to use it
- Claude Code plugin with PostToolUse and SessionStart hooks, and a `scan` skill.
- GitHub Action with PR diff scanning and SARIF upload.
- npm package for Node ≥ 20, with a typed library API.
- `wysiwyg render`: the text a human would see, for document pipelines.
- Standalone binaries for Linux, macOS and Windows.

### Robustness
- A repository `.wysiwygrc` can no longer disable a scan. NUL bytes, oversized files and symlinks no longer cause files to be skipped.
- Linear-time scanning under adversarial input, and a per-file time limit.
- Scanned content can't inject ANSI sequences into the report. JSON and SARIF output is no longer truncated at 64 KB on pipes.
- Parallel scanning on all cores. Readable "you see" / "AI reads" output with the hidden span highlighted.

### Breaking changes
- Findings now carry `ruleId`, `technique`, `hiddenText` and `intent`; some `type` values changed.
- `scan [targets...]` is the default command. `--recursive` became `--no-recursive`.
- Oversized files are scanned up to `--max-size` (default 10 MB) instead of being skipped.

## 0.1.2

Initial release.
