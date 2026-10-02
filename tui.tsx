import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { generateSyntax } from "@opencode/theme/tui"
import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  RGBA,
  SyntaxStyle,
  TextAttributes,
  type BoxRenderable,
  type KeyEvent,
  type Renderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { spawn } from "bun"
import { createEffect, createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { DevinAcp } from "./src/acp"
import { groupEntries, type Row, type ThoughtEntry, type ToolEntry } from "./src/grouping"
import { createMentionOverlay, MentionPanel } from "./mention-overlay"
import { openSessionPicker } from "./session-picker"
import {
  BUSY_BIND_NOTICE,
  laneFor,
  NEW_SESSION,
  type AvailableCommand,
  type ConfigOption,
  type Entry,
  type PermissionChoice,
  type SessionDescriptor,
  type SpawnEngine,
  type SubagentInfo,
} from "./src/lane"

const DEVIN_BIN = process.env.DEVIN_BIN ?? "devin"

// Host ui/border.ts: an all-blank BorderCharacters shape, the `┃` split rail
// used by raised blocks, and the prompt's `╹` bottom hook + `▀` underline.
const EMPTY_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}
const SPLIT_BORDER_CHARS = { ...EMPTY_BORDER, vertical: "┃" }
const PROMPT_BORDER_CHARS = { ...SPLIT_BORDER_CHARS, bottomLeft: "╹" }

// Host component/spinner.tsx has no importable primitive here (@opentui/solid
// does not register a `<spinner>` intrinsic and @opencode/plugin/tui exports no
// spinner) — a signal-driven glyph row carries the same grammar.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// Host context/thinking.ts: the collapsed reasoning header shows a title
// lifted from a leading `**bold**` block when the wire carries that shape;
// Devin thoughts are plain prose, so the first line is the summary fallback.
function reasoningSummary(text: string): { title: string | null; body: string } {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (match) return { title: match[1]!.trim(), body: content.slice(match[0].length).trimEnd() }
  const nl = content.indexOf("\n")
  return { title: nl === -1 ? content || null : content.slice(0, nl), body: content }
}

// Host thinking-syntax.ts: the reasoning body keeps syntax structure but every
// token drops to muted.
function generateThinkingSyntax(syntax: SyntaxStyle, foreground: RGBA): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    Object.fromEntries(syntax.getRegisteredNames().map((name) => [name, { ...syntax.getStyle(name), fg: foreground }])),
  )
}

// Host routes/session tool icons (InlineTool callers) keyed by the wire's real
// toolName — exec/read/edit/write/glob/grep/web fetch+search — with the coarse
// ACP `kind` aliases sharing the same cells. Unknown tools take the generic
// pair (running `│`, completed `✓`, failed `✗`).
const TOOL_GLYPHS: Readonly<Record<string, string>> = {
  exec: "$",
  execute: "$",
  bash: "$",
  shell: "$",
  run_command: "$",
  read: "→",
  read_file: "→",
  ls: "→",
  list: "→",
  list_files: "→",
  glob: "✱",
  grep: "✱",
  search: "✱",
  find: "✱",
  web_fetch: "%",
  fetch: "%",
  web_search: "◈",
  edit: "←",
  write: "←",
  write_file: "←",
  apply_patch: "←",
  patch: "←",
}

// Host pending labels (per-tool renderers in routes/session) shown while a
// call runs and its wire title has not landed.
const TOOL_PENDING: Readonly<Record<string, string>> = {
  read: "Reading file…",
  read_file: "Reading file…",
  ls: "Listing files…",
  list: "Listing files…",
  glob: "Finding files…",
  grep: "Searching content…",
  search: "Searching content…",
  find: "Finding files…",
  web_fetch: "Fetching from the web…",
  fetch: "Fetching from the web…",
  web_search: "Searching web…",
  write: "Preparing write…",
  write_file: "Preparing write…",
  edit: "Preparing edit…",
  apply_patch: "Preparing edit…",
  patch: "Preparing edit…",
  exec: "execute",
  execute: "execute",
  bash: "execute",
  shell: "execute",
  run_command: "execute",
  run_subagent: "Delegating…",
  task: "Delegating…",
  subagent: "Delegating…",
}

// The wire's `diff` content blocks carry raw {path, oldText?, newText} —
// diffed at line level and shaped into @@ hunks for <diff> (host
// util/diff.ts + patch-diff.tsx grammar): unchanged lines render as context,
// change regions separated by >2*context split into their own hunks, and each
// hunk's row count feeds the renderable's minHeight.
interface PatchHunk {
  // Each hunk carries the full patch shape a <diff> consumes — file header
  // plus this hunk's own @@ header — matching host splitPatchHunks' output.
  readonly patch: string
  readonly header: string
  readonly rows: number
  readonly splitRows: number
}

const DIFF_CONTEXT = 3

// Line-level diff: LCS over the line table so untouched middles render as
// context instead of a false -/+ pair. Past the DP budget the caller falls
// back to the single prefix/suffix hunk.
const diffOps = (oldLines: readonly string[], newLines: readonly string[]): ("=" | "-" | "+")[] | undefined => {
  const n = oldLines.length
  const m = newLines.length
  if (n === 0) return newLines.map(() => "+")
  if (m === 0) return oldLines.map(() => "-")
  if (n * m > 500_000) return undefined
  const stride = m + 1
  const dp = new Int32Array((n + 1) * stride)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * stride + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * stride + j + 1]! + 1
          : Math.max(dp[(i + 1) * stride + j]!, dp[i * stride + j + 1]!)
  const ops: ("=" | "-" | "+")[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push("=")
      i++
      j++
    } else if (dp[(i + 1) * stride + j]! >= dp[i * stride + j + 1]!) {
      ops.push("-")
      i++
    } else {
      ops.push("+")
      j++
    }
  }
  for (; i < n; i++) ops.push("-")
  for (; j < m; j++) ops.push("+")
  return ops
}

// Split-view row count for one hunk body: context lines take one row and each
// maximal -/+ block takes max(removed, added) — host util/diff.ts splitRows.
const splitRowsFor = (items: readonly { t: "=" | "-" | "+" }[]): number => {
  let rows = 0
  let idx = 0
  while (idx < items.length) {
    if (items[idx]!.t === "=") {
      rows++
      idx++
      continue
    }
    let del = 0
    let add = 0
    while (idx < items.length && items[idx]!.t !== "=") {
      if (items[idx]!.t === "-") del++
      else add++
      idx++
    }
    rows += Math.max(del, add)
  }
  return rows
}

