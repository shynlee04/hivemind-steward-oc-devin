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
import { until, untilFrame } from "./support/drive"
import { pickNamed, pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-loaderr-"))
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
const loadsTo = (path: string, sessionId: string) =>
  wire(path).filter((w) => w.method === "session/load" && w.params.sessionId === sessionId)

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

// Row indices on the load-error page: 1 = + New session;
// 2 locked-ward (⚿ 4242, foreign cwd — always fails), 3 picky-cwd (foreign cwd
// rejected once, lane-cwd retry accepted), 4 deleted-ghost (no cwd, partial
// replay then not-found).
describe("Hosted Devin View — failed binds restore prior state (REQ-LOCK-01)", () => {
  test("unbound pick of a deleted session surfaces the wire error, re-offers the picker, and drops the partial replay", async () => {
    const { setup, log, directory } = await mountView({ scenario: "load-error" })
    const f = await untilFrame(setup, (fr) => fr.includes("deleted-ghost") && fr.includes("+ New session"))
    expect(f).toMatch(/⚿\s*4242/)
    await pickNamed(setup, "deleted-ghost")
    // The failed unbound pick re-offers the picker; the wire error lands in the
    // lane log behind the reopened dialog.
    await until(() => loadsTo(log, "deleted-ghost").length === 1)
    const failed = await untilFrame(
      setup,
      (fr) => fr.includes("+ New session") && fr.includes("Deleted in another client"),
    )
    expect(failed).toContain("+ New session")
    expect(failed).toContain("locked-ward")
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    expect(lane.sessionId).toBe("")
    expect(lane.loadingId).toBe("")
    expect(lane.entries.filter((e) => e.kind === "system").map((e) => e.text).join("\n")).toContain(
      "could not load session deleted-ghost",
    )
    expect(lane.entries.some((e) => "text" in e && e.text.includes("GHOST"))).toBe(false)
    const loads = loadsTo(log, "deleted-ghost")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params.cwd).toBe(directory)
    expect(count(log, "initialize")).toBe(1)
  })

  test("bound swap to a deleted session keeps the prior binding — log, header, sessionId — plus the error entry", async () => {
    const { setup, log, directory } = await mountView({ scenario: "load-error" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    await setup.mockInput.typeText("keep")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("pong: keep"))
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    const boundId = lane.sessionId
    const headerBefore = (await untilFrame(setup, (fr) => fr.includes("pong: keep"))).split("\n")[0]
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("deleted-ghost"))
    await pickNamed(setup, "deleted-ghost")
    // The restored agent reply re-parses on a later paint than the system
    // entry — wait until the same frame carries both.
    const f = await untilFrame(setup, (fr) => fr.includes("could not load session deleted-ghost") && fr.includes("pong: keep"))
    expect(f).toContain("❯ keep")
    expect(f).not.toContain("GHOST")
    expect(f.split("\n")[0]).toBe(headerBefore)
    expect(lane.sessionId).toBe(boundId)
    expect(lane.loadingId).toBe("")
    expect(lane.entries.some((e) => "text" in e && e.text.includes("GHOST"))).toBe(false)
    const loads = loadsTo(log, "deleted-ghost")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params.cwd).toBe(directory)
    expect(count(log, "initialize")).toBe(1)
  })

  test("swap to a locked session retries once on the lane cwd, fails, restores — and the next open re-lists (E24, E42)", async () => {
    const { setup, log, directory } = await mountView({ scenario: "load-error" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    await setup.mockInput.typeText("mine")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("pong: mine"))
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    const boundId = lane.sessionId
    const headerBefore = (await untilFrame(setup, (fr) => fr.includes("pong: mine"))).split("\n")[0]
    setup.mockInput.pressKey("o", { ctrl: true })
    const overlay = await untilFrame(setup, (fr) => fr.includes("locked-ward"))
    expect(overlay).toMatch(/⚿\s*4242/)
    await pickNamed(setup, "locked-ward")
    // The restored agent reply re-parses on a later paint than the system
    // entry — wait until the same frame carries both.
    const f = await untilFrame(
      setup,
      (fr) => fr.includes("could not load session locked-ward") && fr.includes("locked by a live client") && fr.includes("pong: mine"),
    )
    expect(f.split("\n")[0]).toBe(headerBefore)
    expect(lane.sessionId).toBe(boundId)
    const loads = loadsTo(log, "locked-ward")
    expect(loads).toHaveLength(2)
    expect(loads[0]!.params.cwd).toBe("/Users/test/opencode-devin")
    expect(loads[1]!.params.cwd).toBe(directory)
    expect(count(log, "initialize")).toBe(1)
    const lists = count(log, "session/list")
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("+ New session"))
    await until(() => count(log, "session/list") === lists + 2)
  })

  test("cwd-rejected load retries once on the lane cwd and binds on success (E42)", async () => {
    const { setup, log, directory } = await mountView({ scenario: "load-error" })
    await untilFrame(setup, (fr) => fr.includes("picky-cwd"))
    await pickNamed(setup, "picky-cwd")
    const f = await untilFrame(setup, (fr) => fr.includes("picky-cwd") && fr.includes("ready"))
    expect(f.split("\n")[0]).toContain("picky-cwd")
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    expect(lane.sessionId).toBe("picky-cwd")
    const loads = loadsTo(log, "picky-cwd")
    expect(loads).toHaveLength(2)
    expect(loads[0]!.params.cwd).toBe("/recorded/elsewhere")
    expect(loads[1]!.params.cwd).toBe(directory)
    expect(count(log, "initialize")).toBe(1)
    expect(count(log, "session/new")).toBe(0)
  })

  test("a failed swap rolls back the failed session's config — the rebound lane keeps its own model/mode/thinking options", async () => {
    const { setup, directory } = await mountView({ scenario: "load-error" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    expect(lane.config.current.find((o) => o.id === "model")?.currentValue).toBe("swe-2-high")
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("deleted-ghost"))
    await pickNamed(setup, "deleted-ghost")
    const f = await untilFrame(setup, (fr) => fr.includes("could not load session deleted-ghost"))
    expect(lane.sessionId).toContain("fake-session-")
    expect(lane.config.current.find((o) => o.id === "model")?.currentValue).toBe("swe-2-high")
    expect(lane.config.current.some((o) => o.options?.some((c) => c.value === "ghost-model"))).toBe(false)
    expect(f.split("\n")[0]).toContain("SWE-2")
    setup.mockInput.pressKey("m", { ctrl: true })
    const picker = await untilFrame(setup, (fr) => fr.includes("Adaptive"))
    expect(picker).not.toContain("ghost-model")
  })

  test("mid-load pending-tag permissions answer cancelled when the load fails — no ghost card, picker keys still work", async () => {
    const { setup, log, directory } = await mountView({ scenario: "load-error" })
    await untilFrame(setup, (fr) => fr.includes("deleted-ghost") && fr.includes("+ New session"))
    await pickNamed(setup, "deleted-ghost")
    await until(() => loadsTo(log, "deleted-ghost").length === 1)
    const f = await untilFrame(setup, (fr) => fr.includes("+ New session") && fr.includes("picky-cwd"))
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    expect(lane.pending).toBeUndefined()
    expect(lane.entries.some((e) => e.kind === "permission")).toBe(false)
    expect(f).not.toContain("Permission required")
    await until(() => permissionAnswers(log, "srv-perm-ghost").length === 1)
    await until(() => permissionAnswers(log, "srv-perm-ghost-queued").length === 1)
    expect(permissionAnswers(log, "srv-perm-ghost")[0]).toEqual({ outcome: "cancelled" })
    expect(permissionAnswers(log, "srv-perm-ghost-queued")[0]).toEqual({ outcome: "cancelled" })
    // The overlay released: the picker filters to the row again instead of
    // feeding an invisible permission card.
    await pickNamed(setup, "picky-cwd")
    await until(() => loadsTo(log, "picky-cwd").length === 2)
    expect(lane.sessionId).toBe("picky-cwd")
  })
})
