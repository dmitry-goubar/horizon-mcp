# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `ocr` now returns bounding boxes: each recognized line and word includes an
  `{x, y, width, height}` rectangle in absolute screen pixels (the region offset is
  added back), so located text can be clicked directly without a Vision round-trip.
- Window & display tools: `get_window_rect` (a window's screen rectangle),
  `window_action` (minimize/maximize/restore/close), `set_window_bounds` (move and/or
  resize), and `list_monitors` (per-screen bounds, primary flag, and DPI/scale).
- Synchronization tools: `wait_for_pixel` (poll a pixel until it matches a color) and
  `wait_for_text` (poll OCR until a substring appears, returning its bounding box),
  replacing brittle fixed `wait` calls.
- ESLint (flat config) and Prettier with `lint`, `format`, and `format:check` scripts.
  (Wiring the lint step into CI is pending the `workflow` PAT scope to edit `ci.yml`.)
- `src/input.ts`: pure, side-effect-free module for key tables, string escaping, and
  numeric validation, enabling unit tests without spawning the server.
- Unit tests (`node:test`) covering escaping, key-code lookup, key-combo script
  generation, and input validation.
- Continuous integration (GitHub Actions): build, type-check, test, and a check that the
  committed `dist/` stays in sync with `src/`.
- `npx` support: a `bin` entry and shebang so the server can run without cloning or
  building, plus a `files` allowlist for publishing.
- Documentation: `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `ROADMAP.md`, and a
  Troubleshooting section in the README.

### Changed
- `ocr` line entries changed from plain strings to objects (`{text, x, y, width, height, words[]}`).
  The full recognized text is still available under the top-level `text` field.
- `focus_window` now reliably raises a window past the Windows foreground lock —
  restoring it if minimized, attaching to the foreground thread's input queue, and
  toggling Z-order so it ends up above other (including topmost) windows.
- Coordinate and numeric tool arguments are now validated as finite numbers and produce
  clear error messages instead of silently forming malformed scripts.
- The server version is read from `package.json` rather than being hardcoded.

### Hardened
- Each PowerShell invocation now runs under a timeout so a hung call cannot block the
  server indefinitely.
- The server exits at startup with a clear message when run on a non-Windows platform.
- PowerShell errors are now surfaced: scripts run with `$ErrorActionPreference = 'Stop'`,
  and a call that writes to the error stream or exits non-zero is reported as a tool
  error instead of silently returning empty output. Timeouts produce a clear message.

### Fixed
- `ocr` failed with "Cannot index into a null array" on Windows PowerShell 5.1. The WinRT
  async bridge now resolves the `AsTask` overload by its parameter type and passes the
  result type explicitly, instead of deriving the generic argument from the operation's
  interfaces (which returned null on some setups). Verified against a live session.
- Non-ASCII characters in `list_windows`, `get_foreground_window`, `get_clipboard`, and
  `ocr` output were mangled to `?`/replacement characters. PowerShell output is now forced
  to UTF-8 so titles, clipboard text, and OCR results round-trip correctly.

## [1.0.0]

### Added
- Initial release: an MCP server exposing screen capture, mouse, keyboard, window
  management, clipboard, OCR, and timing tools for Windows desktop automation, targeting
  the Omnissa Horizon Client.
