import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Salesforce Inspector (and other XHR-only extensions) do cross-origin authenticated
// API calls with new XMLHttpRequest() → open() → setRequestHeader("Authorization",...)
// → send(). From the safari-web-extension:// origin Safari CORS-blocks those (status 0)
// and strips the site cookies as third-party, so every call fails as a bogus
// "offline/network" error. The shim's XHR wrapper must route proxy-host XHRs through the
// SAME native-host path the fetch wrapper uses, then SYNTHESIZE the XHR response so the
// caller's onreadystatechange/onload see success with the proxied status/body.
//
// This drives the real integration: a fake native `fetch` that CORS-rejects the target
// (as Safari would), the shim's own fetch patch retrying via proxyFetch → sendToHost, and
// a fake sendNativeMessage standing in for the Swift host. We then read back the synthetic
// xhr.status / xhr.responseText / xhr.response exactly as inspector.js does.

// Minimal XMLHttpRequest whose read-only response props live on the PROTOTYPE (like the
// platform), so we prove the shim's per-instance defineProperty getters actually shadow
// them. A direct send() just reports a CORS block (status 0), which is what the shim
// detects and replays.
function makeXHRClass(sandbox) {
  function FakeXHR() {
    this.readyState = 0;
    this._reqHeaders = {};
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.responseType = "";
    this.timeout = 0;
  }
  // Prototype accessors: assigning to this.status on an instance must NOT be how the
  // shim writes the proxied value — it has to defineProperty over these.
  Object.defineProperty(FakeXHR.prototype, "status", { configurable: true, get() { return this._status || 0; } });
  Object.defineProperty(FakeXHR.prototype, "statusText", { configurable: true, get() { return this._statusText || ""; } });
  Object.defineProperty(FakeXHR.prototype, "responseText", { configurable: true, get() { return this._responseText || ""; } });
  Object.defineProperty(FakeXHR.prototype, "response", { configurable: true, get() { return this._response == null ? null : this._response; } });
  FakeXHR.prototype.open = function (m, u, async) { this._m = m; this._u = u; this._async = async; this.readyState = 1; };
  FakeXHR.prototype.setRequestHeader = function (k, v) { this._reqHeaders[k] = v; };
  FakeXHR.prototype.getResponseHeader = function () { return null; };
  FakeXHR.prototype.getAllResponseHeaders = function () { return ""; };
  FakeXHR.prototype.dispatchEvent = function () { return true; };
  // A native send: a cross-origin proxy host is CORS-blocked → readyState 4, status 0.
  // If the shim short-circuits (proxy path) this is never called.
  FakeXHR.prototype.send = function () {
    this._status = 0; this._responseText = ""; this.readyState = 4;
    if (typeof this.onreadystatechange === "function") this.onreadystatechange();
    if (typeof this.onerror === "function") this.onerror();
  };
  return FakeXHR;
}

function makeContext(nativeReply) {
  const nativeCalls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Response, Headers, URL, atob, btoa, Event, Promise, JSON, Object, Array, Uint8Array, Error, Number, String,
    location: { href: "safari-web-extension://TEST/page.html", origin: "safari-web-extension://TEST", host: "TEST" },
    navigator: { userAgent: "test" },
    // Native fetch the shim wraps: reject the Salesforce host like a Safari CORS block,
    // resolve anything else so non-proxy hosts pass straight through untouched.
    fetch(input) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (/salesforce\.com/.test(url)) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(new Response("DIRECT-OK", { status: 200 }));
    },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        // Background privilege present → shim proxies directly through the host.
        sendNativeMessage(appId, msg) {
          nativeCalls.push(msg);
          return Promise.resolve(nativeReply(msg));
        },
      },
      cookies: {
        // httpOnly session cookie the page can't see — proves cookies come from here.
        getAll(_q) { return Promise.resolve([{ name: "sid", value: "SECRET" }]); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.XMLHttpRequest = makeXHRClass(sandbox);
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ proxyHosts: ["salesforce.com"], chromeOrigin: "chrome-extension://abc" }), sandbox);
  return { sandbox, nativeCalls };
}

function b64(s) { return Buffer.from(s, "utf-8").toString("base64"); }

// Run an XHR to readyState 4 (or a settle sentinel) with a self-clearing, unref'd
// guard timer — so a failed run rejects promptly and never leaks a live timer that
// node:test could mis-attribute to a later file under parallel execution.
function drive(sandbox, build) {
  return new Promise((resolve, reject) => {
    const xhr = new sandbox.XMLHttpRequest();
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => finish(reject, new Error("timeout: XHR never settled")), 2000);
    if (typeof t.unref === "function") t.unref();
    build(xhr, (v) => finish(resolve, v), (e) => finish(reject, e));
    xhr.send(xhr.__body);
  });
}

