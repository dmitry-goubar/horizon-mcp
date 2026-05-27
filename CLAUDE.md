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
Captures the primary screen and returns a PNG image. Use this first to understand what is currently displayed before clicking or typing.

```
No parameters.
```

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
