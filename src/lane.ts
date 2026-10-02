import { DevinAcpError, agentStopped, toolBlocks, turnStats, updateMeta } from "./acp"
import type {
  AvailableCommand,
  ConfigOption,
  DevinAcpEvents,
  LoadSessionResult,
  NewSessionResult,
  PermissionRequestParams,
  PromptContent,
  PromptOutcome,
  SessionDescriptor,
  SessionListResult,
  SessionUpdate,
  ToolDiff,
  UsageDimension,
} from "./acp"
import { fileCandidates, resolveMentions } from "./mentions"

export type { AvailableCommand, ConfigOption, PermissionRequestParams, SessionDescriptor }
export type PermissionChoice = { readonly id: string; readonly name: string; readonly kind?: string }
export type PermissionOutcome = { outcome: "selected" | "cancelled"; optionId?: string }

export type BindTarget = SessionDescriptor | { readonly pick: "new" }
export const NEW_SESSION: BindTarget = { pick: "new" }

export type SessionsFetch =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly message: string }

// Subagent lifecycle arrives in-stream via `_meta` on tool_call updates
// (wire-inventory P1): `cognition.ai/subagent_started` carries
// {agentId,title,task,model,isBackground}, `subagent_completed` carries
// {agentId,success,summary}.
export interface SubagentInfo {
  readonly id: string
  readonly title: string
  readonly task?: string
  readonly model?: string
  readonly status: "running" | "done" | "failed" | "cancelled"
}

// The lane's one refusal for a bind while occupied — the route's ctrl+o and
// the sidebar's click path both land on this wording.
export const BUSY_BIND_NOTICE = "devin is busy — the prompt must settle before swapping sessions"

// `id` is the lane's render identity, stamped by writeEntries: a monotonic
// number per pushed entry that merges carry forward, so the view keys rows
// and expansion sets on `entry.id` and an in-place merge repaints instead of
// remounting. Wire identities keep domain names (toolId, agentId) — a
// toolCallId identifies a call across updates, not a row.
type WithEntryId<T> = T extends unknown ? T & { id?: number } : never

export type Entry = WithEntryId<
  | { kind: "user"; text: string; mentions?: string[] }
  | { kind: "agent"; text: string; agent?: string }
  | { kind: "thought"; text: string; startedAt: number; endedAt?: number; agent?: string }
  | {
    kind: "tool"
    toolId: string
    title: string
    status: string
    detail: string
    // "text" detail renders as markdown (REQ-TOOL-01); "mono" stays a plain
    // block. Commands/paths/terminal output are mono; content-block text is text.
    detailKind: "mono" | "text"
    toolKind?: string
    agent?: string
    // Wire-rich slots (all `_meta`-sourced, all optional):
    // toolName is the real tool (`exec`,`read`,`edit`,…) behind coarse `kind`.
    toolName?: string
    command?: string
    diffs?: readonly ToolDiff[]
    exitCode?: number
    output?: string
    cwd?: string
    timeoutMs?: number
    commandNames?: readonly string[]
    canceled?: boolean
  }
  | {
    // One row per agent, converged in place by agentId: subagent_started on
    // the run_subagent tool_call opens it "running", subagent_completed on a
    // later update flips it terminal. agent carries the agent's own id so a
    // scoped entry filter still shows its lifecycle.
    kind: "subagent"
    agentId: string
    title: string
    task?: string
    model?: string
    summary?: string
    state: "running" | "finished" | "failed" | "cancelled"
    agent?: string
  }
  | { kind: "plan"; items: string[]; agent?: string }
  | { kind: "permission"; title: string; options: PermissionChoice[]; answered?: string }
  | { kind: "system"; text: string }
  // usage_update `_meta` token counts, rendered as the host's `+ Tokens:` line;
  // cost totals and labelled response dimensions ride the same meta when the
  // capture carries them.
  | {
    kind: "usage"
    input?: number
    output?: number
    cached?: number
    creditCost?: number
    acuCost?: number
    dimensions?: readonly UsageDimension[]
    agent?: string
  }
  // Emitted when a prompt settles: model display name, wall-clock duration,
  // output tokens for the `tok/s` segment — plus the wire's own per-turn stats
  // from _cognition.ai/turn_stats and _cognition.ai/agent_stopped when present.
  | {
    kind: "turnmeta"
    model?: string
    durationMs: number
    outputTokens?: number
    inputTokens?: number
    cachedTokens?: number
    toolCalls?: number
    filesChanged?: number
    commandsRun?: number
    ttftMs?: number
    tokensPerSec?: number
    totalTimeMs?: number
    requestId?: string
    dimensions?: readonly UsageDimension[]
  }
>

export interface DevinEngine {
  readonly alive: boolean
  newSession(cwd: string): Promise<NewSessionResult>
  loadSession(sessionId: string, cwd: string): Promise<LoadSessionResult>
  listSessions(): Promise<SessionListResult>
  prompt(sessionId: string, content: string | PromptContent[], signal?: AbortSignal): Promise<PromptOutcome>
  cancel(sessionId: string): Promise<void>
  setMode(sessionId: string, modeId: string): Promise<unknown>
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown>
  close(): Promise<void>
}

export type SpawnEngine = (input: { cwd: string; events: DevinAcpEvents }) => Promise<DevinEngine>

export interface LaneSink {
  notify(): void
}

