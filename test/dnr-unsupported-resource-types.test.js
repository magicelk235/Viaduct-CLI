import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Safari refuses four of Chrome's DNR resource types outright. Submitting one rule per
// type to updateSessionRules on Safari Technology Preview, `object`, `csp_report`,
// `webtransport` and `webbundle` throw
//
//   Invalid call to declarativeNetRequest.updateSessionRules(). The 'addRules' value is
//   invalid, because an error with rule at index 20: Rule with id 27 is invalid. The
//   value in the `resourceTypes` array is invalid.
//
// and one such rule fails the whole batch. The shim's salvage then re-adds every rule one
// call at a time, and each call recompiles the extension's content rule list: AdGuard's
// 715 session rules landed about one per 7 s, so its engine start never finished. Safari
// never classifies a request as any of those types, so the shim removes them before the
// call and the batch lands in one go.

const ORIGIN = "safari-web-extension://e3aef829-d4b2-4f9f-8cca-aa2d0f1cd13a";
const REFUSED = new Set(["object", "csp_report", "webtransport", "webbundle"]);
const SAFARI_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "xmlhttprequest", "ping", "media", "websocket", "other"];

function runShim() {
  const timers = new Set();
  const calls = [];
  const attempts = [];
  const nativeUpdate = (name) => function (opts, cb) {
    attempts.push(name);
    (opts.addRules || []).forEach((r, i) => {
      const c = r.condition || {};
      for (const t of [].concat(c.resourceTypes || [], c.excludedResourceTypes || [])) {
        if (REFUSED.has(t)) {
          throw new Error(`Invalid call to declarativeNetRequest.${name}(). The 'addRules' value is invalid, because an error with rule at index ${i}: Rule with id ${r.id} is invalid. The value in the \`resourceTypes\` array is invalid.`);
        }
      }
      if (c.regexFilter && c.regexFilter.includes("(?=")) {
        throw new Error(`Invalid call to declarativeNetRequest.${name}(). The 'addRules' value is invalid, because an error with rule at index ${i}: Rule with id ${r.id} is invalid. \`regexFilter\` is not a valid regular expression.`);
      }
    });
    calls.push([name, opts]);
    if (typeof cb === "function") { cb(); return; }
    return Promise.resolve();
  };
  const area = {
    get: (_k, cb) => { if (typeof cb === "function") cb({}); return Promise.resolve({}); },
    set: (_o, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
    remove: (_k, cb) => { if (typeof cb === "function") cb(); return Promise.resolve(); },
  };
  const chrome = {
    runtime: {
      id: "com.viaduct.Test.Extension",
      lastError: null,
      getURL: (p) => ORIGIN + "/" + String(p == null ? "" : p).replace(/^\.?\//, ""),
      getManifest: () => ({ manifest_version: 3, permissions: ["declarativeNetRequest"] }),
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener() {}, removeListener() {}, hasListener: () => false },
      onConnect: { addListener() {}, removeListener() {}, hasListener: () => false },
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
    },
    declarativeNetRequest: {
      updateSessionRules: nativeUpdate("updateSessionRules"),
      updateDynamicRules: nativeUpdate("updateDynamicRules"),
      getSessionRules: () => Promise.resolve([]),
      getDynamicRules: () => Promise.resolve([]),
    },
    storage: { local: area, sync: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { query: () => Promise.resolve([]), onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const href = ORIGIN + "/background.html";
  const url = new URL(href);
  const sandbox = {
    chrome, browser: chrome, console, Promise, JSON, Object, Array, Error, Date, Math,
    String, Number, Boolean, URL, URLSearchParams, Symbol, Proxy, Reflect, Map, Set,
    WeakMap, RegExp, TypeError, isNaN, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent,
    location: { href, protocol: url.protocol, origin: url.origin, pathname: url.pathname, search: url.search },
    navigator: { userAgent: "test" },
    history: { state: null, pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    document: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { timers.delete(h); clearTimeout(h); },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearInterval: (h) => { timers.delete(h); clearInterval(h); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ origin: "", hosts: [] }), sandbox, { filename: "safari-compat-shim.js" });
  const dispose = () => { for (const h of timers) { clearTimeout(h); clearInterval(h); } timers.clear(); };
  return { chrome: sandbox.chrome, calls, attempts, dispose };
}

const block = (id, condition) => ({ id, priority: 1, action: { type: "block" }, condition: Object.assign({ urlFilter: "||ads.example^" }, condition) });

test("a batch with refused resource types lands in ONE native call", async (t) => {
  const { chrome, calls, dispose } = runShim();
  t.after(dispose);

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [5],
    addRules: [
      block(1, { resourceTypes: ["script", "image"] }),
      block(2, { resourceTypes: ["csp_report"] }),
      block(3, { resourceTypes: ["object", "sub_frame", "webbundle"] }),
      block(4, { excludedResourceTypes: ["webtransport", "main_frame"] }),
      block(6, {}),
    ],
  });

  assert.equal(calls.length, 1, "no one-rule-at-a-time salvage");
  const [, opts] = calls[0];
  assert.deepEqual(opts.removeRuleIds, [5]);
  const byId = Object.fromEntries(opts.addRules.map((r) => [r.id, r.condition]));
  assert.deepEqual(byId[1].resourceTypes, ["script", "image"], "untouched when every type is supported");
  assert.equal(byId[2], undefined, "a rule for a type Safari never produces matches nothing, so it goes");
  assert.deepEqual(byId[3].resourceTypes, ["sub_frame"], "mixed rules keep the types Safari has");
  assert.deepEqual(byId[4].excludedResourceTypes, ["main_frame"]);
  assert.deepEqual(byId[6], { urlFilter: "||ads.example^" }, "a rule without types is left alone");
});

test("emptied exclusions keep matching main_frame, as Chrome did with the exclusion list present", async (t) => {
  const { chrome, calls, dispose } = runShim();
  t.after(dispose);

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [block(7, { excludedResourceTypes: ["csp_report"] })] });

  assert.equal(calls.length, 1);
  const c = calls[0][1].addRules[0].condition;
  assert.equal(c.excludedResourceTypes, undefined);
  assert.deepEqual([...c.resourceTypes], SAFARI_TYPES);
});

