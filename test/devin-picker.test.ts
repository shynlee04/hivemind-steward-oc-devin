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
  readonly height?: number
  readonly directory?: string
  readonly initialPrompt?: string
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devin-picker-"))
  dirs.push(dir)
  return dir
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = options.directory ?? tempDir()
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 160, height: options.height ?? 40, kittyKeyboard: true })
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

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — session picker (REQ-PICK-01, REQ-NEW-01)", () => {
  test("bare mount lists real sessions — zero session/new, one session/list, rows match the wire page", async () => {
    // Tall enough for the host-capped scrollbox (floor(h/2)-6) to show every row.
    const { setup, log, directory } = await mountView({ scenario: "sessions", height: 60 })
    const f = await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("+ New session"))
    expect(f).toContain("Starting Local Devin Sessions from OpenCode V2 TUI")
    expect(f).toContain("Reply with exactly the single word: ok")
    expect(f).toMatch(/⚿\s*95393/)
    expect(f).toContain("quiet-badger")
    expect(f).toContain("homeless-fern")
    const homelessRow = f.split("\n").find((l) => l.includes("homeless-fern")) ?? ""
    expect(homelessRow).toContain(directory.replace(/\/$/, "").split("/").pop() ?? directory)
    expect(f).toContain("warped-sundial")
    expect(f).toContain("not-a-timestamp")
    expect(f).not.toMatch(/more sessions|next page/i)
    // Wire order, never re-sorted (REQ-PICK-01): mango-mangosteen (16:33:03)
    // sits after cherry-random (16:33:20), and quiet-badger (17:14) after both —
    // any updatedAt sort in sessionRows()/refreshSessions() inverts these lines.
    const rowLine = (id: string) => f.split("\n").findIndex((l) => l.includes(id))
    expect(rowLine("repeated-plane")).toBeLessThan(rowLine("cherry-random"))
    expect(rowLine("cherry-random")).toBeLessThan(rowLine("mango-mangosteen"))
    expect(rowLine("mango-mangosteen")).toBeLessThan(rowLine("quiet-badger"))
    expect(rowLine("quiet-badger")).toBeLessThan(rowLine("homeless-fern"))
    expect(rowLine("homeless-fern")).toBeLessThan(rowLine("warped-sundial"))
    expect(count(log, "session/new")).toBe(0)
    const lists = wire(log).filter((w) => w.method === "session/list")
    expect(lists).toHaveLength(2)
    expect(lists[0]!.params).toEqual({})
    expect(lists[1]!.params).toEqual({ cursor: "cursor-page-2" })
  })

  test("+ New session is row 1 and binds via session/new on the same engine; composer then accepts input (REQ-NEW-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    const f = await untilFrame(setup, (fr) => fr.includes("+ New session") && fr.includes("repeated-plane"))
    expect(f.split("\n").findIndex((l) => l.includes("+ New session"))).toBeLessThan(
      f.split("\n").findIndex((l) => l.includes("repeated-plane")),
    )
    setup.mockInput.pressEnter()
    const bound = await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    expect(bound).toContain("fake-session-")
    expect(count(log, "session/new")).toBe(1)
    expect(count(log, "session/load")).toBe(0)
    expect(count(log, "initialize")).toBe(1)
    await setup.mockInput.typeText("hello")
    await setup.renderOnce()
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("hello")
  })

  test("picking a descriptor emits one session/load {sessionId, cwd, mcpServers:[]} on the same engine (REQ-LOAD-01 wire half)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    await untilFrame(setup, (fr) => !fr.includes("+ New session"))
    const loads = wire(log).filter((w) => w.method === "session/load")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params).toEqual({ sessionId: "cherry-random", cwd: "/Users/test/opencode-devin", mcpServers: [] })
    expect(count(log, "initialize")).toBe(1)
    expect(count(log, "session/new")).toBe(0)
  })

  test("unbound discipline: typeText lands in the picker filter — never the composer; esc navigates home, ctrl+o is a no-op (E26)", async () => {
    const { setup, test, log } = await mountView({ scenario: "sessions" })
    await waitForPicker(setup)
    await setup.mockInput.typeText("nothing to send to")
    await setup.renderOnce()
    expect(setup.renderer.currentFocusedEditor?.plainText ?? "").toBe("nothing to send to")
    await untilFrame(setup, (fr) => fr.includes("No sessions found"))
    expect(count(log, "session/prompt")).toBe(0)
    await until(() => count(log, "session/list") === 2)
    setup.mockInput.pressKey("o", { ctrl: true })
    await tick(setup, 80)
    expect(count(log, "session/list")).toBe(2)
    setup.mockInput.pressEscape()
    await tick(setup)
    expect(test.navigations).toEqual([{ type: "home" }])
  })

  test("/devin <task> on an unbound lane binds session/new then submits — the picker is skipped (REQ-ARG-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", initialPrompt: "do the thing" })
    await untilFrame(setup, (fr) => fr.includes("❯ do the thing") && fr.includes("pong: do the thing"))
    expect(count(log, "session/new")).toBe(1)
    expect(count(log, "session/load")).toBe(0)
    expect(count(log, "session/list")).toBe(0)
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.params.prompt as { text: string }[])[0]!.text).toBe("do the thing")
  })

  test("/devin <task> whose initial session/new fails keeps the task parked in the composer (E41)", async () => {
    const { setup, log, directory } = await mountView({
      scenario: "sessions",
      initialPrompt: "do the thing",
      env: { FAKE_ACP_NEW_ERROR: "1" },
    })
    const f = await untilFrame(setup, (fr) => fr.includes("could not start a new session") && fr.includes("+ New session"))
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    const sysText = () =>
      lane.entries.filter((e) => e.kind === "system").map((e) => e.text).join("\n")
    expect(sysText()).toContain("fake cannot create a session")
    expect(count(log, "session/new")).toBe(1)
    await pickNamed(setup, "cherry-random")
    await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only"))
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("do the thing")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ do the thing") && fr.includes("pong: do the thing"))
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.params.prompt as { text: string }[])[0]!.text).toBe("do the thing")
  })

  test("a session/list error renders an explicit state; + New session still binds (E19)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_LIST_ERROR: "1" } })
    const f = await untilFrame(setup, (fr) => fr.includes("could not list sessions") && fr.includes("+ New session"))
    expect(f).not.toContain("cherry-random")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    expect(count(log, "session/new")).toBe(1)
  })

  test("an empty account renders only + New session (E18)", async () => {
    const { setup, log } = await mountView({ scenario: "basic" })
    const f = await waitForPicker(setup)
    expect(f).toContain("+ New session")
    expect(f).not.toContain("fake-session-")
    await until(() => count(log, "session/list") === 1)
  })

  test("keys during the list flight select only + New session; descriptor rows appear on response (E20)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_LIST_DELAY_MS: "300" } })
    const early = await waitForPicker(setup)
    expect(early).toContain("+ New session")
    setup.mockInput.pressArrow("down")
    await tick(setup, 60)
    expect(count(log, "session/load")).toBe(0)
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    expect(count(log, "session/list")).toBe(2)
  })

  test("ctrl+o on a bound idle lane opens the sessions overlay over the entry log", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    await setup.mockInput.typeText("hi")
    setup.mockInput.pressEnter()
    // Settle first: ctrl+o during a live prompt is refused by the busy gate.
    await untilFrame(setup, (fr) => fr.includes("pong: hi") && fr.includes("end_turn"))
    setup.mockInput.pressKey("o", { ctrl: true })
    const f = await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("pong: hi"))
    expect(f).toContain("+ New session")
    expect(count(log, "session/list")).toBe(4)
    setup.mockInput.pressEscape()
    await untilFrame(setup, (fr) => !fr.includes("cherry-random"))
  })
})
