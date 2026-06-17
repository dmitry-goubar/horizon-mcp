#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { createRequire } from "node:module";
import {
  escapePsSingleQuote,
  requireFinite,
  requireInt,
  parseHexColor,
  parseKeyCombo,
  buildKeyComboLines,
  buildKeyEventLine,
  buildTypeLines,
} from "./input.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Maximum time a single PowerShell invocation may run before it is killed, so a
// hung call cannot block the server indefinitely.
const PS_TIMEOUT_MS = 60_000;

// Run PowerShell using Base64-encoded command to avoid escaping issues.
// - `Stop` error preference promotes non-terminating errors to terminating ones,
//   so a failing cmdlet exits non-zero and is reported instead of silently
//   returning empty output.
// - UTF-8 output so non-ASCII characters (in window titles, clipboard, OCR text)
//   survive the pipe; Windows PowerShell otherwise emits the console code page,
//   which Node decodes as UTF-8 and mangles into '?'/replacement chars.
async function ps(script: string): Promise<string> {
  const wrapped =
    "$ErrorActionPreference = 'Stop'\n" +
    // Suppress the progress stream. Module auto-loading emits a "Preparing modules
    // for first use" progress record that PowerShell serialises to stderr as CLIXML;
    // for input commands (key_combo/type_text/press_key) that produce no stdout, that
    // stderr text was being thrown as a spurious error even though the keystroke fired.
    "$ProgressPreference = 'SilentlyContinue'\n" +
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
    script;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  try {
    // Use execFile, not exec: exec routes through cmd.exe (≈8191-char command-line
    // limit), which a long Base64 script (e.g. the OCR pipeline) can exceed. execFile
    // spawns powershell directly, raising the limit to CreateProcess's ≈32767 chars.
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { maxBuffer: 50 * 1024 * 1024, windowsHide: true, timeout: PS_TIMEOUT_MS, encoding: "utf8" }
    );
    const out = stdout.trim();
    const errText = stderr.trim();
    // Exit was 0. If the script produced no output but did write to the error
    // stream, treat that as a failure rather than returning empty success.
    if (!out && errText) throw new Error(errText);
    if (errText) process.stderr.write(stderr);
    return out;
  } catch (err) {
    // execAsync rejects on a non-zero exit (a terminating PowerShell error) or a
    // timeout; surface the PowerShell error text rather than the generic wrapper.
    const e = err as { stderr?: string; killed?: boolean; message?: string };
    if (e.killed) throw new Error(`PowerShell call timed out after ${PS_TIMEOUT_MS} ms`);
    const detail = e.stderr?.trim() || e.message || String(err);
    throw new Error(detail);
  }
}

// Capture a screen by index (0 = primary, 1 = second, ...) or all screens combined
async function takeScreenshot(screenIndex?: number): Promise<string> {
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
  } else {
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
// Mouse coordinates live in the *virtual desktop*, where a monitor left of the
// primary starts at a negative X. `screenshot screen=N`, by contrast, returns that
// monitor's image with a local 0,0 origin — so a point read off a screenshot must be
// shifted by the monitor's virtual origin before SetCursorPos, or the cursor lands on
// the wrong monitor. This emits PowerShell setting $cx/$cy to the absolute position:
// with `screen`, (x,y) are local to AllScreens[screen] and its Bounds offset is added
// (matching the screenshot frame); without it, (x,y) are absolute virtual coordinates.
function resolveCursorPs(x: number, y: number, screen?: number): string {
  if (screen === undefined) return `$cx = ${x}; $cy = ${y}`;
  return `Add-Type -AssemblyName System.Windows.Forms
$__b = [System.Windows.Forms.Screen]::AllScreens[${screen}].Bounds
$cx = $__b.X + (${x}); $cy = $__b.Y + (${y})`;
}

// Shared schema description for the optional `screen` param on the mouse tools.
const SCREEN_PARAM_DESC =
  "Monitor index the coordinates are relative to — pass the SAME index you gave " +
  "`screenshot` so the click lands on the right monitor (on multi-monitor setups a " +
  "left-of-primary monitor has a negative virtual X). Omit only if x,y are already " +
  "absolute virtual-desktop coordinates.";

// Move cursor and click via user32.dll
// MOUSEEVENTF down/up flag pairs per button.
const MOUSE_FLAGS: Record<"left" | "right" | "middle", [string, string]> = {
  left:   ["0x0002", "0x0004"],
  right:  ["0x0008", "0x0010"],
  middle: ["0x0020", "0x0040"],
};

async function mouseClick(
  x: number,
  y: number,
  button: "left" | "right" | "middle",
  double_: boolean,
  screen?: number
): Promise<void> {
  const [down, up] = MOUSE_FLAGS[button];
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
${resolveCursorPs(x, y, screen)}
[Mouse]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 80
${clicks}
`);
}

// Type text via keybd_event (raw virtual-key codes), one character at a time, holding
// Shift around characters that need it. This is the SAME low-level input path key_combo
// and paste_text use — field-tested to reach locked-down/remote Horizon sessions where
// the SendKeys path is silently dropped (a 13-char password typed via SendKeys arrived
// as ~4 chars; clicks and keybd_event chords always worked). The character -> VK+Shift
// mapping (US layout) and statement generation live in input.ts and are unit-tested; only
// integers are emitted, so there is no script injection. Characters not on the US layout
// are skipped. A small delay between characters lets the remote keep up. For long or
// multi-line text, paste_text (clipboard) is still preferable — it is a single event.
const TYPE_CHAR_DELAY_MS = 60;
const TYPE_HOLD_MS = 30;
async function sendText(text: string): Promise<void> {
  if (!text) return;
  const lines = buildTypeLines(text, TYPE_CHAR_DELAY_MS, TYPE_HOLD_MS);
  if (lines.length === 0) return;
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Kbd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
}
"@
${lines.join("\n")}
`);
}

