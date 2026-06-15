// page-bridge-cs.js — content script (isolated world) on claude.ai.
// Injects page-bridge.js into the MAIN world and relays page messages to the
// service worker as internal messages tagged {__bridge:true}, then posts the
// SW response back to the page.
(function () {
  var api = typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null);
  if (!api) return;
  // Verbose logging OFF by default. Set window.__C2S_DEBUG = true to re-enable.
  var DEBUG = (typeof window !== "undefined" && window.__C2S_DEBUG) || false;
  var DBG = function () { if (DEBUG) try { console.log.apply(console, arguments); } catch (e) {} };

  // page-bridge.js is loaded into the MAIN world via a separate content_scripts
  // entry (world:"MAIN") to bypass claude.ai's page CSP. This isolated-world
  // script only relays page<->SW messages.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.__claudeBridge !== "page") return;
    var mtype = d.msg && d.msg.type ? d.msg.type : "(no type)";
    DBG("[bridge-cs] relay page->SW", mtype, "reqId", d.reqId);
    var done = false;
    function back(response, err) {
      if (done) return; done = true;
      clearTimeout(t);
      DBG("[bridge-cs] SW resp", mtype, d.reqId, err ? ("ERR " + err) : (response ? "(ok)" : response));
      window.postMessage({ __claudeBridge: "cs", reqId: d.reqId, response: response, error: err }, window.location.origin);
    }
    // If the SW never answers (e.g. not running / unreachable), surface a clear
    // error instead of hanging the page forever.
    var t = setTimeout(function () {
      back(undefined, "SW no response after 30s (service worker not running or not receiving?)");
    }, 30000);
    try {
      // Safari's browser.runtime.sendMessage is PROMISE-based and ignores the
      // callback arg (the callback form is a Chrome-ism). Handle both: pass a
      // callback for Chrome, and if a thenable is returned (Safari) use that.
      var ret = api.runtime.sendMessage({ __bridge: true, payload: d.msg }, function (response) {
        var err = api.runtime.lastError ? api.runtime.lastError.message : null;
        back(response, err);
      });
      if (ret && typeof ret.then === "function") {
        ret.then(function (response) { back(response, null); },
                 function (e) { back(undefined, String((e && e.message) || e)); });
      }
    } catch (e) {
      back(undefined, String(e));
    }
  });
  DBG("[bridge-cs] installed v3 — probing background…");

  // Auto-probe on load: ping the background directly (no login needed) so we know
  // immediately whether the background context is running and reachable.
  (function probe() {
    var settled = false;
    var t = setTimeout(function () {
      if (settled) return; settled = true;
      console.error("[bridge-cs] PROBE: background NO RESPONSE after 5s — background not running/reachable");
    }, 5000);
    function got(label, val) {
      if (settled) return; settled = true; clearTimeout(t);
      DBG("[bridge-cs] PROBE", label, val);
    }
    try {
      var ret = api.runtime.sendMessage({ __bridge: true, payload: { type: "ping" } }, function (resp) {
        var err = api.runtime.lastError ? api.runtime.lastError.message : null;
        got(err ? "ERR" : "resp", err || resp);
      });
      if (ret && typeof ret.then === "function") {
        ret.then(function (resp) { got("resp", resp); },
                 function (e) { got("ERR", String((e && e.message) || e)); });
      }
    } catch (e) { got("THREW", String(e)); }
  })();
})();
