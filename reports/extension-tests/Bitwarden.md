# Bitwarden Password Manager — Safari conversion test report

**Status: ⚠️ PARTIAL.** UI loads and renders (the only one of the three whose UI worked
before this round). Vault SDK and passkeys remain blocked by platform limits.

Source: `test extensions/Bitwarden.zip` (MV3, service worker → background page).
Bundle id: `com.viaduct.BitwardenPasswordManager`.

## What the extension does
Password manager. MV3 service worker backend (converted to a non-persistent
background page) running a WASM crypto SDK; popup/inline UI for vault, autofill,
passkey (WebAuthn) login. Heavy use of `chrome.scripting` (content/script injection
with `ExecutionWorld`), `chrome.runtime` messaging, and managed storage.

## The problem (as seen live)
```
TypeError: undefined is not an object (evaluating 'chrome.scripting.ExecutionWorld.ISOLATED')  (background.js)
Error: SDK loading failed: TypeError: undefined is not an object (evaluating 'a[e].call')      (background.js)
[IPC] Initialization failed
passkey login failed: SecurityError (RPID)
Invalid call to runtime.connect(). No runtime.onConnect listeners found.
```

## The process (how it was diagnosed)
This extension drove the deepest diagnosis because its failures were "succeed silently
then vanish." Using live `chrome.storage.local` diagnostics read from the bg console:

1. Found `chrome.scripting.ExecutionWorld` undefined despite the shim claiming to
   backfill it. Added a marker (`__c2sScriptingSeen`) — it was **false** while every
   *other* late shim marker was true → the shim ran fully, but the scripting write
   evaporated.
2. Probed `chrome.scripting`'s property descriptor live and tested mutation:
   - assign → silent no-op (no throw, value unchanged)
   - `defineProperty` → silent no-op
   - `delete` → returns `true`, but the empty native slot **re-materializes**
   → `chrome.scripting` is an **exotic, immutable host slot**. The enums cannot be
   installed from JS by any means.
3. Separately confirmed the top-level `chrome`/`browser` and some sub-namespaces are
   **frozen**, which had been silently aborting the shim earlier (`api.storage.sync = {}`
   threw and escaped its block).

## The solution
- **ExecutionWorld/RegistrationWorld:** since they're fixed string constants and the
  namespace is immutable, **inline the reads at conversion time** —
  `inlineImmutableEnums` (src/input/stage.ts) rewrites
  `chrome.scripting.ExecutionWorld.ISOLATED` → `"ISOLATED"` in the staged bundle
  (covers `chrome`/`browser`, dot/bracket access). 7 Bitwarden scripts rewritten,
  0 residual reads. **This fixed the bg `ExecutionWorld` crash and the UI now loads.**
- **Frozen-namespace shim abort:** outer try/catch backstop + thaw-and-republish of
  frozen roots so the shim runs to completion.
- **runtime.connect / getURL:** same general fixes as the other extensions
  (wake-proxy, getURL via mutable runtime clone, host lowercasing).

## What's left — platform limits (NOT shim-fixable)
- **WASM SDK load failure** (`a[e].call`): Bitwarden's crypto SDK is loaded via a
  webpack chunk mechanism that fails under Safari's extension CSP/module handling.
  Blocks vault unlock / full functionality. Needs either an unbundled SDK build or a
  Safari-specific loader from Bitwarden — out of scope for the converter.
- **Passkey login `SecurityError` (RPID):** WebAuthn binds the credential to the
  Relying Party's origin. A Safari Web Extension cannot present the RP's origin, so the
  passkey assertion is rejected by the platform. Hard WebAuthn constraint; master
  password is the supported path (and depends on the SDK above).

## Verdict
The converter side is done for Bitwarden — UI renders, scripting/connect/storage fixed.
Remaining blockers are Bitwarden-internal (WASM SDK) and WebAuthn platform constraints.
