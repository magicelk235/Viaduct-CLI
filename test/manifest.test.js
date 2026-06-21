import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonc,
  matchPatternError,
  analyzeCommands,
  analyzeManifest,
  transformManifest,
  collectReferencedPaths,
} from "../dist/manifest.js";

// transformManifest probes extPath for popup candidates; a path that doesn't
// exist simply yields no auto-wired popup, which is fine for these unit tests.
const NO_EXT = "/nonexistent-extension-dir";
const XF = { keepModuleBackground: false };

test("parseJsonc strips line and block comments", () => {
  const out = parseJsonc('{\n  // a comment\n  "a": 1, /* inline */ "b": 2\n}');
  assert.deepEqual(out, { a: 1, b: 2 });
});

test("parseJsonc drops trailing commas in objects and arrays", () => {
  assert.deepEqual(parseJsonc('{ "a": [1, 2, 3,], }'), { a: [1, 2, 3] });
});

test("parseJsonc does NOT touch // inside string literals (urls)", () => {
  const out = parseJsonc('{ "url": "https://example.com/x" }');
  assert.deepEqual(out, { url: "https://example.com/x" });
});

test("parseJsonc preserves commas inside strings", () => {
  assert.deepEqual(parseJsonc('{ "s": "a,b,c" }'), { s: "a,b,c" });
});

test("matchPatternError accepts valid patterns", () => {
  assert.equal(matchPatternError("<all_urls>"), null);
  assert.equal(matchPatternError("https://*.example.com/*"), null);
  assert.equal(matchPatternError("*://*/*"), null);
  assert.equal(matchPatternError("file:///Users/*"), null);
  assert.equal(matchPatternError("file://*/*"), null, "wildcard-host file pattern");
  assert.equal(matchPatternError("file://*/*.png"), null, "wildcard-host file pattern with ext");
});

test("matchPatternError rejects malformed patterns", () => {
  assert.ok(matchPatternError("example.com/*"), "missing scheme");
  assert.ok(matchPatternError("ws://example.com/*"), "unsupported scheme");
  assert.ok(matchPatternError("https://example.com"), "missing path");
  assert.ok(matchPatternError("https://*.*.com/*"), "illegal interior wildcard");
});

test("analyzeCommands flags a chord with no primary modifier", () => {
  const issues = analyzeCommands({ foo: { suggested_key: { default: "Shift+Y" } } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warning");
  assert.match(issues[0].message, /lacks a Ctrl\/Command\/Alt modifier/);
});

test("analyzeCommands accepts a valid chord", () => {
  const issues = analyzeCommands({ foo: { suggested_key: { default: "Command+Shift+Y" } } });
  assert.equal(issues.length, 0);
});

test("analyzeCommands flags ChromeOS-only Search modifier", () => {
  const issues = analyzeCommands({ foo: { suggested_key: { default: "Search+Ctrl+Y" } } });
  assert.ok(issues.some((i) => /Search/.test(i.message)));
});

test("analyzeCommands ignores commands with no suggested_key", () => {
  assert.deepEqual(analyzeCommands({ foo: {} }), []);
});

test("analyzeManifest marks unsupported permissions for removal", () => {
  const { permissionsToRemove } = analyzeManifest({
    manifest_version: 3,
    permissions: ["storage", "tabGroups", "offscreen", "tabs"],
  });
  assert.ok(permissionsToRemove.includes("tabGroups"));
  assert.ok(permissionsToRemove.includes("offscreen"));
  assert.ok(!permissionsToRemove.includes("storage"));
  assert.ok(!permissionsToRemove.includes("tabs"));
});

test("analyzeManifest tags shim-backed removed permissions as shimmed", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    permissions: ["tabGroups", "offscreen"],
  });
  const tabGroups = issues.find((i) => i.category === "permission" && i.message.includes('"tabGroups"'));
  const offscreen = issues.find((i) => i.category === "permission" && i.message.includes('"offscreen"'));
  assert.equal(tabGroups?.shimmed, true);
  assert.ok(offscreen && !offscreen.shimmed);
});

test("analyzeManifest errors on an invalid content-script match pattern", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    content_scripts: [{ matches: ["not-a-pattern"], js: ["cs.js"] }],
  });
  assert.ok(issues.some((i) => i.severity === "error" && /Invalid match pattern/.test(i.message)));
});

test("transformManifest strips Chrome-only keys", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0", update_url: "https://x", key: "abc", minimum_chrome_version: "120", version_name: "v1" },
    [],
    NO_EXT,
    XF
  );
  assert.equal(out.update_url, undefined);
  assert.equal(out.key, undefined);
  assert.equal(out.minimum_chrome_version, undefined);
  assert.equal(out.version_name, undefined);
});

test("transformManifest stops at the first non-numeric version component", () => {
  // "3beta" is the first non-numeric part, so only the leading 1.2 survives.
  const out = transformManifest({ manifest_version: 3, version: "1.2.3beta.4" }, [], NO_EXT, XF);
  assert.equal(out.version, "1.2");
});

test("transformManifest keeps a clean dotted numeric version unchanged", () => {
  const out = transformManifest({ manifest_version: 3, version: "2.5.1" }, [], NO_EXT, XF);
  assert.equal(out.version, "2.5.1");
});

test("transformManifest clamps version components to 65535 and caps at 3 parts", () => {
  const out = transformManifest({ manifest_version: 3, version: "70000.1.2.3" }, [], NO_EXT, XF);
  assert.equal(out.version, "65535.1.2");
});

test("transformManifest falls back to 1.0.0 for an unusable version", () => {
  const out = transformManifest({ manifest_version: 3, version: "beta" }, [], NO_EXT, XF);
  assert.equal(out.version, "1.0.0");
});

