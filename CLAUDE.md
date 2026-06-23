# Viaduct — Chrome → Safari Web Extension converter

CLI that takes a Chrome extension (`.zip`/`.crx`/`.xpi`/unpacked dir/Web-Store URL) and
emits a Safari Web Extension: rewrites the manifest, injects a runtime compatibility
shim for unsupported Chrome APIs, wraps it in an Xcode project, and optionally builds +
installs it into Safari. macOS-only (uses `xcrun`, `xcodebuild`, `ditto`, `pluginkit`).

## Commands

```bash
npm run build      # rm dist/ → tsc → copy templates/ + runtime/ into dist/ → chmod cli
npm test           # build, then node --test test/*.test.js  (191 tests)
npm run typecheck  # tsc --noEmit
npm run corpus     # stress-test conversion logic against a large local manifest corpus
node dist/cli.js <input> [opts]          # run the CLI
node dist/cli.js <input> --analyze       # report only, no conversion
node dist/cli.js <input> --temp-load     # stage only (no Xcode); fast for iterating
```

Always `npm run build` before running `dist/cli.js` or the tests — both run against `dist/`.

## Architecture

ESM TypeScript, near-zero runtime deps. Source grouped by pipeline stage; `cli.ts`,
`convert.ts`, and the shared leaves (`types.ts`, `util.ts`, `paths.ts`) live at `src/` root.

```
src/
  cli.ts          arg parsing, --analyze/--doctor/--list/--uninstall, calls convert()
  convert.ts      the orchestrator — runs the whole pipeline (see order below)
  types.ts        Manifest, Issue, Platforms — shared types
  util.ts         run() (child_process), logging (info/ok/warn/fail), commandExists
  paths.ts        single source of truth for bundled-asset dirs (templates/, runtime/)
  input/          download  extract  stage  icons     ← get files onto disk
  manifest/       manifest  compat-data  dnr          ← parse + analyze + rewrite manifest
  analyze/        analyze  report                      ← scan JS for unsupported APIs, format report
  runtime/        shim  oauth-bridge  + safari-compat-shim.js   ← runtime compat layer
  build/          packager  installer  tempload        ← Xcode project, build, install to Safari
  templates/      OAuth-bridge scripts + browser-polyfill (copied verbatim into output)
```

### Conversion pipeline (`convert.ts`, in order)

1. `loadManifest` + `analyzeManifest` (manifest/) + `scanExtension` (analyze/) → collect issues
2. blocking errors abort unless `--force`
3. `stageExtension` (input/) copies referenced files into `<output>/staged_extension/`
4. `writePolyfill` + `writeShim` + `injectShimIntoHtmlPages` (runtime/) — drop in the compat layer
5. `transformManifest` (manifest/) — strip unsupported permissions, rewrite keys, prepend shim to content scripts
6. `applyDnr` (manifest/) — neutralize unsupported declarativeNetRequest header rules
7. `applyOAuthBridge` (runtime/) — wire the Chrome↔Safari OAuth handshake (uses the real Chrome id, derived *before* `key` is stripped)
8. `convertServiceWorkerToBackgroundPage` (runtime/) — SW → non-persistent background page, hoist `importScripts` targets as classic `<script>`s
9. `synthesizePlaceholderIcons`, `stripDanglingSourcemaps`, `writeManifest`, `injectPopupSizing`
10. with `--temp-load`: stop here. Else `runPackager` (build/) → Xcode project → `xcodebuild` → optional `installToSafari`

## The runtime shim — most important file

`src/runtime/safari-compat-shim.js` is a **real `.js` file** (~2200 lines), NOT TypeScript.
`shim.ts`'s `shimSource()` reads it and substitutes one placeholder (`__C2S_PROXY_CONFIG_JSON__`).
Edit the `.js` directly; it's plain JS so backslashes/regex are literal (no template escaping).

