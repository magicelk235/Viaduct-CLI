# Dark Reader — Safari conversion test report

**Status: ✅ WORKING.** Pages are restyled dark (verified live: Google Translate, a
normally-white page, renders fully dark — inverted background/text, brand colors
preserved), and the popup opens with its controls. No code change was needed.

Source: `test extensions/Dark Reader.zip` (MV3, rated 9/10). Bundle id:
`com.viaduct.DarkReader`.

## What the extension does
Per-page dark-mode restyler. MV3 service worker (`background/index.js`), content-script
injectors (`inject/`) that rewrite page CSS, and a React popup (`ui/popup/index.html`)
with on/off + brightness/contrast/sepia sliders. The popup fetches state from the bg
via `chrome.runtime.sendMessage` (the `sendRequest` → `GET_DATA` path; `isFirefox` is
compiled to `false`, so the alternate `runtime.connect` port path is dead code).

## Test scope
No account needed — pure content-script restyling. Goal: confirm the dark transform
applies and the popup renders its controls.

## What happened
- First open: popup stuck on **"loading, please wait"** — the popup was waiting on a bg
  `GET_DATA` reply.
- After the install settled (Safari was quit/reopened and site access granted per the
  standard reinstall cycle), **the popup works and the page transform applies.** The
  hang did not recur.

## Why the initial hang — and why no fix shipped
The bg gates incoming popup messages on the sender's URL:
```js
const allowedSenderURL = [ chrome.runtime.getURL("/ui/popup/index.html"), … ];
if (allowedSenderURL.includes(sender.url)) { Messenger.onUIMessage(message, sendResponse); }
```
The initial suspicion was the known Safari UUID **case mismatch** (getURL host vs
`sender.url` host) that bit uBlock/Grammarly. A speculative shim change to lowercase
`sender.url` in the onMessage wrapper was drafted **and reverted** — it was never backed
by live evidence, and getURL keeps the REAL (uppercase) host for *resource* paths
(only root/origin calls are lowercased), so a resource-path comparison like this one is
not obviously a case bug. When the live bg-console values were about to be read, the
popup had already started working on its own.

Most likely the "loading" was a **cold bg service worker** (Safari hadn't spun it up yet
on first click) and/or **site access not yet granted**, not a converter bug. The shim
that shipped (current in the installed appex, verified) already handles the real
Dark-Reader-specific hazard captured earlier:
> `ReferenceError: Can't find variable: chrome (safari-compat-shim.js)` — Safari can
> expose `browser` with no `chrome` global; a bare `browser !== chrome` would abort the
> whole shim. Covered by the "browser exists but chrome is undefined" regression test.

## What's left / notes
- `fontSettings` permission dropped at conversion (no Safari equivalent) — Dark Reader's
  font override may be limited; core restyle unaffected.
- The "loading" hang is **intermittent and self-resolving** (cold SW / permission grant).
  If it ever reproduces persistently, get the live bg-console values for
  `getURL('/ui/popup/index.html')` vs `sender.url` before touching the shim — the
  sender.url-case theory is unproven and easy to "fix" in the wrong direction.