interface PendingPermission {
  readonly request: PermissionRequestParams
  readonly entryIndex: number
  readonly resolve: (outcome: PermissionOutcome) => void
}

// REQ-ERR-01: one error→entry mapping for every request path — the wire's
// `user_message` beats the raw message, a retryable flag earns its hint, and
// auth kinds point at the shell login flow.
const describeError = (error: unknown): string => {
  if (error instanceof DevinAcpError) {
    const auth = error.errorKind === "Unauthenticated" || error.errorKind === "AuthFlowError"
    const base = `${error.userMessage ?? error.wireMessage}${error.retryable ? " (retryable)" : ""}${auth ? " — run `devin auth login`" : ""}`
    const pid = error.lockHolderPid
    return pid !== undefined && !base.includes(String(pid)) ? `${base} — held by pid ${pid}` : base
  }
  return error instanceof Error ? error.message : String(error)
}

// Spawn-level failures split three ways for the status line: a missing binary
// (ENOENT / "Executable not found") names the binary and the install/DEVIN_BIN
// fix; auth-shaped wire errors keep the login hint; anything else keeps the
// generic both-causes line. Pure — the view asks the same question through
// `lane.status` after ensure() rejects.
export const describeSpawnFailure = (error: unknown, bin = "devin"): string => {
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === "ENOENT" || /ENOENT|executable not found|^spawn\s/i.test(message)) {
    return `\`${bin}\` not found on PATH — install the Devin CLI or set DEVIN_BIN`
  }
  const auth = error instanceof DevinAcpError && (error.errorKind === "Unauthenticated" || error.errorKind === "AuthFlowError")
  if (auth || /auth|login|unauthoriz/i.test(message)) {
    return "failed to start — devin may need a login (devin auth login)"
  }
  return "failed to start — is devin installed and logged in? (devin auth login)"
}

const describeToolCall = (update: SessionUpdate): string => {
  const input = update.rawInput as Record<string, unknown> | undefined
  const parts: string[] = []
  const command = input?.command ?? input?.cmd
  if (typeof command === "string") parts.push(command.slice(0, 400))
  const path = update.locations?.[0]?.path ?? input?.file_path ?? input?.path
  if (typeof path === "string") parts.push(path)
  return parts.join("\n")
}

// tool_call `content` carries ToolCallContent blocks; acp.ts unwraps them —
// inner `text` blocks flatten into `detail` (and `output` on updates), `diff`
// blocks land on `diffs`.
const capDetail = (text: string): string => text.slice(0, 400)

const mergeToolDetail = (prev: string, additions: string[]): string => {
  let detail = prev
  for (const part of additions) if (!detail.includes(part)) detail = detail ? `${detail}\n${part}` : part
  return detail.trim()
}

// Terminal output outlives the 400-char detail budget but still needs a bound —
// the tail is where an exec's failures land.
const OUTPUT_CAP = 32_000

const mergeOutput = (prev: string | undefined, additions: readonly string[]): string | undefined => {
  let output = prev ?? ""
  for (const part of additions) if (!output.includes(part)) output = output ? `${output}\n${part}` : part
  const text = output.trim()
  if (!text) return undefined
  return text.length > OUTPUT_CAP ? text.slice(text.length - OUTPUT_CAP) : text
}

const mergeDiffs = (prev: readonly ToolDiff[] | undefined, additions: readonly ToolDiff[]): readonly ToolDiff[] => {
  const diffs = [...(prev ?? [])]
  for (const diff of additions) {
    if (!diffs.some((d) => d.path === diff.path && d.oldText === diff.oldText && d.newText === diff.newText)) {
      diffs.push(diff)
    }
  }
  return diffs
}

const toolCommand = (update: SessionUpdate): string | undefined => {
  const input = update.rawInput as Record<string, unknown> | undefined
  const command = input?.command ?? input?.cmd
  return typeof command === "string" ? command.slice(0, 4_000) : undefined
}

type SubagentEntry = Extract<Entry, { kind: "subagent" }>

// The wire can repeat either lifecycle meta across several updates — upsert
// keyed by agentId keeps exactly one notice per agent at its stream position.
const noticeSubagent = (
  list: Entry[],
  agentId: string,
  patch: { state: SubagentEntry["state"]; title?: string; task?: string; model?: string; summary?: string },
): Entry[] => {
  const idx = list.findIndex((e) => e.kind === "subagent" && e.agentId === agentId)
  const prev = idx === -1 ? undefined : list[idx]
  if (prev?.kind !== "subagent") {
    return [
      ...list,
      {
        kind: "subagent" as const,
        agentId,
        title: patch.title ?? agentId,
        task: patch.task,
        model: patch.model,
        summary: patch.summary,
        state: patch.state,
        agent: agentId,
      },
    ]
  }
  const next = list.slice()
  next[idx] = {
    ...prev,
    title: patch.title ?? prev.title,
    task: patch.task ?? prev.task,
    model: patch.model ?? prev.model,
    summary: patch.summary ?? prev.summary,
    state: patch.state,
  }
  return next
}

type TurnMetaEntry = Extract<Entry, { kind: "turnmeta" }>

const definedFields = <T extends object>(patch: { [K in keyof T]?: T[K] }): Partial<T> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>

const sameDims = (a: readonly UsageDimension[] | undefined, b: readonly UsageDimension[] | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((d, i) => d.uid === b[i]?.uid && d.label === b[i]?.label && d.value === b[i]?.value))

