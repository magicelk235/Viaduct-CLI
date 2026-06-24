import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanExtension } from "../dist/analyze/analyze.js";

// Build a throwaway extension dir from a {relpath: contents} map. Contents that
// are objects are JSON-stringified (manifest-style messages.json etc.).
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "scan-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}
const has = (issues, re) => issues.some((i) => re.test(i.message));

test("scanExtension flags an unsupported chrome.* API in source", () => {
  const dir = fixture({ "bg.js": "chrome.identity.launchWebAuthFlow({});" });
  const issues = scanExtension(dir, { manifest_version: 3, background: { service_worker: "bg.js" } }, "macos");
  assert.ok(has(issues, /launchWebAuthFlow is unsupported/));
});

test("scanExtension tags shim-backed APIs as shimmed, not truly-unsupported ones", () => {
  const dir = fixture({ "bg.js": "chrome.identity.getAuthToken({}); chrome.tabCapture.capture({});" });
  const issues = scanExtension(dir, { manifest_version: 3, background: { service_worker: "bg.js" } }, "macos");
  const identity = issues.find((i) => /chrome\.identity is unsupported/.test(i.message));
  const capture = issues.find((i) => /tabCapture is unsupported/.test(i.message));
  assert.equal(identity?.shimmed, true);
  assert.ok(capture && !capture.shimmed);
});

test("scanExtension flags a hardcoded chrome-extension://<id> URL", () => {
  const dir = fixture({ "x.js": 'var u = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html";' });
  const issues = scanExtension(dir, { manifest_version: 3 }, "macos");
  assert.ok(has(issues, /Hardcoded chrome-extension:\/\/<id>/));
});

test("scanExtension errors on a manifest-referenced file missing from disk", () => {
  const dir = fixture({ "present.js": "// here" });
  const m = { manifest_version: 3, content_scripts: [{ js: ["gone.js"], matches: ["https://x.com/*"] }] };
  const issues = scanExtension(dir, m, "macos");
  assert.ok(has(issues, /references "gone\.js", which is missing/));
});

test("scanExtension errors on a declared icon missing from disk", () => {
  const dir = fixture({ "manifest.json": { manifest_version: 3 } });
  const issues = scanExtension(dir, { manifest_version: 3, icons: { 48: "icon.png" } }, "macos");
  assert.ok(has(issues, /Declared icon "icon\.png" is missing/));
});

test("scanExtension errors on an unresolved __MSG_ name placeholder", () => {
  const dir = fixture({ "_locales/en/messages.json": { extName: { message: "Real" } } });
  const m = { manifest_version: 3, default_locale: "en", name: "__MSG_missingKey__" };
  const issues = scanExtension(dir, m, "macos");
  assert.ok(has(issues, /manifest\.name uses "__MSG_missingKey__"/));
});

test("scanExtension errors when _locales exists but default_locale is absent", () => {
  const dir = fixture({ "_locales/en/messages.json": { k: { message: "v" } } });
  const issues = scanExtension(dir, { manifest_version: 3 }, "macos");
  assert.ok(has(issues, /_locales\/ is present but default_locale is missing/));
});

test("scanExtension flags a hardcoded chrome://extensions/shortcuts link", () => {
  const dir = fixture({ "opt.js": 'a.href = "chrome://extensions/shortcuts";' });
  const issues = scanExtension(dir, { manifest_version: 3 }, "macos");
  assert.ok(has(issues, /has no Safari equivalent.*chrome/i));
});

test("scanExtension does not flag chrome.action / chrome.runtime as a chrome:// link", () => {
  const dir = fixture({ "bg.js": "chrome.action.setBadgeText({}); chrome.runtime.getURL('x');" });
  const issues = scanExtension(dir, { manifest_version: 3 }, "macos");
  assert.equal(issues.filter((i) => /no Safari equivalent.*chrome:\/\//.test(i.message)).length, 0);
});

test("scanExtension treats importScripts() with string literals as auto-fixed info, not a blocking error", () => {
  const dir = fixture({ "bg.js": 'importScripts("lib/a.js", "lib/b.js");' });
  const issues = scanExtension(dir, { manifest_version: 3, background: { service_worker: "bg.js" } }, "macos");
  const m = issues.find((i) => /importScripts/.test(i.message));
  assert.ok(m, "expected an importScripts issue");
  assert.equal(m.severity, "info");
});

test("scanExtension warns on importScripts() with a dynamic argument (can't hoist)", () => {
  const dir = fixture({ "bg.js": "importScripts(libPath);" });
  const issues = scanExtension(dir, { manifest_version: 3, background: { service_worker: "bg.js" } }, "macos");
  const m = issues.find((i) => /importScripts/.test(i.message));
  assert.ok(m, "expected an importScripts issue");
  assert.equal(m.severity, "warning");
});

test("scanExtension warns on importScripts() whose arg contains a quote but isn't a bare literal (getURL/concat can't hoist)", () => {
  // The old check classified any arg containing a quote as a hoistable static
  // literal, falsely reassuring on importScripts(getURL("x.js")) / base + "a.js".
  for (const arg of ['chrome.runtime.getURL("lib.js")', '"./" + name', 'base + "a.js"']) {
    const dir = fixture({ "bg.js": `importScripts(${arg});` });
    const issues = scanExtension(dir, { manifest_version: 3, background: { service_worker: "bg.js" } }, "macos");
    const m = issues.find((i) => /importScripts/.test(i.message));
    assert.ok(m, `expected an importScripts issue for ${arg}`);
    assert.equal(m.severity, "warning", `dynamic importScripts(${arg}) must warn, not info`);
  }
});

test("scanExtension warns (not fatal) on blocking webRequest so the extension still converts", () => {
  // Bitwarden/LastPass/Honey/uBlock all use blocking webRequest. Safari ignores
  // the blocking return but the extension loads and works — so this must NOT be a
  // blocking error, or every ad-blocker/password-manager fails to convert.
  const dir = fixture({
    "bg.js": 'chrome.webRequest.onBeforeRequest.addListener(fn, {urls:["<all_urls>"]}, ["blocking"]);',
  });
  const issues = scanExtension(dir, { manifest_version: 3 }, "macos");
  const m = issues.find((i) => /blocking webRequest/i.test(i.message));
  assert.ok(m, "expected a blocking-webRequest issue");
  assert.equal(m.severity, "warning");
});

test("scanExtension stays quiet on a clean extension (no false positives)", () => {
  const dir = fixture({
    "icon.png": "PNG",
    "bg.js": "chrome.runtime.onMessage.addListener(function(){});",
    "cs.js": "console.log('content');",
  });
  const m = {
    manifest_version: 3,
    icons: { 48: "icon.png" },
    background: { service_worker: "bg.js" },
    content_scripts: [{ js: ["cs.js"], matches: ["https://x.com/*"] }],
  };
  const issues = scanExtension(dir, m, "macos");
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2));
});
