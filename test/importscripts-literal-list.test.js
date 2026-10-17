import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertServiceWorkerToBackgroundPage } from "../dist/runtime/shim.js";
import { scanExtension } from "../dist/analyze/analyze.js";

// Regression: Zotero Connector 5.0.217. Its service worker imports its whole
// background from a list:
//
//   var scriptsToImport = ["zotero.js", "messages.js", …, "background.js"];
//   for (let script of scriptsToImport) self.importScripts('./' + script);
//
// The converter took the "./" prefix for a target, and since that is the worker's
// own directory it "existed": background.html got <script src="./"> and none of the
// listed scripts, so the background was empty and no page was ever recognized.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-implist-"));
  for (const [name, content] of Object.entries(files)) {
    const at = join(dir, name);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, content);
  }
  return dir;
}

const ZOTERO_SHAPE =
  "try {\n" +
  "  var scriptsToImport = [\n    \"lib/a.js\",\n      'b.js', // the core\n    \"background.js\"\n  ];\n" +
  "  for (let script of scriptsToImport) {\n    self.importScripts('./' + script);\n  }\n" +
  "} catch (e) { console.error(e); }\n";

test("a loop over a literal list hoists every listed script, in order", () => {
  const dir = stage({ "bg.js": ZOTERO_SHAPE, "lib/a.js": "var A = 1;\n", "b.js": "var B = 2;\n", "background.js": "var C = 3;\n" });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "bg.js" } };
  assert.equal(convertServiceWorkerToBackgroundPage(dir, manifest), true);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.ok(!html.includes('src="./"'), "a literal prefix is not a script");
  const order = ["lib/a.js", "b.js", "background.js", "bg.js"].map((f) => html.indexOf(`<script src="${f}"></script>`));
  assert.ok(order.every((i) => i >= 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "listed order, before the worker body");
  assert.ok(!/\bimportScripts\s*\(/.test(readFileSync(join(dir, "bg.js"), "utf-8")));
  rmSync(dir, { recursive: true, force: true });
});

test("the analyzer doesn't call that loop dynamic", () => {
  const dir = stage({ "bg.js": ZOTERO_SHAPE, "lib/a.js": "", "b.js": "", "background.js": "" });
  const manifest = { manifest_version: 3, name: "T", version: "1", background: { service_worker: "bg.js" } };
  const issues = scanExtension(dir, manifest, "macos").filter((i) => /importScripts/.test(i.message));
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0].severity, "info", "hoisted, not lost");
  rmSync(dir, { recursive: true, force: true });
});

test("a concatenation with no literal list behind it stays dynamic and hoists nothing", () => {
  const dir = stage({ "bg.js": "importScripts('./' + location.hash.slice(1));\n", "x.js": "" });
  const manifest = { manifest_version: 3, name: "T", background: { service_worker: "bg.js" } };
  convertServiceWorkerToBackgroundPage(dir, manifest);
  const html = readFileSync(join(dir, "background.html"), "utf-8");
  assert.ok(!html.includes('src="./"'));
  rmSync(dir, { recursive: true, force: true });
});
