# Glossary

Canonical terms for hivemind-steward-oc-devin. Resolve a term here before
coining a synonym.

## Terms

**Lane** — the per-working-directory controller (`src/lane.ts`) that owns one
`devin acp` subprocess (its Engine), its current session binding (mutable via
`session/load`), entry history, busy state, permission queue, and the sink the
mounted view listens on. A lane outlives route mounts.
_Avoid_: "connection", "process wrapper", "session object" (the session belongs
to Devin; the lane hosts it).

**Hosted session** — a Devin ACP session driven inside the OpenCode TUI `/devin`
route, as opposed to a session observed in Devin Desktop or another ACP client.
_Avoid_: "embedded session" (vague), "chat".

**Hosted Devin View** — the `/devin` route's full-screen surface (header, Entry
Log scrollbox, Overlay strip, Composer) that renders one lane's state and owns
the route keymap and focus. The `session.panel` and `sidebar.content` claims
are secondary windows onto the same lane (ADR-005).
_Avoid_: "the TUI" (that's the host), "Devin screen", "the plugin" (the plugin
also owns the delegation surfaces).

**Session picker** — the listing surface over `session/list` used to choose an
existing Devin session to continue, or `+ New session in <cwd>` to start one.
It mounts inside the host's dialog chrome (titled frame, search field,
date-grouped rows, `●` bound marker, `⚿` lock badge); an unbound lane is
offered it automatically, a bound lane summons it with ctrl+o (ADR-002).
_Avoid_: "history view", "recent list".

**Overlay** — a focus-owning surface layered over the Composer strip inside the
Hosted Devin View: the Permission Request card, a Config Option picker, the
commands list, or the mention panel. At most one owns input at a time; esc
dismisses it before esc navigates. The Session picker is not an Overlay — it
rides the host's dialog surface.
_Avoid_: "modal", "popup", "dialog" (the host's `ui.dialog` chrome is a
different surface).

**Replay** — the stream of `session/update` notifications Devin emits after a
successful `session/load`, reconstructing prior entries in order.
_Avoid_: "scrollback fetch", "history sync".

**Lock** — Devin's `cognition.ai/isLocked` + `lockHolderPid` metadata marking a
session currently held by another live ACP client. A locked session is
listable; loading it is permitted but the UI must surface the lock state.
_Avoid_: "busy session" (busy means in-flight prompt in our lane).

**Entry** — one rendered item in the lane's Entry Log: user prompt, agent text,
thought, tool call card, plan, permission card, or system notice.
_Avoid_: "message" (too narrow; a tool call is not a message).

**Entry Log** — the lane's complete ordered list of Entries. The lane owns it,
so unmount, remount, and session swaps never lose it (a swap clears it and
rebuilds from the new Replay); the view renders only a windowed tail.
_Avoid_: "chat history" (history belongs to Devin; the log is the lane's
render model of it), "scrollback".

**Composer** — the Hosted Devin View's text field ("Message Devin…") where
prompts, File mentions, and `/<name>` commands are typed. It takes no input
while the lane is unbound or a bind is in flight, and its text survives failed
submits, failed binds, and failed mention resolution.
_Avoid_: "input box", "prompt field", "editor".

**Permission Request** — a `session/request_permission` the lane holds open
until answered, rendered as an Entry with numbered options; answering sends
`{outcome: "selected", optionId}` or `cancelled` on esc. On the hosted lane
only the user answers it — never auto-approved.
_Avoid_: "approval dialog", "auth prompt", "permission dialog" (it is an
inline card, not a dialog).

**Config Option** — one configurable facet of the bound session as Devin
reports it via `config_option_update` or the load response (`model`, `mode`,
`thought_level`): an id, a name, a choice list, and a current value. The
ctrl+m/ctrl+e/ctrl+t pickers render only these rows.
_Avoid_: "setting", "preference" (too generic), "picker" (that is the Overlay
rendering the choices).

**Continuation** — resuming a session that exists on the user's Devin account
regardless of which client created it, via `session/load`.
_Avoid_: "resume" alone when the distinction between lane-remount and
cross-client reload matters; say "lane remount" for the TUI navigation case.

**Delegation** — the server-side tools (`devin_run`, `devin_session`) that let
the OpenCode agent hand work to Devin. Distinct from the hosted route.
_Avoid_: "handoff" (reserved for document handoffs between agent sessions).

**Resource reference** — a `resource_link` content block in a `session/prompt`
payload carrying a `file://` URI, the mechanism behind file mentions.
_Avoid_: "attachment" (no upload occurs), "context injection".

**Engine** — one `devin acp` subprocess plus its JSON-RPC client as seen through
the `DevinEngine` interface (`src/lane.ts`). A lane's engine outlives the
individual session bindings made on it.
_Avoid_: "connection" (that is the wire, not the owned thing), "client",
"backend".

**Binding** — the association between a lane and a Devin `sessionId`, made via
`session/new` or `session/load` (a lane *binds* a session). A lane with no
binding is **unbound** and renders the Session picker; a bound lane can re-bind
— a session swap — only while idle.
_Avoid_: "attach" (reserved for view→lane sinks), "activate", "open session".

**Session descriptor** — one `session/list` row after wire-boundary
translation: `sessionId`, `cwd`, `title`, `updatedAt`, plus `isLocked`,
`lockHolderPid`, `createdAt`, `requestingTabId`. The picker's row model.
_Avoid_: "session object" (the session lives in Devin; the descriptor is only
a listing), "session entry".

**Lane registry** — the module-level `lanes` map behind `laneFor`, keyed by
lane slot (`${cwd}:default`), never by `sessionId`. A session never owns a
registry key.
_Avoid_: "session map", "lane cache".

**Tool lane** — the `devin_session` record in `index.ts` (a `DevinAcp` plus a
session id keyed by `${sessionID}:${name}`). A different type sharing the lane
name; its lifecycle is per-tool-call, not per-route, and ADR-001 does not
govern it.
_Avoid_: reusing "lane" unqualified when both kinds are in scope.

**Journey** — a `verify-journeys/<feature>.json` spec consumed by
`verify-opencode-runtime` on the real installed host; its `proves:` names are
the gate vocabulary a slice must pass before claiming done (ADR-004).
_Avoid_: "e2e test" (that is the legacy `test/e2e/devin-pty.py` drive),
"scenario" (a fake-acp script, not a journey).

**Pending binding** — a `session/load` in flight on a lane. Its sessionId is a
legitimate update tag alongside the bound sessionId until the load resolves or
fails, because ACP v1 replays the conversation *before* the load response.
_Avoid_: "loading session" (the session is not loading; the binding is pending).

**Stale update** — sessionId-tagged traffic (`session/update`,
`session/request_permission`, `available_commands_update`,
`config_option_update`, tagged `_cognition.ai/output`) whose tag is neither the
bound session nor the pending binding. Dropped before it can touch lane state.
_Avoid_: "orphan message", "ghost update".

**Session swap** — re-binding an idle bound lane to a different session via
`session/load` on the same engine; the Entry Log clears and rebuilds from the
new Replay.
_Avoid_: "switch" (that is host route switching), "reconnect".

**File mention** — an `@<path>` token in the Composer that resolves to a
Resource reference block in `session/prompt`.
_Avoid_: "attachment" (no upload occurs), "file tag".

**Available command** — a Devin slash command delivered via
`available_commands_update` as `{name, description, input.hint,
_meta.{icon, category}}`. Invoked by sending `/<name> <args>` as ordinary
prompt text; there is no dedicated invocation wire method.
_Avoid_: "plugin command" (that is the host's keymap command), "slash handler".
