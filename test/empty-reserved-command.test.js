import { test } from "node:test";
import assert from "node:assert/strict";
import { dropEmptyReservedCommands } from "../dist/manifest/manifest.js";

// `"_execute_action": {}` is valid in Chrome, and Stylus and Violentmonkey ship it.
// Safari records "Empty or invalid command in the `commands` manifest entry" for it
// and shows the error under Settings > Extensions, while synthesizing the very same
// command without the entry. A shortcut-only or description-only one loads cleanly.

test("an empty reserved command is dropped, the rest stay as they were", () => {
  const m = {
    commands: {
      _execute_action: {},
      openManage: { description: "Manage" },
      _execute_browser_action: { suggested_key: { default: "Alt+Shift+S" } },
    },
  };
  assert.deepEqual(dropEmptyReservedCommands(m), ["_execute_action"]);
  assert.deepEqual(Object.keys(m.commands), ["openManage", "_execute_browser_action"]);
  assert.deepEqual(m.commands._execute_browser_action, { suggested_key: { default: "Alt+Shift+S" } });
});

test("a reserved command with a description or a shortcut is kept", () => {
  const m = { commands: { _execute_action: { description: "" }, _execute_page_action: { suggested_key: { mac: "Command+Shift+E" } } } };
  assert.deepEqual(dropEmptyReservedCommands(m), []);
  assert.equal(Object.keys(m.commands).length, 2);
});

test("an ordinary command is never touched, even when empty", () => {
  const m = { commands: { toggle: {} } };
  assert.deepEqual(dropEmptyReservedCommands(m), []);
  assert.deepEqual(m.commands, { toggle: {} });
});

test("commands left empty is removed rather than kept as {}", () => {
  const m = { name: "x", commands: { _execute_action: {} } };
  dropEmptyReservedCommands(m);
  assert.ok(!("commands" in m));
});
