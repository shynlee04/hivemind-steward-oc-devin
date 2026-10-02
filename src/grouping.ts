import type { Entry } from "./lane"

export type ThoughtEntry = Extract<Entry, { kind: "thought" }>
export type ToolEntry = Extract<Entry, { kind: "tool" }>

// The row grammar the view renders: a plain entry, a merged reasoning run
// (`+ Thought · N steps · dur`), or a merged exploration run
// (`Explored: a, b` — read/search calls collapse like the host's low-verbosity
// activity groups). Single-element runs pass through as `entry`.
export type Row =
  | { kind: "entry"; entry: Entry }
  | { kind: "thoughts"; entries: readonly ThoughtEntry[] }
  | { kind: "explored"; entries: readonly ToolEntry[] }

// toolName is the wire's real tool (cognition.ai/inferenceToolName); toolKind
// covers older captures that lack the meta.
const EXPLORATION = new Set(["read", "grep", "glob", "webfetch", "fetch"])

const exploreName = (entry: ToolEntry): string => entry.toolName ?? entry.toolKind ?? ""

// Consecutive same-agent runs merge; an interleaved agent or any other kind
// ends the run. Pure — the lane's entry list is never touched.
export const groupEntries = (entries: readonly Entry[]): readonly Row[] => {
  const rows: Row[] = []
  let thoughts: ThoughtEntry[] = []
  let explored: ToolEntry[] = []
  const flushThoughts = (): void => {
    if (thoughts.length === 1) rows.push({ kind: "entry", entry: thoughts[0]! })
    else if (thoughts.length > 1) rows.push({ kind: "thoughts", entries: thoughts })
    thoughts = []
  }
  const flushExplored = (): void => {
    if (explored.length === 1) rows.push({ kind: "entry", entry: explored[0]! })
    else if (explored.length > 1) rows.push({ kind: "explored", entries: explored })
    explored = []
  }
  for (const entry of entries) {
    if (entry.kind === "thought") {
      flushExplored()
      if (thoughts.length > 0 && thoughts[thoughts.length - 1]!.agent !== entry.agent) flushThoughts()
      thoughts.push(entry)
      continue
    }
    if (entry.kind === "tool" && EXPLORATION.has(exploreName(entry))) {
      flushThoughts()
      if (explored.length > 0 && explored[explored.length - 1]!.agent !== entry.agent) flushExplored()
      explored.push(entry)
      continue
    }
    flushThoughts()
    flushExplored()
    rows.push({ kind: "entry", entry })
  }
  flushThoughts()
  flushExplored()
  return rows
}
