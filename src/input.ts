// Pure, side-effect-free helpers for input handling and validation.
//
// This module is intentionally free of I/O and PowerShell execution so it can be
// unit-tested without spawning the server. index.ts imports these helpers and is
// responsible for the actual PowerShell/Win32 calls and MCP wiring.

/** Escape a string for safe embedding inside a PowerShell single-quoted literal. */
export function escapePsSingleQuote(s: string): string {
  // In a single-quoted PowerShell string the only metacharacter is the quote
  // itself, which is escaped by doubling it. No $ or backtick expansion occurs.
  return s.replace(/'/g, "''");
}

/** Escape SendKeys metacharacters by wrapping each in braces. */
export function escapeSendKeys(s: string): string {
  return s.replace(/([+^%~(){}[\]])/g, "{$1}");
}

/**
 * Validate that a value coerces to a finite number; throw a clear error otherwise.
 * Guards against NaN/Infinity reaching the interpolated PowerShell scripts.
 */
export function requireFinite(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number (received ${JSON.stringify(v)})`);
  }
  return n;
}

/** Validate a finite value and truncate it to an integer (for pixel coordinates/indices). */
export function requireInt(v: unknown, name: string): number {
  return Math.trunc(requireFinite(v, name));
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parse a hex color (`"#1A2B3C"` or `"1a2b3c"`) into RGB. Throws on malformed input. */
export function parseHexColor(hex: string): RGB {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) {
    throw new Error(`Invalid hex color: ${JSON.stringify(hex)} (expected RRGGBB)`);
  }
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// Virtual-key codes for keybd_event (case-insensitive lookup).
// Unlike SendKeys, keybd_event can send the real Windows key and any chord,
// which is required to drive a remote Horizon session (Win+R, Alt+Tab,
// Ctrl+Alt+Insert = remote Ctrl+Alt+Del, Win+number, etc.).
export const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, shift: 0x10,
  win: 0x5b, lwin: 0x5b, rwin: 0x5c,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  apps: 0x5d, menukey: 0x5d, printscreen: 0x2c, prtsc: 0x2c, capslock: 0x14, pause: 0x13,
};
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c).toLowerCase()] = c; // a-z
for (let d = 0; d <= 9; d++) VK[String(d)] = 0x30 + d;                       // 0-9
for (let f = 1; f <= 24; f++) VK["f" + f] = 0x6f + f;                        // F1=0x70 .. F24=0x87

// Keys on the extended-key region (arrows, nav block, Win, Apps) need the
// KEYEVENTF_EXTENDEDKEY flag so they are interpreted correctly.
export const VK_EXTENDED = new Set([
  0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x5b, 0x5c, 0x5d, 0x2c,
]);

/** Look up the virtual-key code for a key name; throw on an unknown name. */
export function vkOf(name: string): number {
  const v = VK[name.trim().toLowerCase()];
  if (v === undefined) throw new Error(`Unknown key in combo: "${name}"`);
  return v;
}

/** Parse the key_combo `keys` argument: an array, or a single "Ctrl+V"-style string. */
export function parseKeyCombo(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split("+").map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the keybd_event statement lines for a key chord (without the Add-Type
 * wrapper). Modifiers come first, the main key last: e.g. ["Win","R"],
 * ["Ctrl","Alt","Insert"], ["Alt","Tab"]. `times` repeats the main key while the
 * modifiers stay held. All emitted values are integers from the validated VK map,
 * so user input is never interpolated into the script.
 */
export function buildKeyComboLines(keys: string[], times: number, holdMs: number): string[] {
  if (keys.length === 0) throw new Error("key_combo requires at least one key");
  const codes = keys.map(vkOf);
  const main = codes[codes.length - 1];
  const mods = codes.slice(0, -1);
  const repeat = Math.max(1, Math.floor(times));
  // KEYEVENTF_EXTENDEDKEY=0x1, KEYEVENTF_KEYUP=0x2
  const ev = (vk: number, up: boolean) =>
    `[Kbd]::keybd_event(${vk}, 0, ${(VK_EXTENDED.has(vk) ? 1 : 0) | (up ? 2 : 0)}, [UIntPtr]::Zero)`;
  const lines: string[] = [];
  for (const m of mods) lines.push(ev(m, false));
  for (let i = 0; i < repeat; i++) {
    lines.push(ev(main, false));
    if (holdMs > 0) lines.push(`Start-Sleep -Milliseconds ${Math.floor(holdMs)}`);
    lines.push(ev(main, true));
    if (i < repeat - 1) lines.push(`Start-Sleep -Milliseconds 40`);
  }
  for (const m of [...mods].reverse()) lines.push(ev(m, true));
  return lines;
}

/**
 * Build a single keybd_event statement for pressing (down) or releasing (up) one
 * key. Used by the key_down / key_up primitives. Emits only integers from the
 * validated VK map, so there is no script injection.
 */
export function buildKeyEventLine(key: string, isDown: boolean): string {
  const vk = vkOf(key);
  // KEYEVENTF_EXTENDEDKEY=0x1, KEYEVENTF_KEYUP=0x2
  const flags = (VK_EXTENDED.has(vk) ? 1 : 0) | (isDown ? 0 : 2);
  return `[Kbd]::keybd_event(${vk}, 0, ${flags}, [UIntPtr]::Zero)`;
}

export interface KeyStroke {
  vk: number;
  shift: boolean;
}

// Shifted top-row digits and OEM punctuation on a US (ENG) keyboard layout.
const SHIFTED_DIGIT: Record<string, number> = {
  ")": 0x30, "!": 0x31, "@": 0x32, "#": 0x33, "$": 0x34,
  "%": 0x35, "^": 0x36, "&": 0x37, "*": 0x38, "(": 0x39,
};
const OEM_CHARS: Record<string, [number, boolean]> = {
  ";": [0xba, false], ":": [0xba, true],
  "=": [0xbb, false], "+": [0xbb, true],
  ",": [0xbc, false], "<": [0xbc, true],
  "-": [0xbd, false], "_": [0xbd, true],
  ".": [0xbe, false], ">": [0xbe, true],
  "/": [0xbf, false], "?": [0xbf, true],
  "`": [0xc0, false], "~": [0xc0, true],
  "[": [0xdb, false], "{": [0xdb, true],
  "\\": [0xdc, false], "|": [0xdc, true],
  "]": [0xdd, false], "}": [0xdd, true],
  "'": [0xde, false], '"': [0xde, true],
};

/**
 * Map a single character to its US-layout virtual-key code and whether Shift is held.
 * type_text drives keybd_event with this — the same low-level path key_combo/paste use,
 * which reaches locked-down/remote sessions where SendKeys does not. Returns null for
 * characters not on the US layout (accented/non-ASCII) and for "\r" (so a "\r\n" pair
 * yields a single Enter); callers skip nulls.
 */
export function charToStroke(ch: string): KeyStroke | null {
  if (ch.length !== 1) return null; // surrogate-pair code points etc.
  if (ch >= "a" && ch <= "z") return { vk: ch.charCodeAt(0) - 32, shift: false }; // VK = uppercase
  if (ch >= "A" && ch <= "Z") return { vk: ch.charCodeAt(0), shift: true };
  if (ch >= "0" && ch <= "9") return { vk: ch.charCodeAt(0), shift: false };
  if (ch === " ") return { vk: 0x20, shift: false };
  if (ch === "\t") return { vk: 0x09, shift: false };
  if (ch === "\n") return { vk: 0x0d, shift: false };
  if (ch in SHIFTED_DIGIT) return { vk: SHIFTED_DIGIT[ch], shift: true };
  if (ch in OEM_CHARS) return { vk: OEM_CHARS[ch][0], shift: OEM_CHARS[ch][1] };
  return null;
}

/**
 * Build the keybd_event statement lines to TYPE `text` one character at a time, holding
 * Shift around characters that need it, with `delayMs` between characters so the remote
 * (laptop -> Horizon -> session) keeps up. Characters not on the US layout are skipped.
 * Emits only integers, so there is no script injection. Pairs with the [Kbd] Add-Type
 * wrapper in index.ts.
 */
export function buildTypeLines(text: string, delayMs: number, holdMs = 0): string[] {
  // Supply the real hardware scan code (MapVirtualKey), not 0. Horizon forwards
  // keyboard input to the remote by SCAN CODE; a keybd_event with bScan=0 is dropped
  // for bare alphanumeric/space keys (field-tested), while keys with a modifier or OEM
  // keys happened to get through. Only the integer VK is interpolated, so no injection.
  const ev = (vk: number, up: boolean) =>
    `[Kbd]::keybd_event(${vk}, [byte]([Kbd]::MapVirtualKey(${vk}, 0)), ${(VK_EXTENDED.has(vk) ? 1 : 0) | (up ? 2 : 0)}, [UIntPtr]::Zero)`;
  const sleep = (ms: number) => `Start-Sleep -Milliseconds ${Math.floor(ms)}`;
  const SHIFT = 0x10;
  const lines: string[] = [];
  for (const ch of text) {
    const s = charToStroke(ch);
    if (!s) continue; // not representable on the US layout — skip
    if (s.shift) lines.push(ev(SHIFT, false));
    lines.push(ev(s.vk, false));
    // Hold the key down briefly before releasing. A zero-duration press (down+up in
    // the same instant) is dropped by the remote Horizon input pipeline for simple
    // keys; a short hold makes each keystroke register reliably.
    if (holdMs > 0) lines.push(sleep(holdMs));
    lines.push(ev(s.vk, true));
    if (s.shift) lines.push(ev(SHIFT, true));
    if (delayMs > 0) lines.push(sleep(delayMs));
  }
  return lines;
}
