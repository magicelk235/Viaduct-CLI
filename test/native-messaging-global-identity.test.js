import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shimSource } from "../dist/runtime/shim.js";
import { rewriteNativeMessagingCalls } from "../dist/input/stage.js";

// Regression: Claude in Chrome 1.0.91, but any converted background. The
// native-messaging bridge used to wrap runtime and the root in a Proxy and
// republish global chrome/browser with it. WebKit resolves message and port
// dispatch through the frame's global `browser`/`chrome` at delivery time and
// skips a frame whose global is not its own native namespace (Safari Quirks
// E15), so every content script's sendMessage/connect to the background was
// lost while the offscreen iframe beside it, never proxied, received them all.
// Safari's sendNativeMessage/connectNative are custom-value slots that read
// back the native whatever assignment, defineProperty or delete report
// (measured on Safari Technology Preview 26), so the bridge is published under
// new names on the extensible native runtime and call sites are rewritten.

function makeContext() {
  const runtime = {
    id: "test-ext",
    getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
    onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    sendMessage() {},
  };
  const nativeSend = function sendNativeMessage() { return Promise.resolve({}); };
  const nativeConnect = function connectNative() { return {}; };
  // Safari's slots: assignment, defineProperty and delete all "succeed" and the
  // native reads back. Emulate that on the two members, keep the rest ordinary.
  const custom = { sendNativeMessage: nativeSend, connectNative: nativeConnect };
  const runtimeProxy = new Proxy(runtime, {
    get(t, k) { return k in custom ? custom[k] : t[k]; },
    has(t, k) { return k in custom || k in t; },
    getOwnPropertyDescriptor(t, k) {
      if (k in custom) return { value: custom[k], writable: false, configurable: true, enumerable: false };
      return Object.getOwnPropertyDescriptor(t, k);
    },
    set(t, k, v) { if (k in custom) return true; t[k] = v; return true; },
    defineProperty(t, k, d) { if (k in custom) return true; Object.defineProperty(t, k, d); return true; },
    deleteProperty(t, k) { if (k in custom) return true; delete t[k]; return true; },
  });
  const browser = { runtime: runtimeProxy };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: "safari-web-extension://TEST/background.html", origin: "safari-web-extension://TEST", pathname: "/background.html" },
    navigator: { userAgent: "test" },
    browser,
    chrome: browser,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, browser, runtimeProxy, nativeSend, nativeConnect };
}

test("the native-messaging bridge keeps global browser/chrome native", () => {
  const { sandbox, browser } = makeContext();
  assert.equal(sandbox.browser, browser, "global browser must stay the native namespace; WebKit dispatches through it");
  assert.equal(sandbox.chrome, browser, "global chrome must stay the native namespace");
  assert.equal(sandbox.browser.runtime, browser.runtime, "runtime is not swapped either");
});

test("the bridge is published under the alias names the rewrite targets", () => {
  const { browser, nativeSend, nativeConnect } = makeContext();
  const rt = browser.runtime;
  assert.equal(rt.sendNativeMessage, nativeSend, "the native slot is untouchable and left alone");
  assert.equal(rt.connectNative, nativeConnect);
  assert.equal(typeof rt.__viaductSendNativeMessage, "function");
  assert.equal(typeof rt.__viaductConnectNative, "function");
  const port = rt.__viaductConnectNative("com.example.host");
  assert.equal(port.name, "com.example.host");
  assert.equal(typeof port.postMessage, "function");
  assert.equal(typeof port.onMessage.addListener, "function");
  port.disconnect(); // stops the bridge's poll loop so the process can exit
});

test("rewriteNativeMessagingCalls points dotted call sites at the bridge and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-nm-"));
  try {
    const src = 'const p = chrome.runtime.connectNative("com.example.host");\n' +
      'r.sendNativeMessage ("x", {a:1}, cb);\n' +
      'const { connectNative } = chrome.runtime; connectNative("y");\n' +
      'obj.connectNativeThing(1); obj["sendNativeMessage"]("z");\n';
    writeFileSync(join(dir, "bg.js"), src);
    writeFileSync(join(dir, "plain.js"), "console.log(1);\n");
    assert.equal(rewriteNativeMessagingCalls(dir), 1);
    const out = readFileSync(join(dir, "bg.js"), "utf-8");
    assert.match(out, /chrome\.runtime\.__viaductConnectNative\("com\.example\.host"\)/);
    assert.match(out, /r\.__viaductSendNativeMessage\("x"/);
    assert.match(out, /const \{ connectNative \} = chrome\.runtime; connectNative\("y"\)/, "destructured form is left alone");
    assert.match(out, /obj\.connectNativeThing\(1\); obj\["sendNativeMessage"\]\("z"\)/, "other identifiers and bracket access untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
