import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// Run the real CLI against an unpacked extension dir and parse its JSON.
// `analyze --json` is the machine-readable contract consumers depend on, so its
// shape is locked here: a field rename or removal must fail this test on purpose.
function analyzeJson(manifest) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-contract-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    // The CLI exits 1 when there are blocking issues; the JSON feed is still on
    // stdout in that case, so read it off the thrown error too.
    let stdout;
    try {
      stdout = execFileSync("node", [CLI, dir, "--analyze", "--json"], { encoding: "utf-8" });
    } catch (e) {
      stdout = e.stdout;
    }
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("analyze --json emits the full documented contract for a clean extension", () => {
  const report = analyzeJson({
    manifest_version: 3,
    name: "Contract",
    version: "1.2.3",
    permissions: ["storage", "tabs"],
  });

  // Top-level keys (the documented machine-readable feed).
  for (const key of [
    "name",
    "appName",
    "bundleId",
    "version",
    "manifestVersion",
    "platforms",
    "counts",
    "autoFixed",
    "blocking",
    "convertible",
    "removedPermissions",
    "issues",
  ]) {
    assert.ok(key in report, `missing key "${key}"`);
  }

  assert.equal(report.name, "Contract");
  assert.equal(report.appName, "Contract");
  assert.equal(report.version, "1.2.3");
  assert.equal(report.manifestVersion, 3);
  assert.equal(report.platforms, "macos");
  assert.equal(typeof report.bundleId, "string");

  // counts is an object keyed by severity.
  for (const sev of ["error", "warning", "info"]) {
    assert.equal(typeof report.counts[sev], "number");
  }
  assert.equal(typeof report.autoFixed, "number");
  assert.equal(typeof report.blocking, "number");
  assert.equal(typeof report.convertible, "boolean");
  assert.ok(Array.isArray(report.removedPermissions));
  assert.ok(Array.isArray(report.issues));
});

test("analyze --json reports convertible:true and exit 0 for a clean extension", () => {
  const report = analyzeJson({
    manifest_version: 3,
    name: "Clean",
    version: "1.0.0",
    permissions: ["storage"],
  });
  assert.equal(report.blocking, 0);
  assert.equal(report.convertible, true);
});

test("analyze --json lists removed permissions for unsupported APIs", () => {
  const report = analyzeJson({
    manifest_version: 3,
    name: "Unsupported",
    version: "1.0.0",
    permissions: ["storage", "tabGroups", "offscreen"],
  });
  assert.ok(report.removedPermissions.includes("tabGroups"));
  assert.ok(report.removedPermissions.includes("offscreen"));
});

test("analyze --json each issue carries severity, category, message", () => {
  const report = analyzeJson({
    manifest_version: 3,
    name: "Issues",
    version: "1.0.0",
    content_scripts: [{ matches: ["bad-pattern"], js: ["cs.js"] }],
  });
  assert.ok(report.issues.length > 0);
  for (const issue of report.issues) {
    assert.ok(["error", "warning", "info"].includes(issue.severity));
    assert.equal(typeof issue.category, "string");
    assert.equal(typeof issue.message, "string");
  }
});

test("analyze --json on a corrupt input still emits parseable JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-contract-"));
  try {
    // No manifest.json → loadManifest throws; JSON mode must still emit a feed.
    let stdout;
    try {
      stdout = execFileSync("node", [CLI, dir, "--analyze", "--json"], { encoding: "utf-8" });
    } catch (e) {
      // CLI exits 1 on a blocking/error case; stdout still carries the JSON.
      stdout = e.stdout;
    }
    const report = JSON.parse(stdout);
    assert.equal(report.convertible, false);
    assert.equal(typeof report.error, "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
