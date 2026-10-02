#!/usr/bin/env bun
// Scripted `devin acp` stand-in: newline-delimited JSON-RPC over stdio.
// Env: FAKE_ACP_SCENARIO (basic|permission|permission-two|permission-crash|silent|crash|sessions|swap|load-error|wire-errors|journey|rich|replay:<file>), FAKE_ACP_LOG (wire log path),
// FAKE_ACP_CONFIG (JSON file of configOptions), FAKE_ACP_REPLAY (ndjson fixture for replay),
// FAKE_ACP_SESSIONS (JSON file overriding the scripted session/list page),
// FAKE_ACP_DELAY_MS (prompt result delay), FAKE_ACP_LIST_DELAY_MS (list delay),
// FAKE_ACP_LOAD_DELAY_MS (load response delay — the replay still streams first),
// FAKE_ACP_LIST_ERROR=1 (session/list responds with an error),
// FAKE_ACP_NEW_ERROR=1 (session/new responds with an error),
// FAKE_ACP_STALE_REPLACED=1 (mid-load traffic tagged to the replaced sessionId),
// FAKE_ACP_LOAD_PERM=1 (session/request_permission on the pending tag mid-load),
// FAKE_ACP_LOAD_DIE=1 (process exits inside a session/load — replay streamed,
// response never sent; one-shot via the crash marker so a respawn loads fine),
// FAKE_ACP_REJECT_SET (error on set_mode/set_config_option).

import { appendFileSync, existsSync, readFileSync } from "node:fs"

// CLI-mode shims: this file doubles as a fake `devin` binary, not just the
// `acp` subcommand. `--version` answers immediately (devin_doctor probe);
// `-p <prompt>` prints a one-shot reply (devin_run); anything else falls
// through to the ACP loop below. Both modes leave a marker in FAKE_ACP_LOG so
// journeys can prove the tool really spawned the binary.
if (process.argv.includes("--version")) {
  if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, '{"event":"cli-version"}\n')
  console.log("devin 0.0.0-fake")
  process.exit(0)
}
const oneShotIdx = process.argv.indexOf("-p")
if (oneShotIdx >= 0) {
  const prompt = String(process.argv[oneShotIdx + 1] ?? "")
  if (process.env.FAKE_ACP_LOG)
    appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ event: "cli-oneshot", prompt: prompt.slice(0, 120) }) + "\n")
  console.log(`fake-devin reply: ${prompt.slice(0, 120)}`)
  process.exit(0)
}

const SCENARIO = process.env.FAKE_ACP_SCENARIO ?? "basic"
const LOG = process.env.FAKE_ACP_LOG
const DELAY_MS = Number(process.env.FAKE_ACP_DELAY_MS ?? 0)
const REJECT_SET = process.env.FAKE_ACP_REJECT_SET === "1"
const STALE_REPLACED = process.env.FAKE_ACP_STALE_REPLACED === "1"
const LOAD_PERM = process.env.FAKE_ACP_LOAD_PERM === "1"
const REPLAY = process.env.FAKE_ACP_REPLAY ?? (SCENARIO.startsWith("replay:") ? SCENARIO.slice(7) : undefined)

