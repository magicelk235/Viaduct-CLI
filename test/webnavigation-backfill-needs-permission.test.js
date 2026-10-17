import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Without the webNavigation permission Chrome has no chrome.webNavigation, and
// bundles feature-detect on it. Web Scraper sets `webNavigationEnabled =
// chrome.webNavigation !== undefined` without declaring the permission; the shim's
// inert backfill made its scraper window wait for page-load events that never came,
// so every page timed out and a scrape stored no rows.

const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot(manifest, nativeWebNav) {
  const chrome = {
    runtime: {
      id: "x",
      getURL: (p) => "safari-web-extension://T/" + String(p).replace(/^\//, ""),
      getManifest: () => manifest,
      onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {},
    },
  };
  if (nativeWebNav) chrome.webNavigation = nativeWebNav;
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    location: { href: "safari-web-extension://T/scraper.html", protocol: "safari-web-extension:", pathname: "/scraper.html", origin: "safari-web-extension://t" },
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

test("no webNavigation permission, no chrome.webNavigation", () => {
  assert.equal(boot({ manifest_version: 3, permissions: ["tabs", "webRequest"] }).webNavigation, undefined);
});

test("a declared permission still gets the events backfilled", () => {
  for (const key of ["permissions", "optional_permissions"]) {
    const wn = boot({ manifest_version: 3, [key]: ["webNavigation"] }).webNavigation;
    assert.equal(typeof wn?.onCompleted?.addListener, "function", key);
    assert.equal(typeof wn.getAllFrames, "function", key);
  }
});

test("a native namespace keeps its own events and gains the missing ones", () => {
  const onCompleted = { addListener() {}, removeListener() {}, hasListener() { return false; } };
  const wn = boot({ manifest_version: 3, permissions: ["webNavigation"] }, { onCompleted }).webNavigation;
  assert.equal(wn.onCompleted, onCompleted);
  assert.equal(typeof wn.onTabReplaced.addListener, "function");
});
