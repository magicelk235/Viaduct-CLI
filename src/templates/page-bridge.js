// page-bridge.js — injected into the MAIN world of externally_connectable pages.
// Such pages probe window.chrome.runtime to talk to the extension. Safari does
// not give web pages a `chrome` namespace (only `browser`, and that needs the
// Safari extension id which the page can't know). Define a `chrome.runtime`
// whose sendMessage relays over window.postMessage to the content script.
(function () {
  if (window.__claudeBridgeInstalled) return;
  window.__claudeBridgeInstalled = true;
  // Verbose logging OFF by default (runs in the page's MAIN world). Set
  // window.__C2S_DEBUG = true to re-enable diagnostic logs.
  var DEBUG = !!window.__C2S_DEBUG;
  var DBG = function () { if (DEBUG) try { console.log.apply(console, arguments); } catch (e) {} };
  var DBGW = function () { if (DEBUG) try { console.warn.apply(console, arguments); } catch (e) {} };
  // The page reads chrome.runtime.id. For a faithful conversion this should be
  // the extension's original Chrome id; the converter substitutes it at build
  // time when known (CRX/store download). If left unsubstituted, fall back to
  // the live Safari runtime id so messaging still works for ANY extension.
  var CHROME_ID = "__C2S_EXTENSION_ID__";
  if (CHROME_ID === "__C2S_" + "EXTENSION_ID__") {
    try {
      var liveApi = window.browser || window.chrome;
      CHROME_ID = (liveApi && liveApi.runtime && liveApi.runtime.id) || "";
    } catch (e) { CHROME_ID = ""; }
  }
  var pending = Object.create(null);
  var seq = 0;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    if (ev.origin !== window.location.origin) return;
    var d = ev.data;
    if (!d || d.__claudeBridge !== "cs") return;
    var cb = pending[d.reqId];
    if (cb) { delete pending[d.reqId]; cb(d.response, d.error); }
  });

  function sendMessage() {
    var args = [].slice.call(arguments);
    var msg, cb = null;
    if (typeof args[0] === "string") {            // (id, msg[, opts][, cb])
      msg = args[1];
      cb = typeof args[2] === "function" ? args[2] : (typeof args[3] === "function" ? args[3] : null);
    } else {                                        // (msg[, cb])
      msg = args[0];
      cb = typeof args[1] === "function" ? args[1] : null;
    }
    var reqId = "r" + (++seq);
    var mtype = msg && msg.type ? msg.type : "(no type)";
    DBG("[bridge] page->SW send", mtype, "reqId", reqId);
    var p = new Promise(function (resolve, reject) {
      // Timeout so the promise can't hang forever: if the page calls sendMessage
      // before the isolated-world relay has attached its listener, the postMessage
      // is dropped and no reply ever arrives. (The relay has its own 30s SW timeout;
      // this guards the page->relay leg the relay can't see.)
      var to = setTimeout(function () {
        if (pending[reqId]) { delete pending[reqId]; reject(new Error("bridge timeout: no response from extension")); }
      }, 30000);
      pending[reqId] = function (resp, err) {
        clearTimeout(to);
        if (err) { console.error("[bridge] SW->page ERROR", mtype, reqId, err); reject(new Error(err)); }
        else { DBG("[bridge] SW->page resp", mtype, reqId, resp ? "(ok)" : resp); resolve(resp); }
      };
    });
    window.postMessage({ __claudeBridge: "page", reqId: reqId, msg: msg }, window.location.origin);
    if (cb) { p.then(function (r) { cb(r); }, function () { cb(undefined); }); return; }
    return p;
  }

  var noop = function () {};
  var emptyEvent = { addListener: noop, removeListener: noop, hasListener: function () { return false; } };
  var runtime = {
    id: CHROME_ID,
    sendMessage: sendMessage,
    connect: function () {
      DBGW("[bridge] runtime.connect called — returning inert port (not supported via Safari bridge)");
      return { name: "", postMessage: noop, disconnect: noop,
               onMessage: emptyEvent, onDisconnect: emptyEvent };
    },
    onMessage: emptyEvent,
    onMessageExternal: emptyEvent,
    onConnect: emptyEvent,
    get lastError() { return undefined; }
  };

  var ns = window.chrome || {};
  if (!ns.runtime) ns.runtime = runtime;
  else { ns.runtime.sendMessage = sendMessage; if (!ns.runtime.id) ns.runtime.id = CHROME_ID; }
  window.chrome = ns;
  DBG("[bridge] page chrome.runtime installed");
})();
