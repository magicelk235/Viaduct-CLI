import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageExtension } from "../dist/input/stage.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// Regression: a manifest-referenced asset that is a symlink to another file INSIDE
// the source tree must be dereferenced and its bytes copied into the stage. The
// containment check has to compare the link's realpath against the realpath'd source
// root — on macOS tmpdir() lives under a symlinked path (/var → /private/var), so a
// resolve()-only root would make the in-tree target look external and silently drop it.
test("stageExtension dereferences a kept in-tree symlinked asset", () => {
  const src = tmp("vd-stage-src-");
  const stage = join(tmp("vd-stage-out-"), "staged_extension");

  // real file the manifest will reference via a symlink
  writeFileSync(join(src, "real-asset.js"), "console.log('hi');");
  symlinkSync(join(src, "real-asset.js"), join(src, "linked-asset.js"));
  writeFileSync(join(src, "manifest.json"), "{}");

  stageExtension(src, stage, new Set(["linked-asset.js"]));

  const dest = join(stage, "linked-asset.js");
  assert.ok(existsSync(dest), "kept symlinked asset should be staged");
  assert.equal(readFileSync(dest, "utf-8"), "console.log('hi');", "target bytes copied");
});

// A kept symlink pointing OUTSIDE the source tree must NOT be followed (would leak
// host files / ship a path that 404s).
test("stageExtension drops a kept symlink that escapes the source tree", () => {
  const src = tmp("vd-stage-src2-");
  const outside = tmp("vd-stage-outside-");
  writeFileSync(join(outside, "secret.js"), "leak");
  symlinkSync(join(outside, "secret.js"), join(src, "evil.js"));
  writeFileSync(join(src, "manifest.json"), "{}");

  const stage = join(tmp("vd-stage-out2-"), "staged_extension");
  stageExtension(src, stage, new Set(["evil.js"]));

  assert.ok(!existsSync(join(stage, "evil.js")), "escaping symlink must not be staged");
});
