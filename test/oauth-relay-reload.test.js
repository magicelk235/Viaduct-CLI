import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR } from "../dist/paths.js";

// Safari reloads a converted extension where Chrome never would: the host app launching,
// the app being replaced on reinstall. Content scripts already running in open tabs stay
// bound to the context that died and are never injected again, so the page bridge in
// those tabs relays into nothing. A fresh install's sign-in tab, opened by the first load
// and still open when the next load replaced it, answered the Authorize click with
// claude.ai's "Authorization failed". The background now remembers the bridge-origin
// tabs it opens and, on the next load, reloads the recent ones whose relay stopped
// answering.
const read = (f) => readFileSync(join(TEMPLATE_DIR, f), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** A background load over a shared tab table and storage.local. */
function load({ tabs, storage }) {
  const reloaded = [];
  let nextId = 100;
  const bg = {
    console: { log() {}, warn() {}, error() {} },
    URL, Promise, setTimeout, clearTimeout, Date,
    location: { href: "safari-web-extension://ABC/background.html", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "com.viaduct.Test.Extension",
        getURL: (p) => "safari-web-extension://ABC/" + String(p ?? "").replace(/^\//, ""),
        getManifest: () => ({
          content_scripts: [
            { js: ["page-bridge.js"], matches: ["https://claude.ai/*"], world: "MAIN" },
            { js: ["page-bridge-cs.js"], matches: ["https://claude.ai/*"] },
          ],
        }),
        onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
        onMessageExternal: { addListener() {}, removeListener() {}, hasListener: () => false },
        lastError: undefined,
      },
      storage: {
        local: {
          get: (k) => Promise.resolve(k in storage ? { [k]: JSON.parse(JSON.stringify(storage[k])) } : {}),
          set: (o) => { Object.assign(storage, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
        },
      },
      tabs: {
        create: (props) => {
          const tab = { id: nextId++, url: props.url, relayAlive: true };
          tabs.push(tab);
          return Promise.resolve({ id: tab.id, url: tab.url });
        },
        query: () => Promise.resolve(tabs.map((t) => ({ id: t.id, url: t.url }))),
        get: (id) => {
          const t = tabs.find((x) => x.id === id);
          return t ? Promise.resolve({ id: t.id, url: t.url }) : Promise.reject(new Error("No tab with id"));
        },
        reload: (id) => { reloaded.push(id); return Promise.resolve(); },
        // Safari rejects a message no listener in the running context receives.
        sendMessage: (id, msg) => {
          const t = tabs.find((x) => x.id === id);
          if (msg && msg.__bridgeRelayPing === true && t && t.relayAlive) return Promise.resolve(true);
          return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
        },
      },
    },
  };
  bg.self = bg; bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("identity-polyfill.js"), bg);
  return { chrome: bg.chrome, reloaded };
}

test("the next load reloads the sign-in tab the previous load opened, once its relay is dead", async () => {
  const tabs = [{ id: 1, url: "https://claude.ai/new", relayAlive: false }];
  const storage = {};

  // First load: the bundle opens its sign-in tab, and the Chrome-style extras still work.
  const first = load({ tabs, storage });
  const created = await first.chrome.tabs.create({ url: "https://claude.ai/oauth/authorize?state=a" });
  await first.chrome.tabs.create({ url: "https://example.com/" });
  await tick(20);
  assert.equal(created.url, "https://claude.ai/oauth/authorize?state=a");
  assert.equal(first.reloaded.length, 0);

  // Safari replaces the context: every content script it injected is now dead, and tab
  // ids are the new context's own (the old id no longer resolves).
  for (const t of tabs) { t.relayAlive = false; t.id += 1000; }
  const second = load({ tabs, storage });
  await tick(50);
  // Only the tab the extension opened on a bridge origin. The user's own claude.ai tab
  // and the non-bridge tab are left alone.
  assert.deepEqual(second.reloaded, [created.id + 1000]);
});

test("a sign-in tab whose relay still answers, or that is not recent, is not reloaded", async () => {
  const tabs = [
    { id: 7, url: "https://claude.ai/oauth/authorize?state=b", relayAlive: true },
    { id: 8, url: "https://claude.ai/oauth/authorize?state=c", relayAlive: false },
  ];
  const storage = { __c2sBridgeTabs: [{ url: tabs[0].url, t: Date.now() }, { url: tabs[1].url, t: Date.now() - 5 * 60 * 1000 }] };
  const { reloaded } = load({ tabs, storage });
  await tick(50);
  assert.deepEqual(reloaded, []);
});

test("a sign-in tab that redirected is still found by the next load", async () => {
  const tabs = [];
  const storage = {};
  const first = load({ tabs, storage });
  await first.chrome.tabs.create({ url: "https://claude.ai/oauth/authorize?state=d" });
  // The provider sends the tab on to its login page while the first load is alive.
  tabs[0].url = "https://claude.ai/login?returnTo=%2Foauth%2Fauthorize%3Fstate%3Dd";
  await tick(1200);
  for (const t of tabs) { t.relayAlive = false; t.id += 1000; }
  const second = load({ tabs, storage });
  await tick(50);
  assert.deepEqual(second.reloaded, [tabs[0].id]);
});

test("a tab whose relay never answers is reloaded at most twice", async () => {
  const url = "https://claude.ai/oauth/authorize?state=e";
  const tabs = [{ id: 9, url, relayAlive: false }];
  const storage = { __c2sBridgeTabs: [{ url, t: Date.now(), n: 1 }] };
  const second = load({ tabs, storage });
  await tick(50);
  assert.deepEqual(second.reloaded, [9]);
  assert.equal(storage.__c2sBridgeTabs[0].n, 2);
  const third = load({ tabs, storage });
  await tick(50);
  assert.deepEqual(third.reloaded, [], "site access on Ask: no content script will ever answer");
});

test("the relay answers the background's liveness ping", async () => {
  const listeners = [];
  const win = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, Date, Math, JSON,
    location: { origin: "https://claude.ai", href: "https://claude.ai/oauth/authorize" },
    addEventListener() {}, postMessage() {},
  };
  win.window = win; win.self = win; win.globalThis = win;
  vm.createContext(win);
  const api = {
    runtime: {
      id: "x",
      sendMessage: () => new Promise(() => {}),
      onMessage: { addListener: (f) => listeners.push(f) },
    },
  };
  vm.runInContext("(function(chrome, browser){" + read("page-bridge-cs.js") + "})", win)(api, undefined);
  assert.equal(listeners.length, 1);
  assert.equal(await listeners[0]({ __bridgeRelayPing: true }, {}, () => {}), true);
  assert.equal(listeners[0]({ type: "other" }, {}, () => {}), undefined, "other messages pass through");
});
