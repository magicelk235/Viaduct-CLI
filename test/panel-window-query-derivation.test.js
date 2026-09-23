import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { derivePanelWindowQuery } from "../dist/runtime/shim.js";

// Safari shows a side panel as a standalone popover. An extension that opens the same
// page itself as a standalone window says how the page behaves in that form:
//   windows.create({ url: getURL(`sidepanel.html?mode=window&sessionId=${id}`) })
// and the popover should open the page the same way, with no flag. Only the literal
// head of the URL counts, and only complete key=value pairs in it, so a permission
// popup opened as `sidepanel.html?tabId=${t}&mcpPermissionOnly=true` contributes
// nothing: its head ends in a dynamic value.

function bundle(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-pwq-"));
  mkdirSync(join(dir, "assets"));
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  return dir;
}
const manifest = { manifest_version: 3, side_panel: { default_path: "sidepanel.html" } };

test("the window-mode head is derived; dynamic tails and the permission popup are not", (t) => {
  const dir = bundle({
    "assets/sw.js": 'const i=chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}${n?"&skipPermissions=true":""}`),o=await chrome.windows.create({url:i,type:"popup",width:500});',
    "assets/ui.js": 'chrome.windows.create({url:chrome.runtime.getURL(`sidepanel.html?tabId=${t}&mcpPermissionOnly=true&requestId=${r}`),type:"popup"},e=>{});' +
      'const j=chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}`);chrome.windows.create({url:j});',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir, manifest), "mode=window");
});

test("a bundle that never opens its panel as a window yields nothing", (t) => {
  const dir = bundle({
    "assets/sw.js": 'chrome.sidePanel.setOptions({path:`sidepanel.html?tabId=${e}`});chrome.tabs.create({url:"sidepanel.html?mode=tab"});',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir, manifest), "");
});

test("two window forms with different constant heads are ambiguous and nothing is derived", (t) => {
  const dir = bundle({
    "assets/a.js": 'chrome.windows.create({url:chrome.runtime.getURL("sidepanel.html?mode=window")});',
    "assets/b.js": 'chrome.windows.create({url:chrome.runtime.getURL("sidepanel.html?mode=compact")});',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir, manifest), "");
});

test("a panel page in a subdirectory is matched by its file name", (t) => {
  const dir = bundle({
    "assets/sw.js": 'chrome.windows.create({url:chrome.runtime.getURL("panel/index.html?standalone=1&x=y")});',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir, { manifest_version: 3, side_panel: { default_path: "/panel/index.html" } }), "standalone=1&x=y");
});

test("no side_panel key: a `sidepanel` page name still counts (Claude declares none), any other page does not", (t) => {
  const dir = bundle({
    "assets/sw.js": 'chrome.windows.create({url:chrome.runtime.getURL(`sidepanel.html?mode=window&sessionId=${t}`)});',
    "assets/other.js": 'chrome.windows.create({url:"popup.html?mode=window"});',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir, { manifest_version: 3, action: { default_popup: "sidepanel.html" } }), "mode=window");
  const dir2 = bundle({ "assets/sw.js": 'chrome.windows.create({url:"popup.html?mode=window"});' });
  t.after(() => rmSync(dir2, { recursive: true, force: true }));
  assert.equal(derivePanelWindowQuery(dir2, { manifest_version: 3, action: { default_popup: "popup.html" } }), "");
});
