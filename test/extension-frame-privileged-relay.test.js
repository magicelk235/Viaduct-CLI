import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// A content script that iframes one of the extension's pages into a site (Vimium's HUD and
// Vomnibar) puts that page in the site's WebContent process. Safari exposes tabs, windows,
// scripting, … to it, but the UI process validates each call against the extension's
// privileged process and kills the frame's process on a mismatch, which takes the whole
// tab down: "Received an invalid message WebExtensionContext_TabsQuery from WebContent
// process". The shim's own tab-group prune ran a tabs.query({}) at boot in every extension
// page, so merely showing Vimium's HUD killed the page.
//
// In such a frame every privileged call has to reach the background instead, and the
// background answers it only for the extension's own documents.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";

function runShim(href, { framed }) {
  const timers = new Set();
  const url = new URL(href);
  const nativeCalls = [];
  const sent = [];
  const onMessageListeners = [];
  const native = (name, result) => (...args) => { nativeCalls.push(name); return Promise.resolve(result(...args)); };
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  let answer = () => undefined;
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => ({ manifest_version: 3 }),
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(answer(msg)); },
      onMessage: { addListener(fn) { onMessageListeners.push(fn); }, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    // No storage.onChanged: keeps the storage relay out, so sendMessage stays observable.
    storage: { local: area, session: area },
    tabs: {
      query: native("tabs.query", () => [{ id: 7, windowId: 3, active: true }]),
      get: native("tabs.get", (id) => ({ id })),
      sendMessage: native("tabs.sendMessage", () => undefined),
      connect: () => { nativeCalls.push("tabs.connect"); return {}; },
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, onActivated: { addListener() {} },
    },
    windows: {
      get: native("windows.get", (id) => ({ id, focused: true })),
      getCurrent: native("windows.getCurrent", () => ({ id: 3 })),
      onFocusChanged: { addListener() {} },
    },
    webNavigation: { getAllFrames: native("webNavigation.getAllFrames", () => []) },
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
  // A cross-origin parent: reading its location throws, as it does for a site.
  sandbox.top = framed ? { get location() { throw new Error("SecurityError: Blocked a frame"); } } : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { chrome: sandbox.chrome, nativeCalls, sent, onMessageListeners, dispose, setAnswer: (fn) => { answer = fn; } };
}

const settle = () => new Promise((r) => setTimeout(r, 2200));

test("an extension frame inside a web page never calls a privileged API natively", async (t) => {
  const ctx = runShim(ORIGIN + "/pages/hud_page.html", { framed: true });
  t.after(ctx.dispose);
  ctx.setAnswer((msg) => (msg && msg.__c2sFrameApi ? { v: [{ id: 7 }] } : undefined));

  const tabs = await ctx.chrome.tabs.query({ active: true });
  const win = await ctx.chrome.windows.getCurrent();
  await ctx.chrome.webNavigation.getAllFrames({ tabId: 7 });
  await settle(); // the shim's own boot-time work (the tab-group prune) has run by now

  assert.deepEqual(ctx.nativeCalls, [], "no native privileged call left the frame");
  assert.deepEqual(tabs.map((x) => x.id), [7], "the background's answer is what the caller gets");
  assert.ok(win, "windows.getCurrent resolved through the background");
  const relayed = ctx.sent.filter((m) => m && m.__c2sFrameApi).map((m) => m.__c2sFrameApi.ns + "." + m.__c2sFrameApi.m);
  assert.ok(relayed.includes("tabs.query") && relayed.includes("windows.getCurrent") && relayed.includes("webNavigation.getAllFrames"));
});

test("a relayed call keeps Chrome's callback form and lastError", async (t) => {
  const ctx = runShim(ORIGIN + "/pages/hud_page.html", { framed: true });
  t.after(ctx.dispose);
  ctx.setAnswer((msg) => (msg && msg.__c2sFrameApi ? { err: "No tab with id: 9" } : undefined));

  const got = await new Promise((resolve) => {
    ctx.chrome.webNavigation.getAllFrames({ tabId: 9 }, (frames) => resolve({ frames, err: ctx.chrome.runtime.lastError && ctx.chrome.runtime.lastError.message }));
  });
  assert.deepEqual(got, { frames: undefined, err: "No tab with id: 9" });
});

test("a port cannot cross the relay, so tabs.connect fails alone instead of killing the tab", (t) => {
  const ctx = runShim(ORIGIN + "/pages/hud_page.html", { framed: true });
  t.after(ctx.dispose);
  assert.throws(() => ctx.chrome.tabs.connect(7), /unavailable in an extension frame/);
  assert.ok(!ctx.nativeCalls.includes("tabs.connect"));
});

test("a top-level extension page keeps the native APIs", async (t) => {
  const ctx = runShim(ORIGIN + "/pages/options.html", { framed: false });
  t.after(ctx.dispose);
  await ctx.chrome.tabs.query({});
  assert.ok(ctx.nativeCalls.includes("tabs.query"));
  assert.ok(!ctx.sent.some((m) => m && m.__c2sFrameApi));
});

test("the background answers the extension's own frames and nobody else", async (t) => {
  const ctx = runShim(ORIGIN + "/background.html", { framed: false });
  t.after(ctx.dispose);
  const ask = async (sender, req) => {
    for (const fn of ctx.onMessageListeners) {
      const r = fn({ __c2sFrameApi: req }, sender, () => {});
      if (r && typeof r.then === "function") return await r;
    }
    return undefined;
  };
  const frame = { id: "com.viaduct.Test.Extension", url: ORIGIN.toUpperCase().replace("SAFARI-WEB-EXTENSION", "safari-web-extension") + "/pages/hud_page.html" };
  const listed = await ask(frame, { ns: "tabs", m: "query", args: [{}] });
  assert.deepEqual(listed.v.map((x) => x.id), [7]);
  const current = await ask({ ...frame, tab: { id: 7, windowId: 3 } }, { ns: "windows", m: "getCurrent", args: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(current)), { v: { id: 3, focused: true } });

  const before = ctx.nativeCalls.length;
  const page = { id: "com.viaduct.Test.Extension", url: "https://example.com/", tab: { id: 7 } };
  assert.equal(await ask(page, { ns: "tabs", m: "query", args: [{}] }), undefined, "a content script gets no answer");
  assert.equal(await ask(frame, { ns: "runtime", m: "reload", args: [] }), undefined, "only the privileged namespaces relay");
  assert.equal(ctx.nativeCalls.length, before);
});
