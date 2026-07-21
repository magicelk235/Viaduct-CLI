// viaduct CDP keep-alive content script.
//
// Safari suspends a non-persistent MV3 background page when idle. During an
// autonomous CDP session the agent drives the page with no user interaction, so
// the background briefly unloads between command bursts — stalling the
// connectNative poll loop that carries CDP. Even a ~2-5s stall makes the agent's
// puppeteer connection time out and reconnect, so a multi-step action never
// completes. Safari keeps a non-persistent background LOADED while a
// runtime.connect port is open to it (Apple dev-forum 738567). An injected
// executeScript(func) port does NOT persist in Safari, but a DECLARED content
// script's port does — and content->background PORTS are delivered on Safari even
// though content->background sendMessage/storage.onChanged are not. So this file
// (declared on <all_urls>) simply holds that port whenever it runs, keeping the
// background loaded so the CDP poll loop never stalls. Re-created automatically on
// every navigation.
(function () {
  "use strict";
  // DIAGNOSTIC: a DOM marker (visible to page JS via do-JavaScript) proves Safari ran this
  // declared content script at all — distinguishes "not injected" from "port didn't reach bg".
  try { document.documentElement.setAttribute("data-viaduct-cdp-ka", "run"); } catch (e) {}
  var api = (typeof chrome !== "undefined" ? chrome : (typeof browser !== "undefined" ? browser : null));
  if (!api || !api.runtime || typeof api.runtime.connect !== "function") {
    try { document.documentElement.setAttribute("data-viaduct-cdp-ka", "no-runtime"); } catch (e) {}
    return;
  }
  var port = null;
  function hold() {
    if (port) return;
    try {
      port = api.runtime.connect({ name: "__viaduct-cdp-keepalive" });
      try { document.documentElement.setAttribute("data-viaduct-cdp-ka", "held"); } catch (e) {}
      port.onDisconnect.addListener(function () {
        var _ = api.runtime && api.runtime.lastError;
        port = null;
        setTimeout(hold, 400); // background bounced — re-hold
      });
    } catch (e) {
      port = null;
      try { document.documentElement.setAttribute("data-viaduct-cdp-ka", "connect-threw"); } catch (e2) {}
      setTimeout(hold, 1000);
    }
  }
  hold();
})();