export class DevinLane {
  acp: DevinEngine | undefined
  sessionId = ""
  loadingId = ""
  sessionTitle = ""
  readonly config: { current: ConfigOption[] } = { current: [] }
  entries: Entry[] = []
  modeId = ""
  busy = false
  binding = false
  usage: { used: number; size: number } | undefined
  status = "starting devin acp…"
  pending: PendingPermission | undefined
  sessions: SessionDescriptor[] = []
  sessionsFetch: SessionsFetch = { kind: "idle" }
  availableCommands: AvailableCommand[] = []
  subagents: SubagentInfo[] = []
  private readonly queue: Array<{ request: PermissionRequestParams; resolve: (o: PermissionOutcome) => void }> = []
  // Multiple surfaces (route view, sidebar, panel) can subscribe — the lane
  // fans out to every attached sink (ADR-005).
  private sinks = new Set<LaneSink>()
  private starting: Promise<void> | undefined
  private bindSeen = 0
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private flushQueued = false
  private entrySeq = 0
  private turnInput = 0
  private turnOutput = 0
  private turnCached = 0

  constructor(
    readonly cwd: string,
    private readonly spawnEngine: SpawnEngine,
    private readonly binName = "devin",
  ) { }

  attach(sink: LaneSink): void {
    this.sinks.add(sink)
    sink.notify()
  }

  detach(sink: LaneSink): void {
    this.sinks.delete(sink)
  }

  get alive(): boolean {
    return this.acp?.alive ?? false
  }

  private notify(): void {
    if (!this.binding) {
      for (const sink of this.sinks) sink.notify()
      return
    }
    // Replay floods arrive one frame per update — a ~64ms coalesce turns a
    // 1,500-update storm into a few progress paints instead of a render per
    // frame (REQ-BATCH-01), while the status line keeps advancing (REQ-PROG-01).
    this.flushQueued = true
    if (this.flushTimer !== undefined) return
    const timer = setTimeout(() => {
      this.flushTimer = undefined
      if (!this.flushQueued) return
      this.flushQueued = false
      if (this.loadingId) this.status = `loading ${this.loadingId} — ${this.bindSeen} updates`
      for (const sink of this.sinks) sink.notify()
    }, 64)
    timer.unref?.()
    this.flushTimer = timer
  }

  push(entry: Entry): void {
    this.writeEntries((list) => [...list, entry], entry.kind)
  }

  setStatus(text: string): void {
    this.status = text
    this.notify()
  }

  // Anything landing seals the trailing run of open thoughts — interleaved
  // subagent authors can leave one open thought per author, and a non-tail
  // open thought can never receive another chunk. Sole exception: the tail
  // stays open while a same-author thought chunk still merges into it.
  // endedAt is where the "+ Thought: … · Ns" suffix gets its duration from.
  private writeEntries(fn: (list: Entry[]) => Entry[], incoming?: Entry["kind"], author?: string): void {
    let list = this.entries
    if (incoming !== undefined) {
      let end = list.length
      while (end > 0) {
        const e = list[end - 1]
        if (e?.kind !== "thought" || e.endedAt !== undefined) break
        end--
      }
      const last = list[list.length - 1]
      const keepTail = incoming === "thought" && last?.kind === "thought" && last.agent === author
      const sealTo = list.length - (keepTail ? 1 : 0)
      if (end < sealTo) {
        const now = Date.now()
        const next = list.slice()
        for (let i = end; i < sealTo; i++) {
          const t = next[i]
          if (t?.kind === "thought") next[i] = { ...t, endedAt: now }
        }
        list = next
      }
    }
    // Stamp the render identity: entries carried forward keep their stamped
    // id (merge replacements spread it through), new entries take the next
    // sequence number. The counter never resets — a row key stays unique
    // even across binds that swap the whole log.
    this.entries = fn(list).map((entry) => (entry.id === undefined ? { ...entry, id: this.entrySeq++ } : entry))
    this.notify()
  }

  private appendChunk(kind: "agent" | "thought", text: string, author?: string): void {
    this.writeEntries((list) => {
      const last = list[list.length - 1]
      // Chunks merge only within one author — a subagent's stream must not
      // bleed into the root agent's entry (wire-inventory P1).
      if (kind === "thought") {
        // Spread the merged entry so its stamped `id` (and any other slots)
        // survive the replacement — a fresh object would read as a new row.
        if (last?.kind === "thought" && last.agent === author)
          return [...list.slice(0, -1), { ...last, text: last.text + text }]
        return [...list, { kind, text, startedAt: Date.now(), agent: author }]
      }
      if (last?.kind === "agent" && last.agent === author) return [...list.slice(0, -1), { ...last, text: last.text + text }]
      return [...list, { kind, text, agent: author }]
    }, kind, author)
  }

  // turn_stats arrives mid-turn and agent_stopped at its end; both are
  // standalone notifications outside session/update, so they stash into
  // pendingTurnMeta — a live prompt's send() merges the stash into the
  // turnmeta it pushes, and a late/replayed frame flushes into the tail row.
  private pendingTurnMeta: Partial<TurnMetaEntry> | undefined

  private takeTurnMeta(): Partial<TurnMetaEntry> | undefined {
    const stash = this.pendingTurnMeta
    this.pendingTurnMeta = undefined
    return stash
  }

