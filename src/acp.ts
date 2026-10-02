import { spawn, type Subprocess } from "bun"

export interface AvailableCommand {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string }
}

export interface SessionUpdate {
  readonly sessionUpdate: string
  readonly content?: {
    readonly type?: string
    readonly text?: string
    readonly name?: string
    readonly uri?: string
    readonly mimeType?: string
  }
  readonly availableCommands?: ReadonlyArray<AvailableCommand>
  readonly toolCallId?: string
  readonly title?: string
  readonly status?: string
  readonly kind?: string
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly locations?: ReadonlyArray<{ readonly path?: string }>
  readonly entries?: ReadonlyArray<{ readonly content?: string; readonly status?: string }>
  readonly currentModeId?: string
  readonly configOptions?: ReadonlyArray<ConfigOption>
  readonly [key: string]: unknown
}

export interface ConfigOptionChoice {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface ConfigOption {
  readonly id: string
  readonly name: string
  readonly category?: string
  readonly type?: string
  readonly currentValue?: string
  readonly options?: ReadonlyArray<ConfigOptionChoice>
}

export interface SessionMode {
  readonly id: string
  readonly name?: string
}

export interface NewSessionResult {
  readonly sessionId: string
  readonly modes?: { readonly currentModeId?: string; readonly availableModes?: ReadonlyArray<SessionMode> }
  readonly configOptions?: ReadonlyArray<ConfigOption>
}

export type LoadSessionResult = Omit<NewSessionResult, "sessionId">

export interface SessionDescriptor {
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  readonly updatedAt?: string
  readonly createdAt?: string
  readonly isLocked: boolean
  readonly lockHolderPid?: number
  readonly requestingTabId?: string
}

export interface SessionListResult {
  readonly sessions: ReadonlyArray<SessionDescriptor>
  readonly nextCursor?: string
}

export type PromptContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly uri: string; readonly name: string; readonly mimeType?: string }

export interface PermissionRequestParams {
  readonly sessionId: string
  readonly toolCall?: { readonly toolCallId?: string; readonly title?: string; readonly kind?: string; readonly rawInput?: unknown }
  readonly options?: ReadonlyArray<PermissionOption>
}

export interface PromptOutcome {
  readonly stopReason: string
  readonly text: string
  readonly thoughts: string
}

export interface DevinAcpEvents {
  readonly onUpdate?: (sessionId: string, update: SessionUpdate) => void
  readonly onPermission?: (params: PermissionRequestParams) => Promise<unknown>
  readonly onNotification?: (method: string, params: unknown) => void
}

export interface DevinAcpOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly autoApprove: boolean
  readonly requestTimeoutMs?: number
  readonly events?: DevinAcpEvents
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

// Wire-error taxonomy: `error.data` keys `cognition.ai/errorKind`,
// `user_message`, `retryable` become typed fields at this seam — the raw wire
// keys never cross into the lane (REQ-ERR-01).
export class DevinAcpError extends Error {
  readonly code: number
  readonly wireMessage: string
  readonly errorKind?: string
  readonly userMessage?: string
  readonly lockHolderPid?: number
  readonly retryable: boolean

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(`devin acp ${code}: ${message}`)
    this.name = "DevinAcpError"
    this.code = code
    this.wireMessage = message
    const errorKind = data?.["cognition.ai/errorKind"]
    const userMessage = data?.["user_message"]
    const lockHolderPid = data?.["cognition.ai/lockHolderPid"]
    if (typeof errorKind === "string") this.errorKind = errorKind
    if (typeof userMessage === "string") this.userMessage = userMessage
    if (typeof lockHolderPid === "number") this.lockHolderPid = lockHolderPid
    this.retryable = data?.["retryable"] === true || data?.["cognition.ai/retryable"] === true
  }
}

interface PendingPrompt {
  chunks: string[]
  thoughts: string[]
}

