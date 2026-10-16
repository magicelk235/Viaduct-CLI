import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
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
