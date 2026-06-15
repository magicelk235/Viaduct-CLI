// identity-polyfill.js — Safari chrome.identity shim for OAuth.
// Verbose logging is OFF by default (it can leak OAuth tokens into the console).
// Set self.__C2S_DEBUG = true before this loads to re-enable diagnostic logs.
(function () {
  "use strict";
  var DEBUG = (typeof self !== "undefined" && self.__C2S_DEBUG) ||
              (typeof globalThis !== "undefined" && globalThis.__C2S_DEBUG) || false;
  var DBG = function () { if (DEBUG) try { console.log.apply(console, arguments); } catch (e) {} };
  var DBGW = function () { if (DEBUG) try { console.warn.apply(console, arguments); } catch (e) {} };
  var api = typeof self !== "undefined" && self.chrome ? self.chrome
          : (typeof chrome !== "undefined" ? chrome : null);
  if (!api) { DBGW("[idpoly] no chrome api"); return; }

  var CHROME_EXT_ID = "dihbgbndebgnbjfmelmegjepbnkhlgni";
  var REDIRECT_BASE = "https://" + CHROME_EXT_ID + ".chromiumapp.org/";
  DBG("[idpoly] loaded. native identity?", !!api.identity,
              "tabs?", !!api.tabs, "webNavigation?", !!api.webNavigation,
              "REDIRECT_BASE", REDIRECT_BASE);

  // Surface any throw during SW bundle module-eval. A missing-API TypeError there
  // aborts evaluation BEFORE onMessageExternal registers, but can be easy to miss
  // in the console — log it loudly with a stack so the failing API is obvious.
  try {
    self.addEventListener("error", function (e) {
      console.error("[idpoly] GLOBAL ERROR:", (e && e.message) || e,
                    e && e.filename, e && e.lineno, e && e.error && e.error.stack);
    });
    self.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      console.error("[idpoly] UNHANDLED REJECTION:", r && (r.stack || r.message || r));
    });
  } catch (e) { /* no event target */ }

  function getRedirectURL(path) {
    var u = !path ? REDIRECT_BASE : REDIRECT_BASE + String(path).replace(/^\//, "");
    DBG("[idpoly] getRedirectURL ->", u);
    return u;
  }

  function launchWebAuthFlow(details, callback) {
    DBG("[idpoly] launchWebAuthFlow", JSON.stringify(details));
    var p = new Promise(function (resolve, reject) {
      var authUrl = details && details.url;
      if (!authUrl) { reject(new Error("launchWebAuthFlow: missing url")); return; }

      // The redirect target is whatever redirect_uri the caller embedded in the
      // authorize URL (chromiumapp.org for one flow, chrome-extension://.../
      // oauth_callback.html for another). Watch for navigation to THAT, not a
      // hardcoded base — that is what Chrome's launchWebAuthFlow does.
      var redirectTarget = REDIRECT_BASE;
      try {
        var ru = new URL(authUrl).searchParams.get("redirect_uri");
        if (ru) redirectTarget = ru;
      } catch (e) { /* keep default */ }
      DBG("[idpoly] redirectTarget", redirectTarget);

      // DEBUG: always visible so you can see the authorize result.
      api.tabs.create({ url: authUrl, active: true }, function (tab) {
        if (api.runtime.lastError || !tab) {
          console.error("[idpoly] tab create err", api.runtime.lastError);
          reject(new Error((api.runtime.lastError && api.runtime.lastError.message) || "tab create failed"));
          return;
        }
        var tabId = tab.id;
        var settled = false;
        DBG("[idpoly] auth tab", tabId, "url", authUrl);
        var timer = setTimeout(function () {
          DBGW("[idpoly] TIMEOUT (tab left open for inspection)", tabId);
          if (!settled) { settled = true; cleanup(); reject(new Error("launchWebAuthFlow timeout")); }
        }, 120000);

        function captured(url) {
          return typeof url === "string" && url.indexOf(redirectTarget) === 0;
        }
        function onNav(d) {
          if (d.tabId !== tabId) return;
          DBG("[idpoly] nav", d.url);
          if (captured(d.url)) finish(resolve, d.url);
        }
        function onErr(d) {
          if (d.tabId !== tabId) return;
          DBG("[idpoly] navERR", d.url, d.error);
          if (captured(d.url)) finish(resolve, d.url);
        }
        function onRemoved(id) {
          if (id === tabId) { DBGW("[idpoly] tab removed"); finish(reject, new Error("auth tab closed")); }
        }
        function cleanup() {
          clearTimeout(timer);
          api.webNavigation.onBeforeNavigate.removeListener(onNav);
          api.webNavigation.onCommitted.removeListener(onNav);
          api.webNavigation.onCompleted.removeListener(onNav);
          api.webNavigation.onErrorOccurred.removeListener(onErr);
          api.tabs.onRemoved.removeListener(onRemoved);
        }
        function finish(fn, arg) {
          if (settled) return;
          settled = true;
          cleanup();
          // Redact the OAuth token/code: the redirect URL carries it in the query/
          // fragment, so log only origin+path, never the full URL.
          var redacted = arg;
          if (fn === resolve && typeof arg === "string") {
            try { var ru = new URL(arg); redacted = ru.origin + ru.pathname + " (params redacted)"; } catch (e) { redacted = "(redirect url redacted)"; }
          }
          DBG("[idpoly] finish ->", (fn === resolve ? "RESOLVE " + redacted : "reject " + arg));
          try { api.tabs.remove(tabId, function () { void api.runtime.lastError; }); } catch (e) {}
          fn(arg);
        }

        api.webNavigation.onBeforeNavigate.addListener(onNav);
        api.webNavigation.onCommitted.addListener(onNav);
        api.webNavigation.onCompleted.addListener(onNav);
        api.webNavigation.onErrorOccurred.addListener(onErr);
        api.tabs.onRemoved.addListener(onRemoved);
      });
    });

    if (typeof callback === "function") {
      p.then(function (u) { callback(u); }, function () { callback(undefined); });
      return;
    }
    return p;
  }

  var identity = api.identity || {};
  identity.getRedirectURL = getRedirectURL;
  identity.launchWebAuthFlow = launchWebAuthFlow;
  if (!identity.removeCachedAuthToken) identity.removeCachedAuthToken = function (d, cb) { if (cb) cb(); return Promise.resolve(); };
  if (!identity.getAuthToken) identity.getAuthToken = function () { return Promise.reject(new Error("getAuthToken unsupported")); };
  api.identity = identity;
  DBG("[idpoly] identity patched");

  // --- page<->extension bridge (SW side) ---------------------------------
  // Safari requires the page to pass the (Safari) extension id to message the
  // SW, but claude.ai hardcodes the Chrome id, so page->ext messaging fails
  // ("Chrome extension API not available"). A content script relays page
  // messages to the SW as internal messages tagged {__bridge:true}. Here we
  // capture the extension's onMessageExternal listeners and re-dispatch those
  // tagged messages to them, synthesizing sender.origin so origin checks pass.
  function safeOrigin(u) { try { return new URL(u).origin; } catch (e) { return undefined; } }
  var extListeners = [];
  // Capture the SW's onMessageExternal handler so bridged page messages can be
  // dispatched to it. Safari may expose onMessageExternal as a read-only/native
  // event; under "use strict" a naive `addListener =` reassignment THROWS and
  // aborts this whole polyfill, leaving the bridge dead (tab opens, login never
  // finishes). Replace the event object wholesale via defineProperty, with
  // progressive fallbacks, so addListener is always captured here.
  (function () {
    var rt = api.runtime;
    if (!rt) { DBGW("[idpoly] no runtime for onMessageExternal capture"); return; }
    var nativeExt = rt.onMessageExternal;
    var nativeAdd = (nativeExt && typeof nativeExt.addListener === "function")
                  ? nativeExt.addListener.bind(nativeExt) : null;
    DBG("[idpoly] native onMessageExternal?", !!nativeExt, "nativeAdd?", !!nativeAdd);
    // Single capture sink. Whether the SW bundle calls addListener on our
    // defineProperty shadow OR on the original native event object, the listener
    // must land here — else extListeners stays empty and bridged page messages
    // have nowhere to go ("no external listener captured"). Also forward to the
    // native event so genuine external messages still work.
    function capture(l) {
      if (typeof l !== "function") return;
      if (extListeners.indexOf(l) < 0) {
        extListeners.push(l);
        DBG("[idpoly] captured onMessageExternal listener; total", extListeners.length);
      }
      if (nativeAdd) { try { nativeAdd(l); } catch (e) { /* native may reject */ } }
    }
    var controlled = {
      addListener: capture,
      removeListener: function (l) { var i = extListeners.indexOf(l); if (i >= 0) extListeners.splice(i, 1); },
      hasListener: function (l) { return extListeners.indexOf(l) >= 0; }
    };
    // (1) Replace the event object so `rt.onMessageExternal.addListener` hits us.
    try {
      Object.defineProperty(rt, "onMessageExternal", { value: controlled, configurable: true, writable: true });
      DBG("[idpoly] onMessageExternal replaced via defineProperty");
    } catch (e1) {
      try { rt.onMessageExternal = controlled; DBG("[idpoly] onMessageExternal replaced via assignment"); }
      catch (e2) { DBGW("[idpoly] could not replace onMessageExternal object", e2); }
    }
    // (2) ALSO patch addListener on the ORIGINAL native object in place, in case
    // the bundle reaches the native event reference directly (Safari may hand out
    // a runtime/event object distinct from our shadow). Belt and suspenders.
    if (nativeExt && nativeExt !== controlled) {
      try {
        Object.defineProperty(nativeExt, "addListener", { value: capture, configurable: true, writable: true });
        DBG("[idpoly] native onMessageExternal.addListener wrapped");
      } catch (e3) {
        try { nativeExt.addListener = capture; DBG("[idpoly] native onMessageExternal.addListener wrapped (assign)"); }
        catch (e4) { DBGW("[idpoly] could not wrap native onMessageExternal.addListener", e4); }
      }
    }
  })();
  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.__bridge !== true) return;
      var origin = sender.origin || safeOrigin(sender.url) ||
                   (sender.tab && sender.tab.url ? safeOrigin(sender.tab.url) : undefined);
      var fixed = Object.assign({}, sender, { origin: origin });
      DBG("[idpoly] bridge msg", JSON.stringify(msg.payload), "origin", origin,
                  "listeners", extListeners.length);
      // Return a Promise so Safari/Firefox deliver the async response. Safari
      // IGNORES `return true`, so a `return true` + async sendResponse drops the
      // reply and the page hangs forever. Also call sendResponse for Chrome
      // callers (Chrome ignores the returned Promise).
      return new Promise(function (resolve) {
        var settled = false;
        var resp = function (r) {
          if (settled) return; settled = true;
          DBG("[idpoly] bridge resp ->", (r && r.success === false) ? JSON.stringify(r) : "(ok, payload redacted)");
          try { sendResponse(r); } catch (e) {}
          resolve(r);
        };
        if (extListeners.length === 0) {
          console.error("[idpoly] bridge msg but NO captured onMessageExternal listeners — SW handler not registered/captured");
          resp({ success: false, error: "bridge: no external listener captured" });
          return;
        }
        for (var i = 0; i < extListeners.length; i++) {
          try { extListeners[i](msg.payload, fixed, resp); } catch (e) { console.error("[idpoly] extListener err", e); }
        }
      });
    });
  }
})();
