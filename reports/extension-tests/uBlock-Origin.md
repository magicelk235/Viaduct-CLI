# uBlock Origin — Safari conversion test report

**Status: ✅ WORKING.** Popup loads and renders live data ("Domains connected: 6 out of 6", per-page block counts). Content blocking active.

Source: `test extensions/uBlock Origin.zip` (MV2). Bundle id: `com.viaduct.uBlockOrigin`.

## What the extension does
Wide-spectrum content blocker. Filters network requests and cosmetically hides page
elements via filter lists. The toolbar popup shows per-page/global block stats, a
power toggle, and (under "More") the advanced dynamic-filtering firewall pane. The
popup is a privileged extension page that talks to the background page over a
long-lived `runtime.connect` port to fetch `popupData`.

## The problem (as seen live)
Popup opened blank. Console:
```
TypeError: null is not an object (evaluating 'popupData.cnameMap')  (popup-fenix.js:83)
TypeError: undefined is not an object (evaluating 'v.split')        (popup-fenix.js:517)
vAPI.getURL('').slice  → undefined is not an object                 (earlier rounds)
Invalid call to runtime.connect(). No runtime.onConnect listeners found.  (earlier rounds)
```
`cachePopupData(null)` → `popupData.cnameMap` null → render crash → blank popup.

## The process (how it was diagnosed)
Repeated console-relay guessing failed. Switched to **live diagnostics**: enable a
debug flag in the shim that writes structured state to `chrome.storage.local`, then
read it from the **background-page console** (which is reliable, unlike the popover
console). Traced the popup→bg message flow link by link:

1. `runtime.connect()` outcome — traced to storage → `native-ok`. So connect was NOT
   the problem (the "No onConnect" errors were stale from an earlier build).
2. Did the `getPopupData` request reach the bg port? — traced → **yes** (`got:true`).
3. Did the bg reply? — traced → **no reply ever posted**.
4. Why no reply? uBlock only answers the privileged `popupPanel` channel if
   `portDetails.privileged === true`. Dumped `vAPI.messaging.ports` → **`priv:false`**.
5. Why unprivileged? uBlock computes
   `privileged = sender.origin === getURL('').slice(0,-1)`. Dumped the live values:
   - `sender.origin` = `safari-web-extension://540eb6c5-…` (**lowercase**)
   - `getURL('')`    = `safari-web-extension://540EB6C5-…/` (**UPPERCASE**)
   → `lower === UPPER` is **false** → port judged unprivileged → request unanswered.
6. Tried to rewrite `sender.origin` to the correct case in an `onConnect` wrapper.
   It "succeeded" (`did:true`) but the port stayed unprivileged. Probe showed
   `port.sender` is an **exotic getter returning a fresh object on every read**
   (`sameObj:false`) — the mutation didn't persist to the read uBlock made.

## The solution
A URL authority/host is case-insensitive per RFC 3986, and Safari itself is already
inconsistent about the UUID case across APIs. So instead of fighting the immutable
`sender.origin`, **lowercase the extension host in `runtime.getURL()`'s output**
(`patchGetURL` → `lowerHost`). Path is preserved (case-sensitive); only the
`safari-web-extension://<host>` authority is lowercased. uBlock's `PRIVILEGED_ORIGIN`
(derived from `getURL`) is then lowercase and **equals** the lowercase
`sender.origin` → the popup port is privileged → `getPopupData` is answered →
`cnameMap` populates → popup renders.

Supporting fixes that had to land first for uBlock to get this far:
- **getURL("") on a frozen runtime** returned ""/undefined → `vAPI.getURL("").slice`
  crash. Wrapped getURL via a mutable runtime clone (native methods bound).
- **Shim no longer aborts** on Safari's frozen namespaces (outer try/catch backstop +
  root thawing), so the whole prepended script chain runs.

This is a **general fix**: any extension that privilege-gates by comparing
`sender.origin` to a `getURL`-derived origin was silently failing on Safari.

## What's left
- **Cosmetic only:** the popup content is offset right with an empty left gutter. This
  is uBlock's own `#panes { flex-direction: row-reverse }` two-pane layout — the
  collapsed firewall pane reserves the left side, shown when the Safari popover is
  wider than `#main`. Fixing risks breaking the "More" firewall expansion; left as-is.
- `assets/.../pgl.yoyo.org/.../serverlist.txt invalid path` — a filter-list asset not
  present in the bundle; cosmetic fetch warning, does not block core function.
