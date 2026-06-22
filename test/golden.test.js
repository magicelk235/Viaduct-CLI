import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeManifest, transformManifest } from "../dist/manifest/manifest.js";
import { scanExtension } from "../dist/analyze/analyze.js";

// Run a real manifest through the analyze → transform pipeline against an
// on-disk extension dir (so popup auto-wiring and any path probing behave as
// they do in a real conversion), then assert the Safari-ready shape.
function pipeline(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-golden-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
    const { permissionsToRemove } = analyzeManifest(manifest);
    const out = transformManifest(manifest, permissionsToRemove, dir, { keepModuleBackground: false });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("golden: MV2 background page becomes non-persistent", () => {
  const out = pipeline({
    manifest_version: 2,
    name: "Legacy",
    version: "3.1",
    background: { scripts: ["bg.js"], persistent: true },
    browser_action: { default_popup: "popup.html" },
    permissions: ["storage", "webRequestBlocking"],
  });
  assert.equal(out.background.persistent, false);
  // webRequestBlocking is unsupported → removed; storage stays.
  assert.deepEqual(out.permissions, ["storage"]);
  // MV2 keeps browser_action (injecting `action` would make Safari reject it).
  assert.equal(out.browser_action.default_popup, "popup.html");
  assert.equal(out.browser_specific_settings.safari.strict_min_version, "15.4");
});

test("golden: MV3 service worker manifest with side panel + DNR", () => {
  const out = pipeline({
    manifest_version: 3,
    name: "Modern",
    version: "1.4.2",
    background: { service_worker: "sw.js", type: "module" },
    action: { default_popup: "popup.html" },
    side_panel: { default_path: "panel.html" },
    permissions: ["storage", "sidePanel", "tabGroups", "scripting"],
    host_permissions: ["https://*/*"],
    declarative_net_request: {
      rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }],
    },
    content_security_policy: { extension_pages: "script-src 'self'" },
  });
  // background.type:module stripped (silent popup failure cause).
  assert.equal(out.background.type, undefined);
  assert.equal(out.background.service_worker, "sw.js");
  // Safari-unsupported permissions removed; functional ones kept.
  assert.ok(!out.permissions.includes("sidePanel"));
  assert.ok(!out.permissions.includes("tabGroups"));
  assert.ok(out.permissions.includes("storage"));
  assert.ok(out.permissions.includes("scripting"));
  // host_permissions preserved untouched.
  assert.deepEqual(out.host_permissions, ["https://*/*"]);
  // Chrome-only keys gone.
  assert.equal(out.update_url, undefined);
  assert.equal(out.key, undefined);
  assert.equal(out.browser_specific_settings.safari.strict_min_version, "15.4");
});

test("golden: MV2 web_accessible_resources string[] is wrapped for MV3-style Safari", () => {
  const out = pipeline({
    manifest_version: 3,
    name: "WAR",
    version: "1.0.0",
    web_accessible_resources: ["inject.js", "style.css"],
  });
  assert.deepEqual(out.web_accessible_resources, [
    { resources: ["inject.js", "style.css"], matches: ["<all_urls>"] },
  ]);
});

test("golden: a popup ref with a #fragment is not reported as a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-golden-"));
  try {
    // The concrete file is devpanel.html; the manifest points at "#popup" within it.
    writeFileSync(join(dir, "devpanel.html"), "<!doctype html>");
    const manifest = {
      manifest_version: 3,
      name: "Fragment",
      version: "1.0.0",
      action: { default_popup: "devpanel.html#popup" },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    // The missing-file check lives in scanExtension (it takes the extPath).
    const all = scanExtension(dir, manifest, "macos");
    const missing = all.filter(
      (i) => i.severity === "error" && /missing from the package/.test(i.message)
    );
    assert.equal(missing.length, 0, JSON.stringify(missing, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("golden: a clean MV3 extension passes analyze with no blocking errors", () => {
  const manifest = {
    manifest_version: 3,
    name: "Clean",
    version: "2.0.0",
    action: { default_popup: "popup.html" },
    background: { service_worker: "sw.js" },
    permissions: ["storage", "tabs", "scripting"],
    content_scripts: [{ matches: ["https://*.example.com/*"], js: ["cs.js"] }],
  };
  const { issues } = analyzeManifest(manifest);
  const errors = issues.filter((i) => i.severity === "error" && !i.autoFixed);
  assert.equal(errors.length, 0, JSON.stringify(errors, null, 2));
});