interface PermissionOption {
  readonly optionId?: string
  readonly id?: string
  readonly name?: string
  readonly kind?: string
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

// The real tool name rides `_meta["cognition.ai/inferenceToolName"]` — exec,
// read, edit, write, read_subagent, skill, run_subagent, get_output,
// todo_write, webfetch, ask_user_question — while `update.kind` stays coarse
// (execute/read/edit/fetch). `terminal_exit` is a bare _meta key (no prefix):
// {terminal_id, exit_code, signal}.
export interface TerminalExit {
  readonly terminalId?: string
  readonly exitCode?: number
  readonly signal?: number | null
}

export interface SubagentStarted {
  readonly agentId?: string
  readonly title?: string
  readonly task?: string
  readonly model?: string
  readonly isBackground?: boolean
}

export interface SubagentCompleted {
  readonly agentId?: string
  readonly success?: boolean
  readonly summary?: string
}

// usage_update `_meta.responseDimensions` serializes each metric as
// {uid, group_title, kind:{Metric:{label,value:string}|CumulativeMetric:{label,
// value:number,prefix,tail,plural_tail}}} — the Rust enum spelling. The
// `_cognition.ai/turn_stats` notification carries the same data in the
// TypeScript spelling ({label, kind:{type:"metric"|"cumulativeMetric",...}});
// both normalize here so nothing downstream sees either wire shape.
export interface UsageDimension {
  readonly uid?: string
  readonly group?: string
  readonly label: string
  readonly value: number | string
  readonly prefix?: string
  readonly tail?: string
  readonly pluralTail?: string
}

// Every `_meta` key the lane consumes, parsed once at the wire seam.
export interface UpdateMeta {
  readonly toolName?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly canceled?: boolean
  readonly commandNames?: readonly string[]
  readonly terminalExit?: TerminalExit
  readonly subagentStarted?: SubagentStarted
  readonly subagentCompleted?: SubagentCompleted
  readonly subagentParent?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedReadTokens?: number
  readonly creditCost?: number
  readonly acuCost?: number
  readonly dimensions?: readonly UsageDimension[]
}

const toDimension = (raw: unknown): UsageDimension | undefined => {
  const rec = asRecord(raw)
  if (!rec) return undefined
  const uid = asString(rec.uid)
  const group = asString(rec.group_title) ?? asString(rec.groupTitle)
  const kind = asRecord(rec.kind)
  if (!kind) return undefined
  const inner = asRecord(kind["CumulativeMetric"]) ?? asRecord(kind["Metric"])
  if (inner) {
    const value = asNumber(inner.value) ?? asString(inner.value)
    const label = asString(inner.label)
    if (value === undefined || label === undefined) return undefined
    return {
      uid,
      group,
      label,
      value,
      prefix: asString(inner.prefix),
      tail: asString(inner.tail),
      pluralTail: asString(inner.plural_tail),
    }
  }
  const type = asString(kind.type)
  if (type !== "metric" && type !== "cumulativeMetric") return undefined
  const value = asNumber(kind.value) ?? asString(kind.value)
  const label = asString(rec.label)
  if (value === undefined || label === undefined) return undefined
  return {
    uid,
    group,
    label,
    value,
    prefix: asString(kind.prefix),
    tail: asString(kind.tail),
    pluralTail: asString(kind.pluralTail),
  }
}

const toDimensions = (raw: unknown): readonly UsageDimension[] | undefined => {
  if (!Array.isArray(raw)) return undefined
  const dims: UsageDimension[] = []
  for (const entry of raw) {
    const dim = toDimension(entry)
    if (dim) dims.push(dim)
  }
  return dims.length ? dims : undefined
}

export const updateMeta = (update: SessionUpdate): UpdateMeta => {
  const meta = asRecord(update._meta)
  if (!meta) return {}
  const started = asRecord(meta["cognition.ai/subagent_started"])
  const completed = asRecord(meta["cognition.ai/subagent_completed"])
  const context = asRecord(meta["cognition.ai/subagent_context"])
  const terminalExit = asRecord(meta["terminal_exit"])
  const commandNames = meta["cognition.ai/commandNames"]
  const parent = asString(context?.parentAgentId)
  return {
    toolName: asString(meta["cognition.ai/inferenceToolName"]),
    cwd: asString(meta["cognition.ai/cwd"]),
    timeoutMs: asNumber(meta["cognition.ai/timeoutMs"]),
    canceled: asBoolean(meta["cognition.ai/canceled"]),
    commandNames: Array.isArray(commandNames)
      ? commandNames.filter((name): name is string => typeof name === "string")
      : undefined,
    terminalExit: terminalExit
      ? {
        terminalId: asString(terminalExit.terminal_id),
        exitCode: asNumber(terminalExit.exit_code),
        signal: asNumber(terminalExit.signal) ?? (terminalExit.signal === null ? null : undefined),
      }
      : undefined,
    subagentStarted: started
      ? {
        agentId: asString(started.agentId),
        title: asString(started.title),
        task: asString(started.task),
        model: asString(started.model),
        isBackground: asBoolean(started.isBackground),
      }
      : undefined,
    subagentCompleted: completed
      ? {
        agentId: asString(completed.agentId),
        success: asBoolean(completed.success),
        summary: asString(completed.summary),
      }
      : undefined,
    subagentParent: parent !== undefined && parent !== "root" ? parent : undefined,
    inputTokens: asNumber(meta["cognition.ai/inputTokens"]),
    outputTokens: asNumber(meta["cognition.ai/outputTokens"]),
    cachedReadTokens: asNumber(meta["cognition.ai/cachedReadTokens"]),
    creditCost: asNumber(meta["cognition.ai/totalCreditCost"]),
    acuCost: asNumber(meta["cognition.ai/totalAcuCost"]),
    dimensions: toDimensions(meta["cognition.ai/responseDimensions"]),
  }
}

// tool_call/tool_call_update `content` blocks: `type:"diff"` blocks are flat
// ({type,path,newText,oldText?} — write calls omit oldText); real output text
// arrives wrapped as {type:"content",content:{type:"text",text}} while the
// exec preview echo wraps {type:"resource",resource:{uri:"tool://preview"}}.
// Unknown block kinds and previews never cross the seam.
export interface ToolDiff {
  readonly type: "diff"
  readonly path: string
  readonly oldText?: string
  readonly newText: string
}

export type ToolBlock = { readonly type: "text"; readonly text: string } | ToolDiff

export const toolBlocks = (update: SessionUpdate): readonly ToolBlock[] => {
  const content = update.content
  if (!Array.isArray(content)) return []
  const blocks: ToolBlock[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === "diff") {
      const path = asString(block.path)
      const newText = asString(block.newText)
      if (path !== undefined && newText !== undefined) {
        blocks.push({ type: "diff", path, newText, oldText: asString(block.oldText) })
      }
      continue
    }
    if (block.type === "content") {
      const inner = asRecord(block.content)
      if (inner?.type === "text" && typeof inner.text === "string") {
        blocks.push({ type: "text", text: inner.text })
      }
      continue
    }
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text })
    }
  }
  return blocks
}

