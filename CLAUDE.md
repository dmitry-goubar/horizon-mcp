# horizon-mcp

MCP server that gives Claude eyes and hands on a Windows desktop — take screenshots, move the mouse, type text, and manage windows. Built specifically for interacting with the Omnissa Horizon Client (remote desktop) but works on any Windows application.

## Connecting this server to a Claude Code project

Add the following to the project's `.claude/settings.json` (or the global `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "horizon-mcp": {
      "command": "node",
      "args": ["C:\\github\\horizon-mcp\\dist\\index.js"]
    }
  }
}
```

For **Claude Desktop**, add the same block to `%APPDATA%\Claude\claude_desktop_config.json` instead.

### First-time build

```powershell
cd C:\github\horizon-mcp
npm install
npm run build   # compiles src/index.ts → dist/index.js
```

The compiled output is committed so `npm run build` is only needed after editing the source.

## Tool reference

### `screenshot`
Captures the screen and returns a PNG image. Use this first to understand what is currently displayed before clicking or typing.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `screen` | number | no | Monitor index (0 = primary, 1 = second, …). Omit to capture all monitors combined into one image. |

### `click`
Moves the cursor to pixel coordinates and clicks.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `x` | number | yes | Horizontal pixel coordinate |
| `y` | number | yes | Vertical pixel coordinate |
| `button` | `"left"` \| `"right"` | no | Defaults to `"left"` |

### `double_click`
Double-clicks at pixel coordinates. Use this to open applications, files, or folders in the remote desktop.

| Parameter | Type | Required |
|-----------|------|----------|
| `x` | number | yes |
| `y` | number | yes |

### `type_text`
Types a string into the currently focused window using `SendKeys`. Call `focus_window` first if the target window is not already active.

| Parameter | Type | Required |
|-----------|------|----------|
| `text` | string | yes |

Special characters `+ ^ % ~ ( ) { } [ ]` are automatically escaped.

### `press_key`
Sends a named key or keyboard shortcut to the focused window.

| Parameter | Type | Required |
|-----------|------|----------|
| `key` | string | yes |

Supported key names:

```
Enter  Escape  Tab  Backspace  Delete
Up  Down  Left  Right  Home  End  PageUp  PageDown
F1 – F12
Ctrl+C  Ctrl+V  Ctrl+A  Ctrl+Z  Ctrl+F
Alt+F4  Win
```

### `list_windows`
Returns a JSON array of all visible windows. Each entry has `Id` (PID), `Name` (process name), and `MainWindowTitle`.

```
No parameters.
```

Use this to discover the PID or title of a Horizon app before calling `focus_window`.

### `focus_window`
Brings a window to the foreground. Accepts either a numeric process ID or a partial, case-insensitive window title.

| Parameter | Type | Required | Example |
|-----------|------|----------|---------|
| `target` | string | yes | `"Horizon"` or `"7432"` |

### `get_foreground_window`
Returns the title and PID of the window that currently has keyboard focus, as JSON `{Title, Pid}`. Use to confirm a `focus_window` call landed before typing.

```
No parameters.
```

### `screenshot_region`
Captures a rectangular region of the screen and returns a PNG image. Crop to the area of interest to reduce Vision token cost.

| Parameter | Type | Required |
|-----------|------|----------|
| `x` | number | yes |
| `y` | number | yes |
| `width` | number | yes |
| `height` | number | yes |

### `get_pixel_color`
Samples one screen pixel, returns JSON `{R, G, B, Hex}`. Cheaply detect notification dots or UI state at a known coordinate.

| Parameter | Type | Required |
|-----------|------|----------|
| `x` | number | yes |
| `y` | number | yes |

### `scroll`
Scrolls the mouse wheel at `(x, y)`.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `x` | number | yes | |
| `y` | number | yes | |
| `direction` | `"up"` \| `"down"` | yes | |
| `amount` | number | no | Wheel notches (default: 3) |

### `get_clipboard`
Returns the current clipboard text.

```
No parameters.
```

### `set_clipboard`
Writes text to the clipboard, e.g. to stage a reply for the user to paste with Ctrl+V.

| Parameter | Type | Required |
|-----------|------|----------|
| `text` | string | yes |

### `ocr`
Extracts text from the screen using the Windows built-in OCR engine — free, offline, no API cost. Returns JSON `{text, lines[]}`. Omit all parameters to scan the full primary screen, or pass all four to scan a region. Use as a cheap pre-filter before a Vision screenshot.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `x` | number | no | Omit all four for full primary screen |
| `y` | number | no | |
| `width` | number | no | |
| `height` | number | no | |

## Typical workflow for Horizon Client automation

```
1. screenshot          → see the current state of the screen
2. list_windows        → find "VMware Horizon" or "Omnissa Horizon" window
3. focus_window        → bring the Horizon window to the front
4. screenshot          → confirm Horizon is visible, locate the app icon by coordinates
5. double_click (x, y) → open the remote app
6. screenshot          → wait for the app to load, then read content
7. click / type_text   → interact with the app
```

## Implementation notes

- Transport: **stdio** (standard for MCP). The process is started and managed by the MCP client.
- All Windows interaction runs through PowerShell using `-EncodedCommand` (UTF-16LE base64) to avoid shell-escaping issues.
- Screenshots use `System.Drawing` + `System.Windows.Forms` — no external binaries required.
- Mouse automation uses `user32.dll` P/Invoke via `Add-Type`.
- Requires Windows (tested on Windows 11). Does not run on macOS or Linux.