interface Rpc {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

const log = (direction: "in" | "out", msg: Rpc | Record<string, unknown>) => {
  if (LOG) appendFileSync(LOG, JSON.stringify({ direction, msg }) + "\n")
}

const out = (msg: Rpc | Record<string, unknown>) => {
  log("out", msg)
  process.stdout.write(JSON.stringify(msg) + "\n")
}

const noise = (text: string) => {
  if (LOG) appendFileSync(LOG, JSON.stringify({ direction: "out", event: "noise" }) + "\n")
  process.stdout.write(text + "\n")
}

const DEFAULT_CONFIG = [
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "accept-edits", name: "Code", description: "Write and edit code" },
      { value: "smart", name: "Smart", description: "Auto-approve safe actions" },
      { value: "ask", name: "Ask", description: "Answer questions without code changes" },
      { value: "plan", name: "Plan", description: "Plan before implementing" },
      { value: "bypass", name: "Bypass Permissions", description: "Auto-approve all tool calls" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "swe-2-high",
    options: [
      { value: "adaptive", name: "Adaptive" },
      { value: "swe-2-high", name: "SWE-2" },
      { value: "swe-1-7-lightning-medium", name: "SWE-1.7 Lightning" },
      { value: "claude-opus-5-5-medium", name: "Claude Opus 5.5" },
    ],
  },
  {
    id: "thought_level",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "max",
    options: [
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
]

const configPath = process.env.FAKE_ACP_CONFIG
let configOptions: Record<string, unknown>[] =
  configPath && existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>[]) : DEFAULT_CONFIG

const FAKE_MODES = {
  currentModeId: "accept-edits",
  availableModes: [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
  ],
}

const SCRIPTED_SESSIONS: Record<string, unknown>[] = [
  {
    sessionId: "repeated-plane",
    cwd: "/Users/test/other-project",
    title: "Starting Local Devin Sessions from OpenCode V2 TUI via ACP",
    updatedAt: "2026-10-01T00:10:15+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:19:10.000Z", "cognition.ai/isLocked": true, "cognition.ai/lockHolderPid": 95393 },
  },
  {
    sessionId: "cherry-random",
    cwd: "/Users/test/opencode-devin",
    title: "Reply with exactly the single word: ok",
    updatedAt: "2026-09-30T16:33:20+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:33:13.000Z", "cognition.ai/isLocked": false, "cognition.ai/lockHolderPid": null },
  },
  {
    sessionId: "mango-mangosteen",
    cwd: "/Users/test/opencode-devin",
    title: "Reply with exactly the single word: ok",
    updatedAt: "2026-09-30T16:33:03+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:32:56.000Z", "cognition.ai/isLocked": false, "cognition.ai/lockHolderPid": null },
  },
  {
    sessionId: "quiet-badger",
    cwd: "/Users/test/opencode-devin",
    title: "",
    updatedAt: "2026-09-30T17:14:20+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T17:14:13.000Z", "cognition.ai/isLocked": false, "cognition.ai/lockHolderPid": null },
  },
  {
    sessionId: "homeless-fern",
    title: "Session with no cwd recorded",
    updatedAt: "2026-09-30T18:00:00+00:00",
    _meta: { "cognition.ai/requestingTabId": "new-1790806213192-t6i9eofix", "cognition.ai/isLocked": false, "cognition.ai/lockHolderPid": null },
  },
  {
    sessionId: "warped-sundial",
    cwd: "/Users/test/hivemind-steward-oc-devin",
    title: "Session with a mangled clock",
    updatedAt: "not-a-timestamp",
  },
]

const LOAD_ERROR_SESSIONS: Record<string, unknown>[] = [
  {
    sessionId: "locked-ward",
    cwd: "/Users/test/opencode-devin",
    title: "Held by a live Devin client",
    updatedAt: "2026-10-01T00:10:15+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:19:10.000Z", "cognition.ai/isLocked": true, "cognition.ai/lockHolderPid": 4242 },
  },
  {
    sessionId: "picky-cwd",
    cwd: "/recorded/elsewhere",
    title: "Recorded under a different cwd",
    updatedAt: "2026-09-30T16:33:20+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:33:13.000Z", "cognition.ai/isLocked": false },
  },
  {
    sessionId: "deleted-ghost",
    title: "Deleted in another client",
    updatedAt: "2026-09-30T16:33:03+00:00",
    _meta: { "cognition.ai/createdAt": "2026-09-30T16:32:56.000Z", "cognition.ai/isLocked": false },
  },
]

const sessionsPath = process.env.FAKE_ACP_SESSIONS
const sessionsPage = (): Record<string, unknown>[] => {
  if (sessionsPath && existsSync(sessionsPath)) {
    return JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, unknown>[]
  }
  if (SCENARIO === "load-error") return LOAD_ERROR_SESSIONS
  return SCENARIO === "sessions" || SCENARIO === "swap" || SCENARIO === "wire-errors" ? SCRIPTED_SESSIONS : []
}

