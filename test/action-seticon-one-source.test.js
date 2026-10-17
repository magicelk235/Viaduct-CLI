import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome accepts action.setIcon({path, imageData}) and uses the imageData. Safari
// throws "cannot specify both 'path' and 'imageData'". Violentmonkey passes both on
// every icon change, and the shim's setter wrapper swallowed the throw, so its
// toolbar icon never changed.

const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot() {
  const calls = [];
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    location: { href: "safari-web-extension://T/background.html", protocol: "safari-web-extension:", pathname: "/background.html", origin: "safari-web-extension://t" },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: { id: "x", getURL: (p) => "safari-web-extension://T/" + p, onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {} },
      action: {
        setIcon(d) {
          // Safari's check.
          if (d.path != null && d.imageData != null) throw new Error("Invalid call to action.setIcon(). The 'details' value is invalid, because it cannot specify both 'path' and 'imageData'.");
          calls.push(JSON.parse(JSON.stringify(d)));
          return Promise.resolve();
        },
        setBadgeText() { return Promise.resolve(); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { action: sandbox.chrome.action, calls };
}

const image = () => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) });

test("both given: the imageData wins, as in Chrome", async () => {
  const { action, calls } = boot();
  await action.setIcon({ tabId: 3, path: { 16: "a16.png", 32: "a32.png" }, imageData: { 16: image(), 32: image() } });
  assert.equal(calls.length, 1);
  assert.ok(!("path" in calls[0]));
  assert.equal(calls[0].tabId, 3);
  assert.deepEqual(Object.keys(calls[0].imageData), ["16", "32"]);
});

test("both given but the imageData holds no image: the path is used", async () => {
  const { action, calls } = boot();
  await action.setIcon({ path: { 16: "a16.png" }, imageData: { 16: undefined, 32: false } });
  assert.deepEqual(calls, [{ path: { 16: "a16.png" } }]);
});

test("one source alone passes through untouched", async () => {
  const { action, calls } = boot();
  await action.setIcon({ path: "icon.png" });
  await new Promise((r) => action.setIcon({ imageData: image() }, r));
  assert.equal(calls[0].path, "icon.png");
  assert.ok(calls[1].imageData && !("path" in calls[1]));
});
