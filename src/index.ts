import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Run PowerShell using Base64-encoded command to avoid escaping issues
async function ps(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout, stderr } = await execAsync(
    `powershell -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`,
    { maxBuffer: 50 * 1024 * 1024, windowsHide: true }
  );
  if (stderr) process.stderr.write(stderr);
  return stdout.trim();
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
async function mouseClick(
  x: number,
  y: number,
  button: "left" | "right",
  double_: boolean
): Promise<void> {
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
async function sendText(text: string): Promise<void> {
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

// Bring a window to the foreground by PID or partial title
async function focusWindow(pidOrTitle: string): Promise<string> {
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
async function scroll(x: number, y: number, direction: "up" | "down", amount: number): Promise<void> {
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
async function getClipboard(): Promise<string> {
  return ps(`Get-Clipboard`);
}

// Write text to the clipboard
async function setClipboard(text: string): Promise<void> {
  const safeText = text.replace(/'/g, "''");
  await ps(`Set-Clipboard -Value '${safeText}'`);
}

// Extract text from the screen (or a region) using Windows built-in WinRT OCR.
// Returns JSON { text: string, lines: string[] }.
// Uses a temp PNG file to bridge System.Drawing and the WinRT BitmapDecoder.
async function runOcr(x?: number, y?: number, width?: number, height?: number): Promise<string> {
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

function Await([object]$Op) {
    $iface = $Op.GetType().GetInterfaces() |
             Where-Object { $_.IsGenericType -and $_.Name -eq 'IAsyncOperation\`1' } |
             Select-Object -First 1
    $m = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
          Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
          Select-Object -First 1).MakeGenericMethod($iface.GenericTypeArguments[0])
    $m.Invoke($null, @($Op)).GetAwaiter().GetResult()
}

${captureScript}
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid().ToString('N') + '.png')
$bmp.Save($tmp); $bmp.Dispose()

try {
    $sf   = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp))
    $stm  = Await ($sf.OpenReadAsync())
    $dec  = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stm))
    $sbmp = Await ($dec.GetSoftwareBitmapAsync())
    $eng  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $eng) { throw 'No OCR engine available — install a language pack in Windows Settings' }
    $res   = Await ($eng.RecognizeAsync($sbmp))
    $lines = @($res.Lines | ForEach-Object { $_.Text })
    ConvertTo-Json -Compress @{ text = $res.Text; lines = $lines }
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
`);
}

// --- MCP Server setup ---

const server = new Server(
  { name: "horizon-mcp", version: "1.0.0" },
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
        "Bring a window to the foreground. Pass a numeric process ID or a partial window title (case-insensitive).",
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
          x:      { type: "number", description: "Left edge pixel coordinate" },
          y:      { type: "number", description: "Top edge pixel coordinate" },
          width:  { type: "number", description: "Width in pixels" },
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
          x:         { type: "number", description: "Horizontal pixel coordinate to scroll at" },
          y:         { type: "number", description: "Vertical pixel coordinate to scroll at" },
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction" },
          amount:    { type: "number", description: "Number of notches to scroll (default: 3)" },
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
      description:
        "Extract text from the screen using the Windows built-in OCR engine. Free, offline, no API cost. " +
        "Returns JSON {text, lines[]}. Omit x/y/width/height to scan the full primary screen, or pass all four to scan a region. " +
        "Use as a cheap pre-filter before sending screenshots to Claude Vision — if OCR text is unchanged, skip the Vision call.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

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
        await mouseClick(
          Number(a.x),
          Number(a.y),
          (a.button as "left" | "right") ?? "left",
          false
        );
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
      case "get_foreground_window": {
        const result = await getForegroundWindow();
        return { content: [{ type: "text", text: result }] };
      }
      case "screenshot_region": {
        const data = await screenshotRegion(
          Number(a.x), Number(a.y), Number(a.width), Number(a.height)
        );
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }
      case "get_pixel_color": {
        const result = await getPixelColor(Number(a.x), Number(a.y));
        return { content: [{ type: "text", text: result }] };
      }
      case "scroll": {
        const amount = a.amount !== undefined ? Number(a.amount) : 3;
        await scroll(Number(a.x), Number(a.y), (a.direction as "up" | "down"), amount);
        return { content: [{ type: "text", text: `Scrolled ${a.direction} ${amount} notch(es) at (${a.x}, ${a.y})` }] };
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
          ? await runOcr(Number(a.x), Number(a.y), Number(a.width), Number(a.height))
          : await runOcr();
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

const transport = new StdioServerTransport();
await server.connect(transport);
