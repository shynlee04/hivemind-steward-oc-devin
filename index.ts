import { Plugin } from "@opencode/plugin"
import { spawn } from "bun"
import { DevinAcp } from "./src/acp"

const PLUGIN_ID = "hivemind-steward-oc-devin"
const DEVIN_BIN = process.env.DEVIN_BIN ?? "devin"

const PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"] as const
type PermissionMode = (typeof PERMISSION_MODES)[number]

interface OneShotInput {
  readonly prompt: string
  readonly cwd?: string
  readonly model?: string
  readonly permission_mode?: PermissionMode
  readonly cloud?: boolean
  readonly respect_workspace_trust?: boolean
  readonly timeout_ms?: number
}

interface SessionInput {
  readonly action: "start" | "send" | "status" | "cancel" | "close"
  readonly prompt?: string
  readonly name?: string
  readonly cwd?: string
  readonly model?: string
  readonly cloud?: boolean
  readonly agent_type?: "summarizer" | "review"
  readonly refusal_fallback?: string
  readonly auto_approve?: boolean
  readonly timeout_ms?: number
}

interface DevinLane {
  readonly acp: DevinAcp
  readonly sessionId: string
  readonly cwd: string
}

const MISSING_BIN_MESSAGE = "devin CLI not found on PATH — install it or set DEVIN_BIN"

// Bun's spawn throws "Executable not found in $PATH"; Node-style errors carry
// a .code of ENOENT. Confirm with Bun.which so an ENOENT raised for a dead
// cwd doesn't get mislabeled as a missing binary.
const isMissingDevinBin = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return (code === "ENOENT" || /ENOENT|executable not found/i.test(message)) && Bun.which(DEVIN_BIN) === null
}

const spawnDevin = (argv: string[], cwd: string) => {
  try {
    return spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    throw isMissingDevinBin(error) ? new Error(MISSING_BIN_MESSAGE) : error
  }
}

