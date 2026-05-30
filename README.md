# horizon-mcp

An MCP server that gives Claude eyes and hands on a Windows desktop — capture screenshots, move the mouse, type text, and manage windows.

## Overview

Controlling a graphical Windows application from an AI assistant normally requires a purpose-built API or RPA framework. horizon-mcp takes a different approach: it exposes raw screen capture and input simulation as MCP tools, so Claude can see what is on screen and interact with it the same way a human would — by looking, clicking, and typing.

The primary use case is the Omnissa Horizon Client (formerly VMware Horizon), a remote desktop and published-application client used in enterprise environments. Many enterprise tools live inside Horizon sessions and have no external API. horizon-mcp lets Claude navigate those apps, read data from them, fill in forms, and open remote applications — all by observing the screen and driving the mouse and keyboard. The same tools work on any Windows application.

This server exposes fourteen tools covering the full input/output surface of a desktop: screen capture (`screenshot`, `screenshot_region`, `get_pixel_color`), mouse control (`click`, `double_click`, `scroll`), keyboard input (`type_text`, `press_key`), window management (`list_windows`, `focus_window`, `get_foreground_window`), clipboard access (`get_clipboard`, `set_clipboard`), and on-device text extraction (`ocr`). It exposes no resources or prompts. Because Claude is multimodal, screenshot output is returned as a raw PNG image that Claude reads directly; the `ocr` tool is offered separately as a cheap, offline pre-filter that uses the Windows built-in OCR engine — no third-party library or API is required.

## Installation

Node.js 18 or later is required. The server runs on Windows only.

```powershell
git clone https://github.com/dmitry-goubar/horizon-mcp.git
cd horizon-mcp
npm install
npm run build
```

The compiled output lands in `dist/index.js`. No further setup is needed — all Windows interaction (screen capture, mouse, keyboard) runs through built-in PowerShell and Win32 APIs. No additional binaries are required.

To verify the build:

```powershell
node dist/index.js
# Server starts and waits on stdin — Ctrl+C to exit
```

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

## Architecture

**Transport.** The server uses stdio transport, the standard for local MCP servers. The MCP client process spawns `node dist/index.js` and communicates over stdin/stdout.

**PowerShell execution.** Every Windows operation (screen capture, mouse, keyboard, window management) runs through PowerShell via `powershell -NonInteractive -EncodedCommand <base64>`. The UTF-16LE base64 encoding eliminates shell-escaping issues with special characters in scripts and user input. Each tool call spawns a new PowerShell process; there is no persistent shell session.

**Screen capture.** Screenshots use `System.Drawing.Bitmap` + `System.Windows.Forms.Screen` from the .NET framework, which is available on all Windows installations without additional dependencies. The bitmap is serialized to PNG in memory and returned as a base64 string, with a 50 MB stdout buffer to accommodate large or multi-monitor captures.

**Mouse automation.** Clicks use `user32.dll` P/Invoke (`SetCursorPos` + `mouse_event`) compiled inline via PowerShell's `Add-Type`. This bypasses `SendInput` and works with applications that do not respond to higher-level automation APIs.

**Keyboard automation.** Text input and key presses use `System.Windows.Forms.SendKeys.SendWait`, which posts keystrokes to the foreground window's message queue. The target window must be focused before calling `type_text` or `press_key`.

**Security.** This server has unrestricted access to the local desktop — it can read any pixel on screen, click anywhere, and type into any focused window. It should only be connected to trusted MCP clients. Do not expose it over a network transport.

## License

MIT
