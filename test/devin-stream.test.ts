import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { TextAttributes } from "@opentui/core"
import { DevinView } from "../tui"
import type { DevinAcpEvents, PromptOutcome, SessionUpdate } from "../src/acp"
import type { SpawnEngine } from "../src/lane"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { editors, frame, tick, until, untilFrame } from "./support/drive"
import { pickNew, pickNamed } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "devin-stream-"))
  dirs.push(dir)
  return dir
}

interface MountOptions extends FakeEngineOptions {
  readonly initialPrompt?: string
  readonly height?: number
  readonly copyText?: (text: string) => Promise<void>
  readonly spawnEngine?: SpawnEngine
}

async function mountView(options: MountOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext; log: string }> {
  const directory = tempDir()
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 100, height: options.height ?? 30, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  const { copyText, ...engine } = options
  await render(
    () =>
      [DevinView({
        context: test.context,
        initialPrompt: options.initialPrompt,
        deps: {
          spawnEngine:
            options.spawnEngine ?? fakeEngineSpawn({ ...engine, env: { FAKE_ACP_LOG: log, ...(engine.env ?? {}) } }),
          copyText,
        },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test, log }
}

const sentMethods = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { method?: string } })
    .filter((f) => f.direction === "in" && f.msg?.method)
    .map((f) => f.msg!.method!)

const waitForSession = async (setup: TestRendererSetup) => {
  await pickNew(setup)
  await untilFrame(setup, (f) => f.includes("fake-session-") || f.includes("opposite-ellipse"))
}

const spanFg = (setup: TestRendererSetup, needle: string): string | undefined => {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return String(span.fg)
    }
  }
  return undefined
}

const spanBg = (setup: TestRendererSetup, needle: string): string | undefined => {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return String(span.bg)
    }
  }
  return undefined
}

