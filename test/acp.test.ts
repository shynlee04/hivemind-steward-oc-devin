import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevinAcp, type SessionUpdate } from "../src/acp"
import { until } from "./support/drive"

const FAKE = new URL("./fake-acp.ts", import.meta.url).pathname

interface SpawnOptions {
  readonly scenario?: string
  readonly env?: Record<string, string>
  readonly requestTimeoutMs?: number
  readonly autoApprove?: boolean
  readonly events?: Parameters<typeof DevinAcp.spawn>[0]["events"]
}

interface Frame {
  readonly direction: "in" | "out" | "meta"
  readonly msg?: {
    readonly id?: number | string
    readonly method?: string
    readonly params?: Record<string, unknown>
    readonly result?: unknown
    readonly error?: { code: number; message: string }
  }
  readonly event?: string
}

const dirs: string[] = []
const clients: DevinAcp[] = []

function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-acp-"))
  dirs.push(dir)
  return join(dir, "wire.ndjson")
}

function readLog(path: string): Frame[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Frame)
}

function sentMethods(path: string): string[] {
  return readLog(path)
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => f.msg!.method!)
}

async function spawnFake(path: string, options: SpawnOptions = {}): Promise<DevinAcp> {
  const acp = await DevinAcp.spawn({
    argv: [FAKE, "acp"],
    cwd: process.cwd(),
    autoApprove: options.autoApprove ?? false,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    env: {
      FAKE_ACP_LOG: path,
      FAKE_ACP_SCENARIO: options.scenario ?? "basic",
      ...(options.env ?? {}),
    },
    events: options.events,
  })
  clients.push(acp)
  return acp
}

