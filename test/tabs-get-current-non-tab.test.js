import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// Chrome's tabs.getCurrent resolves the tab the calling document is in, and undefined
// when it is in none: the background page, an action popup, a side panel. Safari falls
// back to the focused window's active tab instead. Measured in Safari Technology
// Preview: from the background page and from the action popover, getCurrent returned
// tab 420, the web page in front. From options.html opened in a background tab it
// returned that tab (1270), url "safari-web-extension://<UUID>/options.html".
//
// Claude in Chrome 1.0.102 decides what its panel is from that answer: undefined means
// side panel, a tab means a window it opened. Handed the web tab, it finds no handover
// for it and shows "Claude isn't available on this page" in the popover.

const HOST = "safari-web-extension://0CF6ABF1-9981-4622-B6F8-AA7F0665F65B";
const WEB_TAB = { id: 420, windowId: 417, active: true, url: "http://127.0.0.1:8765/index.html" };
const OWN_TAB = { id: 1270, windowId: 417, active: false, url: `${HOST}/options.html` };
const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot({ href, nativeTab, top }) {
  const u = new URL(href);
  const location = { href, protocol: u.protocol, pathname: u.pathname, search: u.search, origin: u.origin.toLowerCase() };
  const getCurrent = (cb) => {
    const t = nativeTab ? { ...nativeTab } : undefined;
    if (typeof cb === "function") { cb(t); return; }
    return Promise.resolve(t);
  };
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL, URLSearchParams,
    location,
    navigator: { userAgent: "test" },
    history: { state: null, replaceState() {} },
    chrome: {
      runtime: { id: "x", getURL: (p) => `${HOST}/${p}`, getManifest: () => ({ manifest_version: 3 }), onMessage: { addListener() {} }, onConnect: { addListener() {} }, sendMessage() {} },
      tabs: { query: (q, cb) => { if (cb) { cb([]); return; } return Promise.resolve([]); }, getCurrent },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = top ? { location: { href: top, protocol: new URL(top).protocol } } : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox.chrome;
}

const viaCallback = (chrome) => new Promise((r) => chrome.tabs.getCurrent(r));
const id = (t) => (t ? t.id : t);

test("the action popover is not in a tab", async () => {
  const chrome = boot({ href: `${HOST}/sidepanel.html`, nativeTab: WEB_TAB });
  assert.equal(await chrome.tabs.getCurrent(), undefined);
  assert.equal(await viaCallback(chrome), undefined);
});

test("the background page is not in a tab", async () => {
  const chrome = boot({ href: `${HOST}/background.html`, nativeTab: WEB_TAB });
  assert.equal(await chrome.tabs.getCurrent(), undefined);
});

test("a page opened in a tab gets that tab, whatever query it carries", async () => {
  const chrome = boot({ href: `${HOST}/options.html?tabId=420`, nativeTab: OWN_TAB });
  assert.equal(id(await chrome.tabs.getCurrent()), 1270);
  assert.equal(id(await viaCallback(chrome)), 1270);
});

test("a frame inside the extension's own tab gets the tab its top document is in", async () => {
  const chrome = boot({ href: `${HOST}/frame.html`, nativeTab: OWN_TAB, top: `${HOST}/options.html` });
  assert.equal(id(await chrome.tabs.getCurrent()), 1270);
});

test("a tab Safari reports without a url is not this document's", async () => {
  const chrome = boot({ href: `${HOST}/sidepanel.html`, nativeTab: { id: 420, windowId: 417, active: true } });
  assert.equal(await chrome.tabs.getCurrent(), undefined);
});
