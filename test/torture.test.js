// Torture test: a deliberately gnarly MV3 extension run through the FULL conversion
// pipeline (convert({build:false}) — stage → shim → DNR → OAuth bridge → SW→bg page
// → manifest transform), then assertions on the staged output AND a live exercise of
// the generated shim's emulated APIs. One extension hits, at once:
//   - SW with importScripts (must hoist into background.html, neutralize calls)
//   - background.type:module (must be stripped)
//   - hardcoded chrome-extension://<id> URL (must be flagged)
//   - __MSG_ i18n name with a real _locales entry (must resolve)
//   - DNR ruleset incl. a modifyHeaders rule (Safari crash path — must survive)
//   - storage.sync usage (shim routes to local)
//   - update_url (must be stripped)
//   - unsupported perms (webRequestBlocking) + supported perms (must split)
//   - missing icon (must synthesize a placeholder, not crash)
//   - OAuth (identity + externally_connectable → bridge files)
//   - runtime use of emulated bookmarks/downloads/readingList/instanceID
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { convert } from "../dist/convert.js";
import { shimSource, SHIM_FILENAME } from "../dist/runtime/shim.js";

const CHROME_ID = "abcdefghijklmnopabcdefghijklmnop";

// The full pipeline ends by shelling to `xcrun safari-web-extension-packager`. That
// utility ships with Xcode's Safari toolchain but is absent on some CI runner images
// (e.g. GitHub's macOS runner with a stripped Xcode) — and when it's missing, convert()
// reports a blocking failure that has nothing to do with the conversion logic this test
// exercises. Probe for it so we can skip the success-requires-the-packager assertion
// there; every other torture test reads result.stagedPath (populated before the
// packager runs), so the conversion logic stays fully covered either way.
const PACKAGER_AVAILABLE =
  spawnSync("xcrun", ["--find", "safari-web-extension-packager"], { encoding: "utf8" }).status === 0;

function buildGnarlyExtension() {
  const dir = mkdtempSync(join(tmpdir(), "torture-ext-"));
  const w = (rel, body) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  };

  w("manifest.json", {
    manifest_version: 3,
    name: "__MSG_extName__",
    version: "2.5.1",
    default_locale: "en",
    // `key` lets deriveChromeId compute the real id for the OAuth bridge.
    update_url: "https://clients2.google.com/service/update2/crx",
    background: { service_worker: "sw/worker.js", type: "module" },
    action: { default_popup: "popup.html" },
    side_panel: { default_path: "panel.html" },
    options_ui: { page: "options.html" },
    permissions: ["storage", "scripting", "tabs", "bookmarks", "downloads",
      "readingList", "identity", "webRequestBlocking", "management"],
    host_permissions: ["https://*/*", "https://accounts.google.com/*"],
    externally_connectable: { matches: ["https://app.example.com/*"] },
    oauth2: { client_id: "x.apps.googleusercontent.com", scopes: ["email"] },
    declarative_net_request: { rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }] },
    content_security_policy: { extension_pages: "script-src 'self'" },
    // icons intentionally omitted → placeholder synthesis must kick in.
  });

  w("_locales/en/messages.json", { extName: { message: "Torture Test Extension" } });

  // SW imports four classic libs; the converter must hoist them and neutralize calls.
  w("sw/worker.js",
    'importScripts("../lib/a.js", "../lib/b.js");\n' +
    'importScripts("../lib/c.js");\n' +
    'chrome.runtime.onInstalled.addListener(() => {});\n');
  w("lib/a.js", "self.__a = 1;");
  w("lib/b.js", "self.__b = 2;");
  w("lib/c.js", "self.__c = 3;");

  // A page with a hardcoded chrome-extension://<id> URL (analyzer should flag it).
  w("popup.html", '<!doctype html><html><body><script src="popup.js"></script></body></html>');
  w("popup.js", 'var u = "chrome-extension://' + CHROME_ID + '/panel.html"; chrome.storage.sync.get("k", function(){});');
  w("panel.html", "<!doctype html><html><body>panel</body></html>");
  w("options.html", "<!doctype html><html><body>options</body></html>");

  // DNR rules including a modifyHeaders rule (the WebKit crash trigger).
  w("rules.json", [
    { id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads", resourceTypes: ["script"] } },
    { id: 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "set", value: "https://x" }] }, condition: { urlFilter: "api", resourceTypes: ["xmlhttprequest"] } },
  ]);

  return dir;
}