const sessionsReplay = (tag: string) => {
  const descriptor = sessionsPage().find((d) => d.sessionId === tag)
  const stale = "stale-ghost-session"
  if (SCENARIO === "sessions") {
    // Connect-time MCP fan-out — the fixture records 38 `_cognition.ai/output`
    // emissions around one load. Every MCP:* line drops at the lane; the one
    // bound-tagged error line earns a system entry; the empty-tagged warn and
    // the unknown _-prefixed method are tolerated noise (REQ-NOISE-01, E32).
    const servers = ["deepwiki", "fetch", "exa", "gh_grep", "github", "gitingest", "repomix", "tavily", "context7", "chrome-devtools", "fetcher", "brave"]
    for (const server of servers) {
      for (const message of [`Connecting to MCP server '${server}'`, `Starting stdio MCP server '${server}'`, `MCP server '${server}' ready`]) {
        out({ jsonrpc: "2.0", method: "_cognition.ai/output", params: { channel: `MCP: ${server}`, message, level: "info", sessionId: "" } })
      }
    }
    out({ jsonrpc: "2.0", method: "_cognition.ai/mcp/serversChanged", params: { servers } })
    out({ jsonrpc: "2.0", method: "_cognition.ai/output", params: { channel: "agent", message: "dropped a transcript frame — recovered", level: "error", sessionId: tag } })
    out({ jsonrpc: "2.0", method: "_cognition.ai/output", params: { channel: "agent", message: "unattributable warn line", level: "warn", sessionId: "" } })
    out({ jsonrpc: "2.0", method: "_cognition.ai/mystery_extension", params: { v: 1 } })
  }
  if (process.env.FAKE_ACP_SUBAGENTS === "1") {
    // In-stream subagent lifecycle (wire-inventory P1): a tool_call_update
    // _meta announces the agent, subagent_context tags its authored updates,
    // and a completing tool_call_update seals it.
    update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "in_progress",
        _meta: {
          "cognition.ai/subagent_started": {
            agentId: "sub-1",
            title: "Scout the repo",
            task: "Read the layout",
            model: "SWE-2 Max",
            depth: 1,
            isBackground: false,
          },
        },
      },
      tag,
    )
    update(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "subagent note" },
        _meta: { "cognition.ai/subagent_context": { parentAgentId: "sub-1" } },
      },
      tag,
    )
    update(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub-1",
        status: "completed",
        _meta: { "cognition.ai/subagent_completed": { agentId: "sub-1", success: true } },
      },
      tag,
    )
  }
  update(
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Acknowledge the linked file by name only, one line." } },
    tag,
  )
  update(
    {
      sessionUpdate: "user_message_chunk",
      content: { type: "resource_link", uri: "file:///Users/test/hivemind-steward-oc-devin/package.json", name: "package.json", mimeType: "application/json" },
    },
    tag,
  )
  update(
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The prompt asks for the filename only, on a single line." } },
    tag,
  )
  // Stale ammunition interleaved mid-replay — every frame tagged to a
  // sessionId the lane never binds and never loads.
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE ghost text" } }, stale)
  update(
    {
      sessionUpdate: "config_option_update",
      configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "ghost-9", options: [{ value: "ghost-9", name: "ghost-9" }] }],
    },
    stale,
  )
  update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "ghost-slash" }] }, stale)
  update({ sessionUpdate: "usage_update", used: 999999, size: 1 }, stale)
  requestPermission("srv-perm-stale", "Stale tool call", "rm -rf /tmp/stale", stale)
  update(
    {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the linked file name", status: "completed" },
        { content: "Reply with the name only", status: "in_progress" },
      ],
    },
    tag,
  )
  update(
    { sessionUpdate: "tool_call", toolCallId: "call-load-1", title: "Ran ls", kind: "execute", rawInput: { command: "ls package.json" } },
    tag,
  )
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-load-1", status: "completed" }, tag)
  update({ sessionUpdate: "mystery_future_kind", payload: { v: 1 } }, tag)
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "package.json" } }, tag)
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " **Wrapped** reply `package.json`" } }, tag)
  update({ sessionUpdate: "session_info_update", title: typeof descriptor?.title === "string" ? descriptor.title : "" }, tag)
  update(
    {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "login", description: "Authenticate with an API key", input: { hint: "[api-key]" } },
        { name: "status", description: "Check authentication status" },
        { name: "plan", description: "Switch to Plan mode, or plan with a prompt", input: { hint: "[prompt]" } },
      ],
    },
    tag,
  )
  update({ sessionUpdate: "usage_update", used: 31503, size: 262000 }, tag)
}

let sessionCounter = 0
let sessionId = ""
let listCalls = 0
let newCalls = 0
const CRASH_MARKER = `${process.cwd()}/.fake-acp-crashed`
let pendingPromptId: number | string | undefined
const permissionWaiters = new Map<number | string, number | string>()
const loadAttempts = new Map<string, number>()
let buffer = ""

const update = (u: Record<string, unknown>, tag = sessionId) =>
  out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: tag, update: u } })
const respond = (id: number | string, result: unknown) => out({ jsonrpc: "2.0", id, result })
const respondError = (id: number | string, message: string, data?: Record<string, unknown>) =>
  out({ jsonrpc: "2.0", id, error: { code: -32602, message, ...(data === undefined ? {} : { data }) } })

