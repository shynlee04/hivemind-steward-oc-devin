import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@opentui/solid"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { DevinView } from "../tui"
import { laneFor } from "../src/lane"
import { createTestContext } from "./support/context"
import { fakeEngineSpawn, type FakeEngineOptions } from "./support/engine"
import { until, untilFrame } from "./support/drive"
import { pickNamed, pickNew } from "./support/picker"

const dirs: string[] = []
const setups: TestRendererSetup[] = []

// Lane state is registry-keyed by cwd — a remount is a fresh renderer over the
// same directory, which lands the same DevinLane. The spawn options only matter
// on the first mount (the lane keeps its engine across mounts).
async function mountInto(directory: string, log: string, options: FakeEngineOptions): Promise<TestRendererSetup> {
  const setup = await createTestRenderer({ width: 160, height: 40, kittyKeyboard: true })
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
  return setup
}

const unmount = (setup: TestRendererSetup) => {
  setup.renderer.destroy()
  const i = setups.indexOf(setup)
  if (i >= 0) setups.splice(i, 1)
}

const wire = (path: string, method: string): number => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return 0
  }
  return raw
    .split("\n")
    .filter((l) => l.includes(`"method":"${method}"`) && l.includes('"direction":"in"'))
    .length
}

const sent = (path: string, needle: string): boolean => {
  try {
    return readFileSync(path, "utf8").includes(needle)
  } catch {
    return false
  }
}

