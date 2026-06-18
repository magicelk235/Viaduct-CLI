// Runs the generated shim against a fake chrome and asserts the windows/devtools/app
// backfills: missing members are filled, native ones are NOT clobbered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/shim.js";

function runShim(chrome) {
  const window = { addEventListener() {} };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, window, undefined, { chrome });
  return chrome;
}

test("windows: backfills onBoundsChanged without clobbering native methods", () => {
  let nativeGetCalled = false;
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, create() {} },
    // Safari ships windows.get/create but omits onBoundsChanged.
    windows: { get: () => { nativeGetCalled = true; }, create() {} },
  };
  runShim(chrome);
  // Native member preserved.
  chrome.windows.get();
  assert.equal(nativeGetCalled, true);
  // Missing event backfilled as a usable inert event object.
  assert.equal(typeof chrome.windows.onBoundsChanged.addListener, "function");
  assert.doesNotThrow(() => chrome.windows.onBoundsChanged.addListener(() => {}));
  assert.equal(chrome.windows.WINDOW_ID_CURRENT, -2);
});

test("windows: full absence (iOS) → create routes to tabs, getAll resolves []", async () => {
  let openedUrl = null;
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, create: (o) => { openedUrl = o.url; } },
  };
  runShim(chrome);
  await chrome.windows.create({ url: "https://example.com/x" });
  assert.equal(openedUrl, "https://example.com/x");
  assert.deepEqual(await chrome.windows.getAll(), []);
});

test("devtools: panels/network/inspectedWindow stubbed so a devtools page loads", () => {
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  };
  runShim(chrome);
  assert.equal(typeof chrome.devtools.network.onRequestFinished.addListener, "function");
  assert.doesNotThrow(() => chrome.devtools.panels.create("t", "", "p.html", () => {}));
  assert.equal(chrome.devtools.inspectedWindow.tabId, -1);
});

test("app: isInstalled reports not-installed", async () => {
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  };
  runShim(chrome);
  assert.equal(chrome.app.isInstalled, false);
  assert.equal(chrome.app.getDetails(), null);
  assert.equal(await chrome.app.installState(), "not_installed");
});
