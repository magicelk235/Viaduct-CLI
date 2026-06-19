// injectPopupSizing provides a size FLOOR only — it must not dictate the popup's
// size (the app knows its own). It forces only margin:0 (Tampermonkey's
// body{margin:auto} would otherwise offset the popover) and a non-important
// min-width/min-height so an empty-at-load body doesn't collapse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectPopupSizing } from "../dist/shim.js";

function size(html) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-popup-"));
  writeFileSync(join(dir, "action.html"), html);
  injectPopupSizing(dir, "action.html");
  const out = readFileSync(join(dir, "action.html"), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test("popup sizing: margin reset is !important, size floor is NOT", () => {
  const out = size('<!doctype html><html><head><link href="style.css" rel="stylesheet"></head><body></body></html>');
  const style = out.match(/<style id="c2s-popup-size">([^<]*)<\/style>/)[1];
  // margin:0 must win over a later app body{margin:auto}.
  assert.match(style, /margin:0!important/);
  // a min floor exists so an empty body doesn't collapse,
  assert.match(style, /min-width:\d+px/);
  assert.match(style, /min-height:\d+px/);
  // but the floor must NOT be !important — the app's own size must win.
  assert.doesNotMatch(style, /min-width:\d+px!important/);
  // and we must NOT pin a fixed width/height that overrides the app.
  assert.doesNotMatch(style, /[^-]width:\d+px/); // no `width:NNNpx` (min-width is fine)
  assert.doesNotMatch(style, /[^-]height:\d+px/);
  assert.doesNotMatch(style, /max-width/);
  assert.doesNotMatch(style, /max-content/);
  // injected BEFORE the app stylesheet.
  assert.ok(out.indexOf("c2s-popup-size") < out.indexOf("style.css"));
});

test("popup sizing: idempotent (no double inject)", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-popup2-"));
  writeFileSync(join(dir, "p.html"), "<head></head>");
  injectPopupSizing(dir, "p.html");
  injectPopupSizing(dir, "p.html");
  const out = readFileSync(join(dir, "p.html"), "utf-8");
  rmSync(dir, { recursive: true, force: true });
  assert.equal(out.match(/c2s-popup-size/g).length, 1);
});
