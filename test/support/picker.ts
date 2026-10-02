import type { TestRendererSetup } from "@opentui/core/testing"
import { untilFrame, until } from "./drive"

// Picker drivers — press the same keys a user would. The picker rides the host
// dialog: unbound lanes open it on mount, bound lanes via ctrl+o. ⏎ picks the
// highlighted row; typing narrows the list through the filter field.
export const waitForPicker = async (setup: TestRendererSetup): Promise<string> => {
  const f = await untilFrame(setup, (f) => f.includes("+ New session"))
  // The filter (an InputRenderable, not the composer TextareaRenderable)
  // self-focuses a macrotask after the dialog paints; without this a caller's
  // first typeText drops into the void (E26 flake class).
  await until(() => setup.renderer.currentFocusedEditor?.constructor.name === "InputRenderable")
  return f
}

export const pickNew = async (setup: TestRendererSetup): Promise<void> => {
  await waitForPicker(setup)
  setup.mockInput.pressEnter()
}

// The filter input focuses itself a macrotask after mount; chars typed before
// focus drop silently, so retype until the placeholder actually clears.
// Whatever landed is a suffix of `name`, and suffixes of these session names
// narrow to the same unique row — the pick is correct even on partial landings.
export const pickNamed = async (setup: TestRendererSetup, name: string): Promise<void> => {
  await waitForPicker(setup)
  const landed = (f: string) => !f.includes("Search sessions")
  const deadline = Date.now() + 8_000
  for (; ;) {
    await setup.mockInput.typeText(name)
    try {
      await untilFrame(setup, landed, 800)
      break
    } catch {
      if (Date.now() > deadline) throw new Error(`pickNamed: filter never received "${name}"`)
    }
  }
  await untilFrame(setup, (f) => f.includes(name))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
}
