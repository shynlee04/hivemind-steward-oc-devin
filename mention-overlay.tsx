import { createSignal, For, Show, onCleanup } from "solid-js"
import { RGBA, TextAttributes, type BoxRenderable, type TextareaRenderable } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import type { AvailableCommand, DevinLane } from "./src/lane"

type Theme = Plugin.Context["theme"]

interface MentionQuery {
  readonly at: number
  readonly prefix: string
}

// REQ-ATSKILL-01: @ completion mixes wire-exposed commands with file paths —
// the wire publishes no skill surface beyond available_commands_update.
export type MentionRow =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "command"; readonly command: AvailableCommand }

// File mentions (REQ-FILE-01): a trailing `@token` under the cursor opens a
// completion panel over lane-supplied paths. It shares the overlay grammar
// (digits/arrows/⏎/esc) but never takes focus — the composer keeps typing.
export function createMentionOverlay(deps: {
  readonly lane: DevinLane
  readonly textEl: () => TextareaRenderable | undefined
  readonly overlayActive: () => boolean
  readonly resetHighlight: () => void
}) {
  const [mention, setMention] = createSignal<MentionQuery | undefined>(undefined)
  const [rows, setRows] = createSignal<MentionRow[]>([])
  let seq = 0
  let dismissed: MentionQuery | undefined

  const open = () => mention() !== undefined && rows().length > 0 && !deps.overlayActive()

  const refresh = () => {
    const field = deps.textEl()
    if (!field || field.isDestroyed || deps.lane.sessionId === "") return
    const offset = field.editBuffer.getCursorPosition().offset
    const match = /(?:^|\s)@(\S*)$/.exec(field.plainText.slice(0, offset))
    if (!match) {
      setMention(undefined)
      setRows([])
      dismissed = undefined
      return
    }
    const query: MentionQuery = { at: match.index + match[0].length - match[1]!.length - 1, prefix: match[1]! }
    // esc dismisses for the remainder of the token — typing on keeps it shut;
    // erasing back under the dismissed prefix (or a fresh @ elsewhere) reopens.
    if (dismissed && query.at === dismissed.at && query.prefix.startsWith(dismissed.prefix)) return
    setMention(query)
    deps.resetHighlight()
    const prefix = query.prefix.toLowerCase()
    const commandRows: MentionRow[] = deps.lane.availableCommands
      .filter((c) => c.name.toLowerCase().includes(prefix))
      .map((command): MentionRow => ({ kind: "command", command }))
    const generation = ++seq
    void deps.lane.fileCandidates(query.prefix).then((candidates) => {
      if (generation === seq)
        // The host autocomplete caps at 10 visible options; the popover never
        // scrolls beyond them, so deeper hits are unreachable anyway.
        setRows([...commandRows, ...candidates.map((path): MentionRow => ({ kind: "file", path }))].slice(0, 10))
    })
  }

  const insert = (row: MentionRow) => {
    const field = deps.textEl()
    const query = mention()
    if (!field || field.isDestroyed || !query) return
    const end = field.editBuffer.getCursorPosition().offset
    const text = field.plainText
    // Command picks swap the @token for the slash form — same grammar the
    // commands overlay inserts — while files keep the @path spelling.
    if (row.kind === "command") {
      const insertText = `/${row.command.name} `
      field.setText(`${text.slice(0, query.at)}${insertText}${text.slice(end)}`)
      field.editBuffer.setCursorByOffset(query.at + insertText.length)
      dismissed = undefined
      setMention(undefined)
      setRows([])
      return
    }
    const dir = row.path.endsWith("/")
    const insertText = `@${row.path}${dir ? "" : " "}`
    field.setText(`${text.slice(0, query.at)}${insertText}${text.slice(end)}`)
    field.editBuffer.setCursorByOffset(query.at + insertText.length)
    dismissed = undefined
    setMention(undefined)
    setRows([])
    if (dir) refresh()
  }

  const dismiss = () => {
    dismissed = mention()
    setMention(undefined)
    setRows([])
  }

  return { open, rows, refresh, insert, dismiss }
}

// The host autocomplete's SplitBorder rails (ui/border.ts): `┃` sides only,
// no top/bottom rule — the popover floats directly above the composer.
const RAILS = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  top: "",
  bottom: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
}

const truncateMiddle = (text: string, width: number): string => {
  if (text.length <= width) return text
  if (width <= 4) return text.slice(0, Math.max(0, width))
  const head = Math.ceil((width - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`
}

// Host autocomplete grammar (component/prompt/autocomplete.tsx): an absolute
// popover anchored above the composer — capped at 10 rows, `┃` rails, nowrap
// truncation, selection painted as a raised-action background. Never in-flow:
// it must not push the composer or the stream.
export function MentionPanel(props: {
  readonly rows: readonly MentionRow[]
  readonly highlight: number
  readonly theme: Theme
  readonly anchor?: () => BoxRenderable | undefined
  readonly onPick?: (row: MentionRow) => void
  readonly onHover?: (index: number) => void
}) {
  const raised = () => props.theme.surface("dialog")
  // Layout shifts (textarea growth, dock) move the anchor without touching
  // rows — the 50ms tick mirrors the host's position poller.
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), 50)
  onCleanup(() => clearInterval(timer))

  const position = () => {
    tick()
    const anchor = props.anchor?.()
    if (!anchor || anchor.isDestroyed) return { x: 0, y: 0, width: 0 }
    const parent = anchor.parent
    return { x: anchor.x - (parent?.x ?? 0), y: anchor.y - (parent?.y ?? 0), width: anchor.width }
  }
  const height = () => Math.min(10, props.rows.length, Math.max(1, position().y))
  const contentWidth = () => Math.max(1, position().width - 4)

  return (
    <box
      position="absolute"
      top={position().y - height()}
      left={position().x}
      width={position().width}
      zIndex={100}
      border={["left", "right"]}
      customBorderChars={RAILS}
      borderColor={raised().border.base}
      backgroundColor={raised().background.base}
    >
      <scrollbox height={height()} scrollbarOptions={{ visible: false }} backgroundColor={raised().background.base}>
        <For each={props.rows}>
          {(row, i) => {
            const active = () => i() === props.highlight
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? raised().background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                onMouseDown={() => props.onHover?.(i())}
                onMouseMove={() => props.onHover?.(i())}
                onMouseUp={() => props.onPick?.(row)}
              >
                <text
                  wrapMode="none"
                  flexShrink={0}
                  fg={active() ? raised().text.action.primary.focused : raised().text.base}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                >
                  {truncateMiddle(row.kind === "command" ? `/${row.command.name}` : row.path, contentWidth())}
                </text>
                <Show when={row.kind === "command" && row.command.description}>
                  <text
                    wrapMode="none"
                    flexShrink={1}
                    minWidth={0}
                    fg={active() ? raised().text.action.primary.focused : raised().text.muted}
                  >
                    {` ${row.kind === "command" ? (row.command.description ?? "") : ""}`.replace(/\s+/g, " ")}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}
