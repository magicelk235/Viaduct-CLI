// Complex emulated APIs: downloads (registry+events), readingList (storage),
// userScripts (registry), instanceID (stable id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/runtime/shim.js";

function makeStore() {
  const data = {};
  return {
    local: {
      get: (key, cb) => {
        const out = {};
        if (typeof key === "string") { if (key in data) out[key] = data[key]; }
        else if (key == null) Object.assign(out, data);
        else Object.keys(key).forEach((k) => { out[k] = k in data ? data[k] : key[k]; });
        Promise.resolve().then(() => cb(out));
      },
      set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); Promise.resolve().then(() => cb && cb()); },
    },
  };
}
function setup(store = makeStore(), extra = {}) {
  const chrome = Object.assign({ runtime: { lastError: null, getManifest: () => ({}) }, storage: store }, extra);
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, { addEventListener() {} }, undefined, { chrome });
  return chrome;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- downloads ----
test("downloads: download records an item, fires onCreated then onChanged->complete", async () => {
  const chrome = setup();
  const created = [], changed = [];
  chrome.downloads.onCreated.addListener((it) => created.push(it));
  chrome.downloads.onChanged.addListener((d) => changed.push(d.state.current));
  const id = await chrome.downloads.download({ url: "https://x.test/file.zip" });
  assert.equal(typeof id, "number");
  assert.equal(created.length, 1);
  assert.equal(created[0].state, "in_progress");
  await tick();
  assert.deepEqual(changed, ["complete"]);
});

test("downloads: search finds the item and filters by state", async () => {
  const chrome = setup();
  await chrome.downloads.download({ url: "https://x.test/a.zip", filename: "a.zip" });
  await tick();
  const all = await chrome.downloads.search({});
  assert.equal(all.length, 1);
  assert.equal(all[0].filename, "a.zip");
  assert.equal((await chrome.downloads.search({ state: "complete" })).length, 1);
  assert.equal((await chrome.downloads.search({ state: "in_progress" })).length, 0);
});

test("downloads: erase removes matching items and fires onErased", async () => {
  const chrome = setup();
  const id = await chrome.downloads.download({ url: "https://x.test/b.zip" });
  await tick();
  const erased = [];
  chrome.downloads.onErased.addListener((eid) => erased.push(eid));
  const out = await chrome.downloads.erase({ id });
  assert.deepEqual(out, [id]);
  assert.deepEqual(erased, [id]);
  assert.equal((await chrome.downloads.search({})).length, 0);
});

// ---- readingList ----
test("readingList: add/query/update/remove with events", async () => {
  const chrome = setup();
  const added = [], removed = [], updated = [];
  chrome.readingList.onEntryAdded.addListener((e) => added.push(e.url));
  chrome.readingList.onEntryRemoved.addListener((e) => removed.push(e.url));
  chrome.readingList.onEntryUpdated.addListener((e) => updated.push(e.hasBeenRead));

  await chrome.readingList.addEntry({ url: "https://r.test/1", title: "One" });
  assert.deepEqual(added, ["https://r.test/1"]);
  assert.equal((await chrome.readingList.query({})).length, 1);

  await chrome.readingList.updateEntry({ url: "https://r.test/1", hasBeenRead: true });
  assert.deepEqual(updated, [true]);
  assert.equal((await chrome.readingList.query({ hasBeenRead: true })).length, 1);

  await chrome.readingList.removeEntry({ url: "https://r.test/1" });
  assert.deepEqual(removed, ["https://r.test/1"]);
  assert.equal((await chrome.readingList.query({})).length, 0);
});

test("readingList: duplicate URL rejects", async () => {
  const chrome = setup();
  await chrome.readingList.addEntry({ url: "https://dup.test", title: "x" });
  await assert.rejects(() => chrome.readingList.addEntry({ url: "https://dup.test", title: "y" }));
});

test("readingList: persists across a fresh shim", async () => {
  const store = makeStore();
  await setup(store).readingList.addEntry({ url: "https://p.test", title: "keep" });
  await tick();
  const got = await setup(store).readingList.query({});
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "keep");
});

// ---- userScripts ----
test("userScripts: register then getScripts round-trips; update + unregister", async () => {
  const chrome = setup();
  await chrome.userScripts.register([{ id: "s1", matches: ["https://*/*"], js: [{ code: "1" }] }]);
  let got = await chrome.userScripts.getScripts();
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "s1");
  await chrome.userScripts.update([{ id: "s1", allFrames: true }]);
  got = await chrome.userScripts.getScripts({ ids: ["s1"] });
  assert.equal(got[0].allFrames, true);
  await chrome.userScripts.unregister({ ids: ["s1"] });
  assert.equal((await chrome.userScripts.getScripts()).length, 0);
});

test("userScripts: duplicate id rejects", async () => {
  const chrome = setup();
  await chrome.userScripts.register([{ id: "dup", js: [{ code: "1" }] }]);
  await assert.rejects(() => chrome.userScripts.register([{ id: "dup", js: [{ code: "2" }] }]));
});

// ---- instanceID ----
test("instanceID: getID is stable and persists; deleteID rotates it", async () => {
  const store = makeStore();
  const chrome = setup(store);
  const id1 = await chrome.instanceID.getID();
  assert.ok(id1 && typeof id1 === "string");
  assert.equal(await chrome.instanceID.getID(), id1, "stable within a session");
  await tick();
  // fresh shim, same store -> same id
  assert.equal(await setup(store).instanceID.getID(), id1, "persists across contexts");
  // deleteID rotates
  await chrome.instanceID.deleteID();
  assert.notEqual(await chrome.instanceID.getID(), id1);
});

