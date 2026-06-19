import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/shim.js";

// Run the generated shim in a sandbox with a chrome mock that LACKS sidePanel
// (Safari), so the shim installs its sidePanel fallback. Then assert open()
// prefers the action popover over opening a tab — the bug was: shortcut →
// sidePanel.open() → new tab instead of the popup.
function runShimWith(chrome) {
  const sandbox = {
    chrome,
    Notification: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    setTimeout,
    clearTimeout,
    console,
    Promise,
    Date,
    URL,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Catch errors from unrelated API patches; we only care that sidePanel installs.
  try {
    vm.runInContext(shimSource(), sandbox);
  } catch (e) {
    // shim may throw later wiring unrelated namespaces; sidePanel runs early.
  }
  return chrome;
}

test("sidePanel.open() opens the action popover when available", async () => {
  let popupOpened = false;
  let tabCreated = false;
  const chrome = {
    runtime: { getURL: (p) => "ext://" + p, getManifest: () => ({ side_panel: { default_path: "panel.html" } }) },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: { openPopup: () => { popupOpened = true; return Promise.resolve(); } },
  };
  runShimWith(chrome);
  await chrome.sidePanel.open({});
  assert.ok(popupOpened, "should open the action popover");
  assert.ok(!tabCreated, "must not open a tab when popover is available");
});

test("sidePanel.open() falls back to a tab when openPopup rejects", async () => {
  let tabCreated = false;
  const chrome = {
    runtime: { getURL: (p) => "ext://" + p, getManifest: () => ({ side_panel: { default_path: "panel.html" } }) },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: { openPopup: () => Promise.reject(new Error("no focused window")) },
  };
  runShimWith(chrome);
  await chrome.sidePanel.open({});
  assert.ok(tabCreated, "should fall back to a tab when the popover cannot open");
});

test("sidePanel.open() falls back to a tab when openPopup is absent (old Safari)", async () => {
  let tabCreated = false;
  const chrome = {
    runtime: { getURL: (p) => "ext://" + p, getManifest: () => ({ side_panel: { default_path: "panel.html" } }) },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: {},
  };
  runShimWith(chrome);
  await chrome.sidePanel.open({});
  assert.ok(tabCreated, "old Safari without openPopup still opens the panel");
});
