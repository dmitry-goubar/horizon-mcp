# horizon-mcp

An MCP server that gives Claude eyes and hands on a Windows desktop — capture screenshots, move the mouse, type text, and manage windows.

## Overview

Controlling a graphical Windows application from an AI assistant normally requires a purpose-built API or RPA framework. horizon-mcp takes a different approach: it exposes raw screen capture and input simulation as MCP tools, so Claude can see what is on screen and interact with it the same way a human would — by looking, clicking, and typing.

The primary use case is the Omnissa Horizon Client (formerly VMware Horizon), a remote desktop and published-application client used in enterprise environments. Many enterprise tools live inside Horizon sessions and have no external API. horizon-mcp lets Claude navigate those apps, read data from them, fill in forms, and open remote applications — all by observing the screen and driving the mouse and keyboard. The same tools work on any Windows application.

This server exposes nineteen tools covering the full input/output surface of a desktop: screen capture (`screenshot`, `screenshot_region`, `get_pixel_color`), mouse control (`click`, `double_click`, `scroll`, `move_mouse`, `mouse_drag`), keyboard input (`type_text`, `press_key`, `key_combo`, `paste_text`), window management (`list_windows`, `focus_window`, `get_foreground_window`), clipboard access (`get_clipboard`, `set_clipboard`), on-device text extraction (`ocr`), and timing (`wait`). It exposes no resources or prompts. Because Claude is multimodal, screenshot output is returned as a raw PNG image that Claude reads directly; the `ocr` tool is offered separately as a cheap, offline pre-filter that uses the Windows built-in OCR engine — no third-party library or API is required.

## Setup

### Prerequisites

- **Windows.** The server drives the desktop through PowerShell and Win32 (`user32.dll`) APIs and runs on Windows only (tested on Windows 11). It will install on macOS or Linux but will not function there.
- **Node.js 18 or later.**
- **No secrets, API keys, `.env` file, or SSH keys are required** to run the server — it reads no environment variables and no credential files.

### Install

```powershell
git clone https://github.com/sensaiworks/horizon-mcp.git
cd horizon-mcp
npm install
npm run build
```

`npm install` fetches the one runtime dependency (`@modelcontextprotocol/sdk`); the build compiles `src/index.ts` to `dist/index.js`. No additional binaries are required — screen capture, input, and OCR all use built-in Windows/.NET facilities.

The compiled `dist/index.js` is committed to the repository, so `npm run build` is only needed after editing `src/`.

To verify the server starts:

```powershell
node dist/index.js
# Server starts and waits on stdin — Ctrl+C to exit
```

Then register it with your MCP client — see [Configuration](#configuration) below.

### Moving to another machine

The project is self-contained: a `git pull` brings everything needed. On a fresh Windows machine:

```powershell
git clone https://github.com/sensaiworks/horizon-mcp.git
cd horizon-mcp
npm ci          # restore node_modules from the committed lockfile
```

`node_modules/` is the only required piece not in version control, so `npm ci` is the single setup step. Because `dist/index.js` is committed, the server then runs without a build. Nothing has to be copied by hand — there are no secrets or local credential files to transfer. The one machine-specific step is recreating the MCP client registration (see [Configuration](#configuration)) with the new local path to `dist/index.js`.

## Configuration

Add the following entry to your MCP client configuration. The server communicates over stdio, which is the standard transport for local MCP servers.

**Claude Code** — add to `.claude/settings.json` in any project, or to the global `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "horizon-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\horizon-mcp\\dist\\index.js"]
    }
  }
}
```

**Claude Desktop** — add the same block to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "horizon-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\horizon-mcp\\dist\\index.js"]
    }
  }
}
```

Replace `C:\\path\\to\\horizon-mcp` with the actual path to the cloned repository. Restart the MCP client after editing the configuration.

> **Note:** the package is also set up to run via `npx` (`"command": "npx", "args": ["-y", "horizon-mcp"]`), which avoids cloning and pointing at a local path. That form works once the package is published to npm.

## Usage

**Read data from a Horizon application**

```
User: Open Horizon, launch the SAP app, and tell me the balance on account 12345.

Claude: (calls screenshot to see the screen)
        (calls focus_window with "Horizon" to bring the client forward)
        (calls double_click at the SAP icon coordinates)
        (calls screenshot to confirm SAP loaded)
        (calls type_text to enter the account number, press_key "Enter")
        (calls screenshot to read the result)
```

**Open a remote application**

```
User: Open the Workday app in Horizon.

Claude: (calls list_windows to find the Horizon Client PID)
        (calls focus_window with the PID)
        (calls screenshot to locate the Workday icon)
        (calls double_click at the icon coordinates)
        (calls screenshot to confirm Workday launched)
