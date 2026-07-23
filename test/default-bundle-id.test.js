import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultBundleId } from "../dist/build/packager.js";

// The bundle id must be distinct per distinct name — LaunchServices keys the app on
// it, so a collision lets a second install shadow the first.

test("a lossless reverse-DNS-safe name keeps a clean slug id", () => {
  assert.equal(defaultBundleId("MyExt"), "com.viaduct.MyExt");
  assert.equal(defaultBundleId("Grammarly2"), "com.viaduct.Grammarly2");
});

test("distinct names that reduce to the same slug DON'T collide", () => {
  // "1Foo" and "Foo" both slug to "Foo" (leading digit stripped); "Café" and "Cafe"
  // both to "Caf" (non-ASCII dropped). Using the slug alone would collide — the id
  // must differ.
  assert.notEqual(defaultBundleId("1Foo"), defaultBundleId("Foo"));
  assert.notEqual(defaultBundleId("Café"), defaultBundleId("Cafe"));
  assert.notEqual(defaultBundleId("My-Ext"), defaultBundleId("MyExt"));
});

test("the same name is always stable (deterministic)", () => {
  assert.equal(defaultBundleId("Café"), defaultBundleId("Café"));
  assert.equal(defaultBundleId("日本語"), defaultBundleId("日本語"));
});

test("all-non-ASCII / all-symbol names still get a distinct hashed id", () => {
  const a = defaultBundleId("日本語");
  const b = defaultBundleId("한국어");
  assert.match(a, /^com\.viaduct\.ext[0-9a-f]{8}$/);
  assert.match(b, /^com\.viaduct\.ext[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("every produced id is a valid reverse-DNS bundle id", () => {
  const RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
  for (const name of ["MyExt", "1Foo", "Café", "日本語", "My-Ext", "123", "!!!"]) {
    assert.match(defaultBundleId(name), RE, `invalid id for "${name}"`);
  }
});
