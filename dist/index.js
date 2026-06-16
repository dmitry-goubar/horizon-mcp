#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { createRequire } from "node:module";
import { escapePsSingleQuote, escapeSendKeys, requireFinite, requireInt, parseKeyCombo, buildKeyComboLines, } from "./input.js";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const execAsync = promisify(exec);
// Maximum time a single PowerShell invocation may run before it is killed, so a
// hung call cannot block the server indefinitely.
const PS_TIMEOUT_MS = 60_000;
// Run PowerShell using Base64-encoded command to avoid escaping issues.
// Force UTF-8 output so non-ASCII characters (in window titles, clipboard, OCR
// text) survive the pipe; Windows PowerShell otherwise emits the console code
// page, which Node decodes as UTF-8 and mangles into '?'/replacement chars.
async function ps(script) {
    const wrapped = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + script;
    const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
    const { stdout, stderr } = await execAsync(`powershell -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`, { maxBuffer: 50 * 1024 * 1024, windowsHide: true, timeout: PS_TIMEOUT_MS, encoding: "utf8" });
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
    const psLiteral = escapePsSingleQuote(escapeSendKeys(text));
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
    const safeTitle = escapePsSingleQuote(pidOrTitle);
    const selector = isNumeric
        ? `Where-Object { $_.Id -eq ${pidOrTitle} }`
        : `Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' }`;
    return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_SHOWWINDOW = 0x40;

  // SetForegroundWindow from a background process is refused by the Windows
  // foreground lock, so the window gets focus but is not raised above an active
  // or topmost window. Defeat both: borrow the current foreground thread's input
  // queue (AttachThreadInput) so the call is honoured, and force Z-order to the
  // top via a TOPMOST then NOTOPMOST toggle so it ends up above other windows
  // without staying always-on-top.
  public static void ForceForeground(IntPtr h) {
    ShowWindow(h, 9); // SW_RESTORE — un-minimize if needed
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint thisThread = GetCurrentThreadId();
    bool attached = (fgThread != thisThread) && AttachThreadInput(fgThread, thisThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    if (attached) AttachThreadInput(fgThread, thisThread, false);
  }
}
"@
$p = Get-Process | ${selector} | Select-Object -First 1
if ($p) {
  [Win]::ForceForeground($p.MainWindowHandle)
  "Focused: $($p.MainWindowTitle)"
} else { "Window not found: ${pidOrTitle}" }
`);
}
// Return the currently focused window (title + PID)
async function getForegroundWindow() {
    return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder(256)
[FgWin]::GetWindowText($h, $sb, 256) | Out-Null
$pid_ = [uint32]0
[FgWin]::GetWindowThreadProcessId($h, [ref]$pid_) | Out-Null
ConvertTo-Json -Compress @{ Title = $sb.ToString(); Pid = [int]$pid_ }
`);
}
// Capture a rectangular region of the screen, returns base64 PNG
async function screenshotRegion(x, y, width, height) {
    return ps(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`);
}
// Sample the color of a single pixel
async function getPixelColor(x, y) {
    return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PixelUtil {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern uint GetPixel(IntPtr dc, int x, int y);
}
"@
$dc = [PixelUtil]::GetDC([IntPtr]::Zero)
$c = [PixelUtil]::GetPixel($dc, ${x}, ${y})
[PixelUtil]::ReleaseDC([IntPtr]::Zero, $dc) | Out-Null
$r = [int]($c -band 0xFF)
$g = [int](($c -shr 8) -band 0xFF)
$b = [int](($c -shr 16) -band 0xFF)
ConvertTo-Json -Compress @{ R = $r; G = $g; B = $b; Hex = ("#{0:X2}{1:X2}{2:X2}" -f $r,$g,$b) }
`);
}
// Scroll the mouse wheel at (x, y)
async function scroll(x, y, direction, amount) {
    const delta = direction === "up" ? amount * 120 : -(amount * 120);
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class ScrollUtil {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
[ScrollUtil]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 50
[ScrollUtil]::mouse_event(0x0800, 0, 0, ${delta}, 0)
`);
}
// Read the current clipboard text
async function getClipboard() {
    return ps(`Get-Clipboard`);
}
// Write text to the clipboard
async function setClipboard(text) {
    const safeText = escapePsSingleQuote(text);
    await ps(`Set-Clipboard -Value '${safeText}'`);
}
// Extract text from the screen (or a region) using Windows built-in WinRT OCR.
// Returns JSON { text: string, lines: string[] }.
// Uses a temp PNG file to bridge System.Drawing and the WinRT BitmapDecoder.
async function runOcr(x, y, width, height) {
    const hasRegion = x !== undefined && y !== undefined && width !== undefined && height !== undefined;
    const captureScript = hasRegion
        ? `$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$gfx.Dispose()`
        : `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
$gfx.Dispose()`;
    return ps(`
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[void][Windows.Media.Ocr.OcrEngine,            Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile,            Windows.Foundation, ContentType=WindowsRuntime]

# Resolve the AsTask overload by its parameter type (robust across PS 5.1
# WinRT projections), then pass the result type explicitly. Deriving the generic
# argument from the operation's own interfaces returns null on some setups.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
    $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

${captureScript}
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($tmp); $bmp.Dispose()

try {
    $sf   = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stm  = Await ($sf.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $dec  = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stm)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sbmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $eng  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $eng) { throw 'No OCR engine available — install a language pack in Windows Settings' }
    $res   = Await ($eng.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($res.Lines | ForEach-Object { $_.Text })
    ConvertTo-Json -Compress @{ text = $res.Text; lines = $lines }
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
`);
}
// Press a chord of keys via keybd_event. Modifiers come first, the main key
// last: e.g. ["Win","R"], ["Ctrl","Alt","Insert"], ["Alt","Tab"]. The key tables
// and statement generation live in input.ts (and are unit-tested); all emitted
// values are integers from the validated VK map, so there is no script injection.
async function keyCombo(keys, times, holdMs) {
    const lines = buildKeyComboLines(keys, times, holdMs);
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Kbd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
${lines.join("\n")}
`);
}
// Put text on the clipboard and paste it with Ctrl+V (via keybd_event).
// More reliable than SendKeys for arbitrary characters and for password fields
// in a remote session. NOTE: the value remains on the clipboard afterwards —
// for secrets, follow up with set_clipboard "" to clear it.
async function pasteText(text) {
    const safe = escapePsSingleQuote(text);
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class KbdV {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
Set-Clipboard -Value '${safe}'
Start-Sleep -Milliseconds 60
[KbdV]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)  # Ctrl down
[KbdV]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)  # V down
[KbdV]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)  # V up
[KbdV]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)  # Ctrl up
`);
}
// Move the cursor without clicking (hover for menus/tooltips).
async function moveMouse(x, y) {
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MouseMv { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
"@
[MouseMv]::SetCursorPos(${x}, ${y})
`);
}
// Press at (x1,y1), drag to (x2,y2) in small steps, release. Steps are needed
// so the target app registers a real drag (dragging windows, selecting text).
async function mouseDrag(x1, y1, x2, y2, button) {
    const down = button === "left" ? "0x0002" : "0x0008";
    const up = button === "left" ? "0x0004" : "0x0010";
    await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MouseDr {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
[MouseDr]::SetCursorPos(${x1}, ${y1}); Start-Sleep -Milliseconds 60
[MouseDr]::mouse_event(${down}, 0, 0, 0, 0); Start-Sleep -Milliseconds 60
$steps = 24
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int](${x1} + (${x2} - ${x1}) * $i / $steps)
  $ny = [int](${y1} + (${y2} - ${y1}) * $i / $steps)
  [MouseDr]::SetCursorPos($nx, $ny); Start-Sleep -Milliseconds 10
}
Start-Sleep -Milliseconds 60
[MouseDr]::mouse_event(${up}, 0, 0, 0, 0)
`);
}
// --- MCP Server setup ---
const server = new Server({ name: "horizon-mcp", version }, { capabilities: { tools: {} } });
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
            description: "Bring a window to the foreground, forcing it above other (including topmost) windows and restoring it if minimized. Pass a numeric process ID or a partial window title (case-insensitive).",
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
        {
            name: "get_foreground_window",
            description: "Return the title and PID of the window that currently has keyboard focus as JSON {Title, Pid}.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "screenshot_region",
            description: "Capture a rectangular region of the screen and return it as a PNG image. Useful for cropping to just the chat area to reduce Vision API token cost.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Left edge pixel coordinate" },
                    y: { type: "number", description: "Top edge pixel coordinate" },
                    width: { type: "number", description: "Width in pixels" },
                    height: { type: "number", description: "Height in pixels" },
                },
                required: ["x", "y", "width", "height"],
            },
        },
        {
            name: "get_pixel_color",
            description: "Return the color of a single screen pixel as JSON {R, G, B, Hex}. Use to cheaply detect notification dots or UI state changes at known coordinates.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Horizontal pixel coordinate" },
                    y: { type: "number", description: "Vertical pixel coordinate" },
                },
                required: ["x", "y"],
            },
        },
        {
            name: "scroll",
            description: "Scroll the mouse wheel at (x, y). Use to scroll through chat history.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Horizontal pixel coordinate to scroll at" },
                    y: { type: "number", description: "Vertical pixel coordinate to scroll at" },
                    direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
                    amount: { type: "number", description: "Number of notches to scroll (default: 3)" },
                },
                required: ["x", "y", "direction"],
            },
        },
        {
            name: "get_clipboard",
            description: "Return the current clipboard text content.",
            inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
            name: "set_clipboard",
            description: "Write text to the clipboard. Useful for staging a reply that the user can paste into the remote desktop with Ctrl+V.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to place on the clipboard" },
                },
                required: ["text"],
            },
        },
        {
            name: "ocr",
            description: "Extract text from the screen using the Windows built-in OCR engine. Free, offline, no API cost. " +
                "Returns JSON {text, lines[]}. Omit x/y/width/height to scan the full primary screen, or pass all four to scan a region. " +
                "Use as a cheap pre-filter before sending screenshots to Claude Vision — if OCR text is unchanged, skip the Vision call.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Left edge of region (omit for full primary screen)" },
                    y: { type: "number", description: "Top edge of region" },
                    width: { type: "number", description: "Width of region in pixels" },
                    height: { type: "number", description: "Height of region in pixels" },
                },
                required: [],
            },
        },
        {
            name: "key_combo",
            description: "Press a keyboard chord using real virtual-key codes (handles the Windows key and any modifier combination, which type_text/press_key cannot). " +
                "List modifiers first and the main key last. Essential for driving a remote Horizon session: " +
                "['Win','R'] opens Run, ['Win'] opens Start, ['Alt','Tab'] switches windows, ['Ctrl','Alt','Insert'] sends Ctrl+Alt+Del to the remote, ['Win','Up'] maximizes, ['Win','D'] shows the desktop. " +
                "Supported names: Ctrl, Alt, Shift, Win, Tab, Enter, Esc, Space, Backspace, Delete, Insert, Home, End, PageUp, PageDown, Up, Down, Left, Right, Apps, PrintScreen, A-Z, 0-9, F1-F24.",
            inputSchema: {
                type: "object",
                properties: {
                    keys: {
                        type: "array",
                        items: { type: "string" },
                        description: "Keys to press together, modifiers first and main key last, e.g. [\"Win\",\"R\"] or [\"Ctrl\",\"Alt\",\"Insert\"]. A single \"Ctrl+V\"-style string is also accepted.",
                    },
                    times: { type: "number", description: "Repeat the main key while modifiers stay held (e.g. Alt+Tab x3). Default 1." },
                    holdMs: { type: "number", description: "Milliseconds to hold the main key down each press. Default 0." },
                },
                required: ["keys"],
            },
        },
        {
            name: "paste_text",
            description: "Place text on the clipboard and paste it with Ctrl+V. More reliable than type_text for arbitrary characters and for password fields in a remote session. " +
                "Note: the text stays on the clipboard afterward — for secrets, call set_clipboard with an empty string to clear it.",
            inputSchema: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Text to paste into the focused window" },
                },
                required: ["text"],
            },
        },
        {
            name: "move_mouse",
            description: "Move the cursor to (x, y) without clicking. Use to hover over menus or tooltips.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "Horizontal pixel coordinate" },
                    y: { type: "number", description: "Vertical pixel coordinate" },
                },
                required: ["x", "y"],
            },
        },
        {
            name: "mouse_drag",
            description: "Press at (x1, y1), drag to (x2, y2), and release. Use to drag windows, select text, or resize.",
            inputSchema: {
                type: "object",
                properties: {
                    x1: { type: "number", description: "Start horizontal pixel coordinate" },
                    y1: { type: "number", description: "Start vertical pixel coordinate" },
                    x2: { type: "number", description: "End horizontal pixel coordinate" },
                    y2: { type: "number", description: "End vertical pixel coordinate" },
                    button: { type: "string", enum: ["left", "right"], description: "Mouse button to hold during the drag (default: left)" },
                },
                required: ["x1", "y1", "x2", "y2"],
            },
        },
        {
            name: "wait",
            description: "Pause for a number of milliseconds. Use to let a remote session catch up between actions before the next screenshot.",
            inputSchema: {
                type: "object",
                properties: {
                    ms: { type: "number", description: "Milliseconds to wait (max 60000)" },
                },
                required: ["ms"],
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
                const screenIdx = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
                const data = await takeScreenshot(screenIdx);
                return {
                    content: [{ type: "image", data, mimeType: "image/png" }],
                };
            }
            case "click": {
                const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
                await mouseClick(x, y, a.button ?? "left", false);
                return { content: [{ type: "text", text: `Clicked (${x}, ${y})` }] };
            }
            case "double_click": {
                const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
                await mouseClick(x, y, "left", true);
                return {
                    content: [{ type: "text", text: `Double-clicked (${x}, ${y})` }],
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
            case "get_foreground_window": {
                const result = await getForegroundWindow();
                return { content: [{ type: "text", text: result }] };
            }
            case "screenshot_region": {
                const data = await screenshotRegion(requireInt(a.x, "x"), requireInt(a.y, "y"), requireInt(a.width, "width"), requireInt(a.height, "height"));
                return { content: [{ type: "image", data, mimeType: "image/png" }] };
            }
            case "get_pixel_color": {
                const result = await getPixelColor(requireInt(a.x, "x"), requireInt(a.y, "y"));
                return { content: [{ type: "text", text: result }] };
            }
            case "scroll": {
                const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
                const amount = a.amount !== undefined ? requireInt(a.amount, "amount") : 3;
                await scroll(x, y, a.direction, amount);
                return { content: [{ type: "text", text: `Scrolled ${a.direction} ${amount} notch(es) at (${x}, ${y})` }] };
            }
            case "get_clipboard": {
                const result = await getClipboard();
                return { content: [{ type: "text", text: result }] };
            }
            case "set_clipboard": {
                await setClipboard(String(a.text));
                return { content: [{ type: "text", text: "Clipboard updated" }] };
            }
            case "ocr": {
                const hasRegion = a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined;
                const result = hasRegion
                    ? await runOcr(requireInt(a.x, "x"), requireInt(a.y, "y"), requireInt(a.width, "width"), requireInt(a.height, "height"))
                    : await runOcr();
                return { content: [{ type: "text", text: result }] };
            }
            case "key_combo": {
                const keys = parseKeyCombo(a.keys);
                const times = a.times !== undefined ? requireFinite(a.times, "times") : 1;
                const holdMs = a.holdMs !== undefined ? requireFinite(a.holdMs, "holdMs") : 0;
                await keyCombo(keys, times, holdMs);
                return { content: [{ type: "text", text: `Pressed: ${keys.join("+")}${times > 1 ? ` x${times}` : ""}` }] };
            }
            case "paste_text": {
                await pasteText(String(a.text));
                return { content: [{ type: "text", text: "Pasted via clipboard" }] };
            }
            case "move_mouse": {
                const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
                await moveMouse(x, y);
                return { content: [{ type: "text", text: `Moved to (${x}, ${y})` }] };
            }
            case "mouse_drag": {
                const x1 = requireInt(a.x1, "x1"), y1 = requireInt(a.y1, "y1");
                const x2 = requireInt(a.x2, "x2"), y2 = requireInt(a.y2, "y2");
                await mouseDrag(x1, y1, x2, y2, a.button ?? "left");
                return { content: [{ type: "text", text: `Dragged (${x1}, ${y1}) → (${x2}, ${y2})` }] };
            }
            case "wait": {
                const ms = Math.min(Math.max(requireFinite(a.ms, "ms"), 0), 60000);
                await new Promise((resolve) => setTimeout(resolve, ms));
                return { content: [{ type: "text", text: `Waited ${ms} ms` }] };
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
if (process.platform !== "win32") {
    process.stderr.write(`horizon-mcp requires Windows (win32); detected platform "${process.platform}". Exiting.\n`);
    process.exit(1);
}
const transport = new StdioServerTransport();
await server.connect(transport);
