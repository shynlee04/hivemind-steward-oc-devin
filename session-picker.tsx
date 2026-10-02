import type { Plugin } from "@opencode/plugin/tui"
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { JSX } from "solid-js"
import { NEW_SESSION, type DevinLane, type SessionDescriptor } from "./src/lane"

// The picker's selectable model — one flat list in display order. Category
// headers derive from each row and render between groups, so keyboard and
// mouse both index the same list.
type PickerRow =
  | { readonly kind: "new" }
  | { readonly kind: "session"; readonly descriptor: SessionDescriptor; readonly category: string }

const tilde = (path: string, cwd: string): string => {
  const home = process.env.HOME ?? ""
  const p = path || cwd
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}

const relTime = (iso: string | undefined): string => {
  if (!iso) return ""
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Title rows get one line inside the large dialog (88 cols minus padding and
// the marker) — anything longer truncates instead of wrapping mid-string.
const truncate = (text: string, width = 72): string =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text

// Paths tail-truncate: the basename carries the identity, the leading dirs are
// boilerplate under $TMPDIR/$HOME.
const tail = (text: string, width: number): string =>
  text.length > width ? `…${text.slice(text.length - width + 1)}` : text

const categoryFor = (iso: string | undefined): string => {
  const at = Date.parse(iso ?? "")
  if (Number.isNaN(at)) return "Sessions"
  const date = new Date(at)
  return date.toDateString() === new Date().toDateString() ? "Today" : date.toDateString()
}

function DevinSessionPicker(props: {
  context: Plugin.Context
  lane: DevinLane
  cwd: string
  onPick: (row: PickerRow) => void
}) {
  const context = props.context
  const lane = props.lane
  const theme = () => context.theme.surface("dialog")

  const [filter, setFilter] = createSignal("")
  const [sessions, setSessions] = createSignal<SessionDescriptor[]>([...lane.sessions])
  const [fetch, setFetch] = createSignal(lane.sessionsFetch)
  const [highlight, setHighlight] = createSignal(
    Math.max(
      0,
      1 + lane.sessions.findIndex((d) => d.sessionId === lane.sessionId),
    ),
  )
  // The stub keymap keeps registered layers forever; the gate inert-lists this
  // layer once the dialog content unmounts (the real host disposes it with the
  // component either way).
  const [alive, setAlive] = createSignal(true)

  const sink = {
    notify: () => {
      setSessions([...lane.sessions])
      setFetch(lane.sessionsFetch)
    },
  }
  lane.attach(sink)
  onCleanup(() => {
    lane.detach(sink)
    setAlive(false)
  })

  onMount(() => {
    context.ui.dialog.set({ size: "large" })
    void lane.refreshSessions()
  })

  // Wire order is canonical (REQ-PICK-01) — never re-sort. Date headers mark
  // where the descriptor's day changes in that order, so an interleaved date
  // earns its own header run rather than a regrouped list.
  const rows = createMemo<PickerRow[]>(() => {
    const q = filter().trim().toLowerCase()
    const descriptors = sessions().filter(
      (d) =>
        !q ||
        (d.title || d.sessionId).toLowerCase().includes(q) ||
        (d.cwd ?? "").toLowerCase().includes(q) ||
        d.sessionId.toLowerCase().includes(q),
    )
    return [
      { kind: "new" },
      ...descriptors.map(
        (descriptor): PickerRow => ({ kind: "session", descriptor, category: categoryFor(descriptor.updatedAt) }),
      ),
    ]
  })

  const fetchError = () => {
    const f = fetch()
    return f.kind === "error" ? f.message : ""
  }

  const showCategory = (index: number): string | undefined => {
    const row = rows()[index]
    if (row?.kind !== "session") return undefined
    const prev = rows()[index - 1]
    return prev?.kind === "session" && prev.category === row.category ? undefined : row.category
  }

  const pick = (row: PickerRow | undefined) => {
    if (row) props.onPick(row)
  }

  const dismiss = () => context.ui.dialog.clear()

  context.keymap.layer(() => ({
    mode: "modal",
    enabled: alive,
    commands: [
      {
        bind: "up",
        title: "Previous session",
        group: "Devin",
        run: () => setHighlight((h) => (rows().length ? (h - 1 + rows().length) % rows().length : 0)),
      },
      {
        bind: "down",
        title: "Next session",
        group: "Devin",
        run: () => setHighlight((h) => (rows().length ? (h + 1) % rows().length : 0)),
      },
      {
        bind: "pageup",
        title: "Page up",
        group: "Devin",
        run: () => setHighlight((h) => Math.max(0, h - 10)),
      },
      {
        bind: "pagedown",
        title: "Page down",
        group: "Devin",
        run: () => setHighlight((h) => Math.min(rows().length - 1, h + 10)),
      },
      {
        bind: "home",
        title: "First session",
        group: "Devin",
        run: () => setHighlight(0),
      },
      {
        bind: "end",
        title: "Last session",
        group: "Devin",
        run: () => setHighlight(Math.max(0, rows().length - 1)),
      },
      {
        bind: "return",
        title: "Choose session",
        group: "Devin",
        run: () => pick(rows()[highlight()]),
      },
    ],
  }))

  const rowFg = (active: boolean, muted: boolean) =>
    active ? theme().text.action.primary.focused : muted ? theme().text.muted : theme().text.base

  const meta = (d: SessionDescriptor) =>
    [tail(tilde(d.cwd ?? "", props.cwd), 40), relTime(d.updatedAt), d.sessionId]
      .filter((s) => s !== "")
      .join(" · ")

  let inputEl: InputRenderable | undefined

  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4} flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text.base}>
            <b>Sessions</b>
            <span style={{ fg: theme().text.muted }}>{` for ${tilde(props.cwd, props.cwd)}`}</span>
          </text>
          <text fg={theme().text.muted} onMouseUp={dismiss}>
            esc
          </text>
        </box>
        <box paddingTop={1}>
          <input
            onInput={(value) => {
              setFilter(value)
              setHighlight(0)
            }}
            focusedBackgroundColor={theme().background.formfield.focused}
            cursorColor={theme().text.formfield.focused}
            focusedTextColor={theme().text.formfield.focused}
            ref={(r) => {
              inputEl = r
              setTimeout(() => {
                if (inputEl && !inputEl.isDestroyed) inputEl.focus()
              }, 1)
            }}
            placeholder="Search sessions"
            placeholderColor={theme().text.muted}
          />
        </box>
      </box>
      {/* Host DialogSelect bounds the list to half the terminal height minus
          chrome — without it the column outgrows the screen and the footer clips. */}
      <scrollbox flexGrow={1} flexShrink={1} maxHeight={Math.max(6, Math.floor(context.renderer.terminalHeight / 2) - 6)}>
        <For each={rows()}>
          {(row, i) => {
            const active = () => i() === highlight()
            return (
              <box flexDirection="column" paddingLeft={4} paddingRight={4}>
                <Show when={showCategory(i())}>
                  {(category) => (
                    // Host dialog-select group headers: bold accent label.
                    <text fg={theme().text.action.primary.base} attributes={TextAttributes.BOLD} paddingTop={1}>
                      {category()}
                    </text>
                  )}
                </Show>
                <box
                  flexDirection="column"
                  backgroundColor={active() ? theme().background.action.primary.focused : RGBA.fromInts(0, 0, 0, 0)}
                  onMouseMove={() => setHighlight(i())}
                  onMouseUp={() => pick(row)}
                >
                  {row.kind === "new" ? (
                    // Host rows carry no arrow marker — the focused
                    // background is the whole affordance.
                    <text fg={rowFg(active(), false)}>
                      {`  + New session in ${tilde(props.cwd, props.cwd)}`}
                    </text>
                  ) : (
                    <>
                      <text fg={rowFg(active(), false)}>
                        {`  ${truncate(row.descriptor.title || row.descriptor.sessionId, 58)}${row.descriptor.sessionId === lane.sessionId ? " ●" : ""}`}
                        <Show when={row.descriptor.isLocked}>
                          <span style={{ fg: theme().text.feedback.warning.base }}>
                            {` ⚿${row.descriptor.lockHolderPid !== undefined ? ` ${row.descriptor.lockHolderPid}` : ""}`}
                          </span>
                        </Show>
                      </text>
                      <text fg={rowFg(active(), true)}>
                        {`    ${truncate(meta(row.descriptor), 72)}`}
                      </text>
                    </>
                  )}
                </box>
              </box>
            )
          }}
        </For>
        <Show when={fetch().kind === "loading"}>
          <text fg={theme().text.muted} paddingLeft={4}>
            {"  … listing Devin sessions…"}
          </text>
        </Show>
        <Show when={fetchError() !== ""}>
          <text fg={theme().text.feedback.warning.base} paddingLeft={4}>
            {`  ! could not list sessions: ${fetchError()}`}
          </text>
        </Show>
        <Show when={fetch().kind === "ready" && filter().trim() === "" && rows().length === 1}>
          <text fg={theme().text.muted} paddingLeft={4}>
            {"  No Devin sessions on this directory yet"}
          </text>
        </Show>
        <Show when={filter().trim() !== "" && rows().length === 1}>
          <text fg={theme().text.muted} paddingLeft={4}>
            {"  No sessions found"}
          </text>
        </Show>
      </scrollbox>
      <box paddingLeft={4} paddingRight={4}>
        <text fg={theme().text.muted}>{"↑/↓ move · type to filter · ⏎ choose · esc dismiss"}</text>
      </box>
    </box>
  )
}

// Mounts the picker inside the host dialog chrome (backdrop, themed surface,
// esc/ctrl+c, focus restore all host-owned). `onDismissed` fires when the
// dialog closes without a pick — the unbound route uses it to go home.
// `onClosed` fires on every close with whether a pick drove it.
export function openSessionPicker(input: {
  context: Plugin.Context
  lane: DevinLane
  cwd: string
  onDismissed?: () => void
  onClosed?: (picked: boolean) => void
}): void {
  let picked = false
  input.context.ui.dialog.show(
    () => (
      <DevinSessionPicker
        context={input.context}
        lane={input.lane}
        cwd={input.cwd}
        onPick={(row) => {
          picked = true
          // bind() before clear(): the synchronous half of bind flips
          // lane.binding, so the close callback fires while the lane is
          // already in-flight and the view's unbound-picker effect stays shut.
          void input.lane.bind(row.kind === "new" ? NEW_SESSION : row.descriptor)
          input.context.ui.dialog.clear()
        }}
      />
    ),
    () => {
      if (!picked) input.onDismissed?.()
      input.onClosed?.(picked)
    },
  )
}
