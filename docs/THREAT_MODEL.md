# Threat model

## The gap

An agent and the person supervising it look at the same artifact through different projections:

- **The human view** is what a renderer shows: a terminal, an editor, GitHub's Markdown, a browser, a PDF viewer, Word, a chat client's MCP tool list.
- **The agent view** is what reaches the model: raw bytes decoded to text, HTML converted to text, PDF text extraction, every OOXML part, full tool metadata.

Anything in the agent view but not in the human view is an unreviewed channel into the model. Hidden prompt injection is an instruction placed in that channel. wysiwyg computes both projections for each format, reports the difference, and rates it by how the content was hidden and what it says.

This framing beats a list of tricks because new tricks are new ways to make the two views differ. Detecting the *difference* (a stylesheet rule, a terminal overwrite, a PDF render mode) generalizes; a list of known payloads does not.

## Where the views diverge

| Layer | Human view | Agent view | Techniques | Coverage |
| --- | --- | --- | --- | --- |
| Encoding | Glyphs that render | Every code point | Unicode Tags, variation-selector bytes, invisible binary, zero-width/default-ignorable, private use, bidi controls | Decoded where possible. Legitimate uses are recognised (flag emoji, emoji ZWJ, joining scripts, CJK line breaks, RTL marks in RTL text) |
| Terminal | The screen after control sequences | Every byte | CR/BS overwrite, cursor movement + erase, SGR conceal, fg = bg, OSC payloads | Rendered with a terminal emulator; lost characters tracked during rendering |
| Layout | The visible viewport | The whole line or file | Whitespace padding past the edge; content far below the fold | Display-width measurement (tabs to 8); trailing payload after blank lines |
| Encoding as obfuscation | Noise | Decoded text | Base64, hex, `\u`/`\x`/entity/percent escapes | Reported when the decoded text is prose (channel) |
| HTML / SVG | The rendered page | Text extraction, attributes | Inline and stylesheet CSS hiding, contrast, clip, transform, off-screen, sr-only, `hidden`, `<template>`, `<noscript>`, closed `<details>`, comments, alt/title/aria/meta | Cascade with specificity, inheritance, `!important`, media queries for a desktop viewport; effective background for contrast |
| Markdown | GitHub/VS Code rendering | Raw source | Embedded HTML hiding, comments, reference-definition comments, alt text, link titles | Rendered with markdown-it (raw HTML allowed), then the HTML engine |
| PDF | Rendered pages | Text extraction | Render mode 3/7, white/transparent, tiny, off-page, covered by shapes, hidden optional-content layers, metadata, annotations | Operator-list walk with graphics-state tracking |
| OOXML | Word/PowerPoint/Excel UI | Every XML part | `w:vanish`, white/tiny runs, hidden slides/shapes, off-slide shapes, hidden/veryHidden sheets, hidden rows/cols, `;;;` formats, notes, comments, alt text, properties | Style inheritance resolved for DOCX; slide geometry for PPTX |
| Delivery | What a browser receives | What an AI client receives | User-agent cloaking, `Accept: text/markdown` cloaking, header injection, `llms.txt` | Browser fetched twice as a dynamic-content baseline; differences re-verified before reporting |
| Tool metadata | Tool names in the client | Full descriptions, schemas, prompts, server instructions | MCP tool poisoning, hidden content in descriptions, name collisions | stdio and Streamable HTTP; lists only, never calls tools |
| Copy/paste | Plain-text paste | Rich HTML flavour | Hidden spans in copied HTML | HTML engine on the clipboard flavour, plus HTML-only text |
| Instruction files | The file as reviewed in a PR | Loaded into every agent turn | All of the above inside `CLAUDE.md`, skills, rules, MCP config | Stricter severity; scanned at Claude Code session start by the plugin |

## Severity: concealment × intent

Concealment alone over-reports: real sites hide menus, modals and cookie banners, documents have comments, and Excel workbooks hide helper rows. Intent alone is unreliable: documentation legitimately says "run this command". Severity combines the two:

- **Concealment.**
  - *Smuggling:* an encoding with no innocent use.
  - *Hidden:* the renderer never shows it.
  - *Channel:* a place with everyday uses, such as comments, alt text, metadata, collapsed UI, UI toggled by a page's scripts, or hidden sheets that are one click from view.
  - *Evasion:* arranged to make tools skip the file.
- **Intent** of the hidden text.
  - *Instruction:* addresses an agent or tries to make it act, including overriding instructions, running commands, exfiltrating data, secrecy from the user, and manipulating evaluations.
  - *Prose:* ordinary natural-language text.
  - *Trivial:* labels and tooling directives.

The intent patterns are applied only to hidden content. That is what keeps them precise enough to drive severity. They were calibrated against Wikipedia, documentation sites and `llms-full.txt` dumps.

## The scanner as a target

A security scanner in CI is itself an attack surface:

| Attack on the scanner | Mitigation |
| --- | --- |
| A repository `.wysiwygrc` that ignores everything | Configs inside the scanned tree are untrusted. Overbroad patterns are refused and reported, and agent instruction files can never be ignored |
| A NUL byte so the file looks binary | Text with a few NULs is scanned and the NULs are reported. Binary means NUL-heavy or invalid UTF-8; control-character padding never makes a file binary |
| A file padded past the size limit | The head is scanned and the truncation reported, never silently passed |
| A symlinked instruction file pointing outside the tree | Symlinks are followed, as agents follow them, with cycle protection |
| Inputs crafted to be quadratic | Linear-time algorithms in every layer; adversarial performance tests with time budgets; a per-file time limit in the worker pool reports a stalled file instead of hanging |
| ANSI sequences that rewrite the report | Every string from scanned content is escaped before printing |
| Truncated machine-readable output | Output is flushed before exit; exit codes never cut a pipe short |

## Out of scope

- **Visible instructions.** Instructions anyone can read are a policy question, not a perception gap. Agent instruction files get a short phrase check; use a config linter for the rest.
- **Images.** Text in images, steganography, and visual prompt injection aimed at multimodal models.
- **Client-side rendering.** Content a page adds or removes with JavaScript after load. `fetch` compares server responses.
- **Authenticated or IP-targeted cloaking.** Responses behind logins, or tailored to a provider's crawler IP ranges.
- **Fonts that remap glyphs.** A custom font that draws one character as another (HTML `@font-face`, embedded PDF fonts).
- **Hook enforcement.** The Claude Code hook annotates tool results for the model and the user; the original content still reaches the model.
- **Semantic attacks without concealment.** Persuasive but visible text.

## Measuring it

- **Red-team corpus** (`tests/redteam/cases.ts`): one file per technique plus benign controls. Each attack also runs with a neutral payload to measure concealment detection separately from phrase matching.
- **Held-out set** (`tests/redteam/holdout.ts`): attacks and benign pages written after the engine.
- **Delivery-layer red team** (`tests/redteam/fetch.test.ts`): a local server that cloaks by user-agent and by Markdown negotiation, injects headers, and serves rotating content that must not be flagged.
- **Adversarial performance** (`tests/perf/`): inputs built to trigger worst-case behaviour, each with a time budget.

`bun run redteam` scores any checkout, so versions can be compared.
