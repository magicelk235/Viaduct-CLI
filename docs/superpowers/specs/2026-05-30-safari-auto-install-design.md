# Safari auto-install (`--install`)

Date: 2026-05-30
Status: approved

## Problem

`chrome2safari` already converts a Chrome extension and (by default) builds an
ad-hoc-signed Safari host `.app` via `xcodebuild`. It then **stops** and prints a
manual `cp -R "<app>" /Applications/` hint. The user must hand-copy the app,
launch it, and flip Safari settings before the extension appears.

Goal: an opt-in step that copies the built app to a stable location, registers
it with macOS, enables Safari's unsigned-extension setting, bounces Safari, and
launches the host app — so the extension is installed and survives Safari
restarts.

## Decisions (from brainstorming)

- **Trigger:** opt-in `--install` flag. Normal convert is unchanged.
- **Location:** `~/Applications` by default (no sudo). Overridable via `--install-dir`.
- **Safari automation:** full — write the unsigned toggle, graceful-quit Safari,
  relaunch. Escape hatch `--no-safari-restart` falls back to copy + register +
  launch-host-app + printed instructions only.

## CLI surface

| Flag | Meaning |
|------|---------|
| `--install` | Run the install pipeline after a successful build. |
| `--install-dir <path>` | Target dir (default `~/Applications`). |
| `--no-safari-restart` | Skip the Safari quit/toggle/relaunch; copy + register + launch host app + instruct only. |

`--install` requires a build: error if combined with `--no-build` or `--temp-load`.

## Module: `src/installer.ts`

Keeps install side-effects out of `convert.ts`/`packager.ts`. Reuses `run`,
`info`/`ok`/`warn`, `commandExists` (util) and `pluginkitStatus` (packager).

Exports:
- `LSREGISTER` — full path to LaunchServices `lsregister`.
- `expandHome(p)` — leading `~` expansion (pure, testable).
- `bundleRegistered(pluginkitOutput, bundleId)` — substring check (pure, testable).
- `InstallOptions`, `InstallResult`.
- `installToSafari(opts): InstallResult`.

### Pipeline (`installToSafari`)

1. Resolve target dir (`expandHome`, default `~/Applications`), `mkdirSync` recursive.
2. `ditto <builtApp> <target>/<AppName>.app`, removing any stale copy first.
   Copy failure ⇒ return with `installedAppPath: null` (caller warns; conversion
   still counts as success because the build succeeded).
3. `lsregister -f <installedApp>` — register the appex with LaunchServices.
4. If restart enabled and Safari running: graceful quit via
   `osascript -e 'tell application "Safari" to quit'` (not `killall`).
5. If restart enabled: `defaults write com.apple.Safari AllowUnsignedAppExtensions -bool true`.
6. `open <installedApp>` — launch host app once so Safari registers the appex.
7. If restart enabled: `open -a Safari`.
8. `pluginkitStatus()` → `bundleRegistered(...)`; report registered state.

## Wiring

- `types.ts`: `ConvertOptions` += `install: boolean`, `installDir?: string`,
  `safariRestart: boolean`. `ConvertResult` += `installedAppPath?: string`.
- `convert.ts`: after `verifyBuiltBundleId` OK + the pluginkit/unsigned info block,
  `if (opts.install) result.installedAppPath = installToSafari({...}).installedAppPath`.
  Runs before `result.success = true` but does not gate success.
- `cli.ts`: parse the three flags; validate `--install` vs `--no-build`/`--temp-load`;
  pass `safariRestart: !values["no-safari-restart"]`; add `ditto`/`osascript`/`lsregister`
  to `--doctor`; print an install summary (replacing the `cp -R` hint) when
  `installedAppPath` is set.

## Error handling

Build already succeeded, so install failures degrade to **warnings** — except a
copy failure, which aborts the install cleanly (`installedAppPath: null`). Safari
not installed/running ⇒ skip gracefully. All external calls go through `run`,
which never throws.

## Testing

No test runner is configured in the project. Pure helpers (`expandHome`,
`bundleRegistered`, command-arg construction) are factored to be unit-testable if
one is added later. macOS side effects (ditto/lsregister/Safari) require manual
verification on the machine. Verification for this change = `npm run build`
(zero type errors) + a manual `--install` run.

## Honest limitation

Ad-hoc/unsigned extension **enablement** is gated by `AllowUnsignedAppExtensions`,
which Safari treats as session-scoped and tends to reset on quit. The
install/listing **persists** across restarts (host app lives in `~/Applications`);
staying *enabled* may need re-running `--install` or re-ticking the Develop-menu
toggle. Full persistence requires a real signing identity (out of scope).

## Alternatives rejected

- `xcodebuild install` (DSTROOT) — does not register with Safari.
- Leave app in `DerivedData` + register only — build dir is ephemeral ⇒ not persistent.
- `killall Safari` — graceful `osascript` quit chosen instead.
