import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectShimIntoHtmlPages, injectPageScript, PAGE_SCRIPT_FILENAME } from "../dist/runtime/shim.js";

// --page-script loads a user's own file in every shipped HTML page. It has to run after
// the shim, so it sees the APIs the page will, and before the page's own scripts, so it
// can set things up before the bundle's first render.

const TAG = `<script src="/${PAGE_SCRIPT_FILENAME}"></script>`;

function stage(pages) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-page-script-"));
  for (const [rel, html] of Object.entries(pages)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), html);
  }
  const src = join(dir, "..", `fix-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(src, "window.__fix = 1;\n");
  return { dir, src };
}

test("the page script runs after the shim and before the page's own module", () => {
  const { dir, src } = stage({
    "sidepanel.html": '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body></body></html>',
  });
  injectShimIntoHtmlPages(dir);
  assert.equal(injectPageScript(dir, src), 1);
  const html = readFileSync(join(dir, "sidepanel.html"), "utf-8");
  const shim = html.indexOf('src="/safari-compat-shim.js"');
  const mine = html.indexOf(TAG);
  const app = html.indexOf('src="/assets/app.js"');
  assert.ok(shim >= 0 && shim < mine && mine < app, html);
  assert.equal(readFileSync(join(dir, PAGE_SCRIPT_FILENAME), "utf-8"), "window.__fix = 1;\n");
});

test("every page gets it once, including pages in subfolders and a second run", () => {
  const { dir, src } = stage({
    "popup.html": "<!doctype html><html><head></head><body></body></html>",
    "pages/options.html": "<!doctype html><html><head></head><body></body></html>",
  });
  injectPageScript(dir, src);
  assert.equal(injectPageScript(dir, src), 0);
  for (const rel of ["popup.html", "pages/options.html"]) {
    const html = readFileSync(join(dir, rel), "utf-8");
    assert.equal(html.split(TAG).length - 1, 1, rel);
  }
});

test("a missing file stops the conversion instead of shipping pages that load nothing", () => {
  const { dir } = stage({ "popup.html": "<html><head></head></html>" });
  assert.throws(() => injectPageScript(dir, join(dir, "nope.js")), /--page-script: no such file/);
  assert.equal(existsSync(join(dir, PAGE_SCRIPT_FILENAME)), false);
  assert.equal(readFileSync(join(dir, "popup.html"), "utf-8").includes(TAG), false);
});
