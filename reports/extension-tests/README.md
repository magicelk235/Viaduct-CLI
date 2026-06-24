# Safari conversion test reports

Live-testing of the most complex extensions in `test extensions/` (per the
`rating` file), converted with `node dist/cli.js <input> --install --force --clean`
and tested in Safari with the bg-page Web Inspector.

| Extension | Status | Headline result |
|-----------|--------|-----------------|
| [uBlock Origin](./uBlock-Origin.md) | ✅ Working | Popup loads, live block stats render |
| [Bitwarden](./Bitwarden.md) | ⚠️ Partial | UI loads; WASM SDK + passkey are platform limits |
| [Grammarly](./Grammarly.md) | ✅ Working | Popup renders, account loads. Took a 5-fix chain; the unblocker was a conversion-time rewrite stripping the `runtime.id +` prefix from the popup port-routing regex (Safari's `runtime.id` is the bundle id, not the URL-host UUID, and the slot is unfixable at runtime) |
| [LastPass](./LastPass.md) | ✅ Working | Clean first-try: popup renders, login round-trips to LastPass servers (real "check your master password" response). Smoke test only — no account. Full vault/autofill flow unverified |
| [Loom](./Loom.md) | ⚠️ Loads | Shim intact (scripting present, no abort); popup blank in logged-out state (opens web signup by design). `tabCapture`/`desktopCapture` dropped → recording is a platform limit. Logged-in flow unverified (no account) |
| [Dark Reader](./Dark-Reader.md) | ✅ Working | Page restyled dark (verified on Google Translate), popup + controls render. Popup "loading" hung on first click then self-resolved (cold SW / permission grant); no code change needed |

## Cross-cutting root causes found this round
All pinned with **live diagnostics** (debug flag → `chrome.storage.local` → read from
the reliable background-page console), not by guessing from pasted errors.

1. **Frozen roots abort the shim.** Safari exposes `browser`/`chrome` and some
   sub-namespaces as non-extensible. A raw `api.storage.sync = {}` threw and escaped
   its block, aborting the entire prepended shim (dead popup/content/bg). → outer
   try/catch backstop + thaw-and-republish frozen roots on the global bindings.
2. **`chrome.scripting` is an exotic immutable slot.** assign/defineProperty are silent
   no-ops, `delete` re-materializes it. ExecutionWorld/RegistrationWorld can't be
   installed. → converter inlines the enum reads to string literals
   (`inlineImmutableEnums`).
3. **Extension UUID case mismatch.** `getURL()`/`sender.url` UPPERCASE the UUID host,
   `sender.origin` lowercases it → `sender.origin === getURL('').slice(0,-1)` privileged
   checks fail → blank popups. Fix: lowercase the extension host in `getURL()` output
   (authority case-insensitive per RFC 3986); the onConnect/onMessage wrappers also hand
   the bundle a sender clone with the host lowercased for the same equality checks.
3b. **`chrome.runtime.id` ≠ URL-host UUID (Grammarly's popup blocker).** Distinct from the
   case mismatch above: on Safari `runtime.id` is the App-Extension **bundle id**
   (`com.…Extension (TEAM)`), while every extension URL's host is the per-install **UUID**.
   Bundles that route the popup/side-panel port by
   `new RegExp(runtime.id + "/src/popup.html").test(sender.url)` therefore never match →
   port unrouted → bg posts no reply → popup hangs ("starting…"). `runtime.id` is a frozen
   exotic slot (assignment + `defineProperty` no-op; `chrome.runtime` itself unreplaceable —
   all proven live), so it can't be fixed in the shim → the converter strips the
   `runtime.id +` prefix at staging (`rewriteRuntimeIdUrlMatchers`), making the matcher
   host-agnostic and tolerant of Safari's `?tabId=N` popover query. The native event wrap
   it relies on needs `installOverride` (Safari `addListener` is `{w:false,c:true}`), and
   the port clone must forward methods **bound to the real port** (native `postMessage`
   brand-checks `this`).
4. **getURL("") on a frozen runtime** returned ""/undefined (uBlock crash) → wrap via a
   mutable runtime clone with native methods bound.
5. **runtime.connect to a suspended bg throws** → proxy Port that wakes the bg and
   retries, buffering traffic.

## Method (what worked, after a lot of console ping-pong)
- The popover console relay is flaky; the **background-page console is reliable**.
- Write structured diagnostics to `chrome.storage.local` from the shim (gated by
  `__C2S_DEBUG__`), read them from the bg console. Trace the failing flow **link by
  link** (connect → request arrives → reply posted → privileged flag → exact string
  values) instead of guessing from symptom errors.
- Reproduce each suspected Safari behavior in a Node `vm` context (frozen objects,
  exotic getters) so the fix is proven locally before reinstalling.
