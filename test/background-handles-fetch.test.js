import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { backgroundHandlesFetch } from "../dist/runtime/shim.js";

// Whether the source service worker serves its pages' requests decides if the
// navigator.serviceWorker emulation may report a controller (see
// sw-message-bridge.test.js). The handler often lives in a script the worker
// imports rather than in the entry file.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-swfetch-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
const mv3 = (sw) => ({ manifest_version: 3, background: { service_worker: sw } });

test("onfetch or a fetch listener in the worker entry counts", () => {
  assert.equal(backgroundHandlesFetch(stage({ "sw.js": "global.onfetch = evt => evt.respondWith(x);" }), mv3("sw.js")), true);
  assert.equal(backgroundHandlesFetch(stage({ "sw.js": "self.addEventListener('fetch', e => {});" }), mv3("sw.js")), true);
});

test("a handler in an imported script counts", () => {
  const viaImportScripts = stage({ "bg/sw.js": 'importScripts("lib/a.js", "/shared/b.js");', "shared/b.js": 'addEventListener("fetch", h);' });
  assert.equal(backgroundHandlesFetch(viaImportScripts, mv3("bg/sw.js")), true);
  const viaImport = stage({ "sw.js": 'import { x } from "./net/handler.js";\nx();', "net/handler.js": "self.onfetch = (e) => e.respondWith(r);" });
  assert.equal(backgroundHandlesFetch(viaImport, mv3("/sw.js")), true);
});

test("a worker that only calls fetch, or compares onfetch, does not count", () => {
  const dir = stage({ "sw.js": 'fetch("https://example.com"); if (self.onfetch == null) {} self.addEventListener("message", h);' });
  assert.equal(backgroundHandlesFetch(dir, mv3("sw.js")), false);
});

test("no service worker means no fetch handler", () => {
  const dir = stage({ "bg.js": "self.onfetch = h;" });
  assert.equal(backgroundHandlesFetch(dir, { manifest_version: 2, background: { scripts: ["bg.js"] } }), false);
});
