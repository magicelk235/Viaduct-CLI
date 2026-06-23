// Runs the generated shim against a fake chrome and asserts the windows/devtools/app
// backfills: missing members are filled, native ones are NOT clobbered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource, convertServiceWorkerToBackgroundPage, SHIM_FILENAME } from "../dist/runtime/shim.js";

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
  // elements/sources sidebar panes: the elements-panel extension pattern calls
  // createSidebarPane at devtools load; a missing method threw and killed the page.
  let pane;
  assert.doesNotThrow(() => { pane = chrome.devtools.panels.elements.createSidebarPane("My Pane", (p) => { pane = p; }); });
  assert.equal(typeof pane.setObject, "function");
  assert.equal(typeof pane.setExpression, "function");
  assert.equal(typeof chrome.devtools.panels.sources.createSidebarPane, "function");
});

test("a throw inside a backfill section never escapes the shim to abort the host script", () => {
  // Core contract: the shim is prepended to every content script and HTML page,
  // so a throw at its top level kills that whole script (blank popup / dead content
  // script). The chrome.* backfill blocks run ~1100 sequential statements; if any
  // one throws (here simulated with a hostile getter on chrome.omnibox), the
  // per-block try/catch must swallow it. Whatever ran before the throw stays;
  // the host script keeps executing. This is the guarantee that matters in prod —
  // real Safari namespaces are plain objects and don't throw on read, but a
  // future Safari quirk must never take the host script down.
  const chrome = {
    runtime: { lastError: null, getManifest: () => ({}) },
    tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
  };
  Object.defineProperty(chrome, "omnibox", { configurable: true, get() { throw new Error("hostile getter"); } });
  assert.doesNotThrow(() => runShim(chrome), "shim must not propagate a section throw to the host script");
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

test("importScripts: nested parens in args are fully neutralized (no dangling ')')", () => {
  // webpack's chunk loader emits importScripts(o.p+o.u(t)) — the call argument
  // itself contains parens. A regex that stopped at the FIRST ")" left the outer
  // ")" dangling and broke the bundle with "Unexpected token ')'" (Bitwarden).
  const dir = mkdtempSync(join(tmpdir(), "c2s-imp3-"));
  writeFileSync(
    join(dir, "sw.js"),
    'var o={p:"",u:t=>t};o.f.i=(t,i)=>{e[t]||importScripts(o.p+o.u(t))};var done=1;',
  );
  const manifest = { name: "T", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const sw = readFileSync(join(dir, "sw.js"), "utf-8");
  assert.doesNotMatch(sw, /importScripts\s*\(/);
  // The whole call (including the outer paren) must be gone — no orphan ")".
  assert.match(sw, /e\[t\]\|\|void 0 \/\* importScripts hoisted[^*]*\*\/\};/);
  // And the result must actually parse.
  assert.doesNotThrow(() => new Function(sw), "neutralized SW must be syntactically valid");
  rmSync(dir, { recursive: true, force: true });
});

// Regression: manifest.name is raw — may contain "<", "&", or "</title>". It is
// interpolated into the background page's <title>, so it must be HTML-escaped or a
// stray "</title><script>" breaks out and corrupts the page.
test("background page escapes < & > in the manifest name title", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-title-"));
  writeFileSync(join(dir, "sw.js"), "// sw");
  const manifest = { name: "Save </title><script>x</script> & co", background: { service_worker: "sw.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  assert.ok(!html.includes("</title><script>x"), "raw markup must not survive into the page");
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
  assert.match(html, /&amp; co/);
});
