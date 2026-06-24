# Grammarly — Safari conversion test report

**Status: ⚠️ THREE ROOT-CAUSE FIXES LANDED (retest pending).** The popup ("Grammarly
is starting…" forever) was blocked by **three distinct converter bugs**, all now fixed:

1. **bg init hung on `chrome.storage.session.setAccessLevel`** (THE PRIMARY, PROVEN
   blocker) — Safari ships `storage.session` without `setAccessLevel`; Grammarly
   `await`s it through a callback-only promise with no timeout, so bg init stalled
   before registering its RPC listener → every popup RPC queued, bg posted no replies
   (`posted:0`).
2. **Popup↔background port routing by `sender.url` case** — a correct general fix for
   extensions that route ports by `runtime.id`-vs-`sender.url`; not the bug Grammarly
   actually tripped on (its popup detector is case-insensitive), but kept.
3. **Auth proxy couldn't carry the httpOnly session cookie** — the native-host proxy
   forwarded `document.cookie` (which can't see `grauth`), so authenticated calls
   stayed `401 user_not_authorized`. Needed for auth once the popup runs.

Plus an earlier fix this round: a Safari `chrome.cookies.onChanged` null-event crash
that took down the background page.

Source: `test extensions/Grammarly.zip` (MV3, service worker → background page).
Bundle id: `com.viaduct.GrammarlyAIWritingAssistantandGrammarCheckerApp`.

## What the extension does
AI writing assistant. MV3 service worker backend (converted to a non-persistent
background page), content scripts that inject the editor overlay, and a popup. The
popup talks to the background over a long-lived `runtime.connect` port named
`message:to-priv` and drives init through RPCs over that port (`getPageConfig`,
`getExperimentTreatment`, `getTabId`, message channel `cs-to-bg-rpc-…`). Auth is
cookie-based: the httpOnly `grauth` session cookie is sent with `credentials:"include"`
to `*.grammarly.com`.

## The problem (as seen live)
Popup shows "Grammarly is starting…" indefinitely. After the cookies.onChanged crash
fix, the background fully inits (`Background page app started successfully`,
`experiments updated (320)`), but the popup never renders. Console:
```
grm WARN  [universal.popup] Experiments fetch failed, continuing without: "Promise timed out."
grm ERROR [universal.popup] Popup initialization attempt 1/2 failed: "Timeout has occurred"
grm ERROR [universal.popup] All initialization attempts failed, giving up
```
Live port spy (bg console): popup connects `message:to-priv`, sends ~18 RPCs, bg
**posted:0** — receives them, posts no reply. Ports stay alive (3 connect, 0
disconnect), so it is NOT a disconnect race.

## Root cause #1 — popup port never routed (PRIMARY popup blocker)
Traced link by link in `Grammarly-bg.js` (decompiled offsets):
- The bg's RPC reply path routes by **tab id**: `_sendMessageToPorts(msg, tabId)` does
  `this._tabPorts[tabId].filter(...).forEach(p => p.postMessage(msg))`. If
  `_tabPorts[tabId]` is empty, nothing is posted.
- The popup port is only stored if `_initPortListener` can derive an id for it. A
  popover has **no `sender.tab`**, so it relies on `Oa(sender.url)` returning `"popup"`:
  ```js
  if (r = (e.tab ? e.tab.id
        : Oa(e.url) ? "popup" : xa(e.url) ? "sidePanel" : Pa(e.url) ? "devtoolsPanel"
        : undefined),
      r) { this._tabPorts[r].push(port) }
  else en().bgPage.portIdNotFound(...)   // ← popup falls here
  ```
- `Oa()` on the **Chrome build** (`bundleInfo.browser === "chrome"`, baked at build
  time, not UA-detected) takes the case-SENSITIVE branch:
  ```js
  "chrome"===t || "edge"===t ? new RegExp(chrome.runtime.id + "/src/popup.html") : …
  ```
  (There IS a Safari branch — `/^safari-web-extension:\/\/.*\/src\/popup.html$/`, host
  case-insensitive — but it's gated on `extensionType === "safariWebExtension"`, which
  a Chrome-store build is not.)
- **The mismatch:** on Safari `chrome.runtime.id` is the **lowercase** uuid, but
  `sender.url` carries the **UPPERCASE** host (`safari-web-extension://C16B51B5-…/src/popup.html`).
  The regex `c16b51b5-…/src/popup.html` does not match the uppercase URL → `Oa` false
  → `r` undefined → `portIdNotFound` → the port is never stored → the bg posts no
  reply → every popup-init RPC times out.
- Why the popup hangs *forever* (not just the 3 s treatments warning): render is gated
  on `combineLatest([getPageConfig$, treatments$])`. `getExperimentTreatment` is a port
  RPC (self-swallowed after 3 s, non-fatal), but **`getPageConfig` is an un-timed port
  RPC** — with the port dead it never resolves, `combineLatest` never fires, render
  never runs.

This is the documented Safari UUID case quirk (getURL/sender.url UPPER vs sender.origin
lower) — but here it bites **port routing via `runtime.id` vs `sender.url`**, a surface
the shim did not previously normalize (it only fixed `sender.origin`).

### Fix #1 (`safari-compat-shim.js`)
`sender.url` is unpatchable on Safari (frozen exotic getter — assignment and
defineProperty both silently fail; reproduced in a Node `vm` with a frozen sender). So
in `wrapOnConnect` (and the onMessage wrapper) the shim now hands the bundle's listener
a **shallow clone** of the port whose `sender.url` host is **lowercased** to match
`chrome.runtime.id`. The clone uses `Object.create(port)` so `postMessage`/`onMessage`/
`onDisconnect`/`disconnect` still forward to the **real** port — the bg's reply on that
same port reaches the popup. Generic: any extension routing ports by
`runtime.id`-vs-`sender.url` is fixed; for others it's a harmless host-case rewrite of a
value that is case-insensitive as an authority.

Regression: `test/shim-browser-only.test.js` — "onConnect: sender.url host is lowercased
for runtime.id routing, replies still reach the real port (Safari)" and the onMessage
twin. Both fire a **frozen** Safari-style port through the real shim and assert (a) the
bundle's `runtime.id`-regex now matches and (b) the bg's reply reaches the real port.
(Verified anti-vacuous: both fail with the fix neutered.)

## Root cause #2 — auth proxy dropped the httpOnly session cookie
Independent of #1; needed for authenticated requests to succeed once the popup runs.
- Safari treats `safari-web-extension://<uuid>` as **third-party** to grammarly.com, so
  an in-browser `credentials:"include"` fetch is stripped of cookies (ITP) → `401`.
- The converter's recovery — the native-host proxy — retried out-of-process but built
  the `Cookie` header from `document.cookie`, and the `grauth` session cookie is
  **httpOnly** (invisible to `document.cookie`). So the retry carried no session and
  got the same `401`. The recovery never recovered.
- `chrome.cookies` DOES read Safari's real jar incl. httpOnly (proven live:
  `C2S_COOKIES 10`).

### Fix #2 (`safari-compat-shim.js` + `packager.ts`)
The proxy now sources the Cookie header from `chrome.cookies.getAll({url})` (httpOnly
included), `document.cookie` only as fallback. The generated Swift handler disables
URLSession cookie handling (`httpShouldHandleCookies`/`httpShouldSetCookies = false`) so
its empty appex jar can't clobber the forwarded header. Regression in
`test/proxy.test.js` + `test/native-proxy-handler.test.js`.

## Root cause #3 — bg init hangs on `storage.session.setAccessLevel` (the PROVEN `posted:0`)
A deeper audit of the *exact* `posted:0` mechanism found the real, primary blocker —
upstream of #1. Traced link by link in `Grammarly-bg.js`:
- The bg only replies to a port RPC if a `listen("cs-to-bg-rpc-1557421403805", …)` is
  registered. That registration happens when the RPC dispatcher (`class wp`) subscribes
  to its transport (`class vp` → `_message.on(name,…)` → `messageHelper.listen`, draining
  the queued RPCs). `wp` is constructed synchronously at the top of `RB` (legacy bg start).
- `RB` is reached only after a serial `await` chain in the bg bootstrap:
  ```
  await this._migration                               // "Migration completed"
  "chrome-mv3"===sessionStorage.kind &&
     await sessionStorage.allowCStoUseSessionStorage() // ← HANGS HERE (no timeout)
  await this._withTimeout(authSuccessTracker…)          // timeout-guarded
  await (experimentClient init)
  const ue = await RB(…)                                // registers the cs-to-bg-rpc listen()
  ```
- `allowCStoUseSessionStorage` is `new Promise((res,rej)=>chrome.storage.session
  .setAccessLevel?.(lvl, ()=>lastError?rej():res()))` — it settles **only inside the
  callback**. Safari (16.4+) **ships `chrome.storage.session` but WITHOUT `setAccessLevel`**
  (a Chrome-MV3-only API). The optional-chain call short-circuits to `undefined`, the
  callback never fires, the promise **never resolves**, and **no `_withTimeout` guards
  this await** (the very next one does; this one doesn't). Bootstrap stalls before `RB`
  → no `listen()` → all popup RPCs sit in the queue → **got:18, posted:0** → "starting…"
  forever. Exact signature match.
- **The shim gap:** `setAccessLevel` was provisioned only in the *session-wholly-absent*
  branch (`if (!stg.session) {…}`). Safari HAS `session`, so the branch was skipped and
  `setAccessLevel` stayed `undefined`. Same failure class the shim already handled for
  `managed.get`, but missed for `setAccessLevel` on an *existing* session object.

### Fix #3 (`safari-compat-shim.js`)
Backfill a no-op, callback-honoring `setAccessLevel` onto the **existing** Safari
`chrome.storage.session` (and the resolved `browser.storage.session` mirror). The native
session is frozen, so route through `mutableNamespace` to get an extensible clone (it
keeps the real `get`/`set`/`remove` bound) before attaching the method. Generic: any
extension that `await`s `session.setAccessLevel` on Safari would otherwise hang identically.
Regression: `test/emulated-apis.test.js` — "storage.session.setAccessLevel: backfilled on a
frozen native session so init can't hang" (reproduces Grammarly's promise verbatim against
a `Object.freeze`d Safari-style session; **verified anti-vacuous** — fails/hangs with the
fix neutered).

### #1 vs #3 — which actually unblocks Grammarly
Both are real Safari converter bugs, but the **proven** `posted:0` cause is **#3** (init
hang → no `listen()`). #1 (sender.url routing) does **not** change Grammarly's outcome:
its only Safari-active port detector (`Oa`) matches the UUID host with `.*`
(case-insensitive), and `_initPortListener` wires `port.onMessage` and the reply
`port.postMessage` **unconditionally** (outside the port-id `if`), so a mis-resolved
sender.url cannot suppress replies. #1 is kept as a correct general fix for extensions
that route ports by `runtime.id`-vs-`sender.url` (it would otherwise bite them), but #3
is Grammarly's blocker. #2 (cookie) is needed for auth to *succeed* once the popup runs,
not for the popup to render.

