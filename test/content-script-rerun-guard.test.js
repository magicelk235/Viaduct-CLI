import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { guardContentScriptReruns } from "../dist/input/stage.js";

// Safari evaluates a content-script group once per granted origin pattern whose host
// covers the page. An extension without <all_urls> has each requested pattern granted on
// its own, so Augmented Steam (49 patterns on *.steampowered.com) ran app.js 49 times into
// one document and drew every widget 49 times. All the repeats land in one task. Each
// content-script file must run once per burst and still run on a later, deliberate
// re-injection.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-cs-rerun-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// One isolated world: a shared global, a document, and timers we can flush.
function world() {
  const timers = [];
  const ctx = { document: {}, runs: 0, setTimeout: (fn) => { timers.push(fn); return timers.length; } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, nextTask: () => { const t = timers.splice(0); for (const fn of t) fn(); } };
}

function evaluate(ctx, source) {
  try { vm.runInContext(source, ctx); return null; } catch (e) { return e; }
}

test("a burst of repeated evaluations runs the file once", () => {
  const dir = stage({ "js/app.js": "runs++;\n" });
  guardContentScriptReruns(dir, { content_scripts: [{ matches: ["*://*.example.com/*"], js: ["js/app.js"] }] });
  const src = readFileSync(join(dir, "js/app.js"), "utf-8");
  const { ctx } = world();
  const errors = [];
  for (let i = 0; i < 49; i++) { const e = evaluate(ctx, src); if (e) errors.push(e); }
  assert.equal(ctx.runs, 1);
  assert.equal(errors.length, 48);
});

test("a later re-injection into the same document runs again", () => {
  const dir = stage({ "content.js": "runs++;\n" });
  guardContentScriptReruns(dir, { content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }] });
  const src = readFileSync(join(dir, "content.js"), "utf-8");
  const { ctx, nextTask } = world();
  evaluate(ctx, src);
  evaluate(ctx, src);
  nextTask();
  evaluate(ctx, src);
  assert.equal(ctx.runs, 2);
});

test("a new document in the same world runs the file", () => {
  const dir = stage({ "content.js": "runs++;\n" });
  guardContentScriptReruns(dir, { content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }] });
  const src = readFileSync(join(dir, "content.js"), "utf-8");
  const { ctx } = world();
  evaluate(ctx, src);
  ctx.document = {};
  evaluate(ctx, src);
  assert.equal(ctx.runs, 2);
});

test("a strict-mode file stays strict and keeps its first-line numbering", () => {
  const original = '"use strict";\nvar sloppy = (function () { return this; })();\nruns++;\n';
  const dir = stage({ "a.js": original, "b.js": "/* banner */\n'use strict'\nruns++;\n" });
  guardContentScriptReruns(dir, { content_scripts: [{ matches: ["<all_urls>"], js: ["a.js", "./b.js"] }] });
  const a = readFileSync(join(dir, "a.js"), "utf-8");
  const b = readFileSync(join(dir, "b.js"), "utf-8");
  assert.equal(a.split("\n").length, original.split("\n").length);
  const { ctx } = world();
  assert.equal(evaluate(ctx, a), null);
  assert.equal(ctx.sloppy, undefined, "this is undefined inside a strict function");
  assert.equal(evaluate(ctx, b), null);
  assert.equal(ctx.runs, 2);
});

test("guarding twice leaves one guard", () => {
  const dir = stage({ "content.js": "runs++;\n" });
  const manifest = { content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }] };
  guardContentScriptReruns(dir, manifest);
  const once = readFileSync(join(dir, "content.js"), "utf-8");
  assert.equal(guardContentScriptReruns(dir, manifest), 0);
  assert.equal(readFileSync(join(dir, "content.js"), "utf-8"), once);
});

// Return YouTube Dislike (webpack's /******/ runtime) and MetaMask (LavaMoat's SES header)
// open with a comment, have many more comments between whitespace, and no "use strict"
// at the top. Looking for a prologue in files like these once backtracked through every
// way of grouping those comments and never finished, so the conversion sat at
// "Preparing assets". Runs in a child so a regression fails on the timeout instead of
// hanging the suite.
test("files with many leading comments and no prologue are guarded promptly", () => {
  const dir = stage({
    "ryd.content-script.js":
      "/******/ (() => { // webpackBootstrap\n" +
      "/******/ \t// The module cache\n".repeat(40) +
      "/******/ \tvar __webpack_module_cache__ = {};\n",
    "scripts/contentscript.js":
      "/*! SES sources included by LavaMoat. Do not optimize or minify. */\n;\n// ses@2.2.0\n" +
      "  /* comment */\n".repeat(40) +
      "(functors => options => {\n  'use strict';\n})\n",
  });
  const manifest = { content_scripts: [{ matches: ["<all_urls>"], js: ["ryd.content-script.js", "scripts/contentscript.js"] }] };
  const stageUrl = new URL("../dist/input/stage.js", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const { guardContentScriptReruns } = await import(${JSON.stringify(stageUrl)}); guardContentScriptReruns(${JSON.stringify(dir)}, ${JSON.stringify(manifest)});`],
    { timeout: 5000, encoding: "utf-8" }
  );
  assert.equal(child.signal, null, "guarding did not finish within 5 s");
  assert.equal(child.status, 0, child.stderr);
  for (const rel of manifest.content_scripts[0].js) {
    assert.ok(readFileSync(join(dir, rel), "utf-8").startsWith("if(typeof document"), `${rel} is guarded at its top`);
  }
});

test("a prologue after doc comments and line comments keeps the file strict", () => {
  const dir = stage({ "c.js": "/***/\n/** @license x */ // note\n\t\"use strict\";\nvar sloppy = (function () { return this; })();\nruns++;\n" });
  guardContentScriptReruns(dir, { content_scripts: [{ matches: ["<all_urls>"], js: ["c.js"] }] });
  const c = readFileSync(join(dir, "c.js"), "utf-8");
  assert.ok(c.startsWith("/***/\n/** @license x */ // note\n\t\"use strict\";;if(typeof document"));
  const { ctx } = world();
  assert.equal(evaluate(ctx, c), null);
  assert.equal(ctx.sloppy, undefined, "this is undefined inside a strict function");
  assert.equal(ctx.runs, 1);
});
