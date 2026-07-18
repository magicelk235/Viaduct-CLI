# Privacy Policy

Last updated: July 18, 2026

Viaduct is a command-line tool that converts Google Chrome extensions into
Safari Web Extensions. This policy covers what it does, and does not do, with
your data.

## The short version

Viaduct collects no personal data. Every conversion runs locally on your Mac.
Nothing about the extensions you convert, and nothing about you, is sent to us.
There is nowhere to send it: the tool has no servers and no accounts.

## What runs on your Mac

When you convert an extension, Viaduct reads the files you point it at, rewrites
the manifest and code for Safari, and drives Apple's own developer tools
(`safari-web-extension-packager` and `xcodebuild`) together with a Node.js
runtime to build and, if you ask, sign the result. The extension source, the
converted output, and your signing identity stay on your machine.

## Data we collect

None. Viaduct has no analytics and no telemetry.

## Network access

Viaduct works offline when you give it a local file or folder. It reaches the
network only when you ask it to, in two cases:

- You pass a URL instead of a local path. Viaduct downloads the extension from
  that address, such as a Chrome Web Store link or a direct `.crx` or `.zip`
  link.
- Your own toolchain fetches something it needs, for example npm installing the
  package or Xcode downloading a component.

Those requests go to the address you named, or to npm and Apple. They carry no
personal information about you.

## Third parties

Viaduct shares no data with third parties, because it collects none to share.

## Changes

If this policy changes, the updated version will be posted here with a new date
above.

## Contact

Questions? Email support@magicelklabs.com, or open an issue at
<https://github.com/magicelk235/Viaduct-CLI/issues>.
