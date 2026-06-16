# Contributing to horizon-mcp

Thanks for your interest. This document covers how to build, test, and submit changes.

## Prerequisites

- Windows (the server runs only on Windows; see the README).
- Node.js 18 or later.

## Getting started

```powershell
npm install
npm run build      # tsc: src → dist
npm test           # run the unit tests
npm run typecheck  # type-check without emitting
npm run lint       # eslint (run before opening a PR)
npm run format     # prettier --write (format:check for a dry run)
```

## Project layout

- `src/index.ts` — MCP server: tool definitions, request handlers, and all PowerShell /
  Win32 execution.
- `src/input.ts` — pure, side-effect-free helpers (key tables, escaping, validation).
  Logic that can be unit-tested lives here; keep it free of I/O.
- `src/input.test.ts` — unit tests (`node:test`).
- `dist/` — compiled output, **committed** to the repository (see below).

## The committed-`dist/` rule

`dist/index.js` is committed so the server runs without a build step. Therefore, **any
change to `src/` must be accompanied by its rebuilt `dist/`**. Run `npm run build` before
committing; CI fails if the committed `dist/` is out of sync with `src/`.

## Standards

- **No cruft.** No debug logging, commented-out blocks, or `TODO`/`FIXME` litter in
  committed code.
- **Keep docs current.** If you change or add a tool, update `README.md` (the canonical
  tool reference) in the same change.
- **No secrets.** Never commit API keys, passwords, tokens, `.env` contents, or paths
  containing personal information.
- **Minimal dependencies.** A core selling point is zero external binaries beyond Node —
  screen capture, input, and OCR all use built-in Windows/.NET facilities. Do not add
  native modules or heavy libraries; justify any new dependency.
- **Validate input that reaches a script.** String input embedded in PowerShell must be
  escaped (`escapePsSingleQuote`); numeric input must be validated (`requireInt` /
  `requireFinite`). Never interpolate raw user input into a command string.

## Scope

horizon-mcp is the **stateless capability layer** of a two-part system. Keep it a generic
automation primitive. Application-specific behavior, state, scheduling, and any data
persistence belong in the application layer — see [ARCHITECTURE.md](ARCHITECTURE.md).

The following are **out of scope** and will not be merged: telemetry or phone-home
behavior; screen/keystroke recording; scheduled capture; and scrape-and-store or other
data-persistence features.

## Commit messages

Use conventional, descriptive messages: a concise imperative subject (≤ 72 chars) and a
body explaining what changed and why.

## Pull requests

Before opening a PR, make sure `npm run build`, `npm test`, `npm run typecheck`, and
`npm run lint` all pass and that `dist/` is in sync. Describe the change and its
rationale, and update the README and CHANGELOG when behavior changes.
