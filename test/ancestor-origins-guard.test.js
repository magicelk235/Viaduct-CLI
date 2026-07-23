import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardAncestorOriginsAccess } from "../dist/input/stage.js";

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-ancestor-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("guards optional-chained ancestorOrigins[0] before a method call (the popup crash)", () => {
  const dir = stage({
    // Salesforce Inspector Reloaded, popup.js line 1
    "popup.js": 'const x = document.location.ancestorOrigins?.[0].includes(chrome.i18n.getMessage("@@extension_id"));',
  });
  assert.equal(guardAncestorOriginsAccess(dir), 1);
  assert.equal(
    readFileSync(join(dir, "popup.js"), "utf-8"),
    'const x = (document.location.ancestorOrigins?.[0] || "").includes(chrome.i18n.getMessage("@@extension_id"));'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("guards the plain (non-optional) ancestorOrigins[0] variant", () => {
  const dir = stage({
    "a.js": 'if (location.ancestorOrigins[0].startsWith("safari")) {}',
  });
  assert.equal(guardAncestorOriginsAccess(dir), 1);
  assert.equal(
    readFileSync(join(dir, "a.js"), "utf-8"),
    'if ((location.ancestorOrigins[0] || "").startsWith("safari")) {}'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("leaves a bare ancestorOrigins[0] read (no trailing method) untouched", () => {
  // `const o = x.ancestorOrigins[0]` is already undefined-tolerant — nothing to throw.
  const src = 'const o = window.location.ancestorOrigins?.[0];\nconst n = frames.location.ancestorOrigins.length;';
  const dir = stage({ "b.js": src });
  assert.equal(guardAncestorOriginsAccess(dir), 0);
  assert.equal(readFileSync(join(dir, "b.js"), "utf-8"), src);
  rmSync(dir, { recursive: true, force: true });
});

test("wraps the full receiver chain, not just the last segment", () => {
  // The guard must parenthesize from the object root so `|| ""` binds to the whole
  // ancestorOrigins[0] value, not to a stray inner subexpression.
  const dir = stage({
    "c.js": 'top.location.ancestorOrigins?.[0].indexOf("x")',
  });
  assert.equal(guardAncestorOriginsAccess(dir), 1);
  assert.equal(
    readFileSync(join(dir, "c.js"), "utf-8"),
    '(top.location.ancestorOrigins?.[0] || "").indexOf("x")'
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a call-expression receiver never mangles into unbalanced parentheses", () => {
  // The receiver walk-back class must not include ')' — otherwise a match could start
  // at the ')' of `foo().ancestorOrigins…` and the `|| ""` wrap would emit invalid
  // `foo((….)…)`. Real bundles never call through to ancestorOrigins, but the rewrite
  // must never produce a syntax error. Either it's left alone or wrapped balanced.
  const src = 'foo().ancestorOrigins[0].includes(x)';
  const dir = stage({ "d.js": src });
  guardAncestorOriginsAccess(dir);
  const out = readFileSync(join(dir, "d.js"), "utf-8");
  let depth = 0;
  for (const ch of out) { if (ch === "(") depth++; else if (ch === ")") depth--; assert.ok(depth >= 0, "no unbalanced ')' " + out); }
  assert.equal(depth, 0, "balanced parens: " + out);
  rmSync(dir, { recursive: true, force: true });
});
