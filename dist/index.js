import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
// Run PowerShell using Base64-encoded command to avoid escaping issues
async function ps(script) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout, stderr } = await execAsync(`powershell -NonInteractive -EncodedCommand ${encoded}`, { maxBuffer: 50 * 1024 * 1024 } // 50 MB for screenshots
    );
    if (stderr)
        process.stderr.write(stderr);
    return stdout.trim();
}
// Capture a screen by index (0 = primary, 1 = second, ...) or all screens combined
async function takeScreenshot(screenIndex) {
    if (screenIndex === undefined) {
        // All screens: find bounding box of the virtual desktop
        return ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$left   = ($screens | ForEach-Object { $_.Bounds.Left }   | Measure-Object -Minimum).Minimum
$top    = ($screens | ForEach-Object { $_.Bounds.Top }    | Measure-Object -Minimum).Minimum
$right  = ($screens | ForEach-Object { $_.Bounds.Right }  | Measure-Object -Maximum).Maximum
$bottom = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum
$bmp = New-Object System.Drawing.Bitmap(($right - $left), ($bottom - $top))
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`);
    }
    else {
        // Specific screen by index
        return ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$s = $screens[${screenIndex}].Bounds
$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`);
    }
}
// Move cursor and click via user32.dll
async function mouseClick(x, y, button, double_) {
    const down = button === "left" ? "0x0002" : "0x0008";
    const up = button === "left" ? "0x0004" : "0x0010";
    const clicks = double_
        ? `[Mouse]::mouse_event(${down},0,0,0,0); [Mouse]::mouse_event(${up},0,0,0,0); Start-Sleep -Milliseconds 80; [Mouse]::mouse_event(${down},0,0,0,0); [Mouse]::mouse_event(${up},0,0,0,0)`
        : `[Mouse]::mouse_event(${down},0,0,0,0); [Mouse]::mouse_event(${up},0,0,0,0)`;
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
[Mouse]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 80
${clicks}
`);
}
// Type text via SendKeys
async function sendText(text) {
    // Escape SendKeys special chars, then embed in a PS single-quoted string
    // (single-quoted strings are fully literal in PowerShell — no $ or backtick expansion)
    const sendKeysEscaped = text.replace(/([+^%~(){}[\]])/g, "{$1}");
    const psLiteral = sendKeysEscaped.replace(/'/g, "''"); // ' → '' is the only escape needed
    await ps(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psLiteral}')
`);
}
// Press a named key (Enter, Escape, Tab, etc.)
async function pressKey(key) {
    // Map friendly names to SendKeys syntax
    const keyMap = {
        Enter: "{ENTER}",
        Return: "{ENTER}",
        Escape: "{ESC}",
        Tab: "{TAB}",
        Backspace: "{BACKSPACE}",
        Delete: "{DELETE}",
        Up: "{UP}",
        Down: "{DOWN}",
        Left: "{LEFT}",
        Right: "{RIGHT}",
        Home: "{HOME}",
        End: "{END}",
        PageUp: "{PGUP}",
        PageDown: "{PGDN}",
        F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}",
        F5: "{F5}", F6: "{F6}", F7: "{F7}", F8: "{F8}",
        F9: "{F9}", F10: "{F10}", F11: "{F11}", F12: "{F12}",
        "Ctrl+C": "^c", "Ctrl+V": "^v", "Ctrl+A": "^a",
        "Ctrl+Z": "^z", "Ctrl+F": "^f", "Alt+F4": "%{F4}",
        "Win": "^{ESC}",
    };
    const sendKey = keyMap[key];
    if (!sendKey)
        throw new Error(`Unsupported key: "${key}"`);
    await ps(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sendKey}")
`);
}
// List visible windows with their PIDs
async function listWindows() {
    return ps(`
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
  Select-Object Id, Name, MainWindowTitle |
  ConvertTo-Json -Compress
