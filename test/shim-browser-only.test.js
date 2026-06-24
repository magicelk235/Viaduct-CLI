// Regression: Safari can expose `browser` with NO `chrome` global. A bare
// `browser !== chrome` in the shim then throws ReferenceError(chrome) and aborts
// the WHOLE shim — every stub below it never installs, cascading into "undefined
// is not an object" across runtime/scripting/dnr. (Hit Dark Reader live:
// "ReferenceError: Can't find variable: chrome (safari-compat-shim.js)".)
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Run the shim in a context where `browser` exists but `chrome` does NOT.
// Returns the globalThis we passed in so callers can assert what got published.
function runBrowserOnly(browser) {
  // No `chrome` param/binding at all → a bare `chrome` reference throws.
  const fn = new Function("browser", "self", "window", "globalThis", shimSource());
  const self = { addEventListener() {} };
  const glob = { browser };
  fn(browser, self, undefined, glob);
  return glob;
}

test("shim does not throw when `browser` exists but `chrome` is undefined", () => {
  const browser = { runtime: { id: "x", lastError: null, getManifest: () => ({}) }, storage: { local: {} }, scripting: {} };
  assert.doesNotThrow(() => runBrowserOnly(browser));
});

// Regression: the converted bundles call `chrome.*` directly at top level
// (popup.js: `chrome.storage.local`). When Safari gives a page only `browser`,
// a missing global `chrome` throws "chrome is not defined" and kills the whole
// script → blank popups / dead content scripts / dead background. The shim must
// publish `globalThis.chrome = browser` so those reads resolve.
test("shim publishes a global `chrome` aliased to `browser` when chrome is absent", () => {
  const browser = { runtime: { id: "x", getManifest: () => ({}) }, storage: { local: {} }, scripting: {} };
  const glob = runBrowserOnly(browser);
  assert.equal(glob.chrome, browser, "global chrome should alias browser");
});

test("shim backfills runtime/scripting enums on the browser namespace (no chrome)", () => {
  const browser = { runtime: { id: "x", getManifest: () => ({}) }, scripting: {} };
  runBrowserOnly(browser);
  assert.equal(browser.runtime.OnInstalledReason.INSTALL, "install");
  assert.equal(browser.scripting.ExecutionWorld.ISOLATED, "ISOLATED");
});

test("shim backfills runtime + DNR + scripting enums on chrome (normal case)", () => {
  const chrome = { runtime: { id: "x", getManifest: () => ({}) }, scripting: {}, declarativeNetRequest: {} };
  const fn = new Function("chrome", "self", "window", "globalThis", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome });
  assert.equal(chrome.runtime.OnInstalledReason.UPDATE, "update");
  assert.equal(chrome.scripting.ExecutionWorld.MAIN, "MAIN");
  assert.equal(chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, "modifyHeaders");
  assert.equal(typeof chrome.declarativeNetRequest.onRuleMatchedDebug.addListener, "function");
});

// Regression (H7): a far-future alarm (delayInMinutes huge) must not overflow
// setTimeout's 32-bit delay and fire immediately. The shim clamps to <=2^31-1
// and re-arms; verify no scheduled delay exceeds the cap and the alarm doesn't
// fire synchronously.
test("alarms polyfill clamps delays past setTimeout's 32-bit ceiling", () => {
  const MAX_DELAY = 2147483647;
  const delays = [];
  // Capture every setTimeout delay; don't actually run the callback.
  const fakeSetTimeout = (_fn, ms) => { delays.push(ms); return delays.length; };
  const chrome = { runtime: { id: "x", getManifest: () => ({}) }, scripting: {} };
  const fn = new Function(
    "chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout",
    shimSource()
  );
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, fakeSetTimeout, () => {});

  let fired = false;
  chrome.alarms.onAlarm.addListener(() => { fired = true; });
  // ~60 days out — well past the 24.8-day setTimeout ceiling.
  chrome.alarms.create("far", { delayInMinutes: 60 * 24 * 60 });

  assert.ok(delays.length > 0, "alarm should schedule a timer");
  assert.ok(delays.every((d) => d <= MAX_DELAY), `no delay should exceed ${MAX_DELAY}, got ${delays}`);
  assert.equal(fired, false, "far-future alarm must not fire immediately");
});

