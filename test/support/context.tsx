import type { Plugin } from "@opencode/plugin/tui"
import { RGBA, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core"
import { migrateV1, resolveThemeDocument } from "@opencode/theme/tui"
import type { ThemeV1Json } from "@opencode/theme/tui/v1"
import { createSignal, Show, type JSX } from "solid-js"
import themeJson from "./opencode-theme.json"

// A real ResolvedTheme — the view consumes generateSyntax(theme) for markdown
// highlighting, so the hand-rolled color map this used to carry is not enough.
export type TestThemeMode = "dark" | "light"
export const testThemeFor = (mode: TestThemeMode) =>
  resolveThemeDocument(migrateV1(themeJson as ThemeV1Json), mode)
const testTheme = testThemeFor("dark")

type KeymapLayer = Parameters<Plugin.Context["keymap"]["layer"] extends (fn: () => infer L) => void ? (l: L) => void : never>[0]
export type Layer = ReturnType<Plugin.Context["keymap"]["layer"] extends (fn: () => infer L) => void ? () => L : never>
type Command = NonNullable<Layer["commands"]>[number]
type Destination = Parameters<Plugin.Context["ui"]["router"]["navigate"]>[0]
type Route = ReturnType<Plugin.Context["ui"]["router"]["current"]>
type SelectOptions = Parameters<Plugin.Context["ui"]["dialog"]["select"]>[0]

export interface RecordedSelect {
  readonly title: string
  readonly options: readonly { title: string; value: unknown }[]
  resolve: (value: unknown) => void
}

export interface TestContext {
  readonly context: Plugin.Context
  readonly navigations: Destination[]
  readonly selects: RecordedSelect[]
  readonly respondSelect: (index: number | "esc") => void
  readonly dispatch: (id: string, input?: string) => void
  readonly route: () => Route
  readonly registered: Map<string, (input: { data?: Record<string, unknown> }) => unknown>
  readonly slotRenders: ((input: unknown) => unknown)[]
  readonly slotClaims: { readonly path: string; readonly render: (input: unknown) => unknown }[]
  readonly panelsOpened: string[]
  readonly directory: string
  readonly setTheme: (mode: TestThemeMode) => void
  readonly dialogSizes: string[]
  readonly dialogOpen: () => boolean
  // Renders the open dialog's content inside the same render root as the view
  // under test — a second render() root disposes the first when it clears.
  readonly dialogPortal: () => JSX.Element
}

const BIND_ALIASES: Record<string, string> = { enter: "return", esc: "escape", pgdown: "pagedown", pgup: "pageup" }

function matchBind(bind: string, event: KeyEvent): boolean {
  const parts = bind.toLowerCase().split("+")
  const name = BIND_ALIASES[parts[parts.length - 1]!] ?? parts[parts.length - 1]!
  const mods = new Set(parts.slice(0, -1))
  const wantCtrl = mods.delete("ctrl")
  const wantMeta = mods.delete("meta") || mods.delete("opt") || mods.delete("alt")
  const wantShift = mods.delete("shift")
  const wantSuper = mods.delete("super") || mods.delete("cmd") || mods.delete("command")
  const wantHyper = mods.delete("hyper")
  if (mods.size) return false
  const keyName = BIND_ALIASES[event.name] ?? event.name
  if (keyName !== name) return false
  if (event.ctrl !== wantCtrl) return false
  if (event.meta !== wantMeta) return false
  if (event.shift !== wantShift) return false
  if ((event.super ?? false) !== wantSuper) return false
  if ((event.hyper ?? false) !== wantHyper) return false
  return true
}

export function createTestContext(renderer: CliRenderer, directory: string): TestContext {
  const layers: (() => Layer)[] = []
  const navigations: Destination[] = []
  const selects: RecordedSelect[] = []
  const registered = new Map<string, (input: { data?: Record<string, unknown> }) => unknown>()
  const slotRenders: ((input: unknown) => unknown)[] = []
  const slotClaims: { path: string; render: (input: unknown) => unknown }[] = []
  const panelsOpened: string[] = []
  const modes: string[] = ["base"]
  let currentRoute: Route = { type: "home" }
  // The real context.theme is a getter over a live memo; the stub mirrors it
  // with a signal so theme-swap tests exercise the same reactive path.
  const [theme, setThemeSignal] = createSignal(testTheme)
  const setTheme = (mode: TestThemeMode) => setThemeSignal(testThemeFor(mode))

  const layerActive = (layer: Layer): boolean => {
    if (layer.enabled === false) return false
    if (typeof layer.enabled === "function" && !layer.enabled()) return false
    const mode = layer.mode ?? "base"
    if (mode !== "global" && mode !== modes[modes.length - 1]) return false
    if (layer.target !== undefined) {
      const target = layer.target()
      if (target == null || target !== renderer.currentFocusedRenderable) return false
    }
    return true
  }

  // The stub's dialog host mirrors the real DialogProvider: content mounts in
  // an absolute surface over the route, `show` pushes the modal mode, and
  // esc/ctrl+c or clear() unwinds it with the caller's onClose.
  const [dialogContent, setDialogContent] = createSignal<(() => JSX.Element) | undefined>()
  // dialog.set({size}) — the host's medium=60 / large=88 / xlarge=116.
  const dialogWidths = { medium: 60, large: 88, xlarge: 116 } as const
  const [dialogSize, setDialogSize] = createSignal<keyof typeof dialogWidths>("medium")
  const dialogSizes: string[] = []
  let dialogRelease: (() => void) | undefined
  let dialogOnClose: (() => void) | undefined
  // Focus capture mirrors dialog.tsx's replace/refocus: show() blurs and
  // remembers the focused renderable, clear() returns focus to it.
  let dialogFocusRestore: Renderable | null | undefined

  const dialogClear = () => {
    if (dialogContent() === undefined) return
    const onClose = dialogOnClose
    dialogOnClose = undefined
    setDialogContent(undefined)
    setDialogSize("medium")
    dialogRelease?.()
    dialogRelease = undefined
    const restore = dialogFocusRestore
    dialogFocusRestore = undefined
    if (restore && !restore.isDestroyed) restore.focus()
    onClose?.()
  }

  const dialogPortal = () => (
    <Show when={dialogContent()}>
      {(content) => (
        <box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          alignItems="center"
          justifyContent="center"
          zIndex={3000}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          onMouseUp={dialogClear}
        >
          <box
            flexDirection="column"
            width={dialogWidths[dialogSize()]}
            backgroundColor={theme().surface("dialog").background.base}
            paddingTop={1}
            onMouseUp={(e: { stopPropagation(): void }) => e.stopPropagation()}
          >
            {content()()}
          </box>
        </box>
      )}
    </Show>
  )

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    if (event.defaultPrevented || event.propagationStopped) return
    const active = layers
      .map((fn) => fn())
      .filter(layerActive)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    for (const layer of active) {
      for (const command of layer.commands ?? []) {
        if (typeof command.bind !== "string" || !command.bind) continue
        if (!matchBind(command.bind, event)) continue
        if (command.enabled === false) continue
        if (typeof command.enabled === "function" && !command.enabled()) continue
        const result = command.run(undefined, event)
        if (result === false) continue
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }
  })

  const dialogModeCleanup: (() => void)[] = []

  renderer.keyInput.on("keypress", (event: KeyEvent) => {
    if (event.defaultPrevented || event.propagationStopped) return
    if (modes[modes.length - 1] !== "modal") return
    if (event.name === "escape" || (event.ctrl && event.name === "c")) dialogClear()
  })

  const context = {
    options: {},
    location: { directory },
    app: { version: "test", channel: "test" },
    renderer,
    get theme() {
      return theme()
    },
    themeMode: "dark",
    keymap: {
      layer: (input: () => Layer) => {
        layers.push(input)
      },
      dispatch: (id: string, input?: string) => {
        for (const fn of layers) {
          const layer = fn()
          if (!layerActive(layer)) continue
          for (const command of layer.commands ?? []) {
            if (command.id !== id) continue
            void command.run(input)
            return
          }
        }
      },
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: {
        current: () => modes[modes.length - 1]!,
        push: (mode: string) => {
          modes.push(mode)
          const release = () => {
            const idx = modes.lastIndexOf(mode)
            if (idx > 0) modes.splice(idx, 1)
          }
          dialogModeCleanup.push(release)
          return release
        },
      },
    },
    ui: {
      router: {
        register: (page: { name: string; render: (input: { data?: Record<string, unknown> }) => unknown }) => {
          registered.set(page.name, page.render)
          return () => registered.delete(page.name)
        },
        navigate: (destination: Destination) => {
          navigations.push(destination)
          currentRoute = destination as Route
        },
        current: () => currentRoute,
      },
      dialog: {
        show: (renderFn: () => JSX.Element, onClose?: () => void) => {
          if (dialogContent() !== undefined) dialogClear()
          else {
            dialogFocusRestore = renderer.currentFocusedRenderable
            dialogFocusRestore?.blur?.()
          }
          dialogOnClose = onClose
          setDialogContent(() => renderFn)
          dialogRelease = context.keymap.mode.push("modal")
        },
        set: (options: { size?: string }) => {
          if (options?.size) {
            dialogSizes.push(options.size)
            if (options.size in dialogWidths) setDialogSize(options.size as keyof typeof dialogWidths)
          }
        },
        clear: dialogClear,
        alert: async () => { },
        confirm: async () => true,
        prompt: async () => undefined,
        select: (options: SelectOptions) => {
          const record: RecordedSelect = {
            title: options.title,
            options: options.options.map((o) => ({ title: o.title, value: o.value })),
            resolve: () => { },
          }
          const release = context.keymap.mode.push("dialog")
          const promise = new Promise<unknown>((resolvePromise) => {
            record.resolve = (value: unknown) => {
              release()
              resolvePromise(value)
            }
            const onKey = (event: KeyEvent) => {
              if (event.name === "escape" && !event.ctrl && !event.meta) {
                event.preventDefault()
                event.stopPropagation()
                record.resolve(undefined)
              }
            }
            renderer.keyInput.on("keypress", onKey)
            const origResolve = record.resolve
            record.resolve = (value: unknown) => {
              renderer.keyInput.off("keypress", onKey)
              origResolve(value)
            }
          })
          selects.push(record)
          return promise
        },
      },
      toast: { show: () => { } },
      format: { path: (v: string) => v },
      panel: {
        open: (name: string) => {
          panelsOpened.push(name)
          return true
        },
        close: () => { },
        current: () => undefined,
      },
      tabs: {
        enabled: () => false,
        list: () => [],
        open: () => false,
        focus: () => false,
        move: () => false,
        close: () => false,
      },
      model: {
        current: () => undefined,
        variant: { list: () => [], set: () => false },
      },
      slot: (claim: { render: (input: unknown) => unknown } & Partial<Record<"append" | "prepend" | "before" | "after" | "replace", string>>) => {
        const path = claim.append ?? claim.prepend ?? claim.before ?? claim.after ?? claim.replace ?? ""
        slotClaims.push({ path, render: claim.render })
        slotRenders.push(claim.render)
        return () => { }
      },
    },
    data: {
      location: { default: () => ({ directory }) },
      session: {
        get: () => undefined,
        list: () => [],
        root: (id: string) => id,
      },
    },
  }

  return {
    context: context as unknown as Plugin.Context,
    navigations,
    selects,
    respondSelect: (index: number | "esc") => {
      const record = selects[selects.length - 1]
      if (!record) return
      if (index === "esc") {
        record.resolve(undefined)
        return
      }
      record.resolve(record.options[index]?.value)
    },
    dispatch: (id, input) => context.keymap.dispatch(id, input),
    route: () => currentRoute,
    registered,
    slotRenders,
    slotClaims,
    panelsOpened,
    directory,
    setTheme,
    dialogSizes,
    dialogOpen: () => dialogContent() !== undefined,
    dialogPortal,
  }
}
