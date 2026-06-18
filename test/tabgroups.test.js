// Runs the generated shim source against a minimal fake chrome.tabs and asserts
// the emulated chrome.tabGroups lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/shim.js";

function fakeEvent() {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener: () => {}, hasListener: () => false, _emit: (...a) => ls.forEach((f) => f(...a)) };
}

function setup() {
  const removed = fakeEvent();
  const tabsById = { 1: { id: 1 }, 2: { id: 2 }, 3: { id: 3 } };
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: {
      onUpdated: fakeEvent(),
      onRemoved: removed,
      get: (id, cb) => cb(Object.assign({}, tabsById[id])),
      query: (qi, cb) => cb(Object.values(tabsById).map((t) => Object.assign({}, t))),
      move: (ids, info, cb) => cb && cb(),
    },
  };
  const window = { addEventListener() {} };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, window, undefined, { chrome });
  return { chrome, removed };
}

test("tabGroups emulation lifecycle", async () => {
  const { chrome, removed } = setup();
  const tg = chrome.tabGroups;
  assert.ok(tg && typeof chrome.tabs.group === "function", "tabGroups + tabs.group present");

  const events = [];
  tg.onCreated.addListener((g) => events.push(["created", g.id]));
  tg.onRemoved.addListener((g) => events.push(["removed", g.id]));

  const gid = await chrome.tabs.group({ tabIds: [1, 2] });
  assert.equal(typeof gid, "number");
  assert.deepEqual(events[0], ["created", gid]);

  assert.equal((await tg.query({})).length, 1, "one group");
  assert.equal((await tg.get(gid)).color, "grey");

  chrome.tabs.get(1, (t) => assert.equal(t.groupId, gid, "tab 1 in group"));
  chrome.tabs.get(3, (t) => assert.equal(t.groupId, -1, "tab 3 ungrouped"));

  await tg.update(gid, { title: "Work", color: "blue" });
  assert.equal((await tg.get(gid)).title, "Work");

  await chrome.tabs.group({ groupId: gid, tabIds: [3] });
  await chrome.tabs.ungroup([1, 2]);
  assert.equal((await tg.query({})).length, 1, "group survives while tab 3 remains");

  removed._emit(3, {});
  assert.equal((await tg.query({})).length, 0, "group removed when empty");
  assert.deepEqual(events[events.length - 1], ["removed", gid]);
});
