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
import { pickNamed, pickNew, waitForPicker } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-swap-"))
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

const wire = (path: string): { method: string; params: Record<string, unknown> }[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } })
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => ({ method: f.msg!.method!, params: f.msg!.params ?? {} }))
}

const count = (path: string, method: string) => wire(path).filter((w) => w.method === method).length

const permissionAnswers = (path: string, id: string) => {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { direction: string; msg?: { id?: number | string; result?: { outcome?: unknown } } })
      .filter((f) => f.direction === "in" && f.msg?.id === id)
      .map((f) => f.msg!.result!.outcome as { outcome: string; optionId?: string })
  } catch {
    return [] as { outcome: string; optionId?: string }[]
  }
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The picker rides the host dialog — picks happen by typing the session name
// into the filter and ⏎ on the matching row, never by row digit.
const swapToCherry = async (setup: TestRendererSetup, log: string) => {
  await pickNew(setup)
  await untilFrame(setup, (fr) => fr.includes("fake-session-"))
  await setup.mockInput.typeText("hi")
  setup.mockInput.pressEnter()
  // "pong:" paints mid-flight; wait for the settled status (ready — end_turn)
  // before ctrl+o or the busy gate correctly refuses the swap (E25).
  await untilFrame(setup, (fr) => fr.includes("pong: hi") && fr.includes("end_turn"))
  setup.mockInput.pressKey("o", { ctrl: true })
  await pickNamed(setup, "cherry-random")
  await until(() => wire(log).some((w) => w.method === "session/load" && w.params.sessionId === "cherry-random"))
}

describe("Hosted Devin View — session swap (REQ-SWAP-01, REQ-STALE-01)", () => {
  test("ctrl+o swap re-binds on the same engine — one session/load(B), initialize stays 1, B's replay rebuilds the log", async () => {
    const { setup, log } = await mountView({ scenario: "swap" })
    await swapToCherry(setup, log)
    const f = await untilFrame(setup, (fr) => fr.includes("31.5k") && fr.includes("❯ Acknowledge the linked file"))
    expect(f).toContain("❯ Acknowledge the linked file by name only, one line.")
    expect(f).toContain("❯ package.json")
    expect(f).not.toContain("pong: hi")
    expect(f.split("\n")[0]).toContain("Reply with exactly the single word: ok")
    const loads = wire(log).filter((w) => w.method === "session/load")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params).toEqual({ sessionId: "cherry-random", cwd: "/Users/test/opencode-devin", mcpServers: [] })
    expect(count(log, "initialize")).toBe(1)
    expect(count(log, "session/new")).toBe(1)
    expect(count(log, "session/prompt")).toBe(1)
  })

  test("post-swap frames tagged to the old session change nothing; its permission is answered cancelled (REQ-STALE-01)", async () => {
    const { setup, log, directory } = await mountView({ scenario: "swap" })
    await swapToCherry(setup, log)
    const f = await untilFrame(setup, (fr) => fr.includes("31.5k"))
    expect(f).not.toContain("STALE swap bleed")
    expect(f).not.toContain("stale-model")
    expect(f).not.toContain("Stale swap tool call")
    await until(() => permissionAnswers(log, "srv-perm-swap-stale").length === 1)
    expect(permissionAnswers(log, "srv-perm-swap-stale")[0]).toEqual({ outcome: "cancelled" })
    setup.mockInput.pressKey("g", { ctrl: true })
    const commands = await untilFrame(setup, (fr) => fr.includes("/login") && fr.includes("/status") && fr.includes("/plan"))
    expect(commands).not.toContain("stale-cmd")
    setup.mockInput.pressEscape()
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    expect(lane.sessionId).toBe("cherry-random")
  })

  test("ctrl+o while a prompt is in flight refuses with a system notice and zero session/load (E25)", async () => {
    const { setup, log } = await mountView({ scenario: "swap", env: { FAKE_ACP_DELAY_MS: "500" } })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    await setup.mockInput.typeText("work")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ work"))
    setup.mockInput.pressKey("o", { ctrl: true })
    const f = await untilFrame(setup, (fr) => fr.includes("busy"))
    expect(f).toContain("settle")
    expect(count(log, "session/load")).toBe(0)
    expect(count(log, "session/list")).toBe(2)
    await untilFrame(setup, (fr) => fr.includes("pong: work"))
  })

  test("ctrl+o while a permission card is pending refuses with a system notice (E25)", async () => {
    const { setup, log } = await mountView({ scenario: "permission" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("Permission required") && fr.includes("Delete node_modules"))
    setup.mockInput.pressKey("o", { ctrl: true })
    const f = await untilFrame(setup, (fr) => fr.includes("settle"))
    expect(f).toContain("Permission required")
    expect(count(log, "session/load")).toBe(0)
    expect(count(log, "session/list")).toBe(1)
  })

  test("picking the currently-bound descriptor dismisses the overlay with zero new wire frames (E39)", async () => {
    const { setup, log } = await mountView({ scenario: "swap" })
    await swapToCherry(setup, log)
    await untilFrame(setup, (fr) => fr.includes("31.5k"))
    const listsBefore = count(log, "session/list")
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("+ New session"))
    await until(() => count(log, "session/list") === listsBefore + 2)
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => !fr.includes("+ New session") && fr.includes("31.5k"))
    expect(f).not.toContain("mango-mangosteen")
    expect(count(log, "session/load")).toBe(1)
    expect(count(log, "session/new")).toBe(1)
    expect(count(log, "initialize")).toBe(1)
  })

  test("esc on the bound sessions overlay dismisses without navigating; re-open re-lists (poll-on-open)", async () => {
    const { setup, test, log } = await mountView({ scenario: "swap" })
    await swapToCherry(setup, log)
    await untilFrame(setup, (fr) => fr.includes("31.5k"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("+ New session"))
    setup.mockInput.pressEscape()
    const f = await untilFrame(setup, (fr) => !fr.includes("+ New session"))
    expect(f).toContain("31.5k")
    expect(test.navigations).toEqual([])
    const lists = count(log, "session/list")
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("+ New session"))
    await until(() => count(log, "session/list") === lists + 2)
  })
})
