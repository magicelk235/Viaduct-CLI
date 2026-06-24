# Grammarly — Safari conversion test report

**Status: ⚠️ AUTH FIX LANDED (retest pending).** Two converter bugs were fixed
this round: (1) a Safari-specific `chrome.cookies.onChanged` null-event crash that
took down the background page, and (2) — the popup blocker — the native-host
auth **proxy could not carry Grammarly's httpOnly session cookie**, so every
authenticated request stayed `401 user_not_authorized` and the popup never left
"Grammarly is starting…". The proxy now sources cookies from `chrome.cookies`
(Safari's real jar, httpOnly included) instead of `document.cookie`.

Source: `test extensions/Grammarly.zip` (MV3, service worker → background page).
Bundle id: `com.viaduct.GrammarlyAIWritingAssistantandGrammarCheckerApp`.

## What the extension does
AI writing assistant. MV3 service worker backend (converted to a non-persistent
background page), content scripts that inject the editor overlay into web text fields,
and a popup. Uses managed storage (enterprise config), an identity/OAuth bridge,
telemetry, and `runtime` messaging between popup, content scripts, and background.
The popup talks to the background over a long-lived `runtime.connect` port named
`message:to-priv` (the "to privileged" background message bus). Auth is **cookie-
based**: the `grauth` session cookie (httpOnly) is sent with `credentials:"include"`
to `auth.grammarly.com` / `*.grammarly.com` endpoints (`/v5/api/userinfo`, the
treatments/experiments service, etc.).

## The problem (as seen live)
Popup shows "Grammarly is starting…" forever. Background logs `experiments updated`
(bg init completes after the cookie-crash fix), but the popup's init chain dies on:
```
grm WARN  [universal.popup] Experiments fetch failed, continuing without: "Promise timed out."
grm ERROR [universal.popup] Popup initialization attempt 1/2 failed: "Timeout has occurred"
grm WARN  [lib.tracking.call.transport] tracking call timeout — "timeout call through bg page"
```
Live probes from the bg console isolated the true cause:
```
C2S_COOKIES  10            ← chrome.cookies.getAll DOES see 10 grammarly cookies
C2S_AUTH     405 type:basic ← network to auth.grammarly.com works (real CORS response)
C2S_USERINFO 401 {"error":"user_not_authorized"}  ← the authenticated call is rejected
```

## Root cause (traced link by link)
The session cookie was never reaching the backend — by **two** compounding paths,
both converter-relevant:

1. **Direct in-browser fetch** (`credentials:"include"`): Safari treats the
   `safari-web-extension://<uuid>` origin as **third-party** to `grammarly.com`, so
   ITP strips the site cookies from the request → backend answers `401
   user_not_authorized`. (Platform behavior — but the converter already has a
   recovery path for exactly this: the native-host proxy.)

2. **The native-host proxy retry** (the recovery) **was also failing auth.** On a
   401/403 (or a hard CORS block) the shim retries the request out-of-process
   through the Swift `SafariWebExtensionHandler`, which can set the real Chrome
   `Origin` and isn't subject to CORS. But it built the forwarded `Cookie` header
   from **`document.cookie`** — and a session cookie like `grauth` is **httpOnly**,
   so it is *invisible* to `document.cookie`. The proxy therefore retried **without
   the session cookie** and got the same 401. The recovery never recovered.

The asymmetry that unlocks the fix: **`chrome.cookies` reads Safari's real cookie
jar, httpOnly cookies included** — proven live (`C2S_COOKIES 10` returned the
grammarly cookies). `document.cookie` cannot. The proxy was simply reading from the
wrong source.

## The solution (converter-side fix that landed)
**Source the proxy's Cookie header from `chrome.cookies`, not `document.cookie`**
(`safari-compat-shim.js`). New `gatherCookieHeader(url)`:
`chrome.cookies.getAll({url})` → `name=value; …` (httpOnly included), falling back
to `document.cookie` only when the cookies API is unavailable. `proxyFetch` awaits
it before posting to the native host. Works from both the popup and the bg page
(both hold the `cookies` permission).

**Stop URLSession from clobbering the forwarded cookie** (`packager.ts`, the
generated Swift proxy handler). The appex's `HTTPCookieStorage.shared` is empty
(it does not share Safari's browser jar); if URLSession were allowed to manage
cookies it would strip/replace our explicit, authenticated `Cookie` header. Set
`req.httpShouldHandleCookies = false` and `cfg.httpShouldSetCookies = false`
(`httpCookieAcceptPolicy = .never`) so the header we built from `chrome.cookies`
is what actually goes on the wire.

This is **general**: any converted extension whose backend authenticates via an
httpOnly cookie (the common case) hit the same dead end — the proxy retry could
never carry the session. Now it can.

Regression coverage:
- `test/proxy.test.js` — "proxy cookie sourcing: httpOnly cookie from
  chrome.cookies lands in the header" (+ updated proxy-hardening assertions).
- `test/native-proxy-handler.test.js` — "forwarded Cookie header isn't clobbered
  by URLSession's empty jar".

Shared fixes from earlier rounds that also apply (re-confirmed live): shim survives
frozen Safari roots; `runtime.connect` wake-proxy; `getURL` host lowercased for
origin checks only (resource paths keep real case); managed-storage stub resolves
empty; `cookies.onChanged` null-event guard; `connect-src 'self'` injection.

## What's left
- **Retest in Safari** with the new build: confirm `C2S_USERINFO` flips from `401`
  to `200` (cookie now carried via the proxy) and the popup completes init. The
  reinstall cycle matters — verify the new shim + Swift handler reached the
  installed `.appex` before retesting.
- **Residual platform risk (not converter):** if `auth.grammarly.com` additionally
  requires a CSRF token bound to the session, or otherwise rejects the spoofed-
  Origin server-side request, that is a backend policy beyond the converter. The
  *cookie-not-carried* root cause — the thing that made auth structurally
  impossible — is fixed.
- Font CSP refusals (`Refused to load … .woff2`): cosmetic; fallback fonts render.

## Verdict
The converter bug that blocked Grammarly's popup is identified and fixed: the
native-host auth proxy now carries the httpOnly session cookie (read via
`chrome.cookies`) instead of dropping it, and the Swift handler no longer lets an
empty URLSession jar overwrite it. Pending a Safari retest to confirm the popup
finishes init end-to-end.