const finishPrompt = (stopReason: string) => {
  if (pendingPromptId === undefined) return
  respond(pendingPromptId, { stopReason, usage: { used: 1000, size: 262000 } })
  pendingPromptId = undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const scriptBasic = async (text: string) => {
  update({ sessionUpdate: "session_info_update", title: text })
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about the request…" } })
  update({
    sessionUpdate: "plan",
    entries: [
      { content: "Understand the request", status: "completed" },
      { content: "Run the work", status: "in_progress" },
      { content: "Report back", status: "pending" },
    ],
  })
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-fake-1",
    title: "Ran echo",
    kind: "execute",
    content: [{ type: "content", content: { type: "text", text: `echo ${text}` } }],
    rawInput: { command: `echo ${text}` },
    _meta: { "cognition.ai/commandNames": ["echo"], "cognition.ai/inferenceToolName": "exec" },
  })
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-fake-1", status: "in_progress" })
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-fake-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "fake-tool-output" } }],
  })
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong: " } })
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
  update({ sessionUpdate: "usage_update", used: 1234, size: 262000, _meta: { "cognition.ai/inputTokens": 1100, "cognition.ai/outputTokens": 134 } })
  if (DELAY_MS > 0) await sleep(DELAY_MS)
  finishPrompt("end_turn")
}

const PERM_OPTIONS = process.env.FAKE_ACP_PERM_OPTIONS
  ? (JSON.parse(process.env.FAKE_ACP_PERM_OPTIONS) as Array<{ optionId?: string; name?: string; kind?: string }>)
  : undefined

const requestPermission = (id: string, title: string, command: string, tag = sessionId) => {
  if (pendingPromptId !== undefined) permissionWaiters.set(id, pendingPromptId)
  out({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: tag,
      toolCall: { toolCallId: `call-${id}`, title, kind: "execute", rawInput: { command } },
      options: PERM_OPTIONS ?? [
        { optionId: "perm-allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "perm-allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "perm-reject", name: "Reject", kind: "reject_once" },
      ],
    },
  })
}

const scriptPermission = async () => {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I need permission to continue. " } })
  requestPermission("srv-perm-1", "Delete node_modules", "rm -rf node_modules")
}

const scriptPermissionTwo = async () => {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Two gated calls. " } })
  requestPermission("srv-perm-1", "Delete node_modules", "rm -rf node_modules")
  requestPermission("srv-perm-2", "Write env file", "write .env")
}

const scriptJourney = async (text: string) => {
  update({ sessionUpdate: "session_info_update", title: text })
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about the request…" } })
  update({
    sessionUpdate: "plan",
    entries: [
      { content: "Understand the request", status: "completed" },
      { content: "Run the work", status: "in_progress" },
      { content: "Report back", status: "pending" },
    ],
  })
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-fake-1",
    title: "Ran echo",
    kind: "execute",
    content: [{ type: "content", content: { type: "text", text: `echo ${text}` } }],
    rawInput: { command: `echo ${text}` },
    _meta: { "cognition.ai/commandNames": ["echo"], "cognition.ai/inferenceToolName": "exec" },
  })
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-fake-1", status: "in_progress" })
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-fake-1", status: "completed" })
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it. " } })
  requestPermission("srv-perm-1", "Delete node_modules", "rm -rf node_modules")
}

