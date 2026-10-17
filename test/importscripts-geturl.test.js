import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertServiceWorkerToBackgroundPage } from "../dist/runtime/shim.js";
import { scanExtension } from "../dist/analyze/analyze.js";

// Wappalyzer 6.12.7's worker is three lines:
//   importScripts(chrome.runtime.getURL('js/wappalyzer.js'))
//   importScripts(chrome.runtime.getURL('js/utils.js'))
//   importScripts(chrome.runtime.getURL('js/index.js'))
// The converter took the literal inside getURL as worker-relative ("js/js/…", nowhere on
// disk), dropped it, and still neutralized the call, so the background page loaded none
// of its code and the extension did nothing. getURL paths are relative to the extension
// root, so these are as static as a bare literal.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-imports-geturl-"));
  for (const [name, content] of Object.entries(files)) {
    const at = join(dir, name);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, content);
  }
  return dir;
}

const WORKER =
  "importScripts(chrome.runtime.getURL('js/wappalyzer.js'))\n" +
  "importScripts(browser.runtime.getURL(\"/js/utils.js\"))\n" +
  "importScripts(chrome.runtime.getURL(`js/index.js`))\n";

test("getURL-wrapped importScripts targets are hoisted from the extension root", (t) => {
  const dir = stage({
    "js/background.js": WORKER,
    "js/wappalyzer.js": "var Wappalyzer = {};\n",
    "js/utils.js": "var Utils = {};\n",
    "js/index.js": "Wappalyzer.ready = true;\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "js/background.js" } };
  assert.equal(convertServiceWorkerToBackgroundPage(dir, manifest), true);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  for (const f of ["js/wappalyzer.js", "js/utils.js", "js/index.js"]) {
    assert.match(html, new RegExp(`<script src="${f.replace(/[./]/g, "\\$&")}"></script>`));
    assert.ok(html.indexOf(`src="${f}"`) < html.indexOf('src="js/background.js"'), `${f} loads before the worker body`);
  }
  assert.ok(!html.includes("js/js/"));
  assert.ok(!/type="module"/.test(html), "nothing dynamic remains, so the page stays classic");
});

test("the analyzer counts them as hoisted, not as lost code", (t) => {
  const dir = stage({ "js/background.js": WORKER });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = { manifest_version: 3, name: "T", version: "1", background: { service_worker: "js/background.js" } };
  const issues = scanExtension(dir, manifest, "macos").filter((i) => /importScripts/.test(i.message));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "info");
});
