import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari has no tab groups; the shim keeps a group registry and stamps
// tab.groupId onto tabs.get/query results. Two things it got wrong, both found
// on Claude in Chrome 1.0.91 in Safari Technology Preview, whose tool engine
// runs in the side panel and keeps the agent in an isolated tab group:
//  - it did not honor a `groupId` in the query, and Safari ignores the unknown
//    filter and answers with every tab, so the panel and the user's tabs were
//    reported as group members;
//  - the registry lived per shim instance, so a group made in the panel was
//    unknown to the background, and the tab the agent created was "not in the
//    same group as the current" one.
// It concluded its new tab never existed and drove the user's current tab.

// The shim arms keepalive intervals once storage.local exists; unref them so the
// runner exits when the assertions are done.
const unrefd = (fn) => (...a) => { const t = fn(...a); if (t && typeof t.unref === "function") t.unref(); return t; };

// One storage.local shared by every context, with onChanged fan-out, like Safari's.
// Each context gets its own namespace OBJECTS (Safari does too): the shim installs
// per-context wrappers on them, and a shared object would wrap another's wrapper.
function makeStorage() {
  const store = {};
  const sess = {};
  const listeners = [];
  return () => ({
    local: {
      // Callbacks fire asynchronously, as Safari's do.
      get: (k, cb) => { const r = store[k] === undefined ? {} : { [k]: store[k] }; if (cb) queueMicrotask(() => cb(r)); return Promise.resolve(r); },
      set: (o, cb) => {
        const changes = {};
        for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(v)) }; store[k] = changes[k].newValue; }
        for (const l of listeners) l(changes, "local");
        if (cb) cb();
        return Promise.resolve();
      },
    },
    session: {
      get: (k) => Promise.resolve(k == null ? { ...sess } : (sess[k] === undefined ? {} : { [k]: sess[k] })),
      set: (o) => { Object.assign(sess, o); return Promise.resolve(); },
      remove: (k) => { for (const x of [].concat(k)) delete sess[x]; return Promise.resolve(); },
      clear: () => { for (const x of Object.keys(sess)) delete sess[x]; return Promise.resolve(); },
    },
    onChanged: { addListener(l) { listeners.push(l); } },
  });
}

function boot(storageFor, pathname = "/background.html") {
  const tabs = [
    { id: 1, windowId: 5, url: "https://a.example/", active: true },
    { id: 2, windowId: 5, url: "safari-web-extension://TEST/sidepanel.html", active: false },
    { id: 3, windowId: 5, url: "https://b.example/", active: false },
  ];
  const sandbox = {
    console,
    setTimeout: unrefd(setTimeout), clearTimeout, setInterval: unrefd(setInterval), clearInterval,
    location: { href: "safari-web-extension://TEST" + pathname, protocol: "safari-web-extension:", pathname },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {} },
        onConnect: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      storage: storageFor(),
      tabs: {
        query(q, cb) {
          // Safari: unknown filter keys are ignored.
          const r = tabs.filter((t) => (q.windowId == null || t.windowId === q.windowId)).map((t) => ({ ...t }));
          if (cb) cb(r);
          return Promise.resolve(r);
        },
        get(id) { return Promise.resolve({ ...tabs.find((t) => t.id === id) }); },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox;
}

test("tabs.query({groupId}) returns only the tabs in that emulated group", async () => {
  const s = boot(makeStorage());
  const gid = await s.chrome.tabs.group({ tabIds: [3] });
  assert.equal(typeof gid, "number");
  const members = await s.chrome.tabs.query({ groupId: gid });
  assert.deepEqual(members.map((t) => t.id), [3]);
  assert.equal(members[0].groupId, gid);
  const none = await s.chrome.tabs.query({ groupId: s.chrome.tabGroups.TAB_GROUP_ID_NONE });
  assert.deepEqual(none.map((t) => t.id).sort(), [1, 2], "TAB_GROUP_ID_NONE selects the ungrouped tabs");
  const all = await s.chrome.tabs.query({});
  assert.deepEqual(all.map((t) => t.id).sort(), [1, 2, 3], "no groupId in the query keeps every tab");
});

test("the groupId filter also applies to the callback form and combines with other filters", async () => {
  const s = boot(makeStorage());
  const gid = await s.chrome.tabs.group({ tabIds: [1, 3] });
  const viaCb = await new Promise((resolve) => s.chrome.tabs.query({ groupId: gid, windowId: 5 }, resolve));
  assert.deepEqual(viaCb.map((t) => t.id).sort(), [1, 3]);
  const otherWindow = await s.chrome.tabs.query({ groupId: gid, windowId: 6 });
  assert.deepEqual(otherWindow, []);
});

test("a group made in one context is visible in another, and a later context loads it", async () => {
  const storage = makeStorage();
  const panel = boot(storage, "/sidepanel.html");
  const bg = boot(storage);
  const gid = await panel.chrome.tabs.group({ tabIds: 3, createProperties: { windowId: 5 } });
  assert.deepEqual((await bg.chrome.tabs.query({ groupId: gid })).map((t) => t.id), [3], "the background sees the panel's group");
  assert.equal((await bg.chrome.tabGroups.get(gid)).windowId, 5);
  await bg.chrome.tabGroups.update(gid, { title: "Claude" });
  assert.equal((await panel.chrome.tabGroups.get(gid)).title, "Claude", "and the panel sees the background's update");
  const late = boot(storage, "/popup.html");
  assert.equal((await late.chrome.tabs.get(3)).groupId, gid, "a context booted afterwards reads the shared registry before answering");
  const gid2 = await late.chrome.tabs.group({ tabIds: [1] });
  assert.notEqual(gid2, gid, "ids keep incrementing across contexts instead of colliding");
});