// Regression: Safari exposes some chrome.* sub-namespaces as FROZEN native objects.
// setIfMissing/defineProperty can't add to a frozen object, so enum/managed backfills
// silently vanished → the bundle re-read undefined, threw at SW eval, and onConnect
// never registered ("No onConnect listeners found"). The shim must swap a frozen
// namespace for an extensible clone and land the backfills there.
test("shim backfills survive FROZEN chrome.scripting / chrome.storage (Safari)", () => {
  const scripting = Object.freeze({ executeScript() {} });
  const realLocal = { get() {}, set() {} };
  const storage = Object.freeze({ local: realLocal, sync: { get() {}, set() {} } });
  const chrome = {
    runtime: { id: "x", getManifest: () => ({}), getURL: (p) => (p ? "safari-web-extension://ABC/" + p.replace(/^\//, "") : "") },
    scripting, storage, tabs: {},
  };
  const fn = new Function("chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, () => 0, () => {});

  assert.equal(chrome.scripting.ExecutionWorld.ISOLATED, "ISOLATED", "enum must land on a frozen scripting ns");
  assert.equal(typeof chrome.storage.managed.get, "function", "managed.get must land on a frozen storage ns");
  assert.equal(typeof chrome.storage.session.get, "function", "session.get must land on a frozen storage ns");
  assert.equal(chrome.storage.local, realLocal, "real storage.local must be preserved through the clone");
  // getURL("") must not return "" (uBlock's vAPI.getURL("").slice would crash).
  assert.ok(chrome.runtime.getURL("").length > 0, "getURL('') must yield a usable base URL");
});

// Regression (Grammarly): Safari's resource server is CASE-SENSITIVE on the UUID host
// for fetch()/XHR, but reports the host LOWERCASE in sender.origin. We lowercase the
// host ONLY for origin-derivation calls (getURL("")/"/"), and keep Safari's REAL host
// case for actual resource paths — else fetch(getURL("manifest.json")) 404s and an
// extension that loads its own bundled assets (Grammarly bg init) silently breaks.
test("getURL lowercases host for root arg only; keeps real case for resource paths", () => {
  const chrome = {
    runtime: {
      id: "x", getManifest: () => ({}),
      // Safari hands back an UPPERCASE UUID host.
      getURL: (p) => "safari-web-extension://F7737B2B-3F47/" + String(p || "").replace(/^\//, ""),
    },
    scripting: {}, storage: { local: {}, sync: {} }, tabs: {},
  };
  const fn = new Function("chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, () => 0, () => {});

  // Origin-derivation: host lowercased so `sender.origin === getURL('').slice(0,-1)` holds.
  assert.match(chrome.runtime.getURL(""), /^safari-web-extension:\/\/f7737b2b-3f47\//, "root arg → lowercase host");
  assert.match(chrome.runtime.getURL("/"), /^safari-web-extension:\/\/f7737b2b-3f47\//, "'/' → lowercase host");
  // Resource paths: REAL (uppercase) host preserved so Safari serves the file.
  assert.match(chrome.runtime.getURL("manifest.json"), /^safari-web-extension:\/\/F7737B2B-3F47\/manifest\.json$/, "resource path keeps real host case");
  assert.match(chrome.runtime.getURL("src/css/x.css"), /\/\/F7737B2B-3F47\/src\/css\/x\.css$/, "nested resource path keeps real host case");
});

// Regression: Safari's NATIVE i18n.getMessage throws "name value is invalid" for an
// empty key; Chrome returns "". uBlock calls getMessage("") in its popup → the throw
// killed popup init. The shim must wrap the throwing native to return "" instead.
test("i18n.getMessage('') returns '' instead of throwing (Safari native wrap)", () => {
  const i18n = {
    getMessage: (k) => { if (!k) throw new Error("The 'name' value is invalid, because it cannot be empty."); return "MSG:" + k; },
    getUILanguage: () => "en",
  };
  const chrome = {
    runtime: { id: "x", getManifest: () => ({}), getURL: (p) => (p ? "x://" + p : "") },
    scripting: {}, storage: { local: {}, sync: {} }, i18n, tabs: {},
  };
  const fn = new Function("chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, () => 0, () => {});

  assert.doesNotThrow(() => chrome.i18n.getMessage(""));
  assert.equal(chrome.i18n.getMessage(""), "");
  assert.equal(chrome.i18n.getMessage("hello"), "MSG:hello", "real keys still resolve via native");
});

// Regression: Safari's NATIVE alarms.create / menus.create / tabs.query are stricter
// than Chrome and THROW on arg shapes Chrome tolerates, aborting the caller. The shim
// wraps each native to soften validation (uBlock alarms.create(name), uBlock menus
// "abp:*" pattern, Grammarly tabs.query windowId:-1).
test("shim wraps strict Safari native alarms/menus/tabs to not throw on Chrome-valid args", () => {
  const alarmCalls = [], menuCalls = [], tabCalls = [];
  const chrome = {
    runtime: { id: "x", getManifest: () => ({}), getURL: (p) => (p ? "x://" + p : "") },
    scripting: {}, storage: { local: { get() {}, set() {} }, sync: { get() {}, set() {} } },
    alarms: {
      create(name, info) { if (info == null || typeof info !== "object") throw new Error("info must be object"); alarmCalls.push([name, info]); },
      onAlarm: { addListener() {} },
    },
    contextMenus: {
      create(p) { const pats = (p && p.targetUrlPatterns) || []; for (const x of pats) if (!/^(\*|https?|file|ftp):\/\//.test(x) && x !== "<all_urls>") throw new Error("bad pattern " + x); menuCalls.push(p); return 1; },
    },
    tabs: { query(info, cb) { if (info && info.windowId === -1) throw new Error("-1 invalid windowId"); tabCalls.push(info); if (cb) cb([]); return Promise.resolve([]); } },
  };
  const fn = new Function("chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, () => 0, () => {});

  assert.doesNotThrow(() => chrome.alarms.create("a"), "alarms.create(name) must not throw");
  assert.equal(typeof alarmCalls[0][1], "object", "alarms.create must receive an info object");

  assert.doesNotThrow(() => chrome.contextMenus.create({ title: "x", targetUrlPatterns: ["abp:*", "https://e.com/*"] }));
  assert.deepEqual(menuCalls[0].targetUrlPatterns, ["https://e.com/*"], "invalid patterns must be dropped, valid kept");

  assert.doesNotThrow(() => chrome.tabs.query({ windowId: -1, active: true }));
  assert.ok(!("windowId" in tabCalls[0]), "negative windowId must be stripped");
});

// Regression: Safari THROWS "Invalid call to runtime.connect(). No runtime.onConnect
// listeners found." when the non-persistent background page is suspended at connect()
// time — Chrome queues the port and wakes the worker. Every converted popup hit this
// (blank uBlock/Bitwarden/Grammarly popups). The shim wraps connect() to return a
// proxy Port that wakes the bg via sendMessage, retries, and flushes buffered traffic.
test("runtime.connect wakes a suspended background and flushes the proxy port", async () => {
  let awake = false, wakePings = 0, realPort = null;
  const runtime = {
    id: "x", getManifest: () => ({}), getURL: (p) => (p ? "x://" + p : ""),
    sendMessage(m) { if (m && m.__c2s_wake__) { wakePings++; setTimeout(() => { awake = true; }, 50); } return Promise.resolve(); },
    connect(args) {
      if (!awake) throw new Error("Invalid call to runtime.connect(). No runtime.onConnect listeners found.");
      realPort = {
        name: (args && args.name) || "", msgs: [], ml: [],
        postMessage(x) { this.msgs.push(x); }, disconnect() {},
        onMessage: { addListener: (f) => realPort.ml.push(f), removeListener() {}, hasListener() { return false; } },
        onDisconnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      };
      return realPort;
    },
    onConnect: { addListener() {} }, onMessage: { addListener() {} },
  };
  const chrome = { runtime, scripting: {}, storage: { local: {}, sync: {} }, tabs: {} };
  const fn = new Function("chrome", "self", "window", "globalThis", "setTimeout", "clearTimeout", shimSource());
  fn(chrome, { addEventListener() {} }, undefined, { chrome }, (f, ms) => setTimeout(f, ms), () => {});

  let port;
  assert.doesNotThrow(() => { port = chrome.runtime.connect({ name: "popup" }); }, "connect must not throw while bg is asleep");
  assert.equal(typeof port.postMessage, "function");
  port.postMessage({ hello: 1 });          // buffered
  port.onMessage.addListener(() => {});     // forwarded later
  assert.ok(wakePings >= 1, "must ping the background to wake it");

  await new Promise((r) => setTimeout(r, 300)); // let the bg wake + retry land
  assert.ok(realPort, "real port should connect after the bg wakes");
  assert.equal(realPort.msgs[0].hello, 1, "buffered message must flush to the real port");
  assert.equal(realPort.ml.length, 1, "listener must forward to the real port");
});

// ROOT CAUSE (the one that made every other fix ineffective live): Safari exposes
// the ENTIRE namespace tree frozen — `browser` itself AND `browser.runtime`,
// `browser.storage`, etc. A raw `api.storage.sync = {…}` then throws and ESCAPES
// its block, aborting the whole prepended shim (dead popup/content/bg). And every
// `parent[key] = …` backfill no-ops on the frozen parent, so getURL stays
// unwrapped / sync never installs / connect is never proxied — the exact live
// symptoms. The shim must (a) never let a block-level throw abort it and (b)
// republish extensible clones on the reassignable GLOBAL bindings so the backfills
// land and bundle code (`browser.runtime.getURL`) reads the patched namespace.
// Use a real VM context so `browser`/`chrome` are live globals (reassigning
// globalThis.browser updates what `browser` resolves to) — a Function-param mock
// can't model that and would hide the bug.
test("shim survives a FULLY frozen Safari root (browser + sub-namespaces) and still patches", () => {
  const realRuntime = {
    id: "x", getManifest: () => ({}),
    // Native getURL bound to its own namespace: bare-copied (uBlock vAPI.getURL =
    // browser.runtime.getURL) it must still work, and getURL("") must be usable.
    getURL(p) { if (this !== realRuntime) throw new Error("Can only be called on browser.runtime"); return p ? "safari-web-extension://ABC/" + p.replace(/^\//, "") : ""; },
    connect() { throw new Error("Invalid call to runtime.connect(). No runtime.onConnect listeners found."); },
    sendMessage() { return Promise.resolve(); },
    onConnect: { addListener() {} }, onMessage: { addListener() {} },
  };
  const storage = Object.freeze({ local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); }, remove() {}, clear() {} } });
  const i18n = Object.freeze({ getMessage: (k) => { if (!k) throw new Error("empty"); return "M" + k; }, getUILanguage: () => "en" });
  const browser = Object.freeze({ runtime: Object.freeze(realRuntime), scripting: Object.freeze({}), storage, i18n, tabs: {} });

  const ctx = { browser, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctx.globalThis = ctx; ctx.window = undefined;
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(shimSource(), ctx), "frozen root must not abort the shim");

  const g = vm.runInContext("({ b: browser, c: chrome })", ctx);
  assert.notEqual(g.b, browser, "frozen browser must be republished as an extensible clone");
  assert.equal(g.c, g.b, "chrome must stay aliased to the (thawed) browser on Safari");
  // uBlock: vAPI.getURL = browser.runtime.getURL; vAPI.getURL("").slice(0,-1)
  const copiedGetURL = g.b.runtime.getURL;
  assert.ok(copiedGetURL("").length > 0, "getURL('') must yield a usable base even when copied off the ns");
  assert.equal(typeof g.b.storage.sync.get, "function", "storage.sync must install onto a frozen storage ns");
  assert.equal(g.b.i18n.getMessage(""), "", "i18n.getMessage('') must be softened, not throw");
  assert.doesNotThrow(() => g.b.runtime.connect({ name: "popup" }), "connect must proxy, not throw, while bg is asleep");
});

// ROOT CAUSE #2 (Bitwarden: `chrome.scripting.ExecutionWorld.ISOLATED` undefined in
// the bg). Pinned via live diagnostics: Safari's native `chrome.scripting` is an
// EXOTIC, IMMUTABLE host slot — assign and defineProperty return WITHOUT throwing but
// are NO-OPS, and `delete` returns true yet the empty native slot re-materializes. So
// the enum CANNOT be installed from JS at all; the converter inlines the reads to
// literals instead (see test/inline-enums.test.js). The shim's backfillScripting is
// only a best-effort for the MUTABLE case (content scripts / non-Safari). Assert two
// things: (a) when scripting IS mutable, the enums land; (b) when it's the immutable
// exotic slot, the shim does NOT throw (the host script must keep running).
test("scripting backfill lands on a mutable namespace and never throws on an immutable one", () => {
  // (a) mutable
  const mutableChrome = {
    runtime: { id: "x", getManifest: () => ({}), getURL: (p) => (p ? "x://" + p : "") },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: {}, tabs: {},
  };
  const ctxA = { chrome: mutableChrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctxA.globalThis = ctxA;
  vm.createContext(ctxA);
  vm.runInContext(shimSource(), ctxA);
  assert.equal(vm.runInContext("chrome.scripting.ExecutionWorld.ISOLATED", ctxA), "ISOLATED", "enum lands on a mutable scripting");

  // (b) immutable exotic slot: assign/define are silent no-ops. Modeled with a
  // Proxy whose defineProperty/set succeed-but-ignore. The shim must not throw.
  const realScripting = { executeScript() {} };
  const immutableScripting = new Proxy(realScripting, {
    set() { return true; },                 // pretend success, change nothing
    defineProperty() { return true; },       // pretend success, change nothing
    deleteProperty() { return true; },
  });
  const immutableChrome = {
    runtime: { id: "x", getManifest: () => ({}), getURL: (p) => (p ? "x://" + p : "") },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: immutableScripting, tabs: {},
  };
  const ctxB = { chrome: immutableChrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctxB.globalThis = ctxB;
  vm.createContext(ctxB);
  assert.doesNotThrow(() => vm.runInContext(shimSource(), ctxB), "immutable scripting must not abort the shim");
});

// ROOT CAUSE #3 (uBlock/Grammarly blank popup, even though connect() succeeds
// natively). Live-proven: Safari reports the extension UUID UPPERCASE in
// `runtime.getURL()`/`sender.url` but LOWERCASE in `port.sender.origin`. Extensions
// privilege-gate their own pages with `sender.origin === getURL('').slice(0,-1)`
// (uBlock PRIVILEGED_ORIGIN). The case mismatch makes that false → the popup's port
// is judged unprivileged → privileged channels (getPopupData) go unanswered → blank
// popup. sender.origin can't be patched (it's an exotic fresh-object getter — proven
// live: mutations don't persist across reads). The URL authority is case-insensitive
// per RFC 3986, so the fix is patchGetURL LOWERCASING the extension host in getURL()'s
// output. Then the bundle's PRIVILEGED_ORIGIN (from getURL) is lowercase and equals
// the lowercase sender.origin.
test("getURL lowercases the extension host so origin === getURL-derived passes (Safari)", () => {
  const UPPER = "safari-web-extension://C16B51B5-85C1-41D4-A8F6-1C3DAD4D1098";
  const lower = UPPER.toLowerCase();
  const chrome = {
    runtime: {
      id: "x", getManifest: () => ({}),
      // Safari native getURL → UPPERCASE host, with a (case-sensitive) path kept as-is.
      getURL: (p) => UPPER + "/" + (p == null ? "" : p),
      connect() { throw new Error("noop"); },
      sendMessage() { return Promise.resolve(); },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: {}, tabs: {},
  };
  const ctx = { chrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(shimSource(), ctx);

  // getURL('') host must now be lowercase → matches the lowercase sender.origin.
  const privilegedOrigin = vm.runInContext("chrome.runtime.getURL('').replace(/\\/+$/,'')", ctx);
  assert.equal(privilegedOrigin, lower, "getURL-derived privileged origin must be lowercase");
  // A real RESOURCE path must keep Safari's REAL host case (UPPER) — Safari's resource
  // server is case-sensitive on the host for fetch()/XHR; lowercasing it 404s the load
  // (live-proven on Grammarly). Only the empty/root origin-derivation call is lowercased.
  const res = vm.runInContext("chrome.runtime.getURL('js/POPUP-Fenix.js')", ctx);
  assert.equal(res, UPPER + "/js/POPUP-Fenix.js", "resource path keeps real (upper) host case + path case");
  // The bundle's check: sender.origin (lowercase) === PRIVILEGED_ORIGIN (now lowercase).
  assert.equal(lower, privilegedOrigin, "lowercase sender.origin now equals the privileged origin");
});

// ROOT CAUSE #4 (Grammarly popup stuck "Grammarly is starting…" — posted:0). The bg
// routes the popup PORT by matching sender.url against a regex built from
// chrome.runtime.id: `new RegExp(chrome.runtime.id + "/src/popup.html").test(sender.url)`.
// On Safari chrome.runtime.id is the LOWERCASE uuid but sender.url carries the UPPERCASE
// host → no match → the port is never stored in the bg's port table → the bg posts no
// reply → every popup-init RPC (getPageConfig/getExperimentTreatment) times out → the
// popup hangs forever. The shim must hand the bundle's onConnect listener a port whose
// sender.url host is lowercased to match runtime.id, WITHOUT breaking the reply path
// (the bg replies via that same port's postMessage). sender.url itself is unpatchable
// on Safari (frozen exotic getter — emulated here with a frozen sender), so the shim
// passes a shallow clone that forwards postMessage to the real port.
test("onConnect: sender.url host is lowercased for runtime.id routing, replies still reach the real port (Safari)", () => {
  const UPPER = "safari-web-extension://C16B51B5-85C1-41D4-A8F6-1C3DAD4D1098";
  const RUNTIME_ID = "c16b51b5-85c1-41d4-a8f6-1c3dad4d1098"; // Safari runtime.id: lowercase uuid
  let captured = null; // the wrapped listener the shim installed
  // CRITICAL: Safari's native onConnect is an event object whose addListener is
  // { writable:false, configurable:true } (proven live). A bare `oc.addListener = …`
  // THROWS in strict mode here, so the shim must use defineProperty to install its
  // wrapper. Model that exact descriptor — a plain writable method would let a broken
  // (assignment-only) shim pass while silently failing on real Safari.
  const nativeEvent = (capture) => {
    const ev = {};
    Object.defineProperty(ev, "addListener", {
      value: capture, writable: false, enumerable: true, configurable: true,
    });
    ev.removeListener = () => {};
    ev.hasListener = () => false;
    return ev;
  };
  const chrome = {
    runtime: {
      id: RUNTIME_ID, getManifest: () => ({}),
      getURL: (p) => UPPER + "/" + (p == null ? "" : p),
      connect() { throw new Error("noop"); },
      sendMessage() { return Promise.resolve(); },
      onConnect: nativeEvent((fn) => { captured = fn; }),
      onMessage: nativeEvent(() => {}),
    },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: {}, tabs: {},
  };
  const ctx = { chrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(shimSource(), ctx);

  // The bg registers its port router (mirrors Grammarly's Oa()-gated _initPortListener).
  const popupRe = new RegExp(chrome.runtime.id + "/src/popup.html");
  const tabPorts = {};
  let routedId = undefined;
  chrome.runtime.onConnect.addListener(function (port) {
    // Route by sender.url, exactly like Grammarly's Oa(): popover has no sender.tab.
    routedId = popupRe.test(port.sender.url) ? "popup" : undefined;
    if (routedId) {
      (tabPorts[routedId] = tabPorts[routedId] || []).push(port);
      // The reply path: the bg posts back on the SAME port.
      port.postMessage({ rpc: "reply", ok: true });
    }
  });
  assert.equal(typeof captured, "function", "shim must wrap onConnect.addListener");

  // Simulate Safari delivering a FROZEN exotic port: sender.url via getter (UPPER host),
  // sender + port frozen so direct mutation can't work — only a clone can normalize.
  const replies = [];
  const sender = {};
  Object.defineProperty(sender, "url", { get() { return UPPER + "/src/popup.html"; }, enumerable: true, configurable: false });
  Object.defineProperty(sender, "origin", { get() { return UPPER.toLowerCase(); }, enumerable: true, configurable: false });
  Object.freeze(sender);
  // CRITICAL: Safari's native Port.postMessage BRAND-CHECKS its receiver — called with a
  // `this` that isn't the real native port it throws "Can only be called on a Port
  // object". Model that here with a WeakMap-backed private slot only realPort has, so a
  // wrapper built with Object.create(realPort) (this === clone) would FAIL to deliver the
  // reply, while a wrapper that forwards bound to realPort succeeds. (Without this brand
  // check the test passes even for a broken Object.create clone — which is exactly how the
  // bug shipped: bg routed the port but every reply silently threw → popup stuck.)
  const slot = new WeakMap();
  const brand = (fn) => function (...a) {
    if (!slot.has(this)) throw new TypeError("postMessage: Can only be called on a Port object");
    return fn.apply(this, a);
  };
  const realPort = {
    name: "message:to-priv",
    sender,
    postMessage: brand(function (m) { replies.push(m); }),
    disconnect: brand(function () {}),
    onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onDisconnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
  };
  slot.set(realPort, true); // only the real port is branded
  Object.freeze(realPort);

  // Fire the shim-wrapped listener with the frozen Safari port.
  captured(realPort);

  // 1) Routing now succeeds: the bundle saw a lowercased sender.url → port stored as "popup".
  assert.equal(routedId, "popup", "runtime.id-vs-sender.url routing must match after host lowercasing");
  assert.equal((tabPorts.popup || []).length, 1, "popup port must be stored in the bg port table");
  // 2) The reply the bg posted reached the REAL port — and did NOT throw despite the
  //    native brand check, proving the wrapper forwards postMessage bound to the real port.
  assert.deepEqual(replies, [{ rpc: "reply", ok: true }], "bg reply must reach the real popup port without a brand-check throw");
});

// Same routing fix for one-shot messages (onMessage): some backgrounds run the
// runtime.id-vs-sender.url match on onMessage senders too. The wrapped listener must
// observe a lowercased sender.url host while sendResponse still works.
test("onMessage: sender.url host is lowercased for runtime.id routing (Safari)", () => {
  const UPPER = "safari-web-extension://C16B51B5-85C1-41D4-A8F6-1C3DAD4D1098";
  const RUNTIME_ID = "c16b51b5-85c1-41d4-a8f6-1c3dad4d1098";
  let capturedMsg = null;
  // Safari native event: addListener non-writable (see onConnect test above). The shim
  // must defineProperty its wrapper, not assign it.
  const nativeEvent = (capture) => {
    const ev = {};
    Object.defineProperty(ev, "addListener", { value: capture, writable: false, enumerable: true, configurable: true });
    ev.removeListener = () => {};
    ev.hasListener = () => false;
    return ev;
  };
  const chrome = {
    runtime: {
      id: RUNTIME_ID, getManifest: () => ({}),
      getURL: (p) => UPPER + "/" + (p == null ? "" : p),
      connect() { throw new Error("noop"); }, sendMessage() { return Promise.resolve(); },
      onConnect: nativeEvent(() => {}),
      onMessage: nativeEvent((fn) => { capturedMsg = fn; }),
    },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: {}, tabs: {},
  };
  const ctx = { chrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(shimSource(), ctx);

  const popupRe = new RegExp(chrome.runtime.id + "/src/popup.html");
  let seenUrl = null, matched = false;
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    seenUrl = sender.url;
    matched = popupRe.test(sender.url);
    sendResponse({ ok: true });
    return true;
  });
  assert.equal(typeof capturedMsg, "function", "shim must wrap onMessage.addListener");

  const sender = {};
  Object.defineProperty(sender, "url", { get() { return UPPER + "/src/popup.html"; }, enumerable: true, configurable: false });
  Object.freeze(sender);
  let responded = null;
  capturedMsg({ type: "x" }, sender, (r) => { responded = r; });

  assert.equal(seenUrl, UPPER.toLowerCase() + "/src/popup.html", "listener must see a lowercased sender.url host");
  assert.equal(matched, true, "runtime.id-vs-sender.url match must succeed");
  assert.deepEqual(responded, { ok: true }, "sendResponse must still work through the wrapper");
});

// Safari's chrome.runtime.id is the App-Extension BUNDLE id (e.g.
// "com.viaduct.Foo.Extension (TEAMID)"), NOT the per-install UUID that is the host of
// getURL()/sender.url. On Chrome the two are identical, and bundles route the popup port
// with `new RegExp(chrome.runtime.id + "/src/popup.html").test(sender.url)` (Grammarly's
// Oa). On Safari that regex can never match — bundle id vs uuid, and the bundle id even
// carries regex metachars (spaces, parens). Live-proven the popup hangs: the port is
// never routed, the bg posts no reply, getPageConfig never resolves. The shim overrides
// runtime.id to the UUID from getURL("") so the invariant Chrome bundles assume holds.
test("runtime.id is rewritten to the UUID host so runtime.id-vs-sender.url routing matches (Safari)", () => {
  const UUID = "10dfae67-ca8e-481d-921f-52342ed81d67";
  const UPPER_HOST = UUID.toUpperCase();
  const BUNDLE_ID = "com.viaduct.GrammarlyApp.Extension (V8K8L3ZSD5)"; // Safari's real runtime.id
  const chrome = {
    runtime: {
      getManifest: () => ({}),
      // Safari getURL → the UUID host (uppercased; patchGetURL lowercases the root arg).
      getURL: (p) => "safari-web-extension://" + UPPER_HOST + "/" + (p == null ? "" : p),
      connect() { throw new Error("noop"); },
      sendMessage() { return Promise.resolve(); },
      onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
      onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    },
    storage: { local: { get() {}, set() {} }, sync: { get() {} } },
    scripting: {}, tabs: {},
  };
  // id is a native-style prop returning the bundle id (Safari).
  Object.defineProperty(chrome.runtime, "id", { value: BUNDLE_ID, writable: false, enumerable: true, configurable: true });
  const ctx = { chrome, self: { addEventListener() {} }, setTimeout: () => 0, clearTimeout() {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(shimSource(), ctx);

  // 1) runtime.id is now the UUID (lowercase), not the bundle id.
  assert.equal(chrome.runtime.id, UUID, "runtime.id must be rewritten to the UUID host");

  // 2) Grammarly's exact popup-routing regex now matches the (lowercased) sender.url host.
  //    Without the fix, RegExp(BUNDLE_ID + ...) could never match a uuid url.
  const popupRe = new RegExp(chrome.runtime.id + "/src/popup.html");
  const loweredUrl = "safari-web-extension://" + UUID + "/src/popup.html?tabId=1";
  assert.equal(popupRe.test(loweredUrl), true, "runtime.id (UUID) regex must match the lowercased popup url");

  // Anti-vacuous: the original bundle id would NOT have matched the uuid url.
  assert.equal(new RegExp(BUNDLE_ID + "/src/popup.html").test(loweredUrl), false, "bundle id could never match the uuid url");
});
