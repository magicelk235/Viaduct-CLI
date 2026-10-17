import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari's webRequest addListener throws on a ws:// or wss:// URL filter, and the shim
// sanitizes the filter by patching the event's addListener. WebKit hands out a fresh
// event wrapper, with a fresh prototype, on a later read of chrome.webRequest.onX, so a
// patch on the boot-time wrapper or its prototype could be gone by the time the
// extension registers. Privacy Badger's startListeners then reached the native method
// with ["http://*/*","https://*/*","ws://*/*","wss://*/*"], threw, and never created
// its badger object (2 of 3 fresh installs, measured).

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

function runShim() {
  const timers = new Set();
  const registered = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  // Every read of an event property materializes a new wrapper on a new prototype.
  const freshEvent = (name) => {
    const proto = {
      addListener(fn, filter) {
        for (const u of (filter && filter.urls) || []) {
          if (!/^(\*|https?|file|ftp):\/\//.test(u) && u !== "<all_urls>") throw new Error(`'${u}' is an invalid match pattern`);
        }
        registered.push({ name, urls: filter && filter.urls });
      },
      removeListener() {}, hasListener: () => false,
    };
    return Object.create(proto);
  };
  const webRequest = {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onAuthRequired",
    "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"]) {
    Object.defineProperty(webRequest, name, { get: () => freshEvent(name), configurable: true, enumerable: true });
  }
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
    webRequest,
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
  return { chrome: sandbox.chrome, registered, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

test("a ws:// filter registered after boot is still sanitized", (t) => {
  const { chrome, registered, dispose } = runShim();
  t.after(dispose);
  chrome.webRequest.onBeforeRequest.addListener(() => {}, { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] });
  assert.deepEqual(JSON.parse(JSON.stringify(registered)), [{ name: "onBeforeRequest", urls: ["http://*/*", "https://*/*"] }]);
});

test("every read of the event returns the one the shim patched", (t) => {
  const { chrome, dispose } = runShim();
  t.after(dispose);
  assert.equal(chrome.webRequest.onCompleted, chrome.webRequest.onCompleted);
});
