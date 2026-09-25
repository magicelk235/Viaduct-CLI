import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: Claude in Chrome 1.0.94 opened two sign-in tabs after a conversion.
// Safari fires runtime.onInstalled {reason:"install"} on EVERY mid-session reload of an
// unchanged extension (WebKit's determineInstallReasonDuringLoad: not at browser launch,
// no version or bundle-hash change → ExtensionInstall). Reinstalling the host app and
// then opening it reloads the extension twice, and Claude's listener runs
// `reason === INSTALL && signIn()` both times. Measured live in Safari Technology
// Preview: re-opening the installed host app alone added a second oauth/authorize tab
// with a fresh `state`.
//
// The background records the installed version at boot. An "install" that arrives with
// a version already recorded is what Chrome reports as "update" for a reload, so the
// bundle gets that, previousVersion included.

const tick = () => new Promise((r) => setTimeout(r, 0));

function makeContext({ page = "background.html", stored = {} } = {}) {
  const store = { ...stored };
  const listeners = [];
  const onInstalled = {
    addListener(fn) { if (!listeners.includes(fn)) listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.includes(fn); },
  };
  const chrome = {
    runtime: {
      id: "test-ext",
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3, version: "1.0.94" }),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onInstalled,
      sendMessage() {},
    },
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
    location: { href: "safari-web-extension://TEST/" + page, origin: "safari-web-extension://TEST", protocol: "safari-web-extension:", pathname: "/" + page },
    navigator: { userAgent: "test" },
    chrome,
    URL,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  // Safari dispatches a fresh details object to every registered listener.
  const fire = (details) => { for (const fn of listeners.slice()) fn(JSON.parse(JSON.stringify(details))); };
  const run = (code) => vm.runInContext(code, sandbox);
  // What the bundle's listener saw, copied out of the vm realm.
  const seen = () => JSON.parse(run("JSON.stringify(globalThis.__seen)"));
  run(`globalThis.__seen = []; globalThis.__fn = function (d) { __seen.push(d); };
       chrome.runtime.onInstalled.addListener(__fn);`);
  return { store, fire, run, seen, listeners };
}

test("a first install reaches the bundle as install and records the version", async () => {
  const { store, fire, seen } = makeContext();
  fire({ reason: "install" });
  await tick(); await tick();
  assert.deepEqual(seen(), [{ reason: "install" }]);
  assert.equal(store.__c2sInstalledVersion, "1.0.94");
});

test("Safari's install on a reload of an installed extension reaches the bundle as update", async () => {
  const { fire, seen } = makeContext({ stored: { __c2sInstalledVersion: "1.0.94" } });
  fire({ reason: "install" });
  await tick(); await tick();
  assert.deepEqual(seen(), [{ reason: "update", previousVersion: "1.0.94" }]);
});

test("every listener sees the same reason for one dispatch", async () => {
  const { fire, run, seen } = makeContext({ stored: { __c2sInstalledVersion: "1.0.91" } });
  run(`chrome.runtime.onInstalled.addListener(function (d) { __seen.push(d); });`);
  fire({ reason: "install" });
  await tick(); await tick();
  assert.deepEqual(seen(), [
    { reason: "update", previousVersion: "1.0.91" },
    { reason: "update", previousVersion: "1.0.91" },
  ]);
});

test("a real update passes through as Safari sent it and moves the record forward", async () => {
  const { store, fire, seen } = makeContext({ stored: { __c2sInstalledVersion: "1.0.91" } });
  fire({ reason: "update", previousVersion: "1.0.91" });
  await tick(); await tick();
  assert.deepEqual(seen(), [{ reason: "update", previousVersion: "1.0.91" }]);
  assert.equal(store.__c2sInstalledVersion, "1.0.94");
});

test("removeListener and hasListener take the bundle's own function", async () => {
  const { fire, run, seen, listeners } = makeContext({ stored: { __c2sInstalledVersion: "1.0.94" } });
  assert.equal(run("chrome.runtime.onInstalled.hasListener(__fn)"), true);
  run("chrome.runtime.onInstalled.removeListener(__fn)");
  assert.equal(run("chrome.runtime.onInstalled.hasListener(__fn)"), false);
  assert.equal(listeners.length, 0);
  fire({ reason: "install" });
  await tick(); await tick();
  assert.deepEqual(seen(), []);
});

test("an extension page other than the background is left alone", async () => {
  const { store, fire, seen } = makeContext({ page: "sidepanel.html", stored: { __c2sInstalledVersion: "1.0.94" } });
  fire({ reason: "install" });
  await tick(); await tick();
  assert.deepEqual(seen(), [{ reason: "install" }]);
  assert.equal(store.__c2sInstalledVersion, "1.0.94");
});