It's prepended to **every content script and every extension HTML page**, and runs in the
converted background page. Core rule: **it must never throw at top level** — a throw aborts
the whole script chain it's prepended to (→ "content script not executing"). Every patch is
wrapped in try/catch and feature-detects before touching `chrome.*`. It backfills missing
Chrome APIs/events/enums as inert stubs so a bundle reading `chrome.X.onY.addListener` at
module-eval doesn't crash on Safari, and emulates several APIs in memory (tabGroups, bookmarks,
userScripts registry, etc.). Sections are commented `// chrome.<api> — …`.

## Key behaviors / gotchas

- **Severity matters.** `analyze.ts` issues are `error` (blocks conversion) / `warning` / `info`.
  An "error" aborts unless `--force`. Don't flag a degrade-but-still-works case as `error` —
  blocking webRequest is a `warning` precisely because the extension still loads (Safari just
  ignores the blocking return). Mis-flagging fatal kills whole extension categories.
- **Compat data** (which permissions/APIs Safari lacks, remediation notes) lives in
  `manifest/compat-data.ts`, re-exported from `manifest.ts`. Add new unsupported APIs there.
- **Asset paths** resolve via `paths.ts` (relative to dist root), so files at any folder depth
  find `templates/`/`runtime/`. Don't re-derive dirs from `import.meta.url` in moved files.
- **Tests import from `dist/`** (e.g. `../dist/analyze/analyze.js`), so build first. Add a
  test for any non-trivial logic change; the suite is the regression net for the 50+ real
  extensions in `test extensions/`.
- **Multi-variant sample packages** (Chrome API-sample repos with several manifest-bearing
  subdirs) aren't single extensions — point the CLI at a specific variant subdir.

## Conventions

- ESM imports use the `.js` extension (`from "./util.js"`), even from `.ts` sources.
- macOS-only; system binaries invoked by name via `util.run()`, found on `PATH`.
- Comments explain *why* (the Safari quirk being worked around), not *what*. Match that density.

## Live-testing a converted extension (debug protocol)

When a converted extension misbehaves in Safari, **do NOT guess from pasted console
errors** — they're often stale or symptoms, not causes. Diagnose with live evidence:

- **The background-page console is reliable; the popover/popup console relay is flaky.**
  Drive diagnostics from the bg console (Safari → Develop → Web Extension Background Pages).
- **Write structured state to `chrome.storage.local` from the shim, read it from the bg
  console.** The shim has a `__C2S_DEBUG__` flag (top of `safari-compat-shim.js`); gate
  temporary `chrome.storage.local.set({...})` traces behind it. Flip on for a diagnostic
  build, **flip OFF and strip the temporary traces before committing.**
- **Trace the failing flow link by link**, not the end symptom: connect outcome → did the
  request reach the bg port → did the bg post a reply → privileged flag → the exact string
  values being compared. Each link narrows the cause to one fact.
- **Reproduce the suspected Safari behavior in a Node `vm` context** (frozen objects, exotic
  getters, case-mismatched origins) and prove the fix locally before reinstalling. Safari's
  native namespaces are frozen/immutable/exotic in ways a plain object mock won't show — use
  `vm` with `Object.freeze`, accessor descriptors, and live globals to match reality.
- **Reinstall cycle:** `--uninstall <App>`, `rm -rf <App>_Safari` (stale output dir →
  ENOTEMPTY), reinstall with `--install --force --clean`, then **quit and reopen Safari**
  before retesting. Verify the new shim actually reached the installed `.appex`
  (`grep` a marker in `…/Contents/Resources/safari-compat-shim.js`) — a stale install is a
  common false "fix didn't work".
- **Distinguish shim-fixable from platform limits.** WebAuthn/passkey RPID, WASM-SDK chunk
  loaders, and webfont CSP refusals are platform/extension-internal, not converter bugs —
  document them, don't chase them.
- **After a test session, write/update a per-extension report** in
  `reports/extension-tests/` (problem → process → solution → what's left), and keep the
  `README.md` status table current.

Known Safari namespace quirks already handled (see `safari-compat-shim.js` comments):
frozen `browser`/`chrome` roots (shim must not throw at top level), exotic-immutable
`chrome.scripting` (enums inlined at conversion in `stage.ts`), extension-UUID case
mismatch between `getURL()` (UPPER) and `sender.origin` (lower) — getURL lowercases the
host so origin-privilege checks pass.
