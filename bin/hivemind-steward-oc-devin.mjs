#!/usr/bin/env node
// Installer + prerequisite check for hivemind-steward-oc-devin.
//
//   npx hivemind-steward-oc-devin                 # verify clients, wire global scope
//   npx hivemind-steward-oc-devin --project [dir] # wire <dir>/opencode.json instead
//   npx hivemind-steward-oc-devin --check         # prerequisites only, no writes
//   npx hivemind-steward-oc-devin --spec github:owner/repo --project .
//
// Exit codes: 0 ok · 1 opencode missing/not v2 · 2 devin missing · 3 config error
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"

const PKG = "hivemind-steward-oc-devin"
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (flag("--help") || flag("-h")) {
  console.log(`Usage: npx ${PKG} [--project [dir]] [--spec <spec>] [--check] [--force]`)
  process.exit(0)
}

const onPath = (bin) => {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, bin + ext)
      try {
        accessSync(p, constants.X_OK)
        return p
      } catch {}
    }
  }
  return undefined
}

const fail = (code, lines) => {
  for (const l of lines) console.error(l)
  process.exit(code)
}

const opencode = onPath("opencode")
if (!opencode) {
  fail(1, [
    `[${PKG}] opencode is not on PATH.`,
    `This plugin requires OpenCode V2 (a V1 host cannot load the TUI entry).`,
    `Install OpenCode v2 first, then re-run this installer.`,
  ])
}
const ver = spawnSync(opencode, ["--version"], { encoding: "utf8" })
const major = parseInt(String(ver.stdout ?? "").match(/\d+/)?.[0] ?? "0", 10)
if (!(major >= 2)) {
  fail(1, [
    `[${PKG}] opencode --version reported "${String(ver.stdout).trim()}" — expected v2.x.`,
    `Upgrade OpenCode to v2, then re-run this installer.`,
  ])
}

const devinEnv = process.env.DEVIN_BIN
const devin = devinEnv ?? onPath("devin")
const devinOk = devinEnv ? existsSync(devinEnv) : Boolean(devin)
if (!devinOk && !flag("--force")) {
  fail(2, [
    `[${PKG}] devin binary not found${devinEnv ? ` at DEVIN_BIN=${devinEnv}` : " on PATH"}.`,
    `The plugin spawns \`devin acp\`; without the binary it fails at runtime.`,
    `Install the Devin CLI (or set DEVIN_BIN to its path), run \`devin auth login\`, then re-run.`,
    `Pass --force to wire the plugin anyway.`,
  ])
}

if (flag("--check")) {
  console.log(`[${PKG}] ok: opencode ${String(ver.stdout).trim()} · devin ${devin ?? "(missing)"}`)
  process.exit(0)
}

const spec = value("--spec") ?? PKG
const projectIdx = args.indexOf("--project")
const scope =
  projectIdx >= 0
    ? path.resolve(
        typeof args[projectIdx + 1] === "string" && !args[projectIdx + 1].startsWith("-")
          ? args[projectIdx + 1]
          : ".",
      )
    : process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
      : path.join(homedir(), ".config", "opencode")

const candidates = [
  path.join(scope, "opencode.json"),
  path.join(scope, "opencode.jsonc"),
  path.join(scope, ".opencode", "opencode.json"),
  path.join(scope, ".opencode", "opencode.jsonc"),
]
const configPath = candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile()) ?? candidates[0]

const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}"
const errors = []
const config = parse(text, errors, { allowTrailingComma: true })
if (errors.length || typeof config !== "object" || config === null || Array.isArray(config)) {
  fail(3, [
    `[${PKG}] cannot safely edit ${configPath} (invalid JSONC).`,
    `Add this entry manually: { "plugins": ["${spec}", ...] }`,
  ])
}
const plugins = "plugins" in config ? config.plugins : undefined
if (plugins !== undefined && !Array.isArray(plugins)) {
  fail(3, [`[${PKG}] ${configPath} has a non-array "plugins" — fix or edit manually.`])
}
const already = (plugins ?? []).some(
  (e) => e === spec || e === PKG || (typeof e === "object" && e !== null && e.package === spec),
)

if (already) {
  console.log(`[${PKG}] already configured in ${configPath}`)
} else {
  const updated = applyEdits(
    text,
    modify(text, ["plugins"], [...(plugins ?? []), spec], {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    }),
  )
  mkdirSync(path.dirname(configPath), { recursive: true })
  const tmp = configPath + ".tmp"
  writeFileSync(tmp, updated.endsWith("\n") ? updated : updated + "\n", { mode: 0o600 })
  renameSync(tmp, configPath)
  console.log(`[${PKG}] added "${spec}" to plugins in ${configPath}`)
}

console.log(`[${PKG}] next: restart OpenCode, then run /devin — the session picker means it works.`)
console.log(`[${PKG}] if Devin asks for auth: devin auth login`)
