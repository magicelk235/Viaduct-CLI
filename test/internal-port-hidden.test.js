import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// The shim talks to its own background over named runtime.connect ports: the side-panel
// signal (__c2sPanelPort, opened from every action popup too), the action keep-alive
// (__viaduct-keepalive), the debugger keep-alive (__viaduct-cdp-keepalive), the service
// worker bridge (__c2sSwBridge) and the --debug RPC (__viaduct-rpc). Chrome never shows
// an extension those ports, and some extensions treat an unknown port name as a bug:
//
//   static onPortConnection(port) {
//     switch (true) {
//       case port.name.startsWith(Page.Popup): ...
//       case port.name === KEEP_ALIVE_PORT_NAME: ...
//       default: throw new Error(`There is no such pages ${port.name}`);   // AdGuard, verbatim
//     }
//   }
//
// So the extension's onConnect listeners must never be called with one of them, while the
// shim's own listeners keep receiving them.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";
const INTERNAL = ["__c2sPanelPort", "__viaduct-keepalive", "__viaduct-cdp-keepalive", "__c2sSwBridge", "__viaduct-rpc"];

function fakeEvent() {
  const fns = [];
  return {
    addListener(fn) { fns.push(fn); },
    removeListener(fn) { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
    hasListener(fn) { return fns.includes(fn); },
    size() { return fns.length; },
  };
}

function fakePort(name, sender) {
  return { name, sender, onMessage: fakeEvent(), onDisconnect: fakeEvent(), postMessage() {}, disconnect() {} };
}

function runShim(href) {
  const timers = new Set();
  const url = new URL(href);
  const nativeConnectListeners = [];
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  // WebKit hands out event wrappers it holds weakly: the shim can patch the instance it
  // read at boot, and a later read of runtime.onConnect can still return a FRESH wrapper
  // without that patch. Fresh wrappers inherit from one shared event prototype, which is
  // also where addListener lives, so model exactly that.
  const eventProto = {
    addListener(fn) { nativeConnectListeners.push(fn); },
    removeListener(fn) { const i = nativeConnectListeners.indexOf(fn); if (i >= 0) nativeConnectListeners.splice(i, 1); },
    hasListener(fn) { return nativeConnectListeners.includes(fn); },
  };
  let onConnect = Object.create(eventProto);
  const runtime = {
    id: "com.viaduct.Test.Extension",
    lastError: null,
    getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
    getManifest: () => ({ manifest_version: 3, action: { default_popup: "pages/popup.html" } }),
    sendMessage: () => Promise.resolve(),
    onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
    connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
  };
  Object.defineProperty(runtime, "onConnect", { get: () => onConnect, enumerable: true, configurable: true });
  const churn = () => { onConnect = Object.create(eventProto); };
  const chrome = {
    runtime,
    storage: {
      local: area, sync: area, session: area,
      onChanged: { addListener() {}, removeListener() {} },
    },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    navigator: { userAgent: "test" },
    history: { state: null, pushState() {}, replaceState() {} },
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
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });

  // Like Safari: one listener throwing doesn't stop the rest, and the throw surfaces as
  // an uncaught error, which is what the user sees in the background console.
  const thrown = [];
  const dispatch = (port) => {
    for (const fn of [...nativeConnectListeners]) { try { fn(port); } catch (e) { thrown.push(e); } }
  };
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { chrome, dispatch, thrown, dispose, churn };
}

test("an extension's onConnect listener never sees the shim's internal ports", (t) => {
  const { chrome, dispatch, thrown, dispose } = runShim(ORIGIN + "/background.html");
  t.after(dispose);

  const seen = [];
  chrome.runtime.onConnect.addListener((port) => {
    seen.push(port.name);
    if (!port.name.startsWith("popup")) throw new Error(`There is no such pages ${port.name}`);
  });

  for (const name of INTERNAL) dispatch(fakePort(name, { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  dispatch(fakePort("popup_1", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));

  assert.deepEqual(seen, ["popup_1"], "only the extension's own port reaches its listener");
  assert.deepEqual(thrown.map((e) => e.message), [], "nothing throws in the background");
});

test("the shim's own panel listener still receives its port", (t) => {
  const { dispatch, dispose } = runShim(ORIGIN + "/background.html");
  t.after(dispose);

  const port = fakePort("__c2sPanelPort", { url: ORIGIN + "/pages/popup.html", frameId: 0 });
  dispatch(port);
  assert.ok(port.onMessage.size() > 0, "the panel listener subscribed to the port's messages");
});

test("hiding internal ports keeps hasListener/removeListener on the caller's reference", (t) => {
  const { chrome, dispatch, dispose } = runShim(ORIGIN + "/background.html");
  t.after(dispose);

  const seen = [];
  const fn = (port) => { seen.push(port.name); };
  chrome.runtime.onConnect.addListener(fn);
  assert.ok(chrome.runtime.onConnect.hasListener(fn));
  dispatch(fakePort("__c2sPanelPort", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  chrome.runtime.onConnect.removeListener(fn);
  assert.equal(chrome.runtime.onConnect.hasListener(fn), false, "removeListener still takes the original reference");
  dispatch(fakePort("popup_2", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  assert.deepEqual(seen, []);
});

test("a listener added after WebKit swapped the onConnect wrapper is still shielded", (t) => {
  const { chrome, dispatch, thrown, dispose, churn } = runShim(ORIGIN + "/background.html");
  t.after(dispose);

  // AdGuard registers its onConnect handler during async init, long after boot.
  churn();
  const seen = [];
  const fn = (port) => {
    seen.push(port.name);
    if (!port.name.startsWith("popup")) throw new Error(`There is no such pages ${port.name}`);
  };
  chrome.runtime.onConnect.addListener(fn);
  dispatch(fakePort("__c2sPanelPort", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  dispatch(fakePort("popup_3", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  assert.deepEqual(seen, ["popup_3"]);
  assert.deepEqual(thrown.map((e) => e.message), []);

  churn();
  assert.ok(chrome.runtime.onConnect.hasListener(fn), "hasListener answers for the caller's reference");
  chrome.runtime.onConnect.removeListener(fn);
  assert.equal(chrome.runtime.onConnect.hasListener(fn), false);
  dispatch(fakePort("popup_4", { url: ORIGIN + "/pages/popup.html", frameId: 0 }));
  assert.deepEqual(seen, ["popup_3"], "removed through a fresh wrapper too");
});
