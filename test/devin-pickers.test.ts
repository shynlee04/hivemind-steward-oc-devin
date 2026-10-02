import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { frame, tick, until, untilFrame } from "./support/drive"
import { pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

async function mountView(options: FakeEngineOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-pick-"))
  dirs.push(directory)
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  await render(
    () =>
      [DevinView({
        context: test.context,
        deps: { spawnEngine: fakeEngineSpawn({ ...options, env: { FAKE_ACP_LOG: log, ...(options.env ?? {}) } }) },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test, log }
}

const wire = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string; params?: Record<string, unknown> } })
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => ({ method: f.msg!.method!, params: f.msg!.params ?? {} }))

const ready = async (setup: TestRendererSetup) => {
  await pickNew(setup)
  await untilFrame(setup, (f) => f.includes("fake-session-"))
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — live config pickers (REQ-CFG-01)", () => {
  test("ctrl+m lists options from live configOptions; a fixture change changes the rows (PROH-04)", async () => {
    const { setup } = await mountView()
    await ready(setup)
    setup.mockInput.pressKey("m", { ctrl: true })
    const f = await untilFrame(setup, (fr) => fr.includes("Adaptive") && fr.includes("Claude Opus 5.5"))
    expect(f).toContain("SWE-1.7 Lightning")

    const dir = mkdtempSync(join(tmpdir(), "devin-pick-custom-"))
    dirs.push(dir)
    const configPath = join(dir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "zeta-9",
          options: [{ value: "zeta-9", name: "Zeta-9" }, { value: "omega-1", name: "Omega-1" }],
        },
      ]),
    )
    const other = await mountView({ env: { FAKE_ACP_CONFIG: configPath } })
    await ready(other.setup)
    other.setup.mockInput.pressKey("m", { ctrl: true })
    const g = await untilFrame(other.setup, (fr) => fr.includes("Omega-1"))
    expect(g).toContain("Zeta-9")
    expect(g).not.toContain("Adaptive")
  })

  test("model select sends session/set_config_option; mode select sends session/set_mode (E5 surface)", async () => {
    const { setup, log } = await mountView()
    await ready(setup)
    setup.mockInput.pressKey("m", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Adaptive"))
    setup.mockInput.pressKey("3")
    await untilFrame(setup, (f) => f.includes("SWE-1.7 Lightning"))
    const sets = wire(log).filter((f) => f.method === "session/set_config_option")
    expect(sets).toHaveLength(1)
    expect(sets[0]!.params).toMatchObject({ configId: "model", value: "swe-1-7-lightning-medium" })
    expect(wire(log).filter((f) => f.method === "session/set_mode")).toHaveLength(0)

    setup.mockInput.pressKey("e", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Bypass Permissions"))
    setup.mockInput.pressKey("2")
    await untilFrame(setup, (f) => f.includes("Smart"))
    const modes = wire(log).filter((f) => f.method === "session/set_mode")
    expect(modes).toHaveLength(1)
    expect(modes[0]!.params).toMatchObject({ modeId: "smart" })
  })

  test("a rejected set renders a system entry and the header stays put (E5)", async () => {
    const { setup } = await mountView({ env: { FAKE_ACP_REJECT_SET: "1" } })
    await ready(setup)
    setup.mockInput.pressKey("m", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Adaptive"))
    setup.mockInput.pressKey("1")
    await untilFrame(setup, (f) => f.includes("could not set model"))
    expect(frame(setup)).not.toContain("Adaptive ·")
    expect(frame(setup)).toContain("SWE-2")
  })

  test("a picker with no live options shows unavailable and sends nothing (E3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-pick-empty-"))
    dirs.push(dir)
    const configPath = join(dir, "config.json")
    writeFileSync(configPath, JSON.stringify([{ id: "mode", name: "Mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] }]))
    const { setup, log } = await mountView({ env: { FAKE_ACP_CONFIG: configPath } })
    await ready(setup)
    setup.mockInput.pressKey("m", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("unavailable"))
    setup.mockInput.pressEnter()
    await tick(setup)
    setup.mockInput.pressEscape()
    await tick(setup)
    expect(wire(log).filter((f) => f.method.startsWith("session/set"))).toHaveLength(0)
  })

  test("escape dismisses without a set; a second escape navigates home (E4 + E11)", async () => {
    const { setup, test, log } = await mountView()
    await ready(setup)
    setup.mockInput.pressKey("t", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Medium") && f.includes("Max"))
    setup.mockInput.pressEscape()
    // `Medium` is a non-current option — it only exists as a picker row, so
    // its absence means the railed panel is gone. `Max` stays: it's the
    // current thinking level in the composer metadata.
    await untilFrame(setup, (f) => !f.includes("Medium"))
    expect(wire(log).filter((f) => f.method.startsWith("session/set"))).toHaveLength(0)
    expect(test.navigations).toHaveLength(0)
    setup.mockInput.pressEscape()
    await tick(setup)
    expect(test.navigations).toEqual([{ type: "home" }])
  })

  test("ctrl+t picks a thinking level through set_config_option and the header follows", async () => {
    const { setup, log } = await mountView()
    await ready(setup)
    setup.mockInput.pressKey("t", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Medium"))
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.split("\n")[0]!.includes("· High"))
    const sets = wire(log).filter((f) => f.method === "session/set_config_option")
    expect(sets.some((f) => f.params.configId === "thought_level" && f.params.value === "high")).toBe(true)
  })
})
