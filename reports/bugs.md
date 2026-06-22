## ROOT CAUSE of the ~40% conversion-failure rate (Jun 22)

**Blocking webRequest was classified as a FATAL error that aborted conversion.**
`src/analyze.ts` flagged any JS using `chrome.webRequest.on*` + the `"blocking"`
extraInfoSpec as `severity:"error"`, which halts conversion unless `--force`.

This single check killed the entire ad-blocker / password-manager / VPN / privacy
category — Bitwarden, LastPass, Honey, Urban VPN, uBlock, etc. — because nearly all
of them register a blocking webRequest listener somewhere. That's the dominant slice
of the failures.

It's the wrong call: Safari (and the compat shim's `chrome.webRequest` backfill)
accept the listener registration fine, the *blocking return value* is simply ignored,
and every other feature of the extension still works. So the correct behavior is
degrade-not-abort.

**Fix:** downgraded to `severity:"warning"` + `shimmed:true`. The network-blocking
feature degrades (DNR migration is the real remedy) but the extension installs and
runs. Verified: 4 hard-failing zips (Bitwarden/Honey/LastPass/Urban VPN) now stage
cleanly; full local corpus of real extensions stages with 0 failures. Guard test
added in test/analyze.test.js. (The remaining staging "failures" are multi-variant
Chrome *sample-repo* packages with several manifest-bearing subdirs — a test-data
artifact, not a conversion bug; they convert when pointed at a specific variant.)

## Analysis: src/util.ts (Iteration 1)

- **Bug/Portability**: `commandExists` hardcodes `/usr/bin/which`. This is brittle. If `which` is located elsewhere (e.g. `/bin/which` or if the system path is non-standard), it will fail.
- **Bug/Portability**: `moveBundle` hardcodes `/usr/bin/ditto`. While this project seems MacOS-focused (converting extensions for Safari), hardcoding absolute paths to system binaries instead of relying on `PATH` makes the code less resilient to system updates or environment changes.
- **Dumb Logic**: `color` checks `process.stdout.isTTY` only once upon module initialization. If output is later redirected, it might still output ANSI escape codes incorrectly.

## Analysis: src/dnr.ts (Iteration 2)

- **Dumb Logic / False Positive Risk**: `needsAnthropicCorsBypass` stringifies the entire manifest and runs a regex `/api\.anthropic\.com/i` against it. This is a hacky way to check for host permissions and could lead to false positives if the string appears in a `description` or other non-functional field.
- **Dumb Logic / Formatting Loss**: When DNR rules containing `modifyHeaders` are found, the script strips them and rewrites the file using `JSON.stringify(safe, null, 2)`. This destroys any custom formatting the original file had.
- **Potential Bug / Security**: The path joining `join(stageDir, res.path)` does not check for path traversal vulnerabilities (e.g., `res.path` being `"../../../etc/passwd"`). While this may just be a local conversion tool, it's generally unsafe to blindly join manifest-provided paths.

## Analysis: src/installer.ts (Iteration 4)

- **Bug/Portability**: `run("/usr/bin/pgrep", ["-x", "Safari"])` hardcodes `/usr/bin/pgrep`. Will fail on systems without `pgrep` installed at this exact location.
- **Bug/Portability**: `run("/usr/bin/osascript", ...)` hardcodes `/usr/bin/osascript`.
- **Bug/Portability**: `run("/usr/bin/defaults", ...)` hardcodes `/usr/bin/defaults`.
- **Bug/Portability**: `run("/usr/bin/open", ...)` hardcodes `/usr/bin/open`.
- **Dumb Logic / Usability**: The `safariRunning()` check uses `pgrep -x Safari`. However, the osascript later does `tell application "Safari" to quit`. If the user is running Safari Technology Preview, the check might fail, or it might close the wrong browser instance.

## Analysis: src/cli.ts (Iteration 5)

- **Dumb Logic**: `pkgVersion()` uses `fs.readFileSync` on `package.json` relative to `import.meta.url`. In compiled/packaged environments (like `dist/`), this path might not point to `package.json` anymore depending on the output structure.
- **Dumb Logic / Cleanup Bug**: `analyzeOnly` creates a temporary directory using `mkdtempSync` and tries to remove it in a `finally` block. However, if the Node process receives a signal or `process.exit()` is called forcefully, the `finally` block may not run and the directory leaks. The download logic correctly uses `process.on("exit", ...)`, but `analyzeOnly` does not.

## Analysis: src/report.ts (Iteration 6)

- **Dumb Logic / Missing Escape**: In `buildReportMarkdown()`, variables like `meta.version`, `i.message`, and `i.fix` are directly interpolated into Markdown without escaping Markdown syntax characters (like `<`, `>`, `*`, `_`, or `|`). If an extension author uses these characters in their manifest or code, it could break the Markdown formatting or inject unintended structures.
- **Dumb Logic**: `hasSafariSettings` checks for `bss?.safari`. If `bss` is an array or string (due to an invalid manifest), this check will still just return `false` without warning the user about an invalid structure. While TypeScript catches static issues, dynamically loaded JSON might bypass this.
