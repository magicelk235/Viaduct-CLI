import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNativeProxyHandler } from "../dist/build/packager.js";

// Build a minimal xcodeproj layout with a placeholder handler file, run the
// generator, return the rewritten handler source.
function generate(origin, hosts) {
  const root = mkdtempSync(join(tmpdir(), "proj-"));
  const proj = join(root, "MyApp.xcodeproj");
  mkdirSync(proj);
  const ext = join(root, "Ext");
  mkdirSync(ext);
  const handler = join(ext, "SafariWebExtensionHandler.swift");
  writeFileSync(handler, "// placeholder\n");
  writeNativeProxyHandler(proj, origin, hosts);
  return readFileSync(handler, "utf-8");
}

test("native proxy handler: clean hosts/origin are written into the Swift literals", () => {
  const out = generate("chrome-extension://abc", ["api.foo.com", "app.bar.com"]);
  assert.match(out, /static let allowHosts: Set<String> = \["api\.foo\.com", "app\.bar\.com"\]/);
  assert.match(out, /static let chromeOrigin = "chrome-extension:\/\/abc"/);
});

test("native proxy handler: forwarded Cookie header isn't clobbered by URLSession's empty jar", () => {
  // The shim sends the authenticated Cookie (from chrome.cookies, httpOnly
  // included). URLSession's shared storage is empty in the appex; if it were
  // allowed to manage cookies it would strip/replace our header → backend 401.
  const out = generate("chrome-extension://abc", ["auth.grammarly.com"]);
  assert.match(out, /req\.setValue\(cookie, forHTTPHeaderField: "Cookie"\)/, "explicit Cookie header set");
  assert.match(out, /req\.httpShouldHandleCookies = false/, "request won't auto-apply jar cookies");
  assert.match(out, /cfg\.httpShouldSetCookies = false/, "session won't inject jar cookies");
});

test("native proxy handler: a host with quote/backslash/newline can't break or inject the Swift literal", () => {
  // A malformed/hostile manifest can yield a host carrying these chars; stripping
  // only `"` would leave a backslash or newline that breaks the string literal.
  const out = generate("chrome-extension://abc", ['ev"il\nINJECT', "bad\\host", "ok.com"]);
  const hostsLine = out.split("\n").find((l) => l.includes("allowHosts: Set"));
  // Quotes must be balanced (even count) — an unbalanced count means a broken/
  // unterminated literal, i.e. the build breaks or code is injected.
  assert.equal(hostsLine.split('"').length % 2, 1, "balanced quotes in the hosts literal");
  // No raw control chars or backslashes survive inside the literal.
  assert.ok(!/[\\\n\r]/.test(hostsLine.replace(/\n$/, "")), "no backslash/newline in hosts line");
  assert.match(out, /"evilINJECT"/, "quote+newline stripped, token stays intact");
  assert.match(out, /"badhost"/, "backslash stripped");
});

test("native proxy handler: origin quote-injection is neutralized", () => {
  const out = generate('chrome-extension://abc"; evil()', ["ok.com"]);
  const originLine = out.split("\n").find((l) => l.includes("chromeOrigin ="));
  assert.equal(originLine.split('"').length, 3, "exactly one quoted literal, no injected code");
  assert.match(out, /chromeOrigin = "chrome-extension:\/\/abcevil"/);
});

test("native proxy handler: hosts that sanitize to empty are dropped", () => {
  const out = generate("", ['"""', "\n\n", "good.com"]);
  assert.match(out, /allowHosts: Set<String> = \["good\.com"\]/, "only the surviving host remains");
});