test("transformManifest forces persistent:false on an MV2 background", () => {
  const out = transformManifest(
    { manifest_version: 2, version: "1.0.0", background: { scripts: ["bg.js"], persistent: true } },
    [],
    NO_EXT,
    XF
  );
  assert.equal(out.background.persistent, false);
});

test("transformManifest strips background.type:module on MV3 by default", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", background: { service_worker: "sw.js", type: "module" } },
    [],
    NO_EXT,
    XF
  );
  assert.equal(out.background.type, undefined);
});

test("transformManifest keeps background.type:module when asked", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", background: { service_worker: "sw.js", type: "module" } },
    [],
    NO_EXT,
    { keepModuleBackground: true }
  );
  assert.equal(out.background.type, "module");
});

test("transformManifest removes flagged permissions", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", permissions: ["storage", "tabGroups"] },
    ["tabGroups"],
    NO_EXT,
    XF
  );
  assert.deepEqual(out.permissions, ["storage"]);
});

test("transformManifest wraps an MV3 string CSP into the object form", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", content_security_policy: "script-src 'self'" },
    [],
    NO_EXT,
    XF
  );
  assert.deepEqual(out.content_security_policy, { extension_pages: "script-src 'self'" });
});

test("transformManifest wraps a bare MV3 web_accessible_resources string array", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", web_accessible_resources: ["img.png", "x.js"] },
    [],
    NO_EXT,
    XF
  );
  assert.deepEqual(out.web_accessible_resources, [
    { resources: ["img.png", "x.js"], matches: ["<all_urls>"] },
  ]);
});

test("transformManifest injects browser_specific_settings.safari with the min version", () => {
  const out = transformManifest({ manifest_version: 3, version: "1.0.0" }, [], NO_EXT, {
    keepModuleBackground: false,
    minSafariVersion: "18.4",
  });
  assert.equal(out.browser_specific_settings.safari.strict_min_version, "18.4");
});

test("transformManifest defaults the safari min version to 15.4", () => {
  const out = transformManifest({ manifest_version: 3, version: "1.0.0" }, [], NO_EXT, XF);
  assert.equal(out.browser_specific_settings.safari.strict_min_version, "15.4");
});

test("transformManifest folds MV2 page_action into browser_action (not action — Safari rejects MV2 action)", () => {
  const out = transformManifest(
    { manifest_version: 2, version: "1.0.0", page_action: { default_title: "x" } },
    [],
    NO_EXT,
    XF
  );
  assert.equal(out.page_action, undefined);
  // MV2 must use browser_action; an `action` key on an MV2 manifest fails Safari's load.
  assert.equal(out.action, undefined);
  assert.equal(out.browser_action.default_title, "x");
});

test("transformManifest folds MV3 page_action into action", () => {
  const out = transformManifest(
    { manifest_version: 3, version: "1.0.0", page_action: { default_title: "x" } },
    [],
    NO_EXT,
    XF
  );
  assert.equal(out.page_action, undefined);
  assert.equal(out.action.default_title, "x");
});

test("collectReferencedPaths strips #fragment and ?query from page refs", () => {
  const paths = collectReferencedPaths({
    manifest_version: 3,
    action: { default_popup: "devpanel.html#popup" },
    options_page: "options.html?tab=general",
  });
  assert.ok(paths.has("devpanel.html"), [...paths].join(","));
  assert.ok(paths.has("options.html"), [...paths].join(","));
  assert.ok(!paths.has("devpanel.html#popup"));
});

test("transformManifest does not mutate the input manifest", () => {
  const input = { manifest_version: 3, version: "1.0", update_url: "https://x" };
  transformManifest(input, [], NO_EXT, XF);
  assert.equal(input.update_url, "https://x");
  assert.equal(input.version, "1.0");
});

const remoteScriptIssues = (csp) =>
  analyzeManifest({ manifest_version: 3, version: "1.0.0", content_security_policy: csp })
    .issues.filter((i) => /remote origin/.test(i.message));

test("analyzeManifest flags a remote script-src origin in CSP", () => {
  const issues = remoteScriptIssues({ extension_pages: "script-src 'self' https://cdn.example.com" });
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes("https://cdn.example.com"));
});

test("analyzeManifest does NOT flag self/keyword-only CSP as remote", () => {
  assert.equal(remoteScriptIssues({ extension_pages: "script-src 'self' 'wasm-unsafe-eval'" }).length, 0);
  // bare-string MV2-form CSP maps to extension_pages; 'self' alone is clean.
  assert.equal(remoteScriptIssues("script-src 'self'").length, 0);
});

test("analyzeManifest flags a bare-hostname script-src origin (no scheme)", () => {
  const issues = remoteScriptIssues({ extension_pages: "script-src 'self' cdn.example.com" });
  assert.equal(issues.length, 1);
});

test("analyzeManifest flags a host match pattern misplaced in MV3 permissions", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    version: "1.0.0",
    permissions: ["https://api.foo.com/*", "storage"],
  });
  const misplaced = issues.filter((i) => /ignored and grants no host access/.test(i.message));
  assert.equal(misplaced.length, 1);
  assert.ok(misplaced[0].message.includes("https://api.foo.com/*"));
});

test("analyzeManifest does not flag a real host_permissions entry as misplaced", () => {
  const { issues } = analyzeManifest({
    manifest_version: 3,
    version: "1.0.0",
    host_permissions: ["https://api.foo.com/*"],
  });
  assert.equal(issues.filter((i) => /ignored and grants no host access/.test(i.message)).length, 0);
});
