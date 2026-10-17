import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// getURL("") comes back with the extension host lowercased (Safari Quirks B4: it has
// to equal Safari's lowercase origins), but Safari's resource server is case-sensitive
// on that host. A bundle that builds resource URLs from it loads nothing: Stylus's
// `getURL("") + "offscreen.html"` gave an empty offscreen frame, so no style could be
// compiled or installed. Loaders reached through the shim restore Safari's case.

const ROOT = "safari-web-extension://AB12CD34-0000-4000-8000-00000000BEEF/";
const unref = (fn) => (...args) => { const h = fn(...args); h?.unref?.(); return h; };

function boot() {
  const fetched = [];
  const opened = [];
  const tabCalls = [];
  const frames = [];
  class FakeXHR { open(m, u) { opened.push(u); } send() {} }
  class FakeRequest { constructor(u, init) { this.url = typeof u === "string" ? u : u.url; this.method = init?.method || "GET"; } }
  const sandbox = {
    console, setTimeout: unref(setTimeout), clearTimeout, setInterval: unref(setInterval), clearInterval, URL,
    Request: FakeRequest,
    XMLHttpRequest: FakeXHR,
    fetch: (input) => { fetched.push(typeof input === "string" ? input : input.url); return Promise.resolve({}); },
    location: { href: ROOT + "background.html", protocol: "safari-web-extension:", pathname: "/background.html", origin: ROOT.slice(0, -1).toLowerCase() },
    navigator: { userAgent: "test" },
    document: {
      body: { appendChild(f) { setTimeout(() => f._listeners.load?.(), 0); } },
      createElement() {
        const f = { style: {}, _listeners: {}, setAttribute() {}, addEventListener(t, fn) { f._listeners[t] = fn; } };
        frames.push(f);
        return f;
      },
    },
    chrome: {
      runtime: {
        id: "test-ext",
        // Safari: nothing for the empty path, the real (uppercase) host otherwise.
        getURL: (p) => (p ? (/^[a-z-]+:\/\//.test(p) ? p : ROOT + String(p).replace(/^\//, "")) : ""),
        onMessage: { addListener() {}, removeListener() {} },
        onConnect: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
      tabs: {
        create(props) { tabCalls.push(["create", props.url]); return Promise.resolve({}); },
        update(a, b) { tabCalls.push(["update", (typeof a === "object" ? a : b).url]); return Promise.resolve({}); },
      },
      windows: { create(props) { tabCalls.push(["window", props.url]); return Promise.resolve({}); } },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return { sandbox, fetched, opened, tabCalls, frames };
}

test("getURL('') stays lowercase, so the comparisons B4 protects still hold", () => {
  const { sandbox } = boot();
  assert.equal(sandbox.chrome.runtime.getURL(""), ROOT.toLowerCase());
});

test("fetch and XHR load a URL built from getURL('') from Safari's host case", () => {
  const { sandbox, fetched, opened } = boot();
  const root = sandbox.chrome.runtime.getURL("");
  sandbox.fetch(root + "manifest.json");
  sandbox.fetch(new sandbox.Request(root + "data.json"));
  sandbox.fetch(new URL(root + "a.css"));
  new sandbox.XMLHttpRequest().open("GET", root + "rules.json");
  assert.deepEqual(fetched, [ROOT + "manifest.json", ROOT + "data.json", ROOT + "a.css"]);
  assert.deepEqual(opened, [ROOT + "rules.json"]);
});

test("other URLs pass through untouched", () => {
  const { sandbox, fetched } = boot();
  const lookalike = ROOT.toLowerCase().slice(0, -1) + "-other/x.json";
  sandbox.fetch("https://Example.COM/A");
  sandbox.fetch(ROOT + "already.json");
  sandbox.fetch(lookalike);
  sandbox.fetch("x.json");
  assert.deepEqual(fetched, ["https://Example.COM/A", ROOT + "already.json", lookalike, "x.json"]);
});

test("tabs and windows open a URL built from getURL('') in Safari's case", () => {
  const { sandbox, tabCalls } = boot();
  const root = sandbox.chrome.runtime.getURL("");
  sandbox.chrome.tabs.create({ url: root + "options.html" });
  sandbox.chrome.tabs.update(4, { url: root + "install.html?u=1" });
  sandbox.chrome.tabs.update({ url: root + "edit.html" });
  sandbox.chrome.windows.create({ url: [root + "a.html", "https://example.com/"] });
  assert.deepEqual(tabCalls, [
    ["create", ROOT + "options.html"],
    ["update", ROOT + "install.html?u=1"],
    ["update", ROOT + "edit.html"],
    ["window", [ROOT + "a.html", "https://example.com/"]],
  ]);
});

test("the offscreen frame loads from Safari's case and keeps reporting the caller's URL", async () => {
  const { sandbox, frames } = boot();
  const docUrl = sandbox.chrome.runtime.getURL("") + "offscreen.html";
  await sandbox.chrome.offscreen.createDocument({ url: docUrl, reasons: ["WORKERS"], justification: "x" });
  assert.equal(frames[0].src, ROOT + "offscreen.html");
  const clients = await sandbox.self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  assert.equal(clients[0].url, docUrl, "the extension finds its document by the URL it asked for");
});
