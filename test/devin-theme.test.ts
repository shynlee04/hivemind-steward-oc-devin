import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { frame, tick } from "./support/drive"
import { pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

async function mountView(options: FakeEngineOptions = {}): Promise<{ setup: TestRendererSetup; test: TestContext }> {
  const dir = mkdtempSync(join(tmpdir(), "devin-theme-"))
  dirs.push(dir)
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, dir)
  await render(
    () =>
      [DevinView({
        context: test.context,
        deps: { spawnEngine: fakeEngineSpawn({ ...options, env: { FAKE_ACP_LOG: join(dir, "wire.ndjson") } }) },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test }
}

const spanColor = (setup: TestRendererSetup, needle: string): string | undefined => {
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.fg.toString()
    }
  }
  return undefined
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Devin view — live host theme (REQ-THEME-01)", () => {
  test("switching theme repaints painted chrome without remount", async () => {
    const { setup, test } = await mountView()
    await pickNew(setup)
    await tick(setup)
    expect(frame(setup)).toContain("Devin")

    const beforeAccent = spanColor(setup, "Devin")
    // The composer's left `┃` rail paints theme.border.base (host prompt
    // grammar: tint(border.base, agentColor ?? border.base) — no agent color
    // exists on the Devin wire, so the rail settles on the border token).
    const beforeBorder = spanColor(setup, "┃")
    expect(beforeAccent).toBe("rgba(0.93, 0.93, 0.93, 1.00)")
    expect(beforeBorder).toBe("rgba(0.28, 0.28, 0.28, 1.00)")

    test.setTheme("light")
    await tick(setup)

    expect(spanColor(setup, "Devin")).toBe("rgba(0.10, 0.10, 0.10, 1.00)")
    expect(spanColor(setup, "┃")).toBe("rgba(0.72, 0.72, 0.72, 1.00)")
  })
})