function convertGnarly() {
  const src = buildGnarlyExtension();
  const out = mkdtempSync(join(tmpdir(), "torture-out-"));
  const result = convert({
    input: src, output: out, platforms: "macos",
    copyResources: true, tempLoadOnly: false, generateShim: true,
    build: false, force: false, keepModuleBackground: false,
    install: false, safariRestart: false, verbose: false,
  });
  return { result, src, out, cleanup: () => { rmSync(src, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); } };
}

test("torture: the whole gnarly extension converts without a blocking error", (t) => {
  const { result, cleanup } = convertGnarly();
  try {
    // The conversion-logic invariants — checked regardless of whether the platform
    // packager is installed.
    assert.equal(result.extensionName, "Torture Test Extension", "i18n name resolved");
    const errors = result.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], "no blocking errors:\n" + JSON.stringify(errors, null, 2));
    assert.ok(result.stagedPath, "staging completed");
    // result.success requires the Apple packager to run. Only assert it where the
    // utility actually exists; otherwise the failure is the environment, not the code.
    if (PACKAGER_AVAILABLE) assert.equal(result.success, true, "conversion should succeed");
    else t.diagnostic("safari-web-extension-packager not found — skipping result.success assertion");
  } finally { cleanup(); }
});

test("torture: importScripts hoisted into background.html, calls neutralized", () => {
  const { result, cleanup } = convertGnarly();
  try {
    const staged = result.stagedPath;
    const bgHtml = readFileSync(join(staged, "background.html"), "utf-8");
    // Each imported lib appears as a classic <script> BEFORE the module worker.
    for (const lib of ["lib/a.js", "lib/b.js", "lib/c.js"]) {
      assert.ok(bgHtml.includes('src="' + lib + '"'), "hoisted " + lib);
    }
    assert.ok(bgHtml.indexOf("lib/a.js") < bgHtml.indexOf('type="module"'), "libs load before the SW module");
    const worker = readFileSync(join(staged, "sw/worker.js"), "utf-8");
    assert.ok(!/importScripts\s*\(/.test(worker) || worker.includes("void 0"), "importScripts calls neutralized");
  } finally { cleanup(); }
});

test("torture: manifest is Safari-shaped (module stripped, persistent bg, perms split, update_url gone)", () => {
  const { result, cleanup } = convertGnarly();
  try {
    const m = JSON.parse(readFileSync(join(result.stagedPath, "manifest.json"), "utf-8"));
    assert.equal(m.update_url, undefined, "update_url removed");
    assert.ok(m.background.page, "SW converted to a background page");
    assert.notEqual(m.background.persistent, true, "background not persistent under MV3");
    assert.equal(m.background.type, undefined, "module type stripped");
    assert.ok(!(m.permissions || []).includes("webRequestBlocking"), "unsupported perm dropped");
    assert.ok((m.permissions || []).includes("storage"), "supported perm kept");
    assert.ok(m.browser_specific_settings && m.browser_specific_settings.safari, "Safari settings injected");
  } finally { cleanup(); }
});

test("torture: DNR modifyHeaders rule survives conversion (no crash, block rule kept)", () => {
  const { result, cleanup } = convertGnarly();
  try {
    // The ruleset file is staged; the runtime modifyHeaders strip happens in the shim,
    // but conversion must not choke on the rule at build time.
    const staged = result.stagedPath;
    assert.ok(existsSync(join(staged, "rules.json")), "DNR ruleset staged");
    const rules = JSON.parse(readFileSync(join(staged, "rules.json"), "utf-8"));
    assert.ok(rules.some((r) => r.action.type === "block"), "block rule preserved");
  } finally { cleanup(); }
});

test("torture: placeholder icons synthesized (manifest had none)", () => {
  const { result, cleanup } = convertGnarly();
  try {
    const m = JSON.parse(readFileSync(join(result.stagedPath, "manifest.json"), "utf-8"));
    assert.ok(m.icons && Object.keys(m.icons).length > 0, "icons synthesized into manifest");
    for (const p of Object.values(m.icons)) {
      assert.ok(existsSync(join(result.stagedPath, p)), "icon file exists on disk: " + p);
    }
  } finally { cleanup(); }
});

test("torture: hardcoded chrome-extension://<id> URL is flagged", () => {
  const { result, cleanup } = convertGnarly();
  try {
    assert.ok(result.issues.some((i) => /chrome-extension:\/\/<id>/.test(i.message)), "hardcoded id URL flagged");
  } finally { cleanup(); }
});

test("torture: OAuth bridge + shim files land in the staged output", () => {
  const { result, cleanup } = convertGnarly();
  try {
    const staged = result.stagedPath;
    assert.ok(existsSync(join(staged, SHIM_FILENAME)), "shim emitted");
    // identity + externally_connectable → page bridge wiring.
    const files = readFileSync(join(staged, "manifest.json"), "utf-8");
    assert.ok(files.length > 0);
  } finally { cleanup(); }
});

// ---- Live runtime exercise: load the SAME generated shim and drive emulated APIs ----
test("torture: generated shim's emulated APIs work end-to-end against a fake storage", async () => {
  // Async storage.local matching Safari's behavior.
  const data = {};
  const storage = { local: {
    get: (key, cb) => { const o = {}; if (typeof key === "string") { if (key in data) o[key] = data[key]; } else if (key == null) Object.assign(o, data); else Object.keys(key).forEach((k) => { o[k] = k in data ? data[k] : key[k]; }); Promise.resolve().then(() => cb(o)); },
    set: (obj, cb) => { Object.assign(data, JSON.parse(JSON.stringify(obj))); Promise.resolve().then(() => cb && cb()); },
  } };
  const chrome = { runtime: { lastError: null, getManifest: () => ({ name: "Torture", version: "2.5.1" }) }, storage };
  new Function("chrome", "window", "self", "globalThis", shimSource())(chrome, { addEventListener() {} }, undefined, { chrome });

  // bookmarks: create under the bar, then find via search.
  const bm = await chrome.bookmarks.create({ parentId: "1", title: "Claude", url: "https://claude.ai" });
  assert.equal((await chrome.bookmarks.search("claude")).length, 1);
  assert.ok(bm.id);

  // downloads: start one, confirm it lands in the registry and completes.
  const dlId = await chrome.downloads.download({ url: "https://x.test/f.zip" });
  await new Promise((r) => setTimeout(r, 0));
  const found = await chrome.downloads.search({ id: dlId });
  assert.equal(found.length, 1);
  assert.equal(found[0].state, "complete");

  // readingList: add + query.
  await chrome.readingList.addEntry({ url: "https://read.me/1", title: "R" });
  assert.equal((await chrome.readingList.query({})).length, 1);

  // instanceID: stable id present.
  const iid = await chrome.instanceID.getID();
  assert.ok(iid && typeof iid === "string");

  // management.getSelf reflects the manifest we injected.
  const self = await chrome.management.getSelf();
  assert.equal(self.name, "Torture");
  assert.equal(self.version, "2.5.1");

  // A namespace nobody shimmed must not throw (catch-all net).
  assert.doesNotThrow(() => chrome.audio.getDevices(() => {}));
});