// The `rich` prompt streams the full real-wire shape set: inferenceToolName
// meta, shell previews, diff content blocks, terminal_exit exits, command
// metadata, and a cancelled call — the fields the lane surfaces natively.
const scriptRich = async (text: string) => {
  update({ sessionUpdate: "session_info_update", title: text })
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the repo first. " } })
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Then editing." } })
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "read:0#rich",
      kind: "read",
      title: "Read file",
      rawInput: { file_path: "/repo/src/alpha.ts" },
      _meta: { "cognition.ai/inferenceToolName": "read" },
    },
  )
  update({ sessionUpdate: "tool_call_update", toolCallId: "read:0#rich", status: "completed" })
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "read:1#rich",
      kind: "read",
      title: "Read file",
      rawInput: { file_path: "/repo/src/beta.ts" },
      _meta: { "cognition.ai/inferenceToolName": "read" },
    },
  )
  update({ sessionUpdate: "tool_call_update", toolCallId: "read:1#rich", status: "completed" })
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec:0#rich",
      kind: "execute",
      title: "Ran bun test",
      rawInput: { command: "bun test" },
      content: [
        {
          type: "content",
          content: { type: "resource", resource: { mimeType: "text/x-shellscript", text: "bun test", uri: "tool://preview" } },
          _meta: { "cognition.ai/preview_is_shell_command": true },
        },
      ],
      _meta: {
        "cognition.ai/inferenceToolName": "exec",
        "cognition.ai/commandNames": ["bun"],
        "cognition.ai/timeoutMs": 120000,
      },
    },
  )
  update(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec:0#rich",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "bun test v1.4.2\n\n 12 pass\n 0 fail" } }],
      _meta: {
        "cognition.ai/inferenceToolName": "exec",
        "cognition.ai/cwd": "/repo",
        terminal_exit: { terminal_id: "a1b2c3", exit_code: 0, signal: null },
      },
    },
  )
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec:1#rich",
      kind: "execute",
      title: "Ran rm -rf dist",
      rawInput: { command: "rm -rf dist" },
      _meta: { "cognition.ai/inferenceToolName": "exec", "cognition.ai/commandNames": ["rm"] },
    },
  )
  update(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec:1#rich",
      status: "failed",
      _meta: { "cognition.ai/inferenceToolName": "exec", "cognition.ai/canceled": true },
    },
  )
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "edit:0#rich",
      kind: "edit",
      title: "Edited /repo/src/alpha.ts",
      rawInput: { file_path: "/repo/src/alpha.ts", old_string: "alpha = 1", new_string: "alpha = 2" },
      content: [{ type: "diff", path: "/repo/src/alpha.ts", oldText: "export const alpha = 1", newText: "export const alpha = 2" }],
      _meta: { "cognition.ai/inferenceToolName": "edit" },
    },
  )
  update({ sessionUpdate: "tool_call_update", toolCallId: "edit:0#rich", status: "completed" })
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "write:0#rich",
      kind: "edit",
      title: "Wrote /repo/src/new.ts",
      rawInput: { file_path: "/repo/src/new.ts" },
      content: [{ type: "diff", path: "/repo/src/new.ts", newText: "export const created = true\n" }],
      _meta: { "cognition.ai/inferenceToolName": "write" },
    },
  )
  update({ sessionUpdate: "tool_call_update", toolCallId: "write:0#rich", status: "completed" })
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "sub:0#rich",
      kind: "execute",
      title: "Run subagent",
      _meta: {
        "cognition.ai/inferenceToolName": "run_subagent",
        "cognition.ai/subagent_started": {
          agentId: "ag-scout",
          title: "Scout the repo",
          task: "map src/ layout",
          model: "SWE-2",
          isBackground: true,
        },
      },
    },
  )
  update(
    {
      sessionUpdate: "tool_call",
      toolCallId: "sub:1#rich",
      kind: "execute",
      title: "Run subagent",
      _meta: {
        "cognition.ai/inferenceToolName": "run_subagent",
        "cognition.ai/subagent_started": { agentId: "ag-docs", title: "Read docs", task: "summarize readme" },
      },
    },
  )
  update(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "sub:0#rich",
      status: "completed",
      _meta: {
        "cognition.ai/subagent_completed": { agentId: "ag-scout", success: true, summary: "3 modules mapped" },
      },
    },
  )
  update(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "sub:1#rich",
      status: "failed",
      _meta: {
        "cognition.ai/subagent_completed": { agentId: "ag-docs", success: false, summary: "readme missing" },
      },
    },
  )
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })
  update({
    sessionUpdate: "usage_update",
    used: 31700,
    size: 262000,
    _meta: {
      "cognition.ai/inputTokens": 31638,
      "cognition.ai/outputTokens": 40,
      "cognition.ai/cachedReadTokens": 31494,
      "cognition.ai/totalCreditCost": 0.42,
      "cognition.ai/totalAcuCost": 1.7,
      "cognition.ai/responseDimensions": [
        {
          uid: "input_tokens",
          groupTitle: "Token Usage",
          label: "Input tokens",
          kind: { type: "cumulativeMetric", value: 31638, prefix: "", tail: " token", pluralTail: " tokens" },
        },
      ],
    },
  })
  out({
    jsonrpc: "2.0",
    method: "_cognition.ai/turn_stats",
    params: {
      sessionId,
      turnClientMessageId: "cm-rich-1",
      turnRequestId: "req-rich-1",
      responseDimensions: [
        { uid: "model", groupTitle: "Response Statistics", label: "Model", kind: { type: "metric", value: "SWE-2 Max" } },
      ],
    },
  })
  out({
    jsonrpc: "2.0",
    method: "_cognition.ai/agent_stopped",
    params: {
      sessionId,
      cause: "complete",
      stats: {
        toolCalls: 6,
        filesChanged: 2,
        commandsRun: 2,
        inputTokens: 31638,
        outputTokens: 40,
        ttftMs: 118,
        tokensPerSec: 512.5,
        totalTimeMs: 2340,
        requestId: "req-rich-1",
        modelLabel: "SWE-2 Max",
      },
    },
  })
  finishPrompt("end_turn")
}