// `_cognition.ai/agent_stopped` is a standalone notification (not a
// session/update): params {sessionId, cause, stats:{toolCalls, filesChanged,
// commandsRun, inputTokens, outputTokens, ttftMs, tokensPerSec, totalTimeMs,
// requestId, modelLabel, responseDimensions}}.
export interface AgentStopped {
  readonly sessionId?: string
  readonly cause?: string
  readonly stats?: {
    readonly toolCalls?: number
    readonly filesChanged?: number
    readonly commandsRun?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly ttftMs?: number
    readonly tokensPerSec?: number
    readonly totalTimeMs?: number
    readonly requestId?: string
    readonly modelLabel?: string
    readonly dimensions?: readonly UsageDimension[]
  }
}

export const agentStopped = (params: unknown): AgentStopped | undefined => {
  const rec = asRecord(params)
  if (!rec) return undefined
  const stats = asRecord(rec.stats)
  return {
    sessionId: asString(rec.sessionId),
    cause: asString(rec.cause),
    stats: stats
      ? {
        toolCalls: asNumber(stats.toolCalls),
        filesChanged: asNumber(stats.filesChanged),
        commandsRun: asNumber(stats.commandsRun),
        inputTokens: asNumber(stats.inputTokens),
        outputTokens: asNumber(stats.outputTokens),
        ttftMs: asNumber(stats.ttftMs),
        tokensPerSec: asNumber(stats.tokensPerSec),
        totalTimeMs: asNumber(stats.totalTimeMs),
        requestId: asString(stats.requestId),
        modelLabel: asString(stats.modelLabel),
        dimensions: toDimensions(stats.responseDimensions),
      }
      : undefined,
  }
}

// `_cognition.ai/turn_stats` arrives mid-turn ahead of agent_stopped:
// params {sessionId, turnClientMessageId, turnRequestId, responseDimensions}
// with dimensions in the TypeScript spelling (groupTitle, kind.type).
export interface TurnStats {
  readonly sessionId?: string
  readonly turnClientMessageId?: string
  readonly turnRequestId?: string
  readonly dimensions?: readonly UsageDimension[]
}

