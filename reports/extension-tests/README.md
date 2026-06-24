# Safari conversion test reports

Live-testing of the three most complex extensions in `test extensions/` (per the
`rating` file), converted with `node dist/cli.js <input> --install --force --clean`
and tested in Safari with the bg-page Web Inspector.

| Extension | Status | Headline result |
|-----------|--------|-----------------|
| [uBlock Origin](./uBlock-Origin.md) | ✅ Working | Popup loads, live block stats render |
| [Bitwarden](./Bitwarden.md) | ⚠️ Partial | UI loads; WASM SDK + passkey are platform limits |
| [Grammarly](./Grammarly.md) | ⚠️ Two fixes landed | popup port now routed (runtime.id-vs-sender.url case fix; was posted:0 → "starting…" hang) + proxy carries httpOnly cookie; retest pending |

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
3. **Extension UUID case mismatch.** `getURL()`/`sender.url` UPPERCASE, `sender.origin`
   + `chrome.runtime.id` lowercase. Two breakages, same root:
   (a) `sender.origin === getURL('').slice(0,-1)` privileged checks fail → blank popups
   → lowercase the extension host in `getURL()` output (authority case-insensitive per
   RFC 3986).
   (b) port routing via `new RegExp(runtime.id + "/src/popup.html").test(sender.url)`
   fails (lower id vs UPPER url) → popup port unrouted → bg posts no reply → popup hangs
   (Grammarly "starting…"). `sender.url` is an exotic frozen getter (unpatchable) →
   `wrapOnConnect`/onMessage pass the bundle a port/sender clone with a lowercased
   `sender.url` host, methods still forwarding to the real port.
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
