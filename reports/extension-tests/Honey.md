# Honey: Automated Coupons & Rewards — Safari conversion test report

**Status: ⚠️ Partial.** Converts and installs; the background service worker runs and
its network calls succeed (proxy working). One real converter bug was found and fixed
along the way (a `setBadgeText` init-abort, now general). The popup still renders empty
because Honey's popup↔bg `stores:action` message gets no reply on Safari — a deeper
multi-transport messaging issue left unresolved (diminishing returns on a 9/10 beast).

Source: `test extensions/Honey.zip` (MV3, rated 9/10). Bundle id:
`com.viaduct.HoneyAutomatedCouponsRewards`.

## What the extension does
Coupon/cashback. MV3 service worker (`h0.js`), a React popover (`popover/popover.html`
→ `h1-*` chunks), content scripts across `<all_urls>`, an offscreen document for
hidden affiliate-tag iframes, and a custom messaging layer with TWO transports: a
port-based `AdbBpContext` (`runtime.connect`, name `adbbp:cs`) and a
`runtime.sendMessage` path. The popup fetches state via
`content.send("stores:action", …, {background:true})`.

## Bug found + fixed: setBadgeText init-abort (general)
Live bg console:
```
[idpoly] UNHANDLED REJECTION: Invalid call to action.setBadgeText(). Tab not found.
  (anonymous) (h0.js:27…)
```
`chrome.action.setBadgeText({…tabId})` REJECTS on Safari with "Tab not found" when the
tabId is stale/absent — on Chrome it's a global no-op that never rejects. Honey awaits
it in its bg init chain, so the unhandled rejection aborted init. Any extension awaiting
a badge/title/icon setter at startup was silently dying on Safari.

**Fix** (`safari-compat-shim.js`): wrap `action.setBadgeText` /
`setBadgeBackgroundColor` / `setTitle` / `setIcon` — on a "tab not found" reject, retry
once without `tabId` (the global badge still updates), then swallow. A cosmetic badge
failure can never abort init again. Regression test added (`shim-browser-only.test.js`);
231 tests pass. Verified live: the setBadgeText error no longer appears.

## What's still broken (unresolved)
After the badge fix, the popup is still empty. Live evidence:
- Popup console, first error:
  `NoMessageListenersError: No listeners for message of type stores:action in content.send()`
  then a secondary `TypeError: Cannot call a class as a function` (fallout).
- bg console: no errors. A bg→bg `sendMessage({type:'stores:action'})` returns
  `undefined`. Arming `onConnect` and opening the popup logs **no port connect**.
- The `content.send` throw site (`h1-vendors-main-popover.js`) checks
  `chrome.runtime.lastError` / `response.noListeners` — i.e. the **sendMessage** path —
  yet `stores:action` is also wired through the **port** (`AdbBpContext`,
  `this.port.onMessage`). Honey runs both transports and the evidence is ambiguous about
  which one the popup's `stores:action` actually rides on Safari.

**Leading hypothesis (untested):** bg's `stores:action` handler returns a Promise /
`return true` async response that Safari drops (the documented Safari "return true is
ignored" quirk the oauth-bridge already works around), so the popup sees no reply →
`noListeners`. Confirming needs live bg instrumentation of the `y.A` dispatcher's reply
path, not console one-liners — deferred.

## Platform limits (documented, not chased)
- **offscreen** dropped at conversion (no Safari API). Honey's offscreen is a hidden
  affiliate-tag iframe (`offscreen:tag`), lazy on shopping actions — NOT on the init or
  popup path, so it is not the empty-popup cause. The shim stubs `createDocument` (→
  resolves undefined); the affiliate-tag feature degrades.
- **Blocking webRequest** → warning; Safari ignores the blocking return, extension loads.

## What's left
- Resolve the `stores:action` no-reply (port vs sendMessage transport; likely the
  Safari async-response drop). Requires gated bg diagnostics on the `y.A` dispatcher.
- Re-test the popup once routing replies; then the coupon/cashback flows (needs an
  account).