const spanAttrs = (setup: TestRendererSetup, needle: string): number => {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.attributes
    }
  }
  return 0
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — stream rendering (REQ-STREAM-01)", () => {
  test("agent chunks coalesce, thought header sits in the warning tier, tool card is bordered, plan/usage/mode land", async () => {
    const { setup, test } = await mountView()
    await waitForSession(setup)
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    const f = await untilFrame(setup, (fr) => fr.includes("pong: hello") && fr.includes("1.2k/262.0k"))

    const pongLines = f.split("\n").filter((l) => l.includes("pong"))
    expect(pongLines).toHaveLength(1)
    expect(pongLines[0]).toContain("pong: hello")

    expect(f).toContain("[x] Understand the request")
    expect(f).toContain("[~] Run the work")
    expect(f).toContain("[ ] Report back")

    expect(f.split("Ran echo")).toHaveLength(2)
    expect(f).toMatch(/▸ \$ Ran echo/)
    // Host InlineTool conveys state through the icon — the wire's status enum
    // is not echoed as a trailing word.
    expect(f).not.toContain(" completed")
    // Tool detail is collapsed by default (REQ-TOOL-01) — "echo hello" is the
    // command detail and stays hidden until the row is expanded by click.
    expect(f).not.toContain("echo hello")
    expect(f).toContain("▸")

    await setup.renderOnce()
    // Host ReasoningHeader: the collapsed `+ Thought:` line (summary title
    // inline) sits in the warning tier — muted/dimmed only when expanded.
    const thoughtFg = spanFg(setup, "Thinking about the request")
    const warnFg = String(test.context.theme.text.feedback.warning.base)
    const agentFg = spanFg(setup, "pong: hello")
    const mutedFg = spanFg(setup, "send")
    expect(thoughtFg).toBeDefined()
    expect(agentFg).toBeDefined()
    expect(thoughtFg).toBe(warnFg)
    expect(thoughtFg).not.toBe(agentFg)
    expect(thoughtFg).not.toBe(mutedFg)
  })

  test("typography hierarchy — user block raised+edged, turn meta, + Tokens line, collapsible thought (REQ-TYPE-01)", async () => {
    const { setup, test } = await mountView()
    await waitForSession(setup)
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    const f = await untilFrame(
      setup,
      (fr) => fr.includes("tok/s") && fr.includes("+ Tokens") && fr.includes("pong: hello"),
    )

    // Turn meta — accent agent name + muted model/duration/tok/s segments
    // (host grammar: `Build · GPT-6.1 Sol · 23.0s · 16.7 tok/s`).
    expect(f).toMatch(/Devin · SWE-2 · \d+(\.\d+)?s · [\d.]+ tok\/s/)

    // usage_update _meta → the collapsed `+ Tokens:` line with wire counts.
    expect(f).toMatch(/\+ Tokens:.*1,100 in · 134 out/)

    // User message — raised block with the thick left accent edge.
    const userLine = f.split("\n").find((l) => l.includes("❯ hello"))
    expect(userLine).toMatch(/┃/)
    await setup.renderOnce()
    const raisedBg = String(test.context.theme.background.raised.base)
    expect(spanBg(setup, "❯ hello")).toBe(raisedBg)
    expect(spanBg(setup, "pong: hello")).not.toBe(raisedBg)

    // Thought — host minimal grammar: `+ Thought: <title>` collapses to one
    // line; clicking the header expands the full muted reasoning body and
    // flips the chevron.
    const thoughtLine = f.split("\n").find((l) => l.includes("Thinking about the request"))
    expect(thoughtLine).toContain("+ Thought:")
    const thoughtY = f.split("\n").findIndex((l) => l.includes("+ Thought:"))
    await setup.mockMouse.click(6, thoughtY)
    const expanded = await untilFrame(setup, (fr) => fr.includes("- Thought:"))
    expect(
      expanded.split("\n").filter((l) => l.includes("Thinking about the request")).length,
    ).toBeGreaterThanOrEqual(2)
    // The expanded body adds rows below and the scrollbox stays pinned to the
    // bottom — the header's screen row moved; recompute before the re-click.
    const collapseY = expanded.split("\n").findIndex((l) => l.includes("- Thought:"))
    await setup.mockMouse.click(10, collapseY)
    await untilFrame(setup, (fr) => fr.includes("+ Thought:") && !fr.includes("- Thought:"))
  })

  test("bottom dock — composer down opens tabs, arrows cycle, esc returns (REQ-DOCK-01)", async () => {
    const { setup } = await mountView({ scenario: "sessions" })
    await pickNamed(setup, "quiet-badger")
    await untilFrame(setup, (fr) => fr.includes("ready — devin session"))

    // Closed dock leaves no tab strip in the frame; the bound lane advertises
    // the clickable hint (the Show gate must read the sessionId signal — a
    // lane.alive getter read first would freeze it hidden).
    expect(frame(setup)).not.toContain("Subagents")
    expect(frame(setup)).toContain("↓ dock")

    // Composer `down` on the last line docks into the tabbed panel.
    setup.mockInput.pressArrow("down")
    const f0 = await untilFrame(setup, (fr) => fr.includes("Subagents") && fr.includes("Commands") && fr.includes("Log"))
    expect(f0).toContain("esc")
    expect(f0).toContain("No subagents")

    // → cycles to Commands — real availableCommands rows render.
    setup.mockInput.pressArrow("right")
    const f1 = await untilFrame(setup, (fr) => fr.includes("login") && fr.includes("Authenticate"))
    expect(f1).toContain("plan")

    // → again lands on Log — the stream tail renders the replayed session.
    setup.mockInput.pressArrow("right")
    await untilFrame(setup, (fr) => {
      const lines = fr.split("\n")
      const tabLine = lines.findIndex((l) => l.includes("Subagents") && l.includes("Commands"))
      const below = lines.slice(tabLine).join("\n")
      return below.includes("package.json") || below.includes("Ran ls")
    })

    // tab cycles back around to Subagents.
    setup.mockInput.pressTab()
    await untilFrame(setup, (fr) => fr.includes("No subagents"))

    // esc returns to the composer — the dock closes; the `tabs ←/→` hint chip
    // exists only while the dock is open.
    setup.mockInput.pressEscape()
    await untilFrame(setup, (fr) => !fr.includes("tabs ←/→"))
  })

  test("subagent row click filters the entry log to that agent — esc clears (REQ-SUBAGENT-01)", async () => {
    const { setup } = await mountView({ scenario: "sessions", env: { FAKE_ACP_SUBAGENTS: "1" } })
    await pickNamed(setup, "quiet-badger")
    await untilFrame(setup, (fr) => fr.includes("quiet-badger") && fr.includes("ready"))
    await untilFrame(setup, (fr) => fr.includes("subagent note"))

    // Open the dock — the Subagents tab lists the wire-tracked agent.
    setup.mockInput.pressArrow("down")
    const d = await untilFrame(setup, (fr) => fr.includes("Subagents") && fr.includes("Scout the repo"))

    // Clicking the row filters the log to that agent's authored entries.
    const row = d.split("\n").findIndex((l) => l.includes("Scout the repo"))
    await setup.mockMouse.click(4, row)
    const filtered = await untilFrame(setup, (fr) => fr.includes("filtered to Scout the repo"))
    expect(filtered).toContain("subagent note")
    expect(filtered).not.toContain("Acknowledge the linked file")
    expect(filtered).not.toContain("+ Thought:")

    // esc clears the filter — the full log returns.
    setup.mockInput.pressEscape()
    await untilFrame(setup, (fr) => fr.includes("Acknowledge the linked file") && !fr.includes("filtered to"))
  })

  test("dock tabs and rows are mouse-clickable (REQ-DOCK-01)", async () => {
    const { setup } = await mountView({ scenario: "sessions" })
    await pickNamed(setup, "quiet-badger")
    await untilFrame(setup, (fr) => fr.includes("ready — devin session"))
    setup.mockInput.pressArrow("down")
    const f = await untilFrame(setup, (fr) => fr.includes("Commands") && fr.includes("Subagents"))

    // Click the Commands tab label — its rows appear without arrow keys.
    const tabLine = f.split("\n").findIndex((l) => l.includes("Subagents") && l.includes("Commands"))
    const cx = f.split("\n")[tabLine]!.indexOf("Commands") + 1
    await setup.mockMouse.click(cx, tabLine)
    const f1 = await untilFrame(setup, (fr) => fr.includes("login"))

    // Click the "login" row — the command drops into the composer.
    const loginLine = f1.split("\n").findIndex((l) => l.includes("/login"))
    const lx = f1.split("\n")[loginLine]!.indexOf("login") + 1
    await setup.mockMouse.click(lx, loginLine)
    await untilFrame(setup, (fr) => !fr.includes("tabs ←/→") && fr.includes("/login"))
  })

  test("tool detail expands inside a bordered box with syntax styling (REQ-BOXED-01)", async () => {
    const { setup } = await mountView()
    await waitForSession(setup)
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    const f0 = await untilFrame(setup, (fr) => fr.includes("Ran echo") && fr.includes("pong: hello"))

    // The collapsed row is an inline header — no card border around it.
    const header0 = f0.split("\n").find((l) => l.includes("Ran echo"))
    expect(header0).toMatch(/▸ \$ Ran echo/)
    expect(header0).not.toMatch(/[│┃]/)

    const y = f0.split("\n").findIndex((l) => l.includes("Ran echo"))
    const x = f0.split("\n")[y]!.indexOf("Ran echo")
    await setup.mockMouse.click(x, y)
    const f1 = await untilFrame(setup, (fr) => fr.includes("echo hello") && fr.includes("▾"))
    const lines1 = f1.split("\n")
    const detail = lines1.find((l) => l.includes("echo hello"))
    // Expanded detail sits inside a single-bordered box.
    expect(detail).toMatch(/│/)
    expect(f1).toMatch(/[┌└]/)
  })

  // A hand-driven engine: prompt() stays in flight so updates can be pushed
  // one at a time while the lane is busy — the S1 convergence tests need a
  // merge landing after the row is already expanded.
  const manualEngine = () => {
    let events: DevinAcpEvents | undefined
    let finish: ((outcome: PromptOutcome) => void) | undefined
    const spawnEngine: SpawnEngine = (input) => {
      events = input.events
      return Promise.resolve({
        alive: true,
        newSession: () => Promise.resolve({ sessionId: "manual-1" }),
        loadSession: () => Promise.resolve({}),
        listSessions: () => Promise.resolve({ sessions: [] }),
        prompt: () => new Promise<PromptOutcome>((resolve) => { finish = resolve }),
        cancel: () => Promise.resolve(),
        setMode: () => Promise.resolve({}),
        setConfigOption: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      })
    }
    const emit = (update: SessionUpdate) => events?.onUpdate?.("manual-1", update)
    const settle = () => finish?.({ stopReason: "end_turn", text: "", thoughts: "" })
    return { spawnEngine, emit, settle }
  }

  test("a streaming thought stays expanded while later chunks merge into it (S1)", async () => {
    const engine = manualEngine()
    const { setup } = await mountView({ spawnEngine: engine.spawnEngine })
    await pickNew(setup)
    await untilFrame(setup, (f) => f.includes("manual-1"))
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("❯ go"))

    engine.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "streamed reasoning" } })
    const thinking = await untilFrame(setup, (f) => f.includes("Thinking"))
    const y = thinking.split("\n").findIndex((l) => l.includes("Thinking"))
    await setup.mockMouse.click(6, y)
    await untilFrame(setup, (f) => f.includes("streamed reasoning"))

    // The merge replaces the stored entry but keeps its lane id — the
    // expansion set is keyed on that id, so the body must stay mounted.
    engine.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: " — continued" } })
    const merged = await untilFrame(setup, (f) => f.includes("streamed reasoning — continued"))
    expect(merged).toContain("Thinking")

    engine.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer follows" } })
    const sealed = await untilFrame(setup, (f) => f.includes("answer follows"))
    // Sealed by the agent chunk, the header settles — expansion still open.
    expect(sealed).toContain("- Thought:")
    expect(sealed).toContain("streamed reasoning — continued")
  })

  test("an expanded tool detail survives merges and later appends (S1)", async () => {
    const engine = manualEngine()
    const { setup } = await mountView({ spawnEngine: engine.spawnEngine })
    await pickNew(setup)
    await untilFrame(setup, (f) => f.includes("manual-1"))
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await untilFrame(setup, (f) => f.includes("❯ go"))

    engine.emit({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "$ Ran echo",
      kind: "execute",
      status: "running",
      rawInput: { command: "echo hi" },
    })
    const f0 = await untilFrame(setup, (f) => f.includes("Ran echo"))
    const y = f0.split("\n").findIndex((l) => l.includes("Ran echo"))
    const x = f0.split("\n")[y]!.indexOf("Ran echo")
    await setup.mockMouse.click(x, y)
    await untilFrame(setup, (f) => f.includes("▾") && f.includes("echo hi"))

    // A merge into the same call, then an unrelated append — the open detail
    // must not collapse or lose its contents.
    engine.emit({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: "hi\n" })
    engine.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer follows" } })
    const after = await untilFrame(setup, (f) => f.includes("answer follows"))
    expect(after).toContain("▾")
    expect(after).toContain("echo hi")
    expect(after).not.toContain(" completed")
  })

  test("agent text renders as markdown — markers concealed, not literal (REQ-MD-01)", async () => {
    const { setup } = await mountView()
    await waitForSession(setup)
    await setup.mockInput.typeText("show **bold** and `inline`")
    setup.mockInput.pressEnter()
    const f = await untilFrame(setup, (fr) =>
      (fr.split("\n").find((l) => l.includes("pong:")) ?? "").includes("inline"),
    )
    // The agent's markdown row conceals ** and ` markers. The ❯ user echo and
    // the mono tool-card command legitimately keep raw text — check the agent
    // line only.
    const agentLine = f.split("\n").find((l) => l.includes("pong:")) ?? ""
    expect(agentLine).toContain("bold")
    expect(agentLine).toContain("inline")
    expect(agentLine).not.toContain("**")
    expect(agentLine).not.toContain("`")
  })

  test("clicking a user or agent entry opens Message Actions — jump, copy, edit (REQ-MSGACT-01)", async () => {
    const copied: string[] = []
    const { setup, test } = await mountView({ copyText: async (text) => { copied.push(text) } })
    await waitForSession(setup)
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    const f = await untilFrame(setup, (fr) => fr.includes("pong:"))

    // User block click → Message Actions select with the honest wire set.
    const userRow = f.split("\n").findIndex((l) => l.includes("❯ hello"))
    await setup.mockMouse.click(6, userRow)
    await until(() => test.selects.some((s) => s.title === "Message Actions"))
    const select = test.selects.at(-1)!
    expect(select.options.map((o) => o.title)).toEqual(["Jump to", "Copy", "Edit in composer"])

    // Copy writes the entry's text through the clipboard seam.
    test.respondSelect(select.options.findIndex((o) => o.value === "copy"))
    await until(() => copied.length === 1)
    expect(copied[0]).toBe("hello")

    // Edit in composer loads the text without sending — click a different
    // cell: a repeat click on the same cell escalates to word-select and is
    // rightly ignored by the row.
    await setup.mockMouse.click(10, userRow)
    await until(() => test.selects.length >= 2)
    test.respondSelect(test.selects.at(-1)!.options.findIndex((o) => o.value === "edit"))
    await until(() => editors(setup).some((e) => e.plainText === "hello"))

    // Agent entry click → same menu minus the user-only edit affordance.
    const agentRow = f.split("\n").findIndex((l) => l.includes("pong:"))
    await setup.mockMouse.click(4, agentRow)
    await until(() => test.selects.length >= 3)
    expect(test.selects.at(-1)!.options.map((o) => o.title)).toEqual(["Jump to", "Copy"])

    // Jump resolves and dismisses without error.
    test.respondSelect(test.selects.at(-1)!.options.findIndex((o) => o.value === "jump"))
    await tick(setup)
  })

  test("config_option_update replaces the live list wholesale and the header follows (E16 shapes)", async () => {
    const dir = tempDir()
    const configPath = join(dir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify([
        {
          id: "mode",
          name: "Session Mode",
          category: "mode",
          type: "select",
          currentValue: "ask",
          options: [
            { value: "ask", name: "Ask" },
            { value: "accept-edits", name: "Code-Mode" },
          ],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "zeta-9",
          options: [
            { value: "zeta-9", name: "Zeta-9" },
            { value: "omega-1", name: "Omega-1" },
          ],
        },
      ]),
    )
    const { setup, log } = await mountView({ env: { FAKE_ACP_CONFIG: configPath } })
    await pickNew(setup)
    const bound = await untilFrame(setup, (f) => f.includes("Zeta-9") && f.includes("Code-Mode"))
    expect(bound).toContain("Code-Mode")
    setup.mockInput.pressKey("m", { ctrl: true })
    await untilFrame(setup, (f) => f.includes("Omega-1"))
    setup.mockInput.pressKey("2")
    await untilFrame(setup, (f) => f.split("\n")[0]!.includes("Omega-1"))
    expect(sentMethods(log)).toContain("session/set_config_option")
  })

  test("tool blocks collapse to a header row and expand on click (REQ-TOOL-01)", async () => {
    const { setup } = await mountView({ scenario: "messages" })
    await waitForSession(setup)
    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    const f0 = await untilFrame(setup, (f) => f.includes("Ran echo") && f.includes("pong: hello"))
    // Collapsed by default: header carries the collapse glyph + status; the
    // detail text stays hidden entirely.
    const lines0 = f0.split("\n")
    const header0 = lines0.find((l) => l.includes("Ran echo"))
    expect(header0).toContain("▸")
    expect(lines0.filter((l) => l.includes("echo hello")).length).toBe(0)

    // Click the tool card → expands: glyph flips, detail gets its own line.
    const y0 = lines0.findIndex((l) => l.includes("Ran echo"))
    await setup.mockMouse.click(3, y0)
    const f1 = await untilFrame(setup, (f) => {
      const ls = f.split("\n")
      return (
        ls.some((l) => l.includes("Ran echo") && l.includes("▾")) &&
        ls.some((l) => l.includes("echo hello") && !l.includes("Ran echo"))
      )
    })
    const lines1 = f1.split("\n")
    const header1 = lines1.find((l) => l.includes("Ran echo"))
    expect(header1).not.toContain("echo hello")
    expect(lines1.some((l) => l.includes("echo hello") && !l.includes("Ran echo"))).toBe(true)

    // Click again → collapses back: glyph flips, detail hidden again.
    const y1 = lines1.findIndex((l) => l.includes("Ran echo"))
    await setup.mockMouse.click(3, y1)
    const f2 = await untilFrame(
      setup,
      (f) =>
        f.split("\n").some((l) => l.includes("Ran echo") && l.includes("▸")) &&
        !f.split("\n").some((l) => l.includes("echo hello") && !l.includes("Ran echo")),
    )
    expect(f2.split("\n").filter((l) => l.includes("echo hello")).length).toBe(0)
  })

  test("wire-rich tool rows: per-kind glyphs, cancelled strikethrough, diff + command details (REQ-TOOL-01, REQ-BOXED-01)", async () => {
    const { setup } = await mountView({ scenario: "rich", height: 56 })
    await waitForSession(setup)
    await setup.mockInput.typeText("go rich")
    setup.mockInput.pressEnter()
    const f0 = await untilFrame(setup, (f) => f.includes("Edited /repo/src/alpha.ts") && f.includes("Done."))
    const lines0 = f0.split("\n")

    // Host InlineTool icons by toolName: read →, exec $, edit/write ←; a
    // cancelled call keeps its icon and strikes through (host denied grammar).
    // The two consecutive reads collapse into the host's exploration group
    // (group-view.tsx): `→ Explored: 2 reads` — expand it to reach members.
    expect(lines0.some((l) => l.includes("→") && l.includes("Explored: 2 reads"))).toBe(true)
    const exploredY = lines0.findIndex((l) => l.includes("Explored: 2 reads"))
    await setup.mockMouse.click(3, exploredY)
    const fExpanded = await untilFrame(setup, (f) => f.includes("Read file"))
    expect(fExpanded.split("\n").some((l) => l.includes("→") && l.includes("Read file"))).toBe(true)
    expect(lines0.some((l) => l.includes("$") && l.includes("Ran bun test"))).toBe(true)
    expect(lines0.some((l) => l.includes("←") && l.includes("Edited /repo/src/alpha.ts"))).toBe(true)
    expect(spanAttrs(setup, "Ran rm -rf dist") & TextAttributes.STRIKETHROUGH).not.toBe(0)

    // Expand the exec row: command line, output, and exit meta land in the
    // bordered detail box. Coordinates recompute off the expanded frame —
    // the open group pushed every later row down.
    const execY = fExpanded.split("\n").findIndex((l) => l.includes("Ran bun test"))
    await setup.mockMouse.click(3, execY)
    const f1 = await untilFrame(setup, (f) => f.includes("$ bun test") && f.includes("12 pass") && f.includes("exit 0"))

    // Expand the edit row: the wire diff block paints through <diff> with
    // both sides of the change.
    const editY = f1.split("\n").findIndex((l) => l.includes("Edited /repo/src/alpha.ts"))
    await setup.mockMouse.click(3, editY)
    const f2 = await untilFrame(setup, (f) => f.includes("alpha = 1") && f.includes("alpha = 2"))
    expect(f2.split("\n").some((l) => l.includes("-") && l.includes("alpha = 1"))).toBe(true)
    expect(f2.split("\n").some((l) => l.includes("+") && l.includes("alpha = 2"))).toBe(true)

    // REQ-WIRE-01 depth: the turnmeta row surfaces the wire's own turn stats
    // (files/commands/ttft from agent_stopped) and the usage row its cost
    // meta — neither is flattened away before the view.
    expect(f2).toContain("2 files")
    expect(f2).toContain("2 cmds")
    expect(f2).toContain("ttft")
    expect(f2).toContain("0.42 credits")
    expect(f2).toContain("1.7 ACU")
  })

  test("picker rows: hover moves the highlight, click picks the row, lock badge is warning-styled (REQ-MOUSE-01, REQ-CHROME-01)", async () => {
    // Tall mount: the host-capped scrollbox (floor(h/2)-6) must expose
    // quiet-badger's row for the click to hit it.
    const { setup, test, log } = await mountView({ scenario: "sessions", height: 56 })
    const f0 = await untilFrame(setup, (f) => f.includes("quiet-badger") && f.includes("+ New session"))
    const lines0 = f0.split("\n")

    // Hover cherry-random's row → host rows carry no arrow marker; the
    // focused action foreground paints both lines of the hovered row.
    const yHover = lines0.findIndex((l) => l.includes("cherry-random"))
    const xHover = lines0[yHover]!.indexOf("cherry-random")
    const warning = String(test.context.theme.surface("dialog").text.feedback.warning.base)
    const focused = String(test.context.theme.surface("dialog").text.action.primary.focused)
    await setup.mockMouse.moveTo(xHover, yHover)
    const hovered = await untilFrame(setup, () => spanFg(setup, "cherry-random") === focused)

    // The lock badge on repeated-plane renders in the theme's warning color.
    expect(spanFg(setup, "⚿")).toBe(warning)

    // Click quiet-badger's row → binds it via session/load (no session/new).
    // Coordinates come from the just-rendered frame — the wrapped "+ New
    // session" title can shift rows between frames, so stale indices mis-hit.
    const pickLines = hovered.split("\n")
    const yPick = pickLines.findIndex((l) => l.includes("quiet-badger"))
    const xPick = pickLines[yPick]!.indexOf("quiet-badger")
    await setup.mockMouse.click(xPick, yPick)
    await untilFrame(setup, (f) => f.includes("Devin quiet-badger"))
    const loads = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes('"session/load"'))
    expect(loads.length).toBe(1)
    expect(loads[0]).toContain("quiet-badger")
    expect(sentMethods(log)).not.toContain("session/new")
  })
})