interface ReplayRound {
  notifications: Record<string, unknown>[]
  response?: Rpc
}
let replayRounds: Map<string, ReplayRound[]> | undefined

const loadReplay = () => {
  replayRounds = new Map()
  if (!REPLAY || !existsSync(REPLAY)) return
  let current: ReplayRound | undefined
  let sendId: number | string | undefined
  for (const line of readFileSync(REPLAY, "utf8").split("\n")) {
    if (!line.trim()) continue
    const frame = JSON.parse(line) as { direction: string; msg: Rpc }
    if (frame.direction === "send") {
      current = { notifications: [] }
      sendId = frame.msg.id
      const list = replayRounds.get(frame.msg.method ?? "") ?? []
      list.push(current)
      replayRounds.set(frame.msg.method ?? "", list)
      continue
    }
    if (!current) continue
    const isResponse = frame.msg.id !== undefined && frame.msg.id === sendId && (frame.msg.result !== undefined || frame.msg.error !== undefined)
    if (isResponse) current.response = frame.msg
    else current.notifications.push(frame.msg as Record<string, unknown>)
  }
}

const replayRound = (method: string, id: number | string, params?: Record<string, unknown>): boolean => {
  const round = replayRounds?.get(method)?.shift()
  if (!round) return false
  if (method === "session/load" && typeof params?.sessionId === "string") sessionId = params.sessionId
  const named = (round.response?.result as { sessionId?: unknown } | undefined)?.sessionId
  if (method === "session/new" && typeof named === "string" && named) sessionId = named
  for (const note of round.notifications) {
    const noteParams = (note as Rpc).params
    if (noteParams && typeof noteParams === "object" && "sessionId" in noteParams && sessionId) {
      noteParams.sessionId = sessionId
    }
    out(note)
  }
  if (round.response) {
    // The recorded error rides the wire verbatim — code and data
    // (errorKind/user_message/lockHolderPid) are part of the contract under
    // test, so nothing is rewritten to the -32602 default (REQ-ERRDATA-01).
    if (round.response.error) out({ jsonrpc: "2.0", id, error: round.response.error })
    else respond(id, round.response.result)
  }
  return true
}

const setConfigValue = (id: number | string, configId: string, value: string) => {
  if (SCENARIO === "wire-errors") {
    respondError(id, "ERR_SET raw", {
      "cognition.ai/errorKind": "ServerError",
      retryable: true,
      user_message: "Devin backend hiccup — retry in a moment",
    })
    return
  }
  if (REJECT_SET) {
    respondError(id, `fake rejects ${configId}=${value}`)
    return
  }
  configOptions = configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o))
  update({ sessionUpdate: "config_option_update", configOptions })
  if (configId === "mode") update({ sessionUpdate: "current_mode_update", currentModeId: value })
  respond(id, { configOptions })
}

