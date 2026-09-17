import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Regression: MetaMask 13.x on Safari 26. Safari REJECTS a null-prototype object as the
// items argument: "Invalid call to storageArea.set(). The 'items' value is invalid,
// because an object is expected." Chrome accepts one. MetaMask's state store builds its
// payload with Object.create(null), so every persist threw, its background never
// finished initializing, and the popup showed "MetaMask had trouble starting —
// Background initialization timeout". Measured live: the same 168 KB payload copied into
// a plain object was accepted, and so was each key written on its own, so the prototype
// of the receiving object is the whole problem — not its contents.
//
// The shim copies the top level into a plain object. It must stay a SHALLOW copy (the
// nested values are Safari-legal, proven by the single-key retries) so a megabyte of
// state isn't cloned on every write, and it must leave a normal object alone — identity
// included, since a caller may compare what it passed.
//
// The payloads are built INSIDE the sandbox on purpose: an object handed across the vm
// boundary is not what a converted extension ever does, and it does not behave the same.

function makeContext() {
  const seen = [];
  const area = (name) => ({
    set(items, cb) { seen.push({ area: name, op: "set", items, proto: Object.getPrototypeOf(items ?? {}) }); if (cb) cb(); },
    get(keys, cb) { seen.push({ area: name, op: "get", keys }); if (cb) cb({}); },
    remove() {},
    clear() {},
  });
  const chrome = {
    runtime: {
      id: "test-ext",
      getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      sendMessage() {},
    },
    storage: { local: area("local"), sync: area("sync"), session: area("session"), onChanged: { addListener() {} } },
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
  return { sandbox, seen, run: (code) => vm.runInContext(code, sandbox) };
}

test("a null-prototype items object reaches Safari as a plain object", () => {
  const { seen, run } = makeContext();
  run(`var s = Object.create(null);
       s.meta = { version: 141 };
       s.AccountsController = { accounts: {} };
       globalThis.__nested = s.meta;
       chrome.storage.local.set(s);`);
  // The shim writes its own session mirror through the same area, so pick out ours.
  const call = seen.find((c) => c.area === "local" && c.op === "set" && c.items && "meta" in c.items);
  assert.ok(call, "the set must still reach the native area");
  assert.notEqual(call.proto, null, "Safari rejects a prototype-less dictionary outright");
  assert.deepEqual(Object.keys(call.items), ["meta", "AccountsController"]);
  assert.equal(call.items.meta, run("globalThis.__nested"),
    "shallow: the values are passed through, not cloned");
});

test("a normal items object is passed through untouched", () => {
  const { seen, run } = makeContext();
  run("globalThis.__items = { data: { a: 1 } }; chrome.storage.local.set(globalThis.__items);");
  const call = seen.find((c) => c.area === "local" && c.op === "set" && c.items === run("globalThis.__items"));
  assert.ok(call, "no copy for an object Safari already accepts — identity must survive");
});

test("the same rule covers get's defaults object and leaves key lists alone", () => {
  const { seen, run } = makeContext();
  run(`var d = Object.create(null); d.vault = null;
       chrome.storage.local.get(d);
       chrome.storage.local.get(["a","b"]);
       chrome.storage.local.get("single");
       chrome.storage.local.get(null);`);
  const gets = seen.filter((c) => c.op === "get" && c.area === "local");
  const pick = (pred) => gets.filter(pred);
  const defaulted = pick((c) => c.keys && typeof c.keys === "object" && !Array.isArray(c.keys) && "vault" in c.keys)[0];
  assert.ok(defaulted, "the defaults object must still reach the area");
  assert.notEqual(Object.getPrototypeOf(defaulted.keys), null, "get takes the same validator as set");
  assert.ok(pick((c) => Array.isArray(c.keys) && c.keys.join() === "a,b").length === 1,
    "an array already has a prototype Safari accepts, so it passes through as-is");
  assert.ok(pick((c) => c.keys === null).length >= 1, "null means everything; it must not become {}");
});

test("sync and session areas get the same treatment", () => {
  const { seen, run } = makeContext();
  run(`for (var _n of ["sync","session"]) { var o = Object.create(null); o.k = 1; chrome.storage[_n].set(o); }`);
  for (const name of ["sync", "session"]) {
    const call = seen.find((c) => c.area === name && c.op === "set" && c.items && "k" in c.items);
    assert.ok(call, `${name}.set must still reach the area`);
    assert.notEqual(call.proto, null, `${name} takes the same validator`);
  }
});