// Press a named key (Enter, Escape, Tab, etc.)
async function pressKey(key: string): Promise<void> {
  // Map friendly names to SendKeys syntax
  const keyMap: Record<string, string> = {
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
  if (!sendKey) throw new Error(`Unsupported key: "${key}"`);
  await ps(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sendKey}")
`);
}

// List visible windows with their PIDs
async function listWindows(): Promise<string> {
  return ps(`
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } |
  Select-Object Id, Name, MainWindowTitle |
  ConvertTo-Json -Compress
`);
}

// Build a PowerShell `Where-Object` clause that matches a window by numeric PID or
// case-insensitive partial title. The numeric branch is gated by a digits-only test
// and the title is embedded in a single-quoted PS string (with '' escaping), so user
// input is never interpolated as code. Shared by all the window tools.
function windowSelector(pidOrTitle: string): string {
  const isNumeric = /^\d+$/.test(pidOrTitle.trim());
  const safeTitle = escapePsSingleQuote(pidOrTitle);
  return isNumeric
    ? `Where-Object { $_.Id -eq ${pidOrTitle} }`
    : `Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' }`;
}

// Bring a window to the foreground by PID or partial title
async function focusWindow(pidOrTitle: string): Promise<string> {
  const selector = windowSelector(pidOrTitle);

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
async function getForegroundWindow(): Promise<string> {
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

// Return a window's screen rectangle (by PID or partial title) as JSON.
async function getWindowRect(pidOrTitle: string): Promise<string> {
  const selector = windowSelector(pidOrTitle);
  return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process | ${selector} | Select-Object -First 1
if ($p) {
  $r = New-Object WinRect+RECT
  [WinRect]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  ConvertTo-Json -Compress @{ Title = $p.MainWindowTitle; Pid = $p.Id;
    Left = $r.Left; Top = $r.Top; Right = $r.Right; Bottom = $r.Bottom;
    Width = ($r.Right - $r.Left); Height = ($r.Bottom - $r.Top) }
} else { "Window not found: ${pidOrTitle}" }
`);
}

// Minimize, maximize, restore, or close a window (by PID or partial title).
async function windowAction(
  pidOrTitle: string,
  action: "minimize" | "maximize" | "restore" | "close"
): Promise<string> {
  const selector = windowSelector(pidOrTitle);
  // action is validated against this fixed set in the handler, so the looked-up
  // statement is never built from raw user input.
  const op: Record<typeof action, string> = {
    minimize: "[WinAct]::ShowWindow($h, 6)",          // SW_MINIMIZE
    maximize: "[WinAct]::ShowWindow($h, 3)",          // SW_MAXIMIZE
    restore:  "[WinAct]::ShowWindow($h, 9)",          // SW_RESTORE
    close:    "[WinAct]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)", // WM_CLOSE
  };
  return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinAct {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@
$p = Get-Process | ${selector} | Select-Object -First 1
if ($p) {
  $h = $p.MainWindowHandle
  ${op[action]} | Out-Null
  "${action}: $($p.MainWindowTitle)"
} else { "Window not found: ${pidOrTitle}" }
`);
}

// Move and/or resize a window. Omitted dimensions keep their current value, read
// from the window's existing rectangle.
async function setWindowBounds(
  pidOrTitle: string,
  x?: number, y?: number, width?: number, height?: number
): Promise<string> {
  const selector = windowSelector(pidOrTitle);
  const nx = x !== undefined ? `${x}` : "$r.Left";
  const ny = y !== undefined ? `${y}` : "$r.Top";
  const nw = width !== undefined ? `${width}` : "($r.Right - $r.Left)";
  const nh = height !== undefined ? `${height}` : "($r.Bottom - $r.Top)";
  return ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinMove {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process | ${selector} | Select-Object -First 1
if ($p) {
  $h = $p.MainWindowHandle
  $r = New-Object WinMove+RECT
  [WinMove]::GetWindowRect($h, [ref]$r) | Out-Null
  [WinMove]::MoveWindow($h, ${nx}, ${ny}, ${nw}, ${nh}, $true) | Out-Null
  "Set bounds: $($p.MainWindowTitle)"
} else { "Window not found: ${pidOrTitle}" }
`);
}

// Enumerate monitors with bounds, primary flag, and effective DPI/scale.
async function listMonitors(): Promise<string> {
  return ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MonDpi {
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint x, out uint y);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static uint Get(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = MonitorFromPoint(p, 2); // MONITOR_DEFAULTTONEAREST
    uint dx, dy; GetDpiForMonitor(h, 0, out dx, out dy); return dx;
  }
}
"@
$mons = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $b = $_.Bounds
  $dpi = [MonDpi]::Get($b.X + [int]($b.Width / 2), $b.Y + [int]($b.Height / 2))
  @{ device = $_.DeviceName; primary = $_.Primary;
     x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height;
     dpi = [int]$dpi; scale = [int][math]::Round($dpi / 96 * 100) }
})
ConvertTo-Json -Compress -Depth 4 $mons
`);
}

// Capture a rectangular region of the screen, returns base64 PNG
async function screenshotRegion(x: number, y: number, width: number, height: number): Promise<string> {
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

// Capture a single window as base64 PNG — the foreground window if no target is
// given, otherwise one matched by PID or partial title. Crops to the DWM extended
// frame bounds (excludes the invisible resize border) so there is no desktop bleed.
async function screenshotWindow(target?: string): Promise<string> {
  const resolve =
    target === undefined
      ? `$h = [WinShot]::GetForegroundWindow()`
      : `$p = Get-Process | ${windowSelector(target)} | Select-Object -First 1
if (-not $p) { throw 'Window not found: ${escapePsSingleQuote(target)}' }
$h = $p.MainWindowHandle`;
  return ps(`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Drawing; using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  // DWMWA_EXTENDED_FRAME_BOUNDS = 9 → the visible frame; fall back to GetWindowRect.
  public static RECT Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }
}
"@
${resolve}
if ($h -eq [IntPtr]::Zero) { throw 'No target window' }
if ([WinShot]::IsIconic($h)) { throw 'Target window is minimized; focus or restore it first' }
$r = [WinShot]::Bounds($h)
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`);
}

// Sample the color of a single pixel
async function getPixelColor(x: number, y: number): Promise<string> {
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
async function scroll(x: number, y: number, direction: "up" | "down", amount: number, screen?: number): Promise<void> {
  const delta = direction === "up" ? amount * 120 : -(amount * 120);
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class ScrollUtil {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
${resolveCursorPs(x, y, screen)}
[ScrollUtil]::SetCursorPos($cx, $cy); Start-Sleep -Milliseconds 50
[ScrollUtil]::mouse_event(0x0800, 0, 0, ${delta}, 0)
`);
}

// Read the current clipboard text
async function getClipboard(): Promise<string> {
  return ps(`Get-Clipboard`);
}

// Write text to the clipboard
async function setClipboard(text: string): Promise<void> {
  const safeText = escapePsSingleQuote(text);
  await ps(`Set-Clipboard -Value '${safeText}'`);
}

// Read an image from the clipboard and return it as base64 PNG.
async function getClipboardImage(): Promise<string> {
  return ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if (-not $img) { throw 'Clipboard does not contain an image' }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$img.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`);
}

// Load an image file and place it on the clipboard.
async function setClipboardImage(path: string): Promise<void> {
  const safe = escapePsSingleQuote(path);
  await ps(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path -LiteralPath '${safe}')) { throw 'Image not found: ${safe}' }
$img = [System.Drawing.Image]::FromFile('${safe}')
try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
`);
}

// PowerShell's ConvertTo-Json renders a single-element array as a bare object, so an
// OCR result with one line (or a line with one word) would break the documented
// lines[]/words[] shape. Re-normalize so both are always arrays.
function normalizeOcrJson(raw: string): string {
  try {
    const o = JSON.parse(raw);
    const asArray = <T>(v: T | T[] | undefined): T[] =>
      Array.isArray(v) ? v : v ? [v] : [];
    const lines = asArray<{ words?: unknown }>(o.lines);
    for (const line of lines) line.words = asArray(line.words);
    o.lines = lines;
    return JSON.stringify(o);
  } catch {
    return raw;
  }
}

// Extract text from the screen (or a region) using Windows built-in WinRT OCR.
// Returns JSON { text, lines:[{ text, x, y, width, height, words:[{ text, x, y,
// width, height }] }] }, where every box is in absolute screen pixels (the region
// offset is added back), so located text can be clicked directly without a Vision
// round-trip. Uses a temp PNG file to bridge System.Drawing and the WinRT BitmapDecoder.
async function runOcr(x?: number, y?: number, width?: number, height?: number): Promise<string> {
  const hasRegion = x !== undefined && y !== undefined && width !== undefined && height !== undefined;

  // $offX/$offY are the captured bitmap's top-left in screen space; OCR returns
  // box coordinates relative to the bitmap, so adding the offset makes them absolute.
  const captureScript = hasRegion
    ? `$offX = ${x}; $offY = ${y}
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$gfx.Dispose()`
    : `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$offX = $s.Location.X; $offY = $s.Location.Y
$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
$gfx.Dispose()`;

  return normalizeOcrJson(await ps(`
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
    $lines = @($res.Lines | ForEach-Object {
        $ln = $_
        $words = @($ln.Words | ForEach-Object {
            $r = $_.BoundingRect
            @{ text   = $_.Text
               x      = [int][math]::Round($offX + $r.X)
               y      = [int][math]::Round($offY + $r.Y)
               width  = [int][math]::Round($r.Width)
               height = [int][math]::Round($r.Height) }
        })
        # An OCR line exposes no rect of its own; derive it from its words' rects.
        if ($words.Count) {
            $minX = ($words | ForEach-Object { $_.x }              | Measure-Object -Minimum).Minimum
            $minY = ($words | ForEach-Object { $_.y }              | Measure-Object -Minimum).Minimum
            $maxX = ($words | ForEach-Object { $_.x + $_.width }   | Measure-Object -Maximum).Maximum
            $maxY = ($words | ForEach-Object { $_.y + $_.height }  | Measure-Object -Maximum).Maximum
        } else { $minX = 0; $minY = 0; $maxX = 0; $maxY = 0 }
        @{ text = $ln.Text; x = $minX; y = $minY; width = ($maxX - $minX); height = ($maxY - $minY); words = $words }
    })
    ConvertTo-Json -Compress -Depth 6 @{ text = $res.Text; lines = $lines }
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
`));
}

// Locate a template image on screen by pixel template-matching (a deterministic
// alternative to Vision). Captures the screen (or a region), then slides the
// template across it scoring a sampled grid of points by sum-of-absolute-difference
// with early abort. Returns JSON {found, score, x, y, width, height, centerX,
// centerY} in absolute screen pixels. Pixel access uses LockBits for speed.
async function findImage(
  path: string, threshold: number,
  x?: number, y?: number, width?: number, height?: number
): Promise<string> {
  const hasRegion = x !== undefined && y !== undefined && width !== undefined && height !== undefined;
  const safePath = escapePsSingleQuote(path);
  const capture = hasRegion
    ? `$offX = ${x}; $offY = ${y}
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$gfx.Dispose()`
    : `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$offX = $s.Location.X; $offY = $s.Location.Y
$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
$gfx.Dispose()`;
  return ps(`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public class TemplateMatch {
  public static string Find(string hayPath, string ndlPath, int offX, int offY, double threshold) {
    using (Bitmap hay = new Bitmap(hayPath))
    using (Bitmap ndl = new Bitmap(ndlPath)) {
      int HW = hay.Width, HH = hay.Height, NW = ndl.Width, NH = ndl.Height;
      if (NW > HW || NH > HH) return "{\\"found\\":false,\\"reason\\":\\"template larger than search area\\"}";
      var hd = hay.LockBits(new Rectangle(0,0,HW,HH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      var nd = ndl.LockBits(new Rectangle(0,0,NW,NH), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        int hS = hd.Stride, nS = nd.Stride;
        byte[] H = new byte[hS*HH]; byte[] N = new byte[nS*NH];
        Marshal.Copy(hd.Scan0, H, 0, H.Length); Marshal.Copy(nd.Scan0, N, 0, N.Length);
        // Sample up to ~9x9 points across the template instead of every pixel.
        int gx = Math.Max(1, NW/8), gy = Math.Max(1, NH/8);
        var px = new System.Collections.Generic.List<int>(); var py = new System.Collections.Generic.List<int>();
        for (int ty=0; ty<NH; ty+=gy) for (int tx=0; tx<NW; tx+=gx) { px.Add(tx); py.Add(ty); }
        int K = px.Count;
        long best = long.MaxValue; int bx = -1, by = -1;
        for (int y=0; y<=HH-NH; y++) {
          for (int x=0; x<=HW-NW; x++) {
            long sum = 0;
            for (int i=0; i<K; i++) {
              int hi = (y+py[i])*hS + (x+px[i])*4;
              int ni = py[i]*nS + px[i]*4;
              sum += Math.Abs(H[hi]-N[ni]) + Math.Abs(H[hi+1]-N[ni+1]) + Math.Abs(H[hi+2]-N[ni+2]);
              if (sum >= best) break;
            }
            if (sum < best) { best = sum; bx = x; by = y; }
          }
        }
        double score = bx < 0 ? 0 : 1.0 - ((double)best / ((double)K*3*255));
        bool found = bx >= 0 && score >= threshold;
        var ic = System.Globalization.CultureInfo.InvariantCulture;
        return "{\\"found\\":" + (found?"true":"false")
          + ",\\"score\\":" + score.ToString("0.000", ic)
          + ",\\"x\\":" + (offX+bx) + ",\\"y\\":" + (offY+by)
          + ",\\"width\\":" + NW + ",\\"height\\":" + NH
          + ",\\"centerX\\":" + (offX+bx+NW/2) + ",\\"centerY\\":" + (offY+by+NH/2) + "}";
      } finally { hay.UnlockBits(hd); ndl.UnlockBits(nd); }
    }
  }
}
"@
if (-not (Test-Path -LiteralPath '${safePath}')) { throw 'Template image not found: ${safePath}' }
${capture}
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($tmp); $bmp.Dispose()
try {
  [TemplateMatch]::Find($tmp, '${safePath}', $offX, $offY, ${threshold})
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
`);
}

// Press a chord of keys via keybd_event. Modifiers come first, the main key
// last: e.g. ["Win","R"], ["Ctrl","Alt","Insert"], ["Alt","Tab"]. The key tables
// and statement generation live in input.ts (and are unit-tested); all emitted
// values are integers from the validated VK map, so there is no script injection.
async function keyCombo(keys: string[], times: number, holdMs: number): Promise<void> {
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

// Press (down) or release (up) a single key via keybd_event — the primitive behind
// key_down/key_up, for holding a key across other actions (e.g. hold Shift, click,
// release). The VK lookup and flag math live in input.ts (unit-tested); only integers
// from the validated map are emitted, so there is no script injection.
async function keyEvent(key: string, isDown: boolean): Promise<void> {
  const line = buildKeyEventLine(key, isDown);
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Kbd {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
${line}
`);
}

// Put text on the clipboard and paste it with Ctrl+V (via keybd_event).
// More reliable than SendKeys for arbitrary characters and for password fields
// in a remote session. NOTE: the value remains on the clipboard afterwards —
// for secrets, follow up with set_clipboard "" to clear it.
async function pasteText(text: string): Promise<void> {
  const safe = escapePsSingleQuote(text);
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class KbdV {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
Set-Clipboard -Value '${safe}'
# 500ms (not a few ms): inside a Horizon/RDP session, Ctrl+V pastes the *remote*
# clipboard, which lags the local one by the redirection sync interval — too short a
# wait pastes stale remote-clipboard content instead of this text.
Start-Sleep -Milliseconds 500
[KbdV]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)  # Ctrl down
[KbdV]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)  # V down
[KbdV]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)  # V up
[KbdV]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)  # Ctrl up
`);
}

// Move the cursor without clicking (hover for menus/tooltips).
async function moveMouse(x: number, y: number, screen?: number): Promise<void> {
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MouseMv { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }
"@
${resolveCursorPs(x, y, screen)}
[MouseMv]::SetCursorPos($cx, $cy)
`);
}