export function unifiedPatch(path: string, oldText: string | undefined, newText: string): readonly PatchHunk[] {
  const trim = (lines: string[]) => {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return lines
  }
  const oldLines = trim((oldText ?? "").split("\n"))
  const newLines = trim(newText.split("\n"))
  const prefix = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`

  const ops = diffOps(oldLines, newLines)
  const items: { t: "=" | "-" | "+"; o: number; n: number }[] = []
  {
    let o = 0
    let n = 0
    if (ops === undefined) {
      // Budget fallback: one changed region via common-prefix/suffix trim.
      let start = 0
      while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
      let tail = 0
      while (
        tail < oldLines.length - start &&
        tail < newLines.length - start &&
        oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
      )
        tail++
      for (let k = 0; k < start; k++) items.push({ t: "=", o: o++, n: n++ })
      for (let k = start; k < oldLines.length - tail; k++) items.push({ t: "-", o: o++, n: -1 })
      for (let k = start; k < newLines.length - tail; k++) items.push({ t: "+", o: -1, n: n++ })
      for (let k = 0; k < tail; k++) items.push({ t: "=", o: o++, n: n++ })
    } else {
      for (const t of ops) {
        items.push({ t, o: t === "+" ? -1 : o, n: t === "-" ? -1 : n })
        if (t !== "+") o++
        if (t !== "-") n++
      }
    }
  }

  // Cluster changes into hunks: a run of ≤ 2*DIFF_CONTEXT unchanged lines
  // between changes keeps one hunk; a wider gap splits it.
  const changes = items.flatMap((it, i) => (it.t === "=" ? [] : [i]))
  const ranges: [number, number][] =
    changes.length === 0
      ? [[0, items.length]]
      : (() => {
          const out: [number, number][] = []
          let start = Math.max(0, changes[0]! - DIFF_CONTEXT)
          let last = changes[0]!
          for (const idx of changes.slice(1)) {
            if (idx - last - 1 <= 2 * DIFF_CONTEXT) {
              last = idx
              continue
            }
            out.push([start, Math.min(items.length, last + DIFF_CONTEXT + 1)])
            start = Math.max(0, idx - DIFF_CONTEXT)
            last = idx
          }
          out.push([start, Math.min(items.length, last + DIFF_CONTEXT + 1)])
          return out
        })()

  return ranges.map(([s, e]) => {
    const slice = items.slice(s, e)
    const oldBefore = items.slice(0, s).filter((it) => it.t !== "+").length
    const newBefore = items.slice(0, s).filter((it) => it.t !== "-").length
    const oCount = slice.filter((it) => it.t !== "+").length
    const nCount = slice.filter((it) => it.t !== "-").length
    const oRange = oCount === 0 ? `0,0` : `${oldBefore + 1},${oCount}`
    const nRange = nCount === 0 ? `0,0` : `${newBefore + 1},${nCount}`
    const header = `@@ -${oRange} +${nRange} @@`
    const body = slice.map((it) =>
      it.t === "=" ? ` ${oldLines[it.o]}` : it.t === "-" ? `-${oldLines[it.o]}` : `+${newLines[it.n]}`,
    )
    return { patch: `${prefix}${header}\n${body.join("\n")}`, header, rows: body.length, splitRows: splitRowsFor(slice) }
  })
}

// util/filetype.ts on the host maps extensions to tree-sitter languages for
// <diff>/<code> highlighting; only the common set is needed here.
const FILETYPES: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".json": "json",
  ".jsonc": "jsonc",
  ".md": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".html": "html",
  ".css": "css",
  ".sql": "sql",
}

function filetypeFor(path: string): string {
  const match = /\.[^./\\]+$/.exec(path)
  return match ? (FILETYPES[match[0].toLowerCase()] ?? "none") : "none"
}

function SpinnerLine(props: { color?: RGBA; children?: JSX.Element }) {
  const [index, setIndex] = createSignal(0)
  const timer = setInterval(() => setIndex((i) => (i + 1) % SPINNER_FRAMES.length), 80)
  timer.unref?.()
  onCleanup(() => clearInterval(timer))
  return (
    <box flexDirection="row" gap={1} flexShrink={props.children !== undefined ? 1 : 0}>
      <box flexShrink={0}>
        <text fg={props.color}>{SPINNER_FRAMES[index()]}</text>
      </box>
      <Show when={props.children !== undefined}>
        <text fg={props.color}>{props.children}</text>
      </Show>
    </box>
  )
}

export interface DevinViewDeps {
  readonly spawnEngine?: SpawnEngine
  // Clipboard write seam — the real host's clipboard.ts composes a host
  // clipboard with the renderer's OSC52 adapter; tests inject a recorder.
  readonly copyText?: (text: string) => Promise<void>
}

// A spawned-but-silent `devin acp` otherwise parks the route on "starting
// devin acp…" for the client-wide request timeout (600s — it also caps
// prompts, so it can't be narrowed at the client): bound the handshake here.
const SPAWN_TIMEOUT_MS = 30_000
const defaultSpawnEngine: SpawnEngine = async (input) => {
  const spawned = DevinAcp.spawn({ argv: [DEVIN_BIN, "acp"], cwd: input.cwd, autoApprove: false, events: input.events })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      spawned,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`devin acp did not answer initialize within ${SPAWN_TIMEOUT_MS / 1_000}s`))
        }, SPAWN_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    // A spawn that lands past the cutoff still holds a live process — close
    // it rather than leak it.
    void spawned.then((acp) => void acp.close(), () => {})
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ensure() failures are classified inside the lane (describeSpawnFailure) —
// the status line already carries the ENOENT/auth/generic split by the time
// this catch runs; the raw error still lands in the entry.

// devin.doctor probe: PATH resolution first (Bun.which also resolves a
// path-valued DEVIN_BIN), then a bounded `devin --version` so a hung binary
// can't pin the palette command.
const probeDevinCli = async (): Promise<{ ok: boolean; message: string }> => {
  const resolved = Bun.which(DEVIN_BIN)
  if (resolved === null) {
    return { ok: false, message: `\`${DEVIN_BIN}\` not found on PATH — install the Devin CLI or set DEVIN_BIN` }
  }
  try {
    const proc = spawn([DEVIN_BIN, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, 5_000)
    timer.unref?.()
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const detail = (stdout.trim() || stderr.trim()).split("\n")[0]?.trim() ?? ""
      if (timedOut) return { ok: false, message: `\`${DEVIN_BIN} --version\` did not answer within 5s (${resolved})` }
      if (code !== 0)
        return { ok: false, message: `\`${DEVIN_BIN} --version\` exited ${code}${detail ? `: ${detail.slice(0, 200)}` : ""}` }
      return { ok: true, message: `devin CLI ok — ${detail || "no version output"} (${resolved})` }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, message: `\`${DEVIN_BIN}\` probe failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const laneKeyFor = (directory: string) => `${directory}:default`

function DevinCommands(props: { context: Plugin.Context }) {
  const context = props.context
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "devin.open",
        title: "Devin: open session",
        description: "Open the Devin view — pick or resume a Devin session",
        group: "Devin",
        palette: true,
        suggested: true,
        slash: { name: "devin", arguments: true },
        run: (input?: string) => {
          context.ui.router.navigate({ type: "plugin", name: "devin", data: { prompt: input } })
          context.ui.dialog.clear()
        },
      },
      {
        id: "devin.sessions",
        title: "Devin: pick session",
        description: "Open the Devin session picker on the current lane",
        group: "Devin",
        palette: true,
        run: () => {
          context.ui.router.navigate({ type: "plugin", name: "devin", data: { overlay: "sessions" } })
          context.ui.dialog.clear()
        },
      },
      {
        id: "devin.commands",
        title: "Devin: commands",
        description: "List the slash commands the bound Devin session reports",
        group: "Devin",
        palette: true,
        run: () => {
          context.ui.router.navigate({ type: "plugin", name: "devin", data: { overlay: "commands" } })
          context.ui.dialog.clear()
        },
      },
      {
        id: "devin.panel",
        title: "Devin: open panel",
        description: "Show the Devin lane as a panel inside this session",
        group: "Devin",
        palette: true,
        run: () => {
          context.ui.panel.open("devin")
        },
      },
      {
        id: "devin.doctor",
        title: "Devin: doctor",
        description: "Probe the Devin CLI — PATH resolution plus a bounded `devin --version`",
        group: "Devin",
        palette: true,
        run: () => {
          void probeDevinCli().then((report) =>
            context.ui.toast.show({ message: report.message, variant: report.ok ? "success" : "error" }),
          )
        },
      },
    ],
    bindings: ["devin.open"],
  }))
  return null
}

// Sidebar + panel surfaces read the cwd lane — same lane the route binds
// (`laneFor` registry). They render nothing before a lane exists.
export function DevinSidebar(props: { context: Plugin.Context; sessionID: string; deps?: DevinViewDeps }) {
  const context = props.context
  const theme = () => context.theme
  const directory = () =>
    context.data.session.get(props.sessionID)?.location.directory ??
    context.location?.directory ??
    context.data.location.default().directory
  const lane = laneFor(laneKeyFor(directory()), {
    cwd: directory(),
    spawnEngine: props.deps?.spawnEngine ?? defaultSpawnEngine,
  })
  const [title, setTitle] = createSignal(lane.sessionTitle)
  const [sid, setSid] = createSignal(lane.sessionId)
  const [busy, setBusy] = createSignal(lane.busy)
  const [needsInput, setNeedsInput] = createSignal(lane.pending !== undefined)
  const [sessions, setSessions] = createSignal<readonly SessionDescriptor[]>(lane.sessions)
  const [collapsed, setCollapsed] = createSignal(false)
  const sidebarSink = {
    notify: () => {
      setTitle(lane.sessionTitle)
      setSid(lane.sessionId)
      setBusy(lane.busy)
      setNeedsInput(lane.pending !== undefined)
      setSessions(lane.sessions)
    },
  }
  lane.attach(sidebarSink)
  onCleanup(() => lane.detach(sidebarSink))
  onMount(() => {
    // An unbound lane has no engine to answer session/list — only fetch when
    // one is already running (a bind implies alive).
    if (lane.alive && lane.sessionsFetch.kind === "idle") void lane.refreshSessions()
  })

  const sessionMarker = (s: SessionDescriptor): { glyph: string; fg: RGBA } =>
    s.sessionId === sid()
      ? { glyph: "●", fg: theme().text.feedback.success.base }
      : s.isLocked
        ? { glyph: "⚿", fg: theme().text.feedback.warning.base }
        : { glyph: "○", fg: theme().text.muted }

  return (
    <Show when={sid() !== ""}>
      <box flexDirection="column">
        <text fg={theme().text.base}>
          <b>Devin</b>
        </text>
        <text fg={theme().text.muted}>{title() || sid()}</text>
        <text fg={needsInput() ? theme().text.feedback.warning.base : theme().text.muted}>
          {needsInput() ? "needs input" : busy() ? "running" : "idle"}
        </text>
        <Show when={sessions().length > 0}>
          <text fg={theme().text.base} paddingTop={1} onMouseUp={() => setCollapsed(!collapsed())}>
            {`${collapsed() ? "▸" : "▾"} Devin sessions`}
          </text>
          <Show when={!collapsed()}>
            <For each={sessions()}>
              {(s) => (
                <text
                  fg={s.sessionId === sid() ? theme().text.base : theme().text.muted}
                  onMouseUp={() => void lane.bind(s)}
                >
                  <span style={{ fg: sessionMarker(s).fg }}>{`${sessionMarker(s).glyph} `}</span>
                  {s.title || s.sessionId}
                  <Show when={s.title !== ""}>
                    <span style={{ fg: theme().text.muted }}>{` · ${s.sessionId}`}</span>
                  </Show>
                </text>
              )}
            </For>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

// session.panel claim (REQ-PANEL-01): a compact read-out of the cwd lane
// inside the host's panel chrome — the host owns width and fullscreen
// framing. The panel shares the route's lane and never binds on its own;
// focused + ⏎ jumps to the full route.
export function DevinPanel(props: { context: Plugin.Context; input: PanelInput; deps?: DevinViewDeps }) {
  const context = props.context
  const theme = () => context.theme
  const directory = () =>
    context.data.session.get(props.input.sessionID)?.location.directory ??
    context.location?.directory ??
    context.data.location.default().directory
  const lane = laneFor(laneKeyFor(directory()), {
    cwd: directory(),
    spawnEngine: props.deps?.spawnEngine ?? defaultSpawnEngine,
  })
  const [entries, setEntries] = createSignal<Entry[]>(lane.entries)
  const [status, setStatus] = createSignal(lane.status)
  const [sessionId, setSessionId] = createSignal(lane.sessionId)
  const [sessionTitle, setSessionTitle] = createSignal(lane.sessionTitle)
  const [busy, setBusy] = createSignal(lane.busy)
  const [pendingTitle, setPendingTitle] = createSignal<string | undefined>(undefined)
  const panelSink = {
    notify: () => {
      setEntries(lane.entries)
      setStatus(lane.status)
      setSessionId(lane.sessionId)
      setSessionTitle(lane.sessionTitle)
      setBusy(lane.busy)
      const pending = lane.pending
      const entry = pending ? lane.entries[pending.entryIndex] : undefined
      setPendingTitle(entry?.kind === "permission" ? entry.title : pending ? "permission requested" : undefined)
    },
  }
  lane.attach(panelSink)
  onCleanup(() => lane.detach(panelSink))

  context.keymap.layer(() => ({
    commands: [
      {
        bind: "return",
        title: "Open Devin view",
        group: "Devin",
        enabled: () => props.input.focused,
        run: () => {
          context.ui.router.navigate({ type: "plugin", name: "devin" })
        },
      },
    ],
  }))

  const syntax = createMemo(() => generateSyntax(context.theme))
  const tailSize = () => (props.input.presentation === "fullscreen" ? 30 : 6)
  const tail = () => entries().slice(-tailSize())

  const panelEntry = (entry: Entry): JSX.Element => compactEntry(entry, theme(), syntax())

  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={props.input.focused ? theme().text.action.primary.base : theme().border.base}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme().text.muted}>
        <span style={{ fg: theme().text.action.primary.base }}>Devin</span>
        {` ${sessionTitle() || sessionId() || "not bound"} · ${busy() ? "running" : status()}`}
      </text>
      <Show when={pendingTitle()}>
        {(t) => <text fg={theme().text.feedback.warning.base}>{`! ${t()} — answer in the Devin view`}</text>}
      </Show>
      <Show
        when={sessionId() !== ""}
        fallback={<text fg={theme().text.muted}>{"  no Devin session on this directory — ⏎ opens the Devin view"}</text>}
      >
        <For each={tail()}>{(entry) => panelEntry(entry)}</For>
      </Show>
      <text fg={theme().text.muted}>{"  ⏎ open Devin view"}</text>
    </box>
  )
}

export default Plugin.define({
  id: "hivemind-steward-oc-devin",
  setup(context) {
    context.ui.router.register({
      name: "devin",
      render: ({ data }) => (
        <DevinView
          context={context}
          initialPrompt={typeof data?.prompt === "string" ? data.prompt : undefined}
          initialOverlay={data?.overlay === "sessions" || data?.overlay === "commands" ? data.overlay : undefined}
        />
      ),
    })
    context.ui.slot({ append: "app", render: () => <DevinCommands context={context} /> })
    context.ui.slot({ append: "sidebar.content", render: (input) => <DevinSidebar context={context} sessionID={input.sessionID} /> })
    context.ui.slot({
      append: "session.panel",
      render: (input) => (input.name === "devin" ? <DevinPanel context={context} input={input} /> : null),
    })
  },
})

const formatDuration = (ms: number): string => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms - m * 60_000) / 1000)
  return `${m}m ${s}s`
}

const compactEntry = (
  entry: Entry,
  theme: Plugin.Context["theme"],
  syntax: ReturnType<typeof generateSyntax>,
): JSX.Element => {
  if (entry.kind === "user") return <text fg={theme.text.action.primary.base}>{`❯ ${entry.text}`}</text>
  if (entry.kind === "agent")
    return <markdown content={entry.text} syntaxStyle={syntax} conceal fg={theme.markdown?.text ?? theme.text.base} />
  if (entry.kind === "thought") return <text fg={theme.text.muted}>{entry.text}</text>
  if (entry.kind === "system") return <text fg={theme.text.feedback?.warning?.base ?? theme.text.muted}>{entry.text}</text>
  if (entry.kind === "plan") return <text fg={theme.text.muted}>{entry.items.join(" · ")}</text>
  if (entry.kind === "permission")
    return <text fg={theme.text.feedback?.warning?.base ?? theme.text.muted}>{`! permission: ${entry.title}`}</text>
  if (entry.kind === "usage") {
    const parts = [
      entry.input !== undefined ? `${entry.input.toLocaleString()} in` : undefined,
      entry.output !== undefined ? `${entry.output.toLocaleString()} out` : undefined,
      entry.creditCost !== undefined ? `${entry.creditCost} credits` : undefined,
      entry.acuCost !== undefined ? `${entry.acuCost} ACU` : undefined,
    ].filter(Boolean)
    return <text fg={theme.text.muted}>{`+ Tokens${parts.length ? `: ${parts.join(" · ")}` : ""}`}</text>
  }
  if (entry.kind === "turnmeta")
    return (
      <text fg={theme.text.muted}>
        {`Devin${entry.model ? ` · ${entry.model}` : ""} · ${formatDuration(entry.totalTimeMs ?? entry.durationMs)}`}
      </text>
    )
  if (entry.kind === "subagent")
    return <text fg={theme.text.muted}>{`⤷ ${entry.title}${entry.summary ? ` · ${entry.summary}` : ""}`}</text>
  // Dock/panel tail keeps the same header shape as the stream row: ▸ + icon
  // cell + title — the wire's status enum is not echoed.
  const icon =
    entry.status === "failed" || entry.status === "error"
      ? "✗"
      : (TOOL_GLYPHS[entry.toolName ?? ""] ?? TOOL_GLYPHS[entry.toolKind ?? ""] ??
        (entry.status === "completed" ? "✓" : "│"))
  return (
    <text
      fg={entry.status === "failed" ? (theme.text.feedback?.error?.base ?? theme.text.muted) : theme.text.muted}
      attributes={entry.canceled === true ? TextAttributes.STRIKETHROUGH : undefined}
    >{`▸ ${icon} ${entry.title}`}</text>
  )
}

export function DevinView(props: {
  context: Plugin.Context
  initialPrompt?: string
  initialOverlay?: "sessions" | "commands"
  deps?: DevinViewDeps
}) {
  const context = props.context
  const theme = () => context.theme
  // Overlay panels (sessions/commands/picker/mentions) render on the raised
  // dialog surface — the host resolves text/border/accent colors for it via
  // theme().surface("dialog") (dialog.tsx / dialog-select.tsx).
  const raised = () => context.theme.surface("dialog")
  const cwd = context.location?.directory ?? context.data.location.default().directory
  const lane = laneFor(`${cwd}:default`, { cwd, spawnEngine: props.deps?.spawnEngine ?? defaultSpawnEngine, binName: DEVIN_BIN })

  const [entries, setEntries] = createSignal<Entry[]>([])
  const [status, setStatus] = createSignal(lane.status)
  const [config, setConfig] = createSignal<ConfigOption[]>([])
  const [sessionId, setSessionId] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [modeId, setModeId] = createSignal("")
  const [usage, setUsage] = createSignal<{ used: number; size: number } | undefined>(undefined)
  const [pickerId, setPickerId] = createSignal("")
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [commandsOpen, setCommandsOpen] = createSignal(false)
  const [commands, setCommands] = createSignal<AvailableCommand[]>([])
  const [binding, setBinding] = createSignal(lane.binding)
  const [busy, setBusy] = createSignal(lane.busy)
  const [textEl, setTextEl] = createSignal<TextareaRenderable | undefined>(undefined)
  const [highlight, setHighlight] = createSignal(0)
  const [pendingIndex, setPendingIndex] = createSignal(-1)
  // Tool entries are collapsed by default (native parity: header stays
  // visible, detail expands on click). Expansion keys on `entry.id` — the
  // lane's stamped render identity — so a merge that replaces the stored
  // object (every tool_call_update) keeps the row open.
  const [expandedTools, setExpandedTools] = createSignal<ReadonlySet<number>>(new Set())
  const [hoveredTool, setHoveredTool] = createSignal<number | undefined>(undefined)
  const [dockOpen, setDockOpen] = createSignal(false)
  const [dockTab, setDockTab] = createSignal(0)
  const [dockRow, setDockRow] = createSignal(0)
  const [subagents, setSubagents] = createSignal<SubagentInfo[]>([])
  // REQ-SUBAGENT-01: dock row click narrows the log to that agent's authored
  // entries — read-only, never a bind (no child sessionIds exist on the wire).
  const [agentFilter, setAgentFilter] = createSignal<string | undefined>(undefined)
  // Host group-view.tsx: a live selection means the gesture was a copy, not
  // a toggle — also covers click-escalated word/line selects.
  const selectionActive = () => Boolean(context.renderer.getSelection()?.getSelectedText())
  const toggleTool = (id: number) => {
    if (selectionActive()) return
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // One ticker feeds every running tool row's spinner frame (host spinner.tsx
  // grammar; shared so a busy log does not spawn an interval per row).
  const [spinIndex, setSpinIndex] = createSignal(0)
  const spinTimer = setInterval(() => setSpinIndex((i) => (i + 1) % SPINNER_FRAMES.length), 80)
  spinTimer.unref?.()
  onCleanup(() => clearInterval(spinTimer))
  // Thought rows follow the host's default `session.thinking: "hide"` mode:
  // a single collapsed header line, click expands the full reasoning block.
  // Like tools the set keys on `entry.id` — object identity would collapse
  // the expansion on every streamed chunk merge.
  const [expandedThoughts, setExpandedThoughts] = createSignal<ReadonlySet<number>>(new Set())
  const toggleThought = (id: number) => {
    if (selectionActive()) return
    setExpandedThoughts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Explored-group expansion needs its own set: the group's row key is a
  // member's entry id, so sharing expandedTools would pop the first member's
  // detail open every time the group expands.
  const [expandedGroups, setExpandedGroups] = createSignal<ReadonlySet<number>>(new Set())
  const toggleGroup = (id: number) => {
    if (selectionActive()) return
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Message Actions "Jump to" targets — row renderables keyed by entry id.
  // Declared with the id-keyed sets because entryIndex's prune pass reads it.
  const entryRefs = new Map<number, Renderable>()
  // Enter that submits /devin can bleed into the freshly mounted picker and
  // select "+ New session" (#13). Overlay selection stays inert until the
  // view has painted its first frame — input queued before that is not
  // addressed to this view.
  const [painted, setPainted] = createSignal(false)
  // The unbound route IS the picker: whenever the lane is painted, settled,
  // idle, and unbound — fresh mount, failed bind, dead engine — the session
  // dialog is offered again. A dismissal on an unbound lane navigates home; a
  // pick or a bound dismissal just closes. `mountSettled` holds the gate
  // closed until the initial ensure/bind sequence resolves, so /devin <task>
  // never sees the picker flash before its bind (REQ-ARG-01).
  const [mountSettled, setMountSettled] = createSignal(false)
  const [sessionPickerOpen, setSessionPickerOpen] = createSignal(false)
  let navigatingHome = false
  const offerSessionPicker = () => {
    setSessionPickerOpen(true)
    openSessionPicker({
      context,
      lane,
      cwd,
      onDismissed: () => {
        if (lane.sessionId === "") {
          navigatingHome = true
          context.ui.router.navigate({ type: "home" })
        }
      },
      onClosed: () => setSessionPickerOpen(false),
    })
  }
  // laneTick bumps on every lane notify — a bind that settles inside the
  // debounce window never edges binding(), so the gate re-evaluates on each
  // sync, not on whichever fields happened to change.
  const [laneTick, setLaneTick] = createSignal(0)
  createEffect(() => {
    laneTick()
    if (!painted() || !mountSettled() || navigatingHome) return
    // lane.binding leads the binding() signal — notify() debounces while a
    // bind runs, so the field is the only in-tick witness of an in-flight pick.
    if (sessionId() !== "" || binding() || lane.binding || sessionPickerOpen()) return
    offerSessionPicker()
  })
  const onFirstFrame = () => {
    setPainted(true)
    context.renderer.off("frame", onFirstFrame)
  }
  context.renderer.on("frame", onFirstFrame)
  onCleanup(() => context.renderer.off("frame", onFirstFrame))
  const interactive = () => painted() && (overlay() !== undefined || mention.open())

  const sync = () => {
    setEntries(lane.entries)
    setStatus(lane.status)
    setConfig([...lane.config.current])
    setSessionId(lane.sessionId)
    setSessionTitle(lane.sessionTitle)
    setModeId(lane.modeId)
    setUsage(lane.usage)
    setCommands([...lane.availableCommands])
    setSubagents([...lane.subagents])
    setBinding(lane.binding)
    setBusy(lane.busy)
    const idx = lane.pending?.entryIndex ?? -1
    if (idx !== pendingIndex()) setHighlight(0)
    setPendingIndex(idx)
    setLaneTick((n) => n + 1)
  }
  const viewSink = { notify: sync }
  lane.attach(viewSink)
  onCleanup(() => lane.detach(viewSink))

  // The lane keeps the full log (permission entryIndex bookkeeping depends on
  // it) but the scrollbox paints only the tail — replayed sessions can carry
  // thousands of entries and a full render is what froze the TUI (REQ-WINDOW-01).
  // groupEntries runs BEFORE the cut (host order): slicing raw entries could
  // bisect a thoughts/explored run, dropping the group's first member and
  // remounting the survivors under a new key. `hidden` still counts entries —
  // the header reads "N earlier entries hidden", not rows.
  const MAX_VISIBLE_ROWS = 400
  const windowed = createMemo(() => {
    const filter = agentFilter()
    const all = entries()
    const scoped = filter === undefined ? all : all.filter((e) => "agent" in e && e.agent === filter)
    const grouped = groupEntries(scoped)
    const overflow = Math.max(0, grouped.length - MAX_VISIBLE_ROWS)
    const hidden = grouped
      .slice(0, overflow)
      .reduce((n, row) => n + (row.kind === "entry" ? 1 : row.entries.length), 0)
    return { hidden, rows: overflow ? grouped.slice(-MAX_VISIBLE_ROWS) : grouped }
  })

  // Rows key on the lane's stamped `entry.id`, never the entry object:
  // mapArray diffs primitives by value, so a merge (same id, new object)
  // keeps the row mounted — only the props inside repaint — while a push
  // mounts just the new tail. Resolving by id is what lets <markdown>/<diff>
  // children stay mounted (a late mount under the scrollbox paints blank,
  // the S25 regression).
  //
  // groupEntries inside `windowed` applies the host group-view.tsx grammar:
  // same-agent reasoning runs collapse to one `+ Thought · N steps · dur`
  // header, exploration calls to `Explored: N reads, …`. A row's key is its
  // first member's id — runs only ever grow at the tail — so a single that
  // becomes a group keeps its row and the Switch inside rowView swaps the
  // rendered branch in place.
  const rows = () => windowed().rows
  const rowKey = (row: Row, index: number): number =>
    (row.kind === "entry" ? row.entry.id : row.entries[0]?.id) ?? ~index
  const streamRowKeys = () => rows().map(rowKey)
  const rowIndex = createMemo(() => {
    const index = new Map<number, Row>()
    rows().forEach((row, i) => index.set(rowKey(row, i), row))
    return index
  })
  const entryIndex = createMemo(() => {
    const index = new Map<number, Entry>()
    for (const entry of entries()) if (entry.id !== undefined) index.set(entry.id, entry)
    // entryRefs can no longer key on the entry object (merges replace it) —
    // drop handles whose id left the log or whose renderable died.
    for (const [id, el] of entryRefs) if (!index.has(id) || el.isDestroyed) entryRefs.delete(id)
    return index
  })
  const entryById = (id: number) => entryIndex().get(id)
  const lastEntryId = () => entries()[entries().length - 1]?.id

  const overlay = () =>
    pendingIndex() >= 0
      ? "permission"
      : pickerOpen()
        ? "picker"
        : commandsOpen()
          ? "commands"
          : undefined

  const permissionEntry = () => {
    const entry = entries()[pendingIndex()]
    return entry?.kind === "permission" ? entry : undefined
  }

  type FileRow = { readonly file: string }
  type CommandRow = { readonly command: AvailableCommand }

  const pickerOptions = (): PermissionChoice[] => {
    const option = config().find((o) => o.id === pickerId())
    return (option?.options ?? []).map((o) => ({ id: o.value, name: o.name, kind: o.description }))
  }

  const commandsRows = (): CommandRow[] => commands().map((command) => ({ command }))

  const overlayOptions = (): ReadonlyArray<PermissionChoice | FileRow | CommandRow> => {
    if (overlay() === "permission") return permissionEntry()?.options ?? []
    if (overlay() === "picker") return pickerOptions()
    if (overlay() === "commands") return commandsRows()
    if (mention.open())
      return mention.rows().map((row) => (row.kind === "file" ? { file: row.path } : { command: row.command }))
    return []
  }

  const chooseOption = (option: PermissionChoice | FileRow | CommandRow | undefined) => {
    if (overlay() === "permission") {
      if (option && !("file" in option) && !("command" in option)) lane.answerPermission(option)
      return
    }
    if (overlay() === "picker") {
      if (!option || "pick" in option || "file" in option || "command" in option) return
      const id = pickerId()
      setPickerOpen(false)
      void lane.applyConfig(id, option.id)
      return
    }
    if (overlay() === "commands") {
      if (!option || !("command" in option)) return
      setCommandsOpen(false)
      insertCommand(option.command.name)
      return
    }
    if (mention.open() && option) {
      if ("file" in option) mention.insert({ kind: "file", path: option.file })
      else if ("command" in option) mention.insert({ kind: "command", command: option.command })
    }
  }

  const moveHighlight = (delta: number) => {
    const count = overlayOptions().length
    if (count) setHighlight((h) => (h + delta + count) % count)
  }

  const openPicker = (id: string) => {
    if (!lane.alive || overlay()) return
    setPickerId(id)
    const current = lane.configValue(id)?.currentValue
    setHighlight(Math.max(0, pickerOptions().findIndex((o) => o.id === current)))
    setPickerOpen(true)
  }

  const restoreText = (text: string) => {
    const field = textEl()
    if (field && !field.isDestroyed && field.plainText === "") field.setText(text)
  }

  // Row pick inserts `/<name> ` unsubmitted at the cursor — focus returns to
  // the composer through the shared focus effect once the overlay closes.
  const insertCommand = (name: string) => {
    const field = textEl()
    if (!field || field.isDestroyed) return
    const text = field.plainText
    const at = field.editBuffer.getCursorPosition().offset
    const insert = `/${name} `
    field.setText(`${text.slice(0, at)}${insert}${text.slice(at)}`)
    field.editBuffer.setCursorByOffset(at + insert.length)
  }

  // File mentions (REQ-FILE-01): the completion machinery lives in
  // mention-overlay.tsx; the view wires it into the shared overlay grammar.
  const mention = createMentionOverlay({
    lane,
    textEl,
    overlayActive: () => overlay() !== undefined,
    resetHighlight: () => setHighlight(0),
  })

  const submit = () => {
    const input = textEl()
    if (!input || input.isDestroyed) return
    const text = input.plainText.trim()
    if (!text || lane.busy || lane.binding || lane.sessionId === "") return
    input.setText("")
    void lane.send(text).catch(() => restoreText(text))
  }

  context.keymap.layer(() => ({
    commands: [
      // Digit picks belong to overlays that number their options — the `@`
      // mention panel keeps digits for filenames and selects via ↑/↓/⏎.
      ...Array.from({ length: 9 }, (_, i) => ({
        bind: String(i + 1),
        title: `Overlay option ${i + 1}`,
        group: "Devin",
        enabled: () => interactive() && !mention.open(),
        run: () => chooseOption(overlayOptions()[i]),
      })),
      {
        bind: "up",
        title: "Previous option",
        group: "Devin",
        enabled: interactive,
        run: () => moveHighlight(-1),
      },
      {
        bind: "down",
        title: "Next option",
        group: "Devin",
        enabled: interactive,
        run: () => moveHighlight(1),
      },
      // Host SessionQuestion: permission chips cycle on ←/→ (h/l); scoped so
      // the picker's filter field and other overlays keep receiving text.
      ...(["left", "h"] as const).map((key) => ({
        bind: key,
        title: "Previous permission option",
        group: "Devin",
        enabled: () => interactive() && overlay() === "permission",
        run: () => moveHighlight(-1),
      })),
      ...(["right", "l"] as const).map((key) => ({
        bind: key,
        title: "Next permission option",
        group: "Devin",
        enabled: () => interactive() && overlay() === "permission",
        run: () => moveHighlight(1),
      })),
      {
        bind: "return",
        title: "Choose option",
        group: "Devin",
        enabled: interactive,
        run: () => chooseOption(overlayOptions()[highlight()]),
      },
      {
        bind: "escape",
        title: "Back home",
        group: "Devin",
        run(_input?: string, event?: KeyEvent) {
          event?.preventDefault()
          event?.stopPropagation()
          if (overlay() === "permission") {
            lane.answerPermission()
            return
          }
          if (overlay() === "picker") {
            setPickerOpen(false)
            return
          }
          if (overlay() === "commands") {
            setCommandsOpen(false)
            return
          }
          if (mention.open()) {
            mention.dismiss()
            return
          }
          if (agentFilter() !== undefined) {
            setAgentFilter(undefined)
            return
          }
          if (dockOpen()) {
            setDockOpen(false)
            return
          }
          context.ui.router.navigate({ type: "home" })
        },
      },
      {
        bind: "ctrl+o",
        title: "Devin sessions",
        group: "Devin",
        run: () => {
          if (sessionId() === "") return
          // A busy lane's binding is pinned (E25): an in-flight prompt or a
          // pending Permission Request refuses with a notice instead of
          // tearing the session out mid-answer.
          if (lane.busy || lane.binding || lane.pending) {
            lane.push({ kind: "system", text: BUSY_BIND_NOTICE })
            return
          }
          if (overlay() !== undefined) return
          openSessionPicker({ context, lane, cwd })
        },
      },
      {
        // ctrl+g is the only commands surface (E37): "/" typed in the composer
        // is ordinary text and opens nothing.
        bind: "ctrl+g",
        title: "Devin commands",
        group: "Devin",
        run: () => {
          if (sessionId() === "" || overlay() !== undefined) return
          setHighlight(0)
          setCommandsOpen(true)
        },
      },
      {
        bind: "ctrl+m",
        title: "Pick Devin model",
        group: "Devin",
        run: () => openPicker("model"),
      },
      {
        bind: "ctrl+e",
        title: "Pick Devin mode",
        group: "Devin",
        run: () => openPicker("mode"),
      },
      {
        bind: "ctrl+t",
        title: "Pick thinking level",
        group: "Devin",
        run: () => openPicker("thought_level"),
      },
      {
        bind: "ctrl+x",
        title: "Cancel Devin prompt",
        group: "Devin",
        run: () => lane.cancel(),
      },
    ],
  }))

  const composerAtLastLine = () => {
    const input = textEl()
    if (!input || input.isDestroyed) return true
    const last = Math.max(input.virtualLineCount - 1, input.lineCount - 1, 0)
    return input.visualCursor.visualRow >= last
  }

  // Composer `down` enters the dock two ways: a keymap bind (which the host's
  // managed textarea layer yields to when the cursor can't move — the same
  // seam `session.child.first` uses), and the textarea's own onKeyDown as a
  // fallback for hosts whose dispatch order differs. The dock is read-only
  // inspection, so `lane.busy` gates none of the three open paths.
  context.keymap.layer(() => ({
    priority: 1,
    commands: [
      {
        bind: "down",
        title: "Open dock",
        group: "Devin",
        enabled: () =>
          painted() &&
          !dockOpen() &&
          overlay() === undefined &&
          !mention.open() &&
          lane.alive &&
          sessionId() !== "" &&
          !lane.binding &&
          composerAtLastLine(),
        run: () => {
          setDockTab(0)
          setDockRow(0)
          setDockOpen(true)
        },
      },
    ],
  }))

  const DOCK_TABS = ["Subagents", "Commands", "Log"] as const
  type DockTab = (typeof DOCK_TABS)[number]
  const activeDockTab = (): DockTab => DOCK_TABS[dockTab()] ?? "Subagents"
  const LOG_TAIL = 8
  const dockRowCount = () => {
    const tab = activeDockTab()
    if (tab === "Subagents") return subagents().length
    if (tab === "Commands") return commands().length
    return Math.min(entries().length, LOG_TAIL)
  }
  const moveDockRow = (delta: number) => {
    const count = dockRowCount()
    if (count) setDockRow((r) => (r + delta + count) % count)
  }
  const switchDockTab = (delta: number) => {
    setDockTab((t) => (t + delta + DOCK_TABS.length) % DOCK_TABS.length)
    setDockRow(0)
  }
  const openDock = (tab?: number) => {
    setDockTab(tab ?? dockTab())
    setDockRow(0)
    setDockOpen(true)
  }
  const closeDock = () => setDockOpen(false)
  // Host composer dock: each tab contributes its own hints (context.ts
  // ComposerTab.hints) ahead of the shared `tabs`/`close` chips.
  const dockHints = createMemo(() => {
    const tab = activeDockTab()
    const rows = dockRowCount() > 0
    const perTab =
      tab === "Subagents" && rows
        ? [{ label: "filter", shortcut: "⏎" }]
        : tab === "Commands" && rows
          ? [{ label: "insert", shortcut: "⏎" }]
          : []
    return [
      ...perTab,
      ...(rows ? [{ label: "rows", shortcut: "↑/↓" }] : []),
      { label: "tabs", shortcut: "←/→" },
      { label: "close", shortcut: "esc" },
    ]
  })
  const invokeDockRow = () => {
    const tab = activeDockTab()
    if (tab === "Commands") {
      const command = commands()[dockRow()]
      if (!command) return
      closeDock()
      insertCommand(command.name)
      return
    }
    if (tab === "Subagents") {
      const sub = subagents()[dockRow()]
      if (!sub) return
      setAgentFilter((f) => (f === sub.id ? undefined : sub.id))
      closeDock()
    }
  }

  context.keymap.layer(() => ({
    enabled: dockOpen,
    priority: 1,
    commands: [
      { bind: "left", title: "Previous dock tab", group: "Devin", run: () => switchDockTab(-1) },
      { bind: "right", title: "Next dock tab", group: "Devin", run: () => switchDockTab(1) },
      { bind: "tab", title: "Next dock tab", group: "Devin", run: () => switchDockTab(1) },
      { bind: "shift+tab", title: "Previous dock tab", group: "Devin", run: () => switchDockTab(-1) },
      { bind: "up", title: "Dock row up", group: "Devin", run: () => moveDockRow(-1) },
      { bind: "down", title: "Dock row down", group: "Devin", run: () => moveDockRow(1) },
      { bind: "return", title: "Choose dock row", group: "Devin", run: invokeDockRow },
      { bind: "ctrl+c", title: "Close dock", group: "Devin", run: closeDock },
    ],
  }))

  // Mirrors the host composer contract (form.tsx): the textarea is focusable and
  // focused while the route is active and no overlay (permission card, picker,
  // sessions) or in-flight bind owns input; it blurs and becomes unfocusable
  // otherwise. An unbound lane always has the sessions overlay up.
  createEffect(() => {
    const target = textEl()
    if (!target || target.isDestroyed) return
    if (overlay() !== undefined || binding() || dockOpen()) {
      target.blur()
      target.focusable = false
      return
    }
    target.focusable = true
    target.focus()
  })

  // A slash task parks in the composer before any bind runs — the textarea
  // holds text regardless of focusable, so a failed session/new (or a failed
  // spawn) never silently loses what the user typed.
  const parkPrompt = () => {
    const input = textEl()
    if (props.initialPrompt && input && !input.isDestroyed) input.setText(props.initialPrompt)
  }

  void lane
    .ensure()
    .then(async () => {
      parkPrompt()
      if (!lane.sessionId) {
        if (props.initialPrompt) await lane.bind(NEW_SESSION)
        if (!lane.sessionId) return
      }
      // Palette commands can land the route with an overlay pre-opened
      // (devin.sessions / devin.commands) — a bound lane skips the picker.
      if (props.initialOverlay === "sessions") openSessionPicker({ context, lane, cwd })
      if (props.initialOverlay === "commands") setCommandsOpen(true)
      if (!props.initialPrompt) return
      if (lane.busy || lane.binding) {
        lane.push({ kind: "system", text: "devin is busy — task left in composer" })
        return
      }
      submit()
    })
    .catch((error) => {
      parkPrompt()
      lane.push({
        kind: "system",
        text: `failed to start devin acp: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
    .finally(() => setMountSettled(true))

  const currentModel = () => {
    const model = config().find((o) => o.id === "model")
    return model?.options?.find((o) => o.value === model.currentValue)?.name ?? model?.currentValue ?? "…"
  }
  const currentMode = () => {
    const mode = config().find((o) => o.id === "mode")
    return mode?.options?.find((o) => o.value === mode.currentValue)?.name ?? mode?.currentValue ?? (modeId() || "…")
  }
  const currentThinking = () => {
    const thinking = config().find((o) => o.id === "thought_level")
    return thinking?.options?.find((o) => o.value === thinking.currentValue)?.name ?? thinking?.currentValue ?? "…"
  }
  const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const usageText = () => {
    const u = usage()
    return u ? ` · ctx ${fmtTokens(u.used)}/${fmtTokens(u.size)}` : ""
  }

  // Native row chrome (dialog-select.tsx): hover and press track the row into
  // `highlight`, mouse-up activates it; the active row paints the primary
  // action background on the dialog surface and its text goes bold.
  const OverlayRow = (props: {
    readonly active: boolean
    readonly onPick: () => void
    readonly onHover: () => void
    readonly children?: JSX.Element
  }) => (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.active ? raised().background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
      onMouseDown={props.onHover}
      onMouseMove={props.onHover}
      onMouseUp={props.onPick}
    >
      {props.children}
    </box>
  )

  // Row colors live on fg/attributes props (reactive getters), never inside
  // `style={{}}` objects — those snapshot at creation and would not follow
  // `highlight`. Conditional strings that can go empty smear the scrollbox
  // paint (S25); `visible` gates the lock badge instead.
  const rowFg = (active: boolean, muted: boolean) =>
    active ? raised().text.action.primary.focused : muted ? raised().text.muted : raised().text.base

  // Host SessionQuestion (permission.tsx): raised card, `┃` rail in the
  // primary-focused accent, `△ Permission required` header, the wire's title
  // as the subject line, and a footer strip of option chips on the decreased
  // surface — selected chip paints action.primary.focused. An answered card
  // keeps the surface but drops the footer, collapsing to `→ <choice>`.
  const permissionCard = (id: number) => {
    const entry = (): Extract<Entry, { kind: "permission" }> | undefined => {
      const e = entryById(id)
      return e?.kind === "permission" ? e : undefined
    }
    return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme().background.raised.base}
      border={["left"]}
      borderColor={theme().background.action.primary.focused}
      customBorderChars={SPLIT_BORDER_CHARS}
      maxHeight={15}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={1} flexShrink={0}>
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={theme().text.feedback?.warning?.base ?? theme().text.muted}>{"△"}</text>
              <text fg={theme().text.base}>{"Permission required"}</text>
            </box>
            <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
              <text fg={theme().text.base}>{entry()?.title}</text>
            </box>
          </box>
        </box>
        <Show when={entry()?.answered !== undefined}>
          <box paddingLeft={1}>
            <text fg={theme().text.muted}>{`→ ${entry()?.answered}`}</text>
          </box>
        </Show>
      </box>
      <Show when={entry()?.answered === undefined}>
        <box
          flexDirection={dims().width < 80 ? "column" : "row"}
          flexShrink={0}
          gap={1}
          paddingTop={1}
          paddingLeft={2}
          paddingRight={3}
          paddingBottom={1}
          backgroundColor={theme().decrease(theme().background.raised.base)}
          justifyContent={dims().width < 80 ? "flex-start" : "space-between"}
          alignItems={dims().width < 80 ? "flex-start" : "center"}
        >
          <box flexDirection="row" gap={1} flexShrink={0}>
            <For each={entry()?.options ?? []}>
              {(option, i) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    i() === highlight()
                      ? theme().background.action.primary.focused
                      : theme().background.action.primary.base
                  }
                  onMouseMove={() => setHighlight(i())}
                  onMouseUp={() => {
                    setHighlight(i())
                    chooseOption(option)
                  }}
                >
                  <text
                    fg={
                      i() === highlight()
                        ? theme().text.action.primary.focused
                        : theme().text.action.primary.base
                    }
                  >
                    {option.name}
                  </text>
                </box>
              )}
            </For>
          </box>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <Show when={(entry()?.options.length ?? 0) > 1}>
              <text fg={theme().text.base}>
                {"⇆"} <span style={{ fg: theme().text.muted }}>select</span>
              </text>
            </Show>
            <text fg={theme().text.base}>
              {"enter"} <span style={{ fg: theme().text.muted }}>confirm</span>
            </text>
            <text fg={theme().text.base}>
              {"esc"} <span style={{ fg: theme().text.muted }}>cancel</span>
            </text>
          </box>
        </box>
      </Show>
    </box>
    )
  }

  const syntax = createMemo(() => generateSyntax(context.theme))
  // Host routes/session/thinking-syntax.ts — reasoning bodies keep syntax
  // structure with every token dimmed to muted.
  const thinkingSyntax = createMemo(() => generateThinkingSyntax(syntax(), theme().text.muted))

  // Composer surface geometry — host prompt/index.tsx: the accent edge carries
  // the agent color, the surface is `decrease(raised.base)`, and the textarea
  // caps at max(6, height/3) rows.
  const dims = () => ({ width: context.renderer.terminalWidth, height: context.renderer.terminalHeight })
  // Host prompt rail = tint(theme.border.base, agentColor ?? border.base):
  // the wire carries no agent color, so the rail settles on border.base, and
  // the "Devin" metadata label paints the same highlight the host uses.
  const promptAccent = () => theme().border.base
  const promptBg = () => theme().decrease(theme().background.raised.base)
  // The wire carries no auto/provider/variant segments, so unlike the host's
  // promptMetadataLayout we only have mode+thinking to shed: under width
  // pressure thinking leaves first, then mode; the model truncates inside
  // what remains and the "Devin" label never yields.
  const composerMeta = createMemo(() => {
    const pad = dims().width < 44 ? 1 : 2
    const budget = Math.max(0, dims().width - 1 - pad * 2)
    const text = (mode: boolean, thinking: boolean) =>
      `Devin · ${currentModel()}${mode ? ` · ${currentMode()}` : ""}${thinking ? ` · ${currentThinking()}` : ""}`
    if (text(true, true).length <= budget) return { mode: true, thinking: true }
    if (text(true, false).length <= budget) return { mode: true, thinking: false }
    return { mode: false, thinking: false }
  })
  const composerMuted = () => binding() || sessionId() === ""
  const composerMaxHeight = () => Math.max(6, Math.floor(dims().height / 3))
  // Host footer grammar (promptFooterLayout): hint chips fit the row or drop
  // wholesale — never clip mid-word. `drop` ranks removal order: `⏎ send` and
  // `esc home` are self-evident and leave first; `ctrl+x cancel` replaces
  // `send` while busy; `↓ dock` is the last chip standing so the dock stays
  // discoverable at every width where any hint fits at all.
  type HintChip = { id: string; text: string; drop: number }
  const footerHints = createMemo<HintChip[]>(() => {
    const chips: HintChip[] = busy()
      ? [
        { id: "sessions", text: "ctrl+o sessions", drop: 0 },
        { id: "home", text: "esc home", drop: 1 },
        { id: "cancel", text: "ctrl+x cancel", drop: 2 },
        { id: "commands", text: "ctrl+g commands", drop: 4 },
        ...(sessionId() !== "" ? [{ id: "dock", text: "↓ dock", drop: 5 }] : []),
      ]
      : [
        { id: "send", text: "⏎ send", drop: 0 },
        { id: "home", text: "esc home", drop: 1 },
        { id: "sessions", text: "ctrl+o sessions", drop: 3 },
        { id: "commands", text: "ctrl+g commands", drop: 4 },
        ...(sessionId() !== "" ? [{ id: "dock", text: "↓ dock", drop: 5 }] : []),
      ]
    const order = ["send", "sessions", "commands", "cancel", "dock", "home"]
    chips.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    const gap = 2
    const budget = dims().width - 2 - `${status()}${usageText()}`.length - gap
    let width = (list: HintChip[]) => list.reduce((w, c) => w + c.text.length, 0) + gap * Math.max(0, list.length - 1)
    const kept = [...chips]
    while (kept.length > 0 && width(kept) > budget) {
      let weakest = kept[0]!
      for (const chip of kept) if (chip.drop < weakest.drop) weakest = chip
      kept.splice(kept.indexOf(weakest), 1)
    }
    return kept
  })
  // The host's SplitBorder: a thick `┃` accent edge on the left side of the
  // raised user-message block (ui/border.ts in the host source).
  const ACCENT_EDGE = SPLIT_BORDER_CHARS

  const [hoveredUser, setHoveredUser] = createSignal<number | undefined>(undefined)

  const toolErrorFg = () => theme().text.feedback?.error?.base ?? theme().text.muted

  // Message Actions — the host's dialog-message.tsx grammar over the wire's
  // honest capabilities: jump scrolls the entry into view, copy writes its
  // text through the renderer's OSC52 adapter plus the host clipboard, and
  // edit reloads a user prompt into the composer (ACP exposes no revert or
  // fork verb, so neither is claimed).
  let scrollEl: ScrollBoxRenderable | undefined
  let composerEl: BoxRenderable | undefined
  // Host session/index.tsx: once the stream is scrolled off the bottom a
  // right-aligned `Jump to latest ↓` pill appears above the composer; clicking
  // it re-engages sticky scroll. `verticalScrollBar` change events drive the
  // away flag — scrollTop is not a reactive getter.
  const [awayFromBottom, setAwayFromBottom] = createSignal(false)
  const [latestHovered, setLatestHovered] = createSignal(false)
  const updateAwayFromBottom = () => {
    const el = scrollEl
    if (!el || el.isDestroyed) return
    const away = el.scrollTop < Math.max(0, el.scrollHeight - el.viewport.height)
    setAwayFromBottom(away)
    if (!away) setLatestHovered(false)
  }
  const toBottom = () => {
    const el = scrollEl
    if (!el || el.isDestroyed) return
    el.scrollTo(el.scrollHeight)
    updateAwayFromBottom()
  }
  onCleanup(() => scrollEl?.verticalScrollBar.off("change", updateAwayFromBottom))
  const copyText =
    props.deps?.copyText ??
    (async (text: string) => {
      const clipboard = createClipboard({
        host: createHostClipboard(),
        terminal: createRendererClipboardAdapter(context.renderer),
      })
      const result = await clipboard.writeText(text.replaceAll("\0", ""), {
        destination: "all-available",
        selection: "clipboard",
      })
      if (result.host.status === "written" || result.terminal.status === "attempted") return
      if (result.host.status === "failed") throw result.host.error
      throw new Error("clipboard unavailable on host and terminal")
    })
  const openMessageActions = (id: number) => {
    // A drag-release landing on a message row is a copy gesture, not an open.
    if (selectionActive()) return
    const entry = entryById(id)
    if (!entry || (entry.kind !== "user" && entry.kind !== "agent")) return
    type Action = "jump" | "copy" | "edit"
    const options: { title: string; value: Action; description: string }[] = [
      { title: "Jump to", value: "jump", description: "view message in session" },
      { title: "Copy", value: "copy", description: "message text to clipboard" },
    ]
    if (entry.kind === "user")
      options.push({ title: "Edit in composer", value: "edit", description: "load text into composer" })
    void context.ui.dialog.select<Action>({ title: "Message Actions", options }).then(async (action) => {
      if (action === "jump") {
        const el = entryRefs.get(id)
        if (el && !el.isDestroyed) scrollEl?.scrollChildIntoView(el.id)
      } else if (action === "copy") {
        try {
          // Re-resolve: a streaming agent entry keeps merging after the click.
          const current = entryById(id)
          await copyText(current?.kind === "agent" || current?.kind === "user" ? current.text : entry.text)
          context.ui.toast.show({ message: "Copied to clipboard", variant: "success" })
        } catch (error) {
          context.ui.toast.show({
            message: `copy failed: ${error instanceof Error ? error.message : String(error)}`,
            variant: "error",
          })
        }
      } else if (action === "edit") {
        const input = textEl()
        if (input && !input.isDestroyed) {
          input.setText(entry.text)
          input.focus()
        }
      }
    })
  }

  // Every stream row resolves its entry live through `entryById`: merges
  // replace the stored object but keep `entry.id`, so the row subtree stays
  // mounted and each prop repaints in place. `live`/`streaming`/`isLast`
  // predicates read `lastEntryId()` inside the row instead of a snapshot
  // index — the For callback never re-runs for carried-over rows.
  const userView = (id: number) => {
    const entry = (): Extract<Entry, { kind: "user" }> | undefined => {
      const e = entryById(id)
      return e?.kind === "user" ? e : undefined
    }
    const text = () => `❯ ${entry()?.text ?? ""}${(entry()?.mentions ?? []).map((n) => ` [${n}]`).join("")}`
    const bg = () =>
      hoveredUser() === id ? theme().decrease(theme().background.raised.base) : theme().background.raised.base
    return (
      <box
        border={["left"]}
        customBorderChars={ACCENT_EDGE}
        // Host user-block rail = agent color, falling back to border.base
        // (routes/session/index.tsx) — the wire carries no agent color, so
        // the rail settles on the same token the composer/dock use.
        borderColor={theme().border.base}
        backgroundColor={bg()}
        paddingLeft={2}
        paddingTop={1}
        paddingBottom={1}
        flexShrink={0}
        ref={(r) => entryRefs.set(id, r)}
        onMouseOver={() => setHoveredUser(id)}
        onMouseOut={() => setHoveredUser(undefined)}
        onMouseUp={() => openMessageActions(id)}
      >
        <text fg={theme().text.base} bg={bg()}>{text()}</text>
      </box>
    )
  }

  const agentView = (id: number) => {
    const entry = (): Extract<Entry, { kind: "agent" }> | undefined => {
      const e = entryById(id)
      return e?.kind === "agent" ? e : undefined
    }
    return (
      <box paddingLeft={3} flexShrink={0}>
        <markdown
          content={entry()?.text.trim() ?? ""}
          syntaxStyle={syntax()}
          streaming={busy() && lastEntryId() === id}
          internalBlockMode="top-level"
          tableOptions={{ style: "grid", cellPaddingX: 1 }}
          conceal
          fg={theme().markdown.text}
          bg={theme().background.base}
          ref={(r) => entryRefs.set(id, r)}
          onMouseUp={() => openMessageActions(id)}
        />
      </box>
    )
  }

  // Host ReasoningPart in the default `session.thinking: "hide"` mode: one
  // warning-colored header line (`+ Thought: <summary> · <dur>`), click
  // expands into a railed muted <code> block. While live the header shows
  // a spinner + "Thinking".
  const thoughtView = (id: number) => {
    const entry = (): Extract<Entry, { kind: "thought" }> | undefined => {
      const e = entryById(id)
      return e?.kind === "thought" ? e : undefined
    }
    const live = () => busy() && lastEntryId() === id && entry()?.endedAt === undefined
    const expanded = () => expandedThoughts().has(id)
    const summary = () => reasoningSummary(entry()?.text ?? "")
    const duration = () => {
      const e = entry()
      return e?.endedAt === undefined ? undefined : formatDuration(e.endedAt - e.startedAt)
    }
    const warn = () => theme().text.feedback.warning.base
    const headerFg = () =>
      expanded() ? RGBA.fromValues(warn().r, warn().g, warn().b, 0.6) : warn()
    return (
      <box paddingLeft={3} flexDirection="column" flexShrink={0}>
        <box
          border={expanded() ? ["left"] : []}
          customBorderChars={ACCENT_EDGE}
          borderColor={theme().decrease(theme().background.base)}
          paddingLeft={expanded() ? 1 : 0}
        >
          <box onMouseUp={() => toggleThought(id)}>
            <Show
              when={!live()}
              fallback={
                <SpinnerLine color={headerFg()}>
                  {summary().title ? `Thinking: ${summary().title}` : "Thinking"}
                </SpinnerLine>
              }
            >
              <text fg={headerFg()} wrapMode="none">
                <span>{expanded() ? "- " : "+ "}</span>
                <span>Thought</span>
                <Show when={summary().title !== null || duration() !== undefined}>
                  <span>: </span>
                </Show>
                <Show when={summary().title}>{(title) => <span>{title()}</span>}</Show>
                <Show when={duration()}>
                  {(d) => <span>{`${summary().title !== null ? " · " : ""}${d()}`}</span>}
                </Show>
              </text>
            </Show>
          </box>
        </box>
        <Show when={expanded()}>
          <box marginTop={1}>
            <box
              border={["left"]}
              customBorderChars={ACCENT_EDGE}
              borderColor={theme().decrease(theme().background.base)}
              paddingLeft={3}
            >
              <code
                filetype="markdown"
                drawUnstyledText={false}
                streaming={live()}
                syntaxStyle={thinkingSyntax()}
                content={entry()?.text ?? ""}
                conceal
                fg={theme().text.muted}
              />
            </box>
          </box>
        </Show>
      </box>
    )
  }

  const systemView = (id: number) => {
    const entry = () => {
      const e = entryById(id)
      return e?.kind === "system" ? e : undefined
    }
    return (
      <box paddingLeft={3}>
        <text fg={theme().text.feedback?.warning?.base ?? theme().text.muted}>{`! ${entry()?.text ?? ""}`}</text>
      </box>
    )
  }

  const usageView = (id: number) => {
    const parts = () => {
      const entry = entryById(id)
      if (entry?.kind !== "usage") return ""
      const dims = (entry.dimensions ?? []).map(
        (d) => `${d.label}: ${d.prefix ?? ""}${typeof d.value === "number" ? d.value.toLocaleString() : d.value}${d.tail ?? ""}`,
      )
      return [
        entry.input !== undefined ? `${entry.input.toLocaleString()} in` : undefined,
        entry.output !== undefined ? `${entry.output.toLocaleString()} out` : undefined,
        entry.cached !== undefined && entry.cached > 0 ? `${entry.cached.toLocaleString()} cached` : undefined,
        entry.creditCost !== undefined ? `${entry.creditCost} credits` : undefined,
        entry.acuCost !== undefined ? `${entry.acuCost} ACU` : undefined,
        ...dims,
      ].filter(Boolean).join(" · ")
    }
    return (
      <box paddingLeft={3} flexDirection="row">
        <text fg={theme().text.muted} wrapMode="none">{"+ "}</text>
        <text fg={theme().text.muted} attributes={TextAttributes.BOLD} wrapMode="none">{"Tokens"}</text>
        <text fg={theme().text.muted} wrapMode="none">{`: ${parts()}`}</text>
      </box>
    )
  }

  const turnmetaView = (id: number) => {
    const entry = () => {
      const e = entryById(id)
      return e?.kind === "turnmeta" ? e : undefined
    }
    // Wire-first: agent_stopped's tokensPerSec/totalTimeMs are the turn's own
    // stats — the local outputTokens/wall-clock ratio fills gaps only.
    const tps = () => {
      const e = entry()
      if (e?.tokensPerSec !== undefined) return e.tokensPerSec.toFixed(1)
      return e?.outputTokens && e.durationMs > 0 ? (e.outputTokens / (e.durationMs / 1000)).toFixed(1) : undefined
    }
    const elapsed = () => formatDuration(entry()?.totalTimeMs ?? entry()?.durationMs ?? 0)
    // The remaining wire stats ride one muted tail at host density:
    // `· 2 files · 2 cmds · ttft 0.1s`.
    const tail = () =>
      [
        entry()?.filesChanged !== undefined ? `${entry()!.filesChanged} files` : undefined,
        entry()?.commandsRun !== undefined ? `${entry()!.commandsRun} cmds` : undefined,
        entry()?.ttftMs !== undefined ? `ttft ${formatDuration(entry()!.ttftMs!)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    return (
      <box paddingLeft={3}>
        <text wrapMode="none">
          <span style={{ fg: theme().text.action.primary.base }}>Devin</span>
          <Show when={entry()?.model !== undefined}>
            <span style={{ fg: theme().text.muted }}>{` · ${entry()?.model}`}</span>
          </Show>
          <span style={{ fg: theme().text.muted }}>{` · ${elapsed()}`}</span>
          <Show when={tps() !== undefined}>
            <span style={{ fg: theme().text.muted }}>{` · ${tps()} tok/s`}</span>
          </Show>
          <Show when={tail() !== ""}>
            <span style={{ fg: theme().text.muted }}>{` · ${tail()}`}</span>
          </Show>
        </text>
      </box>
    )
  }

  const planView = (id: number) => {
    const entry = () => {
      const e = entryById(id)
      return e?.kind === "plan" ? e : undefined
    }
    return (
      <box flexDirection="column" paddingLeft={3}>
        <For each={entry()?.items ?? []}>{(item) => <text fg={theme().text.muted} wrapMode="none">{item}</text>}</For>
      </box>
    )
  }

  // Subagent lifecycle notice — same InlineTool row grammar as a tool
  // call (host Subagent: ↳ continuation / │ running / ✓ done / ✗ failed;
  // cancelled strikes through like a denied call). The icon cell spins
  // while the agent runs.
  const subagentView = (id: number) => {
    const entry = () => {
      const e = entryById(id)
      return e?.kind === "subagent" ? e : undefined
    }
    const failed = () => entry()?.state === "failed"
    const cancelled = () => entry()?.state === "cancelled"
    const fg = () => (failed() ? toolErrorFg() : theme().text.muted)
    const state = () => entry()?.state ?? "running"
    return (
      <box paddingLeft={3} flexShrink={0}>
        <box flexDirection="row">
          <text
            width={2}
            wrapMode="none"
            flexShrink={0}
            fg={fg()}
            attributes={cancelled() ? TextAttributes.STRIKETHROUGH : undefined}
          >
            {state() === "running" ? SPINNER_FRAMES[spinIndex()] : state() === "finished" ? "✓" : state() === "failed" ? "✗" : "↳"}
          </text>
          <text
            wrapMode="none"
            flexShrink={1}
            minWidth={0}
            fg={fg()}
            attributes={cancelled() ? TextAttributes.STRIKETHROUGH : undefined}
          >
            {/* Host Subagent: `<Agent> Subagent — <description>` — the wire's
                title is the agent's name, `task` its delegated description. */}
            {`${entry()?.title ?? ""}${entry()?.task ? ` — ${entry()!.task}` : ""}`}
          </text>
          <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>
            {`${entry()?.model ? ` · ${entry()!.model}` : ""}${entry()?.summary ? ` · ${entry()!.summary}` : ""}`}
          </text>
        </box>
      </box>
    )
  }

  // Host InlineToolRow/InlineTool grammar (message-parts.tsx) over the
  // wire's richer slots: ▸ affordance + width-2 icon cell + label + status;
  // the icon cell spins while running, `✗` paints error color on failure,
  // cancelled calls strike through like host denials. Expansion keeps the
  // boxed-code treatment (REQ-BOXED-01) and fills it from the wire: `$ cmd`,
  // <diff> per diff block, terminal output, exit meta; the legacy flattened
  // detail renders only when those slots are empty.
  const toolView = (id: number) => {
    const entry = (): Extract<Entry, { kind: "tool" }> | undefined => {
      const e = entryById(id)
      return e?.kind === "tool" ? e : undefined
    }
    const status = () => entry()?.status ?? ""
    const running = () =>
      status() === "running" ||
      status() === "in_progress" ||
      status() === "pending" ||
      status() === "streaming"
    const failed = () => (status() === "failed" || status() === "error") && entry()?.canceled !== true
    const denied = () => entry()?.canceled === true
    const expanded = () => expandedTools().has(id)
    const metaLine = () => {
      const e = entry()
      if (e === undefined) return ""
      return [
        e.cwd !== undefined ? `cwd ${e.cwd}` : undefined,
        e.timeoutMs !== undefined ? `timeout ${formatDuration(e.timeoutMs)}` : undefined,
        (e.commandNames?.length ?? 0) > 0 ? `argv ${e.commandNames!.join(" ")}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    }
    const hasRich = () =>
      entry()?.command !== undefined ||
      entry()?.output !== undefined ||
      (entry()?.diffs?.length ?? 0) > 0 ||
      metaLine() !== ""
    const expandable = () => hasRich() || (entry()?.detail ?? "") !== "" || entry()?.exitCode !== undefined
    const icon = () => {
      if (failed()) return "✗"
      const glyph = TOOL_GLYPHS[entry()?.toolName ?? ""] ?? TOOL_GLYPHS[entry()?.toolKind ?? ""]
      if (glyph !== undefined) return glyph
      return running() ? "│" : "✓"
    }
    const label = () => {
      const e = entry()
      if (e === undefined) return ""
      if (e.title !== "") return e.title
      if (running()) return TOOL_PENDING[e.toolName ?? ""] ?? TOOL_PENDING[e.toolKind ?? ""] ?? "running…"
      return "tool"
    }
    const hoverable = () => hoveredTool() === id && expandable()
    const labelFg = () =>
      failed() ? toolErrorFg() : hoverable() ? theme().text.base : theme().text.muted
    return (
      <box
        flexDirection="column"
        paddingLeft={3}
        onMouseDown={() => setHoveredTool(id)}
        onMouseMove={() => setHoveredTool(id)}
        onMouseOut={() => setHoveredTool(undefined)}
        onMouseUp={(e) => {
          // Members live inside explored-group boxes — stop the bubble so a
          // member click can't collapse its group on the way up.
          e.stopPropagation()
          if (expandable()) toggleTool(id)
        }}
      >
        <box flexDirection="row">
          <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>
            {expandable() ? (expanded() ? "▾ " : "▸ ") : "  "}
          </text>
          <text
            width={2}
            wrapMode="none"
            flexShrink={0}
            fg={failed() ? toolErrorFg() : theme().text.muted}
            attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}
          >
            {running() ? SPINNER_FRAMES[spinIndex()] : icon()}
          </text>
          <text
            wrapMode="none"
            flexShrink={1}
            minWidth={0}
            fg={labelFg()}
            attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}
          >
            {label()}
          </text>
        </box>
        {/* Detail stays mounted from row creation: a <markdown> or <diff>
            mounted late under this scrollbox subtree paints blank (observed in
            S25), so `visible` carries the collapse instead of unmounting. */}
        <box
          flexDirection="column"
          visible={expanded() && expandable()}
          borderStyle="single"
          borderColor={theme().border?.base ?? theme().text.muted}
          paddingLeft={1}
          paddingRight={1}
          marginTop={0}
        >
          <Show when={entry()?.command}>
            {(command) => (
              <text fg={theme().text.muted} wrapMode="none">{`$ ${command()}`}</text>
            )}
          </Show>
          <For each={entry()?.diffs ?? []}>
            {(d) => {
              const split = dims().width > 120
              return (
                // Host PatchDiff: one <diff> per @@ hunk with the hunk header
                // as a separator line between them.
                <For each={unifiedPatch(d.path, d.oldText, d.newText)}>
                  {(hunk, hi) => (
                    <>
                      <Show when={hi() > 0}>
                        <box width="100%" height={1} backgroundColor={theme().diff.background.context}>
                          <text fg={theme().diff.text?.hunkHeader ?? theme().text.muted} wrapMode="none">
                            {` ${hunk.header}`}
                          </text>
                        </box>
                      </Show>
                      <diff
                        diff={hunk.patch}
                        filetype={filetypeFor(d.path)}
                        syntaxStyle={syntax()}
                        view={split ? "split" : "unified"}
                        minHeight={split ? hunk.splitRows : hunk.rows}
                        showLineNumbers={true}
                        wrapMode="word"
                        width="100%"
                        fg={theme().text.base}
                        addedBg={theme().diff.background.added}
                        removedBg={theme().diff.background.removed}
                        contextBg={theme().diff.background.context}
                        addedSignColor={theme().diff.highlight.added}
                        removedSignColor={theme().diff.highlight.removed}
                        lineNumberFg={theme().diff.lineNumber.text}
                        lineNumberBg={theme().diff.background.context}
                        addedLineNumberBg={theme().diff.lineNumber.background.added}
                        removedLineNumberBg={theme().diff.lineNumber.background.removed}
                      />
                    </>
                  )}
                </For>
              )
            }}
          </For>
          <Show when={entry()?.output !== undefined && entry()?.output !== ""}>
            <text fg={failed() ? toolErrorFg() : theme().text.muted}>{entry()?.output}</text>
          </Show>
          <Show when={metaLine() !== ""}>
            <text fg={theme().text.muted} wrapMode="none">{metaLine()}</text>
          </Show>
          <Show when={entry()?.exitCode !== undefined}>
            <text fg={entry()?.exitCode ? toolErrorFg() : theme().text.muted} wrapMode="none">
              {`exit ${entry()?.exitCode}`}
            </text>
          </Show>
          <markdown
            content={entry()?.detail ?? ""}
            syntaxStyle={syntax()}
            conceal
            fg={failed() ? toolErrorFg() : theme().text.muted}
            visible={(entry()?.detail ?? "") !== "" && entry()?.command === undefined && entry()?.output === undefined && entry()?.detailKind === "text"}
          />
          <text
            fg={failed() ? toolErrorFg() : theme().text.muted}
            visible={(entry()?.detail ?? "") !== "" && entry()?.command === undefined && entry()?.output === undefined && entry()?.detailKind === "mono"}
          >
            {entry()?.detail ?? ""}
          </text>
        </box>
      </box>
    )
  }

  // One dispatch on the immutable kind, once per row — the live accessors
  // inside each view carry every later merge.
  const entryView = (id: number): JSX.Element => {
    switch (entryById(id)?.kind) {
      case "user": return userView(id)
      case "agent": return agentView(id)
      case "thought": return thoughtView(id)
      case "tool": return toolView(id)
      case "system": return systemView(id)
      case "usage": return usageView(id)
      case "turnmeta": return turnmetaView(id)
      case "plan": return planView(id)
      case "permission": return permissionCard(id)
      case "subagent": return subagentView(id)
      default: return undefined
    }
  }

  // Members of a group resolve live the same way a stream row does — the
  // stored Row carries the group-time objects, so map each member id back
  // through entryIndex.
  const thoughtMembers = (id: number) => (): ThoughtEntry[] => {
    const row = rowIndex().get(id)
    if (row?.kind !== "thoughts") return []
    return row.entries.flatMap((member) => {
      const live = member.id === undefined ? undefined : entryById(member.id)
      return live?.kind === "thought" ? [live] : []
    })
  }
  const toolMembers = (id: number) => (): ToolEntry[] => {
    const row = rowIndex().get(id)
    if (row?.kind !== "explored") return []
    return row.entries.flatMap((member) => {
      const live = member.id === undefined ? undefined : entryById(member.id)
      return live?.kind === "tool" ? [live] : []
    })
  }

  // Host reasoning group (group-view.tsx): the same header a single thought
  // carries, plus ` · N steps`; expanded, each member renders its railed
  // muted <code> body in place — never re-nested under another dispatch.
  const thoughtsGroupView = (id: number) => {
    const members = thoughtMembers(id)
    const latest = () => members()[members().length - 1]
    const expanded = () => expandedThoughts().has(id)
    const live = () => busy() && lastEntryId() === latest()?.id && latest()?.endedAt === undefined
    const duration = () => {
      const total = members().reduce((ms, m) => (m.endedAt === undefined ? ms : ms + (m.endedAt - m.startedAt)), 0)
      return total > 0 ? formatDuration(total) : undefined
    }
    const title = () => reasoningSummary(latest()?.text ?? "").title
    const warn = () => theme().text.feedback.warning.base
    const headerFg = () =>
      expanded() ? RGBA.fromValues(warn().r, warn().g, warn().b, 0.6) : warn()
    return (
      <box paddingLeft={3} flexDirection="column" flexShrink={0}>
        <box
          border={expanded() ? ["left"] : []}
          customBorderChars={ACCENT_EDGE}
          borderColor={theme().decrease(theme().background.base)}
          paddingLeft={expanded() ? 1 : 0}
        >
          <box onMouseUp={() => toggleThought(id)}>
            <Show when={!live()} fallback={<SpinnerLine color={headerFg()}>Thinking</SpinnerLine>}>
              <text fg={headerFg()} wrapMode="none">
                <span>{expanded() ? "- " : "+ "}</span>
                <span>Thought</span>
                <Show when={title() !== null || duration() !== undefined}>
                  <span>: </span>
                </Show>
                <Show when={title()}>{(t) => <span>{t()}</span>}</Show>
                <span>{` · ${members().length} steps`}</span>
                <Show when={duration()}>
                  {(d) => <span>{` · ${d()}`}</span>}
                </Show>
              </text>
            </Show>
          </box>
        </box>
        <Show when={expanded()}>
          <For each={members().flatMap((m) => (m.id === undefined ? [] : [m.id]))}>
            {(mid) => {
              const text = () => {
                const e = entryById(mid)
                return e?.kind === "thought" ? e.text : ""
              }
              return (
                <box marginTop={1}>
                  <box
                    border={["left"]}
                    customBorderChars={ACCENT_EDGE}
                    borderColor={theme().decrease(theme().background.base)}
                    paddingLeft={3}
                  >
                    <code
                      filetype="markdown"
                      drawUnstyledText={false}
                      streaming={false}
                      syntaxStyle={thinkingSyntax()}
                      content={text()}
                      conceal
                      fg={theme().text.muted}
                    />
                  </box>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    )
  }

  // Host exploration group: an InlineToolRow-flavored header —
  // `Exploring: 2 reads, 1 search` while any member runs, `Explored:` once
  // all settle; icon is ✱ live, → done, ✗ if any member failed. Expanding
  // lists the member tool rows, which keep their own detail expansion.
  const EXPLORED_NAMES: Record<string, string> = {
    read: "read",
    grep: "search",
    glob: "search",
    webfetch: "fetch",
    fetch: "fetch",
  }
  const exploredGroupView = (id: number) => {
    const members = toolMembers(id)
    const expanded = () => expandedGroups().has(id)
    const running = () =>
      members().some((m) => m.status === "running" || m.status === "in_progress" || m.status === "pending" || m.status === "streaming")
    const failed = () => members().some((m) => (m.status === "failed" || m.status === "error") && m.canceled !== true)
    const label = () => {
      const counts = members().reduce<Record<string, number>>((acc, m) => {
        const name = EXPLORED_NAMES[m.toolName ?? m.toolKind ?? ""] ?? m.toolName ?? m.toolKind ?? "tool"
        acc[name] = (acc[name] ?? 0) + 1
        return acc
      }, {})
      const names = Object.entries(counts).map(
        ([name, count]) => `${count} ${count === 1 ? name : name === "search" || name === "fetch" ? `${name}es` : `${name}s`}`,
      )
      return `${running() ? "Exploring" : "Explored"}: ${names.join(", ")}`
    }
    return (
      <box paddingLeft={3} flexDirection="column" flexShrink={0} onMouseUp={() => toggleGroup(id)}>
        <box flexDirection="row">
          <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>
            {expanded() ? "▾ " : "▸ "}
          </text>
          <text width={2} wrapMode="none" flexShrink={0} fg={failed() ? toolErrorFg() : theme().text.muted}>
            {failed() ? "✗" : running() ? SPINNER_FRAMES[spinIndex()] : "→"}
          </text>
          <text wrapMode="none" flexShrink={1} minWidth={0} fg={theme().text.muted}>
            {label()}
          </text>
        </box>
        <Show when={expanded()}>
          <For each={members().flatMap((m) => (m.id === undefined ? [] : [m.id]))}>
            {(mid) => toolView(mid)}
          </For>
        </Show>
      </box>
    )
  }

  // Row-level dispatch is reactive: a lone read can become an `explored`
  // header when the next read lands adjacent — the row key (first member id)
  // survives, and the Switch swaps the rendered branch in place.
  const rowView = (id: number): JSX.Element => {
    const kind = () => rowIndex().get(id)?.kind
    return (
      <Switch>
        <Match when={kind() === "thoughts"}>{thoughtsGroupView(id)}</Match>
        <Match when={kind() === "explored"}>{exploredGroupView(id)}</Match>
        <Match when={kind() === "entry"}>{entryView(id)}</Match>
      </Switch>
    )
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme().text.muted} wrapMode="none">
          <span style={{ fg: theme().text.action.primary.base }}>Devin</span>
          {` ${sessionTitle() || sessionId() || "…"} · ${currentModel()} · ${currentMode()} · ${currentThinking()}${windowed().hidden > 0 ? ` · ${windowed().hidden} earlier entries hidden` : ""}`}
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        contentOptions={{ minHeight: 0 }}
        // Host routes/session/index.tsx: the stream scrollbar is hidden by
        // default (config session.scrollbar) — the `Jump to latest` pill is
        // the position affordance. The renderable still exists for `change`.
        // Both bars are pinned off: the shared `scrollbarOptions` object once
        // forced the horizontal bar visible too, painting a bright default-
        // colored row across the scrollbox's bottom edge.
        verticalScrollbarOptions={{ paddingLeft: 1, visible: false }}
        horizontalScrollbarOptions={{ visible: false }}
        ref={(r) => {
          scrollEl?.verticalScrollBar.off("change", updateAwayFromBottom)
          scrollEl = r
          r.verticalScrollBar.on("change", updateAwayFromBottom)
        }}
      >
        <Show when={agentFilter()}>
          {(id) => (
            <text fg={theme().text.muted} wrapMode="none">
              {`▸ filtered to ${subagents().find((s) => s.id === id())?.title ?? id()} · esc shows all`}
            </text>
          )}
        </Show>
        {/* Host anchor-view.tsx: every stream entry rides a marginTop-1 row
            wrapper — vertical rhythm between entries is structural, not
            baked into each entry kind. */}
        <For each={streamRowKeys()}>
          {(id) => (
            <box marginTop={1} flexShrink={0}>
              {rowView(id)}
            </box>
          )}
        </For>
      </scrollbox>
      <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Show when={awayFromBottom()}>
          <box
            id="devin-jump-to-latest"
            paddingLeft={1}
            onMouseOver={() => setLatestHovered(true)}
            onMouseOut={() => setLatestHovered(false)}
            onMouseUp={toBottom}
          >
            <text
              fg={
                latestHovered()
                  ? (theme().text.action.secondary?.hovered ?? theme().text.action.secondary.base)
                  : theme().text.action.secondary.base
              }
            >
              Jump to latest ↓
            </text>
          </box>
        </Show>
      </box>
      {/* Inline pickers share the host prompt-autocomplete grammar
          (autocomplete.tsx): a `┃`-railed panel on the raised-high surface,
          rows capped at ten, no row markers — the highlighted row paints the
          primary focused background and its text goes focused. */}
      <box flexShrink={0}>
        <Show when={overlay() === "commands"}>
          <box
            flexDirection="column"
            border={["left", "right"]}
            customBorderChars={SPLIT_BORDER_CHARS}
            borderColor={raised().border.base}
            backgroundColor={raised().background.raised.high}
          >
            {/* Host autocomplete.tsx: height is min(10, count) — an exact row
                count, so a short list never leaves empty railed rows. */}
            <scrollbox height={Math.min(10, Math.max(1, commands().length))} scrollbarOptions={{ visible: false }}>
              <For
                each={commands()}
                fallback={
                  <box paddingLeft={1} paddingRight={1}>
                    <text fg={raised().text.muted}>{"no commands — this session has not reported any"}</text>
                  </box>
                }
              >
                {(command, i) => (
                  <OverlayRow active={i() === highlight()} onPick={() => chooseOption({ command })} onHover={() => setHighlight(i())}>
                    <text fg={rowFg(i() === highlight(), false)} wrapMode="none" flexShrink={0}>
                      {`/${command.name}`}
                    </text>
                    <text fg={rowFg(i() === highlight(), true)} wrapMode="none" flexShrink={1} minWidth={0}>
                      {` ${command.description ? command.description.replace(/\s+/g, " ").trim() : ""}${command.input?.hint ? ` ${command.input.hint}` : ""}`}
                    </text>
                  </OverlayRow>
                )}
              </For>
            </scrollbox>
          </box>
        </Show>
        <Show when={overlay() === "picker"}>
          <box
            flexDirection="column"
            border={["left", "right"]}
            customBorderChars={SPLIT_BORDER_CHARS}
            borderColor={raised().border.base}
            backgroundColor={raised().background.raised.high}
          >
            <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
              <text fg={raised().text.base} attributes={TextAttributes.BOLD}>
                {config().find((o) => o.id === pickerId())?.name ?? pickerId()}
              </text>
              <text fg={raised().text.muted} onMouseUp={() => setPickerOpen(false)}>
                esc
              </text>
            </box>
            <scrollbox height={Math.min(10, Math.max(1, pickerOptions().length))} scrollbarOptions={{ visible: false }}>
              <For
                each={pickerOptions()}
                fallback={
                  <box paddingLeft={1} paddingRight={1}>
                    <text fg={raised().text.muted}>unavailable</text>
                  </box>
                }
              >
                {(option, i) => (
                  <OverlayRow active={i() === highlight()} onPick={() => chooseOption(option)} onHover={() => setHighlight(i())}>
                    <text fg={rowFg(i() === highlight(), false)} wrapMode="none" flexShrink={1} minWidth={0}>
                      {option.name}
                    </text>
                    <box flexGrow={1} minWidth={2} />
                    <text fg={rowFg(i() === highlight(), true)} wrapMode="none" flexShrink={0}>
                      {option.kind ?? ""}
                    </text>
                  </OverlayRow>
                )}
              </For>
            </scrollbox>
          </box>
        </Show>
      </box>
      <Show when={dockOpen()}>
        <box
          flexShrink={0}
          border={["left"]}
          customBorderChars={ACCENT_EDGE}
          borderColor={theme().border?.base ?? theme().text.muted}
          backgroundColor={theme().background.raised.base}
          paddingLeft={1}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <box gap={1}>
            <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
              <box flexDirection="row" gap={2}>
                <For each={DOCK_TABS}>
                  {(label, i) => (
                    <text
                      fg={dockTab() === i() ? theme().text.base : theme().text.muted}
                      attributes={dockTab() === i() ? TextAttributes.BOLD : undefined}
                      onMouseUp={() => {
                        setDockTab(i())
                        setDockRow(0)
                      }}
                    >
                      {label}
                    </text>
                  )}
                </For>
              </box>
              <text fg={theme().text.muted} onMouseUp={closeDock}>
                esc
              </text>
            </box>
            {/* Rows cap at five — the dock is a glanceable tray, not a second
                stream; taller content scrolls inside the rail. */}
            <scrollbox maxHeight={5} scrollbarOptions={{ visible: false }} flexShrink={1} stickyScroll stickyStart="bottom">
              <Switch>
                <Match when={activeDockTab() === "Subagents"}>
                  <Show when={subagents().length > 0} fallback={<text fg={theme().text.muted}>{"  No subagents this session"}</text>}>
                    <For each={subagents()}>
                      {(sub, i) => (
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={
                            dockRow() === i() ? theme().background.action.primary.focused : undefined
                          }
                          onMouseUp={() => {
                            setDockRow(i())
                            invokeDockRow()
                          }}
                        >
                          <text
                            fg={
                              sub.status === "failed"
                                ? (theme().text.feedback?.error?.base ?? theme().text.muted)
                                : sub.status === "done" || sub.status === "cancelled"
                                  ? theme().text.muted
                                  : theme().text.action.primary.base
                            }
                            attributes={sub.status === "cancelled" ? TextAttributes.STRIKETHROUGH : undefined}
                          >
                            {sub.status === "running" ? "●" : sub.status === "done" ? "✓" : "✗"}
                          </text>
                          <text
                            fg={dockRow() === i() ? theme().text.base : theme().text.muted}
                            attributes={
                              ((dockRow() === i() ? TextAttributes.BOLD : 0) |
                                (sub.status === "cancelled" ? TextAttributes.STRIKETHROUGH : 0)) || undefined
                            }
                            wrapMode="none"
                            flexShrink={1}
                            minWidth={0}
                          >
                            {`${sub.title}${sub.model ? ` · ${sub.model}` : ""}`}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Match>
                <Match when={activeDockTab() === "Commands"}>
                  <Show when={commands().length > 0} fallback={<text fg={theme().text.muted}>{"  No commands exposed"}</text>}>
                    <For each={commands()}>
                      {(command, i) => (
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={
                            dockRow() === i() ? theme().background.action.primary.focused : undefined
                          }
                          onMouseUp={() => {
                            setDockRow(i())
                            invokeDockRow()
                          }}
                        >
                          <text
                            fg={dockRow() === i() ? theme().text.base : theme().text.muted}
                            attributes={dockRow() === i() ? TextAttributes.BOLD : undefined}
                            wrapMode="none"
                            flexShrink={0}
                          >
                            {`/${command.name}`}
                          </text>
                          <text fg={theme().text.muted} wrapMode="none" flexShrink={1} minWidth={0}>
                            {(command.description ?? "").replace(/\s+/g, " ").trim()}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                </Match>
                <Match when={activeDockTab() === "Log"}>
                  <Show when={entries().length > 0} fallback={<text fg={theme().text.muted}>{"  No log entries"}</text>}>
                    <For each={entries().slice(-LOG_TAIL)}>{(entry) => compactEntry(entry, theme(), syntax())}</For>
                  </Show>
                </Match>
              </Switch>
            </scrollbox>
            {/* Host composer/index.tsx footer: per-tab hints then `tabs ←/→`,
                each a bold label + muted shortcut chip. */}
            <box flexDirection="row" gap={2} paddingLeft={1} flexShrink={0}>
              <For each={dockHints()}>
                {(hint) => (
                  <text wrapMode="none">
                    <span style={{ fg: theme().text.base }}>
                      <b>{hint.label}</b>{" "}
                    </span>
                    <span style={{ fg: theme().text.muted }}>{hint.shortcut}</span>
                  </text>
                )}
              </For>
            </box>
          </box>
        </box>
      </Show>
      {/* Composer — host component/prompt grammar: a left `┃` rail over the
          dimmed raised surface, metadata + hints inside it, and the `╹`/`▀`
          hook row where the surface ends. No top/bottom border exists, so a
          wrapped textarea line can never be overdrawn by a border row (the
          old single-border box clipped the last wrapped line). */}
      <box
        width="100%"
        flexShrink={0}
        ref={(r: BoxRenderable) => {
          composerEl = r
        }}
      >
        <box width="100%" border={["left"]} borderColor={promptAccent()} customBorderChars={PROMPT_BORDER_CHARS}>
          <box
            paddingLeft={dims().width < 44 ? 1 : 2}
            paddingRight={dims().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              ref={(val: TextareaRenderable) => {
                setTextEl(val)
              }}
              placeholder="Message Devin…"
              placeholderColor={theme().text.muted}
              textColor={composerMuted() ? theme().text.muted : theme().text.base}
              focusedTextColor={composerMuted() ? theme().text.muted : theme().text.base}
              minHeight={1}
              maxHeight={composerMaxHeight()}
              focusedBackgroundColor="transparent"
              cursorColor={theme().text.base}
              syntaxStyle={syntax()}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "kpenter", action: "submit" },
              ]}
              onSubmit={submit}
              onContentChange={mention.refresh}
              onCursorChange={mention.refresh}
              onKeyDown={(event) => {
                if (event.name !== "down" || dockOpen() || lane.binding || sessionId() === "") return
                if (!composerAtLastLine()) return
                event.preventDefault()
                openDock()
              }}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                <text fg={promptAccent()} flexShrink={0}>Devin</text>
                <text fg={theme().text.muted} flexShrink={0}>·</text>
                <text flexShrink={1} minWidth={0} wrapMode="none" truncate fg={theme().text.base}>
                  {currentModel()}
                </text>
                <Show when={composerMeta().mode}>
                  <text fg={theme().text.muted} wrapMode="none" flexShrink={0}>{`· ${currentMode()}`}</text>
                </Show>
                <Show when={composerMeta().thinking}>
                  <text fg={theme().text.muted} wrapMode="none" flexShrink={0}>{`· ${currentThinking()}`}</text>
                </Show>
              </box>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={promptAccent()}
          customBorderChars={{ ...EMPTY_BORDER, vertical: promptBg().a !== 0 ? "╹" : " " }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0 ? { ...EMPTY_BORDER, horizontal: "▀" } : { ...EMPTY_BORDER, horizontal: " " }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexDirection="row" flexShrink={0}>
            <text fg={theme().text.muted} wrapMode="none">
              {status()}
            </text>
            <text fg={theme().text.muted} wrapMode="none">
              {usageText()}
            </text>
          </box>
          {/* Host footer grammar (feature-plugins/prompt/footer.tsx): chips
              fit-or-drop wholesale — lowest priority leaves first, `↓ dock`
              last — so the status readout never collides with a clipped hint. */}
          <box flexDirection="row" gap={2} flexShrink={0}>
            <For each={footerHints()}>
              {(hint) => {
                const split = hint.text.indexOf(" ")
                return (
                  <text wrapMode="none" onMouseUp={hint.id === "dock" ? () => openDock() : undefined}>
                    <span style={{ fg: theme().text.base }}>{hint.text.slice(0, split)}</span>
                    <span style={{ fg: theme().text.muted }}>{hint.text.slice(split)}</span>
                  </text>
                )
              }}
            </For>
          </box>
        </box>
      </box>
      <Show when={mention.open()}>
        <MentionPanel
          rows={mention.rows()}
          highlight={highlight()}
          theme={theme()}
          anchor={() => composerEl}
          onPick={(row) => mention.insert(row)}
          onHover={(i) => setHighlight(i)}
        />
      </Show>
    </box>
  )
}