test("cross-origin XHR to a proxy host is replayed through the native host and its response synthesized", async () => {
  const body = JSON.stringify([{ Id: "001", Name: "Acme" }]);
  const { sandbox, nativeCalls } = makeContext((msg) => ({
    status: 200, statusText: "OK", headers: { "content-type": "application/json" }, bodyB64: b64(body),
  }));

  const result = await drive(sandbox, (xhr, resolve, reject) => {
    xhr.open("GET", "https://na1.salesforce.com/services/data/v60.0/query", true);
    xhr.setRequestHeader("Authorization", "Bearer TOKEN");
    xhr.responseType = "json";
    // Exactly how inspector.js sfConn.rest waits.
    xhr.onreadystatechange = () => { if (xhr.readyState === 4) resolve(xhr); };
    xhr.onerror = () => reject(new Error("xhr errored"));
  });

  assert.equal(nativeCalls.length, 1, "must have proxied exactly one request through the native host");
  assert.equal(nativeCalls[0].url, "https://na1.salesforce.com/services/data/v60.0/query");
  // Header names are case-insensitive; the fetch path normalizes them to lowercase
  // (via Headers) before handing them to the host, which is fine for HTTP.
  assert.equal(nativeCalls[0].headers.authorization, "Bearer TOKEN", "Authorization header must be forwarded to the host");
  assert.equal(nativeCalls[0].cookie, "sid=SECRET", "httpOnly cookie from chrome.cookies must be tunneled");

  assert.equal(result.status, 200, "synthesized status must be the proxied 200, not the native 0");
  assert.equal(result.statusText, "OK");
  // responseType:"json" → xhr.response is the parsed object (inspector reads .length/[0]).
  assert.deepEqual(result.response, [{ Id: "001", Name: "Acme" }]);
  // Per spec, responseText is unavailable when responseType is "json" (as on a real XHR).
  assert.throws(() => result.responseText, /responseText is only available/);
});

test("default responseType XHR to a proxy host exposes responseText + response as the raw body", async () => {
  const body = "<xml>ok</xml>";
  const { sandbox } = makeContext((_msg) => ({ status: 200, statusText: "OK", headers: {}, bodyB64: b64(body) }));
  const xhr = await drive(sandbox, (x, resolve, reject) => {
    x.open("POST", "https://na1.salesforce.com/services/Soap/u/60.0", true);
    x.__body = "<envelope/>";
    // responseType left as "" — inspector's soap uses "document"; "" is the simplest
    // proof that responseText/response both surface the proxied text.
    x.onreadystatechange = () => { if (x.readyState === 4) resolve(x); };
    x.onerror = () => reject(new Error("errored"));
  });
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, body);
  assert.equal(xhr.response, body);
});

test("proxy-host XHR whose host retry ALSO fails surfaces a real error (status 0), does not hang", async () => {
  const { sandbox, nativeCalls } = makeContext(() => ({ error: "host down" }));
  const outcome = await drive(sandbox, (xhr, resolve) => {
    xhr.open("GET", "https://na1.salesforce.com/services/data", true);
    xhr.onreadystatechange = () => { if (xhr.readyState === 4 && xhr.status === 0) resolve("error-state"); };
    xhr.onerror = () => resolve("onerror");
  });
  assert.ok(nativeCalls.length === 1, "host retry attempted once");
  assert.notEqual(outcome, "HANG", "must settle, not hang");
  assert.equal(sandbox.XMLHttpRequest.prototype.__c2sPatched, true);
});

test("XHR to a NON-proxy host is left untouched (native passthrough, no host call)", async () => {
  const { sandbox, nativeCalls } = makeContext(() => ({ status: 200, bodyB64: b64("x") }));
  const outcome = await drive(sandbox, (xhr, resolve) => {
    xhr.open("GET", "https://example.com/thing", true);
    // Native send() reports status 0 here; the point is the shim must NOT intercept it.
    xhr.onreadystatechange = () => { if (xhr.readyState === 4) resolve("native-ran"); };
  });
  assert.equal(outcome, "native-ran");
  assert.equal(nativeCalls.length, 0, "non-proxy host must never touch the native host");
});

test("proxy-host XHR timeout fires 'timeout' + 'loadend', NOT 'error'", async () => {
  // Native host retry never resolves, so the request's own xhr.timeout must win. A
  // timeout is a distinct terminal state from a network error: it fires "timeout" then
  // "loadend" and must NOT fire "error" (retry/error-classification code branches on it).
  const { sandbox } = makeContext(() => new Promise(() => {})); // host reply hangs forever
  const events = await new Promise((resolve, reject) => {
    const xhr = new sandbox.XMLHttpRequest();
    const seen = [];
    const guard = setTimeout(() => reject(new Error("test guard: XHR never settled")), 2000);
    if (typeof guard.unref === "function") guard.unref();
    xhr.open("GET", "https://na1.salesforce.com/services/data", true);
    xhr.timeout = 20;
    xhr.ontimeout = () => seen.push("timeout");
    xhr.onerror = () => seen.push("error");
    xhr.onloadend = () => {
      seen.push("loadend");
      clearTimeout(guard);
      // Give any stray error/timeout event a tick to land before asserting.
      setTimeout(() => resolve(seen), 0);
    };
    // addEventListener-registered timeout handler must fire too (not just ontimeout).
    if (typeof xhr.addEventListener === "function") xhr.addEventListener("timeout", () => seen.push("al:timeout"));
    xhr.send();
  });
  assert.ok(events.includes("timeout"), "must fire timeout");
  assert.ok(events.includes("loadend"), "must fire loadend");
  assert.ok(!events.includes("error"), "must NOT fire error on a timeout");
});
