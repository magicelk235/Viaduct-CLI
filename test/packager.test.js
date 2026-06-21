import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultBundleId } from "../dist/packager.js";

// A reverse-DNS CFBundleIdentifier: dot-separated segments of letters, digits and
// hyphens, no empty segments, no segment starting with a digit. A malformed id
// silently breaks Safari registration, so defaultBundleId must always emit a valid
// one whatever the source app name looks like.
const VALID_BUNDLE_ID = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

test("defaultBundleId slugs a normal name and stays under com.viaduct", () => {
  assert.equal(defaultBundleId("My Cool Ext"), "com.viaduct.MyCoolExt");
  assert.match(defaultBundleId("My Cool Ext"), VALID_BUNDLE_ID);
});

test("defaultBundleId drops leading digits (Apple rejects digit-led segments)", () => {
  assert.equal(defaultBundleId("123App"), "com.viaduct.App");
  assert.match(defaultBundleId("123App"), VALID_BUNDLE_ID);
});

test("defaultBundleId derives a valid, NON-colliding id when nothing alphanumeric remains", () => {
  // All-symbol / all-digit / non-Latin names: must still be valid AND distinct, so
  // two such extensions don't get the same bundle id and shadow each other in
  // LaunchServices. (Regression: the old code collapsed them all to .extension.)
  for (const name of ["!!!", "99", "☃", "日本語", "😀"]) {
    assert.match(defaultBundleId(name), VALID_BUNDLE_ID, name);
  }
  assert.notEqual(defaultBundleId("!!!"), defaultBundleId("???"), "distinct names → distinct ids");
  assert.notEqual(defaultBundleId("99"), defaultBundleId("88"));
  // Stable: same name always yields the same id (needed for re-install / updates).
  assert.equal(defaultBundleId("日本語"), defaultBundleId("日本語"));
});
