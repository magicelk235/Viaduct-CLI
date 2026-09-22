import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome opens a side panel with no query, but an extension can open the same page
// itself with one — Claude in Chrome's scheduled tasks open
// `sidepanel.html?mode=window` — and branch on it at first render. Since 1.0.94 the
// bare URL selects an embed of claude.ai that Safari cannot frame (Safari-Quirks E11),
// while `mode=window` selects the classic panel that works. `--panel-query` writes
// that query into the side-panel document's URL at shim boot, synchronously, so the
// page's own `new URLSearchParams(location.search).get("mode")` sees it.

function runShimOnPage(href, manifest, config) {
  const timers = new Set();
  const url = new URL(href);
  const location = { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search };
  const replaceStateCalls = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "abc",
      lastError: null,
      getURL: (p) => "safari-web-extension://abc" + (p.startsWith("/") ? p : "/" + p),
      getManifest: () => manifest,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    storage: { local: area, sync: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: {
      query: (_q, cb) => { const r = [{ id: 42, url: "https://example.com/" }]; if (typeof cb === "function") cb(r); return Promise.resolve(r); },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location,
    history: {
      state: null,
      pushState() {},
      replaceState(state, _title, u) {
        replaceStateCalls.push(u);
        const next = new URL(u);
        location.href = next.href;
        location.pathname = next.pathname;
        location.search = next.search;
      },
    },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(config), sandbox, { filename: "safari-compat-shim.js" });
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { location, replaceStateCalls, dispose };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const sidePanelManifest = { manifest_version: 3, side_panel: { default_path: "sidepanel.html" }, action: { default_popup: "sidepanel.html" } };

test("the configured query is on the side panel's URL before its own scripts run, and ?tabId still follows", async (t) => {
  const { location, dispose } = runShimOnPage("safari-web-extension://abc/sidepanel.html", sidePanelManifest, { panelQuery: "mode=window" });
  t.after(dispose);

  // Synchronous: the page reads `mode` at first render, not after a tab lookup.
  assert.equal(new URLSearchParams(location.search).get("mode"), "window");

  await settle();
  const q = new URLSearchParams(location.search);
  assert.equal(q.get("mode"), "window");
  assert.equal(q.get("tabId"), "42", "the tabId injection must still land on top of the configured query");
});

test("a key the extension already put on the URL wins over the configured one", async (t) => {
  const { location, dispose } = runShimOnPage("safari-web-extension://abc/sidepanel.html?mode=tab&sessionId=s1", sidePanelManifest, { panelQuery: "mode=window&skipPermissions=true" });
  t.after(dispose);

  const q = new URLSearchParams(location.search);
  assert.equal(q.get("mode"), "tab", "an extension-supplied value is not overwritten");
  assert.equal(q.get("sessionId"), "s1");
  assert.equal(q.get("skipPermissions"), "true", "missing keys are still added");
});

test("a plain action popup is left alone even when a query is configured", async (t) => {
  const { location, replaceStateCalls, dispose } = runShimOnPage("safari-web-extension://abc/popover/popover.html", { manifest_version: 3, action: { default_popup: "popover/popover.html" } }, { panelQuery: "mode=window" });
  t.after(dispose);

  await settle();
  assert.deepEqual(replaceStateCalls, [], "only a side-panel page carries the query; a popup URL stays equal to getURL(path)");
  assert.equal(location.search, "");
});

test("no configured query → the side panel's URL only gains tabId", async (t) => {
  const { location, dispose } = runShimOnPage("safari-web-extension://abc/sidepanel.html", sidePanelManifest, {});
  t.after(dispose);

  await settle();
  assert.deepEqual([...new URLSearchParams(location.search).keys()], ["tabId"]);
});