// Press at (x1,y1), drag to (x2,y2) in small steps, release. Steps are needed
// so the target app registers a real drag (dragging windows, selecting text).
async function mouseDrag(
  x1: number, y1: number, x2: number, y2: number, button: "left" | "right" | "middle", screen?: number
): Promise<void> {
  const [down, up] = MOUSE_FLAGS[button];
  // Resolve a per-monitor offset ($ox,$oy) once and apply it to both endpoints, so a
  // drag described in `screen`-local coordinates lands on the right monitor.
  const offset = screen === undefined
    ? `$ox = 0; $oy = 0`
    : `Add-Type -AssemblyName System.Windows.Forms
$__b = [System.Windows.Forms.Screen]::AllScreens[${screen}].Bounds
$ox = $__b.X; $oy = $__b.Y`;
  await ps(`
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MouseDr {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
${offset}
$x1 = $ox + (${x1}); $y1 = $oy + (${y1}); $x2 = $ox + (${x2}); $y2 = $oy + (${y2})
[MouseDr]::SetCursorPos($x1, $y1); Start-Sleep -Milliseconds 60
[MouseDr]::mouse_event(${down}, 0, 0, 0, 0); Start-Sleep -Milliseconds 60
$steps = 24
for ($i = 1; $i -le $steps; $i++) {
  $nx = [int]($x1 + ($x2 - $x1) * $i / $steps)
  $ny = [int]($y1 + ($y2 - $y1) * $i / $steps)
  [MouseDr]::SetCursorPos($nx, $ny); Start-Sleep -Milliseconds 10
}
Start-Sleep -Milliseconds 60
[MouseDr]::mouse_event(${up}, 0, 0, 0, 0)
`);
}

