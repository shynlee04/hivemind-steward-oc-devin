# Contributing

## Setup

```sh
bun install
bun test            # full suite — scripted fake ACP, no real account needed
bunx tsgo --noEmit  # typecheck
```

Tests run against `test/fake-acp.ts`, a scripted `devin acp` stand-in. No Devin
account, no OpenCode config, and no captured sessions are required — the suite
is fully self-contained.

## Rules that bite

- Run tests from the repo root — `bunfig.toml` preloads Solid and render tests
  fail vacuously from a subdirectory.
- No `any`, `@ts-ignore`, `@ts-expect-error`.
- A PR needs `bun test` + `tsgo` green (same as CI).

## What isn't in this repo

The verification journeys (`verify-opencode-runtime`, a maintainer-side PTY
harness) and real-session capture replays live in the private development
repository. If a change needs deeper runtime verification, a maintainer runs
that suite before merge — describe what to exercise in the PR body.
