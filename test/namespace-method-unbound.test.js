import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome's namespace functions don't depend on `this`. Hypothesis copies them out
//   scripting: { executeScript: chrome.scripting.executeScript }
// and calls them off that plain object. WebKit keeps them on the namespace prototype and
// treats `this` as the namespace: measured in Safari, executeScript called that way
// resolves undefined without running, so Hypothesis's sidebar never loaded. The model
// below is a WebKit-style namespace: a class whose prototype methods refuse a foreign
// `this`, exactly how the native silently returns nothing.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

function webkitNamespace(tag, methods) {
  class NS {}
  for (const [name, fn] of Object.entries(methods)) {
    Object.defineProperty(NS.prototype, name, {
      value: function (...args) { return this instanceof NS ? fn(...args) : undefined; },
      writable: false, enumerable: false, configurable: true,
    });
  }
  Object.defineProperty(NS.prototype, Symbol.toStringTag, { value: tag });
  return new NS();
}

function runShim() {
  const timers = new Set();
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: () => Promise.resolve(),
      onMessage: ev(), onConnect: ev(),
      connect: () => ({ onDisconnect: ev(), onMessage: ev(), postMessage() {} }),
    },
    storage: { local: area, session: area },
    scripting: webkitNamespace("Scripting", { executeScript: () => Promise.resolve([{ frameId: 0, result: 28 }]) }),
    tabs: Object.assign(webkitNamespace("Tabs", { query: () => Promise.resolve([{ id: 7 }]) }), {
      onUpdated: ev(), onRemoved: ev(), onActivated: ev(),
    }),
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
  return { chrome: sandbox.chrome, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

test("a namespace method copied off its namespace still runs", async (t) => {
  const { chrome, dispose } = runShim();
  t.after(dispose);
  const api = { scripting: { executeScript: chrome.scripting.executeScript } };
  const results = await api.scripting.executeScript({ target: { tabId: 7 }, files: ["boot.js"] });
  assert.equal(results[0].result, 28);
  const detached = chrome.scripting.executeScript;
  assert.equal((await detached({ target: { tabId: 7 }, files: ["boot.js"] }))[0].result, 28);
});

test("the shim's own assignments over namespace methods still land", async (t) => {
  // wrapTabsQuery and friends assign over tabs.query; a read-only prototype property
  // would make that throw in the shim's strict code and abort everything after it.
  const { chrome, dispose } = runShim();
  t.after(dispose);
  chrome.tabs.extra = 1;
  const tabs = await chrome.tabs.query({});
  assert.equal(tabs[0].id, 7);
  const replacement = () => "mine";
  chrome.scripting.executeScript = replacement;
  assert.equal(chrome.scripting.executeScript, replacement);
});