  private patchTailTurnmeta(patch: Partial<TurnMetaEntry>): void {
    const last = this.entries[this.entries.length - 1]
    if (last?.kind !== "turnmeta") return
    this.writeEntries((list) => [...list.slice(0, -1), { ...last, ...patch }], "turnmeta")
  }

  // Idle frames (replayed history, a notification landing after the prompt
  // resolved) flush the stash into a turnmeta row: merged only when the tail
  // row carries THIS turn's requestId — an id-less straggler pushes its own
  // row rather than contaminating the previous turn's.
  private flushTurnMeta(): void {
    const stash = this.takeTurnMeta() ?? {}
    const last = this.entries[this.entries.length - 1]
    if (
      last?.kind === "turnmeta" &&
      last.requestId !== undefined &&
      stash.requestId !== undefined &&
      last.requestId === stash.requestId
    ) {
      this.patchTailTurnmeta(definedFields(stash))
      return
    }
    this.push({ kind: "turnmeta", durationMs: stash.totalTimeMs ?? 0, ...stash })
  }

  // A stash tagged to a different request than the incoming frame is a settled
  // turn's leftover — flush it as its own row before the merge relabels it.
  private flushStaleTurnMeta(requestId: string | undefined): void {
    const pending = this.pendingTurnMeta?.requestId
    if (pending !== undefined && requestId !== undefined && pending !== requestId) this.flushTurnMeta()
  }

  private applyTurnStats(params: unknown): void {
    const stats = turnStats(params)
    if (!stats || !this.acceptsTag(stats.sessionId ?? "")) return
    this.flushStaleTurnMeta(stats.turnRequestId)
    this.pendingTurnMeta = {
      ...this.pendingTurnMeta,
      requestId: stats.turnRequestId ?? this.pendingTurnMeta?.requestId,
      dimensions: stats.dimensions ?? this.pendingTurnMeta?.dimensions,
    }
    if (!this.busy) this.flushTurnMeta()
  }

  private applyAgentStopped(params: unknown): void {
    const stop = agentStopped(params)
    if (!stop || !this.acceptsTag(stop.sessionId ?? "")) return
    const s = stop.stats
    this.flushStaleTurnMeta(s?.requestId)
    this.pendingTurnMeta = {
      ...this.pendingTurnMeta,
      ...definedFields({
        inputTokens: s?.inputTokens,
        outputTokens: s?.outputTokens,
        toolCalls: s?.toolCalls,
        filesChanged: s?.filesChanged,
        commandsRun: s?.commandsRun,
        ttftMs: s?.ttftMs,
        tokensPerSec: s?.tokensPerSec,
        totalTimeMs: s?.totalTimeMs,
        model: s?.modelLabel,
        dimensions: s?.dimensions,
      }),
      requestId: s?.requestId ?? this.pendingTurnMeta?.requestId,
    }
    if (!this.busy) this.flushTurnMeta()
  }

  // run_subagent's tool_call carries cognition.ai/subagent_started and a later
  // update carries subagent_completed — but either meta can ride other update
  // kinds, so lifecycle tracking runs for every update, not just tool frames.
  private trackSubagents(update: SessionUpdate): void {
    const meta = updateMeta(update)
    const started = meta.subagentStarted
    const completed = meta.subagentCompleted
    if (!started?.agentId && !completed?.agentId) return
    if (started?.agentId && !this.subagents.some((s) => s.id === started.agentId)) {
      this.subagents = [
        ...this.subagents,
        {
          id: started.agentId,
          title: started.title ?? started.agentId,
          task: started.task,
          model: started.model,
          status: "running",
        },
      ]
    }
    if (completed?.agentId) {
      const ok = completed.success !== false && meta.canceled !== true
      this.subagents = this.subagents.map((s) =>
        s.id === completed.agentId
          ? { ...s, status: meta.canceled === true ? "cancelled" : ok ? "done" : "failed" }
          : s,
      )
    }
    this.writeEntries((list) => {
      let next = list
      if (started?.agentId) {
        next = noticeSubagent(next, started.agentId, {
          state: "running",
          title: started.title ?? this.subagents.find((s) => s.id === started.agentId)?.title,
          task: started.task,
          model: started.model,
        })
      }
      if (completed?.agentId) {
        next = noticeSubagent(next, completed.agentId, {
          state: meta.canceled === true ? "cancelled" : completed.success === false ? "failed" : "finished",
          title: this.subagents.find((s) => s.id === completed.agentId)?.title,
          summary: completed.summary,
        })
      }
      return next
    }, "subagent")
  }