export const turnStats = (params: unknown): TurnStats | undefined => {
  const rec = asRecord(params)
  if (!rec) return undefined
  return {
    sessionId: asString(rec.sessionId),
    turnClientMessageId: asString(rec.turnClientMessageId),
    turnRequestId: asString(rec.turnRequestId),
    dimensions: toDimensions(rec.responseDimensions),
  }
}

const toSessionDescriptor = (row: unknown): SessionDescriptor | undefined => {
  const record = asRecord(row)
  if (!record || typeof record.sessionId !== "string" || !record.sessionId) return undefined
  const meta = asRecord(record._meta) ?? {}
  const lockHolderPid = meta["cognition.ai/lockHolderPid"]
  const createdAt = meta["cognition.ai/createdAt"]
  const requestingTabId = meta["cognition.ai/requestingTabId"]
  return {
    sessionId: record.sessionId,
    title: typeof record.title === "string" ? record.title : "",
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
    createdAt: typeof createdAt === "string" ? createdAt : undefined,
    isLocked: meta["cognition.ai/isLocked"] === true,
    lockHolderPid: typeof lockHolderPid === "number" ? lockHolderPid : undefined,
    requestingTabId: typeof requestingTabId === "string" ? requestingTabId : undefined,
  }
}

const SESSION_LIST_PAGE_LIMIT = 10

export class DevinAcp {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">
  private readonly pending = new Map<number, PendingRequest>()
  private readonly prompts = new Map<string, PendingPrompt>()
  private nextId = 0
  private buffer = ""
  private exitError: Error | undefined
  private readonly autoApprove: boolean
  private readonly events?: DevinAcpEvents
  private readonly requestTimeoutMs: number
  private stderrTail = ""