```

**Fill in a form**

```
User: Submit a time-off request in Workday for next Monday.

Claude: (calls screenshot to read the current form state)
        (calls click on the Time Off menu item)
        (calls type_text to enter the date)
        (calls press_key "Enter" to submit)
```

## Tools

### `screenshot`

Captures one or all monitors and returns a PNG image.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `screen` | number | no | Monitor index (0, 1, 2, …). Omit to capture all monitors combined into one image. |

Returns: PNG image data (base64-encoded, delivered as an MCP image content block).

---

### `click`

Moves the cursor to a pixel coordinate and clicks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | yes | Horizontal pixel coordinate |
| `y` | number | yes | Vertical pixel coordinate |
| `button` | string | no | `"left"` (default) or `"right"` |

Returns: confirmation string `"Clicked (x, y)"`.

---

### `double_click`

Double-clicks at a pixel coordinate. Use this to open applications, files, or folders.

| Parameter | Type | Required |
|-----------|------|----------|
| `x` | number | yes |
| `y` | number | yes |

Returns: confirmation string `"Double-clicked (x, y)"`.

---

### `type_text`

Types a string into the currently focused window using `SendKeys`. The special characters `+ ^ % ~ ( ) { } [ ]` are automatically escaped so they are sent as literals.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | The text to type |

Returns: confirmation string `"Typed: <text>"`.

---

### `press_key`

Sends a named key or keyboard shortcut to the focused window.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Key name (see list below) |

Supported keys: `Enter`, `Escape`, `Tab`, `Backspace`, `Delete`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `F1`–`F12`, `Ctrl+C`, `Ctrl+V`, `Ctrl+A`, `Ctrl+Z`, `Ctrl+F`, `Alt+F4`, `Win`.

Returns: confirmation string `"Pressed: <key>"`.

---

### `list_windows`

Returns a JSON array of all visible windows on the desktop.

No parameters.

Returns: JSON array where each element has `Id` (process ID), `Name` (process name), and `MainWindowTitle`.

---

### `focus_window`

Brings a window to the foreground by process ID or title substring.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | yes | A numeric process ID, or a partial case-insensitive window title |

Returns: `"Focused: <title>"` on success, or `"Window not found: <target>"` if no match.

---

### `get_foreground_window`

Returns the window that currently has keyboard focus. Useful to confirm a `focus_window` call landed before typing.

No parameters.

Returns: JSON object `{ "Title": <string>, "Pid": <number> }`.

---

### `screenshot_region`

Captures a rectangular region of the screen and returns it as a PNG image. Use this to crop to just the area of interest (e.g. a chat pane) to reduce Vision token cost.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | yes | Left edge pixel coordinate |
| `y` | number | yes | Top edge pixel coordinate |
| `width` | number | yes | Width in pixels |
| `height` | number | yes | Height in pixels |

Returns: PNG image data (delivered as an MCP image content block).

---

### `get_pixel_color`

Samples the color of a single screen pixel. Use to cheaply detect a notification dot or a UI state change at a known coordinate without a full screenshot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | yes | Horizontal pixel coordinate |
| `y` | number | yes | Vertical pixel coordinate |

Returns: JSON object `{ "R": <0-255>, "G": <0-255>, "B": <0-255>, "Hex": "#RRGGBB" }`.

---

### `scroll`

Scrolls the mouse wheel at a coordinate. Use to move through chat history or long pages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | yes | Horizontal pixel coordinate to scroll at |
| `y` | number | yes | Vertical pixel coordinate to scroll at |
| `direction` | string | yes | `"up"` or `"down"` |
| `amount` | number | no | Number of wheel notches (default: 3) |

Returns: confirmation string `"Scrolled <direction> <amount> notch(es) at (x, y)"`.

---

### `get_clipboard`

Reads the current clipboard text.

No parameters.

Returns: the clipboard text content.

---

### `set_clipboard`

Writes text to the clipboard — useful for staging a reply the user can paste into the remote desktop with `Ctrl+V`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | Text to place on the clipboard |

Returns: confirmation string `"Clipboard updated"`.

---

### `ocr`

Extracts text from the screen using the Windows built-in OCR engine — free, offline, and no API cost. Omit all parameters to scan the full primary screen, or pass all four to scan a region. Use it as a cheap pre-filter before sending a screenshot to Claude Vision: if the OCR text is unchanged, the Vision call can be skipped.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | no | Left edge of region (omit for full primary screen) |
| `y` | number | no | Top edge of region |
| `width` | number | no | Width of region in pixels |
| `height` | number | no | Height of region in pixels |

Returns: JSON object `{ "text": <string>, "lines": <string[]> }`. Requires an OCR language pack installed in Windows Settings (English is present by default).

---

### `key_combo`

Presses a keyboard chord using real virtual-key codes via `keybd_event`. Unlike `type_text` and `press_key` (which use `SendKeys`), this can send the **real Windows key** and **any modifier combination** — which is what driving a remote Horizon session requires. List modifiers first and the main key last.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `keys` | string[] | yes | Keys to press together, modifiers first and main key last, e.g. `["Win","R"]` or `["Ctrl","Alt","Insert"]`. A single `"Ctrl+V"`-style string is also accepted. |
| `times` | number | no | Repeat the main key while modifiers stay held — e.g. `Alt+Tab` ×3 to move three windows back. Default `1`. |
| `holdMs` | number | no | Milliseconds to hold the main key down on each press. Default `0`. |

Supported key names: `Ctrl`, `Alt`, `Shift`, `Win`, `Tab`, `Enter`, `Esc`, `Space`, `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`, `Up`, `Down`, `Left`, `Right`, `Apps`, `PrintScreen`, `A`–`Z`, `0`–`9`, `F1`–`F24`.

Returns: confirmation string `"Pressed: <combo>"`.

---

### `paste_text`

Places text on the clipboard and pastes it with `Ctrl+V`. More reliable than `type_text` for arbitrary characters, long strings, and password fields inside a remote session.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | yes | Text to paste into the focused window |

Returns: confirmation string `"Pasted via clipboard"`.

> **Security:** the value remains on the clipboard after pasting. For passwords or other secrets, follow up with `set_clipboard` set to an empty string to clear it.

---

### `move_mouse`

Moves the cursor to a coordinate without clicking. Use to hover over menus or trigger tooltips.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x` | number | yes | Horizontal pixel coordinate |
| `y` | number | yes | Vertical pixel coordinate |

