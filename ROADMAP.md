# Roadmap

Planned improvements for horizon-mcp, grouped by theme and ordered roughly by
impact. This is a living document — items move to the changelog as they ship.
Status: ✅ done · 🔜 planned · 💤 deferred (needs maintainer action or carries risk
that requires real-desktop testing).

The project's scope boundary still governs every item here: horizon-mcp is the
**stateless capability layer**. Features that record, store, schedule, or harvest
data belong in the application layer, not here — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Engineering quality

- ✅ Extract pure input/validation logic into a side-effect-free module (`src/input.ts`).
- ✅ Unit tests for the pure logic (`node:test`, no extra runtime dependency).
- ✅ Continuous integration (build, typecheck, test, and a committed-`dist/` sync check).
- ✅ Input validation: finite-number checks for coordinates with clear error messages.
- ✅ Hardening: per-call PowerShell timeout, Windows-platform startup guard, server
  version read from `package.json` instead of being hardcoded.
- ✅ Fix `ocr` on Windows PowerShell 5.1 (the WinRT `AsTask` await bridge returned a null
  array). Root-caused and verified against a live Horizon session.
- ✅ Force UTF-8 PowerShell output so non-ASCII characters in window titles, clipboard, and
  OCR text are no longer mangled.
- ✅ ESLint (flat config) + Prettier with `lint`/`format`/`format:check` scripts. Wiring
  the lint step into `ci.yml` is pending the `workflow` PAT scope (see maintainer notes).
- ✅ Stronger error propagation from PowerShell: scripts run with `Stop` error action and
  a call that errors or returns nothing-but-errors is reported instead of silently
  returning empty output.
- 💤 **Performance: persistent PowerShell runspace.** Today every tool call spawns a new
  `powershell.exe` and recompiles its inline C# via `Add-Type` (~150–400 ms each). A
  long-lived runspace would cut per-call latency dramatically. Deferred because it is a
  substantial change that must be validated against a real desktop and remote session.

## Distribution

- ✅ Package for `npx` execution (`bin` entry + shebang + `files` allowlist) so the
  server can be run without cloning or building.
- 💤 **Publish to npm.** Requires the maintainer's npm credentials — prepared but not
  performed here.
- 💤 **List in MCP registries** (official servers list, awesome-mcp-servers, Smithery,
  Glama, mcp.so). Requires accounts/submissions outside the repo.

## Functionality

Each item below changes desktop behavior and needs validation on a real Windows
session before shipping, so they are planned rather than done.

- ✅ **OCR with bounding boxes** — `ocr` returns per-line and per-word coordinates in
  absolute screen pixels so the model can click located text instead of paying Vision
  tokens to re-locate it. Stays generic.
- ✅ **`get_window_rect`** — returns a window's screen rectangle, so automations can target
  coordinates relative to a window rather than absolute positions.
- ✅ **`wait_for` helpers** — `wait_for_pixel` (poll until a pixel matches a color) and
  `wait_for_text` (poll OCR until a substring appears, returning its bounding box),
  replacing brittle fixed `wait` calls.
- ✅ **Window management verbs** — `window_action` (minimize/maximize/restore/close) and
  `set_window_bounds` (move/resize), alongside the existing `focus_window`.
- ✅ **Active-window screenshot** (`screenshot_window`) — capture just the focused window
  (or one by PID/title), cropped to its DWM frame bounds.
- ✅ **Find-image / template match** (`find_image`) — locate a reference image on screen
  via pure-.NET pixel matching, returning its box and clickable center. A deterministic
  alternative to Vision for exact-pixel icons.
- ✅ **Monitor enumeration** (`list_monitors`) — per-screen bounds, primary flag, and
  DPI/scale.
- 🔜 Smaller input additions — middle mouse button, separate key down/up primitives,
  image clipboard get/set.
- 🔜 **DPI-awareness audit** — validated on a **dual-monitor, 100%-scale** setup: native
  1920×1080 capture (full and region, both screens), cursor round-trips exactly at multiple
  points including both corners, and per-screen capture (`screen=1`) plus `get_pixel_color`
  read the secondary monitor pixel-exactly at **negative virtual-desktop coordinates**
  (`-1920..0`) — so capture and input share a 1:1 coordinate space across monitors at 100%.
  Still to verify: scaled (>100%) displays and **mixed-DPI** multi-monitor setups (monitors
  at different scales), which can virtualize coordinates — document or fix any mismatch
  there. Not reproducible on current hardware (both displays are 96 DPI / 100%).

## Documentation

- ✅ `SECURITY.md` — threat model and the trusted-client-only / never-network-exposed posture.
- ✅ `CONTRIBUTING.md` — build, the committed-`dist/` rule, tests, commit style, scope limits.
- ✅ `CHANGELOG.md` — Keep a Changelog format.
- ✅ Troubleshooting section in the README (DPI scaling, OCR language pack, execution
  policy, antivirus/EDR flagging of synthetic input).
- 🔜 Demo GIF/video in the README.
- 🔜 A `recipes/` or expanded examples set for common Horizon flows.

## Explicitly out of scope

Per the project guardrails, the following will **not** be added to this server:

- Telemetry, analytics, or any phone-home behavior.
- Screen/keystroke recording, scheduled capture, or scrape-and-store features.
- Any persistence of captured screen content or user data.
