import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shimSource } from "../dist/runtime/shim.js";

// An extension page reaches the background through the shim's storage relay, which
// gave up on a reply after 30 s. Chrome waits as long as the listener takes once it
// returned true or a Promise. Web Scraper's `scrape` request resolves only when its
// scraper window closes, so the side panel got "Background page client missing
// response" half a minute into every scrape.

const REQ = "__c2sMbxReq:", RSP = "__c2sMbxRsp:";

// One clock for both realms so the 30 s deadline can pass without waiting for it.
function fakeClock() {
  let now = 1_800_000_000_000, seq = 0;
  const q = [];
  const add = (fn, ms, rep) => { const h = { id: ++seq, at: now + Math.max(0, ms || 0), fn, rep: rep ? Math.max(1, ms || 0) : 0 }; q.push(h); return h; };
  return {
    now: () => now,
    // Contexts never start in the same millisecond; the relay's ids rely on that.
    tick: (ms) => { now += ms; },
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const h = q[0];
        if (!h || h.at > end) break;
        now = h.at;
        if (h.rep) h.at += h.rep; else q.shift();
        try { h.fn(); } catch (e) {}
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}

function realm(path, clk, stored) {
  clk.tick(7);
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(clk.now()); }
    static now() { return clk.now(); }
  }
  const href = "safari-web-extension://TEST" + path;
  const sandbox = {
    console, Promise, Proxy, Date: FakeDate,
    setTimeout: clk.setTimeout, clearTimeout: clk.clear, setInterval: clk.setInterval, clearInterval: clk.clear,
    location: { href, origin: "safari-web-extension://test", protocol: "safari-web-extension:", pathname: path },
    navigator: { userAgent: "test" },
    chrome: {
      runtime: {
        id: "test-ext",
        getURL: (p) => "safari-web-extension://TEST/" + String(p == null ? "" : p).replace(/^\//, ""),
        onMessage: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        onConnect: { addListener() {}, removeListener() {}, hasListener() { return false; } },
        sendMessage() {},
      },
      storage: {
        local: {
          get(keys, cb) { const all = JSON.parse(JSON.stringify(stored)); if (typeof keys === "function") keys(all); else cb && cb(all); },
          set(o, cb) { Object.assign(stored, JSON.parse(JSON.stringify(o))); cb && cb(); },
          remove(k) { [].concat(k).forEach((x) => { delete stored[x]; }); },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(shimSource(), sandbox);
  return sandbox;
}

test("a reply that takes minutes still reaches the page", async () => {
  const clk = fakeClock(), stored = {};
  const bg = realm("/background.html", clk, stored);
  const page = realm("/sidepanel.html", clk, stored);
  bg.chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    clk.setTimeout(() => reply({ done: msg.n }), 150_000);
    return true;
  });
  let got = "unset";
  page.chrome.runtime.sendMessage({ n: 1 }, (r) => { got = r; });
  await clk.advance(120_000);
  assert.equal(got, "unset", "still waiting while the background works on it");
  await clk.advance(60_000);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { done: 1 });
});

test("a quick reply is unchanged", async () => {
  const clk = fakeClock(), stored = {};
  const bg = realm("/background.html", clk, stored);
  const page = realm("/popup.html", clk, stored);
  bg.chrome.runtime.onMessage.addListener((msg, sender, reply) => { reply({ ok: true }); });
  let got = "unset";
  page.chrome.runtime.sendMessage({ n: 2 }, (r) => { got = r; });
  await clk.advance(2_000);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), { ok: true });
});

test("a receiver that stops answering still times out", async () => {
  const clk = fakeClock(), stored = {};
  const page = realm("/popup.html", clk, stored);
  let got = "unset";
  page.chrome.runtime.sendMessage({ n: 3 }, (r) => { got = r; });
  await clk.advance(500);
  const req = Object.keys(stored).find((k) => k.startsWith(REQ));
  assert.ok(req, "the request was written");
  // A receiver said it would answer, then went away without another heartbeat.
  stored[RSP + req.slice(REQ.length)] = { from: "gone", pending: true, t: clk.now() };
  await clk.advance(25_000);
  assert.equal(got, "unset");
  await clk.advance(20_000);
  assert.equal(got, undefined);
});
