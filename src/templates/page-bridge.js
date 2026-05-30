// page-bridge.js — injected into the claude.ai MAIN world.
// claude.ai probes window.chrome.runtime to talk to the extension. Safari does
// not give web pages a `chrome` namespace (only `browser`, and that needs the
// Safari extension id which the page can't know). Define a `chrome.runtime`
// whose sendMessage relays over window.postMessage to the content script.
(function () {
  if (window.__claudeBridgeInstalled) return;
  window.__claudeBridgeInstalled = true;
  var CHROME_ID = "dihbgbndebgnbjfmelmegjepbnkhlgni";
  var pending = Object.create(null);
  var seq = 0;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
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
    console.log("[bridge] page->SW send", mtype, "reqId", reqId);
    var p = new Promise(function (resolve, reject) {
      pending[reqId] = function (resp, err) {
        if (err) { console.error("[bridge] SW->page ERROR", mtype, reqId, err); reject(new Error(err)); }
        else { console.log("[bridge] SW->page resp", mtype, reqId, resp); resolve(resp); }
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
      console.warn("[bridge] runtime.connect called — returning inert port (not supported via Safari bridge)");
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
  console.log("[bridge] page chrome.runtime installed");
})();