// Poll a pixel until it matches a target color (within per-channel tolerance) or
// the timeout elapses. Each sample is a short PowerShell call, so the total wait
// can safely exceed the per-call timeout. Returns JSON { matched, color, elapsedMs }.
async function waitForPixel(
  x: number, y: number, hex: string,
  timeoutMs: number, intervalMs: number, tolerance: number
): Promise<string> {
  const target = parseHexColor(hex); // throws on malformed input
  const start = Date.now();
  for (;;) {
    let c = { R: -1, G: -1, B: -1, Hex: "" };
    try { c = JSON.parse(await getPixelColor(x, y)); } catch { /* keep sentinel */ }
    const matched =
      Math.abs(c.R - target.r) <= tolerance &&
      Math.abs(c.G - target.g) <= tolerance &&
      Math.abs(c.B - target.b) <= tolerance;
    const elapsedMs = Date.now() - start;
    if (matched) return JSON.stringify({ matched: true, color: c.Hex, elapsedMs });
    if (elapsedMs >= timeoutMs) return JSON.stringify({ matched: false, color: c.Hex, elapsedMs });
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs)));
  }
}

interface OcrLine { text: string; x: number; y: number; width: number; height: number }

// Poll OCR until a case-insensitive substring appears, or the timeout elapses.
// On a match, returns the found line's text and bounding box so the caller can
// click it. Returns JSON { matched, elapsedMs, match: OcrLine | null }.
async function waitForText(
  needle: string, timeoutMs: number, intervalMs: number,
  x?: number, y?: number, width?: number, height?: number
): Promise<string> {
  const hasRegion = x !== undefined && y !== undefined && width !== undefined && height !== undefined;
  const target = needle.toLowerCase();
  const start = Date.now();
  for (;;) {
    let lines: OcrLine[] = [];
    try {
      const parsed = JSON.parse(hasRegion ? await runOcr(x, y, width, height) : await runOcr());
      // ConvertTo-Json renders a single-element array as an object; normalize.
      lines = Array.isArray(parsed.lines) ? parsed.lines : parsed.lines ? [parsed.lines] : [];
    } catch { /* treat unparseable output as no match this round */ }
    const hit = lines.find((l) => (l.text ?? "").toLowerCase().includes(target));
    const elapsedMs = Date.now() - start;
    if (hit) {
      return JSON.stringify({
        matched: true, elapsedMs,
        match: { text: hit.text, x: hit.x, y: hit.y, width: hit.width, height: hit.height },
      });
    }
    if (elapsedMs >= timeoutMs) return JSON.stringify({ matched: false, elapsedMs, match: null });
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs)));
  }
}

