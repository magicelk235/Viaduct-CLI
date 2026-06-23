import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePluginkitList, uninstallFromSafari } from "../dist/build/installer.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parsePluginkitList returns [] for no matches", () => {
  assert.deepEqual(parsePluginkitList("    (no matches)\n"), []);
  assert.deepEqual(parsePluginkitList(""), []);
});

test("parsePluginkitList parses bundle id and path, stripping the version", () => {
  const out = parsePluginkitList(
    "    +    com.viaduct.MyExt.Extension(1.2.3)\t/Users/me/Applications/MyExt.app/Contents/PlugIns/MyExt Extension.appex\n"
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].bundleId, "com.viaduct.MyExt.Extension");
  assert.ok(out[0].path.endsWith(".appex"));
});

test("parsePluginkitList handles multiple lines and skips malformed ones", () => {
  const out = parsePluginkitList(
    [
      "    +    com.a.Extension(1.0)\t/path/a.appex",
      "garbage-no-tabs",
      "    -    com.b.Extension(2.0)\t/path/b.appex",
    ].join("\n")
  );
  assert.deepEqual(
    out.map((e) => e.bundleId),
    ["com.a.Extension", "com.b.Extension"]
  );
});

test("uninstallFromSafari refuses path traversal out of the install dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-uninstall-"));
  // `../../../etc` would resolve outside `dir`; the guard must reject before any
  // statSync/rmSync touches it, returning false rather than deleting an arbitrary .app.
  assert.equal(uninstallFromSafari("../../../../tmp/Evil", dir), false);
});
