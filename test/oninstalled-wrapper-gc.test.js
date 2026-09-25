import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import v8 from "node:v8";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: Claude in Chrome kept opening a sign-in tab on every reload even with the
// installed version recorded. WebKit caches an extension event's JS wrapper weakly, and
// the shim's onInstalled correction lives on that wrapper as own-property overrides. The
// array that was meant to pin it was reachable only from closures the wrapper itself
// held, so once the version read settled the whole cycle was garbage. Parsing the
// bundle's module chunks collected it, and the bundle's own
// chrome.runtime.onInstalled.addListener got a fresh wrapper with the native method, so
// the raw "install" reached it. Measured live in Safari Technology Preview: before, two
// sign-in tabs per host-app relaunch; after, none across eight reloads.

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 0)); gc(); } };

function makeContext() {
  const store = { __c2sInstalledVersion: "1.0.94" };
  const listeners = [];
  // WebKit's wrapper cache: the same wrapper while something holds it, a fresh one after.
  let cached = null;
  const onInstalledWrapper = () => {
    const alive = cached && cached.deref();
    if (alive) return alive;
    const w = {
      addListener(fn) { if (!listeners.includes(fn)) listeners.push(fn); },
      removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      hasListener(fn) { return listeners.includes(fn); },
    };
    cached = new WeakRef(w);
    return w;
  };
  const runtime = {
    id: "test-ext",
    getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
    getManifest: () => ({ manifest_version: 3, version: "1.0.94" }),
    onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    sendMessage() {},
  };
  Object.defineProperty(runtime, "onInstalled", { get: onInstalledWrapper, enumerable: true, configurable: true });
  const chrome = {
    runtime,
    storage: {
      local: {
        get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        },
        set(items) { Object.assign(store, items); return Promise.resolve(); },
        remove() { return Promise.resolve(); },
        clear() { return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
  const sandbox = {
    console,
    setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t.unref?.(); return t; },
    setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); t.unref?.(); return t; },
    clearTimeout, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", protocol: "safari-web-extension:", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome,
    URL,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const fire = (details) => { for (const fn of listeners.slice()) fn(JSON.parse(JSON.stringify(details))); };
  return { run, fire };
}

test("the onInstalled correction survives a collection before the bundle registers", async () => {
  const { run, fire } = makeContext();
  // The version read settles, then the bundle's module chunks load and a GC runs.
  await settle();
  run(`globalThis.__seen = []; chrome.runtime.onInstalled.addListener(function (d) { __seen.push(d); });`);
  fire({ reason: "install" });
  await settle();
  assert.deepEqual(JSON.parse(run("JSON.stringify(__seen)")), [{ reason: "update", previousVersion: "1.0.94" }]);
});
