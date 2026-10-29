# Detection

What wysiwyg detects, by layer. For the reasoning behind it and what is out of scope, see the [threat model](THREAT_MODEL.md).

| Layer | Techniques |
| --- | --- |
| **Invisible text** | Unicode Tags (ASCII smuggling), variation-selector byte smuggling and two-symbol invisible binary, all decoded. Zero-width and other default-ignorable characters, private-use characters, and bidi overrides and isolates (Trojan Source). Legitimate uses are left alone: flag emoji, emoji ZWJ sequences, joiners in Arabic, Indic and other scripts, and CJK and Thai line-break hints |
| **Terminal** | Text that `cat` never shows: carriage-return and backspace overwrites, cursor movement plus erase, ANSI conceal, foreground matching background, and OSC payloads. Found by rendering with a terminal emulator |
| **Layout** | Instructions pushed off-screen with whitespace (measured in display columns), and payloads after long runs of blank lines |
| **Encoded** | Base64, hex and escape-sequence blobs that decode to prose |
| **HTML / SVG** | A real CSS cascade with stylesheets, specificity, inheritance, and media queries evaluated for a desktop viewport. Detects `display:none`, visibility, opacity, tiny fonts, text matching its background (WCAG contrast against the effective background), transparent text, clip and clip-path, transforms, zero-size boxes, off-screen positioning and screen-reader-only text. Also comments, alt and title text, aria labels that differ from visible text, meta tags, `<template>`, `<noscript>` and collapsed `<details>` |
| **Markdown** | Rendered as GitHub would, then checked with the HTML engine. Also reference-definition comments (`[//]: # (…)`), image alt text and link titles |
| **PDF** | Invisible render modes, and text that matches the background, is transparent or tiny, sits off the page, is covered by shapes, or is in hidden layers. Also metadata and annotations |
| **Word / PowerPoint / Excel** | Hidden (`vanish`), white and tiny runs; hidden slides and shapes; off-slide shapes; hidden and very hidden sheets; hidden rows and columns; `;;;` number formats; speaker notes; comments; alt text; document properties |
| **Delivery** | Content served only to AI clients (user-agent and `Accept` cloaking), instructions in HTTP headers, and `/llms.txt` |
| **MCP** | Tool, parameter, prompt, resource and server-instruction text; overlong descriptions; tool names that collide across servers |
| **Agent instruction files** | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, skills, Cursor, Windsurf, Cline, Roo, Kiro and Copilot rules and prompts, and MCP configs. All of the above apply at stricter severity, plus a short list of injection phrases written in plain sight |
| **Scanner evasion** | NUL bytes, oversized files, symlinks, a repository `.wysiwygrc` that tries to ignore everything, and files built to stall a scanner |

## Severity

Severity combines how the content is hidden with what the hidden text says.

| Hidden… | Addresses the AI | Plain prose | Trivial (labels, lint comments) |
| --- | --- | --- | --- |
| by an encoding with no innocent use (Unicode Tags, variation-selector bytes, invisible binary) | critical | critical | critical |
| from rendering (CSS, PDF render mode, Word `vanish`, terminal overwrite) | critical | warning | info |
| in a place with everyday uses (comments, alt text, metadata, collapsed sections, UI a page's scripts toggle) | critical | info | info |

"Addresses the AI" covers text that tries to override instructions, run commands, exfiltrate secrets, hide actions from the user, or manipulate rankings and reviews. In agent instruction files, hidden prose in places with everyday uses is raised to a warning.

## Accuracy

- **Red-team corpus** (`tests/redteam/cases.ts`): 61 hiding techniques, each tested with an attack payload and a harmless one, plus 15 benign controls. The harmless payloads measure concealment detection separately from phrase matching. All attacks are detected and no control is flagged.
- **Held-out set** (`tests/redteam/holdout.ts`): 39 attacks and benign pages written after the engine, to check that the rules generalize. All pass.
- **Real content:** about 6,500 files, including popular READMEs in 34 languages, about 1,700 agent instruction files (CLAUDE.md, AGENTS.md, skills, Cursor and Copilot rules), MDN, Docusaurus, VitePress and Sphinx docs, rendered websites, papers, reports and Office samples. The scan raised 71 alarms (warning or critical). Every one pointed at text that really was hidden, and none was an attack. Most came from one PDF that repeats a white-on-white running title on every page.

Run `bun run redteam` to score any checkout (`bun scripts/redteam.ts <dir>`), so versions can be compared.
