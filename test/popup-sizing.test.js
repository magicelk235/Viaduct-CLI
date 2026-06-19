// injectPopupSizing must produce a style that survives the app's OWN stylesheet
// (which loads after it) — the Tampermonkey case where body{margin:auto} and an
// empty-at-load body gave a tiny/offset popover.
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

test("popup sizing: structural props are !important so app CSS can't override", () => {
  // Mirrors Tampermonkey: empty body, app stylesheet loaded after, sets body margin.
  const out = size('<!doctype html><html><head><link href="style.css" rel="stylesheet"></head><body></body></html>');
  const style = out.match(/<style id="c2s-popup-size">([^<]*)<\/style>/)[1];
  // margin reset wins over a later author rule only if it is !important.
  assert.match(style, /margin:0!important/);
  // height fits content (not a hard 600px box that clips JS-grown menus).
  assert.match(style, /height:auto!important/);
  assert.match(style, /max-height:\d+px!important/);
  // width has a floor (empty-at-load) but grows to content.
  assert.match(style, /min-width:\d+px!important/);
  assert.match(style, /width:max-content!important/);
  // injected BEFORE the app stylesheet so later !important-free rules still lose.
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