  private updateTool(update: SessionUpdate): void {
    const meta = updateMeta(update)
    this.writeEntries((list) => {
      const idx = list.findIndex((e) => e.kind === "tool" && e.toolId === update.toolCallId)
      const blocks = toolBlocks(update)
      const textParts = blocks.flatMap((b) => (b.type === "text" ? [b.text] : []))
      const diffs = blocks.flatMap((b) => (b.type === "diff" ? [b] : []))
      const outParts = update.sessionUpdate === "tool_call_update" ? textParts : []
      if (idx === -1) {
        return [
          ...list,
          {
            kind: "tool" as const,
            toolId: update.toolCallId ?? `t${list.length}`,
            title: update.title ?? update.kind ?? meta.toolName ?? "tool",
            status: update.status ?? "running",
            detail: mergeToolDetail(describeToolCall(update), textParts.map(capDetail)),
            detailKind: textParts.length > 0 ? ("text" as const) : ("mono" as const),
            toolKind: update.kind,
            agent: this.authorOf(update),
            toolName: meta.toolName ?? update.kind,
            command: toolCommand(update),
            diffs: diffs.length > 0 ? diffs : undefined,
            exitCode: meta.terminalExit?.exitCode,
            output: mergeOutput(undefined, outParts),
            cwd: meta.cwd,
            timeoutMs: meta.timeoutMs,
            commandNames: meta.commandNames,
            canceled: meta.canceled === true ? true : undefined,
          },
        ]
      }
      const next = list.slice()
      const prev = next[idx] as Extract<Entry, { kind: "tool" }>
      const additions = update.rawOutput
        ? [String(update.rawOutput).slice(0, 400), ...textParts.map(capDetail)]
        : textParts.map(capDetail)
      const detail = mergeToolDetail(prev.detail, additions)
      const diffsAll = mergeDiffs(prev.diffs, diffs)
      next[idx] = {
        ...prev,
        status: update.status ?? prev.status,
        title: update.title ?? prev.title,
        detail,
        detailKind: textParts.length > 0 ? "text" : prev.detailKind,
        toolKind: update.kind ?? prev.toolKind,
        agent: this.authorOf(update) ?? prev.agent,
        toolName: meta.toolName ?? update.kind ?? prev.toolName,
        command: toolCommand(update) ?? prev.command,
        diffs: diffsAll.length > 0 ? diffsAll : prev.diffs,
        exitCode: meta.terminalExit?.exitCode ?? prev.exitCode,
        output: mergeOutput(prev.output, outParts) ?? prev.output,
        cwd: meta.cwd ?? prev.cwd,
        timeoutMs: meta.timeoutMs ?? prev.timeoutMs,
        commandNames: meta.commandNames ?? prev.commandNames,
        canceled: meta.canceled === true ? true : prev.canceled,
      }
      return next
    }, "tool")
  }

  // Events live on the lane and delegate to state, never to a component — a
  // remounted view re-syncs from lane state, so nothing writes into a dead sink.
  // The bound/pending tag filter (ADR-001): a wire frame's session tag must
  // equal the bound sessionId — except while a bind is in flight, when the
  // outgoing tag freezes with the cleared log and only the pending loadingId
  // admits frames (ACP v1 replays before the load response). Anything else
  // parks for re-filtering at drain, and a stale permission request is still
  // answered so the agent isn't left hanging.
  private readonly events: DevinAcpEvents = {
    onUpdate: (sessionId, update) => {
      if (this.acceptsTag(sessionId)) {
        if (this.binding) this.bindSeen++
        this.applyUpdate(update)
        return
      }
      // A `session/new` response and its trailing session-scoped updates can
      // share one stream chunk — the new tag only exists from the response on,
      // while adopt() runs a microtask later. Park unknown-tag traffic for the
      // bind's duration and re-filter it once the id lands.
      if (this.binding && sessionId) this.parked.push({ tag: sessionId, update })
    },
    onPermission: (request) => {
      const tag = request.sessionId ?? ""
      if (this.acceptsTag(tag)) return this.enqueuePermission(request)
      if (this.binding && tag) return this.parkPermission(request)
      return Promise.resolve({ outcome: "cancelled" as const })
    },
    // REQ-NOISE-01: connection-level noise is tolerated by the open-union rule
    // and never touches lane state — except a warn/error `output` line tagged
    // to the live binding, which earns one system entry. MCP:* chatter and
    // empty-tagged lines drop (E32); every other method is ignored.
    onNotification: (method, params) => {
      if (method === "_cognition.ai/turn_stats") {
        this.applyTurnStats(params)
        return
      }
      if (method === "_cognition.ai/agent_stopped") {
        this.applyAgentStopped(params)
        return
      }
      if (method !== "_cognition.ai/output") return
      const line = params as
        | { channel?: unknown; level?: unknown; message?: unknown; sessionId?: unknown }
        | undefined
      if (!line || (line.level !== "warn" && line.level !== "error")) return
      const channel = typeof line.channel === "string" ? line.channel : ""
      if (channel === "MCP" || channel.startsWith("MCP:")) return
      const tag = typeof line.sessionId === "string" ? line.sessionId : ""
      if (!this.acceptsTag(tag)) return
      const message = typeof line.message === "string" ? line.message : ""
      if (!message) return
      this.push({ kind: "system", text: `${channel ? `${channel}: ` : ""}${message}` })
    },
  }

  private parked: { tag: string; update: SessionUpdate }[] = []
  private parkedPerms: { request: PermissionRequestParams; resolve: (o: unknown) => void }[] = []

  private parkPermission(request: PermissionRequestParams): Promise<unknown> {
    return new Promise((resolve) => this.parkedPerms.push({ request, resolve }))
  }

  private drainParked(): void {
    for (const p of this.parked.splice(0)) {
      if (this.acceptsTag(p.tag)) this.applyUpdate(p.update)
    }
    for (const p of this.parkedPerms.splice(0)) {
      const tag = p.request.sessionId ?? ""
      if (this.acceptsTag(tag)) void this.enqueuePermission(p.request).then(p.resolve)
      else p.resolve({ outcome: "cancelled" as const })
    }
  }

