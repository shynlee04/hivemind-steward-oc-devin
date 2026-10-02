import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { laneFor } from "../src/lane"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { tick, until, untilFrame } from "./support/drive"
import { pickNamed, pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-errors-"))
  dirs.push(directory)
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  await render(
    () =>
      [DevinView({
        context: test.context,
        initialPrompt: options.initialPrompt,
        deps: { spawnEngine: fakeEngineSpawn({ ...options, env: { FAKE_ACP_LOG: log, ...(options.env ?? {}) } }) },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test, log, directory }
}

const frames = (path: string) => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return [] as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } }[]
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } })
}

const wire = (path: string) =>
  frames(path)
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => ({ method: f.msg!.method!, params: f.msg!.params ?? {} }))

const count = (path: string, method: string) => wire(path).filter((w) => w.method === method).length

const noiseOut = (path: string, method: string) =>
  frames(path).filter((f) => f.direction === "out" && f.msg?.method === method).length

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — wire error taxonomy (REQ-ERR-01)", () => {
  test("every request path renders user_message with its hint — never the raw wire string", async () => {
    const { setup, log, directory } = await mountView({ scenario: "wire-errors" })
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    const sysText = () =>
      lane.entries.filter((e) => e.kind === "system").map((e) => e.text).join("\n")
    // session/list (first call): RateLimited + retryable + user_message — the
    // picker's own error row carries it inside the dialog.
    const listErr = await untilFrame(setup, (fr) => fr.includes("could not list sessions"))
    expect(listErr).toContain("Devin rate limit reached")
    expect(listErr).toContain("+ New session")
    await until(() => sysText().includes("Devin rate limit reached — retry shortly"))
    expect(sysText()).toContain("(retryable)")
    expect(sysText()).not.toContain("ERR_RATELIMIT")
    // session/new (first call): Unauthenticated carries the auth hint. The
    // failed unbound pick re-offers the dialog, which bisects the system
    // entry on screen — the lane log is the behavioral surface.
    await pickNew(setup)
    await until(() => sysText().includes("Devin credentials expired"))
    expect(sysText()).toContain("devin auth login")
    expect(sysText()).not.toContain("ERR_AUTH")
    // Second session/new binds — the lane recovered through the same picker row.
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    // session/prompt: QuotaExhausted user_message, no retryable hint.
    await setup.mockInput.typeText("spend")
    setup.mockInput.pressEnter()
    const promptErr = await untilFrame(setup, (fr) => fr.includes("Devin quota exhausted for this billing period"))
    expect(promptErr).not.toContain("ERR_QUOTA")
    const quotaLine = promptErr.split("\n").find((l) => l.includes("Devin quota exhausted")) ?? ""
    expect(quotaLine).not.toContain("retryable")
    // session/set_* through the mode picker: ServerError + retryable.
    setup.mockInput.pressKey("e", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("Smart"))
    setup.mockInput.pressKey("2")
    const setErr = await untilFrame(setup, (fr) => fr.includes("Devin backend hiccup — retry in a moment"))
    expect(setErr).toContain("(retryable)")
    expect(setErr).not.toContain("ERR_SET")
    // session/load: no data payload → the wire message itself is the fallback;
    // the prior binding survives intact (REQ-LOCK-01 + REQ-ERR-01).
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("+ New session"))
    await pickNamed(setup, "cherry-random")
    const loadErr = await untilFrame(setup, (fr) => fr.includes("session is locked by a live client (pid 4242)"))
    expect(loadErr).toContain("could not load session cherry-random")
    expect(loadErr).toContain("fake-session-")
    expect(loadErr).not.toContain("-32602")
    expect(count(log, "initialize")).toBe(1)
  })

  test("the MCP connect storm yields zero entries; a bound-tagged error line renders once; unknown _ methods are tolerated (REQ-NOISE-01, E32)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => fr.includes("31.5k") && fr.includes("dropped a transcript frame — recovered"))
    // The storm really happened on the wire — the log records it; the lane
    // rendered none of it.
    expect(noiseOut(log, "_cognition.ai/output")).toBeGreaterThanOrEqual(37)
    expect(noiseOut(log, "_cognition.ai/mcp/serversChanged")).toBeGreaterThanOrEqual(1)
    expect(noiseOut(log, "_cognition.ai/mystery_extension")).toBe(1)
    expect(f).not.toContain("MCP:")
    expect(f).not.toContain("deepwiki")
    expect(f).not.toContain("serversChanged")
    // E32: the empty-tagged warn line is unattributable — dropped.
    expect(f).not.toContain("unattributable warn line")
    expect(f).not.toContain("mystery_extension")
    // Exactly one system entry for the bound-tagged error line.
    expect(f.split("dropped a transcript frame — recovered").length - 1).toBe(1)
    expect(f).toContain("agent: dropped a transcript frame")
    // The open-union rule held: the stream continued and a prompt still works.
    await setup.mockInput.typeText("still alive")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("pong: still alive"))
    await tick(setup)
    expect(count(log, "session/prompt")).toBe(1)
  })
})
