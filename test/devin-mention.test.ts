import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { tick, until, untilFrame } from "./support/drive"
import { pickNamed, pickNew } from "./support/picker"
import type { SpawnEngine } from "../src/lane"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
  readonly spawnEngine?: SpawnEngine
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-mention-"))
  dirs.push(directory)
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  const spawnEngine =
    options.spawnEngine ??
    fakeEngineSpawn({ ...options, env: { FAKE_ACP_LOG: log, ...(options.env ?? {}) } })
  await render(
    () =>
      [DevinView({
        context: test.context,
        initialPrompt: options.initialPrompt,
        deps: { spawnEngine },
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

const promptBlocks = (path: string): Record<string, unknown>[][] =>
  wire(path)
    .filter((w) => w.method === "session/prompt")
    .map((w) => (w.params.prompt ?? []) as Record<string, unknown>[])

const editorText = (setup: TestRendererSetup): string => setup.renderer.currentFocusedEditor?.plainText ?? ""

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const seedProject = (directory: string) => {
  writeFileSync(join(directory, "linked-file.md"), "# linked\n")
  writeFileSync(join(directory, "real-file.md"), "real\n")
  mkdirSync(join(directory, "sub"), { recursive: true })
  writeFileSync(join(directory, "sub", "inner.txt"), "inner\n")
  mkdirSync(join(directory, "node_modules"), { recursive: true })
  writeFileSync(join(directory, "node_modules", "junk.js"), "junk\n")
  mkdirSync(join(directory, ".git"), { recursive: true })
  writeFileSync(join(directory, ".git", "config"), "gitdir\n")
}

const bindLane = async (setup: TestRendererSetup, log: string) => {
  await pickNew(setup)
  await untilFrame(setup, (fr) => fr.includes("fake-session-"))
  await until(() => wire(log).some((w) => w.method === "session/new"))
}

describe("Hosted Devin View — file mentions (REQ-FILE-01)", () => {
  test("@ completion offers wire commands alongside files — pick inserts /<name> (REQ-ATSKILL-01)", async () => {
    const { setup, directory } = await mountView({ scenario: "sessions" })
    seedProject(directory)
    await pickNamed(setup, "quiet-badger")
    await untilFrame(setup, (fr) => fr.includes("quiet-badger") && fr.includes("ready"))

    await setup.mockInput.typeText("@sta")
    // The wire's /status command rides the @ panel with its description.
    await untilFrame(setup, (fr) => fr.includes("/status") && fr.includes("Check authentication status"))
    setup.mockInput.pressEnter()
    await until(() => editorText(setup) === "/status ")
  })

  test("digits type into the composer while the @ panel is open — no option hijack", async () => {
    const { setup, directory } = await mountView({ scenario: "sessions" })
    seedProject(directory)
    await pickNamed(setup, "quiet-badger")
    await untilFrame(setup, (fr) => fr.includes("quiet-badger") && fr.includes("ready"))
    // With the panel open on a matching row, `2` is filename text — never an
    // option index. Before the scoping fix the keymap swallowed the digit.
    await setup.mockInput.typeText("@real-file.md2")
    await until(() => editorText(setup) === "@real-file.md2")
    expect(editorText(setup)).toBe("@real-file.md2")
  })
  test("@linked-file.md submits a resource_link block after the text block; the sent entry shows the name", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("@linked-file.md hi")
    setup.mockInput.pressEnter()
    const f = await untilFrame(setup, (fr) => fr.includes("❯ @linked-file.md hi") && fr.includes("pong:"))
    expect(f).toContain("[linked-file.md]")
    const blocks = promptBlocks(log)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]![0]).toEqual({ type: "text", text: "@linked-file.md hi" })
    const link = blocks[0]!.find((b) => b.type === "resource_link")
    expect(link?.type).toBe("resource_link")
    expect(link?.uri).toBe(`file://${realpathSync(join(directory, "linked-file.md"))}`)
    expect(link?.name).toBe("linked-file.md")
    expect(typeof link?.mimeType === "string" || link?.mimeType === undefined).toBe(true)
  })

  test("two mentions send one resource_link block per mention, in mention order (E35)", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("diff @real-file.md and @sub/inner.txt now")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ diff @real-file.md") && fr.includes("[inner.txt]"))
    const blocks = promptBlocks(log)[0]!
    expect(blocks.map((b) => b.type)).toEqual(["text", "resource_link", "resource_link"])
    expect(blocks[0]).toEqual({ type: "text", text: "diff @real-file.md and @sub/inner.txt now" })
    expect(blocks[1]?.uri).toBe(`file://${realpathSync(join(directory, "real-file.md"))}`)
    expect(blocks[1]?.name).toBe("real-file.md")
    expect(blocks[2]?.uri).toBe(`file://${realpathSync(join(directory, "sub", "inner.txt"))}`)
    expect(blocks[2]?.name).toBe("inner.txt")
  })

  test("@ghost.txt resolves to nothing — literal text, no block, no error (E34)", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("@ghost.txt hi")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ @ghost.txt hi"))
    const blocks = promptBlocks(log)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual([{ type: "text", text: "@ghost.txt hi" }])
  })

  test("user@host never opens completion and sends literal (E34)", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("ping user@host now")
    await tick(setup, 80)
    const f = await untilFrame(setup, (fr) => fr.includes("fake-session-"))
    expect(f).not.toContain("real-file.md")
    expect(f).not.toContain("sub/inner.txt")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ ping user@host now"))
    expect(promptBlocks(log)[0]).toEqual([{ type: "text", text: "ping user@host now" }])
  })

  test("a token resolving outside the lane cwd stays literal (E33)", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("see @/etc/hostname end")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ see @/etc/hostname end"))
    expect(promptBlocks(log)[0]).toEqual([{ type: "text", text: "see @/etc/hostname end" }])
  })

  test("@ opens live completion — digits/arrows insert the project-relative path, dirs drill down, junk dirs excluded", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("link @")
    const open = await untilFrame(setup, (fr) => fr.includes("real-file.md") && fr.includes("sub/"))
    expect(open).not.toContain("junk.js")
    expect(open).not.toContain("git/config")
    // The walk lists cwd-relative paths shallow-first — arrows pick sub/,
    // which keeps the token open for drill-down into its contents.
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    const drilled = await untilFrame(setup, (fr) => fr.includes("sub/inner.txt"))
    expect(drilled).toContain("sub/inner.txt")
    // Rows pick on ↑/↓ + ⏎ — digits stay filename text while the panel is
    // open (they belong to overlays that number options, not the mention).
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    await tick(setup, 60)
    expect(editorText(setup)).toBe("link @sub/inner.txt ")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ link @sub/inner.txt"))
    const link = promptBlocks(log)[0]!.find((b) => b.type === "resource_link")
    expect(link?.uri).toBe(`file://${realpathSync(join(directory, "sub", "inner.txt"))}`)
    expect(link?.name).toBe("inner.txt")
  })

  test("esc dismisses the completion with text intact and the token stays literal on submit", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("look @real")
    await untilFrame(setup, (fr) => fr.includes("real-file.md"))
    setup.mockInput.pressEscape()
    const closed = await untilFrame(setup, (fr) => !fr.includes("1..9 insert"))
    expect(closed).not.toContain("real-file.md")
    expect(editorText(setup)).toBe("look @real")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ look @real"))
    expect(promptBlocks(log)[0]).toEqual([{ type: "text", text: "look @real" }])
  })

  test("a directory mention resolves to a resource_link (E36)", async () => {
    const { setup, log, directory } = await mountView()
    seedProject(directory)
    await bindLane(setup, log)
    await setup.mockInput.typeText("check @sub/ please")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("❯ check @sub/ please"))
    const link = promptBlocks(log)[0]!.find((b) => b.type === "resource_link")
    expect(link?.uri).toBe(`file://${realpathSync(join(directory, "sub"))}`)
    expect(link?.name).toBe("sub")
  })

  test("a failed submit restores the composer text verbatim, @ token included (PROH-09)", async () => {
    const { setup, directory } = await mountView({
      spawnEngine: () =>
        Promise.resolve({
          alive: true,
          newSession: () => Promise.resolve({ sessionId: "stub-bound" }),
          loadSession: () => Promise.reject(new Error("unused")),
          listSessions: () => Promise.resolve({ sessions: [] }),
          prompt: () => Promise.reject(new Error("fake rejects the prompt")),
          cancel: () => Promise.resolve(),
          setMode: () => Promise.resolve({}),
          setConfigOption: () => Promise.resolve({}),
          close: () => Promise.resolve(),
        }),
    })
    seedProject(directory)
    await pickNew(setup)
    await untilFrame(setup, (fr) => fr.includes("stub-bound"))
    await setup.mockInput.typeText("@real-file.md hi")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (fr) => fr.includes("fake rejects the prompt"))
    expect(editorText(setup)).toBe("@real-file.md hi")
  })
})
