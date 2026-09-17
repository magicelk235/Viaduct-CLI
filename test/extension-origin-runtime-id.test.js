import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteExtensionOriginFromRuntimeId } from "../dist/input/stage.js";

// Regression: MetaMask 13.x on Safari 26. Its background decides whether a port belongs
// to its own UI with
//   new URL(port.sender.url).origin === `chrome-extension://${chrome.runtime.id}`
// which can never hold on Safari: runtime.id is the App-Extension bundle id while the
// page's host is the per-install UUID. A port that fails the test still gets the liveness
// ping but never BACKGROUND_INITIALIZED, so the popup waited 16 s and then showed
// "MetaMask had trouble starting — Background initialization timeout".
//
// Measured live, both sides of the comparison after the rewrite:
//   new URL(sender.url).origin       safari-web-extension://297cd490-…
//   new URL(getURL("/")).origin      safari-web-extension://297cd490-…
// new URL() lowercases the host, so this also sidesteps the UUID-case mismatch that
// makes a raw string compare fail (Safari Quirks B4).

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-origin-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

test("a template-literal extension origin is derived from getURL instead", () => {
  const dir = stage({
    // MetaMask's shape, verbatim except for the names the minifier picked.
    "bg.js": "function eR(e){let t,r=e.name,n=e.sender?.url?new URL(e.sender.url):null;"
      + "return t=eD?!!eI[r]:n?.origin===`chrome-extension://${C().runtime.id}`,{isMetaMaskUIPort:t}}",
  });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 1);
  const out = readFileSync(join(dir, "bg.js"), "utf-8");
  assert.match(out, /n\?\.origin===new URL\(C\(\)\.runtime\.getURL\("\/"\)\)\.origin/);
  assert.ok(!out.includes("chrome-extension://"), "the unmatchable literal must be gone");
  rmSync(dir, { recursive: true, force: true });
});

test("the string-concat form is rewritten too, on any namespace chain", () => {
  const dir = stage({
    "a.js": 'if (sender.origin === "chrome-extension://" + chrome.runtime.id) ok();',
    "b.js": "if (o === 'chrome-extension://' + globalThis.browser.runtime.id) ok();",
  });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 2);
  assert.match(readFileSync(join(dir, "a.js"), "utf-8"),
    /=== new URL\(chrome\.runtime\.getURL\("\/"\)\)\.origin/);
  assert.match(readFileSync(join(dir, "b.js"), "utf-8"),
    /=== new URL\(globalThis\.browser\.runtime\.getURL\("\/"\)\)\.origin/);
  rmSync(dir, { recursive: true, force: true });
});

test("an optional-chained runtime.id is left alone", () => {
  // `browser?.runtime?.id` answers undefined when the namespace is missing; the
  // getURL form would throw instead, so this shape keeps Chrome's semantics.
  const dir = stage({ "opt.js": "if (o === `chrome-extension://${browser?.runtime?.id}`) ok();" });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a concrete-host URL with a path is left alone", () => {
  // This is the OAuth redirect_uri case: registered verbatim with the provider, so
  // rewriting it turns a working login into "Redirect URI is not supported by client".
  const dir = stage({
    "oauth.js": "const redirect = `chrome-extension://${chrome.runtime.id}/oauth_callback.html`;",
  });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 0);
  assert.match(readFileSync(join(dir, "oauth.js"), "utf-8"), /chrome-extension:\/\/\$\{chrome\.runtime\.id\}\/oauth_callback\.html/);
  rmSync(dir, { recursive: true, force: true });
});

test("an origin built from something other than runtime.id is left alone", () => {
  const dir = stage({
    "other.js": "const o = `chrome-extension://${someOtherId}`; const p = 'chrome-extension://' + knownId;",
  });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a file without the scheme is not rewritten or touched", () => {
  const dir = stage({ "clean.js": "const id = chrome.runtime.id;" });
  assert.equal(rewriteExtensionOriginFromRuntimeId(dir), 0);
  assert.equal(readFileSync(join(dir, "clean.js"), "utf-8"), "const id = chrome.runtime.id;");
  rmSync(dir, { recursive: true, force: true });
});
