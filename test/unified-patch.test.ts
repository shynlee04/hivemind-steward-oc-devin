import { describe, expect, test } from "bun:test"
import { unifiedPatch } from "../tui"

// The wire's diff blocks are raw oldText/newText pairs — unifiedPatch must
// emit real @@ hunks: untouched middle lines stay context, separated changes
// split, and a file-wide change is one hunk.
describe("unifiedPatch — hunk grammar", () => {
  test("separated change regions split into their own @@ hunks with context margins", () => {
    const old = ["l1", "a", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "b", "l9", "l10"].join("\n")
    const nu = ["l1", "A", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "B", "l9", "l10"].join("\n")
    const hunks = unifiedPatch("f.ts", old, nu)
    expect(hunks).toHaveLength(2)
    // The unchanged middle is context, not a false -/+ pair.
    expect(hunks[0]!.patch).not.toContain("-l5")
    expect(hunks[0]!.patch).not.toContain("+l5")
    expect(hunks[0]!.patch).toContain("-a")
    expect(hunks[0]!.patch).toContain("+A")
    expect(hunks[0]!.header).toBe("@@ -1,5 +1,5 @@")
    expect(hunks[1]!.patch).toContain("-b")
    expect(hunks[1]!.patch).toContain("+B")
    expect(hunks[1]!.header).toBe("@@ -7,6 +7,6 @@")
  })

  test("a single contiguous change stays one hunk", () => {
    const hunks = unifiedPatch("f.ts", "alpha = 1", "alpha = 2")
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.header).toBe("@@ -1,1 +1,1 @@")
    expect(hunks[0]!.patch).toContain("-alpha = 1")
    expect(hunks[0]!.patch).toContain("+alpha = 2")
    expect(hunks[0]!.rows).toBe(2)
  })

  test("a new file emits one all-added hunk", () => {
    const hunks = unifiedPatch("new.ts", undefined, "a\nb\n")
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.header).toBe("@@ -0,0 +1,2 @@")
    expect(hunks[0]!.patch).toContain("+a")
    expect(hunks[0]!.patch).toContain("+b")
  })

  test("adjacent changes inside the context window merge into one hunk", () => {
    const old = ["a", "x", "y", "b"].join("\n")
    const nu = ["A", "x", "y", "B"].join("\n")
    const hunks = unifiedPatch("f.ts", old, nu)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.patch).toContain(" x")
    expect(hunks[0]!.patch).toContain(" y")
  })
})
