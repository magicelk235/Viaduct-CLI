  // Debug RPC bridge. This file is NOT staged on its own: shimSource() splices it
  // over the marker line at the END of the outer try (every API patch above it has
  // already applied) only for a --debug conversion, so a release shim carries no
  // trace of it. It runs inside the outer try, but the cardinal rule still holds:
  // nothing here may throw, and it installs nothing when the token is missing.
  //
  // Purpose: drive a converted extension headlessly. Safari refuses a top-level
  // navigation to safari-web-extension:// it did not start itself, the popover
  // console is unreliable, and the only surfaces an outside script can reach are
  // ordinary web pages. So a web page the extension has a content script on posts
  //   window.postMessage({ __viaduct_rpc: { token, id, target, op, ... } }, "*")
  // the content script forwards it over a runtime.connect port named
  // "__viaduct-rpc", the extension contexts whose identity matches `target`
  // answer on their end of that port, and the content script posts
  //   { __viaduct_rpc_reply: { id, res: { ok, ctx, result | error } } }
  // back into the page. A port, not sendMessage: Safari delivers a content
  // script's sendMessage to the background AND every extension page, and the
  // first context to finish replies for all of them, so a page whose own
  // listeners return undefined synchronously (the offscreen document) wins the
  // race against a background that answers with a Promise. Each context gets its
  // own Port and a non-matching one simply stays silent.
  // Targets: "background", "content" (answered by the content script itself),
  // "page" (any non-background extension page), "any" (every match answers; the
  // page keeps the first), or a substring of an extension page's pathname
  // ("sidepanel.html"). Ops:
  //   ping                         -> { ctx, href, root identity (Safari Quirks E15) }
  //   call  { path, args }         -> browser.<path>(...args), awaited; { $path } args pass live objects
  //   get   { path }               -> browser.<path>; a "self." prefix reads the global
  //   same  { paths }              -> paths[1..] === paths[0], identity across the bridge
  //   watch { path }               -> log every dispatch of browser.<path> to the ring
  //   describe { path }            -> descriptor of the slot along the prototype chain
  //   eval  { code }               -> indirect eval (extension pages' CSP may refuse)
  //   dom   { action, selector, value, limit }
  //         action: exists | count | text | html | click | value | attrs | list
  // The token is minted per conversion (see convert.ts) and written next to the
  // report as debug-rpc.token; a page that does not carry it is ignored at both
  // hops. A request no context matches gets no reply; the caller times out.
  (function () {
    var TOKEN = __C2S_DEBUG_RPC_TOKEN_JSON__;
    if (typeof TOKEN !== "string" || !TOKEN) return;
    var isExtPage = typeof location !== "undefined"
      && /^(safari-web-extension|chrome-extension|moz-extension):$/.test(location.protocol);
    var isBackground = false;
    if (isExtPage) {
      try {
        isBackground = !!(api.extension && api.extension.getBackgroundPage && typeof window !== "undefined"
          && api.extension.getBackgroundPage() === window);
      } catch (e) {}
      if (!isBackground) { try { isBackground = /\/background\.html$/.test(location.pathname); } catch (e) {} }
    }
    var here = isExtPage ? (isBackground ? "background" : "page:" + location.pathname) : "content";
    var g = (typeof globalThis !== "undefined") ? globalThis : (typeof window !== "undefined" ? window : self);
    // The shim is prepended to every script of a page (and to every content script
    // of the same isolated world), so guard the install per realm or one request
    // would be answered once per script.
    if (g.__c2sRpcInstalled) return;
    g.__c2sRpcInstalled = true;

    function matches(target) {
      if (!target || target === "any") return true;
      if (target === "background") return isBackground;
      if (target === "content") return !isExtPage;
      if (target === "page") return isExtPage && !isBackground;
      return isExtPage && !isBackground && String(location.pathname || "").indexOf(target) !== -1;
    }
    function serial(v) {
      if (v === undefined) return null;
      try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
    }
    // Paths resolve from the extension API root; a "self." prefix resolves from
    // the realm's global instead (self.top === self, self.__someFlag).
    function resolvePath(path) {
      var parts = String(path || "").split(".");
      var obj = api, parent = null;
      if (parts[0] === "self") { obj = g; parts.shift(); }
      for (var i = 0; i < parts.length; i++) {
        if (obj == null) return null;
        parent = obj;
        obj = obj[parts[i]];
      }
      return { value: obj, parent: parent };
    }
    // An argument of the form { $path: "self.browser.runtime" } is replaced by the
    // value at that path, so natives can be handed real objects across the bridge.
    function callApi(path, args) {
      var r = resolvePath(path);
      if (!r || typeof r.value !== "function") throw new Error("not a function: " + path);
      var real = [];
      if (Array.isArray(args)) {
        for (var i = 0; i < args.length; i++) {
          var a = args[i];
          if (a && typeof a === "object" && typeof a.$path === "string") { var ar = resolvePath(a.$path); real.push(ar ? ar.value : undefined); }
          else real.push(a);
        }
      }
      return r.value.apply(r.parent, real);
    }
    function describe(el) {
      var a = {};
      try { for (var i = 0; i < el.attributes.length; i++) a[el.attributes[i].name] = el.attributes[i].value; } catch (e) {}
      var r = null;
      try { var b = el.getBoundingClientRect(); r = { x: b.x, y: b.y, w: b.width, h: b.height }; } catch (e) {}
      return { tag: el.tagName, text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200), attrs: a, rect: r };
    }
    function dom(req) {
      if (typeof document === "undefined") throw new Error("no document in " + here);
      var sel = req.selector;
      var el = sel ? document.querySelector(sel) : document.documentElement;
      switch (req.action) {
        case "count": return document.querySelectorAll(sel).length;
        case "exists": return !!el;
        case "text": return el ? String(el.innerText || el.textContent || "") : null;
        case "html": return el ? el.outerHTML : null;
        case "attrs": return el ? describe(el) : null;
        case "list": {
          var out = [], all = document.querySelectorAll(sel), lim = req.limit || 50;
          for (var i = 0; i < all.length && out.length < lim; i++) out.push(describe(all[i]));
          return out;
        }
        case "click":
          if (!el) throw new Error("no element for " + sel);
          el.click();
          return true;
        case "value": {
          if (!el) throw new Error("no element for " + sel);
          if (el.isContentEditable) {
            // Editors listen to beforeinput/input from real edits; execCommand
            // produces exactly those, where a textContent write would not.
            el.focus();
            document.execCommand("insertText", false, String(req.value));
            return true;
          }
          // Frameworks read the native setter's value, so go through the prototype's
          // setter rather than the instance property React shadows.
          var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var d = Object.getOwnPropertyDescriptor(proto, "value");
          if (d && d.set) d.set.call(el, req.value); else el.value = req.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        default: throw new Error("unknown dom action " + req.action);
      }
    }
    var WATCH_KEY = "__viaduct_rpc_watch";
    var watched = {}; // event path -> [context targets]
    function watch(path) {
      var wr = resolvePath(path);
      if (!wr || !wr.value || typeof wr.value.addListener !== "function") throw new Error("not an event: " + path);
      var list = watched[path] || (watched[path] = []);
      if (list.indexOf(here) < 0) list.push(here);
      wr.value.addListener(function () {
        var parts = [];
        for (var wi = 0; wi < arguments.length; wi++) { try { parts.push(JSON.stringify(arguments[wi])); } catch (e) { parts.push(String(arguments[wi])); } }
        dbg("[rpc] event " + path + " " + parts.join(" ").slice(0, 400));
      });
    }
    try {
      if (api.storage && api.storage.local) {
        var rearm = function (res) {
          var stored = res && res[WATCH_KEY];
          if (!stored || typeof stored !== "object") return;
          for (var path in stored) {
            if ((stored[path] || []).indexOf(here) < 0) continue;
            try { watch(path); dbg("[rpc] re-armed watch " + path); } catch (e) {}
          }
        };
        var wp0 = api.storage.local.get(WATCH_KEY, function (res) { try { void (api.runtime && api.runtime.lastError); } catch (e) {} rearm(res); });
        if (wp0 && typeof wp0.then === "function") wp0.then(rearm, function () {});
      }
    } catch (e) {}
    function handle(req) {
      dbg("[rpc] " + here + " <- " + String(req.op) + " " + String(req.target) + " " + String(req.path || req.action || ""));
      return new Promise(function (resolve) {
        Promise.resolve().then(function () {
          switch (req.op) {
            case "ping": {
              // Root identity matters (Safari Quirks E15): WebKit dispatches to the
              // native namespace it finds on the global at delivery time, so report
              // what the global currently holds.
              var gb = g.browser, gc = g.chrome;
              var protoTag = function (o) { try { return Object.prototype.toString.call(Object.getPrototypeOf(o)); } catch (e) { return String(e); } };
              var ownKeys = function (o) { try { return Object.getOwnPropertyNames(o).slice(0, 12); } catch (e) { return String(e); } };
              var desc = function (n) {
                try {
                  var d = Object.getOwnPropertyDescriptor(g, n);
                  if (!d) return "inherited";
                  return (d.get ? "accessor" : "data") + (d.writable ? " writable" : "") + (d.configurable ? " configurable" : "") + (d.enumerable ? " enumerable" : "");
                } catch (e) { return String(e); }
              };
              return {
                ctx: here, href: String(location.href),
                apiIsBrowser: api === gb, apiIsChrome: api === gc,
                browserDesc: desc("browser"), chromeDesc: desc("chrome"),
                browser: gb ? Object.prototype.toString.call(gb) : String(gb),
                browserProto: gb ? protoTag(gb) : null,
                browserOwn: gb ? ownKeys(gb) : null,
                chrome: gc ? Object.prototype.toString.call(gc) : String(gc),
                chromeProto: gc ? protoTag(gc) : null,
                chromeOwn: gc ? ownKeys(gc) : null,
                chromeIsBrowser: gc === gb,
                runtimeTag: gb && gb.runtime ? Object.prototype.toString.call(gb.runtime) : null,
                runtimeProto: gb && gb.runtime ? protoTag(gb.runtime) : null,
              };
            }
            case "watch": {
              // Subscribe to browser.<path> and log every dispatch to the ring, so a
              // "does this event fire in this context" question has a measured answer.
              // The subscription is remembered in storage.local and re-armed when a
              // matching context boots, since Safari tears backgrounds down and a
              // listener added after boot is not the same thing as one added at boot.
              watch(String(req.path));
              try {
                if (api.storage && api.storage.local) {
                  var wl = {}; wl[WATCH_KEY] = watched;
                  var wpr = api.storage.local.set(wl, function () { try { void (api.runtime && api.runtime.lastError); } catch (e) {} });
                  if (wpr && typeof wpr.catch === "function") wpr.catch(function () {});
                }
              } catch (e) {}
              return true;
            }
            case "call": return callApi(req.path, req.args);
            case "get": { var r = resolvePath(req.path); return r ? r.value : undefined; }
            case "same": {
              // Identity across paths, since results cross the bridge as JSON.
              var first = resolvePath(req.paths[0]), out = [];
              for (var si = 1; si < req.paths.length; si++) { var o = resolvePath(req.paths[si]); out.push(!!first && !!o && first.value === o.value); }
              return out;
            }
            case "eval": return (0, eval)(String(req.code || ""));
            case "describe": {
              // Where a property lives and whether it can be overridden: own vs
              // inherited, data vs accessor, writable/configurable, the parent's
              // extensibility, and the same for the prototype chain slot.
              var dp = String(req.path).split("."), dn = dp.pop();
              var pr = resolvePath(dp.join(".")); var po = pr ? pr.value : null;
              if (po == null) throw new Error("no parent for " + req.path);
              var chain = [], o = po, depth = 0;
              while (o && depth < 6) {
                var dd = Object.getOwnPropertyDescriptor(o, dn);
                if (dd) chain.push({ depth: depth, kind: dd.get || dd.set ? "accessor" : "data", writable: !!dd.writable, configurable: !!dd.configurable, enumerable: !!dd.enumerable, valueType: typeof dd.value, tag: Object.prototype.toString.call(o) });
                o = Object.getPrototypeOf(o); depth++;
              }
              return { parentExtensible: Object.isExtensible(po), parentTag: Object.prototype.toString.call(po), chain: chain };
            }
            case "dom": return dom(req);
            default: throw new Error("unknown op " + req.op);
          }
        }).then(function (v) {
          resolve({ ok: true, ctx: here, result: serial(v) });
        }, function (e) {
          // Safari's Error.stack carries frames only, so keep the message too.
          resolve({ ok: false, ctx: here, error: String((e && e.message) || e) + (e && e.stack ? "\n" + e.stack : "") });
        });
      });
    }

    var PORT = "__viaduct-rpc";
    // Every extension context listens on its own end of each RPC port and answers
    // only the requests addressed to it.
    try {
      api.runtime.onConnect.addListener(function (port) {
        if (!port || port.name !== PORT) return;
        port.onMessage.addListener(function (msg) {
          if (!msg || typeof msg !== "object" || !msg.__viaduct_rpc) return;
          var req = msg.__viaduct_rpc;
          if (!req || req.token !== TOKEN) return;
          dbg("[rpc] " + here + " port saw target=" + String(req.target));
          if (!matches(req.target)) return;
          handle(req).then(function (res) {
            try { port.postMessage({ __viaduct_rpc_reply: { id: req.id, res: res } }); } catch (e) {}
          });
        });
      });
    } catch (e) {}
    // Extension pages can also hop to one another over sendMessage, where Safari
    // excludes the sender's own page from delivery, so a page-to-page request has
    // no racing undefined reply: `call runtime.sendMessage {__viaduct_rpc: req}`.
    try {
      api.runtime.onMessage.addListener(function (msg) {
        if (!msg || typeof msg !== "object" || !msg.__viaduct_rpc) return;
        var req = msg.__viaduct_rpc;
        if (!req || req.token !== TOKEN) return;
        dbg("[rpc] " + here + " message saw target=" + String(req.target));
        if (!matches(req.target)) return;
        return handle(req);
      });
    } catch (e) {}

    // A content script is the page's way in: it answers "content" itself and
    // forwards everything else over a fresh port per request. onConnect only
    // fires in the contexts alive at connect time, so a port kept open would
    // never reach a page opened later (a side panel tab the background just
    // created); the port closes after the first reply, or after 30s unanswered.
    if (!isExtPage && typeof window !== "undefined") {
      var reply = function (id, res) {
        try { window.postMessage({ __viaduct_rpc_reply: { id: id, res: res } }, "*"); } catch (e) {}
      };
      var send = function (req) {
        var p = api.runtime.connect({ name: PORT });
        var done = false;
        var finish = function () { if (done) return; done = true; try { p.disconnect(); } catch (e) {} };
        p.onMessage.addListener(function (msg) {
          var r = msg && msg.__viaduct_rpc_reply;
          if (!r || r.id !== req.id) return;
          reply(r.id, r.res);
          finish();
        });
        p.onDisconnect.addListener(function () {
          try { void (api.runtime && api.runtime.lastError); } catch (e) {}
          done = true;
        });
        setTimeout(finish, 30000);
        p.postMessage({ __viaduct_rpc: req });
      };
      try {
        window.addEventListener("message", function (ev) {
          var d = ev.data;
          if (ev.source !== window || !d || typeof d !== "object" || !d.__viaduct_rpc) return;
          var req = d.__viaduct_rpc;
          if (!req || req.token !== TOKEN) return;
          if (req.target === "content") { handle(req).then(function (res) { reply(req.id, res); }); return; }
          try { send(req); } catch (e) { reply(req.id, { ok: false, error: String((e && e.message) || e) }); }
        });
      } catch (e) {}
    }
  })();
