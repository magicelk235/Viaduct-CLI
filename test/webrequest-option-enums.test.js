import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome exposes option enums on chrome.webRequest and extensions read them at startup:
//   if (utils.hasOwn(chrome.webRequest.OnBeforeSendHeadersOptions, 'EXTRA_HEADERS'))
// (Privacy Badger's heuristic blocking). Safari has none of them, so that read threw,
// startListeners never finished, the global `badger` was never created and nothing was
// blocked. The enums must exist, and EXTRA_HEADERS must stay absent: Safari has no
// extraHeaders mode, and its absence is what that check is asking about.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

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
    // Safari's webRequest: the events, none of Chrome's enums.
    webRequest: {
      onBeforeRequest: ev(), onBeforeSendHeaders: ev(), onSendHeaders: ev(), onHeadersReceived: ev(),
      onAuthRequired: ev(), onResponseStarted: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev(),
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
  return { chrome: sandbox.chrome, dispose: () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } } };
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test("Privacy Badger's EXTRA_HEADERS probe gets an answer instead of a TypeError", (t) => {
  const { chrome, dispose } = runShim();
  t.after(dispose);
  const wr = chrome.webRequest;
  assert.equal(hasOwn(wr.OnBeforeSendHeadersOptions, "EXTRA_HEADERS"), false);
  assert.equal(hasOwn(wr.OnHeadersReceivedOptions, "EXTRA_HEADERS"), false);
  assert.equal(wr.OnBeforeSendHeadersOptions.REQUEST_HEADERS, "requestHeaders");
  assert.equal(wr.OnHeadersReceivedOptions.RESPONSE_HEADERS, "responseHeaders");
  assert.equal(wr.ResourceType.SUB_FRAME, "sub_frame");
});
