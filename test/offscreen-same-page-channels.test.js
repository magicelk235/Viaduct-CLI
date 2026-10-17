import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// The emulated offscreen document is an iframe of the background page, and Safari
// never delivers runtime messaging within the sending page. Two channels an MV3
// background uses to reach its offscreen document therefore went nowhere:
// runtime.connect (the port disconnects at once) and the service-worker message bus
// (offscreen posts to navigator.serviceWorker.controller and answers on
// event.source). Live case: Violentmonkey connects a port named "offscreen" and runs
// GM_xmlhttpRequest over the message bus, so every request failed with "Offscreen
// document disconnected" and, once the port held, hung without a reply.

function realm(href, extra) {
  const nativeConnects = [];
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    EventTarget, MessageEvent, MessageChannel, structuredClone, JSON,
    location: { href, protocol: "safari-web-extension:", origin: "safari-web-extension://TEST", pathname: new URL(href).pathname },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + String(p).replace(/^\//, ""),
        onMessage: { addListener() {}, removeListener() {} },
        onConnect: { addListener() {}, removeListener() {} },
        sendMessage() {},
        connect(info) {
          nativeConnects.push(info);
          const ev = () => ({ addListener() {}, removeListener() {} });
          return { name: info?.name, onMessage: ev(), onDisconnect: ev(), postMessage() {}, disconnect() {} };
        },
      },
    },
    ...extra,
  };
  const target = new EventTarget();
  sandbox.addEventListener = target.addEventListener.bind(target);
  sandbox.removeEventListener = target.removeEventListener.bind(target);
  sandbox.dispatchEvent = target.dispatchEvent.bind(target);
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, nativeConnects };
}

async function bootPair() {
  const frames = [];
  const bg = realm("safari-web-extension://TEST/background.html", {
    navigator: { userAgent: "test" },
    document: {
      body: { appendChild(f) { setTimeout(() => f._listeners.load?.(), 0); } },
      createElement() {
        const f = { style: {}, _listeners: {}, setAttribute() {}, addEventListener(t, fn) { f._listeners[t] = fn; } };
        frames.push(f);
        return f;
      },
    },
  });
  await bg.sandbox.chrome.offscreen.createDocument({ url: "offscreen.html" });
  const off = realm("safari-web-extension://TEST/offscreen.html", {
    navigator: { userAgent: "test", serviceWorker: new EventTarget() },
    parent: bg.sandbox,
  });
  // contentWindow is the frame's own `window`; inside a vm context that is the
  // global proxy, not the sandbox object passed in.
  frames[0].contentWindow = vm.runInContext("this", off.sandbox);
  return { bg, off };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("a port from the background reaches its offscreen document's onConnect", async () => {
  const { bg, off } = await bootPair();
  const got = [];
  let offPort = null;
  let offGone = false;
  off.sandbox.chrome.runtime.onConnect.addListener((p) => {
    offPort = p;
    p.onMessage.addListener((m) => { got.push(m); p.postMessage({ echo: m.n }); });
    p.onDisconnect.addListener(() => { offGone = true; });
  });

  const port = bg.sandbox.chrome.runtime.connect({ name: "offscreen" });
  assert.ok(offPort, "the offscreen listener must be handed the port");
  assert.equal(offPort.name, "offscreen");
  assert.equal(bg.nativeConnects.length, 0, "a delivered port must not also go out natively");

  const replies = [];
  let bgGone = false;
  port.onMessage.addListener((m) => replies.push(m));
  port.onDisconnect.addListener(() => { bgGone = true; });
  port.postMessage({ n: 1 });
  await tick();
  assert.deepEqual(got, [{ n: 1 }]);
  assert.deepEqual(replies, [{ echo: 1 }]);

  port.disconnect();
  await tick();
  assert.ok(offGone, "disconnecting one end must disconnect the other");
  assert.ok(!bgGone, "the end that disconnected gets no onDisconnect");
});

test("without an offscreen listener the port still goes out natively", async () => {
  const { bg } = await bootPair();
  bg.sandbox.chrome.runtime.connect({ name: "popup" });
  assert.equal(bg.nativeConnects.length, 1);
});

test("the offscreen document's worker messages reach the background and answers come back", async () => {
  const { bg, off } = await bootPair();
  const bgSeen = [];
  bg.sandbox.addEventListener("message", (e) => {
    bgSeen.push(e.data);
    e.source.postMessage({ id: e.data.id, res: "ok" });
  });
  const replies = [];
  const sw = off.sandbox.navigator.serviceWorker;
  sw.addEventListener("message", (e) => replies.push(e.data));

  const sent = Object.freeze({ id: 7, msg: Object.freeze({ cmd: "Request" }) });
  sw.controller.postMessage(sent);
  assert.deepEqual(bgSeen, [{ id: 7, msg: { cmd: "Request" } }]);
  assert.deepEqual(replies, [{ id: 7, res: "ok" }]);
  assert.equal(off.nativeConnects.length, 0, "the tunnel must not be used from the offscreen frame");
});

test("messages arrive as copies, not the sender's object", async () => {
  const { bg, off } = await bootPair();
  let received = null;
  bg.sandbox.addEventListener("message", (e) => { received = e.data; e.data.seen = true; });
  const sent = Object.freeze({ id: 1 });
  off.sandbox.navigator.serviceWorker.controller.postMessage(sent);
  assert.ok(received && received !== sent);
  assert.equal(received.seen, true, "a receiver must be able to write to what it got");
});

test("a frame other than the offscreen document keeps the tunnel", async () => {
  const { bg } = await bootPair();
  const stray = realm("safari-web-extension://TEST/frame.html", {
    navigator: { userAgent: "test", serviceWorker: new EventTarget() },
    parent: bg.sandbox,
  });
  let seen = false;
  bg.sandbox.addEventListener("message", () => { seen = true; });
  stray.sandbox.navigator.serviceWorker.controller.postMessage({ id: 1 });
  assert.ok(!seen, "only the offscreen frame may post straight into the background");
  assert.equal(stray.nativeConnects.length, 1);
});
