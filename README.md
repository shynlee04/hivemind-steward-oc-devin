# hivemind-steward-oc-devin

An [OpenCode V2](https://opencode.ai/v2/docs) plugin that lets you delegate work to [Devin](https://devin.ai) sessions from inside the OpenCode TUI — the reverse direction of `opencode acp` / `devin acp` (both of which only *serve* ACP to editors).

Requires: Devin CLI installed and authenticated (`devin auth login`), OpenCode V2.

## What it adds

### Hosted Devin session (TUI route)

`/devin` (or palette: **Devin: open session**) opens a full-screen Devin view inside the OpenCode TUI — a real `devin acp` session hosted in a plugin route:

- **Session picker**: an unbound lane lists every session on your Devin account — including ones started in Devin Desktop or the CLI — with title, directory, last-active time, and a lock badge for sessions held by a live client. Pick one to continue it with full replayed history, or take `+ New session`.
- **Continuation**: `session/load` replays the prior conversation into the entry log — your prompts, Devin's replies, thoughts, tool calls, plans — then the session is live for new prompts.
- **Session swap**: **ctrl+o** reopens the picker over a live session and re-binds on the same engine; busy lanes refuse politely.
- **File mentions**: type `@` in the composer for live file completion; `@path` tokens resolve to `resource_link` content blocks Devin reads natively.
- **Devin's slash commands**: **ctrl+g** lists the bound session's advertised commands; picking inserts `/<name> ` into the composer.
- Streams Devin's messages, thoughts, tool calls, and plan updates live
- Devin permission requests surface as inline numbered cards (allow/reject per call)
- Devin's own pickers: **ctrl+m** model (all ~110 Devin models incl. SWE-2, Claude, GPT, Gemini, Grok, Kimi, GLM), **ctrl+e** session mode (Code/Smart/Ask/Plan/Bypass), **ctrl+t** thinking level
- `/devin <task>` jumps straight in with a new session and sends the task
- Wire errors render readable entries (rate limits, quota, auth — with `devin auth login` hints where relevant); `_cognition.ai/*` connection noise is filtered
- **ctrl+x** cancels the in-flight prompt, **esc** returns home — the Devin session stays alive in the background and re-mounts intact

### Delegation tools (agent-facing)

| Surface | Name | What it does |
|---|---|---|
| Tool | `devin_run` | One-shot headless task via `devin -p`. Returns Devin's final output. |
| Tool | `devin_session` | Persistent Devin session over ACP (`devin acp` subprocess). Actions: `start`, `send`, `status`, `cancel`, `close`. Devin keeps its own conversation context between `send`s. |
| Command | `/devin_delegate <task>` | Ask the OpenCode agent to delegate via `devin_run`; `/devin_delegate session <task>` uses the persistent lane. |

Both lanes accept `model`, `cloud` (relay to Devin Cloud instead of the local agent), and working-directory overrides. `devin_session` additionally accepts `agent_type` (`summarizer`, `review`), `refusal_fallback` (comma-separated models for provider refusals), `auto_approve` (permission auto-accept, default false — see SECURITY.md), and `name` to run parallel Devin lanes.

## Install

**Requirements**

- OpenCode V2 — `opencode` v2.x on PATH. A V1 host cannot load the plugin's TUI entry.
- Devin CLI — `devin` on PATH, or set `DEVIN_BIN` to the binary's path. Authenticate with `devin auth login`.

The plugin uses the discovered-plugin layout (`index.ts` at the package root), so it works at any scope unchanged.

### One-command install (`npx`)

The package ships a `bin` installer that verifies both clients, then writes the plugin entry into your OpenCode config (JSONC-safe, comment-preserving, idempotent):

```bash
npx hivemind-steward-oc-devin                  # global scope (~/.config/opencode/opencode.json)
npx hivemind-steward-oc-devin --project        # project scope (<cwd>/opencode.json)
npx hivemind-steward-oc-devin --project /path/to/repo
npx hivemind-steward-oc-devin --check          # prerequisites only, writes nothing
```

It fails fast with instructions when a client is missing: exit 1 if `opencode` is absent or not v2, exit 2 if `devin`/`DEVIN_BIN` is absent (pass `--force` to wire anyway). `--spec github:shynlee04/hivemind-steward-oc-devin` installs from the repo instead of the npm name.

### From a package spec

**Global** (every OpenCode session):

```bash
opencode plugin add hivemind-steward-oc-devin
# or straight from the repo:
opencode plugin add github:shynlee04/hivemind-steward-oc-devin
```

Or declare it in `plugins` yourself — entries accept npm specs, `github:owner/repo`, absolute paths, and `file://` URLs:

```jsonc
// ~/.config/opencode/opencode.json — global user scope
{
  "plugins": ["hivemind-steward-oc-devin"]
}
```

```jsonc
// <project>/opencode.json — project scope (a <project>/.opencode/ dir works too)
{
  "plugins": ["github:shynlee04/hivemind-steward-oc-devin"]
}
```

### Local checkout (development)

**Global**:

```bash
ln -s /path/to/hivemind-steward-oc-devin ~/.config/opencode/plugins/hivemind-steward-oc-devin
# or copy the directory instead of symlinking
```

**Project** (one repo only):

```bash
ln -s /path/to/hivemind-steward-oc-devin /path/to/project/.opencode/plugins/hivemind-steward-oc-devin
```

**Explicit** (any location) — add to `opencode.json` / `cli.json`:

```jsonc
{
  "plugins": ["/absolute/path/to/hivemind-steward-oc-devin"]
}
```

Disable per-scope without uninstalling via the `-` prefix: `"plugins": ["-hivemind-steward-oc-devin"]`, or toggle it from the TUI plugins control.

Restart OpenCode (or start a new session) after installing. **Verify it worked**: run `/devin` in the TUI (or **Devin: open session** from the command palette) — the session picker listing your Devin sessions is success. If the `devin` binary is missing, the plugin renders a guidance entry instead of dying silently.

**Agent-facing note**: an agent installing this should verify both binaries first — `opencode --version` (must be v2.x) and `command -v devin` (or `DEVIN_BIN`) — before wiring the plugin spec; otherwise failures surface only inside the TUI at runtime.

### Troubleshooting

- **`devin` not found** (`ENOENT` spawn error in the entry log): install the Devin CLI, or point `DEVIN_BIN` at the binary, then restart OpenCode.
- **Auth errors**: run `devin auth login`. The plugin hints at this on auth wire errors.
- **No `/devin` route at all**: check `opencode --version` — a V1 host cannot load the `tui` entry point.
- **Session picker opens but is empty**: the list comes from `session/list` on your Devin account. An empty list with no error entry means no sessions exist yet — take `+ New session`. An error entry means the ACP handshake failed; check `devin` auth first.

## Usage in the TUI

```
/devin                              → open the hosted Devin session view
/devin refactor src/retry.ts        → open the view and immediately send the task
/devin_delegate <task>              → OpenCode agent delegates a one-shot task
```

Or just ask the agent: "hand this off to Devin" / "have the Devin session fix the failing test".

## How it works

- `devin_run` spawns `devin -p "<prompt>"` (non-interactive print mode) and returns stdout.
- `devin_session` and the TUI route share one ACP client (`src/acp.ts`): spawn `devin acp`, `initialize`/`session/new` handshake over newline-delimited JSON-RPC on stdio, `session/prompt` with streamed `session/update` notifications, `session/set_mode`/`session/set_config_option` for Devin's mode/model/thinking pickers, `session/cancel` to interrupt.
- Verified against `devin acp` 3000.11.3: `initialize`, `session/new`, `session/set_mode`, `session/set_config_option`, `session/prompt`, `session/cancel`, close. Per [Devin's custom-agent docs](https://docs.devin.ai/desktop/acp-custom), session *modes* travel as `configOptions` (category `mode`) — this client sets both `session/set_mode` and the `mode` config option.
- Client capabilities sent: `fs` off, `terminal` off — Devin runs commands in its own subprocess and streams output back as `tool_call` updates (matching how Devin Desktop treats terminal-less clients).
- The hosted view answers `session/request_permission` through a dialog; the delegation lane answers `cancelled` by default — `auto_approve: true` picks the allow-shaped option by label semantics (deny-shaped labels are never selected).
- Binary override: `DEVIN_BIN` env var (default `devin` on PATH).
