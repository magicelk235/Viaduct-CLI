# Grammarly — Safari conversion test report

**Status: ⚠️ PARTIAL.** Background page no longer crashes (a Safari-specific
`chrome.cookies.onChanged` null-event crash is fixed). The popup still does not
finish initializing — but the remaining blocker is **Grammarly-internal** (its
popup-init RPC handshake + a network "treatments"/experiments fetch), not a
converter gap. Live-traced this session: the converter delivers everything
faithfully; Grammarly's own backend/auth flow is what stalls.

Source: `test extensions/Grammarly.zip` (MV3, service worker → background page).
Bundle id: `com.viaduct.GrammarlyAIWritingAssistantandGrammarCheckerApp`.

## What the extension does
AI writing assistant. MV3 service worker backend (converted to a non-persistent
background page), content scripts that inject the editor overlay into web text fields,
and a popup. Uses managed storage (enterprise config), an identity/OAuth bridge,
telemetry, and `runtime` messaging between popup, content scripts, and background.
The popup talks to the background over a long-lived `runtime.connect` port named
`message:to-priv` (the "to privileged" background message bus).

## The problem (as seen live)
Popup shows "Loading Grammarly", then:
```
grm WARN  [universal.popup] Experiments fetch failed, continuing without: "Promise timed out."
grm ERROR [universal.popup] Popup initialization attempt 1/2 failed: "Timeout has occurred"
grm ERROR [universal.popup] All initialization attempts failed, giving up
grm WARN  [lib.tracking.call.transport] tracking call timeout — "timeout call through bg page"
```
And earlier, the fatal one in the **background** page:
```
TypeError: Cannot destructure property 'cookie' from null or undefined  (Grammarly-bg.js)
[idpoly] GLOBAL ERROR
grm ERROR [lib.tracking.telemetry] bg.unhandledException
```

## The process (how it was diagnosed)
Diagnosed entirely from the **background-page console** (the popup relay is
unreliable) using live spy listeners, link by link:

1. **bg was crashing at init.** `Cannot destructure property 'cookie'`. Located the
   offset in `Grammarly-bg.js`: a `chrome.cookies.onChanged` listener doing
   `const {cookie, cause} = changeInfo`. **Safari fires `onChanged` with a NULL
   changeInfo**, so the destructure throws; unhandled in the bg page it takes down
   the whole background → every popup RPC then times out. (Reproduced in Node first:
   `const {cookie}=null` → `TypeError`.)
2. After the cookie fix, **bg stays alive**. Re-traced the popup handshake:
   - `connect`/`onConnect`/`onMessage` all wrapped, `browser === chrome`. ✓
   - Spied `onConnect`: popup opens a **port** `message:to-priv`, `sender.origin` is
     the **lowercase** UUID (the getURL host-lowercasing fix is working). ✓
   - Spied the port: popup sends **18 RPCs** (`cs-to-bg-rpc-…`); bg **`posted:0`** —
     never replies on the port.
   - Spied port lifecycle: **3 connects, 0 disconnects** — the ports stay alive. So
     it's *not* a Safari port-lifecycle/disconnect race; bg simply generates no reply.
   - `chrome.storage.managed.get(...)` was suspected (bg logs "Manage storage
     timeout") but live probe showed it **resolves `{}` and calls back** — not the
     blocker; Grammarly's own managed wrapper logs its own timeout elsewhere.

Conclusion from the trace: the converter side is clean (ports connect, stay open,
messages delivered, origin privileged). What fails is **Grammarly's RPC dispatcher
not answering the popup's init RPCs**, alongside `popupFetchTreatmentsFails:
"Promise timed out"` — a **network** experiments/treatments fetch that depends on
Grammarly's backend/auth (session cookie / network context) under Safari.

## The solution (converter-side fix that landed)
**`chrome.cookies.onChanged` null-event guard** (`safari-compat-shim.js`). Safari
exposes `chrome.cookies.onChanged` but emits a **null** changeInfo. `fill()`
no-clobbers, so the inert stub was skipped and the broken native event survived.
The shim now wraps `onChanged.addListener` to **drop null/undefined events** before
they reach the listener, so a `const {cookie} = changeInfo` listener never throws.
This is a **general fix**: any converted extension whose background listens on
`cookies.onChanged` would otherwise crash its background page on Safari.
Regression covered in `test/emulated-apis.test.js`
("cookies.onChanged: null events are swallowed, real events pass through").

Shared fixes from earlier rounds that also apply (and were re-confirmed live):
shim survives frozen Safari roots; `runtime.connect` wake-proxy; `getURL` host
lowercased so privileged-origin checks pass; managed-storage stub resolves empty.

## What's left — NOT shim-fixable (Grammarly-internal)
- **Popup init RPC handshake unanswered.** bg receives the popup's port RPCs but
  posts no reply. The reply path is gated by Grammarly's own dispatcher/init, which
  is stalled — not by the converter (ports are connected, privileged, and alive).
- **`popupFetchTreatmentsFails` / "Experiments fetch failed: Promise timed out".**
  A network fetch of Grammarly's feature-flag "treatments" times out; the popup's
  init chain depends on it. This is a Grammarly backend/auth/network dependency
  (likely a missing session cookie or network context in the Safari extension),
  same class as Bitwarden's WASM-SDK blocker — document, don't chase.
- **`cookie from null` is fixed**; the remaining `[idpoly] GLOBAL ERROR` and
  `User institution id is not defined` are Grammarly-internal init/identity state,
  not converter throws.
- **Font CSP refusals** (`Refused to load … .woff2`): cosmetic; fallback fonts render.

## Verdict
Converter side is done for Grammarly: the bg-killing `cookies.onChanged` crash is
fixed, and the popup port connects, is privileged, stays alive, and delivers its
messages. The popup still can't finish init because Grammarly's own RPC/treatments
flow doesn't complete under Safari — an extension/backend limitation, not a
converter bug.
