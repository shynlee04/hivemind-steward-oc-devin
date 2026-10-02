# Devin ACP docs (vendored snapshot)

The Devin pages this project's wire contract depends on, committed so
OpenCode can attach them as a reference — `docs.devin.ai` is a website, and a
`references` entry must be a local `path` or a Git `repository`.

```sh
bun scripts/fetch-devin-acp-docs.ts           # refresh
bun scripts/fetch-devin-acp-docs.ts --check   # drift only, exit 1 on change
```

Every file carries its source URL and fetch date in an HTML comment. A
snapshot is evidence of what the page said, never proof that it still says it:
for a behavioural claim, re-run `--check`, and for anything load-bearing on
the wire, check the live URL.

## The two directions

`devin` is on both sides of ACP. Reading these pages in the wrong direction is
the easiest mistake to make here.

| Direction | Who is the client | Who is the agent | Docs |
|---|---|---|---|
| **We host Devin** (this project's MVP) | OpenCode TUI via this plugin | `devin acp` subprocess | `cli-acp-*.md` — real ACP clients driving the same subprocess we spawn |
| **Devin hosts an agent** | Devin Desktop | a custom agent we write | `desktop-acp.md`, `desktop-acp-custom.md` |

`desktop-acp-custom.md` is the page that governs the agent side, and its
Limitations section is the part that costs us: **Devin Desktop does not expose
session modes** (publish them as a `session config option` with category
`mode`) and **does not advertise terminal capabilities** (agents self-host
commands and stream output back as `tool_call` updates). The plugin already
sends `terminal:false` for exactly that reason.

## Pages

| File | Source | Read it for |
|---|---|---|
| `desktop-acp.md` | [docs.devin.ai/desktop/acp](https://docs.devin.ai/desktop/acp) | Devin Desktop as an ACP host: launching third-party agents, `~/.windsurf/acp/registry.json`, known-good agents |
| `desktop-acp-custom.md` | [docs.devin.ai/desktop/acp-custom](https://docs.devin.ai/desktop/acp-custom) | Building a custom ACP agent for Devin Desktop: required methods, the prompt-turn lifecycle, the two limitations above |
| `cli-acp-zed.md` | [docs.devin.ai/cli/acp/zed](https://docs.devin.ai/cli/acp/zed) | `devin acp` driven by Zed's Agent Panel |
| `cli-acp-jetbrains.md` | [docs.devin.ai/cli/acp/jetbrains](https://docs.devin.ai/cli/acp/jetbrains) | `devin acp` driven by JetBrains AI Chat |
| `cli-acp-xcode.md` | [docs.devin.ai/cli/acp/xcode](https://docs.devin.ai/cli/acp/xcode) | `devin acp` driven by Xcode; the MCP bridge |
| `cli-reference-commands.md` | [docs.devin.ai/cli/reference/commands](https://docs.devin.ai/cli/reference/commands) | CLI command and flag reference, including the `devin acp` subcommand we spawn |
| `cli-changelog-stable.md` | [docs.devin.ai/cli/changelog/stable](https://docs.devin.ai/cli/changelog/stable) | The wire-drift watch: ACP-surface changes land here before they break us |

## Reading the changelog for drift

`cli-changelog-stable.md` is the only early-warning surface we have. Entries
that move a row in [ADR-003](../../.planning/architecture/ADR-003-capability-surface-map.md)
show up as ACP-keyed bullets. Confirmed movers already in the snapshot:

- `devin acp --model <name>` / `DEVIN_MODEL`, `--cloud`, `--refusal-fallback`
  — the flags `index.ts` already relays as tool options.
- Standard ACP **elicitation** for `ask_user_question` (so Zed can answer) —
  not in the ledger; no row exists, no client handler.
- Typed retryable error when the agent's channel closes, so clients reconnect
  rather than re-prompt.
- ACP resource-link and inline `<ref_file>` URI encoding fixes on Windows.