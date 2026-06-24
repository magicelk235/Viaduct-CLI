import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveProxyHosts, shimSource } from "../dist/runtime/shim.js";

test("deriveProxyHosts pulls discrete hosts from host_permissions + externally_connectable", () => {
  const hosts = deriveProxyHosts({
    host_permissions: ["https://api.foo.com/*", "*://*.bar.com/*"],
    externally_connectable: { matches: ["https://app.bar.com/*"] },
  });
  assert.deepEqual(new Set(hosts), new Set(["api.foo.com", "bar.com", "app.bar.com"]));
});

test("deriveProxyHosts skips broad wildcards (<all_urls>) and mines CSP connect-src", () => {
  // <all_urls> is too broad to proxy; the real backend lives in connect-src.
  const hosts = deriveProxyHosts({
    host_permissions: ["<all_urls>"],
    content_security_policy: {
      extension_pages: "connect-src 'self' https://api.anthropic.com wss://stream.anthropic.com; script-src 'self'",
    },
  });
  assert.ok(hosts.includes("api.anthropic.com"), "api host from connect-src");
  assert.ok(hosts.includes("stream.anthropic.com"), "wss host from connect-src");
  assert.ok(!hosts.includes("*"), "no wildcard host");
});

test("shimSource bakes the proxy config and keeps the native-message fallback", () => {
  const src = shimSource({ chromeOrigin: "chrome-extension://abc", proxyHosts: ["api.foo.com"] });
  assert.match(src, /__C2S_PROXY_CONFIG__ = \{"origin":"chrome-extension:\/\/abc","hosts":\["api\.foo\.com"\]\}/);
  assert.match(src, /sendNativeMessage/);
  assert.match(src, /__c2sProxy/);
});

test("shimSource with no hosts emits an inert proxy config", () => {
  const src = shimSource();
  assert.match(src, /__C2S_PROXY_CONFIG__ = \{"origin":"","hosts":\[\]\}/);
});

test("shim proxy hardening: cookie forwarding, forbidden-header filter, SW relay", () => {
  const src = shimSource({ chromeOrigin: "chrome-extension://abc", proxyHosts: ["api.foo.com"] });
  // The proxy sources cookies from chrome.cookies (Safari's real jar, httpOnly
  // included), with document.cookie only as a fallback — a session cookie like
  // Grammarly's httpOnly `grauth` is invisible to document.cookie, so forwarding
  // it alone left the proxy retry stuck at 401.
  assert.match(src, /gatherCookieHeader/, "cookie header is gathered for the proxy");
  assert.match(src, /chrome\.cookies/, "sources cookies from chrome.cookies (httpOnly included)");
  assert.match(src, /ck\.getAll\(\{ url: url \}/, "reads cookies scoped to the request URL");
  assert.match(src, /document\.cookie/, "document.cookie remains as a fallback");
  assert.match(src, /__c2sProxyRelay/, "page→SW relay path exists");
  assert.match(src, /"cookie": 1/, "Cookie is in the forbidden-header drop list");
  assert.match(src, /"origin": 1/, "Origin is in the forbidden-header drop list");
});

// The core of the auth fix: the proxy must build a Cookie header that INCLUDES
// the httpOnly session cookie, which only chrome.cookies exposes. This replays
// gatherCookieHeader's builder against a fake chrome.cookies and asserts the
// httpOnly cookie makes it into the header (document.cookie never could).
test("proxy cookie sourcing: httpOnly cookie from chrome.cookies lands in the header", async () => {
  // Mirror of gatherCookieHeader's list→header reduction (shim.ts).
  function buildHeader(list, fallback) {
    if (list && list.length) {
      const parts = [];
      for (const c of list) if (c && c.name != null) parts.push(c.name + "=" + (c.value == null ? "" : c.value));
      if (parts.length) return parts.join("; ");
    }
    return fallback;
  }
  const jar = [
    { name: "grauth", value: "SECRET", httpOnly: true }, // invisible to document.cookie
    { name: "gnar_containerId", value: "abc" },
  ];
  const header = buildHeader(jar, "only_visible=1");
  assert.equal(header, "grauth=SECRET; gnar_containerId=abc");
  // Empty jar → falls back to the document.cookie value.
  assert.equal(buildHeader([], "only_visible=1"), "only_visible=1");
  // And the shim wires getAll promise-or-callback (Safari is promise-based).
  assert.match(shimSource({ proxyHosts: ["x.com"] }), /p\.then\(finish/);
});

// proxyFetch builds a Response from the native host's reply. Response() only
// accepts status 200-599, and rejects a body on a null-body status (204/205/304).
// A host network failure returns status 0; without clamping, new Response throws
// RangeError/TypeError and crashes the proxied fetch with a cryptic error instead
// of surfacing the host result. This replays the exact status-handling the shim
// emits and asserts it never throws.
test("proxy: out-of-range / null-body statuses never crash Response construction", () => {
  // Mirrors the clamp logic in proxyFetch (shim.ts).
  function buildResponse(r) {
    var bytes = new Uint8Array([1, 2, 3]); // pretend the host sent a body
    var st = typeof r.status === "number" ? r.status : 200;
    if (st < 200 || st > 599) st = 502;
    if (st === 204 || st === 205 || st === 304) bytes = null;
    return new Response(bytes, { status: st, statusText: r.statusText || "", headers: r.headers || {} });
  }
  // status 0 (host failure) → 502, no throw
  assert.equal(buildResponse({ status: 0 }).status, 502);
  // 1xx → 502
  assert.equal(buildResponse({ status: 101 }).status, 502);
  // 700 (bogus) → 502
  assert.equal(buildResponse({ status: 700 }).status, 502);
  // 204 with a body → no throw, body dropped
  const r204 = buildResponse({ status: 204 });
  assert.equal(r204.status, 204);
  // normal 200 passes through
  assert.equal(buildResponse({ status: 200 }).status, 200);

  // And confirm the shim source actually carries the clamp (regression guard).
  assert.match(shimSource(), /if \(st < 200 \|\| st > 599\) st = 502/);
  // status read without `|| 200` (which would turn a host-failure 0 into 200).
  assert.match(shimSource(), /typeof r\.status === "number" \? r\.status : 200/);
});