test("instanceID: getToken still rejects (no FCM in Safari)", async () => {
  const chrome = setup();
  await assert.rejects(() => chrome.instanceID.getToken());
});

// ---- storage.sync callback bridge (BUG: promise-only local broke cb form) ----
// Simulate the webextension-polyfill `browser` object: storage.local is
// PROMISE-ONLY and ignores a trailing callback. Chrome code calling
// chrome.storage.sync.get(keys, cb) must still get cb invoked.
function promiseOnlyStore() {
  const data = {};
  return {
    local: {
      get: (key) => {
        const out = {};
        if (typeof key === "string") { if (key in data) out[key] = data[key]; }
        else if (key == null) Object.assign(out, data);
        else Object.keys(key).forEach((k) => { out[k] = k in data ? data[k] : key[k]; });
        return Promise.resolve(out);
      },
      set: (obj) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); },
      remove: (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete data[x]); return Promise.resolve(); },
      clear: () => { Object.keys(data).forEach((k) => delete data[k]); return Promise.resolve(); },
    },
    onChanged: { addListener() {}, removeListener() {}, hasListener() { return false; } },
  };
}

test("storage.sync: callback form fires even when local is promise-only", async () => {
  const chrome = setup(promiseOnlyStore());
  // set with callback
  await new Promise((res) => chrome.storage.sync.set({ a: 1 }, res));
  // get with callback
  const got = await new Promise((res) => chrome.storage.sync.get("a", res));
  assert.deepEqual(got, { a: 1 });
});

test("storage.sync: promise form still works (returns the promise)", async () => {
  const chrome = setup(promiseOnlyStore());
  await chrome.storage.sync.set({ b: 2 });
  assert.deepEqual(await chrome.storage.sync.get("b"), { b: 2 });
});

test("storage.sync: remove and clear honor callbacks against promise-only local", async () => {
  const chrome = setup(promiseOnlyStore());
  await chrome.storage.sync.set({ x: 1, y: 2 });
  await new Promise((res) => chrome.storage.sync.remove("x", res));
  assert.deepEqual(await chrome.storage.sync.get(null), { y: 2 });
  await new Promise((res) => chrome.storage.sync.clear(res));
  assert.deepEqual(await chrome.storage.sync.get(null), {});
});

// ---- fill() must not clobber legitimately-falsy native members ----
// Regression: fill used `if (!obj[k])`, so a real platform member that is falsy
// (tabId 0, isInstalled:false, "") got overwritten by the stub. The shim now tests
// presence with `in`. Provide a chrome whose contextMenus already exists with a
// falsy member and assert the shim leaves it intact.
test("fill: a falsy native member is preserved, not clobbered by the stub", () => {
  // contextMenus present but missing onClicked; a real (falsy) sentinel member set.
  const store = makeStore();
  const chrome = setup(store, {
    contextMenus: {
      // present-but-falsy: must survive
      _nativeFlag: 0,
      // present method: must survive (fill only adds missing)
      create: () => "native-id",
    },
  });
  assert.equal(chrome.contextMenus._nativeFlag, 0, "falsy native member preserved");
  assert.equal(chrome.contextMenus.create(), "native-id", "native method preserved");
  // missing member backfilled
  assert.equal(typeof chrome.contextMenus.removeAll, "function", "missing member added");
  assert.ok(chrome.contextMenus.onClicked, "missing event added");
});

// ---- cookies.onChanged: Safari fires a NULL changeInfo (Grammarly bg crash) ----
// Safari exposes chrome.cookies.onChanged but emits null. A listener doing
// `const {cookie} = changeInfo` throws; unhandled in the bg page it kills the bg
// (Grammarly: bg.unhandledException → popup init times out). The shim wraps
// addListener to drop null events before they reach the listener.
test("cookies.onChanged: null events are swallowed, real events pass through", () => {
  // Native onChanged with real listener storage + a way to fire arbitrary payloads.
  const listeners = [];
  const nativeCookies = {
    get: () => {}, getAll: () => {}, set: () => {}, remove: () => {},
    onChanged: {
      addListener(f) { listeners.push(f); },
      removeListener() {}, hasListener() { return false; },
      _fire(payload) { for (const f of listeners.slice()) f(payload); },
    },
  };
  const chrome = setup(makeStore(), { cookies: nativeCookies });

  const seen = [];
  // Grammarly-style listener that destructures the event.
  chrome.cookies.onChanged.addListener((changeInfo) => {
    const { cookie } = changeInfo; // throws if changeInfo is null and unguarded
    seen.push(cookie && cookie.name);
  });

  // Safari delivers null first — must NOT throw and must NOT reach the listener.
  assert.doesNotThrow(() => nativeCookies.onChanged._fire(null));
  assert.doesNotThrow(() => nativeCookies.onChanged._fire(undefined));
  assert.deepEqual(seen, [], "null/undefined events dropped before the listener");

  // A real event still flows through.
  nativeCookies.onChanged._fire({ cookie: { name: "sid" }, cause: "explicit" });
  assert.deepEqual(seen, ["sid"], "real change events still delivered");
});
