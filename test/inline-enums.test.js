// Safari's chrome.scripting is an immutable host slot — the shim cannot install the
// ExecutionWorld/RegistrationWorld enum objects (assign/defineProperty are silent
// no-ops, delete re-materializes the empty native slot; all proven live in the
// Bitwarden bg). Bundles read chrome.scripting.ExecutionWorld.ISOLATED and crash on
// `undefined.ISOLATED`. The converter inlines those reads to literal strings instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inlineImmutableEnums } from "../dist/input/stage.js";

function run(src) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-enum-"));
  const file = join(dir, "background.js");
  writeFileSync(file, src);
  const n = inlineImmutableEnums(dir);
  const out = readFileSync(file, "utf-8");
  rmSync(dir, { recursive: true, force: true });
  return { out, n };
}

test("inlines chrome.scripting.ExecutionWorld.* member reads to string literals", () => {
  const { out, n } = run(
    `var w = chrome.scripting.ExecutionWorld.ISOLATED; var m = chrome.scripting.ExecutionWorld.MAIN;`
  );
  assert.equal(n, 1, "one file modified");
  assert.match(out, /var w = "ISOLATED";/);
  assert.match(out, /var m = "MAIN";/);
  assert.doesNotMatch(out, /ExecutionWorld/, "no residual enum read");
});

test("handles RegistrationWorld and browser.* and bracket access", () => {
  const { out } = run(
    `a(browser.scripting.RegistrationWorld.MAIN); b(chrome["scripting"].ExecutionWorld.ISOLATED);`
  );
  assert.match(out, /a\("MAIN"\)/);
  assert.match(out, /b\("ISOLATED"\)/);
});

test("leaves unrelated code and unknown members untouched", () => {
  const src = `chrome.scripting.executeScript({}); var x = chrome.scripting.ExecutionWorld.SOMETHING_NEW;`;
  const { out } = run(src);
  assert.match(out, /chrome\.scripting\.executeScript/, "method calls untouched");
  // Unknown member is not in our table → left as-is rather than wrongly inlined.
  assert.match(out, /ExecutionWorld\.SOMETHING_NEW/);
});

test("no-op when there is nothing to inline", () => {
  const { n } = run(`console.log("hello");`);
  assert.equal(n, 0);
});