Returns: confirmation string `"Moved to (x, y)"`.

---

### `mouse_drag`

Presses at a start point, drags to an end point in small steps, and releases. Use to drag windows, select text, or resize.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `x1` | number | yes | Start horizontal pixel coordinate |
| `y1` | number | yes | Start vertical pixel coordinate |
| `x2` | number | yes | End horizontal pixel coordinate |
| `y2` | number | yes | End vertical pixel coordinate |
| `button` | string | no | `"left"` (default) or `"right"` |

Returns: confirmation string `"Dragged (x1, y1) → (x2, y2)"`.

---

### `wait`

Pauses for a number of milliseconds. Use to let a laggy remote session catch up between an action and the next screenshot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ms` | number | yes | Milliseconds to wait (capped at 60000) |

Returns: confirmation string `"Waited <ms> ms"`.

---

## Controlling a remote Horizon session

The Horizon Client renders the **entire remote desktop (or published app) as pixels inside a single local window**. This shapes what is and isn't possible:

- The host OS sees only the **Horizon Client window**, not the individual windows running inside the remote session. `list_windows` and `focus_window` therefore operate on **host** windows only — they cannot enumerate or activate a window *inside* the remote desktop.
- To control the remote, you drive it the way a person does: bring the Horizon window to the foreground, then send keyboard and mouse input that Horizon forwards into the session.

Because `SendKeys` (used by `type_text`/`press_key`) cannot send the Windows key or `Ctrl+Alt+Del`, the `key_combo` and `paste_text` tools are what make the workflows below possible.

**Unlock the remote VM's Windows lock screen**

```
1. focus_window  "Horizon"            → bring the client to the front
2. key_combo     ["Ctrl","Alt","Insert"]  → remote Ctrl+Alt+Del (wakes the lock/login screen)
3. screenshot                          → confirm the password field is shown
4. click         (password field x, y) → focus the field
5. paste_text    "<password>"          → enter the password (passed at runtime)
6. key_combo     ["Enter"]             → submit
7. set_clipboard ""                    → clear the password from the clipboard
```

This works only for the **remote VM** session (Horizon forwards input into it). It cannot unlock the **local host** Windows lock screen — that runs on Windows' secure desktop, which blocks all synthetic input by design.

**Restore a minimized app inside the remote session**

```
1. focus_window  "Horizon"
2. key_combo     ["Alt","Tab"]         → cycle to the app (add times:N to go further)
   # or click the app's icon on the remote taskbar after a screenshot
