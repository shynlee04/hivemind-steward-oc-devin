import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { tick, until, untilFrame } from "./support/drive"
import { pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly directory: string
  readonly log: string
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions): Promise<{ setup: TestRendererSetup; test: TestContext }> {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, options.directory)
  await render(
    () =>
      [DevinView({
        context: test.context,
        initialPrompt: options.initialPrompt,
        deps: { spawnEngine: fakeEngineSpawn({ ...options, env: { FAKE_ACP_LOG: options.log, ...(options.env ?? {}) } }) },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test }
}

const tempHome = () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-resume-"))
  dirs.push(directory)
  return { directory, log: join(directory, "wire.ndjson") }
}

const wire = (log: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } })
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => ({ method: f.msg!.method!, params: f.msg!.params ?? {} }))

const permissionAnswers = (log: string, id: string) =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { id?: number | string; result?: { outcome?: unknown } } })
    .filter((f) => f.direction === "in" && f.msg?.id === id)
    .map((f) => f.msg!.result!.outcome as { outcome: string; optionId?: string })

const sessionOf = (f: string) => f.match(/devin session (\S+)/)?.[1] ?? f.split("\n")[0]!.match(/Devin (\S+)/)?.[1] ?? ""

const boundIds = (log: string): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { result?: { sessionId?: string } } })
    .filter((f) => f.direction === "out" && typeof f.msg?.result?.sessionId === "string")
    .map((f) => f.msg!.result!.sessionId!)

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — lane resume, slash argument, resilience", () => {
  test("esc then re-entry keeps one session/new, the same sessionId, and the prior entries (REQ-RESUME-01, E8)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log })
    await pickNew(first.setup)
    const boundFrame = await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    const sessionId = sessionOf(boundFrame)
    expect(sessionId).toContain("fake-session-")
    await first.setup.mockInput.typeText("hi")
    first.setup.mockInput.pressEnter()
    await untilFrame(first.setup, (f) => f.includes("pong: hi"))

    first.setup.mockInput.pressEscape()
    await tick(first.setup)
    expect(first.test.navigations).toEqual([{ type: "home" }])
    first.setup.renderer.destroy()

    const second = await mountView({ directory, log })
    const f = await untilFrame(second.setup, (fr) => fr.includes("❯ hi") && fr.includes("pong: hi"))
    expect(f).toContain("Devin hi")
    expect(boundIds(log)).toEqual([sessionId])
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.params.sessionId).toBe(sessionId)
    expect(wire(log).filter((w) => w.method === "session/new")).toHaveLength(1)
  })

  test("a prompt in flight across unmount lands its stream on the lane for the next mount (REQ-RESUME-01)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log, env: { FAKE_ACP_DELAY_MS: "400" } })
    await pickNew(first.setup)
    await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    await first.setup.mockInput.typeText("slow")
    first.setup.mockInput.pressEnter()
    await untilFrame(first.setup, (f) => f.includes("❯ slow"))
    first.setup.renderer.destroy()

    const second = await mountView({ directory, log })
    const f = await untilFrame(second.setup, (fr) => fr.includes("pong: slow"))
    expect(f).toContain("❯ slow")
  })

  test("/devin <task> auto-submits once the lane is ready (REQ-ARG-01)", async () => {
    const { directory, log } = tempHome()
    const { setup } = await mountView({ directory, log, initialPrompt: "do the thing" })
    const f = await untilFrame(setup, (fr) => fr.includes("❯ do the thing") && fr.includes("pong: do the thing"))
    expect(setup.renderer.currentFocusedEditor?.plainText ?? "").toBe("")
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.params.prompt as { text: string }[])[0]!.text).toBe("do the thing")
  })

  test("/devin <task> while busy leaves the task in the composer with a system notice (E14)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log, env: { FAKE_ACP_DELAY_MS: "600" } })
    await pickNew(first.setup)
    await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    await first.setup.mockInput.typeText("first")
    first.setup.mockInput.pressEnter()
    await untilFrame(first.setup, (f) => f.includes("❯ first"))

    const second = await mountView({ directory, log, initialPrompt: "queued task", env: { FAKE_ACP_DELAY_MS: "600" } })
    const f = await untilFrame(second.setup, (fr) => fr.includes("busy") || fr.includes("left in composer"))
    expect(f).toMatch(/busy|composer/)
    expect(second.setup.renderer.currentFocusedEditor?.plainText).toBe("queued task")
    await tick(second.setup, 40)
    expect(wire(log).filter((w) => w.method === "session/prompt")).toHaveLength(1)
  })

  test("a dead lane respawns unbound on the next submit; re-picking binds the fresh engine (REQ-RESIL-01, E9)", async () => {
    const { directory, log } = tempHome()
    const { setup } = await mountView({ directory, log, scenario: "crash-once" })
    await pickNew(setup)
    await untilFrame(setup, (f) => f.includes("fake-session-"))
    await until(() => boundIds(log).length === 1)
    const firstSession = boundIds(log)[0]!
    await setup.mockInput.typeText("die")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("dying…") || /error|died|exited/.test(f))
    await until(() => setup.renderer.currentFocusedEditor?.plainText === "die")

    setup.mockInput.pressEnter()
    await until(() => wire(log).filter((w) => w.method === "initialize").length === 2)
    await untilFrame(setup, (f) => f.includes("+ New session"))
    await pickNew(setup)
    await untilFrame(setup, (f) => f.includes("fake-session-"))
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("pong: die"))
    const secondSession = boundIds(log)[1]!
    expect(secondSession).toContain("fake-session-")
    expect(secondSession).not.toBe(firstSession)
    const methods = wire(log).map((w) => w.method)
    expect(methods.filter((m) => m === "initialize")).toHaveLength(2)
    expect(methods.filter((m) => m === "session/new")).toHaveLength(2)
    expect(methods.filter((m) => m === "session/prompt")).toHaveLength(2)
  })

  test("post-remount prompt streams to the live mount — events never bind a dead view (REQ-RESUME-01)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log })
    await pickNew(first.setup)
    await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    first.setup.mockInput.pressEscape()
    await tick(first.setup)
    first.setup.renderer.destroy()

    const second = await mountView({ directory, log })
    await untilFrame(second.setup, (f) => f.includes("fake-session-"))
    await second.setup.mockInput.typeText("two")
    second.setup.mockInput.pressEnter()
    const f = await untilFrame(second.setup, (fr) => fr.includes("❯ two") && fr.includes("pong: two"))
    expect(f).toContain("Devin two")
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.params.sessionId).toBe(boundIds(log)[0])
    expect(wire(log).filter((w) => w.method === "session/new")).toHaveLength(1)
  })

  test("a permission orphaned by process death resolves silently; the respawned lane re-binds cleanly (REQ-RESIL-01, REQ-PERM-01)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log, scenario: "permission-crash" })
    await pickNew(first.setup)
    await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    await first.setup.mockInput.typeText("die")
    first.setup.mockInput.pressEnter()
    await untilFrame(first.setup, (f) => f.includes("Allow once") && f.includes("Permission required"))
    await untilFrame(first.setup, (f) => /exited|died/.test(f))
    first.setup.renderer.destroy()

    const second = await mountView({ directory, log, scenario: "permission-crash" })
    const f = await untilFrame(second.setup, (fr) => fr.includes("+ New session"))
    expect(f).not.toContain("Allow once")
    expect(permissionAnswers(log, "srv-perm-1")).toHaveLength(0)

    await pickNew(second.setup)
    await untilFrame(second.setup, (fr) => fr.includes("fake-session-"))
    await second.setup.mockInput.typeText("again")
    second.setup.mockInput.pressEnter()
    await untilFrame(second.setup, (fr) => fr.includes("Allow once") && fr.includes("Permission required"))
    second.setup.mockInput.pressKey("1")
    await untilFrame(second.setup, (fr) => fr.includes("Permission answered, continuing.") && fr.includes("Done."))
    expect(permissionAnswers(log, "srv-perm-1")).toEqual([{ outcome: "selected", optionId: "perm-allow-once" }])
    expect(wire(log).filter((w) => w.method === "session/prompt")).toHaveLength(2)
  })

  test("permission requested while unmounted re-renders on re-entry and stays answerable (REQ-PERM-01, REQ-RESUME-01)", async () => {
    const { directory, log } = tempHome()
    const first = await mountView({ directory, log, scenario: "permission" })
    await pickNew(first.setup)
    await untilFrame(first.setup, (f) => f.includes("fake-session-"))
    await first.setup.mockInput.typeText("do it")
    first.setup.mockInput.pressEnter()
    await untilFrame(first.setup, (f) => f.includes("Allow once"))
    first.setup.renderer.destroy()

    const second = await mountView({ directory, log })
    const f = await untilFrame(second.setup, (fr) => fr.includes("permission") && fr.includes("Allow once"))
    expect(f).toContain("Delete node_modules")
    second.setup.mockInput.pressKey("1")
    await until(() => permissionAnswers(log, "srv-perm-1").length === 1)
    expect(permissionAnswers(log, "srv-perm-1")[0]).toEqual({ outcome: "selected", optionId: "perm-allow-once" })
  })
})
