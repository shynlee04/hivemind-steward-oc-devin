import type { TestRendererSetup } from "@opentui/core/testing"
import { EditBufferRenderable, type Renderable } from "@opentui/core"

// Drive a render pass after letting async work (process I/O, timers) progress.
export const tick = async (setup: TestRendererSetup, ms = 15): Promise<void> => {
  await Bun.sleep(ms)
  await setup.renderOnce()
}

// Read the frame — only valid after a driven render pass (PROH-07).
export const frame = (setup: TestRendererSetup): string => setup.captureCharFrame()

// Poll until `predicate` holds on a freshly rendered frame, else throw.
export const untilFrame = async (
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  timeoutMs = 4_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  let last = ""
  do {
    await tick(setup)
    last = frame(setup)
    if (predicate(last)) return last
  } while (Date.now() < deadline)
  throw new Error(`untilFrame timed out after ${timeoutMs}ms; last frame:\n${last}`)
}

// Poll a non-frame predicate (wire logs, signals) while pumping render passes.
export const until = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  do {
    if (await predicate()) return
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  throw new Error("until timed out")
}

// Every editor renderable (inputs, textareas) in the tree — focused or not.
// Centered dialogs occlude the composer's frame text, so tests assert editor
// content here instead of reading glyphs behind the dialog surface.
export const editors = (setup: TestRendererSetup): EditBufferRenderable[] => {
  const found: EditBufferRenderable[] = []
  const walk = (node: Renderable) => {
    if (node instanceof EditBufferRenderable) found.push(node)
    for (const child of node.getChildren()) walk(child)
  }
  walk(setup.renderer.root)
  return found
}
