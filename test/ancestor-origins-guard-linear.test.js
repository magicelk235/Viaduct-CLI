import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardAncestorOriginsAccess } from "../dist/input/stage.js";

// The guard's pattern began with the receiver, `(?:[\w$.]|\?\.)+\.ancestorOrigins`,
// so a long run of identifier characters was rescanned from every position in it:
// quadratic. Floccus inlines megabytes of such runs and its conversion sat in this
// step for over half an hour. The run below took the old pattern tens of seconds.

test("a long identifier run doesn't make the guard quadratic", () => {
  const run = "a".repeat(80_000) + ".b".repeat(20_000);
  const src = `var blob = "${run}";\nif (location.ancestorOrigins?.[0].includes("x")) {}\n`;
  const dir = mkdtempSync(join(tmpdir(), "viaduct-ancestor-lin-"));
  writeFileSync(join(dir, "big.js"), src);
  const t0 = Date.now();
  assert.equal(guardAncestorOriginsAccess(dir), 1);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`);
  const out = readFileSync(join(dir, "big.js"), "utf-8");
  assert.ok(out.endsWith('if ((location.ancestorOrigins?.[0] || "").includes("x")) {}\n'));
  assert.ok(out.startsWith(`var blob = "${run}";`), "the data run is untouched");
  rmSync(dir, { recursive: true, force: true });
});
