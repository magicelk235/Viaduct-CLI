import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// A pinned tab in Safari belongs to every window. Measured with one pinned tab (id 260,
// home window 258) and five windows: tabs.query({}) returns it five times, a query for
// window 181 includes it with windowId 258, and windows.getAll({populate:true}) lists it
// under every window. Tab Session Manager saved all five copies and would restore the
// pinned tab once per window. Chrome reports each tab once, in one window.

const PINNED = { id: 260, windowId: 258, index: 0, pinned: true, url: "https://pinned.example/" };
const tab = (id, windowId, index) => ({ id, windowId, index, pinned: false, url: `https://example.com/${id}` });
const WINDOWS = { 181: [tab(183, 181, 1), tab(192, 181, 2)], 258: [tab(269, 258, 1)], 335: [tab(337, 335, 1)] };
const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot() {
  const safariQuery = (q) => {
    const ids = q.windowId != null ? [q.windowId] : q.currentWindow ? [181] : Object.keys(WINDOWS).map(Number);
    let out = ids.flatMap((w) => [PINNED, ...WINDOWS[w]]);
    if (q.pinned) out = out.filter((t) => t.pinned);
    return out.map((t) => ({ ...t }));
  };
  const win = (id) => ({ id, focused: id === 181, tabs: [{ ...PINNED }, ...WINDOWS[id].map((t) => ({ ...t }))] });
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    location: { href: "safari-web-extension://T/background.html", protocol: "safari-web-extension:", pathname: "/background.html", origin: "safari-web-extension://t" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: { id: "x", getURL: (p) => "safari-web-extension://T/" + p, onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {} },
      tabs: { query: (q, cb) => { const r = safariQuery(q || {}); if (cb) { cb(r); return; } return Promise.resolve(r); } },
      windows: {
        get: (id, opts) => Promise.resolve(win(id)),
        getAll: () => Promise.resolve(Object.keys(WINDOWS).map((w) => win(+w))),
        getCurrent: (opts, cb) => { const w = win(181); if (typeof opts === "function") opts(w); else if (cb) cb(w); else return Promise.resolve(w); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox.chrome;
}

// Arrays built inside the vm realm fail deepStrictEqual on prototype; copy them out.
const ids = (tabs) => Array.from(tabs, (t) => t.id);

test("tabs.query({}) lists a pinned tab once", async () => {
  const chrome = boot();
  assert.deepEqual(ids(await chrome.tabs.query({})), [260, 183, 192, 269, 337]);
  assert.deepEqual(ids(await chrome.tabs.query({ pinned: true })), [260]);
});

test("a query for one window leaves out another window's pinned tab", async () => {
  const chrome = boot();
  assert.deepEqual(ids(await chrome.tabs.query({ windowId: 181 })), [183, 192]);
  assert.deepEqual(ids(await chrome.tabs.query({ windowId: 258 })), [260, 269], "its home window keeps it");
  assert.deepEqual(ids(await chrome.tabs.query({ currentWindow: true })), [183, 192]);
  const viaCallback = await new Promise((r) => chrome.tabs.query({ windowId: 181 }, r));
  assert.deepEqual(ids(viaCallback), [183, 192]);
});

test("populated windows list a pinned tab only under its own window", async () => {
  const chrome = boot();
  const all = await chrome.windows.getAll({ populate: true });
  assert.deepEqual(all.map((w) => [w.id, ids(w.tabs)]), [[181, [183, 192]], [258, [260, 269]], [335, [337]]]);
  assert.deepEqual(ids((await chrome.windows.get(181, { populate: true })).tabs), [183, 192]);
  const current = await new Promise((r) => chrome.windows.getCurrent({ populate: true }, r));
  assert.deepEqual(ids(current.tabs), [183, 192]);
});
