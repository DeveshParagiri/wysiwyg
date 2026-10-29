# CLAUDE.md

## What this is

wysiwyg finds content an AI agent reads but a human doesn't see (hidden prompt injection). For every format it computes two projections, the human view and the agent view, and reports the difference. Severity is **concealment × intent** (`src/core/policy.ts`).

## Commands

```bash
bun install
bun test                      # all tests (unit, CLI, red-team corpus, adversarial perf)
bun test tests/core/html.test.ts
bun run lint / bun run format # Biome
bun run typecheck
bun run redteam               # corpus score (bun scripts/redteam.ts <other-checkout> to compare)
bun run dev -- scan <path>    # run from source
bun run build                 # npm package → dist/
bun run build:plugin          # Claude Code plugin bundle → plugin/dist (committed; CI checks it's fresh)
bun run build:binary          # standalone executable
```

## Layout

- `src/core/`: library, no CLI dependencies.
  - `pipeline.ts`: format detection and the per-file pipeline (`scanText`, `scanBytes`).
  - `policy.ts`, `intent.ts`: severity model and intent classification.
  - `text/`: unicode, terminal (emulator), layout, encoded, line helpers.
  - `html/`: CSS cascade (`style.ts`), media queries, the visibility walk (`scan.ts`).
  - `markdown/`: markdown-it render, then the HTML engine.
  - `documents/`: PDF (pdfjs operator list) and OOXML.
  - `fetch/`: cloaking. `mcp/`: MCP client and catalog scan.
  - `constants/agent-files.ts`: agent instruction file locations.
- `src/cli/`: commander CLI, worker pool (`platform/pool.ts`), output (pretty/JSON/SARIF), config trust model, Claude Code hook (`commands/hook.ts`, `commands/session-start.ts`).
- `plugin/`: Claude Code plugin. `.claude-plugin/marketplace.json` makes the repo a marketplace.
- `action.yml`: GitHub Action, which runs `plugin/dist/wysiwyg.mjs`.
- `tests/redteam/`: attack corpus, held-out set, delivery-layer red team.
- `docs/THREAT_MODEL.md`: what the views are, what's covered, what isn't.

## Conventions

- Every hidden-content finding goes through `concealedFinding()`, so severity stays consistent.
- New detections need a red-team case (attack plus benign control) in `tests/redteam/`.
- Anything printed from scanned content goes through `visualize()`.
- Layers must stay linear-time; add an adversarial case to `tests/perf/` for new parsers.
- No Bun-only APIs in `src/`: the npm package runs on Node.
- No literal invisible characters in source; use `\u` escapes.
