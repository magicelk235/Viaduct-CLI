# Loom – Screen Recorder & Screen Capture — Safari conversion test report

**Status: ⚠️ Loads, popup blank in logged-out state.** Shim loads cleanly (no
abort, `chrome.scripting` and friends present in the popup), the bundle runs, and
clicking the toolbar icon triggers Loom's logged-out path — it opens the
Atlassian/Loom web signup flow in a new tab. The popover itself renders nothing
because (a) we have no Loom account so there's no session to render, and (b) Safari's
per-site permission gate denies the tab probe Loom does on open. Neither is a
converter bug.

Source: `test extensions/Loom.zip` (MV3, rated 9/10). Bundle id:
`com.viaduct.LoomScreenRecorderScreenCapture`.

## What the extension does
Screen + cam recorder. MV3 service worker, a React popup (`html/popup.html` →
`/js/popup.js`, a 4.6 MB bundle that renders into an empty `<body>`), many content
scripts (bubble/companion UI, gmail/linkExpand integrations), and an OAuth login via
Atlassian. Recording uses `tabCapture` / `desktopCapture`.

## Test scope
Smoke test only — no Loom account. Goal: confirm load + that the shim doesn't abort.

## What was observed (live)
- Popup `<body>` is empty: `document.body.childElementCount === 0`.
- `typeof chrome.scripting === 'object'` in the popup → **shim loaded, no
  missing-API throw**. The popup HTML has the polyfill + shim injected before
  `popup.js` (verified in the installed appex).
- No red error from `/js/popup.js`. popup.js ran and chose not to render (logged-out).
- Clicking the icon opened `id.atlassian.com/signup?application=loom…` → Loom's
  logged-out branch executed correctly.
- One rejection surfaced via the identity-polyfill's global handler:
  ```
  [idpoly] UNHANDLED REJECTION: (identity-polyfill.js:34:20)
  Error: Invalid call to scripting.executeScript(). This extension does not have
  access to this tab.
  ```
  `identity-polyfill.js:34` is the **`unhandledrejection` reporter**, not the
  source. The real call is Loom's own `scripting.executeScript` against the active
  tab, which Safari denies because `<all_urls>` defaults to **"Ask"** per-site (the
  user hadn't granted the current tab). The shim's own `executeScript` wrapper
  (`inject`, shim line 1119) already swallows its rejection; this unhandled one is a
  Loom call with no `.catch`.

## Diagnosis
Two non-bug factors, both expected:
1. **Logged-out = blank popover by design.** popup.js detects no session and opens
   the web signup flow instead of rendering UI. With no account this is as far as the
   smoke test can go.
2. **Safari per-site permission gate.** Safari defaults broad host access to "Ask",
   so Loom's open-time `scripting.executeScript` on the current tab is denied →
   unhandled rejection (noisy, harmless). Chrome auto-grants `<all_urls>`, so the
   call wouldn't reject there. Granting "Allow on Every Website" should clear it.

Not shim-fixable, not chased: we can't add a `.catch` to Loom's minified call, and
making our `scripting.executeScript` swallow permission errors would hide a real
Safari permission state. The rejection is cosmetic.

## What's left / platform limits
- **Recording untested and likely unsupported.** `tabCapture` and `desktopCapture`
  are dropped at conversion (no Safari equivalent — Safari wants
  `navigator.mediaDevices.getDisplayMedia()` or a native bridge). The core record
  feature is a platform limit, like Bitwarden's WASM SDK.
- **Logged-in flow unverified** — needs a Loom account. The blank popover can't be
  distinguished from a real render bug without logging in; the smoke evidence (shim
  intact, logged-out redirect fires) points to normal behavior.
- `CSP 'unsafe-eval'` present — Safari rejects eval in extension contexts regardless;
  watch for it if logged-in rendering ever fails.
