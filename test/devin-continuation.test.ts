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
import { pickNamed, pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-cont-"))
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

// Row indices: 1 = + New session; descriptors follow wire order —
// 2 repeated-plane, 3 cherry-random, 4 mango-mangosteen, 5 quiet-badger,
// 6 homeless-fern, 7 warped-sundial.
describe("Hosted Devin View — continuation render + stale-tag filter (REQ-LOAD-01, REQ-STALE-01)", () => {
  test("picking a descriptor replays the log before the load response — user chunks, resource links, plan, tool, title (REQ-LOAD-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only") && fr.includes("package.json"))
    expect(f).toContain("❯ Acknowledge the linked file by name only, one line.")
    expect(f).toContain("❯ package.json")
    expect(f).not.toContain("file:///")
    expect(f).toContain("The prompt asks for the filename only, on a single line.")
    expect(f).toContain("[x] Read the linked file name")
    expect(f).toContain("[~] Reply with the name only")
    expect(f.split("Ran ls")).toHaveLength(2)
    // The wire's status enum is not echoed — the row's icon carries state.
    expect(f).not.toContain(" completed")
    expect(f).toContain("package.json")
    expect(f).toContain("Reply with exactly the single word: ok")
    const loads = wire(log).filter((w) => w.method === "session/load")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params).toEqual({ sessionId: "cherry-random", cwd: "/Users/test/opencode-devin", mcpServers: [] })
    expect(count(log, "session/new")).toBe(0)
    expect(count(log, "initialize")).toBe(1)
  })

  test("replay-tagged updates land while the load is still in flight (pending tag accepted before the response)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_LOAD_DELAY_MS: "300" } })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    await until(() => wire(log).some((w) => w.method === "session/load"))
    const f = await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only"))
    expect(f).toContain("package.json")
  })

  test("stale-tagged updates, a stale permission, and stale commands never touch the lane; the wire answers cancelled (REQ-STALE-01, E30/E31)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => fr.includes("package.json") && fr.includes("31.5k"))
    expect(f).not.toContain("STALE ghost text")
    expect(f).not.toContain("ghost-9")
    expect(f).not.toContain("Stale tool call")
    expect(f).not.toContain("999.9k")
    expect(f).not.toContain("mystery_future")
    await until(() => permissionAnswers(log, "srv-perm-stale").length === 1)
    expect(permissionAnswers(log, "srv-perm-stale")[0]).toEqual({ outcome: "cancelled" })
    setup.mockInput.pressKey("g", { ctrl: true })
    const commands = await untilFrame(setup, (fr) => fr.includes("/login") && fr.includes("/status") && fr.includes("/plan"))
    expect(commands).not.toContain("ghost-slash")
    setup.mockInput.pressEscape()
    await tick(setup)
    setup.mockInput.pressKey("m", { ctrl: true })
    const picker = await untilFrame(setup, (fr) => fr.includes("Adaptive"))
    expect(picker).not.toContain("ghost")
  })

  test("empty session_info_update title keeps the sessionId in the header (E45)", async () => {
    const { setup } = await mountView({ scenario: "sessions" })
    await untilFrame(setup, (fr) => fr.includes("quiet-badger"))
    await pickNamed(setup, "quiet-badger")
    const f = await untilFrame(setup, (fr) => fr.includes("package.json") && (fr.split("\n")[0]?.includes("quiet-badger") ?? false))
    expect(f.split("\n")[0]).toContain("quiet-badger")
    expect(f).toContain("❯ Acknowledge the linked file by name only, one line.")
  })

  test("replaced-tag traffic mid-load never touches the rebuilt log; its permission is answered cancelled (REQ-STALE-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_STALE_REPLACED: "1" } })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    setup.mockInput.pressKey("o", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only") && fr.includes("31.5k"))
    expect(f).not.toContain("STALE replaced tail")
    expect(f).not.toContain("Replaced session tool call")
    await until(() => permissionAnswers(log, "srv-perm-replaced").length === 1)
    expect(permissionAnswers(log, "srv-perm-replaced")[0]).toEqual({ outcome: "cancelled" })
  })

  test("a pending-tag permission arriving mid-load renders its card over the picker and answers on a digit (REQ-PERM-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_LOAD_PERM: "1", FAKE_ACP_LOAD_DELAY_MS: "400" } })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    const f = await untilFrame(setup, (fr) => fr.includes("Permission required") && fr.includes("Allow once"))
    expect(f).toContain("Mid-load tool call")
    expect(f).toContain("Allow once")
    setup.mockInput.pressKey("1")
    await until(() => permissionAnswers(log, "srv-perm-load").length === 1)
    expect(permissionAnswers(log, "srv-perm-load")[0]).toEqual({ outcome: "selected", optionId: "perm-allow-once" })
    await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only"))
  })

  test("a second bind while a load is in flight is ignored — one session/load total (E27)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions", env: { FAKE_ACP_LOAD_DELAY_MS: "300" } })
    await untilFrame(setup, (fr) => fr.includes("cherry-random"))
    await pickNamed(setup, "cherry-random")
    setup.mockInput.pressKey("4")
    setup.mockInput.pressKey("2")
    await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file by name only"))
    await tick(setup, 350)
    const loads = wire(log).filter((w) => w.method === "session/load")
    expect(loads).toHaveLength(1)
    expect(loads[0]!.params.sessionId).toBe("cherry-random")
    expect(count(log, "initialize")).toBe(1)
  })
})