// --- MCP Server setup ---

const server = new Server(
  { name: "horizon-mcp", version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "screenshot",
      description:
        "Capture one or all screens. Returns a PNG image. Omit 'screen' to capture all monitors side-by-side. Pass screen=0 for the primary monitor, screen=1 for the second monitor, etc.",
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
      description: "Move the mouse to (x, y) and click. On multi-monitor setups pass `screen` (the same index you screenshotted) so the click hits the right monitor.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Horizontal pixel coordinate" },
          y: { type: "number", description: "Vertical pixel coordinate" },
          button: {
            type: "string",
            enum: ["left", "right", "middle"],
            description: "Mouse button (default: left)",
          },
          screen: { type: "number", description: SCREEN_PARAM_DESC },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "double_click",
      description: "Double-click at (x, y) — use this to open apps or files. Pass `screen` (same index you screenshotted) on multi-monitor setups.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          screen: { type: "number", description: SCREEN_PARAM_DESC },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "type_text",
      description:
        "Type a string of text into the currently focused window. For Horizon apps, focus the window first.",
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
      description:
        "Press a named key or keyboard shortcut. Supported: Enter, Escape, Tab, Backspace, Delete, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1–F12, Ctrl+C, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+F, Alt+F4, Win.",
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
      description:
        "Return a JSON list of all visible windows (Id, Name, MainWindowTitle). Use this to find Horizon Client or a remote app PID before focusing it.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "focus_window",
      description:
        "Bring a window to the foreground, forcing it above other (including topmost) windows and restoring it if minimized. Pass a numeric process ID or a partial window title (case-insensitive).",
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
      name: "get_window_rect",
      description:
        "Return a window's screen rectangle as JSON {Title, Pid, Left, Top, Right, Bottom, Width, Height}. Pass a numeric PID or a partial window title. Use to target clicks relative to a window, or to verify a move/resize.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Process ID (number) or partial window title string" },
        },
        required: ["target"],
      },
    },
    {
      name: "window_action",
      description:
        "Minimize, maximize, restore, or close a window. Pass a numeric PID or partial title. 'close' sends WM_CLOSE — a graceful close the app may still prompt on (e.g. unsaved changes).",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Process ID (number) or partial window title string" },
          action: { type: "string", enum: ["minimize", "maximize", "restore", "close"], description: "Action to perform" },
        },
        required: ["target", "action"],
      },
    },
    {
      name: "set_window_bounds",
      description:
        "Move and/or resize a window. Pass a numeric PID or partial title plus any of x, y, width, height; omitted dimensions keep their current value. Coordinates are absolute screen pixels.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Process ID (number) or partial window title string" },
          x:      { type: "number", description: "New left edge (omit to keep current)" },
          y:      { type: "number", description: "New top edge (omit to keep current)" },
          width:  { type: "number", description: "New width (omit to keep current)" },
          height: { type: "number", description: "New height (omit to keep current)" },
        },
        required: ["target"],
      },
    },
    {
      name: "list_monitors",
      description:
        "Return a JSON array of monitors, each {device, primary, x, y, width, height, dpi, scale}. Coordinates are virtual-desktop pixels (secondary monitors can have negative x/y); scale is the percentage where 100 = no scaling. Use to map a multi-monitor layout before capturing or clicking.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "screenshot_region",
      description: "Capture a rectangular region of the screen and return it as a PNG image. Useful for cropping to just the chat area to reduce Vision API token cost.",
      inputSchema: {
        type: "object",
        properties: {
          x:      { type: "number", description: "Left edge pixel coordinate" },
          y:      { type: "number", description: "Top edge pixel coordinate" },
          width:  { type: "number", description: "Width in pixels" },
          height: { type: "number", description: "Height in pixels" },
        },
        required: ["x", "y", "width", "height"],
      },
    },
    {
      name: "screenshot_window",
      description:
        "Capture a single window as a PNG — the foreground window by default, or one identified by a numeric PID or partial title. Crops to the window's visible frame (DWM extended bounds), cutting Vision token cost versus a full-screen capture. The target must not be minimized.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Process ID (number) or partial window title; omit to capture the foreground window" },
        },
        required: [],
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
          x:         { type: "number", description: "Horizontal pixel coordinate to scroll at" },
          y:         { type: "number", description: "Vertical pixel coordinate to scroll at" },
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
          amount:    { type: "number", description: "Number of notches to scroll (default: 3)" },
          screen:    { type: "number", description: SCREEN_PARAM_DESC },
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
      name: "get_clipboard_image",
      description: "Return the image currently on the clipboard as a PNG. Errors if the clipboard holds no image. Use after a copy/Snip to pull a captured image into the conversation.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "set_clipboard_image",
      description: "Load an image file and place it on the clipboard, so it can be pasted into a remote app with Ctrl+V.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Filesystem path to the image file (PNG/JPG/BMP)" },
        },
        required: ["path"],
      },
    },
    {
      name: "ocr",
      description:
        "Extract text from the screen using the Windows built-in OCR engine. Free, offline, no API cost. " +
        "Returns JSON {text, lines[]} where each line has its text plus a bounding box {x, y, width, height} in absolute screen pixels and a words[] array of the same shape. " +
        "The boxes let you click located text directly (e.g. click a line's center) without a Vision round-trip to re-find it. " +
        "Omit x/y/width/height to scan the full primary screen, or pass all four to scan a region — box coordinates are absolute either way. " +
        "Use as a cheap pre-filter before sending screenshots to Claude Vision.",
      inputSchema: {
        type: "object",
        properties: {
          x:      { type: "number", description: "Left edge of region (omit for full primary screen)" },
          y:      { type: "number", description: "Top edge of region" },
          width:  { type: "number", description: "Width of region in pixels" },
          height: { type: "number", description: "Height of region in pixels" },
        },
        required: [],
      },
    },
    {
      name: "find_image",
      description:
        "Locate a reference image (template) on screen by pixel template-matching — a deterministic alternative to Vision for finding a known icon or button. " +
        "Pass the filesystem path to a template PNG. Returns JSON {found, score, x, y, width, height, centerX, centerY} in absolute screen pixels; click centerX/centerY to hit it. " +
        "score is 0–1 (1 = exact); a match must meet the threshold (default 0.9). Restrict the search to a region with x/y/width/height for speed. " +
        "Best for exact-pixel icons captured at the same scale; not robust to resizing or theme changes.",
      inputSchema: {
        type: "object",
        properties: {
          path:      { type: "string", description: "Filesystem path to the template image (PNG)" },
          threshold: { type: "number", description: "Match threshold 0–1 (default 0.9)" },
          x:         { type: "number", description: "Left edge of search region (omit to search the full primary screen)" },
          y:         { type: "number", description: "Top edge of search region" },
          width:     { type: "number", description: "Width of search region in pixels" },
          height:    { type: "number", description: "Height of search region in pixels" },
        },
        required: ["path"],
      },
    },
    {
      name: "key_combo",
      description:
        "Press a keyboard chord using real virtual-key codes (handles the Windows key and any modifier combination, which type_text/press_key cannot). " +
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
      name: "key_down",
      description:
        "Press and HOLD a single key without releasing it (via keybd_event). Pair with key_up to keep a key held across other actions — e.g. key_down Shift, click, click, key_up Shift to multi-select. Uses the same key names as key_combo.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name to hold down (e.g. Shift, Ctrl, Alt, A, F5)" },
        },
        required: ["key"],
      },
    },
    {
      name: "key_up",
      description:
        "Release a single key previously held with key_down (via keybd_event). Always release what you hold, or the key stays stuck down. Uses the same key names as key_combo.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name to release (e.g. Shift, Ctrl, Alt, A, F5)" },
        },
        required: ["key"],
      },
    },
    {
      name: "paste_text",
      description:
        "Place text on the clipboard and paste it with Ctrl+V. More reliable than type_text for arbitrary characters and for password fields in a remote session. " +
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
          screen: { type: "number", description: SCREEN_PARAM_DESC },
        },
        required: ["x", "y"],
      },
    },
    {
      name: "mouse_drag",
      description: "Press at (x1, y1), drag to (x2, y2), and release. Use to drag windows, select text, or resize. Pass `screen` (same index you screenshotted) on multi-monitor setups.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number", description: "Start horizontal pixel coordinate" },
          y1: { type: "number", description: "Start vertical pixel coordinate" },
          x2: { type: "number", description: "End horizontal pixel coordinate" },
          y2: { type: "number", description: "End vertical pixel coordinate" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button to hold during the drag (default: left)" },
          screen: { type: "number", description: SCREEN_PARAM_DESC },
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
    {
      name: "wait_for_pixel",
      description:
        "Poll a screen pixel until it matches a target color (within tolerance) or the timeout elapses. Use instead of a fixed wait to detect a UI state change — e.g. a button turning active or a spinner finishing. Returns JSON {matched, color, elapsedMs}.",
      inputSchema: {
        type: "object",
        properties: {
          x:          { type: "number", description: "Horizontal pixel coordinate" },
          y:          { type: "number", description: "Vertical pixel coordinate" },
          color:      { type: "string", description: "Target color as hex, e.g. \"#2ECC71\"" },
          timeoutMs:  { type: "number", description: "Max time to wait in ms (default 5000, max 120000)" },
          intervalMs: { type: "number", description: "Poll interval in ms (default 300)" },
          tolerance:  { type: "number", description: "Per-channel match tolerance 0–255 (default 10)" },
        },
        required: ["x", "y", "color"],
      },
    },
    {
      name: "wait_for_text",
      description:
        "Poll OCR until the given text appears on screen (case-insensitive substring) or the timeout elapses. Returns JSON {matched, elapsedMs, match} where match carries the found line's text and bounding box {x, y, width, height} so you can click it. Omit x/y/width/height to scan the full primary screen, or pass all four to scan a region.",
      inputSchema: {
        type: "object",
        properties: {
          text:       { type: "string", description: "Substring to wait for (case-insensitive)" },
          timeoutMs:  { type: "number", description: "Max time to wait in ms (default 10000, max 120000)" },
          intervalMs: { type: "number", description: "Poll interval in ms (default 600)" },
          x:          { type: "number", description: "Left edge of region (omit for full primary screen)" },
          y:          { type: "number", description: "Top edge of region" },
          width:      { type: "number", description: "Width of region in pixels" },
          height:     { type: "number", description: "Height of region in pixels" },
        },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

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
        const screen = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
        await mouseClick(x, y, (a.button as "left" | "right" | "middle") ?? "left", false, screen);
        return { content: [{ type: "text", text: `Clicked (${x}, ${y})` }] };
      }
      case "double_click": {
        const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
        const screen = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
        await mouseClick(x, y, "left", true, screen);
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
      case "get_window_rect": {
        const result = await getWindowRect(String(a.target));
        return { content: [{ type: "text", text: result }] };
      }
      case "window_action": {
        const action = String(a.action);
        if (!["minimize", "maximize", "restore", "close"].includes(action)) {
          throw new Error(`Invalid action: "${action}" (expected minimize|maximize|restore|close)`);
        }
        const result = await windowAction(String(a.target), action as "minimize" | "maximize" | "restore" | "close");
        return { content: [{ type: "text", text: result }] };
      }
      case "set_window_bounds": {
        const x = a.x !== undefined ? requireInt(a.x, "x") : undefined;
        const y = a.y !== undefined ? requireInt(a.y, "y") : undefined;
        const width = a.width !== undefined ? requireInt(a.width, "width") : undefined;
        const height = a.height !== undefined ? requireInt(a.height, "height") : undefined;
        if (x === undefined && y === undefined && width === undefined && height === undefined) {
          throw new Error("set_window_bounds requires at least one of x, y, width, height");
        }
        const result = await setWindowBounds(String(a.target), x, y, width, height);
        return { content: [{ type: "text", text: result }] };
      }
      case "list_monitors": {
        const result = await listMonitors();
        return { content: [{ type: "text", text: result }] };
      }
      case "screenshot_region": {
        const data = await screenshotRegion(
          requireInt(a.x, "x"), requireInt(a.y, "y"),
          requireInt(a.width, "width"), requireInt(a.height, "height")
        );
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }
      case "screenshot_window": {
        const target = a.target !== undefined ? String(a.target) : undefined;
        const data = await screenshotWindow(target);
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }
      case "get_pixel_color": {
        const result = await getPixelColor(requireInt(a.x, "x"), requireInt(a.y, "y"));
        return { content: [{ type: "text", text: result }] };
      }
      case "scroll": {
        const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
        const amount = a.amount !== undefined ? requireInt(a.amount, "amount") : 3;
        const screen = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
        await scroll(x, y, (a.direction as "up" | "down"), amount, screen);
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
      case "get_clipboard_image": {
        const data = await getClipboardImage();
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }
      case "set_clipboard_image": {
        await setClipboardImage(String(a.path));
        return { content: [{ type: "text", text: "Clipboard image set" }] };
      }
      case "ocr": {
        const hasRegion = a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined;
        const result = hasRegion
          ? await runOcr(
              requireInt(a.x, "x"), requireInt(a.y, "y"),
              requireInt(a.width, "width"), requireInt(a.height, "height")
            )
          : await runOcr();
        return { content: [{ type: "text", text: result }] };
      }
      case "find_image": {
        const path = String(a.path);
        const threshold = a.threshold !== undefined
          ? Math.min(Math.max(requireFinite(a.threshold, "threshold"), 0), 1)
          : 0.9;
        const hasRegion = a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined;
        const result = hasRegion
          ? await findImage(
              path, threshold,
              requireInt(a.x, "x"), requireInt(a.y, "y"),
              requireInt(a.width, "width"), requireInt(a.height, "height")
            )
          : await findImage(path, threshold);
        return { content: [{ type: "text", text: result }] };
      }
      case "key_combo": {
        const keys = parseKeyCombo(a.keys);
        const times = a.times !== undefined ? requireFinite(a.times, "times") : 1;
        const holdMs = a.holdMs !== undefined ? requireFinite(a.holdMs, "holdMs") : 0;
        await keyCombo(keys, times, holdMs);
        return { content: [{ type: "text", text: `Pressed: ${keys.join("+")}${times > 1 ? ` x${times}` : ""}` }] };
      }
      case "key_down": {
        await keyEvent(String(a.key), true);
        return { content: [{ type: "text", text: `Key down: ${a.key}` }] };
      }
      case "key_up": {
        await keyEvent(String(a.key), false);
        return { content: [{ type: "text", text: `Key up: ${a.key}` }] };
      }
      case "paste_text": {
        await pasteText(String(a.text));
        return { content: [{ type: "text", text: "Pasted via clipboard" }] };
      }
      case "move_mouse": {
        const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
        const screen = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
        await moveMouse(x, y, screen);
        return { content: [{ type: "text", text: `Moved to (${x}, ${y})` }] };
      }
      case "mouse_drag": {
        const x1 = requireInt(a.x1, "x1"), y1 = requireInt(a.y1, "y1");
        const x2 = requireInt(a.x2, "x2"), y2 = requireInt(a.y2, "y2");
        const screen = a.screen !== undefined ? requireInt(a.screen, "screen") : undefined;
        await mouseDrag(x1, y1, x2, y2, (a.button as "left" | "right" | "middle") ?? "left", screen);
        return { content: [{ type: "text", text: `Dragged (${x1}, ${y1}) → (${x2}, ${y2})` }] };
      }
      case "wait": {
        const ms = Math.min(Math.max(requireFinite(a.ms, "ms"), 0), 60000);
        await sleep(ms);
        return { content: [{ type: "text", text: `Waited ${ms} ms` }] };
      }
      case "wait_for_pixel": {
        const x = requireInt(a.x, "x"), y = requireInt(a.y, "y");
        const timeoutMs = Math.min(a.timeoutMs !== undefined ? requireFinite(a.timeoutMs, "timeoutMs") : 5000, 120000);
        const intervalMs = Math.max(a.intervalMs !== undefined ? requireFinite(a.intervalMs, "intervalMs") : 300, 50);
        const tolerance = a.tolerance !== undefined ? requireInt(a.tolerance, "tolerance") : 10;
        const result = await waitForPixel(x, y, String(a.color), timeoutMs, intervalMs, tolerance);
        return { content: [{ type: "text", text: result }] };
      }
      case "wait_for_text": {
        const timeoutMs = Math.min(a.timeoutMs !== undefined ? requireFinite(a.timeoutMs, "timeoutMs") : 10000, 120000);
        const intervalMs = Math.max(a.intervalMs !== undefined ? requireFinite(a.intervalMs, "intervalMs") : 600, 100);
        const hasRegion = a.x !== undefined && a.y !== undefined && a.width !== undefined && a.height !== undefined;
        const result = hasRegion
          ? await waitForText(
              String(a.text), timeoutMs, intervalMs,
              requireInt(a.x, "x"), requireInt(a.y, "y"),
              requireInt(a.width, "width"), requireInt(a.height, "height")
            )
          : await waitForText(String(a.text), timeoutMs, intervalMs);
        return { content: [{ type: "text", text: result }] };
      }
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

if (process.platform !== "win32") {
  process.stderr.write(
    `horizon-mcp requires Windows (win32); detected platform "${process.platform}". Exiting.\n`
  );
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
