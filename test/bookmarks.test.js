// chrome.bookmarks is fully emulated against chrome.storage.local (Safari has no
// bookmark API). These exercise CRUD, tree assembly, search, events, persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/shim.js";

// Shared async storage.local backing two shim instances to test persistence.
function makeStore() {
  const data = {};
  return {
    data,
    local: {
      get: (key, cb) => {
        const out = {};
        if (typeof key === "string") { if (key in data) out[key] = data[key]; }
        else if (Array.isArray(key)) key.forEach((k) => { if (k in data) out[k] = data[k]; });
        else if (key == null) Object.assign(out, data);
        else Object.keys(key).forEach((k) => { out[k] = k in data ? data[k] : key[k]; });
        Promise.resolve().then(() => cb(out));
      },
      set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); Promise.resolve().then(() => cb && cb()); },
    },
  };
}

function setup(store) {
  const chrome = { runtime: { lastError: null, getManifest: () => ({}) }, storage: store };
  const window = { addEventListener() {} };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, window, undefined, { chrome });
  return chrome;
}

test("bookmarks: seeded tree has root + Bookmarks Bar + Other", async () => {
  const chrome = setup(makeStore());
  const [root] = await chrome.bookmarks.getTree();
  assert.equal(root.id, "0");
  assert.equal(root.children.length, 2);
  assert.deepEqual(root.children.map((c) => c.title), ["Bookmarks Bar", "Other Bookmarks"]);
});

test("bookmarks: create returns a node and getChildren reflects it", async () => {
  const chrome = setup(makeStore());
  const bm = await chrome.bookmarks.create({ parentId: "1", title: "Anthropic", url: "https://anthropic.com" });
  assert.equal(bm.title, "Anthropic");
  assert.equal(bm.url, "https://anthropic.com");
  assert.equal(bm.parentId, "1");
  const kids = await chrome.bookmarks.getChildren("1");
  assert.equal(kids.length, 1);
  assert.equal(kids[0].id, bm.id);
});

test("bookmarks: onCreated fires with the new node", async () => {
  const chrome = setup(makeStore());
  const seen = [];
  chrome.bookmarks.onCreated.addListener((id, node) => seen.push([id, node.title]));
  const bm = await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.test" });
  assert.deepEqual(seen, [[bm.id, "X"]]);
});

test("bookmarks: update changes title and fires onChanged", async () => {
  const chrome = setup(makeStore());
  const bm = await chrome.bookmarks.create({ parentId: "1", title: "old", url: "https://o.test" });
  const events = [];
  chrome.bookmarks.onChanged.addListener((id, info) => events.push(info.title));
  const upd = await chrome.bookmarks.update(bm.id, { title: "new" });
  assert.equal(upd.title, "new");
  assert.deepEqual(events, ["new"]);
});

test("bookmarks: move reparents and reindexes", async () => {
  const chrome = setup(makeStore());
  const a = await chrome.bookmarks.create({ parentId: "1", title: "a", url: "https://a.test" });
  const moved = await chrome.bookmarks.move(a.id, { parentId: "2", index: 0 });
  assert.equal(moved.parentId, "2");
  assert.equal((await chrome.bookmarks.getChildren("1")).length, 0);
  assert.equal((await chrome.bookmarks.getChildren("2")).length, 1);
});

test("bookmarks: search matches title and url, supports object query", async () => {
  const chrome = setup(makeStore());
  await chrome.bookmarks.create({ parentId: "1", title: "Claude docs", url: "https://docs.claude.com" });
  await chrome.bookmarks.create({ parentId: "1", title: "Random", url: "https://example.com" });
  const byTerm = await chrome.bookmarks.search("claude");
  assert.equal(byTerm.length, 1);
  const byUrl = await chrome.bookmarks.search({ url: "https://example.com" });
  assert.equal(byUrl.length, 1);
  assert.equal(byUrl[0].title, "Random");
});

test("bookmarks: remove deletes leaf and fires onRemoved; folder guard works", async () => {
  const chrome = setup(makeStore());
  const folder = await chrome.bookmarks.create({ parentId: "2", title: "Folder" });
  const child = await chrome.bookmarks.create({ parentId: folder.id, title: "c", url: "https://c.test" });
  // Removing a non-empty folder with remove() must reject.
  await assert.rejects(() => chrome.bookmarks.remove(folder.id));
  const removed = [];
  chrome.bookmarks.onRemoved.addListener((id) => removed.push(id));
  await chrome.bookmarks.remove(child.id);
  assert.deepEqual(removed, [child.id]);
  // Now the folder is empty and removable.
  await chrome.bookmarks.remove(folder.id);
  assert.equal((await chrome.bookmarks.getChildren("2")).length, 0);
});

test("bookmarks: removeTree deletes a folder and its descendants", async () => {
  const chrome = setup(makeStore());
  const f = await chrome.bookmarks.create({ parentId: "2", title: "F" });
  await chrome.bookmarks.create({ parentId: f.id, title: "c1", url: "https://1.test" });
  await chrome.bookmarks.create({ parentId: f.id, title: "c2", url: "https://2.test" });
  await chrome.bookmarks.removeTree(f.id);
  assert.equal((await chrome.bookmarks.getChildren("2")).length, 0);
  assert.deepEqual(await chrome.bookmarks.get(f.id), []);
});

test("bookmarks: state persists across a fresh shim via storage.local", async () => {
  const store = makeStore();
  const c1 = setup(store);
  const bm = await c1.bookmarks.create({ parentId: "1", title: "persist", url: "https://p.test" });
  // New shim instance, same backing store — must reload the saved tree.
  const c2 = setup(store);
  const got = await c2.bookmarks.get(bm.id);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "persist");
});

test("bookmarks: callback form works alongside promise form", () => {
  const chrome = setup(makeStore());
  return new Promise((resolve) => {
    chrome.bookmarks.create({ parentId: "1", title: "cb", url: "https://cb.test" }, (node) => {
      assert.equal(node.title, "cb");
      resolve();
    });
  });
});