`);
}
// Bring a window to the foreground by PID or partial title
async function focusWindow(pidOrTitle) {
    const isNumeric = /^\d+$/.test(pidOrTitle.trim());
    // Embed title in a PS single-quoted string — escape ' as '' (no other escaping needed)
    const safeTitle = pidOrTitle.replace(/'/g, "''");
    const selector = isNumeric
        ? `Where-Object { $_.Id -eq ${pidOrTitle} }`
        : `Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' }`;
    return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$p = Get-Process | ${selector} | Select-Object -First 1
if ($p) {
  [Win]::ShowWindow($p.MainWindowHandle, 9)
  [Win]::SetForegroundWindow($p.MainWindowHandle)
  "Focused: $($p.MainWindowTitle)"
} else { "Window not found: ${pidOrTitle}" }
`);
}
// --- MCP Server setup ---
const server = new Server({ name: "horizon-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "screenshot",
            description: "Capture one or all screens. Returns a PNG image. Omit 'screen' to capture all monitors side-by-side. Pass screen=0 for the primary monitor, screen=1 for the second monitor, etc.",
            inputSchema: {
                type: "object",
                properties: {
                    screen: {
                        type: "number",
                        description: "Monitor index (0 = primary, 1 = second, …). Omit to capture all screens combined.",
                    },
                },
                required: [],
            },
        },
        {
            name: "click",
            description: "Move the mouse to (x, y) and click.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Horizontal pixel coordinate" },
                    y: { type: "number", description: "Vertical pixel coordinate" },
                    button: {
                        type: "string",
                        enum: ["left", "right"],
                        description: "Mouse button (default: left)",
                    },
                },
                required: ["x", "y"],
            },
        },
        {
            name: "double_click",
            description: "Double-click at (x, y) — use this to open apps or files.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number" },
                    y: { type: "number" },
                },
                required: ["x", "y"],
            },
        },
        {
            name: "type_text",
            description: "Type a string of text into the currently focused window. For Horizon apps, focus the window first.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to type" },
                },
                required: ["text"],
            },
        },
        {
            name: "press_key",
            description: "Press a named key or keyboard shortcut. Supported: Enter, Escape, Tab, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1–F12, Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+F, Alt+F4, Win.",
            inputSchema: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Key name from the list above" },
                },
                required: ["key"],
            },
        },
        {
            name: "list_windows",
            description: "Return a JSON list of all visible windows (Id, Name, MainWindowTitle). Use this to find Horizon Client or a remote app PID before focusing it.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "focus_window",
            description: "Bring a window to the foreground. Pass a numeric process ID or a partial window title (case-insensitive).",
            inputSchema: {
                type: "object",
                properties: {
                    target: {
                        type: "string",
                        description: "Process ID (number) or partial window title string",
                    },
                },
                required: ["target"],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {});
    try {
        switch (name) {
            case "screenshot": {
                const screenIdx = a.screen !== undefined ? Number(a.screen) : undefined;
                const data = await takeScreenshot(screenIdx);
                return {
                    content: [{ type: "image", data, mimeType: "image/png" }],
                };
            }
            case "click": {
                await mouseClick(Number(a.x), Number(a.y), a.button ?? "left", false);
                return { content: [{ type: "text", text: `Clicked (${a.x}, ${a.y})` }] };
            }
            case "double_click": {
                await mouseClick(Number(a.x), Number(a.y), "left", true);
                return {
                    content: [{ type: "text", text: `Double-clicked (${a.x}, ${a.y})` }],
                };
            }
            case "type_text": {
                await sendText(String(a.text));
                return { content: [{ type: "text", text: `Typed: ${a.text}` }] };
            }
            case "press_key": {
                await pressKey(String(a.key));
                return { content: [{ type: "text", text: `Pressed: ${a.key}` }] };
            }
            case "list_windows": {
                const result = await listWindows();
                return { content: [{ type: "text", text: result }] };
            }
            case "focus_window": {
                const result = await focusWindow(String(a.target));
                return { content: [{ type: "text", text: result }] };
            }
            default:
                return {
                    content: [{ type: "text", text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
