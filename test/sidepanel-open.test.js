import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

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

// In-memory chrome.storage.session, matching the promise+callback dual signatures the
// shim's toggle-state helpers use. Without it the open/closed flag can't persist across
// presses and the toggle can't be exercised.
function sessionStore() {
  const data = {};
  return {
    get: (key, cb) => {
      const out = {};
      if (typeof key === "string") { if (key in data) out[key] = data[key]; }
      else if (Array.isArray(key)) { for (const k of key) if (k in data) out[k] = data[k]; }
      else if (key && typeof key === "object") { for (const k of Object.keys(key)) out[k] = (k in data) ? data[k] : key[k]; }
      else Object.assign(out, data);
      if (typeof cb === "function") { cb(out); return; }
      return Promise.resolve(out);
    },
    set: (obj, cb) => { Object.assign(data, obj); if (typeof cb === "function") { cb(); return; } return Promise.resolve(); },
  };
}

test("sidePanel.open() opens the action popover when available", async () => {
  let popupOpened = false;
  let tabCreated = false;
  const chrome = {
    runtime: { getURL: (p) => "ext://" + p, getManifest: () => ({ side_panel: { default_path: "panel.html" } }) },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: { openPopup: () => { popupOpened = true; return Promise.resolve(); } },
    storage: { session: sessionStore() },
  };
  runShimWith(chrome);
  await chrome.sidePanel.open({});
  assert.ok(popupOpened, "should open the action popover");
  assert.ok(!tabCreated, "must not open a tab when popover is available");
});

// The real toggle: 1st press opens the popover; 2nd press (popover already open, flag
// set) must CLOSE it — broadcast {__c2sClosePanel} so the popover doc self-closes via
// window.close() — and must NOT call openPopup again or spawn a tab. 3rd press reopens.
test("sidePanel.open() toggles: open → close (close message) → open", async () => {
  let openCount = 0;
  let tabCreated = false;
  const closeMsgs = [];
  const chrome = {
    runtime: {
      getURL: (p) => "ext://" + p,
      getManifest: () => ({ side_panel: { default_path: "panel.html" } }),
      sendMessage: (m) => { if (m && m.__c2sClosePanel) closeMsgs.push(m); return Promise.resolve(); },
    },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: { openPopup: () => { openCount++; return Promise.resolve(); } },
    storage: { session: sessionStore() },
  };
  runShimWith(chrome);

  await chrome.sidePanel.open({});      // press 1: open
  assert.equal(openCount, 1, "1st press opens the popover");
  assert.equal(closeMsgs.length, 0, "1st press sends no close message");

  await chrome.sidePanel.open({});      // press 2: close
  assert.equal(openCount, 1, "2nd press must NOT open the popover again");
  assert.equal(closeMsgs.length, 1, "2nd press broadcasts a close message to the popover doc");
  assert.ok(!tabCreated, "2nd press must not spawn a tab");

  await chrome.sidePanel.open({});      // press 3: reopen
  assert.equal(openCount, 2, "3rd press reopens the popover");
  assert.equal(closeMsgs.length, 1, "3rd press does not send another close message");
});

// Regression (claude-chrome Cmd+E): openPopup() REJECTS when the popover is already
// open. A `toggle-side-panel` shortcut fires sidePanel.open on every press, so the 2nd
// press rejects → the old code spawned a duplicate extension TAB ("local" tab) on every
// other keypress. Safari has no popover-close/-state API, so re-pressing must be a
// no-op, NOT a new tab. Only a wholly-absent openPopup (old Safari) may fall back.
test("sidePanel.open() does NOT open a tab when openPopup rejects (popover already open)", async () => {
  let tabCreated = false;
  const chrome = {
    runtime: { getURL: (p) => "ext://" + p, getManifest: () => ({ side_panel: { default_path: "panel.html" } }) },
    tabs: { create: () => { tabCreated = true; return Promise.resolve({}); } },
    action: { openPopup: () => Promise.reject(new Error("popover already open")) },
  };
  runShimWith(chrome);
  await chrome.sidePanel.open({});
  assert.ok(!tabCreated, "a re-press (openPopup reject) must be a no-op, not a stray tab");
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

// Regression: the tabId panel shim must NOT monkeypatch URLSearchParams.prototype.get.
// Doing so clobbered a native method for every URLSearchParams instance in the doc,
// feeding unrelated app code the injected tabId. The tabId now reaches consumers via
// history.replaceState writing it into location.search instead.
test("shim does not clobber URLSearchParams.prototype.get", () => {
  assert.ok(
    !/URLSearchParams\.prototype\.get\s*=/.test(shimSource()),
    "shim must not override the native URLSearchParams.prototype.get"
  );
});
