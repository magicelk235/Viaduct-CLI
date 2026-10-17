import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome exposes chrome.devtools only to a devtools page and its panels, and bundles
// test for it to tell where they run. The shim stubbed it into every extension
// context, so Web Scraper's side panel took itself for a devtools panel, asked
// tabs.get for the stub's inspected tab (-1), and rendered blank.

const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot(path, { devtools } = {}) {
  const href = "safari-web-extension://T" + path;
  const chrome = {
    runtime: {
      id: "x",
      getURL: (p) => "safari-web-extension://T/" + String(p).replace(/^\//, ""),
      getManifest: () => ({ manifest_version: 3, devtools_page: "devtools_init_page.html" }),
      onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {},
    },
  };
  if (devtools) chrome.devtools = devtools;
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    location: { href, protocol: "safari-web-extension:", pathname: path, origin: "safari-web-extension://t" },
    navigator: { userAgent: "test" },
    chrome,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox.chrome;
}

test("an ordinary extension page gets no chrome.devtools", () => {
  assert.equal(boot("/sidepanel.html").devtools, undefined);
  assert.equal(boot("/background.html").devtools, undefined);
});

test("the manifest's devtools page gets the stubs", () => {
  const dt = boot("/devtools_init_page.html").devtools;
  assert.equal(typeof dt?.panels?.create, "function");
  assert.equal(typeof dt.network.onRequestFinished.addListener, "function");
});

test("a native chrome.devtools keeps its own members and gains the missing ones", () => {
  const native = { inspectedWindow: { tabId: 42, eval() {} } };
  const dt = boot("/panel.html", { devtools: native }).devtools;
  assert.equal(dt.inspectedWindow.tabId, 42);
  assert.equal(typeof dt.panels.create, "function");
});
