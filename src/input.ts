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
