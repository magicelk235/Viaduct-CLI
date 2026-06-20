// APIs upgraded from inert stubs to real Web Platform backings:
//   chrome.power.requestKeepAwake -> Screen Wake Lock (navigator.wakeLock)
//   chrome.system.cpu/memory.getInfo -> navigator.hardwareConcurrency / deviceMemory
import { test } from "node:test";
import assert from "node:assert/strict";
import { shimSource } from "../dist/shim.js";

// Build a chrome shim with an injected navigator/document on globalThis so the
// web-API branches are exercised (the shim reads these as globals).
function setup(nav, doc) {
  const chrome = { runtime: { lastError: null, getManifest: () => ({}) } };
  const g = { chrome };
  if (nav) g.navigator = nav;
  if (doc) g.document = doc;
  // Expose navigator/document as globals the shim closure can see.
  const fn = new Function("chrome", "window", "self", "globalThis", "navigator", "document", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, g, nav, doc);
  return chrome;
}

// Minimal document that records visibilitychange handlers and can flip state.
function fakeDoc(state = "visible") {
  const handlers = [];
  return {
    visibilityState: state,
    addEventListener: (type, fn) => { if (type === "visibilitychange") handlers.push(fn); },
    _setVisibility(v) { this.visibilityState = v; handlers.forEach((f) => f()); },
  };
}

test("idle.onStateChanged fires when document visibility flips", () => {
  const doc = fakeDoc("visible");
  const chrome = setup({}, doc);
  const seen = [];
  chrome.idle.onStateChanged.addListener((s) => seen.push(s));
  doc._setVisibility("hidden");
  doc._setVisibility("visible");
  assert.deepEqual(seen, ["idle", "active"]);
});

test("idle.queryState reflects current visibility", async () => {
  const doc = fakeDoc("hidden");
  const chrome = setup({}, doc);
  assert.equal(await chrome.idle.queryState(60), "idle");
});

test("idle.onStateChanged.removeListener stops delivery", () => {
  const doc = fakeDoc("visible");
  const chrome = setup({}, doc);
  const seen = [];
  const fn = (s) => seen.push(s);
  chrome.idle.onStateChanged.addListener(fn);
  chrome.idle.onStateChanged.removeListener(fn);
  doc._setVisibility("hidden");
  assert.deepEqual(seen, []);
});

test("system.storage.getInfo reports quota from StorageManager.estimate()", async () => {
  const nav = { storage: { estimate: () => Promise.resolve({ quota: 5000, usage: 10 }) } };
  const chrome = setup(nav);
  const info = await chrome.system.storage.getInfo();
  assert.equal(info.length, 1);
  assert.equal(info[0].capacity, 5000);
});

test("system.storage.getInfo falls back to [] without StorageManager", async () => {
  const chrome = setup({});
  assert.deepEqual(await chrome.system.storage.getInfo(), []);
});

test("system.cpu.getInfo reports real navigator.hardwareConcurrency", async () => {
  const chrome = setup({ hardwareConcurrency: 8 });
  const info = await chrome.system.cpu.getInfo();
  assert.equal(info.numOfProcessors, 8);
  assert.equal(info.processors.length, 8, "one processor entry per core");
});

test("system.memory.getInfo converts navigator.deviceMemory (GiB) to bytes", async () => {
  const chrome = setup({ deviceMemory: 8 });
  const info = await chrome.system.memory.getInfo();
  assert.equal(info.capacity, 8 * 1024 * 1024 * 1024);
});

test("system.* degrades to zeros when navigator lacks the fields", async () => {
  const chrome = setup({});
  const cpu = await chrome.system.cpu.getInfo();
  const mem = await chrome.system.memory.getInfo();
  assert.equal(cpu.numOfProcessors, 0);
  assert.equal(mem.capacity, 0);
});

test("power.requestKeepAwake takes a screen wake lock when available", () => {
  let requested = null;
  const nav = { wakeLock: { request: (type) => { requested = type; return Promise.resolve({ release: () => {} }); } } };
  const chrome = setup(nav, { visibilityState: "visible", addEventListener() {} });
  chrome.power.requestKeepAwake("display");
  assert.equal(requested, "screen", "should request a screen wake lock");
});

test("power.requestKeepAwake is a safe no-op without the Wake Lock API", () => {
  const chrome = setup({}, { visibilityState: "visible", addEventListener() {} });
  assert.doesNotThrow(() => { chrome.power.requestKeepAwake("display"); chrome.power.releaseKeepAwake(); });
});
