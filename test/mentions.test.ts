import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveMentions } from "../src/mentions"

const dirs: string[] = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "mentions-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("resolveMentions", () => {
  test("plain file mentions resolve to resource links", () => {
    const root = dir()
    writeFileSync(join(root, "note.md"), "hi")
    const links = resolveMentions(root, "check @note.md please")
    expect(links).toHaveLength(1)
    expect(links[0]!.name).toBe("note.md")
    expect(links[0]!.uri).toBe(pathToFileURL(realpathSync(join(root, "note.md"))).href)
  })

  test("a symlink escaping the cwd stays literal — containment is realpath-based", () => {
    const root = dir()
    const outside = dir()
    writeFileSync(join(outside, "secret.env"), "TOKEN=x")
    symlinkSync(join(outside, "secret.env"), join(root, "link.env"))
    expect(resolveMentions(root, "read @link.env")).toHaveLength(0)
    expect(resolveMentions(root, "read @../" + outside.split("/").pop() + "/secret.env")).toHaveLength(0)
  })

  test("a symlink staying inside the cwd resolves to the real target path", () => {
    const root = dir()
    writeFileSync(join(root, "real.txt"), "content")
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"))
    const links = resolveMentions(root, "open @alias.txt")
    expect(links).toHaveLength(1)
    expect(links[0]!.name).toBe("real.txt")
    expect(links[0]!.uri).toBe(pathToFileURL(realpathSync(join(root, "real.txt"))).href)
  })

  test("user@host inside a word and missing files never become mentions", () => {
    const root = dir()
    writeFileSync(join(root, "exists.ts"), "x")
    expect(resolveMentions(root, "mail dev@example.com and @gone.txt")).toHaveLength(0)
    expect(resolveMentions(root, "see @exists.ts")).toHaveLength(1)
  })
})