test("the extension's own rule objects are not mutated", async (t) => {
  const { chrome, dispose } = runShim();
  t.after(dispose);

  const rule = block(8, { resourceTypes: ["object", "image"] });
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
  assert.deepEqual(rule.condition.resourceTypes, ["object", "image"]);
});

// Safari validates every rule SYNCHRONOUSLY and names the first bad one by index; only
// an accepted call pays for the recompile. So a rule Safari's validator refuses (here a
// lookahead, outside WebKit's regex subset) is dropped by index and the rest resubmitted,
// instead of falling into the one-rule-per-call salvage.
test("rules Safari's validator refuses are dropped by index and the rest land in one accepted call", async (t) => {
  const { chrome, calls, attempts, dispose } = runShim();
  t.after(dispose);

  const rules = [];
  for (let i = 1; i <= 50; i++) rules.push(block(i, { resourceTypes: ["script"] }));
  rules[10] = { id: 11, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https://a(?=b)" } };
  rules[40] = { id: 41, priority: 1, action: { type: "block" }, condition: { regexFilter: "^https://c(?=d)" } };
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });

  assert.equal(calls.length, 1, "one accepted call");
  assert.equal(attempts.length, 3, "one refused attempt per bad rule, then the accepted one");
  const ids = calls[0][1].addRules.map((r) => r.id);
  assert.equal(ids.length, 48);
  assert.ok(!ids.includes(11) && !ids.includes(41));
});

test("the callback form drops refused rules the same way", async (t) => {
  const { chrome, calls, dispose } = runShim();
  t.after(dispose);

  const rules = [block(1, {}), { id: 2, priority: 1, action: { type: "block" }, condition: { regexFilter: "x(?=y)" } }, block(3, {})];
  await new Promise((resolve) => chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules }, resolve));
  assert.deepEqual(calls.map((c) => c[1].addRules.map((r) => r.id)), [[1, 3]]);
});
