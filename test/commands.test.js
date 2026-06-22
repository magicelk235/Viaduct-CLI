import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Run the generated shim against a Safari-like chrome mock (commands lacks
// getAll; no chrome://extensions/shortcuts page) and assert the shim makes
// shortcut management usable: getAll() reflects the manifest, and a navigation
// to the non-existent chrome:// shortcuts page is swallowed, not opened.
function runShim(manifestCommands) {
  const created = [];
  const chrome = {
    runtime: { getManifest: () => ({ commands: manifestCommands || {} }) },
    tabs: {
      query: (q, cb) => (cb ? cb([]) : Promise.resolve([])),
      create: (p, cb) => { created.push(p.url); return cb ? cb({ id: 1 }) : Promise.resolve({ id: 1 }); },
    },
    storage: { local: { get() {}, set() {} } },
  };
  const sandbox = {
    chrome, console, Promise, Date, Object, URL,
    setTimeout, clearTimeout,
    Notification: undefined, fetch: undefined, XMLHttpRequest: undefined,
    Headers: function () {},
  };
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { chrome, created };
}

test("commands.getAll() reconstructs the manifest's commands for the extension UI", async () => {
  const { chrome } = runShim({
    toggle: { description: "Toggle it", suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" } },
    _execute_action: { suggested_key: "Ctrl+B" },
  });
  const cmds = await chrome.commands.getAll();
  assert.equal(cmds.length, 2);
  const toggle = cmds.find((c) => c.name === "toggle");
  assert.equal(toggle.description, "Toggle it");
  assert.equal(toggle.shortcut, "Command+Shift+Y"); // mac chord preferred
  const exec = cmds.find((c) => c.name === "_execute_action");
  assert.equal(exec.shortcut, "Ctrl+B"); // string suggested_key
});

test("commands.getAll() is empty (not throwing) when the manifest declares none", async () => {
  const { chrome } = runShim({});
  const cmds = await chrome.commands.getAll();
  assert.ok(Array.isArray(cmds) && cmds.length === 0);
});

test("commands.openShortcutSettings() resolves false (no Safari deep-link)", async () => {
  const { chrome } = runShim({});
  assert.equal(await chrome.commands.openShortcutSettings(), false);
});

test("tabs.create to chrome://extensions/shortcuts is swallowed, not opened", async () => {
  const { chrome, created } = runShim({});
  await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  await chrome.tabs.create({ url: "https://example.com" });
  // Only the real URL reaches the underlying create; the dead chrome:// link does not.
  assert.deepEqual(created, ["https://example.com"]);
});
