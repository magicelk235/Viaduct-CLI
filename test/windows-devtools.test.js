// Runs the generated shim against a fake chrome and asserts the windows/devtools/app
// backfills: missing members are filled, native ones are NOT clobbered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource, convertServiceWorkerToBackgroundPage, SHIM_FILENAME } from "../dist/shim.js";

function runShim(chrome) {
  const window = { addEventListener() {} };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, window, undefined, { chrome });
  return chrome;
}

test("windows: backfills onBoundsChanged without clobbering native methods", () => {
  let nativeGetCalled = false;
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, create() {} },
    // Safari ships windows.get/create but omits onBoundsChanged.
    windows: { get: () => { nativeGetCalled = true; }, create() {} },
  };
  runShim(chrome);
  // Native member preserved.
  chrome.windows.get();
  assert.equal(nativeGetCalled, true);
  // Missing event backfilled as a usable inert event object.
  assert.equal(typeof chrome.windows.onBoundsChanged.addListener, "function");
  assert.doesNotThrow(() => chrome.windows.onBoundsChanged.addListener(() => {}));
  assert.equal(chrome.windows.WINDOW_ID_CURRENT, -2);
});

test("windows: full absence (iOS) → create routes to tabs, getAll resolves []", async () => {
  let openedUrl = null;
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, create: (o) => { openedUrl = o.url; } },
  };
  runShim(chrome);
  await chrome.windows.create({ url: "https://example.com/x" });
  assert.equal(openedUrl, "https://example.com/x");
  assert.deepEqual(await chrome.windows.getAll(), []);
});

test("devtools: panels/network/inspectedWindow stubbed so a devtools page loads", () => {
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  };
  runShim(chrome);
  assert.equal(typeof chrome.devtools.network.onRequestFinished.addListener, "function");
  assert.doesNotThrow(() => chrome.devtools.panels.create("t", "", "p.html", () => {}));
  assert.equal(chrome.devtools.inspectedWindow.tabId, -1);
});

test("app: isInstalled reports not-installed", async () => {
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  };
  runShim(chrome);
  assert.equal(chrome.app.isInstalled, false);
  assert.equal(chrome.app.getDetails(), null);
  assert.equal(await chrome.app.installState(), "not_installed");
});

test("importScripts: hoisted into background.html, call neutralized in SW", () => {
  // The default extension CSP forbids eval, so importScripts is fixed at staging
  // time: imported files become classic <script> tags before the SW module, and
  // the call is replaced with a no-op.
  const dir = mkdtempSync(join(tmpdir(), "c2s-imp-"));
  mkdirSync(join(dir, "service-worker"), { recursive: true });
  mkdirSync(join(dir, "ad-blocker"), { recursive: true });
  writeFileSync(join(dir, "ad-blocker", "background.js"), "/* ad blocker */");
  writeFileSync(
    join(dir, "service-worker", "index.js"),
    'console.log("a");importScripts("../ad-blocker/background.js");console.log("b");',
  );
  writeFileSync(join(dir, SHIM_FILENAME), "// shim");

  const manifest = { name: "T", background: { service_worker: "service-worker/index.js" } };
  const converted = convertServiceWorkerToBackgroundPage(dir, manifest);
  assert.equal(converted, true);

  const html = readFileSync(join(dir, "background.html"), "utf-8");
  // Imported file hoisted as a classic script BEFORE the SW module.
  assert.match(html, /<script src="ad-blocker\/background\.js"><\/script>/);
  assert.ok(html.indexOf('ad-blocker/background.js') < html.indexOf('type="module"'),
    "import tag must precede the SW module");

  // The call is neutralized in the SW source; the surrounding code survives.
  const sw = readFileSync(join(dir, "service-worker", "index.js"), "utf-8");
  assert.doesNotMatch(sw, /importScripts\s*\(\s*["']/);
  assert.match(sw, /console\.log\("a"\)/);
  assert.match(sw, /console\.log\("b"\)/);

  rmSync(dir, { recursive: true, force: true });
});

test("importScripts: unresolved target → no tag, call still neutralized", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-imp2-"));
  mkdirSync(join(dir, "service-worker"), { recursive: true });
  writeFileSync(join(dir, "service-worker", "index.js"), 'importScripts("missing.js");x();');
  const manifest = { name: "T", background: { service_worker: "service-worker/index.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.doesNotMatch(html, /missing\.js/);
  const sw = readFileSync(join(dir, "service-worker", "index.js"), "utf-8");
  assert.doesNotMatch(sw, /importScripts\s*\(\s*["']/);
  rmSync(dir, { recursive: true, force: true });
});
