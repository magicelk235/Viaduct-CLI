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
  optionally builds an ad-hoc signed app.
- Verifies the bundle identifier of the COMPILED `.appex`, not just the project
  files, so the wrong extension is never registered with Safari.

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
    --no-shim           Do not generate/inject the compatibility shim
    --keep-module       Keep background.type:"module" (default strips it)
    --force             Convert despite blocking errors
    --analyze           Analyze and report only
    --doctor            Verify xcrun/packager/xcodebuild availability
-v, --verbose           Verbose output
-h, --help              Show this help
```

## Installing a built app

After a full build the tool prints the app path. Copy it into Applications and
launch it once so the system registers the extension:

```
cp -R "<AppName>_Safari/.../Release/<AppName>.app" /Applications/
open "/Applications/<AppName>.app"
```

Then enable the extension in Safari, Settings, Extensions. For ad-hoc (unsigned)
builds, "Allow Unsigned Extensions" must be enabled in Safari's Develop menu;
this setting resets every time Safari restarts.

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
