# Reference

- [CLI](#cli)
- [Configuration](#configuration)
- [Subcommands](#subcommands)
- [Claude Code](#claude-code)
- [GitHub Action](#github-action)
- [Library](#library)

## CLI

```bash
wysiwyg [paths...] [options]
```

`scan` is the default command, so `wysiwyg .` and `wysiwyg scan .` are the same.

| Flag | Description |
| --- | --- |
| `--diff <ref>` | Only scan files changed since `<ref>` |
| `--staged` | Only scan staged files |
| `--format pretty\|json\|sarif` | Output format (default `pretty`) |
| `--fail-on critical\|warning\|info` | Exit 1 at or above this severity (default `critical`) |
| `-v, --verbose` | Also show info findings |
| `--stdin` | Read content from stdin |
| `--as <name>` | With `--stdin`, treat the input as file `<name>` to choose its format |
| `--clipboard` | Scan the clipboard as both plain text and rich HTML (macOS, Linux) |
| `--max-size <MB>` | Bytes scanned per text file (default 10). Larger files are scanned up to the limit, and the truncation is reported |
| `--config <path>` | Use this `.wysiwygrc`, trusted |
| `--no-config` | Ignore config files |
| `--no-recursive` | Only scan files directly inside a directory |

PDF and Office files are always read whole, up to 256 MB, because their index sits at the end of the file.

Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage or runtime error.

```bash
pbpaste | wysiwyg --stdin --as page.html
```

## Configuration

`.wysiwygrc` (YAML), in the project or your home directory:

```yaml
ignore: ["vendor/**", "*.min.js"]
expected_scripts: [Latin, Arabic]   # joiners in these scripts are expected
fail_on: critical
```

A `.wysiwygrc` inside the scanned tree comes from whoever controls that tree, which in CI may be an attacker. It can narrow a scan but never switch it off: wysiwyg refuses and reports patterns that would ignore everything, and always scans agent instruction files. For a config you trust, pass `--config <path>`. To ignore config files, pass `--no-config`.

## Subcommands

### `fetch`: web pages and cloaking

```bash
wysiwyg fetch https://example.com
```

`fetch` downloads the page several ways and compares the text each one gets:

- **As a browser, twice,** so that content that changes on every load isn't mistaken for cloaking.
- **As current AI clients:** ClaudeBot, Claude-User, ChatGPT-User, GPTBot, OAI-SearchBot, PerplexityBot, Perplexity-User, Googlebot, curl, python-requests and Node.
- **With `Accept: text/markdown`.**

A difference is checked again before it is reported. `fetch` also scans the page itself, its response headers and `/llms.txt`.

### `mcp`: MCP servers

Your MCP client shows you tool names. The model reads every tool description, parameter description, prompt and server instruction, which is where tool poisoning hides.

```bash
wysiwyg mcp -- npx -y @modelcontextprotocol/server-filesystem ~/notes   # stdio
wysiwyg mcp --url https://mcp.example.com/mcp -H "Authorization: Bearer $TOKEN"
wysiwyg mcp --config .mcp.json --yes   # every server in a config file
```

`mcp` only lists metadata and never calls a tool. `--config` starts every command in the file, so it prints them first and requires `--yes`.

### `render`: the text a human sees

```bash
wysiwyg render resume.pdf > resume.txt   # visible text only
wysiwyg render page.html --format json   # { text, kind, removed: [findings] }
```

Use it to give a model exactly what the reviewer saw.

## Claude Code

The plugin registers two hooks and a skill:

- **`PostToolUse`** scans the results of `Read`, `WebFetch`, `WebSearch`, `Bash`, `Grep` and `mcp__*` tools. When something is hidden, it quotes the hidden text and tells Claude not to follow it, and you see a notice.
- **`SessionStart`** scans the instruction files the session will load: the project's `CLAUDE.md`, rules, skills, commands and MCP config, plus your `~/.claude` skills, agents and commands. The search is capped, so even very large monorepos take about a second.
- **`/wysiwyg:scan`** checks a file, folder, URL or MCP server on demand. Claude can also use it on its own when you ask whether something is safe.

The plugin bundles its own copy of the CLI. If the scanner itself fails, the hooks let the tool call through, so your session never breaks.

**Cost.** Each hooked tool call adds about 0.15 s, mostly Node starting up. The scan takes milliseconds for typical results and about 0.05 s for a 100 KB file. Session start adds about 0.5 s.

**Hooking fewer tools.** Edit the `PostToolUse` matcher in the plugin's `hooks/hooks.json`, for example to drop `Grep`.

**Without the plugin.** Add the hooks to `settings.json` yourself:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|WebFetch|WebSearch|Bash|Grep|mcp__.*",
        "hooks": [{ "type": "command", "command": "npx -y wysiwyg-shield hook", "timeout": 30 }]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [{ "type": "command", "command": "npx -y wysiwyg-shield hook", "timeout": 30 }]
      }
    ]
  }
}
```

With a global install (`npm i -g wysiwyg-shield`), `wysiwyg hook` starts faster than `npx -y wysiwyg-shield hook`. Add `--fail-on warning` to also report hidden prose that isn't addressed to the AI.

Recent Claude Code versions can also install in one step: `/plugin install wysiwyg --marketplace deveshparagiri/wysiwyg`.

## GitHub Action

```yaml
- uses: DeveshParagiri/wysiwyg@v0.2.1
  with:
    fail-on: warning
```

| Input | Default | Description |
| --- | --- | --- |
| `paths` | `.` | Files or directories, space-separated |
| `diff` | `auto` | Git ref to diff against. `auto` uses the PR base branch; `""` scans everything |
| `fail-on` | `critical` | `critical`, `warning` or `info` |
| `sarif` | `true` | Upload results to GitHub code scanning (needs `security-events: write`) |
| `args` | | Extra CLI arguments, such as `--no-config` |

Diffing needs the base branch in the checkout, so use `fetch-depth: 0` with `actions/checkout`.

## Library

```ts
import { renderVisible, scanBytes, scanText } from "wysiwyg-shield";

await scanBytes(bytes, { path: "resume.pdf" });   // Buffer or Uint8Array; format chosen from path and content
scanText(html, { path: "page.html" });            // strings
await renderVisible(bytes, { path: "resume.pdf" }); // { text, kind, removed }
```

Each `Finding` has:

| Field | Description |
| --- | --- |
| `ruleId` | Stable identifier, such as `html/hidden-text` |
| `severity` | `critical`, `warning` or `info` |
| `technique` | How the text was hidden |
| `hiddenText` | The hidden content, as the model would read it |
| `intent` | `instruction`, `prose` or `trivial` |
| `line` / `location` | Where it is |
| `humanView` / `agentView` | Snippets of what each side sees |

The package ships with TypeScript types.
