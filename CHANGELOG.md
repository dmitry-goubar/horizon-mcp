# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Coordinate and numeric tool arguments are now validated as finite numbers and produce
  clear error messages instead of silently forming malformed scripts.
- The server version is read from `package.json` rather than being hardcoded.

### Hardened
- Each PowerShell invocation now runs under a timeout so a hung call cannot block the
  server indefinitely.
- The server exits at startup with a clear message when run on a non-Windows platform.

## [1.0.0]

### Added
- Initial release: an MCP server exposing screen capture, mouse, keyboard, window
  management, clipboard, OCR, and timing tools for Windows desktop automation, targeting
  the Omnissa Horizon Client.
