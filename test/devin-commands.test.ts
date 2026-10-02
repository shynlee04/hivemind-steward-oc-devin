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
  const directory = mkdtempSync(join(tmpdir(), "devin-cmd-"))
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

interface WireCommand {
  readonly name: string
  readonly description?: string
  readonly input?: { readonly hint?: string }
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

// The commands the fake last emitted under `tag` — the assertion source for
// the overlay (fixture-diff: the expected rows are read off the wire, never
// hardcoded in the test).
const emittedCommands = (path: string, tag: string): WireCommand[] => {
  let latest: WireCommand[] = []
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const frame = JSON.parse(line) as {
      direction: string
      msg?: { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; availableCommands?: WireCommand[] } } }
    }
    if (
      frame.direction === "out" &&
      frame.msg?.method === "session/update" &&
      frame.msg.params?.sessionId === tag &&
      frame.msg.params.update?.sessionUpdate === "available_commands_update" &&
      Array.isArray(frame.msg.params.update.availableCommands)
    ) {
      latest = frame.msg.params.update.availableCommands
    }
  }
  return latest
}

const editorText = (setup: TestRendererSetup): string => setup.renderer.currentFocusedEditor?.plainText ?? ""

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const bindCherry = async (setup: TestRendererSetup) => {
  await untilFrame(setup, (fr) => fr.includes("cherry-random"))
  await pickNamed(setup, "cherry-random")
  await untilFrame(setup, (fr) => fr.includes("❯ Acknowledge the linked file") && fr.includes("31.5k"))
}

describe("Hosted Devin View — available commands overlay (REQ-CMD-01)", () => {
  test("ctrl+g on a bound lane lists the emitted commands — name, description, input.hint — and drops the stale emission", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await bindCherry(setup)
    const emitted = emittedCommands(log, "cherry-random")
    expect(emitted.length).toBeGreaterThan(0)

    setup.mockInput.pressKey("g", { ctrl: true })
    const f = await untilFrame(setup, (fr) => fr.includes("/plan"))
    // Host autocomplete grammar: railed rows `┃ /name desc` — one per
    // emitted command, no numbered markers.
    const rows = f.split("\n").filter((l) => l.includes("┃") && l.includes("/"))
    expect(rows).toHaveLength(emitted.length)
    for (const command of emitted) {
      expect(f).toContain(`/${command.name}`)
      if (command.description) expect(f).toContain(command.description)
      if (command.input?.hint) expect(f).toContain(command.input.hint)
    }
    // The stale ghost-tag emission mid-replay never reaches the list (E30).
    expect(f).not.toContain("ghost-slash")
  })

  test("choosing a row inserts /<name> into the composer unsubmitted with focus back; esc dismisses", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await bindCherry(setup)

    setup.mockInput.pressKey("g", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("/login"))
    setup.mockInput.pressEscape()
    const dismissed = await untilFrame(setup, (fr) => !fr.includes("/login"))
    expect(dismissed).not.toContain("/status —")
    expect(editorText(setup)).toBe("")

    setup.mockInput.pressKey("g", { ctrl: true })
    await untilFrame(setup, (fr) => fr.includes("/status"))
    // Emitted order: 1 login, 2 status, 3 plan — the digit accelerator picks
    // the second row without a visible marker (host grammar shows none).
    setup.mockInput.pressKey("2")
    await untilFrame(setup, (fr) => !fr.includes("/login"))
    await until(() => editorText(setup) === "/status ")
    expect(count(log, "session/prompt")).toBe(0)
    expect(setup.renderer.currentFocusedEditor).not.toBeNull()
  })

  test("/plan do X + Enter sends an ordinary session/prompt with that exact text — no dedicated wire method (REQ-CMD-01)", async () => {
    const { setup, log } = await mountView({ scenario: "sessions" })
    await bindCherry(setup)
    await setup.mockInput.typeText("/plan do X")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ /plan do X"))
    const prompts = wire(log).filter((w) => w.method === "session/prompt")
    expect(prompts).toHaveLength(1)
    const blocks = prompts[0]!.params.prompt as { type: string; text?: string }[]
    expect(blocks[0]).toEqual({ type: "text", text: "/plan do X" })
    const methods = new Set(wire(log).map((w) => w.method))
    for (const m of methods) {
      expect(["initialize", "session/list", "session/load", "session/prompt"]).toContain(m)
    }
  })

  test("/ typed in the composer is ordinary text — no overlay opens (E37)", async () => {
    const { setup } = await mountView({ scenario: "sessions" })
    await bindCherry(setup)
    await setup.mockInput.typeText("/")
    await tick(setup, 80)
    expect(editorText(setup)).toBe("/")
    const f = await untilFrame(setup, (fr) => fr.includes("fake-session-") || fr.includes("cherry-random"))
    expect(f).not.toContain("/login")
    expect(f).not.toContain("/status —")
  })

  test("ctrl+g before any available_commands_update renders an explicit empty state (E38)", async () => {
    const { setup } = await mountView({ scenario: "basic" })
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    setup.mockInput.pressKey("g", { ctrl: true })
    const f = await untilFrame(setup, (fr) => /no commands/i.test(fr))
    expect(f).not.toContain("/login")
    setup.mockInput.pressEscape()
    await untilFrame(setup, (fr) => !/no commands/i.test(fr))
  })
})