afterEach(async () => {
  for (const acp of clients.splice(0)) await acp.close().catch(() => { })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("DevinAcp over scripted fake", () => {
  test("handshake emits initialize → session/new → session/prompt in order, once each (REQ-LIFE-01)", async () => {
    const log = logPath()
    const acp = await spawnFake(log)
    const session = await acp.newSession(process.cwd())
    expect(session.sessionId).toContain("fake-session")
    expect(session.configOptions?.map((o) => o.id)).toEqual(["mode", "model", "thought_level"])

    const outcome = await acp.prompt(session.sessionId, "say hi")
    expect(outcome.stopReason).toBe("end_turn")
    expect(outcome.text).toContain("say hi")

    expect(sentMethods(log)).toEqual(["initialize", "session/new", "session/prompt"])
  })

  test("a second session/prompt while one is in flight never reaches the wire (PROH-05)", async () => {
    const log = logPath()
    const acp = await spawnFake(log, { env: { FAKE_ACP_DELAY_MS: "150" } })
    const session = await acp.newSession(process.cwd())
    const first = acp.prompt(session.sessionId, "first")
    await expect(acp.prompt(session.sessionId, "second")).rejects.toThrow(/prompt in flight/)
    await first
    const prompts = sentMethods(log).filter((m) => m === "session/prompt")
    expect(prompts).toHaveLength(1)
  })

  test("process exit mid-prompt rejects the pending request and flips alive (E9)", async () => {
    const log = logPath()
    const acp = await spawnFake(log, { scenario: "crash" })
    const session = await acp.newSession(process.cwd())
    await expect(acp.prompt(session.sessionId, "boom")).rejects.toThrow(/exited/)
    await Bun.sleep(30)
    expect(acp.alive).toBe(false)
  })

  test("malformed stdout lines are ignored; pending requests unaffected (E13)", async () => {
    const log = logPath()
    const acp = await spawnFake(log)
    // The fake emits the noise line in the same handler tick as the initialize
    // response, but pipe delivery can wake this process first — poll the log
    // rather than racing the child's append.
    await until(() => readLog(log).some((f) => f.direction === "out" && f.event === "noise"))
    const session = await acp.newSession(process.cwd())
    const outcome = await acp.prompt(session.sessionId, "still works")
    expect(outcome.text).toContain("still works")
  })

  test("permission request round-trips the user's optionId before the prompt resolves (REQ-PERM-01)", async () => {
    const log = logPath()
    const seen: string[] = []
    const acp = await spawnFake(log, {
      scenario: "permission",
      events: {
        onPermission: async (params) => {
          seen.push(params.toolCall?.title ?? "")
          return { outcome: "selected", optionId: params.options?.[0]?.optionId ?? "" }
        },
      },
    })
    const session = await acp.newSession(process.cwd())
    const outcome = await acp.prompt(session.sessionId, "needs approval")
    expect(outcome.stopReason).toBe("end_turn")
    expect(seen).toEqual(["Delete node_modules"])

    const frames = readLog(log)
    const answerIdx = frames.findIndex(
      (f) =>
        f.direction === "in" &&
        f.msg?.id === "srv-perm-1" &&
        (f.msg?.result as { outcome?: { optionId?: string } } | undefined)?.outcome?.optionId === "perm-allow-once",
    )
    const promptResultIdx = frames.findIndex(
      (f) => f.direction === "out" && f.msg?.result && (f.msg.result as { stopReason?: string }).stopReason === "end_turn",
    )
    expect(answerIdx).toBeGreaterThan(-1)
    expect(promptResultIdx).toBeGreaterThan(answerIdx)
  })

  test("autoApprove:false without a handler answers cancelled, never auto-selected (PROH-03)", async () => {
    const log = logPath()
    const acp = await spawnFake(log, { scenario: "permission", autoApprove: false })
    const session = await acp.newSession(process.cwd())
    await acp.prompt(session.sessionId, "needs approval")
    const answer = readLog(log).find((f) => f.direction === "in" && f.msg?.id === "srv-perm-1")
    expect((answer?.msg?.result as { outcome: { outcome: string } }).outcome.outcome).toBe("cancelled")
  })

  test("session/cancel emits a notify only when asked and resolves the prompt cancelled (PROH-10)", async () => {
    const log = logPath()
    let sawUpdate = false
    const acp = await spawnFake(log, {
      env: { FAKE_ACP_DELAY_MS: "200" },
      events: { onUpdate: () => (sawUpdate = true) },
    })
    const session = await acp.newSession(process.cwd())
    const pending = acp.prompt(session.sessionId, "long work")
    while (!sawUpdate) await Bun.sleep(5)
    await acp.cancel(session.sessionId)
    const outcome = await pending
    expect(outcome.stopReason).toBe("cancelled")
    const cancels = sentMethods(log).filter((m) => m === "session/cancel")
    expect(cancels).toHaveLength(1)
  })

  test("request timeout rejects a silent server", async () => {
    const log = logPath()
    const acp = await spawnFake(log, { scenario: "silent", requestTimeoutMs: 80 })
    const session = await acp.newSession(process.cwd())
    await expect(acp.prompt(session.sessionId, "hello?")).rejects.toThrow(/timed out/)
  })

  test("autoApprove:true never picks a deny-labelled option even when it contains 'allow'", async () => {
    const log = logPath()
    const acp = await spawnFake(log, {
      scenario: "permission",
      autoApprove: true,
      env: {
        FAKE_ACP_PERM_OPTIONS: JSON.stringify([
          { optionId: "perm-dont", name: "Don't allow" },
          { optionId: "perm-yes", name: "Yes" },
        ])
      },
    })
    const session = await acp.newSession(process.cwd())
    await acp.prompt(session.sessionId, "needs approval")
    const answer = readLog(log).find((f) => f.direction === "in" && f.msg?.id === "srv-perm-1")
    const outcome = (answer?.msg?.result as { outcome: { outcome: string; optionId?: string } }).outcome
    expect(outcome.outcome).toBe("selected")
    expect(outcome.optionId).toBe("perm-yes")
  })

  test("autoApprove:true picks the allow option, not options[0], when labels carry no kind", async () => {
    const log = logPath()
    const acp = await spawnFake(log, {
      scenario: "permission",
      autoApprove: true,
      env: {
        FAKE_ACP_PERM_OPTIONS: JSON.stringify([
          { optionId: "perm-no", name: "No" },
          { optionId: "perm-yes", name: "Yes" },
        ])
      },
    })
    const session = await acp.newSession(process.cwd())
    await acp.prompt(session.sessionId, "needs approval")
    const answer = readLog(log).find((f) => f.direction === "in" && f.msg?.id === "srv-perm-1")
    const outcome = (answer?.msg?.result as { outcome: { outcome: string; optionId?: string } }).outcome
    expect(outcome.outcome).toBe("selected")
    expect(outcome.optionId).toBe("perm-yes")
  })

  test("autoApprove:true fails closed — deny-only options resolve cancelled, not options[0]", async () => {
    const log = logPath()
    const acp = await spawnFake(log, {
      scenario: "permission",
      autoApprove: true,
      env: {
        FAKE_ACP_PERM_OPTIONS: JSON.stringify([
          { optionId: "perm-no", name: "No" },
          { optionId: "perm-deny", name: "Deny" },
        ])
      },
    })
    const session = await acp.newSession(process.cwd())
    await acp.prompt(session.sessionId, "needs approval")
    const answer = readLog(log).find((f) => f.direction === "in" && f.msg?.id === "srv-perm-1")
    expect((answer?.msg?.result as { outcome: { outcome: string } }).outcome.outcome).toBe("cancelled")
  })
})
