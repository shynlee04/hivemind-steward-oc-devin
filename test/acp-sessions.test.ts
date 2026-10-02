import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DevinAcp } from "../src/acp"

const FAKE = new URL("./fake-acp.ts", import.meta.url).pathname

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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acp-sessions-"))
  dirs.push(dir)
  return dir
}

function readLog(path: string): Frame[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Frame)
}

function sentFrames(path: string): Frame[] {
  return readLog(path).filter((f) => f.direction === "in" && f.msg?.method !== undefined)
}

async function spawnFake(path: string, options: { scenario?: string; env?: Record<string, string> } = {}): Promise<DevinAcp> {
  const acp = await DevinAcp.spawn({
    argv: [FAKE, "acp"],
    cwd: process.cwd(),
    autoApprove: false,
    requestTimeoutMs: 5_000,
    env: {
      FAKE_ACP_LOG: path,
      FAKE_ACP_SCENARIO: options.scenario ?? "basic",
      ...(options.env ?? {}),
    },
  })
  clients.push(acp)
  return acp
}

afterEach(async () => {
  for (const acp of clients.splice(0)) await acp.close().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("DevinAcp session wire scaffold (REQ-PICK-01 wire half)", () => {
  test("session/list follows nextCursor to the terminal page — unioned descriptors, no _meta survives", async () => {
    const log = join(tempDir(), "wire.ndjson")
    const acp = await spawnFake(log, { scenario: "sessions" })
    const result = await acp.listSessions()

    // The fake serves two finite pages: a bare-{} first request, then one
    // cursor follow — the walk terminates when page two carries no cursor.
    const listFrames = sentFrames(log).filter((f) => f.msg!.method === "session/list")
    expect(listFrames).toHaveLength(2)
    expect(listFrames[0]!.msg!.params).toEqual({})
    expect(listFrames[1]!.msg!.params).toEqual({ cursor: "cursor-page-2" })

    expect(result.sessions.length).toBe(6)
    for (const descriptor of result.sessions) {
      expect("_meta" in descriptor).toBe(false)
      expect(typeof descriptor.sessionId).toBe("string")
      expect(descriptor.sessionId.length).toBeGreaterThan(0)
    }
    // Page two carried no cursor — nothing unfollowed remains.
    expect(result.nextCursor).toBeUndefined()
    // Rows from both halves of the scripted list made the union.
    const ids = result.sessions.map((d) => d.sessionId)
    expect(ids).toContain("repeated-plane")
    expect(ids).toContain("warped-sundial")
  })

  test("a server echoing an already-followed cursor terminates the walk — no third request", async () => {
    const log = join(tempDir(), "wire.ndjson")
    const acp = await spawnFake(log, { scenario: "sessions", env: { FAKE_ACP_LIST_LOOP: "1" } })
    const result = await acp.listSessions()
    const listFrames = sentFrames(log).filter((f) => f.msg!.method === "session/list")
    expect(listFrames).toHaveLength(2)
    expect(result.sessions.length).toBe(6)
    expect(result.nextCursor).toBeUndefined()
  })

  test("descriptor translation: empty title stays empty, missing cwd undefined, unparsable updatedAt raw, lock fields typed (E21/E22)", async () => {
    const log = join(tempDir(), "wire.ndjson")
    const acp = await spawnFake(log, { scenario: "sessions" })
    const result = await acp.listSessions()
    const byId = new Map(result.sessions.map((d) => [d.sessionId, d]))

    const emptyTitle = byId.get("quiet-badger")
    expect(emptyTitle?.title).toBe("")

    const noCwd = byId.get("homeless-fern")
    expect(noCwd?.cwd).toBeUndefined()
    expect(noCwd?.requestingTabId).toBe("new-1790806213192-t6i9eofix")

    const mangledClock = byId.get("warped-sundial")
    expect(mangledClock?.updatedAt).toBe("not-a-timestamp")

    const locked = byId.get("repeated-plane")
    expect(locked?.isLocked).toBe(true)
    expect(locked?.lockHolderPid).toBe(95393)
    expect(locked?.createdAt).toBe("2026-09-30T16:19:10.000Z")

    const unlocked = byId.get("cherry-random")
    expect(unlocked?.isLocked).toBe(false)
    expect(unlocked?.lockHolderPid).toBeUndefined()
  })

  test("FAKE_ACP_SESSIONS file overrides the scripted page", async () => {
    const dir = tempDir()
    const log = join(dir, "wire.ndjson")
    const page = join(dir, "sessions.json")
    writeFileSync(
      page,
      JSON.stringify([
        { sessionId: "env-driven", cwd: "/tmp/env", title: "From the env file", updatedAt: "2026-10-02T00:00:00+00:00" },
      ]),
    )
    const acp = await spawnFake(log, { scenario: "sessions", env: { FAKE_ACP_SESSIONS: page } })
    const result = await acp.listSessions()
    expect(result.sessions.map((d) => d.sessionId)).toEqual(["env-driven"])
    expect(result.sessions[0]!.isLocked).toBe(false)
  })

  test("session/load sends {sessionId, cwd, mcpServers:[]} and the replay arrives tagged to the request id before the response", async () => {
    const log = join(tempDir(), "wire.ndjson")
    const acp = await spawnFake(log, { scenario: "sessions" })
    const result = await acp.loadSession("cherry-random", "/tmp/lane-cwd")

    const frames = readLog(log)
    const loadIdx = frames.findIndex((f) => f.direction === "in" && f.msg?.method === "session/load")
    expect(loadIdx).toBeGreaterThan(-1)
    const loadId = frames[loadIdx]!.msg!.id!
    expect(frames[loadIdx]!.msg!.params).toEqual({ sessionId: "cherry-random", cwd: "/tmp/lane-cwd", mcpServers: [] })

    const responseIdx = frames.findIndex((f) => f.direction === "out" && f.msg?.id === loadId)
    expect(responseIdx).toBeGreaterThan(loadIdx)

    const replayIdx = frames.findIndex(
      (f) =>
        f.direction === "out" &&
        f.msg?.method === "session/update" &&
        (f.msg.params as { sessionId?: string }).sessionId === "cherry-random",
    )
    expect(replayIdx).toBeGreaterThan(loadIdx)
    expect(replayIdx).toBeLessThan(responseIdx)

    const kinds = frames
      .slice(loadIdx, responseIdx)
      .filter((f) => f.msg?.method === "session/update")
      .map((f) => (f.msg!.params as { update: { sessionUpdate: string } }).update.sessionUpdate)
    for (const kind of ["user_message_chunk", "agent_thought_chunk", "plan", "tool_call", "agent_message_chunk", "session_info_update", "available_commands_update"]) {
      expect(kinds).toContain(kind)
    }

    expect(result).not.toHaveProperty("sessionId")
    expect(result.modes?.currentModeId).toBe("accept-edits")
    expect(result.configOptions?.map((o) => o.id)).toEqual(["mode", "model", "thought_level"])
  })

  test("a prompt double-flight on a loaded session still rejects before the wire (PROH-05)", async () => {
    const log = join(tempDir(), "wire.ndjson")
    const acp = await spawnFake(log, { scenario: "sessions", env: { FAKE_ACP_DELAY_MS: "120" } })
    await acp.loadSession("cherry-random", "/tmp/lane-cwd")
    const first = acp.prompt("cherry-random", "first")
    await expect(acp.prompt("cherry-random", "second")).rejects.toThrow(/prompt in flight/)
    await first
    const prompts = sentFrames(log).filter((f) => f.msg!.method === "session/prompt")
    expect(prompts).toHaveLength(1)
  })
})
