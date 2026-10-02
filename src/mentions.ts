import { existsSync, realpathSync, statSync, type Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { PromptContent } from "./acp"

export type ResourceLink = Extract<PromptContent, { type: "resource_link" }>

// File mentions (REQ-FILE-01): a whitespace-delimited `@<path>` at a word
// boundary resolves under the lane cwd into a Resource reference. `@`
// inside a word (user@host) never counts; a token outside the lane cwd or
// matching nothing on disk stays literal text (E33/E34). Symlinks are
// resolved before the containment check — a link escaping the cwd stays
// literal, and the URI sent is always the real target path. Directories
// pass through — Devin resolves them server-side (E36).
export function resolveMentions(cwd: string, text: string): ResourceLink[] {
  const root = realpathSync(resolve(cwd))
  const links: ResourceLink[] = []
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const abs = resolve(root, match[1]!)
    if (!existsSync(abs)) continue
    const real = realpathSync(abs)
    if (real !== root && !real.startsWith(`${root}${sep}`)) continue
    const directory = statSync(real).isDirectory()
    links.push({
      type: "resource_link",
      uri: pathToFileURL(real).href,
      name: basename(real),
      mimeType: directory ? undefined : Bun.file(real).type,
    })
  }
  return links
}

// Live bounded walk under the lane cwd for `@` completion — the view never
// touches the disk itself (PROH-12 parallel). Shallow entries come first;
// .git and node_modules are never listed; directories carry a trailing "/"
// so picking one re-queries inside it.
export async function fileCandidates(cwd: string, prefix: string): Promise<string[]> {
  const root = resolve(cwd)
  const out: string[] = []
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }]
  let head = 0
  let visited = 0
  while (head < queue.length && out.length < 100 && visited < 5_000) {
    const cur = queue[head++]!
    let entries: Dirent[]
    try {
      entries = await readdir(cur.abs, { withFileTypes: true })
    } catch {
      continue
    }
    visited += entries.length
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const rel = cur.rel === "" ? entry.name : `${cur.rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (cur.depth < 6) queue.push({ abs: join(cur.abs, entry.name), rel, depth: cur.depth + 1 })
        if (rel.startsWith(prefix)) out.push(`${rel}/`)
      } else if (rel.startsWith(prefix)) {
        out.push(rel)
      }
      if (out.length >= 100) break
    }
  }
  return out
}