afterEach(async () => {
  for (const setup of setups.splice(0)) setup.renderer.destroy()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempLane = (): { directory: string; log: string } => {
  const directory = mkdtempSync(join(tmpdir(), "devin-remount-"))
  dirs.push(directory)
  return { directory, log: join(directory, "wire.ndjson") }
}

describe("Hosted Devin View — remount safety (REQ-REMOUNT-01)", () => {
  test("input delivered before the first painted frame cannot pick (#13, REQ-ENTER-01)", async () => {
    const { directory, log } = tempLane()
    const setup = await mountInto(directory, log, { scenario: "sessions" })
    // The mount has happened but no frame has been driven — this is the bleed
    // window where /devin's submitting Enter lands on the picker (#13). The
    // picker's pick key is Enter; a pre-paint press finds no mounted dialog.
    setup.mockInput.pressEnter()
    await until(() => wire(log, "session/new") > 0, 600).then(
      () => expect.unreachable("pre-paint keypress must not bind"),
      () => { },
    )
    expect(wire(log, "session/new")).toBe(0)
    // After the first frame paints, the same key picks as normal.
    await untilFrame(setup, (fr) => fr.includes("+ New session"))
    setup.mockInput.pressEnter()
    await until(() => wire(log, "session/new") === 1)
  })

  test("unmount during an in-flight session/list — the response still lands; the remounted picker is populated", async () => {
    const { directory, log } = tempLane()
    const options: FakeEngineOptions = { scenario: "sessions", env: { FAKE_ACP_LIST_DELAY_MS: "250" } }
    const first = await mountInto(directory, log, options)
    await until(() => wire(log, "session/list") === 1)
    unmount(first) // response still in flight — the sink detaches, the lane keeps the result
    await until(() => sent(log, '"sessions":['))
    const second = await mountInto(directory, log, options)
    const f = await untilFrame(second, (fr) => fr.includes("cherry-random") && fr.includes("repeated-plane"))
    expect(f).toContain("+ New session")
    await until(() => wire(log, "session/list") === 4)
    // One list per picker open — mount and remount are two opens on one engine.
    expect(wire(log, "initialize")).toBe(1)
  })

  test("unmount during an in-flight session/load — replay and response land on the lane; remount shows the bound log (E44)", async () => {
    const { directory, log } = tempLane()
    const options: FakeEngineOptions = { scenario: "sessions", env: { FAKE_ACP_LOAD_DELAY_MS: "300" } }
    const first = await mountInto(directory, log, options)
    await untilFrame(first, (fr) => fr.includes("cherry-random"))
    await pickNamed(first, "cherry-random")
    await until(() => wire(log, "session/load") === 1)
    // Replay notifications stream ahead of the delayed response — they arrive
    // while the view is about to detach and must not be lost to a dead sink.
    await until(() => sent(log, '"session_info_update"'))
    unmount(first)
    await until(() => sent(log, '"modes":{'))
    const second = await mountInto(directory, log, options)
    const f = await untilFrame(
      second,
      (fr) => fr.includes("Reply with exactly the single word: ok") && fr.includes("Ran ls") && fr.includes("package.json"),
    )
    expect(f).not.toContain("+ New session")
    expect(wire(log, "session/load")).toBe(1)
    expect(wire(log, "session/new")).toBe(0)
    expect(wire(log, "initialize")).toBe(1)
  })

  test("bound remount — same binding and Entry Log, no new session/new, no re-list, view-owned composer resets", async () => {
    const { directory, log } = tempLane()
    const options: FakeEngineOptions = { scenario: "sessions" }
    const first = await mountInto(directory, log, options)
    await untilFrame(first, (fr) => fr.includes("cherry-random"))
    await pickNew(first)
    await untilFrame(first, (fr) => fr.includes("fake-session-"))
    await first.mockInput.typeText("ping")
    first.mockInput.pressEnter()
    await untilFrame(first, (fr) => fr.includes("pong: ping"))
    await first.mockInput.typeText("draftxyz")
    unmount(first)
    const second = await mountInto(directory, log, options)
    const f = await untilFrame(second, (fr) => fr.includes("Devin ping") && fr.includes("pong: ping"))
    expect(f).not.toContain("draftxyz")
    expect(f).not.toContain("cherry-random") // picker did not reopen over a bound lane
    expect(wire(log, "session/new")).toBe(1)
    expect(wire(log, "session/list")).toBe(2)
    expect(wire(log, "initialize")).toBe(1)
  })

  test("engine death mid-load — the load rejects, the lane unbinds, and the next pick lazily respawns and re-lists (E43)", async () => {
    const { directory, log } = tempLane()
    const options: FakeEngineOptions = {
      scenario: "sessions",
      env: { FAKE_ACP_LOAD_DIE: "1", FAKE_ACP_LOAD_DELAY_MS: "150" },
    }
    const first = await mountInto(directory, log, options)
    await untilFrame(first, (fr) => fr.includes("cherry-random"))
    await pickNamed(first, "cherry-random")
    await until(() => wire(log, "session/load") === 1)
    unmount(first) // the death lands while the view is detached
    await until(() => existsSync(join(directory, ".fake-acp-crashed")))
    const second = await mountInto(directory, log, options)
    // The reopened picker dialog bisects the lane log, so the wire error and
    // the death notice are asserted on the lane entries, not the frame.
    const f = await untilFrame(second, (fr) => fr.includes("+ New session"), 10_000)
    const lane = laneFor(`${directory}:default`, { cwd: directory, spawnEngine: fakeEngineSpawn({}) })
    const sys = lane.entries.filter((e) => e.kind === "system").map((e) => e.text).join("\n")
    expect(sys).toContain("could not load session cherry-random")
    expect(sys).toMatch(/devin acp (exited|died)/)
    expect(f).not.toContain("fake-session-")
    // The respawned engine re-lists, and the same pick binds cleanly. Wait for
    // the descriptor row to paint: the wire log records the request before the
    // response lands, so pressing on the wire count alone can beat the rows.
    await untilFrame(second, (fr) => fr.includes("cherry-random") && fr.includes("restarted devin acp"), 10_000)
    expect(wire(log, "session/list")).toBe(4)
    expect(wire(log, "initialize")).toBe(2)
    await pickNamed(second, "cherry-random")
    await untilFrame(second, (fr) => fr.includes("Reply with exactly the single word: ok") && fr.includes("Ran ls"), 10_000)
    expect(wire(log, "session/load")).toBe(2)
    expect(wire(log, "session/new")).toBe(0)
    expect(wire(log, "initialize")).toBe(2)
  }, 20_000)
})
