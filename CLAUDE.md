# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**wysiwyg-agent-shield** — A CLI tool that diffs what humans see vs what AI agents process, exposing hidden prompt injection payloads before they reach your agent. It implements a 5-layer scanning architecture to detect invisible Unicode encoding, rendered content hiding, agent-targeted server-side cloaking, config file poisoning, and clipboard integrity issues.

## Commands

```bash
# Install dependencies
bun install

# Run from source (development)
bun run dev scan <file-or-dir>
bun run dev fetch <url>

# Type-check
bun typecheck

# Run all tests
bun test

# Run a single test file
bun test tests/core/unicode.test.ts

# Generate test fixtures
bun tests/fixtures/generate.ts

# Build standalone binary
bun build --compile --minify src/cli/cli.ts --outfile dist/wysiwyg

# Build for npm (Node.js target)
bun build --target=node --outdir dist src/cli/cli.ts
```

## Architecture

The codebase is split into two layers: a **CLI interface** (`src/cli/`) and a **reusable core engine** (`src/core/`).

### Core Scanning Engine (`src/core/`)

Five scanner modules, each detecting a different attack vector:

1. **`scanner/unicode.ts`** — Detects invisible Unicode: Tags (U+E0000–E007F), zero-width chars, bidi overrides, variation selectors, invisible math operators. Context-aware severity using 19-script detection (`utils/script-detect.ts`) — zero-width chars in Arabic/Devanagari are legitimate, in Latin they're suspicious.

2. **`scanner/rendered.ts`** — Renders Markdown/HTML/PDF to visible text, then diffs rendered vs raw content. Detects CSS-based hiding (display:none, opacity:0, font-size:0, white-on-white text via WCAG contrast analysis in `utils/color.ts`), and HTML comments containing instructions.

3. **`scanner/cloaking.ts`** — Fetches URLs with 6 different user-agents (browser, ClaudeBot, ChatGPT-User, etc.), normalizes responses (strips dynamic content like CSRF tokens, timestamps), and word-level diffs to detect agent-targeted content injection. Threshold: >10 chars material change = critical.

4. **`scanner/configfile.ts`** — Scans known AI config files (.cursorrules, .claude/settings.json, mcp.json, .github/copilot-instructions.md, etc.) for non-ASCII characters and 10 prompt injection regex patterns.

5. **`scanner/clipboard.ts`** — Reads system clipboard as both plain text and rich HTML. Parses inline CSS to detect rendering-layer hiding. Platform-specific: macOS (osascript/pbpaste), Linux (xclip/xsel).

### CLI Layer (`src/cli/`)

- **`cli.ts`** — Commander.js entry point with `scan` and `fetch` commands
- **`commands/scan.ts`** — Orchestrates file/dir/stdin/clipboard scanning through layers 1, 2, 4, 5
- **`commands/fetch.ts`** — Orchestrates URL cloaking detection through layer 3
- **`config/loader.ts`** — Loads `.wysiwygrc` (YAML) for expected_scripts, ignore patterns, fail_on threshold
- **`output/formatter.ts`** — Pretty terminal output (box-drawing, word-level diff highlighting) and JSON output
- **`platform/clipboard.ts`** — OS-specific clipboard access
- **`platform/fs.ts`** — Recursive directory walking, glob matching, binary detection

### Key Types (`src/core/types.ts`)

Every scanner produces `Finding` objects with `type`, `severity` (critical/warning/info), `humanView` (what a user sees), and `agentView` (what an LLM tokenizes). Results aggregate into `ScanResult` with a `clean` boolean.

### Constants (`src/core/constants/`)

Detection patterns and thresholds are centralized here: Unicode ranges, AI bot user-agent strings, known config file paths, CSS hiding indicators, and default configuration values.

## Testing

Tests use Bun's built-in test runner. Test fixtures in `tests/fixtures/` contain real injection payloads (Unicode Tags, zero-width chars, bidi overrides, hidden HTML/CSS, poisoned config files). The fixture generator (`tests/fixtures/generate.ts`) creates these programmatically.

## Key Design Decisions

- **Severity is context-aware**: The same Unicode character gets different severity depending on the surrounding script. Zero-width joiners in Arabic text are `info`, in Latin text they're `warning`, Unicode Tags are always `critical`.
- **Cloaking normalization**: Response comparison strips dynamic content (timestamps, session IDs, CSRF tokens, nonces) to avoid false positives.
- **Exit codes**: 0 = clean, 1 = findings at/above threshold, 2 = error. The `--fail-on` flag controls the threshold (critical/warning/info).
- **File scanning limits**: 1 MB max file size, binary files detected by null bytes in first 8KB and skipped.