## Verified NOT additional converter bugs (audited this round)
- **chrome.storage.managed**: shim stub resolves `{}` for both `chrome.*` and `browser.*`;
  Grammarly's own "Manage storage timeout" resolves (not rejects) and is non-fatal.
- **tabId / panel-doc backfill**: `c2sIsPanelDoc` DOES match Grammarly's popup
  (`action.default_popup === "src/popup.html"`), and the init path has an `activeTab`
  fallback, so a missing popover tabId doesn't stall init.
- **experiments/treatments fetch timeout**: `getExperimentTreatment` is self-swallowed
  after 3 s ("continuing without") and render does **not** depend on it; render is gated on
  the port RPCs (fixed by #3/#1), so the treatments fetch race is non-fatal.
- **`User institution id is not defined` / `[idpoly] GLOBAL ERROR`**: Grammarly-internal,
  non-fatal (graceful early-return for accounts without an institution; the idpoly global
  error listener is in the bg, not a popup throw).
- **Font CSP refusals**: cosmetic; fallback fonts render.

## What's left
- **Retest in Safari** with the new build (reinstall cycle + quit/reopen Safari; verify
  the new shim reached the installed `.appex`). Expect: bg bootstrap now passes
  `allowCStoUseSessionStorage` (milestone log continues past "Migration completed"),
  reaches `RB`, registers the `cs-to-bg-rpc` listener, drains the queued RPCs →
  `posted:N>0`, `getPageConfig` resolves, the popup renders. Quick confirm from the bg
  console: `typeof chrome.storage.session.setAccessLevel` should now be `"function"`.
  Then `C2S_USERINFO` should flip `401 → 200` once signed in (fix #2).
- **Residual platform risk (not converter):** if `auth.grammarly.com` additionally
  requires a CSRF token bound to the session, or the user isn't signed in, auth may still
  fail — but that's backend policy / login state, not the converter.

## Verdict
Three real converter bugs were found and fixed. The **primary** popup blocker is #3: bg
init hung forever on `chrome.storage.session.setAccessLevel` (undefined on Safari, no
timeout), so the bg never registered its RPC listener and posted no replies (`posted:0` →
"starting…" forever). #1 (port routing by `sender.url` case) is a correct general fix but
is not what Grammarly tripped on. #2 (httpOnly session cookie via `chrome.cookies`) lets
auth succeed once the popup runs. Each fix has an anti-vacuous regression test; the full
suite (223) passes. Pending a Safari retest to confirm end to end.