const onRequest = async (msg: Rpc) => {
  const { id, method, params } = msg
  if (id === undefined) return
  switch (method) {
    case "initialize":
      // FAKE_ACP_SILENT_INIT=1 — accept the handshake frame but never answer;
      // exercises the view's 30s spawn deadline.
      if (process.env.FAKE_ACP_SILENT_INIT === "1") return
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } },
        agentInfo: { name: "fake-devin", title: "Fake Devin", version: "0.0.0-fake" },
        authMethods: [],
      })
      noise("this is not json {{{ — the client must ignore it")
      return
    case "session/list": {
      if (replayRounds && replayRound(method ?? "", id, params)) return
      if (SCENARIO === "wire-errors" && listCalls++ === 0) {
        respondError(id, "ERR_RATELIMIT raw", {
          "cognition.ai/errorKind": "RateLimited",
          retryable: true,
          user_message: "Devin rate limit reached — retry shortly",
        })
        return
      }
      if (process.env.FAKE_ACP_LIST_ERROR) {
        respondError(id, "fake cannot list sessions")
        return
      }
      const listDelay = Number(process.env.FAKE_ACP_LIST_DELAY_MS ?? "0")
      if (listDelay > 0) await sleep(listDelay)
      const page = sessionsPage()
      const cursor = typeof params?.cursor === "string" ? params.cursor : undefined
      // Two finite pages: the first half rides page one behind nextCursor,
      // the second half answers cursor-page-2 with no further cursor. An
      // unknown cursor answers an empty page — degenerate wires must still
      // terminate the client's follow loop. FAKE_ACP_LIST_LOOP=1 makes page
      // two echo its own cursor to exercise the repeated-cursor guard.
      const mid = Math.ceil(page.length / 2)
      if (cursor === undefined) {
        const first = page.slice(0, mid)
        respond(id, first.length ? { sessions: first, nextCursor: "cursor-page-2" } : { sessions: [] })
      } else if (cursor === "cursor-page-2") {
        const rest = page.slice(mid)
        respond(id, process.env.FAKE_ACP_LIST_LOOP ? { sessions: rest, nextCursor: "cursor-page-2" } : { sessions: rest })
      } else {
        respond(id, { sessions: [] })
      }
      return
    }
    case "session/new": {
      if (replayRounds && replayRound(method, id, params)) return
      if (SCENARIO === "wire-errors" && newCalls++ === 0) {
        respondError(id, "ERR_AUTH raw", {
          "cognition.ai/errorKind": "Unauthenticated",
          user_message: "Devin credentials expired",
        })
        return
      }
      if (process.env.FAKE_ACP_NEW_ERROR) {
        respondError(id, "fake cannot create a session")
        return
      }
      sessionCounter += 1
      sessionId = `fake-session-${process.pid}-${sessionCounter}`
      respond(id, { sessionId, modes: FAKE_MODES, configOptions })
      update({ sessionUpdate: "config_option_update", configOptions })
      update({ sessionUpdate: "current_mode_update", currentModeId: "accept-edits" })
      return
    }
    case "session/load": {
      if (replayRounds && replayRound(method, id, params)) return
      if (SCENARIO === "wire-errors") {
        respondError(id, "session is locked by a live client (pid 4242)")
        return
      }
      if (SCENARIO === "load-error") {
        const target = String(params?.sessionId ?? "")
        const attempts = (loadAttempts.get(target) ?? 0) + 1
        loadAttempts.set(target, attempts)
        if (target === "locked-ward") {
          respondError(id, "session is locked by a live client (pid 4242)")
          return
        }
        if (target === "picky-cwd" && attempts === 1) {
          respondError(id, `cwd mismatch — session was recorded under ${String(params?.cwd)}`)
          return
        }
        if (target === "deleted-ghost") {
          // A delete-between-list-and-pick can still stream a partial replay
          // before the failure lands — none of it may survive the lane's
          // restore (E24, REQ-LOCK-01). The mid-load config update and the
          // pending-tag permissions (one presented, one queued) belong to the
          // failed session: config rolls back, both wire requests answer
          // cancelled, and no card may dangle over the restored log.
          update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "GHOST fragment" } }, target)
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GHOST partial replay" } }, target)
          update(
            {
              sessionUpdate: "config_option_update",
              configOptions: [
                {
                  id: "model",
                  name: "Model",
                  type: "select",
                  currentValue: "ghost-model",
                  options: [{ value: "ghost-model", name: "ghost-model" }],
                },
              ],
            },
            target,
          )
          requestPermission("srv-perm-ghost", "Ghost mid-load call", "rm -rf /tmp/ghost", target)
          requestPermission("srv-perm-ghost-queued", "Ghost queued call", "rm -rf /tmp/ghost-queued", target)
          respondError(id, "session not found — deleted in another client")
          return
        }
      }
      const replaced = sessionId
      sessionId = String(params?.sessionId ?? "")
      if (SCENARIO === "sessions" || SCENARIO === "swap") sessionsReplay(sessionId)
      // The outgoing session keeps streaming while the lane rebuilds — frames
      // tagged to the replaced id must be dropped, its permission cancelled.
      if (STALE_REPLACED && replaced) {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE replaced tail" } }, replaced)
        requestPermission("srv-perm-replaced", "Replaced session tool call", "rm -rf /tmp/replaced", replaced)
      }
      // Devin re-issuing a permission mid-load on the pending tag: accepted via
      // loadingId while the lane is still unbound.
      if (LOAD_PERM) requestPermission("srv-perm-load", "Mid-load tool call", "touch /tmp/mid-load", sessionId)
      const loadDelay = Number(process.env.FAKE_ACP_LOAD_DELAY_MS ?? "0")
      if (loadDelay > 0) await sleep(loadDelay)
      // E43: death mid-load — the replay already streamed, the response never
      // arrives. One-shot so the lazily respawned engine serves the re-bind.
      if (process.env.FAKE_ACP_LOAD_DIE === "1" && !existsSync(CRASH_MARKER)) {
        appendFileSync(CRASH_MARKER, "1")
        process.stdout.uncork?.()
        process.exit(1)
      }
      respond(id, { modes: FAKE_MODES, configOptions })
      update({ sessionUpdate: "config_option_update", configOptions })
      update({ sessionUpdate: "current_mode_update", currentModeId: "accept-edits" })
      // The swap bleed: after the load resolves, Devin can still emit traffic
      // for the replaced session (fixture-real — available_commands_update for
      // mango-mangosteen arriving while cherry-random was bound). Everything
      // tagged `replaced` must drop; its permission resolves cancelled.
      if (SCENARIO === "swap" && replaced) {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "STALE swap bleed" } }, replaced)
        update(
          {
            sessionUpdate: "config_option_update",
            configOptions: [
              { id: "model", name: "Model", type: "select", currentValue: "stale-model", options: [{ value: "stale-model", name: "stale-model" }] },
            ],
          },
          replaced,
        )
        update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "stale-cmd" }] }, replaced)
        requestPermission("srv-perm-swap-stale", "Stale swap tool call", "rm -rf /tmp/swap-stale", replaced)
      }
      return
    }
    case "session/prompt": {
      if (SCENARIO === "wire-errors") {
        respondError(id, "ERR_QUOTA raw", {
          "cognition.ai/errorKind": "QuotaExhausted",
          user_message: "Devin quota exhausted for this billing period",
        })
        return
      }
      pendingPromptId = id
      const text = (((params?.prompt as { text?: string }[] | undefined)?.[0]?.text) ?? "").slice(0, 400)
      if (SCENARIO === "silent") return
      if (SCENARIO === "crash") {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dying…" } })
        process.stdout.uncork?.()
        process.exit(1)
      }
      if (SCENARIO === "crash-once" && !existsSync(CRASH_MARKER)) {
        appendFileSync(CRASH_MARKER, "1")
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dying…" } })
        process.stdout.uncork?.()
        process.exit(1)
      }
      if (SCENARIO === "permission") return scriptPermission()
      if (SCENARIO === "permission-two") return scriptPermissionTwo()
      if (SCENARIO === "permission-crash") {
        if (existsSync(CRASH_MARKER)) return scriptPermission()
        appendFileSync(CRASH_MARKER, "1")
        await scriptPermission()
        process.stdout.uncork?.()
        process.exit(1)
      }
      if (SCENARIO === "journey") return scriptJourney(text)
      if (SCENARIO === "rich") return scriptRich(text)
      if (replayRounds) {
        if (replayRound(method, id)) {
          pendingPromptId = undefined
          return
        }
        respondError(id, "no replay round for session/prompt")
        pendingPromptId = undefined
        return
      }
      return scriptBasic(text)
    }
    case "session/set_mode":
      return setConfigValue(id, "mode", String(params?.modeId ?? ""))
    case "session/set_config_option":
      return setConfigValue(id, String(params?.configId ?? ""), String(params?.value ?? ""))
    default:
      if (replayRounds && replayRound(method ?? "", id)) return
      respondError(id, `fake-devin does not implement ${method}`)
  }
}

