# chrome2safari

A command-line tool that converts a Google Chrome extension into a Safari Web
Extension ready for local development, ad-hoc testing, or an Xcode/TestFlight
build. It extracts the extension, analyzes and rewrites the manifest for Safari,
injects a runtime compatibility shim for unsupported `chrome.*` APIs, and drives
Apple's `safari-web-extension-packager` and `xcodebuild` to produce a signed app.

## What it does

- Accepts a `.zip`, `.crx`, or an unpacked extension directory.
- Detects MV2 vs MV3 and reports incompatibilities before converting.
- Rewrites the manifest for Safari:
  - Removes Chrome-only keys (`update_url`, `key`, `minimum_chrome_version`).
  - Strips permissions Safari does not implement (for example `tabGroups`,
    `offscreen`, `sidePanel`, `debugger`).
  - Forces `persistent: false` on MV2 backgrounds; strips
    `background.type: "module"` (a known cause of silent popup failures).
  - Injects `browser_specific_settings.safari` with a minimum version and no
    maximum cap (an `18.*` cap hides the extension on Safari 18+ and Safari 26).
  - Auto-wires a `default_popup` when the action has none.
- Generates and injects a compatibility shim into content scripts and every
  extension HTML page (popup, options, side panel). The shim:
  - Routes `storage.sync` to `storage.local` (Safari has no iCloud sync).
  - Stubs `sidePanel`, `identity`, `notifications`, `tabGroups`, `debugger`,
    and `offscreen` so module evaluation does not throw and blank the page.
- Auto-sizes side-panel pages wired as the action popup so the popup is not a
  collapsed, tiny window.
- Packages the extension into an Xcode project, patches bundle identifiers, and
  optionally builds an ad-hoc or team-signed app.
- Verifies the bundle identifier of the COMPILED `.appex`, not just the project
  files, so the wrong extension is never registered with Safari.
- Optionally installs the built host app into `~/Applications` and registers it
  with Safari (`--install`), so the extension persists across Safari restarts
  when team-signed.

## Requirements

- macOS with a full Xcode install (not just the Command Line Tools) for the
  packaging and build steps. `xcrun safari-web-extension-packager` and
  `xcodebuild` ship with Xcode.
- Node.js 18 or newer.
- No runtime dependencies; TypeScript is the only dev dependency.

Run the built-in toolchain check at any time:

```
chrome2safari --doctor
```

## Install and build

```
npm install
npm run build
```

This compiles `src/` to `dist/`. The CLI entry point is `dist/cli.js`.

Run it directly with Node:

```
node dist/cli.js <input> [options]
```

Or link it as a global command:

```
npm link
chrome2safari <input> [options]
```

## Usage

Analyze an extension and report issues without converting:

```
chrome2safari ./my-extension.zip --analyze
```

Stage for Safari 18+ "Add Temporary Extension" (no Xcode, fastest iteration):

```
chrome2safari ./my-extension.zip --temp-load
```

Then in Safari: Settings, Advanced, enable "Show features for web developers";
Settings, Developer, enable "Allow Unsigned Extensions"; Develop menu, "Add
Temporary Extension", and select the staged folder. Temporary extensions must be
re-added after each Safari restart.

Generate an Xcode project without building:

```
chrome2safari ./my-extension.zip --no-build
```

Full conversion and ad-hoc build (CI/TestFlight-safe clean copy):

```
chrome2safari ./my-extension.zip --ci
```

The default (without `--ci`) symlinks resources for live development edits; use
`--ci` to clean-copy resources into the project.

## Options

```
-o, --output <dir>      Output directory (default: ./<AppName>_Safari)
    --bundle-id <id>    Reverse-DNS bundle id (default: com.chrome2safari.<app>)
    --app-name <name>   Host app name (default: extension name)
    --platforms <p>     all | macos | ios            (default: macos)
    --ci                Clean-copy resources (CI/TestFlight-safe)
    --temp-load         Stage only, for Safari 18 "Add Temporary Extension"
    --no-build          Generate the Xcode project but do not run xcodebuild
    --install           Install the built app to ~/Applications + register w/ Safari
    --install-dir <dir> Install target directory (default: ~/Applications)
    --no-safari-restart With --install, don't quit/relaunch Safari or set the toggle
    --team [<id>]       Sign with an Apple Team ID; --team auto (or plain --install)
                        auto-detects it from Xcode. Omit for ad-hoc signing.
    --no-shim           Do not generate/inject the compatibility shim
    --keep-module       Keep background.type:"module" (default strips it)
    --force             Convert despite blocking errors
    --analyze           Analyze and report only
    --doctor            Verify xcrun/packager/xcodebuild availability
-v, --verbose           Verbose output
-h, --help              Show this help
```

## Installing a built app

Let the tool install for you. It copies the built app into `~/Applications`,
registers it with LaunchServices, and launches it once so Safari registers the
extension:

```
chrome2safari ./my-extension.zip --install
```

Then enable the extension in Safari, Settings, Extensions.

### Persisting across Safari restarts (team signing)

How the extension persists depends on how it was signed:

- **Ad-hoc (no `--team`)**: Safari only loads it while "Allow Unsigned
  Extensions" (Develop menu) is on, and that setting resets every time Safari
  restarts. With `--install` the tool sets the toggle and bounces Safari for
  you; pass `--no-safari-restart` to skip that.
- **Team-signed (`--team`)**: signed with a real Apple Developer certificate, so
  Safari loads it without the unsigned toggle and it survives quitting Safari.

`--team auto` (or plain `--install`) auto-detects your Team ID from Xcode, so you
do not need to know or type it:

```
chrome2safari ./my-extension.zip --install            # auto-detects the team
chrome2safari ./my-extension.zip --install --team auto # same, explicit
chrome2safari ./my-extension.zip --install --team V8K8L3ZSD5  # exact id
```

Auto-detection reads the team cached by Xcode (`IDEProvisioningTeamByIdentifier`
in `com.apple.dt.Xcode`); it requires an Apple account signed into Xcode. If no
team is found, the build falls back to ad-hoc signing.

A free personal Apple team works, but its provisioning profile expires about
every 7 days — re-run the command to re-sign. A paid Developer Program account
lasts about a year.

If you prefer to install manually, copy the printed app path yourself:

```
cp -R "<AppName>_Safari/<AppName>.app" ~/Applications/
open "~/Applications/<AppName>.app"
```

## Limitations

- APIs with no Safari equivalent are stubbed so the extension loads, but the
  underlying feature does not work. The analyzer reports each one with a
  suggested remediation.
- Extensions that authenticate with `chrome.identity` or a hardcoded
  `chrome-extension://` OAuth redirect cannot complete login. The OAuth client
  is registered on the provider's server against the original Chrome extension
  identity and scheme, which Safari cannot reproduce. This requires the
  provider to register a Safari redirect or a hosted HTTPS callback flow; it
  cannot be fixed by conversion alone.
- `storage.sync` is mapped to `storage.local`; data persists but does not sync
  across devices.
- `declarativeNetRequest` rules with a `modifyHeaders` action crash Safari's
  WebKit rule loader, so the tool strips them (both static rulesets and dynamic
  `updateSessionRules`/`updateDynamicRules` calls). Header-rewriting use cases —
  for example a CORS bypass — are not converted; use a native-messaging proxy
  instead.
