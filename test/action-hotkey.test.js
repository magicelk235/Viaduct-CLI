import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wireActionHotkey } from "../dist/runtime/shim.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-hk-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("wires an in-page hotkey that replays the background's onClicked message", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'TOGGLE_SHELL'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    commands: { "toggle-shell": { suggested_key: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" } } },
  };
  try {
    const label = wireActionHotkey(dir, manifest);
    assert.equal(label, "Command+Shift+S");
    assert.ok(existsSync(join(dir, "__viaduct-hotkey.js")));
    const js = readFileSync(join(dir, "__viaduct-hotkey.js"), "utf-8");
    // replays the exact message the onClicked handler sends
    assert.match(js, /TOGGLE_SHELL/);
    // combo parsed from the command's mac key
    assert.match(js, /"meta":true/);
    assert.match(js, /"key":"s"/);
    // invokes the shim-captured content-script listeners, not the toolbar/background
    assert.match(js, /__viaductMsgListeners/);
    // hotkey added to the content script
    assert.ok(manifest.content_scripts[0].js.includes("__viaduct-hotkey.js"));
    // the now-inert command (Safari never fires onCommand) is removed to free its key
    assert.equal(manifest.commands, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back (no hotkey) when the onClicked message can't be determined", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => doSomethingDynamic(t));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), null);
    assert.ok(!existsSync(join(dir, "__viaduct-hotkey.js")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no hotkey without content scripts (nothing in-page to toggle)", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'X'}));",
  });
  const manifest = { manifest_version: 3, action: {}, background: { service_worker: "bg.js" } };
  try {
    assert.equal(wireActionHotkey(dir, manifest), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaults to Ctrl+Shift+Y when the extension declares no command", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'GO'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), "Ctrl+Shift+Y");
    const js = readFileSync(join(dir, "__viaduct-hotkey.js"), "utf-8");
    assert.match(js, /"ctrl":true/);
    assert.match(js, /"key":"y"/);
    assert.match(js, /GO/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with several ambiguous commands, uses the default and leaves commands untouched", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'GO'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    commands: {
      "open-settings": { suggested_key: { default: "Ctrl+Shift+O" } },
      "next-tab": { suggested_key: { default: "Ctrl+Shift+N" } },
    },
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), "Ctrl+Shift+Y");
    // ambiguous → don't steal a key; both commands remain
    assert.deepEqual(Object.keys(manifest.commands), ["open-settings", "next-tab"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefers _execute_action's key among multiple commands", () => {
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'GO'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    commands: {
      "other": { suggested_key: { default: "Ctrl+Shift+O" } },
      "_execute_action": { suggested_key: { mac: "Command+Shift+E", default: "Ctrl+Shift+E" } },
    },
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), "Command+Shift+E");
    // only the reused command is removed
    assert.deepEqual(Object.keys(manifest.commands), ["other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maps a named command key (Up) to its DOM e.key form (arrowup), not the bare token", () => {
  // The generated script compares `e.key.toLowerCase()` — for the Up arrow that's
  // "arrowup", never "up". A bare "up" wired the shortcut but it could never fire.
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'TOGGLE'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    commands: { "_execute_action": { suggested_key: { default: "Ctrl+Shift+Up" } } },
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), "Ctrl+Shift+Up");
    const js = readFileSync(join(dir, "__viaduct-hotkey.js"), "utf-8");
    assert.match(js, /"key":"arrowup"/);
    assert.doesNotMatch(js, /"key":"up"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls back to the Ctrl+Shift+Y default when the command key is unmappable", () => {
  // A named key we can't map to an e.key (e.g. a function key token) must NOT wire a
  // dead shortcut — parseCombo bails and the caller uses its working default.
  const dir = stage({
    "bg.js": "chrome.action.onClicked.addListener(t => chrome.tabs.sendMessage(t.id, {type:'TOGGLE'}));",
    "content.js": "chrome.runtime.onMessage.addListener(e => {});",
  });
  const manifest = {
    manifest_version: 3,
    action: {},
    background: { service_worker: "bg.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
    commands: { "_execute_action": { suggested_key: { default: "Ctrl+Shift+MediaPlayPause" } } },
  };
  try {
    assert.equal(wireActionHotkey(dir, manifest), "Ctrl+Shift+Y");
    const js = readFileSync(join(dir, "__viaduct-hotkey.js"), "utf-8");
    assert.match(js, /"key":"y"/);
    // the unmappable command was NOT reused, so it stays on the manifest
    assert.deepEqual(Object.keys(manifest.commands), ["_execute_action"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