// devin_doctor probe: PATH resolution first (Bun.which also resolves a
// path-valued DEVIN_BIN), then a bounded `devin --version` so a hung binary
// can't pin the tool call.
const probeDevin = async (): Promise<string> => {
  const resolved = Bun.which(DEVIN_BIN)
  if (resolved === null) return MISSING_BIN_MESSAGE
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
      if (timedOut) return `devin found at ${resolved} but \`devin --version\` did not answer within 5s`
      if (code !== 0) return `devin found at ${resolved} but \`devin --version\` exited ${code}${detail ? `: ${detail.slice(0, 300)}` : ""}`
      return `devin CLI ok — ${detail || "no version output"} (${resolved})`
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return `devin found at ${resolved} but probing failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function runOneShot(input: OneShotInput, fallbackCwd: string, signal: AbortSignal) {
  const argv = [DEVIN_BIN, "-p", input.prompt]
  if (input.model) argv.push("--model", input.model)
  if (input.permission_mode) argv.push("--permission-mode", input.permission_mode)
  if (input.cloud) argv.push("--cloud")
  if (input.respect_workspace_trust === false) argv.push("--respect-workspace-trust", "false")
  const proc = spawnDevin(argv, input.cwd ?? fallbackCwd)
  const timeout = input.timeout_ms ?? 600_000
  const onAbort = () => proc.kill()
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => proc.kill(), timeout)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(`devin exited (code ${code})${stderr.trim() ? `: ${stderr.trim().slice(-1_500)}` : ""}`)
    }
    return stdout.trim()
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

function devinAcpArgv(input: Pick<SessionInput, "model" | "cloud" | "agent_type" | "refusal_fallback">) {
  const argv = [DEVIN_BIN, "acp"]
  if (input.cloud) argv.push("--cloud")
  if (input.model) argv.push("--model", input.model)
  if (input.agent_type) argv.push("--agent-type", input.agent_type)
  if (input.refusal_fallback) argv.push("--refusal-fallback", input.refusal_fallback)
  return argv
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    // Cheap host gate: this plugin needs the V2 promise API (tool.transform et
    // al). Warn once when the host reports a pre-2 major; an unparsable or
    // missing shape skips silently rather than guesses.
    const app: { readonly name?: unknown; readonly version?: unknown } | undefined = ctx.app
    const major = typeof app?.version === "string" ? Number.parseInt(app.version, 10) : NaN
    if (Number.isFinite(major) && major < 2) {
      const host = typeof app?.name === "string" ? `${app.name}@${String(app.version)}` : `version ${String(app?.version)}`
      console.error(`[${PLUGIN_ID}] hivemind-steward-oc-devin requires OpenCode V2 — host reports ${host}`)
    }

    const lanes = new Map<string, DevinLane>()
    const laneKey = (sessionID: string, name?: string) => `${sessionID}:${name ?? "default"}`

    const registerTool = async (tool: {
      readonly name: string
      readonly description: string
      readonly input: unknown
      readonly execute: (input: never, context: never) => Promise<{ readonly content?: string; readonly metadata?: Record<string, unknown> }>
    }) => {
      const toolDomain = ctx.tool as unknown as {
        transform?: (fn: (editor: { add: (t: unknown) => void }) => void) => Promise<unknown>
        add?: (t: unknown) => Promise<unknown>
      }
      if (typeof toolDomain.transform === "function") {
        try {
          await toolDomain.transform((editor) => editor.add(tool))
          return
        } catch (error) {
          console.error(
            `[${PLUGIN_ID}] tool.transform registration for "${tool.name}" failed — falling back to tool.add`,
            error instanceof Error ? error.message : error,
          )
        }
      }
      if (typeof toolDomain.add === "function") {
        await toolDomain.add(tool)
        return
      }
      console.error(`[${PLUGIN_ID}] host exposes neither tool.transform nor tool.add — "${tool.name}" was not registered`)
    }

    await registerTool({
      name: "devin_run",
      description:
        "Run a one-shot task in a headless Devin session (devin -p). Devin works autonomously with its own tools and returns its final output. Use devin_session for multi-turn work instead.",
      input: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Task for Devin to execute autonomously" },
          cwd: { type: "string", description: "Working directory for the Devin session (default: this project root)" },
          model: { type: "string", description: "Devin model override, e.g. 'opus', 'claude-sonnet-4', 'codex'" },
          permission_mode: { type: "string", enum: [...PERMISSION_MODES], description: "Devin permission mode (default: auto)" },
          cloud: { type: "boolean", description: "Drive a Devin Cloud session instead of the local agent" },
          respect_workspace_trust: {
            type: "boolean",
            description: "Enforce Devin's workspace trust check. Default true; set false for headless runs in untrusted dirs",
          },
          timeout_ms: { type: "integer", description: "Kill the run after this many ms (default 600000)" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      execute: async (rawInput: OneShotInput) => {
        const output = await runOneShot(rawInput, ctx.location.directory, AbortSignal.timeout((rawInput.timeout_ms ?? 600_000) + 5_000))
        return { content: output || "(devin produced no output)" }
      },
    } as never)

    await registerTool({
      name: "devin_session",
      description:
        "Drive a persistent Devin session over ACP (devin acp). Actions: start | send (prompt, auto-starts) | status | cancel | close. Sessions persist across calls within this OpenCode session, so Devin retains its own conversation context between sends.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "send", "status", "cancel", "close"] },
          prompt: { type: "string", description: "Prompt text (required for send)" },
          name: { type: "string", description: "Lane name to run parallel Devin sessions (default: 'default')" },
          cwd: { type: "string", description: "Working directory (start only; default: this project root)" },
          model: { type: "string", description: "Devin model override (start only)" },
          cloud: { type: "boolean", description: "Relay to Devin Cloud instead of the local agent (start only)" },
          agent_type: { type: "string", enum: ["summarizer", "review"], description: "Devin agent type (start only; omit for default agent)" },
          refusal_fallback: { type: "string", description: "Comma-separated fallback models on provider refusal (start only)" },
          auto_approve: { type: "boolean", description: "Auto-approve Devin permission requests on this unattended lane (default false — grant only for runs you trust)" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (rawInput: SessionInput, toolCtx: { sessionID: string; signal: AbortSignal }) => {
        const key = laneKey(toolCtx.sessionID, rawInput.name)
        const cwd = rawInput.cwd ?? ctx.location.directory

        if (rawInput.action === "status") {
          const lane = lanes.get(key)
          if (!lane) return { content: `no devin session '${rawInput.name ?? "default"}' in this OpenCode session` }
          return {
            content: `devin session ${lane.sessionId} (cwd: ${lane.cwd}, acp ${lane.acp.alive ? "alive" : "dead"})`,
            metadata: { sessionId: lane.sessionId, alive: lane.acp.alive },
          }
        }

        if (rawInput.action === "cancel" || rawInput.action === "close") {
          const lane = lanes.get(key)
          if (!lane) return { content: "nothing to " + rawInput.action }
          if (rawInput.action === "cancel") {
            await lane.acp.cancel(lane.sessionId)
            return { content: "cancelled in-flight prompt" }
          }
          lanes.delete(key)
          await lane.acp.close()
          return { content: `closed devin session ${lane.sessionId}` }
        }

        let lane = lanes.get(key)
        if (!lane || !lane.acp.alive) {
          const acp = await DevinAcp.spawn({
            argv: devinAcpArgv(rawInput),
            cwd,
            autoApprove: rawInput.auto_approve ?? false,
            requestTimeoutMs: rawInput.timeout_ms,
          })
          const session = await acp.newSession(cwd)
          lane = { acp, sessionId: session.sessionId, cwd }
          lanes.set(key, lane)
        }

        if (rawInput.action === "start") {
          return { content: `devin session started: ${lane.sessionId} (cwd: ${lane.cwd})`, metadata: { sessionId: lane.sessionId } }
        }

        const prompt = rawInput.prompt
        if (!prompt) return { content: "send requires a prompt" }
        const outcome = await lane.acp.prompt(lane.sessionId, prompt, toolCtx.signal)
        const thoughts = outcome.thoughts ? `\n\n--- reasoning ---\n${outcome.thoughts.slice(-8_000)}` : ""
        return {
          content: `${outcome.text || "(no text output)"}${thoughts}`,
          metadata: { sessionId: lane.sessionId, stopReason: outcome.stopReason },
        }
      },
    } as never)

    await registerTool({
      name: "devin_doctor",
      description:
        "Probe the local Devin CLI: resolves `devin` on PATH (or the DEVIN_BIN override) and runs `devin --version` with a 5s bound. Run it when devin_run/devin_session fail or before relying on them.",
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({ content: await probeDevin() }),
    } as never)

    const commandDomain = ctx.command as unknown as {
      transform?: (fn: (editor: { add: (d: unknown) => void }) => void) => Promise<unknown>
    }
    if (typeof commandDomain.transform === "function") {
      await commandDomain.transform((editor) =>
        editor.add({
          name: "devin_delegate",
          description:
            "Delegate a task to Devin from the agent: /devin_delegate <task> (one-shot) or /devin_delegate session <task> (persistent session). For a fully hosted Devin session inside the TUI, use the /devin view instead.",
          execute: async (input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }) => {
            const args = input.prompt.text.replace(/^\/?devin[_-]?(delegate)?\s*/, "").trim()
            const persistent = args.startsWith("session ")
            const task = persistent ? args.slice(8).trim() : args
            const text = persistent
              ? `Delegate this task to Devin using the devin_session tool (action: "send" with prompt; it auto-starts). After it returns, report Devin's result. Task: ${task}`
              : `Delegate this task to Devin using the devin_run tool. After it returns, report Devin's result. Task: ${task}`
            await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
          },
        }),
      )
    }

    return async () => {
      for (const lane of lanes.values()) await lane.acp.close().catch(() => { })
      lanes.clear()
    }
  },
})