  private acceptsTag(tag: string): boolean {
    if (tag === "") return false
    return this.binding ? tag === this.loadingId : tag === this.sessionId
  }

  // subagent_context.parentAgentId names the authoring agent — "root" is the
  // main agent and earns no tag since it owns the unfiltered view.
  private authorOf(update: SessionUpdate): string | undefined {
    return updateMeta(update).subagentParent
  }

  private applyUpdate(update: SessionUpdate): void {
    this.dispatchUpdate(update)
    // Lifecycle notices append after the frame's own entry — a run_subagent
    // tool_call renders ahead of the subagent row it spawned.
    this.trackSubagents(update)
  }

  private dispatchUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const content = update.content
        const text = !content ? "" : content.type === "resource_link" ? (content.name ?? "linked resource") : (content.text ?? "")
        if (text) this.push({ kind: "user", text })
        return
      }
      case "session_info_update":
        if (update.title !== undefined) this.sessionTitle = String(update.title)
        this.notify()
        return
      case "available_commands_update":
        this.availableCommands = [...(update.availableCommands ?? [])]
        this.notify()
        return
      case "agent_message_chunk":
        if (update.content?.text) this.appendChunk("agent", update.content.text, this.authorOf(update))
        return
      case "agent_thought_chunk":
        if (update.content?.text) this.appendChunk("thought", update.content.text, this.authorOf(update))
        return
      case "tool_call":
      case "tool_call_update":
        this.updateTool(update)
        return
      case "plan":
        this.push({
          kind: "plan",
          items: (update.entries ?? []).map(
            (e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content ?? ""}`,
          ),
          agent: this.authorOf(update),
        })
        return
      case "current_mode_update":
        if (update.currentModeId) this.modeId = update.currentModeId
        this.config.current = this.config.current.map((o) =>
          o.id === "mode" ? { ...o, currentValue: update.currentModeId } : o,
        )
        this.notify()
        return
      case "config_option_update":
        if (update.configOptions) this.config.current = [...update.configOptions]
        this.notify()
        return
      case "usage_update": {
        const used = Number(update.used ?? 0)
        const size = Number(update.size ?? 0)
        if (Number.isFinite(used) && Number.isFinite(size)) this.usage = { used, size }
        const meta = updateMeta(update)
        const { inputTokens, outputTokens, cachedReadTokens } = meta
        // Turn sums feed the `tok/s` footer for the root agent — a subagent's
        // usage_update is tagged and stays out of them.
        if (this.authorOf(update) === undefined) {
          if (inputTokens !== undefined) this.turnInput = inputTokens
          if (outputTokens !== undefined) this.turnOutput = outputTokens
          if (cachedReadTokens !== undefined) this.turnCached = cachedReadTokens
        }
        const hasTokens = inputTokens !== undefined || outputTokens !== undefined || cachedReadTokens !== undefined
        const hasCosts = meta.creditCost !== undefined || meta.acuCost !== undefined || meta.dimensions !== undefined
        if (hasTokens || hasCosts) {
          const next = {
            input: inputTokens,
            output: outputTokens,
            cached: cachedReadTokens,
            creditCost: meta.creditCost,
            acuCost: meta.acuCost,
            dimensions: meta.dimensions,
          }
          const author = this.authorOf(update)
          const last = this.entries[this.entries.length - 1]
          const same =
            last?.kind === "usage" &&
            last.input === next.input &&
            last.output === next.output &&
            last.cached === next.cached &&
            last.creditCost === next.creditCost &&
            last.acuCost === next.acuCost &&
            sameDims(last.dimensions, next.dimensions) &&
            last.agent === author
          if (!same) this.push({ kind: "usage", ...next, agent: author })
          return
        }
        this.notify()
        return
      }
    }
  }

  private enqueuePermission(request: PermissionRequestParams): Promise<PermissionOutcome> {
    if (this.pending) {
      return new Promise((resolve) => this.queue.push({ request, resolve }))
    }
    return this.presentPermission(request)
  }

  private presentPermission(request: PermissionRequestParams): Promise<PermissionOutcome> {
    const title = request.toolCall?.title ?? request.toolCall?.kind ?? "Tool call"
    const options = (request.options ?? []).map((o) => ({
      id: o.optionId ?? o.id ?? "",
      name: o.name ?? o.optionId ?? o.id ?? "option",
      kind: o.kind,
    }))
    const entryIndex = this.entries.length
    let resolveFn: ((o: PermissionOutcome) => void) | undefined
    const promise = new Promise<PermissionOutcome>((resolve) => {
      resolveFn = resolve
    })
    this.pending = { request, entryIndex, resolve: resolveFn! }
    this.push({ kind: "permission", title, options })
    return promise
  }

  answerPermission(choice?: PermissionChoice): void {
    const pending = this.pending
    if (!pending) return
    this.pending = undefined
    this.writeEntries((list) =>
      list.map((e, i) =>
        i === pending.entryIndex && e.kind === "permission" ? { ...e, answered: choice?.name ?? "cancelled" } : e,
      ),
    )
    pending.resolve(choice ? { outcome: "selected", optionId: choice.id } : { outcome: "cancelled" })
    const next = this.queue.shift()
    if (next) void this.presentPermission(next.request).then(next.resolve)
  }

  private flushPermissions(): void {
    const pending = this.pending
    if (pending) {
      this.pending = undefined
      this.writeEntries((list) =>
        list.map((e, i) => (i === pending.entryIndex && e.kind === "permission" ? { ...e, answered: "cancelled" } : e)),
      )
      pending.resolve({ outcome: "cancelled" })
    }
    for (const queued of this.queue.splice(0)) queued.resolve({ outcome: "cancelled" })
  }

  async ensure(): Promise<void> {
    if (this.alive) return
    this.starting ??= this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async start(): Promise<void> {
    // The body's sync prefix would otherwise run before ensure() assigns
    // `this.starting` — a notify() in that window re-enters ensure() (picker
    // mount → refreshSessions) and spawns a second engine.
    await Promise.resolve()
    const restarting = this.acp !== undefined && !this.acp.alive
    if (restarting) {
      this.sessionId = ""
      this.loadingId = ""
      this.sessionTitle = ""
      this.config.current = []
      this.availableCommands = []
      this.subagents = []
      this.usage = undefined
      this.pendingTurnMeta = undefined
      this.modeId = ""
      this.sessions = []
      this.sessionsFetch = { kind: "idle" }
      this.flushPermissions()
      this.push({ kind: "system", text: "devin acp died — restarting…" })
    }
    this.status = "starting devin acp…"
    this.notify()
    let acp: Awaited<ReturnType<SpawnEngine>>
    try {
      acp = await this.spawnEngine({ cwd: this.cwd, events: this.events })
    } catch (error) {
      // Without this the last caller's failure leaves "starting devin acp…"
      // up forever — classify here so every ensure() failure lands honestly.
      this.status = describeSpawnFailure(error, this.binName)
      this.notify()
      throw error
    }
    this.acp = acp
    if (restarting) {
      this.push({ kind: "system", text: "restarted devin acp — pick a session" })
    }
    this.status = restarting ? "restarted devin acp — pick a session" : "pick a Devin session"
    this.notify()
  }

  async refreshSessions(): Promise<void> {
    this.sessionsFetch = { kind: "loading" }
    this.sessions = []
    this.notify()
    try {
      await this.ensure()
      // The engine can die between the alive check and the write — the exit
      // event lands before the pending request rejects, so `alive` is false
      // here and one respawn converges the retry.
      const result = await this.acp!.listSessions().catch(async (error) => {
        if (this.alive) throw error
        await this.ensure()
        return this.acp!.listSessions()
      })
      this.sessions = [...result.sessions]
      this.sessionsFetch = { kind: "ready" }
      this.notify()
    } catch (error) {
      const message = describeError(error)
      this.sessionsFetch = { kind: "error", message }
      // Bound (or mid-bind) lanes keep the log for the session — the picker's
      // fetchError row carries the failure. Only an unbound log earns the
      // system entry, where it is the only visible surface.
      if (this.sessionId || this.binding) this.notify()
      else this.push({ kind: "system", text: `could not list sessions: ${message}` })
    }
  }

  async bind(target: BindTarget): Promise<void> {
    if (this.busy || this.binding || this.pending) {
      // A refused bind is audible — the sidebar's click path lands here with
      // no route handler to notice the no-op (E25).
      this.push({ kind: "system", text: BUSY_BIND_NOTICE })
      return
    }
    // Re-picking the bound descriptor is a dismiss, not a load (E39).
    if (!("pick" in target) && target.sessionId === this.sessionId) return
    this.binding = true
    this.bindSeen = 0
    this.status = "pick" in target ? "starting a new Devin session…" : `loading ${target.sessionId} — 0 updates`
    this.notify()
    // A failed bind restores this snapshot wholesale (REQ-LOCK-01): nothing
    // replayed under the failed tag is presented as current, and a bound
    // lane keeps its prior log/header — the error entry is appended after.
    const prior = {
      entries: this.entries,
      usage: this.usage,
      availableCommands: this.availableCommands,
      modeId: this.modeId,
      sessionTitle: this.sessionTitle,
      config: [...this.config.current],
      subagents: this.subagents,
    }
    try {
      await this.ensure()
      // A live local holder means the wire would stream the entire replay
      // before refusing with -32015 — the pid probe refuses up front, before
      // the log is cleared or a single load frame is sent (REQ-LOCKPRE-01).
      if (!("pick" in target)) this.refuseLiveHolder(target)
      // The lane re-reads like a fresh mount of the target session — nothing
      // from the previous binding may bleed through.
      this.resetForBind()
      if ("pick" in target) {
        const session = await this.acp!.newSession(this.cwd)
        this.adopt(session)
        this.status = `ready — devin session ${session.sessionId}`
      } else {
        // ACP v1 replays the log BEFORE the load response — loadingId accepts
        // that tag while sessionId still names the previous (or no) binding.
        this.loadingId = target.sessionId
        const result = await this.loadWithCwdFallback(target)
        this.adopt({ ...result, sessionId: target.sessionId })
        this.status = `ready — devin session ${target.sessionId}`
      }
      this.notify()
    } catch (error) {
      const message = describeError(error)
      // Mid-bind permission traffic belongs to the failed session — answer it
      // cancelled on the wire before the log rollback, so a stale entryIndex
      // never marks a prior card and no queued request resurfaces as a ghost.
      this.flushPermissions()
      this.entries = prior.entries
      this.usage = prior.usage
      this.availableCommands = prior.availableCommands
      this.modeId = prior.modeId
      this.sessionTitle = prior.sessionTitle
      this.config.current = prior.config
      this.subagents = prior.subagents
      const what = "pick" in target ? "start a new session" : `load session ${target.sessionId}`
      this.status = `could not ${what}: ${message}`
      this.push({ kind: "system", text: this.status })
    } finally {
      this.binding = false
      this.loadingId = ""
      if (this.flushTimer !== undefined) {
        clearTimeout(this.flushTimer)
        this.flushTimer = undefined
      }
      this.flushQueued = false
      this.drainParked()
      this.notify()
    }
  }

  // EPERM means the process exists but is owned by another user — still held.
  private refuseLiveHolder(target: SessionDescriptor): void {
    const pid = target.lockHolderPid
    if (!target.isLocked || pid === undefined) return
    let alive = true
    try {
      process.kill(pid, 0)
    } catch (error) {
      alive = (error as { code?: string }).code === "EPERM"
    }
    if (alive) {
      throw new Error(`session is held by live process ${pid} — close the other client or pick another session`)
    }
  }

  private resetForBind(): void {
    this.entries = []
    this.usage = undefined
    this.pendingTurnMeta = undefined
    this.availableCommands = []
    this.subagents = []
    this.modeId = ""
    this.sessionTitle = ""
    this.flushPermissions()
    this.notify()
  }

  // Whether session/load requires the session's recorded cwd is unprobed
  // (ADR-001 risk 3): the descriptor cwd goes first, a rejection retries once
  // on the lane cwd, and a second rejection takes the error path (E42).
  private async loadWithCwdFallback(target: SessionDescriptor): Promise<LoadSessionResult> {
    const sent = target.cwd ?? this.cwd
    try {
      return await this.acp!.loadSession(target.sessionId, sent)
    } catch (first) {
      if (sent === this.cwd) throw first
      this.resetForBind()
      return await this.acp!.loadSession(target.sessionId, this.cwd)
    }
  }

  private adopt(session: NewSessionResult): void {
    this.sessionId = session.sessionId
    this.config.current = [...(session.configOptions ?? [])]
    this.modeId = session.modes?.currentModeId ?? ""
  }

  async send(text: string): Promise<void> {
    this.busy = true
    try {
      await this.ensure()
      if (this.binding) throw new Error("a session bind is in flight")
      if (!this.sessionId) throw new Error("no devin session bound — pick a session")
      const mentions = resolveMentions(this.cwd, text)
      this.push({ kind: "user", text, mentions: mentions.map((m) => m.name) })
      this.status = "devin is working…"
      this.notify()
      const startedAt = Date.now()
      this.turnInput = 0
      this.turnOutput = 0
      this.turnCached = 0
      this.pendingTurnMeta = undefined
      const outcome = await this.acp!.prompt(this.sessionId, [{ type: "text", text }, ...mentions])
      const model = this.config.current
        .find((o) => o.id === "model")
        ?.options?.find((o) => o.value === this.config.current.find((c) => c.id === "model")?.currentValue)?.name
      const stash = this.takeTurnMeta()
      this.push({
        kind: "turnmeta",
        ...stash,
        // Wire fields beat derived values: agent_stopped's modelLabel and
        // token counts are the turn's own stats; config lookup and the
        // usage_update tally fill gaps only.
        model: stash?.model ?? model,
        durationMs: Date.now() - startedAt,
        outputTokens: stash?.outputTokens ?? (this.turnOutput > 0 ? this.turnOutput : undefined),
      })
      if (!outcome.text) this.push({ kind: "system", text: `(stop: ${outcome.stopReason})` })
      this.status = `ready — ${outcome.stopReason}`
      this.notify()
    } catch (error) {
      const message = describeError(error)
      this.push({ kind: "system", text: `error: ${message}` })
      this.status = "error"
      this.notify()
      throw error
    } finally {
      this.busy = false
      this.notify()
    }
  }

  async applyConfig(id: string, value: string): Promise<void> {
    const acp = this.acp
    if (!acp || !this.sessionId) return
    try {
      if (id === "mode") {
        try {
          await acp.setMode(this.sessionId, value)
        } catch {
          await acp.setConfigOption(this.sessionId, id, value)
        }
      } else {
        await acp.setConfigOption(this.sessionId, id, value)
      }
    } catch (error) {
      this.push({
        kind: "system",
        text: `could not set ${id}: ${describeError(error)}`,
      })
      return
    }
    this.config.current = this.config.current.map((o) => (o.id === id ? { ...o, currentValue: value } : o))
    if (id === "mode") this.modeId = value
    this.notify()
  }

  // The lane supplies `@` completions (src/mentions.ts owns the bounded
  // filesystem walk) so the view never touches the disk itself.
  fileCandidates(prefix: string): Promise<string[]> {
    return fileCandidates(this.cwd, prefix)
  }

  cancel(): void {
    if (!this.busy || !this.acp) return
    void this.acp.cancel(this.sessionId)
  }

  configValue(id: string): ConfigOption | undefined {
    return this.config.current.find((o) => o.id === id)
  }
}

const lanes = new Map<string, DevinLane>()

export function laneFor(key: string, deps: { cwd: string; spawnEngine: SpawnEngine; binName?: string }): DevinLane {
  const existing = lanes.get(key)
  if (existing) return existing
  const lane = new DevinLane(deps.cwd, deps.spawnEngine, deps.binName)
  lanes.set(key, lane)
  return lane
}
