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

test("defaultBundleId falls back to 'extension' when nothing usable remains", () => {
  assert.equal(defaultBundleId("!!!"), "com.viaduct.extension");
  assert.equal(defaultBundleId("99"), "com.viaduct.extension");
  assert.equal(defaultBundleId(""), "com.viaduct.extension");
  assert.match(defaultBundleId("☃"), VALID_BUNDLE_ID);
});
