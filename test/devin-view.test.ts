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
import { editors, frame, tick, until, untilFrame } from "./support/drive"
import { pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

function logPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "devin-view-"))
  dirs.push(dir)
  return join(dir, "wire.ndjson")
}

function readLog(path: string) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } })
}

const promptFrames = (path: string) => sentMethods(path).filter((m) => m === "session/prompt")

const sentMethods = (path: string) =>
  readLog(path)
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => f.msg!.method!)

interface MountOptions extends FakeEngineOptions {
  readonly directory?: string
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string }> {
  const log = logPath()
  const directory = options.directory ?? dirs[dirs.length - 1]!
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
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
  return { setup, test, log }
}

const waitForSession = async (setup: TestRendererSetup) => {
  await pickNew(setup)
  await untilFrame(setup, (f) => f.includes("fake-session-"))
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — composer focus + send + cancel", () => {
  test("composer holds focus once a session is bound; typed characters land in it (REQ-FOCUS-01)", async () => {
    const { setup } = await mountView()
    await waitForSession(setup)
    await setup.renderOnce()
    expect(frame(setup)).toMatch(/Message.?Devin/)
    await setup.mockInput.typeText("hello")
    await setup.renderOnce()
    const editor = setup.renderer.currentFocusedEditor
    expect(editor).not.toBeNull()
    expect(editor!.plainText).toBe("hello")
    expect(frame(setup)).toContain("hello")
  })

  test("composer wraps long text — every virtual line paints inside the railed surface (E-wrap)", async () => {
    const { setup } = await mountView()
    await waitForSession(setup)
    const long =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar " +
      "papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four " +
      "five six seven eight nine ten"
    await setup.mockInput.typeText(long)
    await untilFrame(setup, (f) => f.includes("five six seven eight nine ten"))
    const f = frame(setup)
    // All three wrapped lines are visible — the pre-port box let the textarea
    // overflow its last row onto the bottom border.
    expect(f).toContain("alpha bravo charlie")
    expect(f).toContain("papa quebec romeo sierra")
    expect(f).toContain("five six seven eight nine ten")
    // Host prompt grammar: `┃` rail, `Devin · model · mode · thinking`
    // metadata, and the `╹` hook row beneath.
    const lines = f.split("\n")
    const typed = lines.find((l) => l.includes("five six seven eight nine ten"))!
    expect(typed).toContain("┃")
    expect(f).toMatch(/┃\s+Devin · SWE-2/)
    const hook = lines.findIndex((l) => l.includes("╹"))
    expect(hook).toBeGreaterThan(lines.findIndex((l) => l.includes("five six seven eight nine ten")))
    // No single-border box remains around the composer.
    expect(lines.filter((l) => l.includes("└") || l.includes("┌"))).toHaveLength(0)
  })

  test("Enter submits non-empty composer text as session/prompt and renders a ❯ entry (REQ-SEND-01)", async () => {
    const { setup, log } = await mountView()
    await waitForSession(setup)
    await setup.mockInput.typeText("  say  hi  ")
    await setup.renderOnce()
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("❯ say  hi"))
    const editor = setup.renderer.currentFocusedEditor
    expect(editor?.plainText ?? "").toBe("")
    const prompts = readLog(log).filter((f) => f.direction === "in" && f.msg?.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    const text = (prompts[0]!.msg!.params!.prompt as { text: string }[])[0]!.text
    expect(text).toBe("say  hi")
  })

  test("Enter on an empty composer emits nothing (E1)", async () => {
    const { setup, log } = await mountView()
    await waitForSession(setup)
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(sentMethods(log).filter((m) => m === "session/prompt")).toHaveLength(0)
  })

  test("Enter while a prompt is in flight emits nothing (PROH-05)", async () => {
    const { setup, log } = await mountView({ env: { FAKE_ACP_DELAY_MS: "400" } })
    await waitForSession(setup)
    await setup.mockInput.typeText("first")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("❯ first"))
    await setup.mockInput.typeText("second")
    setup.mockInput.pressEnter()
    await tick(setup, 60)
    expect(promptFrames(log)).toHaveLength(1)
  })

  test("ctrl+x emits session/cancel only while a prompt is in flight (E12, PROH-10)", async () => {
    const { setup, log } = await mountView({ env: { FAKE_ACP_DELAY_MS: "500" } })
    await waitForSession(setup)
    setup.mockInput.pressKey("x", { ctrl: true })
    await tick(setup)
    expect(sentMethods(log).filter((m) => m === "session/cancel")).toHaveLength(0)
    await setup.mockInput.typeText("work")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("❯ work"))
    setup.mockInput.pressKey("x", { ctrl: true })
    await until(() => sentMethods(log).includes("session/cancel"))
    expect(sentMethods(log).filter((m) => m === "session/cancel")).toHaveLength(1)
  })

  test("spawn failure renders a system entry naming the failure; unbound composer stays locked; + New retries the spawn (E15)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-dead-"))
    dirs.push(dir)
    const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
    setups.push(setup)
    const test = createTestContext(setup.renderer, dir)
    let spawns = 0
    await render(
      () =>
        [DevinView({
          context: test.context,
          deps: {
            spawnEngine: () => {
              spawns += 1
              return Promise.reject(new Error("spawn devin ENOENT: no such file"))
            },
          },
        }), test.dialogPortal()],
      setup.renderer,
    )
    // The spawn failure surfaces inside the reopened session dialog as the
    // list error — ENOENT is the visible witness; the auth hint stays in
    // the status line, bisected by the dialog surface.
    await untilFrame(setup, (f) => f.includes("ENOENT"))
    await setup.mockInput.typeText("keep me")
    await setup.renderOnce()
    // The unbound route is the session dialog — typed text lands in its
    // filter, never the locked composer (the dialog surface occludes the
    // composer's placeholder, so assert the editor contents directly).
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("keep me")
    const composer = editors(setup).find((e) => e !== setup.renderer.currentFocusedEditor)
    expect(composer?.plainText ?? "").toBe("")
    // The picker's own refresh already retried the spawn once — the pick must
    // drive one more spawn, so assert growth rather than a fixed count.
    const before = spawns
    await pickNew(setup)
    await until(() => spawns > before)
    await untilFrame(setup, (f) => f.includes("ENOENT"))
  })

  test("a bind whose session/new rejects keeps the lane unbound and the engine alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-n7-"))
    dirs.push(dir)
    const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
    setups.push(setup)
    const test = createTestContext(setup.renderer, dir)
    let closed = 0
    let newCalls = 0
    await render(
      () =>
        [DevinView({
          context: test.context,
          deps: {
            spawnEngine: () =>
              Promise.resolve({
                alive: true,
                newSession: () => {
                  newCalls += 1
                  return Promise.reject(new Error("handshake refused"))
                },
                loadSession: () => Promise.reject(new Error("handshake refused")),
                listSessions: () => Promise.resolve({ sessions: [] }),
                prompt: () => Promise.reject(new Error("unused")),
                cancel: () => Promise.resolve(),
                setMode: () => Promise.resolve({}),
                setConfigOption: () => Promise.resolve({}),
                close: () => {
                  closed += 1
                  return Promise.resolve()
                },
              }),
          },
        }), test.dialogPortal()],
      setup.renderer,
    )
    await untilFrame(setup, (f) => f.includes("+ New session"))
    const lane = laneFor(`${dir}:default`, { cwd: dir, spawnEngine: fakeEngineSpawn({}) })
    const sysText = () =>
      lane.entries.filter((e) => e.kind === "system").map((e) => e.text).join("\n")
    await pickNew(setup)
    // The failed pick re-offers the picker; the error lives in the lane log.
    await until(() => sysText().includes("handshake refused"))
    await untilFrame(setup, (f) => f.includes("+ New session"))
    expect(closed).toBe(0)
    await pickNew(setup)
    await until(() => newCalls === 2)
    expect(closed).toBe(0)
  })
})
