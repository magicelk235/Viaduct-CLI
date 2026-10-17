import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari accepts a declarativeNetRequest redirect rule and never redirects (a block
// rule in the same store blocks), and refuses a regexFilter with alternation. Stylus
// installs a .user.css from any site through such a rule, regexFilter
// `^.*\.user\.(?:css|less|styl)(?:\?.*)?$` redirecting to its install page, so the
// style just displayed as text. The shim keeps the extension's top-frame redirect
// rules and performs them from the background page.

function storageArea(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    data,
    get(key, cb) { const out = {}; if (key in data) out[key] = data[key]; cb?.(out); return Promise.resolve(out); },
    set(obj, cb) { Object.assign(data, JSON.parse(JSON.stringify(obj))); cb?.(); return Promise.resolve(); },
  };
}

// Shim timers must not keep the test process alive.
const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };
function boot({ local = {}, session = {} } = {}) {
  const navListeners = [];
  const updates = [];
  const sent = [];
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    location: { href: "safari-web-extension://TEST/background.html", protocol: "safari-web-extension:", pathname: "/background.html", origin: "safari-web-extension://TEST" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + String(p).replace(/^\//, ""),
        onMessage: { addListener() {}, removeListener() {} },
        onConnect: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      storage: { local: storageArea(local), session: storageArea(session), onChanged: { addListener() {} } },
      tabs: { update(tabId, props) { updates.push([tabId, props.url]); return Promise.resolve({}); } },
      webNavigation: { onBeforeNavigate: { addListener(fn) { navListeners.push(fn); }, removeListener() {} } },
      declarativeNetRequest: {
        updateSessionRules(opts) { sent.push(["session", opts]); return Promise.resolve(); },
        updateDynamicRules(opts) { sent.push(["dynamic", opts]); return Promise.resolve(); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  const nav = (url, { tabId = 5, frameId = 0 } = {}) => { for (const fn of navListeners) fn({ tabId, frameId, url, parentFrameId: -1, timeStamp: 0 }); };
  return { dnr: sandbox.chrome.declarativeNetRequest, nav, updates, sandbox };
}

const STYLUS_RULE = {
  id: 1,
  condition: {
    regexFilter: /^.*\.user\.(?:css|less|styl)(?:\?.*)?$/.source,
    resourceTypes: ["main_frame"],
    responseHeaders: [{ header: "content-type", values: ["text/*"], excludedValues: ["text/html*"] }],
  },
  action: { type: "redirect", redirect: { regexSubstitution: "safari-web-extension://TEST/install-usercss.html#\\0" } },
};

test("a top-frame redirect rule sends the tab to its target, alternation included", async () => {
  const { dnr, nav, updates } = boot();
  await dnr.updateDynamicRules({ removeRuleIds: [1], addRules: [STYLUS_RULE] });
  nav("https://example.org/themes/dark.user.less?v=2");
  assert.deepEqual(updates, [[5, "safari-web-extension://TEST/install-usercss.html#https://example.org/themes/dark.user.less?v=2"]]);
  nav("https://example.org/plain.css");
  assert.equal(updates.length, 1, "a URL the rule doesn't match stays put");
});

test("only the top frame of a main_frame rule is redirected", async () => {
  const { dnr, nav, updates } = boot();
  await dnr.updateSessionRules({ addRules: [
    STYLUS_RULE,
    { id: 2, condition: { urlFilter: "||ads.example^" }, action: { type: "redirect", redirect: { url: "https://example.net/" } } },
  ] });
  nav("https://example.org/a.user.css", { frameId: 7 });
  nav("https://ads.example/x");
  assert.deepEqual(updates, [], "sub-frames, and rules without main_frame (Chrome's default), are left alone");
});

test("a higher or equal priority allow rule wins over the redirect", async () => {
  const { dnr, nav, updates } = boot();
  await dnr.updateDynamicRules({ addRules: [
    { id: 1, priority: 1, condition: { urlFilter: "||example.com^", resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { url: "https://example.net/" } } },
    { id: 2, priority: 1, condition: { urlFilter: "||example.com/keep", resourceTypes: ["main_frame"] }, action: { type: "allow" } },
    { id: 3, priority: 5, condition: { urlFilter: "||example.com/high", resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { url: "https://example.org/" } } },
    { id: 4, priority: 2, condition: { urlFilter: "||example.com/high", resourceTypes: ["main_frame"] }, action: { type: "allow" } },
  ] });
  nav("https://example.com/keep/1");
  nav("https://example.com/high", { tabId: 6 });
  nav("https://example.com/other", { tabId: 7 });
  assert.deepEqual(updates, [[6, "https://example.org/"], [7, "https://example.net/"]]);
});

test("removing a rule stops the redirect, per store", async () => {
  const { dnr, nav, updates } = boot();
  const rule = { id: 9, condition: { urlFilter: "||example.com^", resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } } };
  await dnr.updateSessionRules({ addRules: [rule] });
  await dnr.updateDynamicRules({ addRules: [rule] });
  await dnr.updateDynamicRules({ removeRuleIds: [9] });
  nav("https://example.com/");
  assert.deepEqual(updates, [[5, "safari-web-extension://TEST/blocked.html"]], "the session rule with the same id still holds");
  await dnr.updateSessionRules({ removeRuleIds: [9] });
  nav("https://example.com/", { tabId: 8 });
  assert.equal(updates.length, 1);
});

test("the redirect's own target is not redirected again", async () => {
  const { dnr, nav, updates } = boot();
  await dnr.updateDynamicRules({ addRules: [
    { id: 1, condition: { urlFilter: "||example.com^", resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { transform: { queryTransform: { addOrReplaceParams: [{ key: "safe", value: "1" }] } } } } },
  ] });
  nav("https://example.com/search?q=x");
  nav("https://example.com/search?q=x&safe=1");
  assert.deepEqual(updates, [[5, "https://example.com/search?q=x&safe=1"]]);
});

test("conditions on request domains and tabs are honored", async () => {
  const { dnr, nav, updates } = boot();
  await dnr.updateDynamicRules({ addRules: [
    { id: 1, condition: { requestDomains: ["example.com"], excludedRequestDomains: ["keep.example.com"], excludedTabIds: [3], resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { url: "https://example.net/" } } },
  ] });
  nav("https://www.example.com/");
  nav("https://keep.example.com/", { tabId: 6 });
  nav("https://www.example.com/", { tabId: 3 });
  nav("https://notexample.com/", { tabId: 4 });
  assert.deepEqual(updates, [[5, "https://example.net/"]]);
});

test("dynamic rules survive a background restart, session rules stay in the session", async () => {
  const first = boot();
  const rule = (id, url) => ({ id, condition: { urlFilter: "||example.com^", resourceTypes: ["main_frame"] }, action: { type: "redirect", redirect: { url } } });
  await first.dnr.updateDynamicRules({ addRules: [rule(1, "https://example.net/")] });
  await first.dnr.updateSessionRules({ addRules: [rule(2, "https://example.org/")] });
  assert.ok(!first.sandbox.chrome.storage.local.data.__c2sDnrNavRules["2"], "a session rule must not outlive the session");

  const restarted = boot({ local: first.sandbox.chrome.storage.local.data });
  await new Promise((r) => setTimeout(r, 0));
  restarted.nav("https://example.com/");
  assert.deepEqual(restarted.updates, [[5, "https://example.net/"]]);
});
