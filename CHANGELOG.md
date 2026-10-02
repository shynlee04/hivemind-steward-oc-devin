# Changelog

## Unreleased

Initial public drop of the OpenCode V2 plugin: `/devin` route with live ACP
streaming, session picker and session swap, permission cards, `@file`
mentions, dock overlays, palette commands, and `devin_run` / `devin_session` /
`devin_doctor` agent tools.

Notable hardening in this drop:

- `auto_approve` on the delegation tools now defaults to **false** and picks
  permission options by label semantics — deny-shaped labels are never
  auto-selected.
- `@` mention containment resolves symlinks before the cwd check.
