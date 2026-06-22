// The shim's catch-all safety net: documented chrome.* namespaces that aren't
// explicitly shimmed (rare/ChromeOS-only) must degrade to inert no-ops instead
// of throwing TypeError when an extension touches them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/runtime/shim.js";

function setup() {
  const chrome = { runtime: { lastError: null, getManifest: () => ({}) } };
  const window = { addEventListener() {} };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, window, undefined, { chrome });
  return chrome;
}

test("catch-all: an unshimmed namespace exists instead of being undefined", () => {
  const chrome = setup();
  assert.ok(chrome.audio, "chrome.audio should be defined by the net");
  assert.ok(chrome.dns, "chrome.dns should be defined");
  assert.ok(chrome.systemLog, "chrome.systemLog should be defined");
});

test("catch-all: a method call resolves (promise) instead of throwing", async () => {
  const chrome = setup();
  const v = await chrome.audio.getDevices({});
  assert.equal(v, undefined);
});

test("catch-all: a method call invokes a trailing callback with undefined", () => {
  const chrome = setup();
  let called = false;
  chrome.audio.getDevices({}, (r) => { called = true; assert.equal(r, undefined); });
  assert.ok(called, "callback should have fired");
});

test("catch-all: nested sub-namespace access does not throw", async () => {
  const chrome = setup();
  // chrome.dns.resolve(...) style — recurse then call.
  const r = await chrome.dns.resolve("example.com");
  assert.equal(r, undefined);
});

test("catch-all: event-shaped members expose addListener and never fire", () => {
  const chrome = setup();
  let fired = false;
  chrome.audio.onLevelChanged.addListener(() => { fired = true; });
  assert.equal(typeof chrome.audio.onLevelChanged.addListener, "function");
  assert.equal(chrome.audio.onLevelChanged.hasListener(), false);
  assert.equal(fired, false);
});

test("catch-all: does NOT clobber an explicitly shimmed namespace", () => {
  const chrome = setup();
  // chrome.tts is a real shim that routes to Web Speech — must keep its speak().
  assert.equal(typeof chrome.tts.speak, "function");
});
