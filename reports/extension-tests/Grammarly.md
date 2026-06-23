# Grammarly — Safari conversion test report

**Status: 🔶 NOT YET RE-VERIFIED with the final fixes.** Last observed: popup stuck at
"Grammarly is starting…". The connect/privileged/getURL fixes that unblocked uBlock
apply to Grammarly's popup too and are expected to help, but a fresh retest is pending.

Source: `test extensions/Grammarly.zip` (MV3, service worker → background page).
Bundle id: `com.viaduct.GrammarlyAIWritingAssistantandGrammarCheckerApp`.

## What the extension does
AI writing assistant. MV3 service worker backend (converted to a non-persistent
background page), content scripts that inject the editor overlay into web text fields,
and a popup. Uses managed storage (enterprise config), an identity/OAuth bridge,
telemetry, and `runtime` messaging between popup, content scripts, and background.

## The problem (as seen live)
```
TypeError: Cannot destructure property 'cookie' from null or undefined  (Grammarly-bg.js)
grm ERROR [extension-api.managed-storage.chrome] Manage storage timeout to get "GrammarlyExtensionMode"
grm ERROR [extension-api.managed-storage.chrome] Manage storage timeout to get "GrammarlyEnrollmentToken"
[idpoly] bridge msg but NO captured onMessageExternal listeners — SW handler not registered/captured
grm ERROR [universal.popup] Popup initialization attempt 1/2 failed: "Timeout has occurred"
… "All initialization attempts failed, giving up"
Refused to load chrome-extension://…  (multiple CSP / resource warnings)
```
The popup repeatedly times out initializing — it never completes its handshake with
the background page, mirroring the same popup↔bg messaging wall uBlock hit.

## The process (how it was diagnosed)
Grammarly shared root causes with uBlock and Bitwarden, diagnosed via the same live
`chrome.storage.local` + bg-console method:
- **Frozen namespaces** were aborting the shim early (fixed: outer try/catch + thaw).
- **managed-storage timeouts**: Safari's strict native APIs and missing managed config;
  the shim softens/stubs managed storage so reads resolve instead of hanging.
- **popup init timeout**: the popup's privileged handshake with the bg is gated by the
  same `sender.origin === getURL-derived origin` pattern that the **UUID case-mismatch**
  defeats (see uBlock report). The getURL host-lowercasing fix addresses that class.

## The solution (shared fixes, applied; retest pending)
- Shim survives frozen Safari roots (no early abort).
- `runtime.connect` wake-proxy + `getURL` via mutable runtime clone.
- **getURL host lowercased** so `sender.origin`-vs-origin privileged checks pass — the
  fix that unblocked uBlock's popup. Grammarly's popup uses the same mechanism.
- Strict-native wrappers (tabs.query windowId:-1, etc.) and managed-storage softening.

## What's left
- **Retest required** after the final build to confirm the popup gets past
  "starting…". If it still times out, trace the popup→bg handshake with the same
  storage-backed diagnostic used for uBlock (confirm privileged + reply round-trip).
- **`cookie from null`** in `Grammarly-bg.js`: Grammarly reads a cookie/session object
  that is null on Safari (no cookie access in that context or a different auth flow).
  Likely needs `chrome.cookies` shimming or is Grammarly-internal — investigate if it
  blocks login after the popup loads.
- **`Refused to load chrome-extension://…` / font CSP**: cosmetic CSP refusals;
  fallback fonts render. Not blocking.
- **identity/OAuth bridge** `onMessageExternal` capture: verify the OAuth handshake
  once the popup initializes.
