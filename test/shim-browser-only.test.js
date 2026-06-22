// Regression: Safari can expose `browser` with NO `chrome` global. A bare
// `browser !== chrome` in the shim then throws ReferenceError(chrome) and aborts
// the WHOLE shim — every stub below it never installs, cascading into "undefined
// is not an object" across runtime/scripting/dnr. (Hit Dark Reader live:
// "ReferenceError: Can't find variable: chrome (safari-compat-shim.js)".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/runtime/shim.js";

// Run the shim in a context where `browser` exists but `chrome` does NOT.
// Returns the globalThis we passed in so callers can assert what got published.
function runBrowserOnly(browser) {
  // No `chrome` param/binding at all → a bare `chrome` reference throws.
  const fn = new Function("browser", "self", "window", "globalThis", shimSource());
  const self = { addEventListener() {} };
  const glob = { browser };
  fn(browser, self, undefined, glob);
  return glob;
}

test("shim does not throw when `browser` exists but `chrome` is undefined", () => {
  const browser = { runtime: { id: "x", lastError: null, getManifest: () => ({}) }, storage: { local: {} }, scripting: {} };
  assert.doesNotThrow(() => runBrowserOnly(browser));
});

// Regression: the converted bundles call `chrome.*` directly at top level
// (popup.js: `chrome.storage.local`). When Safari gives a page only `browser`,
// a missing global `chrome` throws "chrome is not defined" and kills the whole
// script → blank popups / dead content scripts / dead background. The shim must
// publish `globalThis.chrome = browser` so those reads resolve.
test("shim publishes a global `chrome` aliased to `browser` when chrome is absent", () => {
  const browser = { runtime: { id: "x", getManifest: () => ({}) }, storage: { local: {} }, scripting: {} };
  const glob = runBrowserOnly(browser);
  assert.equal(glob.chrome, browser, "global chrome should alias browser");
});

test("shim backfills runtime/scripting enums on the browser namespace (no chrome)", () => {
  const browser = { runtime: { id: "x", getManifest: () => ({}) }, scripting: {} };
  runBrowserOnly(browser);
  assert.equal(browser.runtime.OnInstalledReason.INSTALL, "install");
  assert.equal(browser.scripting.ExecutionWorld.ISOLATED, "ISOLATED");
});

test("shim backfills runtime + DNR + scripting enums on chrome (normal case)", () => {
  const chrome = { runtime: { id: "x", getManifest: () => ({}) }, scripting: {}, declarativeNetRequest: {} };
  const fn = new Function("chrome", "self", "window", "globalThis", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome });
  assert.equal(chrome.runtime.OnInstalledReason.UPDATE, "update");
  assert.equal(chrome.scripting.ExecutionWorld.MAIN, "MAIN");
  assert.equal(chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, "modifyHeaders");
  assert.equal(typeof chrome.declarativeNetRequest.onRuleMatchedDebug.addListener, "function");
});
