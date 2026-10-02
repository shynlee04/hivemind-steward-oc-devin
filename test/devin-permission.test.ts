import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { createTestContext, type TestContext } from "./support/context"
import { fakeEngineSpawn } from "./support/engine"
import { frame, tick, until, untilFrame } from "./support/drive"
import { pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

async function mountPermission(scenario = "permission"): Promise<{ setup: TestRendererSetup; test: TestContext; log: string }> {
  const directory = mkdtempSync(join(tmpdir(), "devin-perm-"))
  dirs.push(directory)
  const log = join(directory, "wire.ndjson")
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  setups.push(setup)
  const test = createTestContext(setup.renderer, directory)
  await render(
    () =>
      [DevinView({
        context: test.context,
        deps: {
          spawnEngine: fakeEngineSpawn({ scenario, env: { FAKE_ACP_LOG: log } }),
        },
      }), test.dialogPortal()],
    setup.renderer,
  )
  return { setup, test, log }
}

const permissionAnswers = (path: string, id = "srv-perm-1") =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { direction: string; msg?: { id?: number | string; result?: { outcome?: unknown } } })
    .filter((f) => f.direction === "in" && f.msg?.id === id)
    .map((f) => f.msg!.result!.outcome as { outcome: string; optionId?: string })

const waitForCard = (setup: TestRendererSetup) => untilFrame(setup, (f) => f.includes("Permission required") && f.includes("Allow once"))

const bound = async (setup: TestRendererSetup) => {
  await pickNew(setup)
  await untilFrame(setup, (f) => f.includes("fake-session-"))
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Hosted Devin View — inline permission card (REQ-PERM-01)", () => {
  test("permission request renders an inline numbered card; digit key answers on the wire and the prompt continues (E7)", async () => {
    const { setup, log } = await mountPermission()
    await bound(setup)
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    const card = await waitForCard(setup)
    // Host SessionQuestion grammar: △ header, subject title, option chips.
    expect(card).toContain("△")
    expect(card).toContain("Permission required")
    expect(card).toContain("Delete node_modules")
    expect(card).toContain("Always allow")
    expect(card).toContain("Reject")

    setup.mockInput.pressKey("1")
    await until(() => permissionAnswers(log).length === 1)
    expect(permissionAnswers(log)[0]).toEqual({ outcome: "selected", optionId: "perm-allow-once" })
    await untilFrame(setup, (f) => f.includes("Permission answered, continuing. Done."))
  })

  test("esc cancels on the wire without navigating home (E10)", async () => {
    const { setup, test, log } = await mountPermission()
    await bound(setup)
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await waitForCard(setup)
    setup.mockInput.pressEscape()
    await until(() => permissionAnswers(log).length === 1)
    expect(permissionAnswers(log)[0]).toEqual({ outcome: "cancelled" })
    expect(test.navigations).toHaveLength(0)
  })

  test("arrow-right + enter selects the highlighted chip's optionId (host ←/→ grammar)", async () => {
    const { setup, log } = await mountPermission()
    await bound(setup)
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await waitForCard(setup)
    setup.mockInput.pressArrow("right")
    setup.mockInput.pressEnter()
    await until(() => permissionAnswers(log).length === 1)
    expect(permissionAnswers(log)[0]).toEqual({ outcome: "selected", optionId: "perm-allow-always" })
  })

  test("a second request queues behind the open card; each resolves on the wire with its own outcome", async () => {
    const { setup, log } = await mountPermission("permission-two")
    await bound(setup)
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await waitForCard(setup)
    setup.mockInput.pressKey("1")
    await until(() => permissionAnswers(log, "srv-perm-1").length === 1)
    expect(permissionAnswers(log, "srv-perm-1")[0]).toEqual({ outcome: "selected", optionId: "perm-allow-once" })

    // A second pending card lands below the answered one — its `△ Permission
    // required` header comes after the first card's `→ Allow once` result.
    const next = await untilFrame(
      setup,
      (f) => f.indexOf("Write env file") !== -1 && f.lastIndexOf("Permission required") > f.indexOf("→ Allow once"),
    )
    expect(next).toContain("→ Allow once")
    setup.mockInput.pressEscape()
    await until(() => permissionAnswers(log, "srv-perm-2").length === 1)
    expect(permissionAnswers(log, "srv-perm-2")[0]).toEqual({ outcome: "cancelled" })
    await untilFrame(setup, (f) => f.includes("Done."))
  })

  test("the card owns input while open; the composer takes keys again after it closes", async () => {
    const { setup, log } = await mountPermission()
    await bound(setup)
    await setup.mockInput.typeText("go")
    setup.mockInput.pressEnter()
    await waitForCard(setup)
    await setup.mockInput.typeText("zzz")
    await tick(setup)
    expect(setup.renderer.currentFocusedEditor).toBeNull()
    setup.mockInput.pressKey("1")
    await until(() => permissionAnswers(log).length === 1)
    await untilFrame(setup, (f) => f.includes("Permission answered"))
    await setup.mockInput.typeText("back")
    await tick(setup)
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("back")
  })
})
