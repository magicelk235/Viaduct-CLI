import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome's tabs.setZoom(tabId, 0) means "back to the default zoom", which is how Vimium's
// zoomReset is written. Safari zooms a tab but has no such rule: measured live, a factor of
// 0 is clamped to its 50% minimum, so "reset" halves the page instead.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

function runShim() {
  const timers = new Set();
  const calls = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {} },
      onConnect: { addListener() {}, removeListener() {} },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} }),
    },
    storage: { local: area, session: area },
    tabs: {
      query: () => Promise.resolve([]),
      setZoom: (...args) => { calls.push(args); return Promise.resolve(); },
      getZoom: () => Promise.resolve(1),
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} },
    },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: { href: ORIGIN + "/background.html", protocol: "safari-web-extension:", origin: ORIGIN, pathname: "/background.html", search: "" },
    navigator: { userAgent: "test" },
    history: { state: null, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  return { chrome: sandbox.chrome, calls, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

test("setZoom with a factor of 0 resets to 100% instead of Safari's minimum", async (t) => {
  const { chrome, calls, dispose } = runShim();
  t.after(dispose);
  await chrome.tabs.setZoom(7, 0);
  await chrome.tabs.setZoom(0);
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [[7, 1], [1]]);
});

test("any other factor reaches Safari untouched", async (t) => {
  const { chrome, calls, dispose } = runShim();
  t.after(dispose);
  const cb = () => {};
  await chrome.tabs.setZoom(7, 1.5);
  chrome.tabs.setZoom(7, 0.5, cb);
  await chrome.tabs.setZoom(2);
  assert.deepEqual(calls, [[7, 1.5], [7, 0.5, cb], [2]]);
});
