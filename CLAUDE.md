# horizon-mcp

Guidance for working on this repository. Keep it accurate; update it when the project changes.

## Project context

horizon-mcp is an **MCP server** that gives Claude screen, mouse, keyboard, and window control on a Windows desktop — screenshots, clicks, typing, key chords, clipboard, OCR, and window management. It is built to automate enterprise applications running inside the **Omnissa Horizon Client** (remote desktop / published apps), but the tools work on any Windows application.

- **Language / runtime:** TypeScript, Node.js 18+.
- **Platform:** Windows only. All OS interaction goes through PowerShell and Win32 (`user32.dll`) P/Invoke; it does not run on macOS or Linux.
- **Transport:** stdio (the standard for local MCP servers); the MCP client spawns and manages the process.
- **Companion:** this is the **capability layer** of a two-part system; the companion `horizon-monitor` is the **application layer**. The mechanism-vs-policy split and the rule for where a feature belongs are in [ARCHITECTURE.md](ARCHITECTURE.md) — consult it before adding any app-specific logic here (it does not belong in the server).

The full tool reference lives in [README.md](README.md); do not duplicate it here. The tools, grouped: screen capture (`screenshot`, `screenshot_region`, `get_pixel_color`), mouse (`click`, `double_click`, `scroll`, `move_mouse`, `mouse_drag`), keyboard (`type_text`, `press_key`, `key_combo`, `paste_text`), windows (`list_windows`, `focus_window`, `get_foreground_window`), clipboard (`get_clipboard`, `set_clipboard`), text extraction (`ocr`), and timing (`wait`).

## Ownership and attribution

- **Owner:** SensAI LLC. The repo lives under the `sensaiworks` org — remote: `https://github.com/sensaiworks/horizon-mcp`.
- **Commit authorship:** commits must be authored with the **maintainer's personal Git identity** (`Dmitry Goubar <174258986+dmitry-goubar@users.noreply.github.com>`) so contributions count on the personal GitHub profile, even though the repo is org-owned. Verify with `git log -1 --format='%an <%ae>'` before pushing; if the repo-local `git config user.email` is set to the org address, set it to the personal identity for this repo.
- This is a **public** repository and a portfolio piece / Anthropic partner application. Code and history represent SensAI professionally.

## Build and layout

```powershell
npm install
npm run build      # tsc: src → dist
npm test           # unit tests (node:test, via tsx)
npm run typecheck  # type-check without emitting
```

- `src/index.ts` — MCP server: tool definitions, request handlers, and all PowerShell / Win32 execution.
- `src/input.ts` — pure, side-effect-free helpers (key tables, escaping, validation). Unit-testable logic goes here; keep it free of I/O.
- `src/input.test.ts` — unit tests (excluded from the build).
- `dist/` — compiled output, **committed**.

`dist/index.js` is **committed** so the server runs without a build step. Therefore: **rebuild before committing any `src/` change** — never commit a `src/` edit without its regenerated `dist/`, or the published server goes stale. CI verifies `dist/` is in sync, and the `commit-mcp` skill enforces the rebuild.

## Standards to maintain

- **Public and professional.** No debug cruft, no commented-out code blocks, no `TODO`/`FIXME` litter in committed code. Leave the tree clean.
- **README stays current.** If you change or add functionality, update [README.md](README.md) in the same change so docs never lag the code.
- **No secrets, ever.** Never commit API keys, passwords, tokens, `.env` contents, or paths containing personal info. Local-only files (`.mcp.json`, `.env*`, `node_modules/`, logs, `.claude/settings.local.json`) stay gitignored and unstaged.
- **Security posture.** This tool has **unrestricted desktop access** — it can read any pixel, click anywhere, and type into any focused window. Keep the README's security warnings prominent and accurate; if a change alters the access surface, update them. Never weaken or remove the warning that it must only be connected to trusted clients and never exposed over a network transport.
- **Minimal dependencies.** The selling point is zero external binaries beyond Node — screen capture, input, and OCR all use built-in Windows/.NET facilities. Do not add native modules, image libraries, OCR engines, or automation frameworks. Justify any new npm dependency against this bar before adding it.
- **Commit messages.** Conventional, descriptive, imperative subject; explain what changed and why.

## What NOT to do

- **No data-extraction, monitoring, or persistence features.** Keep this a clean, stateless automation *primitive* — not a surveillance or data-harvesting tool. Logging keystrokes/screens to disk, scraping-and-storing, scheduled capture, and similar belong (if anywhere) in the application layer, never here. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **No telemetry or phone-home behavior.** The server makes no outbound network calls. It must not collect, report, or transmit usage, screenshots, or any other data anywhere.

## Working knowledge

- **Two keyboard paths.** `type_text`/`press_key` use SendKeys (literal text and a fixed set of named keys) but cannot send the Windows key or `Ctrl+Alt+Del`. `key_combo`/`paste_text` use `keybd_event` with raw virtual-key codes and can send any modifier chord — required to drive a remote Horizon session (`Win+R`, `Alt+Tab`, `Ctrl+Alt+Insert`).
- **Horizon renders the remote desktop as pixels inside one host window.** `list_windows`/`focus_window` see only **host** windows; they cannot enumerate or activate a window *inside* the remote session. Drive the remote by focusing the Horizon window, then sending input it forwards. The local host lock screen runs on Windows' secure desktop and cannot receive synthetic input — only the remote VM session can be unlocked this way.
- **Injection safety.** Windows operations run through PowerShell via `-EncodedCommand` (UTF-16LE base64). Virtual-key codes are looked up from a fixed table and emitted as integers, so user input is never interpolated into a script. Preserve this when editing — do not build PowerShell command strings from raw user input.
