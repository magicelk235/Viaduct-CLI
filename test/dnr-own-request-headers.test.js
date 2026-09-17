import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari never applies a declarativeNetRequest modifyHeaders rule, so the shim
// strips them (dnr-modify-headers.test.js). But an extension registers such a
// rule mostly to stamp headers on its OWN API calls: Claude in Chrome sets
// User-Agent, anthropic-client-platform and anthropic-client-version on every
// api.anthropic.com request that way, and without them the backend sees an
// anonymous browser client. Those requests all go through the shim's fetch/XHR
// patches, which honor the extension's rules themselves: settable headers are
// applied in the browser, forbidden ones (User-Agent) are handed to the
// native-host proxy retry, which can set anything.

// The shim arms keepalive intervals once storage.local exists; unref them so the
// runner exits when the assertions are done.
const unrefd = (fn) => (...a) => { const t = fn(...a); if (t && typeof t.unref === "function") t.unref(); return t; };

function boot() {
  const calls = [];
  const store = {};
  const sandbox = {
    console,
    setTimeout: unrefd(setTimeout), clearTimeout, setInterval: unrefd(setInterval), clearInterval,
    Headers, Request, Response, URL, URLSearchParams,
    location: { href: "safari-web-extension://TEST/background.html", protocol: "safari-web-extension:", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    fetch(input, init) {
      const h = {};
      new Headers((init && init.headers) || (typeof input !== "string" && input && input.headers) || {}).forEach((v, k) => { h[k] = v; });
      calls.push({ url: typeof input === "string" ? input : input.url, headers: h });
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {} },
        onConnect: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      storage: {
        local: {
          get: (k) => Promise.resolve(store[k] === undefined ? {} : { [k]: store[k] }),
          set: (o) => { Object.assign(store, o); return Promise.resolve(); },
        },
        onChanged: { addListener() {} },
      },
      declarativeNetRequest: {
        updateSessionRules() { return Promise.resolve(); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, calls, store };
}

const claudeRule = {
  id: 1,
  priority: 1,
  action: {
    type: "modifyHeaders",
    requestHeaders: [
      { header: "User-Agent", operation: "set", value: "1.0.91 test Chrome" },
      { header: "anthropic-client-platform", operation: "set", value: "claude_browser_extension" },
      { header: "anthropic-client-version", operation: "set", value: "1.0.91" },
    ],
  },
  condition: { urlFilter: "https://api.example.com/*", resourceTypes: ["xmlhttprequest", "other"] },
};

test("a stripped modifyHeaders rule is still applied to the extension's own matching fetch", async () => {
  const { sandbox, calls, store } = boot();
  await sandbox.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [claudeRule] });
  await sandbox.fetch("https://api.example.com/v1/thing", { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["anthropic-client-platform"], "claude_browser_extension");
  assert.equal(calls[0].headers["anthropic-client-version"], "1.0.91");
  assert.equal(calls[0].headers["content-type"], "application/json", "the caller's own headers survive");
  assert.equal(calls[0].headers["user-agent"], undefined, "a forbidden header is not attempted in the browser");
  assert.ok(store.__c2sDnrHeaderRules && store.__c2sDnrHeaderRules[1], "the rule is mirrored for the other contexts");
});

test("a request the rule's condition excludes is left alone, and a removed rule stops applying", async () => {
  const { sandbox, calls } = boot();
  await sandbox.chrome.declarativeNetRequest.updateSessionRules({ addRules: [claudeRule] });
  await sandbox.fetch("https://other.example.com/v1");
  assert.deepEqual(calls[0].headers, {}, "urlFilter mismatch");
  await sandbox.chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{ ...claudeRule, id: 2, condition: { urlFilter: "||api.example.com", initiatorDomains: ["claude.ai"] } }],
  });
  await sandbox.fetch("https://api.example.com/v1");
  assert.equal(calls[1].headers["anthropic-client-platform"], "claude_browser_extension", "rule 1 still matches");
  await sandbox.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] });
  await sandbox.fetch("https://api.example.com/v1");
  assert.deepEqual(calls[2].headers, {}, "rule 1 removed; rule 2 is keyed on an initiator domain the extension can never be");
});

test("urlFilter anchors and separators follow Chrome's syntax", async () => {
  const { sandbox, calls } = boot();
  const rule = (id, urlFilter) => ({ id, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "x-rule", operation: "set", value: String(id) }] }, condition: { urlFilter } });
  await sandbox.chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule(1, "||api.example.com^"), rule(2, "|https://exact.example.com/only|")] });
  await sandbox.fetch("https://sub.api.example.com/x");
  await sandbox.fetch("https://notapi.example.com/x");
  await sandbox.fetch("https://exact.example.com/only");
  await sandbox.fetch("https://exact.example.com/only?more");
  assert.equal(calls[0].headers["x-rule"], "1", "|| matches the host and its subdomains");
  assert.equal(calls[1].headers["x-rule"], undefined, "|| does not match a host that merely ends in it");
  assert.equal(calls[2].headers["x-rule"], "2", "| anchors both ends");
  assert.equal(calls[3].headers["x-rule"], undefined, "trailing | rejects extra characters");
});
