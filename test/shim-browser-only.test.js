// Regression: Safari can expose `browser` with NO `chrome` global. A bare
// `browser !== chrome` in the shim then throws ReferenceError(chrome) and aborts
// the WHOLE shim — every stub below it never installs, cascading into "undefined
// is not an object" across runtime/scripting/dnr. (Hit Dark Reader live:
// "ReferenceError: Can't find variable: chrome (safari-compat-shim.js)".)
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/runtime/shim.js";

// Run the shim in a context where `browser` exists but `chrome` does NOT.
function runBrowserOnly(browser) {
  // No `chrome` param/binding at all → a bare `chrome` reference throws.
  const fn = new Function("browser", "self", "window", "globalThis", shimSource());
  const self = { addEventListener() {} };
  fn(browser, self, undefined, { browser });
  return browser;
}

test("shim does not throw when `browser` exists but `chrome` is undefined", () => {
  const browser = { runtime: { id: "x", lastError: null, getManifest: () => ({}) }, storage: { local: {} }, scripting: {} };
  assert.doesNotThrow(() => runBrowserOnly(browser));
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
