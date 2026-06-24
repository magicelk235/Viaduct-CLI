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
import { inlineImmutableEnums, rewriteRuntimeIdUrlMatchers } from "../dist/input/stage.js";

function run(src) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-enum-"));
  const file = join(dir, "background.js");
  writeFileSync(file, src);
  const n = inlineImmutableEnums(dir);
  const out = readFileSync(file, "utf-8");
  rmSync(dir, { recursive: true, force: true });
  return { out, n };
}

function runRewrite(src) {
  const dir = mkdtempSync(join(tmpdir(), "c2s-rid-"));
  const file = join(dir, "background.js");
  writeFileSync(file, src);
  const n = rewriteRuntimeIdUrlMatchers(dir);
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

// Safari's chrome.runtime.id is the bundle id, not the URL-host UUID, so a port matcher
// `new RegExp(chrome.runtime.id + "/src/popup.html").test(sender.url)` never matches (and
// runtime.id is a frozen exotic slot the shim can't fix). The converter strips the
// `runtime.id +` prefix so the matcher is host-agnostic and matches the real Safari URL.
test("strips runtime.id+ prefix from port-routing RegExp so it matches any host", () => {
  const { out, n } = runRewrite(
    `if (new RegExp(chrome.runtime.id + "/src/popup.html").test(p.sender.url)) route();`
  );
  assert.equal(n, 1, "one file modified");
  assert.match(out, /new RegExp\("\/src\/popup\.html"\)/, "prefix dropped → host-agnostic matcher");
  assert.doesNotMatch(out, /runtime\.id\s*\+/, "no residual runtime.id concat");
  // The rewritten matcher must hit the real Safari popup URL (UPPER host + ?tabId query)
  // and reject a content-script URL.
  const re = new RegExp(out.match(/new RegExp\("([^"]+)"\)/)[1]);
  assert.equal(re.test("safari-web-extension://ABC-123/src/popup.html?tabId=7"), true, "matches UUID host + query");
  assert.equal(re.test("https://example.com/page"), false, "does not match a content-script URL");
});

test("rewrites browser.runtime.id and bracket runtime.id matchers too", () => {
  const { out } = runRewrite(
    `a(new RegExp(browser.runtime.id + "/src/sidePanel.html")); b(new RegExp(self.chrome.runtime.id + "/src/devtoolsPanel.html"));`
  );
  assert.match(out, /a\(new RegExp\("\/src\/sidePanel\.html"\)\)/);
  assert.match(out, /b\(new RegExp\("\/src\/devtoolsPanel\.html"\)\)/);
});

test("leaves a non-path runtime.id concat alone (only URL-path matchers are rewritten)", () => {
  // e.g. building a storage key or log tag from runtime.id — not a port URL matcher.
  const src = `var k = new RegExp(chrome.runtime.id + "-cache");`;
  const { out, n } = runRewrite(src);
  assert.equal(n, 0, "non-path concat is not rewritten");
  assert.match(out, /chrome\.runtime\.id \+ "-cache"/, "left untouched");
});

test("rewrite is a no-op when there is no runtime.id matcher", () => {
  const { n } = runRewrite(`console.log("hi");`);
  assert.equal(n, 0);
});