  private constructor(proc: Subprocess<"pipe", "pipe", "pipe">, options: DevinAcpOptions) {
    this.proc = proc
    this.autoApprove = options.autoApprove
    this.events = options.events
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000
    void this.drain(proc.stdout)
    void this.captureStderr(proc.stderr)
    void proc.exited.then((code) => {
      this.exitError = new Error(`devin acp exited (code ${code})${this.stderrTail ? `: ${this.stderrTail}` : ""}`)
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(this.exitError)
      }
      this.pending.clear()
    })
  }

  static async spawn(options: DevinAcpOptions): Promise<DevinAcp> {
    const proc = spawn<"pipe", "pipe", "pipe">([...options.argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const client = new DevinAcp(proc, options)
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hivemind-steward-oc-devin", version: "0.1.0" },
    })
    return client
  }

  async newSession(cwd: string): Promise<NewSessionResult> {
    return (await this.request("session/new", { cwd, mcpServers: [] })) as NewSessionResult
  }

  async loadSession(sessionId: string, cwd: string): Promise<LoadSessionResult> {
    return (await this.request("session/load", { sessionId, cwd, mcpServers: [] })) as LoadSessionResult
  }

  // session/list paginates on the wire ({cursor?} -> {sessions, nextCursor?}):
  // follow nextCursor until absent, unioning pages and deduping on
  // sessionId. Three guards terminate a degenerate wire — an empty page, a
  // cursor the server already handed us, and the page cap — and a cap-hit
  // surfaces the unfollowed remainder as nextCursor so a caller can tell the
  // list may be truncated.
  async listSessions(): Promise<SessionListResult> {
    const sessions: SessionDescriptor[] = []
    const seenIds = new Set<string>()
    const followed = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < SESSION_LIST_PAGE_LIMIT; page++) {
      const result = (await this.request("session/list", cursor === undefined ? {} : { cursor })) as {
        sessions?: unknown
        nextCursor?: unknown
      }
      const rows = Array.isArray(result.sessions) ? result.sessions : []
      for (const row of rows) {
        const descriptor = toSessionDescriptor(row)
        if (descriptor === undefined || seenIds.has(descriptor.sessionId)) continue
        seenIds.add(descriptor.sessionId)
        sessions.push(descriptor)
      }
      const next = typeof result.nextCursor === "string" ? result.nextCursor : undefined
      if (next === undefined || rows.length === 0 || followed.has(next)) return { sessions }
      if (page + 1 >= SESSION_LIST_PAGE_LIMIT) return { sessions, nextCursor: next }
      followed.add(next)
      cursor = next
    }
    return { sessions }
  }

  async prompt(sessionId: string, content: string | PromptContent[], signal?: AbortSignal): Promise<PromptOutcome> {
    if (this.prompts.has(sessionId)) throw new Error(`devin session ${sessionId} already has a prompt in flight`)
    const pending: PendingPrompt = { chunks: [], thoughts: [] }
    this.prompts.set(sessionId, pending)
    const onAbort = () => void this.cancel(sessionId).catch(() => { })
    signal?.addEventListener("abort", onAbort, { once: true })
    try {
      const result = (await this.request("session/prompt", {
        sessionId,
        prompt: typeof content === "string" ? [{ type: "text", text: content }] : content,
      })) as { stopReason?: string }
      return {
        stopReason: result.stopReason ?? "unknown",
        text: pending.chunks.join(""),
        thoughts: pending.thoughts.join(""),
      }
    } finally {
      signal?.removeEventListener("abort", onAbort)
      this.prompts.delete(sessionId)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.notify("session/cancel", { sessionId })
  }

  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId })
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request("session/set_config_option", { sessionId, configId, value })
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end()
    } catch { }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => -1 as const)])
    if (exited === -1) this.proc.kill()
  }

  get alive(): boolean {
    return this.exitError === undefined && this.proc.exitCode === null
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.alive) return Promise.reject(this.exitError ?? new Error("devin acp is not running"))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`devin acp timed out on ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(payload + "\n")
    })
  }

  private notify(method: string, params: unknown): void {
    if (!this.alive) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  private respond(id: number | string, result: unknown): void {
    if (!this.alive) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
  }

  private respondError(id: number | string, code: number, message: string): void {
    if (!this.alive) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
  }

  private async drain(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    const reader = stdout.getReader()
    try {
      for (; ;) {
        const { done, value } = await reader.read()
        if (done) return
        this.buffer += decoder.decode(value, { stream: true })
        let newline = this.buffer.indexOf("\n")
        while (newline !== -1) {
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line) this.dispatch(line)
          newline = this.buffer.indexOf("\n")
        }
      }
    } catch { }
  }

  private async captureStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const text = await new Response(stderr).text().catch(() => "")
    this.stderrTail = text.trim().split("\n").slice(-5).join("\n").slice(0, 2_000)
  }

  private dispatch(line: string): void {
    let message: {
      id?: number | string
      method?: string
      params?: unknown
      result?: unknown
      error?: { code: number; message: string; data?: unknown }
    }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method !== undefined && message.id !== undefined) {
      void this.handleRequest(message.id, message.method, message.params)
      return
    }
    if (message.method !== undefined) {
      this.handleNotification(message.method, message.params)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(Number(message.id))
    if (!pending) return
    this.pending.delete(Number(message.id))
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new DevinAcpError(message.error.code, message.error.message, asRecord(message.error.data)))
      return
    }
    pending.resolve(message.result)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const { sessionId, update } = (params ?? {}) as { sessionId?: string; update?: SessionUpdate }
      if (!sessionId || !update) return
      const pending = this.prompts.get(sessionId)
      if (pending) {
        if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
          pending.chunks.push(update.content.text)
        }
        if (update.sessionUpdate === "agent_thought_chunk" && update.content?.text) {
          pending.thoughts.push(update.content.text)
        }
      }
      this.events?.onUpdate?.(sessionId, update)
      return
    }
    this.events?.onNotification?.(method, params)
  }

  private async handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (method === "session/request_permission") {
      const request = (params ?? {}) as PermissionRequestParams
      if (this.events?.onPermission) {
        try {
          this.respond(id, { outcome: await this.events.onPermission(request) })
        } catch {
          this.respond(id, { outcome: { outcome: "cancelled" } })
        }
        return
      }
      this.respond(id, { outcome: this.permissionOutcome(request) })
      return
    }
    this.respondError(id, -32601, `hivemind-steward-oc-devin does not implement ${method}`)
  }

  private permissionOutcome(params: PermissionRequestParams): unknown {
    if (!this.autoApprove) return { outcome: "cancelled" }
    const options = params.options ?? []
    const deny = /\b(don'?t|do not|deny|reject|never|no|block|refuse)\b/i
    const allow = /\b(allow|yes|approve|accept|proceed|ok|confirm)\b/i
    const pick =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => o.kind === "allow_always") ??
      options.find((o) => allow.test(o.name ?? "") && !deny.test(o.name ?? ""))
    if (!pick) return { outcome: "cancelled" }
    return { outcome: "selected", optionId: pick.optionId ?? pick.id }
  }
}
