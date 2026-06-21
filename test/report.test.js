import { test } from "node:test";
import assert from "node:assert/strict";
import { countBlocking, summarizeManifestChanges, buildReportMarkdown } from "../dist/report.js";

const err = { severity: "error", category: "x", message: "e" };
const warn = { severity: "warning", category: "x", message: "w" };
const info = { severity: "info", category: "x", message: "i" };
const autoFixedErr = { severity: "error", category: "x", message: "e", autoFixed: true };

test("countBlocking counts unfixed errors only by default", () => {
  assert.equal(countBlocking([err, warn, info]), 1);
});

test("countBlocking excludes auto-fixed errors", () => {
  assert.equal(countBlocking([err, autoFixedErr]), 1);
});

test("countBlocking treats warnings as blocking in strict mode", () => {
  assert.equal(countBlocking([err, warn, info], true), 2);
});

test("countBlocking never counts info, even in strict mode", () => {
  assert.equal(countBlocking([info, info], true), 0);
});

test("countBlocking returns 0 for an empty list", () => {
  assert.equal(countBlocking([]), 0);
});

test("summarizeManifestChanges reports dropped Chrome-only keys and Safari settings", () => {
  const before = { update_url: "https://x", key: "abc", version: "1.2.3" };
  const after = {
    version: "1.2.3",
    browser_specific_settings: { safari: { strict_min_version: "15.4" } },
  };
  const changes = summarizeManifestChanges(before, after);
  assert.ok(changes.some((c) => c.includes("update_url")));
  assert.ok(changes.some((c) => c.includes("key")));
  assert.ok(changes.some((c) => c.includes("strict_min_version")));
});

test("summarizeManifestChanges detects removed permissions and folded page_action", () => {
  const before = { permissions: ["tabs", "gcm"], page_action: { default_popup: "p.html" } };
  const after = { permissions: ["tabs"], action: { default_popup: "p.html" } };
  const changes = summarizeManifestChanges(before, after);
  assert.ok(changes.some((c) => c.includes("`gcm`")));
  assert.ok(changes.some((c) => c.includes("page_action")));
});

test("summarizeManifestChanges returns nothing when nothing changed", () => {
  const m = { version: "1.0", permissions: ["tabs"] };
  assert.deepEqual(summarizeManifestChanges(m, m), []);
});

test("buildReportMarkdown includes a Manifest changes section when provided", () => {
  const md = buildReportMarkdown(
    { name: "X", manifestVersion: 3, platforms: "macos", manifestChanges: ["Dropped `key`."] },
    []
  );
  assert.match(md, /## Manifest changes \(1\)/);
  assert.match(md, /Dropped `key`\./);
});
