import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import Plugin, { DevinPanel, DevinSidebar, DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn } from "./support/engine"
import { tick, until, untilFrame } from "./support/drive"
import { pickNamed, pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "devin-surfaces-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function mountLane(directory: string): Promise<{ setup: TestRendererSetup; test: TestContext }> {
  const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  await render(
    () =>
      [DevinView({
        context: test.context,
        deps: { spawnEngine: fakeEngineSpawn({ scenario: "sessions" }) },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test }
}

describe("Devin surfaces — palette commands + sidebar (REQ-CMDPAL-01, REQ-SIDEBAR-01)", () => {
  test("plugin setup registers Devin-grouped palette commands that navigate with overlay data", async () => {
    const directory = tempDir()
    const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true })
    setups.push(setup)
    const test = createTestContext(setup.renderer, directory)

    // Real plugin setup — the app claim mounts DevinCommands and its keymap
    // layer. Identify it by slot path, not by position among the claims.
    void Plugin.setup(test.context)
    const appClaim = test.slotClaims.find((c) => c.path === "app")
    expect(appClaim).toBeDefined()
    await render(() => appClaim!.render({}) as never, setup.renderer)

    test.dispatch("devin.sessions")
    expect(test.navigations.some((n) => n.type === "plugin" && n.name === "devin" && n.data?.overlay === "sessions")).toBe(true)
    test.dispatch("devin.commands")
    expect(test.navigations.some((n) => n.type === "plugin" && n.name === "devin" && n.data?.overlay === "commands")).toBe(true)
  })

  test("sidebar renders nothing unbound, then bound status once the lane binds", async () => {
    const directory = tempDir()
    const { setup, test } = await mountLane(directory)

    // Sidebar on the same cwd lane — unbound at first.
    const sidebar = await createTestRenderer({ width: 60, height: 12, kittyKeyboard: true })
    setups.push(sidebar)
    const sidebarCtx = createTestContext(sidebar.renderer, directory)
    await render(
      () =>
        DevinSidebar({
          context: sidebarCtx.context,
          sessionID: "oc-session-1",
          deps: { spawnEngine: fakeEngineSpawn({ scenario: "sessions" }) },
        }),
      sidebar.renderer,
    )
    await tick(sidebar)
    expect(sidebar.captureCharFrame()).not.toContain("Devin")

    // Bind via the route — the sidebar must update on the shared lane.
    await pickNew(setup)
    const bound = await untilFrame(setup, (f) => f.includes("fake-session-"))
    expect(bound).toContain("ready")
    const side = await untilFrame(sidebar, (f) => f.includes("Devin") && f.includes("fake-session-"))
    expect(side).toMatch(/idle|running|needs input/)
  })

  test("sidebar lists Devin sessions collapsibly — bound marker, click binds (REQ-SIDEBAR-02)", async () => {
    const directory = tempDir()
    const { setup } = await mountLane(directory)
    await pickNamed(setup, "quiet-badger")
    console.log("=== POST-PICK ===\n" + setup.captureCharFrame())
    await untilFrame(setup, (f) => f.includes("quiet-badger") && f.includes("ready"))

    const sidebar = await createTestRenderer({ width: 60, height: 24, kittyKeyboard: true })
    setups.push(sidebar)
    const sidebarCtx = createTestContext(sidebar.renderer, directory)
    await render(
      () =>
        DevinSidebar({
          context: sidebarCtx.context,
          sessionID: "oc-session-1",
          deps: { spawnEngine: fakeEngineSpawn({ scenario: "sessions" }) },
        }),
      sidebar.renderer,
    )

    const f = await untilFrame(sidebar, (fr) => fr.includes("Devin sessions") && fr.includes("cherry-random"))
    expect(f).toContain("● quiet-badger")
    expect(f.split("\n").find((l) => l.includes("cherry-random"))).toContain("○")
    expect(f).toContain("⚿")

    // Clicking a session row binds it on the shared lane — the route follows.
    const row = f.split("\n").findIndex((l) => l.includes("cherry-random"))
    await sidebar.mockMouse.click(2, row)
    await untilFrame(sidebar, (fr) => {
      const line = fr.split("\n").find((l) => l.includes("cherry-random"))
      return !!line && line.includes("●")
    })
    await untilFrame(setup, (fr) => fr.includes("cherry-random") && fr.includes("ready"))

    // Collapse hides the rows; re-expand restores them.
    const head = sidebar.captureCharFrame().split("\n").findIndex((l) => l.includes("Devin sessions"))
    await sidebar.mockMouse.click(2, head)
    await untilFrame(sidebar, (fr) => !fr.includes("cherry-random"))
    await sidebar.mockMouse.click(2, head)
    await untilFrame(sidebar, (fr) => fr.includes("cherry-random"))
  })

  test("session.panel claim renders the bound lane tail; focused + ⏎ opens the route (REQ-PANEL-01)", async () => {
    const directory = tempDir()
    const { setup } = await mountLane(directory)
    await pickNew(setup)
    await untilFrame(setup, (f) => f.includes("fake-session-"))

    const panel = await createTestRenderer({ width: 80, height: 14, kittyKeyboard: true })
    setups.push(panel)
    const panelCtx = createTestContext(panel.renderer, directory)
    const input = {
      name: "devin",
      sessionID: "oc-session-1",
      width: 80,
      presentation: "panel" as const,
      focused: true,
      focus: () => { },
      close: () => { },
      toggleFullscreen: () => { },
    }
    await render(
      () =>
        DevinPanel({
          context: panelCtx.context,
          input,
          deps: { spawnEngine: fakeEngineSpawn({ scenario: "sessions" }) },
        }),
      panel.renderer,
    )
    // Same cwd lane as the route — the panel mirrors it without spawning.
    const f = await untilFrame(panel, (fr) => fr.includes("Devin") && fr.includes("fake-session-"))
    expect(f).toContain("open Devin view")

    panel.mockInput.pressEnter()
    await until(() => panelCtx.navigations.some((n) => n.type === "plugin" && n.name === "devin"))
  })

  test("session.panel slot claim renders nothing for other panels; Devin: open panel calls ui.panel.open", async () => {
    const directory = tempDir()
    const setup = await createTestRenderer({ width: 80, height: 14, kittyKeyboard: true })
    setups.push(setup)
    const test = createTestContext(setup.renderer, directory)
    void Plugin.setup(test.context)
    // Mount the app claim so DevinCommands registers its keymap layer.
    const appClaim = test.slotClaims.find((c) => c.path === "app")
    expect(appClaim).toBeDefined()
    await render(() => appClaim!.render({}) as never, setup.renderer)

    const panelClaim = test.slotClaims.find((c) => c.path === "session.panel")
    expect(panelClaim).toBeDefined()
    const foreign = panelClaim!.render({ name: "other-plugin", sessionID: "s", width: 40, presentation: "panel", focused: false, focus: () => { }, close: () => { }, toggleFullscreen: () => { } })
    expect(foreign).toBeNull()

    test.dispatch("devin.panel")
    expect(test.panelsOpened).toContain("devin")
  })
})
