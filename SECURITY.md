# Security Policy

## Supported versions

Viaduct is published to npm as a rolling release. Only the latest version on the
`main` branch and the most recent release on npm receive security fixes. If you
are on an older version, update before reporting an issue.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older versions | :x:                |

## Reporting a vulnerability

Please do not open a public GitHub issue for security vulnerabilities.

Report privately through one of:

- GitHub Security Advisories: open a draft advisory at
  <https://github.com/magicelk235/Viaduct-CLI/security/advisories/new>
  (preferred).
- Email: yehonatan.2350@gmail.com with the subject line `SECURITY: viaduct-cli`.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, with a proof-of-concept if you have one.
- The affected version, your macOS and Node.js versions, and any relevant
  configuration.

## What to expect

- Acknowledgement within 5 business days.
- An assessment and, where the issue is confirmed, a fix timeline. Most issues
  are patched in the next release.
- Credit in the release notes once a fix ships, unless you ask to stay
  anonymous.

Please give a reasonable window to release a fix before any public disclosure.

## Scope notes

Viaduct is a command-line tool that converts Chrome extensions into Safari Web
Extensions. It can download an extension from a URL (a Chrome Web Store link or
a direct `.crx`/`.zip` link), rewrite the extension's manifest and code, inject a
runtime compatibility shim, and drive Apple's `safari-web-extension-packager`
and `xcodebuild` to build and sign the result.

Reports touching any of these paths are in scope: the URL fetch and archive
handling, the manifest and code rewriting, the injected shim, and the
invocation of the packager, `xcodebuild`, and code signing. Vulnerabilities in
those upstream tools themselves should be reported to their respective projects
(Apple, Node.js, npm).