3. screenshot                          → read the messages / content
```

**Launch an app inside the remote session**

```
1. focus_window  "Horizon"
2. key_combo     ["Win","R"]           → open the remote Run dialog
3. type_text     "notepad"             → (or the app name / path)
4. key_combo     ["Enter"]
5. wait          1500                   → let the app open
6. screenshot                          → confirm
```

To launch a **published app from the Horizon catalog** instead, `screenshot` the launcher and `double_click` its icon.

---

## Troubleshooting

**Clicks or screenshots land in the wrong place.** On displays with a scaling factor above 100% (or mixed-DPI multi-monitor setups), screen coordinates can be reported in a different space than where input is delivered. Set the affected app — or Windows display scaling — to 100% to confirm, and prefer coordinates read from a fresh `screenshot` at the current scaling.

**`ocr` returns an error about a language pack.** The Windows built-in OCR engine needs a recognition language installed. Add one under *Settings → Time & language → Language & region → (your language) → Language options → install the optional OCR component*, then retry.

**A tool fails with a PowerShell or "is not recognized" error.** PowerShell must be available on `PATH`. If your environment restricts script execution, ensure `powershell.exe` can run; this server invokes it with `-EncodedCommand`, which is unaffected by the script-file execution policy.

**Antivirus or EDR blocks input.** Synthetic mouse/keyboard input and screen capture can trip endpoint-protection heuristics. If actions silently do nothing, check whether security software is blocking the host process and allow-list it if appropriate.

**Keyboard input goes to the wrong window.** Keyboard tools send to whatever window has focus. Call `focus_window` (and confirm with `get_foreground_window`) before typing.

**Nothing happens inside the remote session.** `list_windows`/`focus_window` see only host windows, not windows *inside* a Horizon session. Focus the Horizon window first, then drive the remote with input it forwards — see [Controlling a remote Horizon session](#controlling-a-remote-horizon-session).

## Development

```powershell
npm install
npm run build      # tsc: src → dist
npm test           # unit tests (node:test)
npm run typecheck  # type-check without emitting
```

`dist/index.js` is committed, so rebuild before committing any `src/` change. Pure,
testable logic (key tables, escaping, validation) lives in `src/input.ts`; PowerShell
execution and MCP wiring live in `src/index.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the full workflow and [ROADMAP.md](ROADMAP.md) for planned work.

---

## Architecture

This section covers the server's internal implementation. For the **system-level
architecture** — how this server relates to its companion application (`horizon-monitor`),
and the rule that decides where any given feature belongs — see
[ARCHITECTURE.md](ARCHITECTURE.md).

**Transport.** The server uses stdio transport, the standard for local MCP servers. The MCP client process spawns `node dist/index.js` and communicates over stdin/stdout.

**PowerShell execution.** Every Windows operation (screen capture, mouse, keyboard, window management) runs through PowerShell via `powershell -NonInteractive -EncodedCommand <base64>`. The UTF-16LE base64 encoding eliminates shell-escaping issues with special characters in scripts and user input. Each tool call spawns a new PowerShell process; there is no persistent shell session.

**Screen capture.** Screenshots use `System.Drawing.Bitmap` + `System.Windows.Forms.Screen` from the .NET framework, which is available on all Windows installations without additional dependencies. The bitmap is serialized to PNG in memory and returned as a base64 string, with a 50 MB stdout buffer to accommodate large or multi-monitor captures.

**Mouse automation.** Movement, clicks, and drags use `user32.dll` P/Invoke (`SetCursorPos` + `mouse_event`) compiled inline via PowerShell's `Add-Type`. Drags move the cursor in small steps between press and release so the target application registers a genuine drag.

**Keyboard automation.** There are two paths. `type_text` and `press_key` use `System.Windows.Forms.SendKeys.SendWait`, which is convenient for literal text and a fixed set of named keys but cannot express the Windows key or `Ctrl+Alt+Del`. `key_combo` and `paste_text` use `keybd_event` P/Invoke with raw virtual-key codes, which can send any modifier chord including the Windows key — required to drive a remote Horizon session (`Win+R`, `Alt+Tab`, `Ctrl+Alt+Insert`, etc.). The target window must be focused before sending any keyboard input. Key-combo virtual-key codes are looked up from a fixed table and emitted as integers, so user input is never interpolated into the PowerShell script.

**Security.** This server has unrestricted access to the local desktop — it can read any pixel on screen, click anywhere, and type into any focused window. It should only be connected to trusted MCP clients. Do not expose it over a network transport. It makes no outbound network calls and contains no telemetry. See [SECURITY.md](SECURITY.md) for the full threat model and reporting process.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the build and test
workflow, [ARCHITECTURE.md](ARCHITECTURE.md) for the design and scope boundaries,
[ROADMAP.md](ROADMAP.md) for planned work, and [CHANGELOG.md](CHANGELOG.md) for release
history.

## License

MIT
