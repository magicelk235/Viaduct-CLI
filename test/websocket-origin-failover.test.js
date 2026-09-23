import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// A backend the extension declares (CSP connect-src / host_permissions) can refuse the
// WebSocket handshake Safari sends on the extension's behalf: Claude in Chrome's browser
// bridge, wss://bridge.claudeusercontent.com, answers 101 to its Chrome origin and to no
// Origin, 403 to `safari-web-extension://…`, so from a converted background the socket
// died with 1006 on every retry and the extension never registered as a connected
// browser. The shim now gives the platform socket the first try and, when it dies
// before ever opening, re-establishes the same connection through the native-host
// tunnel behind the one object the app holds — the same recovery the fetch retry does.

// Node has no CloseEvent; the shim and the fake socket both construct one.
const CloseEvent = globalThis.CloseEvent ?? class CloseEvent extends Event {
  constructor(type, init = {}) { super(type, init); this.code = init.code ?? 0; this.reason = init.reason ?? ""; this.wasClean = !!init.wasClean; }
};

// Platform WebSocket that never opens: error, then close 1006. `openFor` lists hosts it
// does open for, to check the fast path stays native.
function makeNativeWS(log, openFor) {
  class FakeWS extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url); this.readyState = 0; this.binaryType = "blob";
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      log.push({ native: this.url });
      const host = new URL(this.url).hostname;
      queueMicrotask(() => {
        if (openFor.includes(host)) { this.readyState = 1; this.fire("open", new Event("open")); return; }
        this.readyState = 3;
        this.fire("error", new Event("error"));
        this.fire("close", new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
      });
    }
    // A real socket runs both the on* handler and addEventListener listeners.
    fire(type, ev) { const h = this["on" + type]; if (typeof h === "function") h.call(this, ev); this.dispatchEvent(ev); }
    send(d) { log.push({ nativeSend: d }); }
    close() { this.readyState = 3; this.fire("close", new CloseEvent("close", { code: 1000, wasClean: true })); }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  return FakeWS;
}

function makeContext({ proxyHosts, openFor = [] }) {
  const log = [];
  const host = { opened: [], sent: [], inbox: [] };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, atob, btoa, Event, MessageEvent, CloseEvent, EventTarget, Blob, TextDecoder, TextEncoder,
    Promise, JSON, Object, Array, Uint8Array, ArrayBuffer, Error, TypeError, Number, String, Boolean, Math, Date,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", host: "TEST", protocol: "safari-web-extension:", pathname: "/background.html", search: "" },
    navigator: { userAgent: "test" },
    fetch: () => Promise.resolve(new Response("", { status: 200 })),
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + p,
        getManifest: () => ({ manifest_version: 3 }),
        onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        sendNativeMessage(_app, msg) {
          if (msg.op === "wsopen") { host.opened.push(msg); return Promise.resolve({ ok: true }); }
          if (msg.op === "wssend") { host.sent.push(msg); return Promise.resolve({ ok: true }); }
          if (msg.op === "wspoll") { const m = host.inbox.splice(0); return Promise.resolve({ open: true, messages: m }); }
          if (msg.op === "wsclose") return Promise.resolve({ ok: true });
          return Promise.resolve({});
        },
      },
      storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() }, onChanged: { addListener() {} } },
    },
  };
  sandbox.WebSocket = makeNativeWS(log, openFor);
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource({ proxyHosts, chromeOrigin: "" }), sandbox);
  return { sandbox, log, host };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("a declared backend that refuses the handshake is reached through the native tunnel behind the same socket object", async () => {
  const { sandbox, log, host } = makeContext({ proxyHosts: ["bridge.claudeusercontent.com"] });
  const ws = new sandbox.WebSocket("wss://bridge.claudeusercontent.com/chrome/acct-1");
  const events = [];
  ws.onopen = () => events.push("open");
  ws.onerror = () => events.push("error");
  ws.onclose = (e) => events.push("close:" + e.code);
  ws.onmessage = (e) => events.push("msg:" + e.data);
  ws.send(JSON.stringify({ type: "connect" })); // queued while CONNECTING, exactly as the extension does in onopen-or-earlier

  await tick(); await tick();
  assert.equal(log.filter((l) => l.native).length, 1, "the platform socket got the first try");
  assert.deepEqual(host.opened.map((o) => o.url), ["wss://bridge.claudeusercontent.com/chrome/acct-1"], "the same URL was re-opened through the host");
  assert.deepEqual(events, ["open"], "the app saw one open and neither the refused handshake's error nor its close");
  assert.equal(ws.readyState, 1);
  assert.equal(host.sent.length, 1, "the frame queued before open went out over the tunnel");
  assert.equal(host.sent[0].text, JSON.stringify({ type: "connect" }));

  host.inbox.push({ kind: "text", text: JSON.stringify({ type: "waiting" }) });
  await tick(120);
  assert.ok(events.includes('msg:{"type":"waiting"}'), "server frames arrive as message events on the app's object");

  ws.close();
  await tick();
  assert.equal(ws.readyState, 3, "close reaches the tunnel and the app's object");
});

test("a declared backend that accepts the handshake stays on the platform socket", async () => {
  const { sandbox, log, host } = makeContext({ proxyHosts: ["api.anthropic.com"], openFor: ["api.anthropic.com"] });
  const ws = new sandbox.WebSocket("wss://api.anthropic.com/api/ws/voice");
  let opened = false; ws.onopen = () => { opened = true; };
  await tick();
  assert.ok(opened);
  assert.equal(log.filter((l) => l.native).length, 1);
  assert.equal(host.opened.length, 0, "no tunnel for a socket the platform can open");
});

test("a host the extension does not declare is left to the platform, failure and all", async () => {
  const { sandbox, host } = makeContext({ proxyHosts: ["bridge.claudeusercontent.com"] });
  const ws = new sandbox.WebSocket("wss://example.org/socket");
  const events = [];
  ws.onerror = () => events.push("error");
  ws.onclose = (e) => events.push("close:" + e.code);
  await tick();
  assert.deepEqual(events, ["error", "close:1006"], "an undeclared host reports the platform's own failure");
  assert.equal(host.opened.length, 0);
});

test("loopback ws:// keeps the existing tunnel path", async () => {
  const { sandbox, host } = makeContext({ proxyHosts: [] });
  const ws = new sandbox.WebSocket("ws://127.0.0.1:9999/app");
  await tick();
  assert.equal(host.opened.length, 1);
  ws.close();
  await tick();
});
