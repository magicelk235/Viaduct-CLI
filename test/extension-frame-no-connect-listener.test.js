import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// An extension page iframed into a site by a content script shares the content script's
// process. While that frame holds a runtime.onConnect listener, Safari delivers every
// message a content script posts on a port to the background twice (measured with a probe
// extension: one connect, two onMessage dispatches, two replies; none with the listener
// gone). The shim used to register its own onConnect listeners (the side-panel signal, the
// --debug RPC) in every page, frames included, so Vimium and Surfingkeys, which keep such
// frames open, had each port message handled twice.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

function runShim(href, { framed }) {
  const timers = new Set();
  const url = new URL(href);
  const native = [];
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
      onConnect: {
        addListener(fn) { native.push(fn); },
        removeListener(fn) { const i = native.indexOf(fn); if (i >= 0) native.splice(i, 1); },
        hasListener: (fn) => native.includes(fn),
      },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} }),
    },
    storage: { local: area, session: area },
    // tabs without sidePanel: the shim's side-panel emulation registers its port listener.
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    navigator: { userAgent: "test" },
    history: { state: null, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.top = framed ? { get location() { throw new Error("SecurityError: Blocked a frame"); } } : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  return { chrome: sandbox.chrome, native, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

test("the shim leaves no onConnect listener in an extension frame inside a web page", (t) => {
  const { native, dispose } = runShim(ORIGIN + "/pages/hud_page.html", { framed: true });
  t.after(dispose);
  assert.equal(native.length, 0);
});

test("a top-level extension page keeps the shim's onConnect listeners", (t) => {
  const { native, dispose } = runShim(ORIGIN + "/pages/options.html", { framed: false });
  t.after(dispose);
  assert.ok(native.length > 0);
});

test("the frame's own onConnect listener still registers", (t) => {
  const { chrome, native, dispose } = runShim(ORIGIN + "/pages/hud_page.html", { framed: true });
  t.after(dispose);
  chrome.runtime.onConnect.addListener(() => {});
  assert.equal(native.length, 1);
});
