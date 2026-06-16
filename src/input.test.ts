import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapePsSingleQuote,
  escapeSendKeys,
  requireFinite,
  requireInt,
  parseHexColor,
  vkOf,
  parseKeyCombo,
  buildKeyComboLines,
  VK_EXTENDED,
} from "./input.js";

test("escapePsSingleQuote doubles single quotes", () => {
  assert.equal(escapePsSingleQuote("it's a test"), "it''s a test");
  assert.equal(escapePsSingleQuote("no quotes"), "no quotes");
  assert.equal(escapePsSingleQuote("''"), "''''");
});

test("escapeSendKeys wraps metacharacters in braces", () => {
  assert.equal(escapeSendKeys("a+b"), "a{+}b");
  assert.equal(escapeSendKeys("(x)"), "{(}x{)}");
  assert.equal(escapeSendKeys("100%"), "100{%}");
  assert.equal(escapeSendKeys("plain text"), "plain text");
});

test("requireFinite accepts numbers and numeric strings, rejects the rest", () => {
  assert.equal(requireFinite(12, "x"), 12);
  assert.equal(requireFinite("42", "x"), 42);
  assert.equal(requireFinite("3.5", "x"), 3.5);
  assert.throws(() => requireFinite("abc", "x"), /x must be a finite number/);
  assert.throws(() => requireFinite(NaN, "x"), /x must be a finite number/);
  assert.throws(() => requireFinite(Infinity, "x"), /x must be a finite number/);
  assert.throws(() => requireFinite(undefined, "x"), /x must be a finite number/);
});

test("requireInt truncates toward zero", () => {
  assert.equal(requireInt("12.9", "x"), 12);
  assert.equal(requireInt(-3.7, "x"), -3);
  assert.throws(() => requireInt("nope", "y"), /y must be a finite number/);
});

test("parseHexColor parses with and without a leading hash, rejects malformed input", () => {
  assert.deepEqual(parseHexColor("#1A2B3C"), { r: 0x1a, g: 0x2b, b: 0x3c });
  assert.deepEqual(parseHexColor("ffffff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor("  #000000 "), { r: 0, g: 0, b: 0 });
  assert.throws(() => parseHexColor("#fff"), /Invalid hex color/);
  assert.throws(() => parseHexColor("nothex!"), /Invalid hex color/);
  assert.throws(() => parseHexColor("12345g"), /Invalid hex color/);
});

test("vkOf resolves names case-insensitively and rejects unknowns", () => {
  assert.equal(vkOf("Ctrl"), 0x11);
  assert.equal(vkOf("ctrl"), 0x11);
  assert.equal(vkOf("Win"), 0x5b);
  assert.equal(vkOf("A"), 65);
  assert.equal(vkOf("a"), 65);
  assert.equal(vkOf("5"), 0x35);
  assert.equal(vkOf("F5"), 0x74);
  assert.equal(vkOf("Insert"), 0x2d);
  assert.throws(() => vkOf("NotAKey"), /Unknown key in combo/);
});

test("parseKeyCombo handles arrays and plus-delimited strings", () => {
  assert.deepEqual(parseKeyCombo(["Win", "R"]), ["Win", "R"]);
  assert.deepEqual(parseKeyCombo("Ctrl+V"), ["Ctrl", "V"]);
  assert.deepEqual(parseKeyCombo("Ctrl + Alt + Insert"), ["Ctrl", "Alt", "Insert"]);
  assert.deepEqual(parseKeyCombo("Enter"), ["Enter"]);
});

test("buildKeyComboLines emits modifier-down, main, modifier-up in order", () => {
  const lines = buildKeyComboLines(["Win", "R"], 1, 0);
  // Win down, R down, R up, Win up
  assert.equal(lines.length, 4);
  assert.match(lines[0], /keybd_event\(91, 0, 1,/); // Win down, extended flag set
  assert.match(lines[1], /keybd_event\(82, 0, 0,/); // R down, not extended
  assert.match(lines[2], /keybd_event\(82, 0, 2,/); // R up (KEYUP=2)
  assert.match(lines[3], /keybd_event\(91, 0, 3,/); // Win up (extended|KEYUP = 3)
});

test("buildKeyComboLines repeats the main key with times and inserts hold sleeps", () => {
  const lines = buildKeyComboLines(["Alt", "Tab"], 3, 0);
  // Alt down, (Tab down, Tab up) x3 with a sleep between repeats, Alt up
  const tabDowns = lines.filter((l) => /keybd_event\(9, 0, 0,/.test(l)).length;
  assert.equal(tabDowns, 3);
  assert.equal(lines.filter((l) => /Start-Sleep/.test(l)).length, 2); // between the 3 presses

  const held = buildKeyComboLines(["Ctrl", "C"], 1, 100);
  assert.ok(held.some((l) => /Start-Sleep -Milliseconds 100/.test(l)));
});

test("buildKeyComboLines only ever interpolates integers (no injection)", () => {
  const lines = buildKeyComboLines(["Ctrl", "Alt", "Insert"], 1, 0);
  for (const l of lines) {
    if (l.startsWith("[Kbd]")) {
      // every argument inside keybd_event(...) must be an integer or [UIntPtr]::Zero
      assert.match(l, /^\[Kbd\]::keybd_event\(\d+, 0, \d+, \[UIntPtr\]::Zero\)$/);
    }
  }
});

test("VK_EXTENDED contains the navigation/Win keys that require the extended flag", () => {
  assert.ok(VK_EXTENDED.has(0x5b)); // Win
  assert.ok(VK_EXTENDED.has(0x26)); // Up
  assert.ok(!VK_EXTENDED.has(0x52)); // R is not extended
});

test("buildKeyComboLines rejects an empty chord", () => {
  assert.throws(() => buildKeyComboLines([], 1, 0), /requires at least one key/);
});
