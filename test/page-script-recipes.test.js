import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPageScript, pageScriptsDir } from "../dist/runtime/shim.js";

// A page script filed under the extension's Chrome id applies without --page-script, so
// a fix one bundle needs survives re-conversion and extension updates. The id comes from
// the manifest key, so it is stable across versions of the same bundle.

const CLAUDE = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-recipes-"));
  const prev = process.env.VIADUCT_PAGE_SCRIPTS;
  process.env.VIADUCT_PAGE_SCRIPTS = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.VIADUCT_PAGE_SCRIPTS;
    else process.env.VIADUCT_PAGE_SCRIPTS = prev;
  }
}

test("a script named after the Chrome id is found, another id's script is not", () => {
  withDir((dir) => {
    assert.equal(pageScriptsDir(), dir);
    writeFileSync(join(dir, `${CLAUDE}.js`), "window.__fix = 1;\n");
    assert.equal(findPageScript(CLAUDE), join(dir, `${CLAUDE}.js`));
    assert.equal(findPageScript("dngcpimnedloihjnnfngkgjoidhnaolf"), undefined);
  });
});

test("no Chrome id (manifest without a key) or a directory in place of the file loads nothing", () => {
  withDir((dir) => {
    writeFileSync(join(dir, `${CLAUDE}.js`), "");
    assert.equal(findPageScript(undefined), undefined);
    mkdirSync(join(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.js"));
    assert.equal(findPageScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), undefined);
  });
});

test("a missing directory is not an error", () => {
  withDir((dir) => {
    process.env.VIADUCT_PAGE_SCRIPTS = join(dir, "absent");
    assert.equal(findPageScript(CLAUDE), undefined);
  });
});
