import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari's native chrome.permissions validates every permission NAME against the ones it
// implements, and throws for the rest:
//
//   Invalid call to permissions.contains(). The 'permissions' value is invalid, because
//   'privacy' is not a valid permission.
//
// Chrome answers `false` for an optional permission the user hasn't granted, and viaduct
// strips Safari-unsupported names like `privacy` from the manifest, so the extension can
// never hold it. AdGuard asks at startup and its whole engine start died on the throw:
//
//   static REQUIRED_PERMISSIONS = ['privacy'];
//   const isPermissionGranted = await chrome.permissions.contains({ permissions });
//
// The shim keeps the native call and only answers a Safari-rejected name itself, the way
// its manifest-based backfill does: declared means granted, anything else is false.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";
const SAFARI_KNOWN = new Set(["tabs", "storage", "cookies", "scripting", "declarativeNetRequest"]);

function runShim(manifest) {
  const timers = new Set();
  const nativeCalls = [];
  const validate = (fn, p) => {
    for (const name of (p && p.permissions) || []) {
      if (!SAFARI_KNOWN.has(name)) {
        throw new Error(`Invalid call to permissions.${fn}(). The 'permissions' value is invalid, because '${name}' is not a valid permission.`);
      }
    }
  };
  const nativeMethod = (fn, answer) => function (p, cb) {
    if (p === undefined) throw new TypeError(`Invalid call to permissions.${fn}(). A required argument is missing.`);
    validate(fn, p);
    nativeCalls.push([fn, p]);
    if (typeof cb === "function") { cb(answer); return; }
    return Promise.resolve(answer);
  };
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => manifest,
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    permissions: {
      contains: nativeMethod("contains", true),
      request: nativeMethod("request", true),
      remove: nativeMethod("remove", true),
      getAll: (cb) => { const v = { permissions: [], origins: [] }; if (cb) { cb(v); return; } return Promise.resolve(v); },
      onAdded: { addListener() {} }, onRemoved: { addListener() {} },
    },
    storage: { local: area, sync: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const href = ORIGIN + "/background.html";
  const url = new URL(href);
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
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { chrome: sandbox.chrome, nativeCalls, dispose };
}

const MANIFEST = { manifest_version: 3, permissions: ["tabs", "storage"] };

test("contains() on a permission Safari rejects resolves false instead of throwing", async (t) => {
  const { chrome, dispose } = runShim(MANIFEST);
  t.after(dispose);

  let result;
  assert.doesNotThrow(() => { result = chrome.permissions.contains({ permissions: ["privacy"] }); });
  assert.equal(await result, false);
});

test("the callback form gets false too", async (t) => {
  const { chrome, dispose } = runShim(MANIFEST);
  t.after(dispose);

  const got = await new Promise((resolve) => chrome.permissions.contains({ permissions: ["privacy"] }, resolve));
  assert.equal(got, false);
});

test("a name Safari rejects but the manifest declares still counts as granted", async (t) => {
  const { chrome, dispose } = runShim({ manifest_version: 3, permissions: ["tabs", "sidePanel"] });
  t.after(dispose);

  assert.equal(await chrome.permissions.contains({ permissions: ["sidePanel"] }), true);
});

test("names Safari knows still go to the native call", async (t) => {
  const { chrome, nativeCalls, dispose } = runShim(MANIFEST);
  t.after(dispose);

  assert.equal(await chrome.permissions.contains({ permissions: ["tabs"] }), true);
  assert.deepEqual(nativeCalls.map((c) => c[0]), ["contains"]);
});

test("request() and remove() on a rejected name resolve false", async (t) => {
  const { chrome, dispose } = runShim(MANIFEST);
  t.after(dispose);

  assert.equal(await chrome.permissions.request({ permissions: ["privacy"] }), false);
  assert.equal(await chrome.permissions.remove({ permissions: ["privacy"] }), false);
});

test("any other native error still surfaces", (t) => {
  const { chrome, dispose } = runShim(MANIFEST);
  t.after(dispose);

  assert.throws(() => chrome.permissions.contains(), /required argument/);
});
