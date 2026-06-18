import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveProxyHosts, shimSource } from "../dist/shim.js";

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
  assert.match(src, /document\.cookie/, "forwards JS-visible cookies");
  assert.match(src, /__c2sProxyRelay/, "page→SW relay path exists");
  assert.match(src, /"cookie": 1/, "Cookie is in the forbidden-header drop list");
  assert.match(src, /"origin": 1/, "Origin is in the forbidden-header drop list");
});
