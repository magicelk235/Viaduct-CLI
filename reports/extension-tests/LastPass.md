# LastPass: Free Password Manager — Safari conversion test report

**Status: ✅ WORKING (clean first-try).** Popup renders, the login form submits, and a
real LastPass server response comes back ("Check your master password and try again")
— so the popup → background → network → content round-trip is intact end to end. No
shim throws, background-page and popup consoles clean.

Source: `test extensions/LastPass.zip` (MV3, rated 10/10). Bundle id:
`com.viaduct.LastPassFreePasswordManager`.

## What the extension does
Password manager. MV3 service worker (`background-redux-new.js`) plus a vault/login
popup, content scripts for field detection/autofill across `<all_urls>`, and a zxcvbn
password-strength worker. The popup talks to the background over messaging to drive
login and vault state.

## Test scope
Smoke test only — no LastPass account available. Goal: confirm it loads and the
message/network path is live, not a full vault/autofill exercise.

## Result
- Popup opens and renders the login UI.
- Submitting login with arbitrary credentials returns the genuine server-side error
  ("Check your master password and try again. … Contact the people who manage LastPass
  at your organization."). That error is **from LastPass**, which proves: popup booted,
  background received the request, the network call left Safari, and the response was
  routed back to the popup and rendered.
- `read_console(level=error)` on the active tab: **empty**. No shim-abort, no
  frozen-namespace throw, no port-routing failure.

## Why this converted cleanly (no fix chain needed)
Everything LastPass triggers was already handled by fixes landed for the earlier
extensions:
- **Frozen `browser`/`chrome` roots** — outer try/catch backstop + root thawing keep
  the prepended shim from aborting the script chain.
- **UA Chrome-version sniff** (4 files) — shim appends a synthetic `Chrome/120.0.0.0`
  token so the sniff resolves.
- **Blocking webRequest** — warned, not blocked; Safari ignores the blocking return but
  the extension still loads (correct severity).
- **Dynamic `importScripts`** (`zxcvbn-worker.js`, SW) — warned; the strength worker is
  non-critical to login, so the smoke path is unaffected.
- Dropped Chrome-only bits at conversion: `update_url`, `offscreen` permission;
  `privacy`/`omnibox`/`contextMenus` flagged (no Safari equivalent), none on the login
  path.

## What's left
- **Full vault flow untested** — login with a real account, autofill on a live site,
  save credential. Needs a LastPass account; the smoke result says the transport is
  sound, but autofill content-script injection across `<all_urls>` is unverified.
- `storage.sync` maps to local (no cross-device iCloud sync) — platform limit, shimmed.
- Dynamic `importScripts` in the zxcvbn worker won't hoist — password-strength meter
  may be degraded; not on the login path, not chased.
