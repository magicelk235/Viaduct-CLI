import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectShimIntoHtmlPages, injectPopupSizing } from "../dist/runtime/shim.js";

// A page with no <head> tag got the shim tags prepended ahead of its doctype, and
// anything but whitespace or comments before <!DOCTYPE html> puts the page in quirks
// mode. Live: Violentmonkey's install page (`<!DOCTYPE html>` then body markup)
// reported document.compatMode "BackCompat" after conversion.

function page(html) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-doctype-"));
  writeFileSync(join(dir, "page.html"), html);
  return dir;
}

// The doctype must be the first thing in the file apart from a BOM, whitespace or comments.
const doctypeFirst = (html) => /^(?:\uFEFF)?(?:\s|<!--[\s\S]*?-->)*<!doctype html>/i.test(html);

test("shim tags go after the doctype on a page without a head", () => {
  const dir = page('<!DOCTYPE html>\n<meta charset="utf-8">\n<body><div id="app"></div><script src="app.js"></script>');
  injectShimIntoHtmlPages(dir, "browser-polyfill.min.js");
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(doctypeFirst(html), "doctype must stay first:\n" + html.slice(0, 200));
  assert.ok(html.indexOf("safari-compat-shim.js") < html.indexOf("app.js"), "the shim still runs before the page's own scripts");
});

test("a comment before the doctype stays where it is", () => {
  const dir = page("<!-- built -->\n<!doctype html><body></body>");
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(doctypeFirst(html));
  assert.ok(html.includes("safari-compat-shim.js"));
});

test("the popup sizing style also goes after the doctype", () => {
  const dir = page("<!DOCTYPE html><body>x</body>");
  injectPopupSizing(dir, "page.html");
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(doctypeFirst(html));
  assert.ok(html.includes("c2s-popup-size"));
});

test("a page with neither head nor doctype still gets the shim first", () => {
  const dir = page('<body><script src="app.js"></script></body>');
  injectShimIntoHtmlPages(dir);
  const html = readFileSync(join(dir, "page.html"), "utf-8");
  assert.ok(html.startsWith('<script src="/safari-compat-shim.js"></script>'));
});