const onNotification = (msg: Rpc) => {
  if (msg.method === "session/cancel") {
    const gated = permissionWaiters.values().next().value
    if (gated !== undefined) pendingPromptId = gated
    permissionWaiters.clear()
    finishPrompt("cancelled")
  }
}

const onResponse = (msg: Rpc) => {
  if (msg.id === undefined) return
  const gated = permissionWaiters.get(msg.id)
  if (gated === undefined) return
  permissionWaiters.delete(msg.id)
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Permission answered, continuing. " } })
  if (permissionWaiters.size === 0) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })
    update({ sessionUpdate: "usage_update", used: 2200, size: 262000, _meta: { "cognition.ai/inputTokens": 2000, "cognition.ai/outputTokens": 200 } })
    respond(gated, { stopReason: "end_turn" })
    pendingPromptId = undefined
  }
}

if (REPLAY) loadReplay()

const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let idx = buffer.indexOf("\n")
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    idx = buffer.indexOf("\n")
    if (!line) continue
    let msg: Rpc
    try {
      msg = JSON.parse(line) as Rpc
    } catch {
      continue
    }
    log("in", msg)
    if (msg.method !== undefined && msg.id !== undefined) void onRequest(msg)
    else if (msg.method !== undefined) onNotification(msg)
    else if (msg.id !== undefined) onResponse(msg)
  }
}
