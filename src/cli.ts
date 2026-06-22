#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { convert } from "./convert.js";
import { extractExtension } from "./input/extract.js";
import { loadManifest, analyzeManifest, resolveI18nString, transformManifest } from "./manifest/manifest.js";
import { scanExtension } from "./analyze/analyze.js";
import { printIssues, countBlocking, summarizeManifestChanges, buildReportMarkdown } from "./analyze/report.js";
import { run, info, ok, warn, fail, color, commandExists, setVerbose, setQuiet } from "./util.js";
import { LSREGISTER, uninstallFromSafari, listSafariExtensions } from "./build/installer.js";
import { detectXcodeTeam, defaultBundleId } from "./build/packager.js";
import { isUrl, downloadExtension } from "./input/download.js";
import type { Platforms } from "./types.js";

function pkgVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Apple bundle ids are reverse-DNS: dot-separated segments of letters, digits and
// hyphens. No spaces, underscores, leading/trailing/empty dots. Xcode silently
// fails the build on an invalid id, so reject it up front with a clear message.
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// Apple version strings are 1–3 dot-separated non-negative integers.
const SAFARI_VERSION_RE = /^\d+(\.\d+){0,2}$/;

// Apple Developer Team IDs are exactly 10 uppercase alphanumeric characters.
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

const HELP = `viaduct — convert a Chrome extension to a Safari Web Extension

USAGE
  viaduct <input> [options]
  viaduct <input> --analyze         # report only, no conversion
  viaduct --doctor                  # check local toolchain
  viaduct --list                    # list registered Safari Web Extensions
  viaduct --uninstall <AppName>     # remove a previously installed app

INPUT
  A .zip, .crx, .xpi, an unpacked extension directory, or a URL (type detected by magic bytes).
  URLs may be a Chrome Web Store link (https://chromewebstore.google.com/detail/<name>/<id>)
  or a direct .crx / .zip download link; the source is fetched automatically.

OPTIONS
  -o, --output <dir>        Output directory (default: ./<AppName>_Safari)
      --bundle-id <id>      Reverse-DNS bundle id (default: com.viaduct.<app>)
      --app-name <name>     Host app name (default: extension name)
      --min-safari <ver>    Safari strict_min_version (default: 15.4; use 18.4 for world:MAIN)
      --platforms <p>       all | macos | ios            (default: macos)
      --ci                  Clean-copy resources into the project (CI/TestFlight-safe).
                            Default symlinks resources instead, for live dev edits.
      --temp-load           Stage only, for Safari 18 "Add Temporary Extension…" (no Xcode)
      --zip                 Also emit a distributable .zip of the staged extension
      --clean               Wipe the output directory before staging (drop stale leftovers)
      --no-build            Generate the Xcode project but do not run xcodebuild
      --open-xcode          Open the generated .xcodeproj in Xcode when done
      --install             Install the built app to ~/Applications + register it with Safari
      --install-dir <dir>   Install target directory (default: ~/Applications)
      --no-safari-restart   With --install, don't quit/relaunch Safari or set the unsigned toggle
      --team <id>           Sign with an Apple Developer Team ID (real signing → the
                            extension persists across Safari quits; no unsigned toggle).
                            Use --team auto (or plain --install) to auto-detect the team
                            from Xcode. Omit for ad-hoc signing. Free personal teams expire ~7 days.
      --no-shim             Do not generate/inject the compatibility shim
      --no-oauth-bridge     Do not wire the Safari OAuth/externally_connectable bridge
      --keep-module         Keep background.type:"module" (default strips it)
      --force               Convert despite blocking errors
      --strict              Treat warnings as blocking too (CI gate). With --analyze,
                            exit 1 if any warning/error is present.
      --analyze             Analyze and report only (also previews the manifest rewrites)
      --json                With --analyze, print a machine-readable JSON report
      --report <file>       With --analyze, also write the report to <file> (.json if --json, else Markdown)
      --doctor              Verify xcrun/packager/xcodebuild availability
      --list                List Safari Web Extensions registered with pluginkit
      --uninstall <name>    Remove the installed <name>.app + unregister it (use with --install-dir)
  -q, --quiet               Suppress progress messages (warnings/errors still print)
  -v, --verbose             Verbose output
  -h, --help                Show this help
      --version             Print the viaduct version and exit
`;

function doctor(): number {
  const checks: Array<[string, () => boolean, string]> = [
    ["xcrun", () => run("xcrun", ["--version"]).code === 0, "Install Xcode command line tools."],
    [
      "safari-web-extension-packager",
      () => run("xcrun", ["--find", "safari-web-extension-packager"]).code === 0,
      "Requires a full Xcode install (not just CLT).",
    ],
    ["xcodebuild", () => run("xcodebuild", ["-version"]).code === 0, "Requires full Xcode."],
    ["plutil", () => commandExists("plutil"), "Part of macOS."],
    ["pluginkit", () => run("/usr/bin/which", ["pluginkit"]).code === 0, ""],
    ["ditto", () => commandExists("ditto"), "Part of macOS."],
    ["osascript", () => commandExists("osascript"), "Part of macOS."],
    ["lsregister", () => existsSync(LSREGISTER), "Part of macOS LaunchServices."],
  ];
  let allOk = true;
  for (const [name, fn, hint] of checks) {
    if (fn()) ok(name);
    else {
      fail(`${name} — ${hint}`);
      allOk = false;
    }
  }
  return allOk ? 0 : 1;
}

function analyzeOnly(
  input: string,
  platforms: Platforms,
  json: boolean,
  strict: boolean,
  reportPath?: string
): number {
  const scratch = mkdtempSync(join(tmpdir(), "viaduct-"));
  try {
    let extPath: string;
    let manifest;
    try {
      extPath = extractExtension(resolve(input), scratch);
      manifest = loadManifest(extPath);
    } catch (e) {
      const msg = (e as Error).message;
      // In JSON mode always emit parseable output so a CI consumer never gets a
      // bare stack trace on a corrupt archive / missing manifest.
      if (json) console.log(JSON.stringify({ error: msg, convertible: false }, null, 2));
      else fail(msg);
      return 1;
    }
    const name = resolveI18nString(manifest.name, extPath, manifest.default_locale) ?? manifest.name ?? "Unknown";
    if (!json) info(`${name} (MV${manifest.manifest_version ?? 3})`);
    const { issues: mIssues, permissionsToRemove } = analyzeManifest(manifest);
    const issues = [...mIssues, ...scanExtension(extPath, manifest, platforms)];

    // Preview the real manifest rewrites the converter would apply. transformManifest
    // deep-clones its input and only reads from extPath, so this is side-effect-free.
    const transformed = transformManifest(manifest, permissionsToRemove, extPath, {
      keepModuleBackground: false,
    });
    const changes = summarizeManifestChanges(manifest, transformed);

    // Mirror the real conversion gate: an auto-fixed issue (e.g. the MV2 persistent
    // background that transformManifest rewrites) is NOT blocking, so --analyze and
    // an actual convert agree on the exit code.
    const blockingCount = countBlocking(issues, strict);
    if (json) {
      const counts = { error: 0, warning: 0, info: 0 };
      let autoFixed = 0;
      let shimmed = 0;
      for (const i of issues) {
        counts[i.severity]++;
        if (i.shimmed) shimmed++;
        else if (i.autoFixed) autoFixed++;
      }
      const appName = name.replace(/[\s/\\:]+/g, "") || "Extension";
      const payload = {
        name,
        appName,
        bundleId: defaultBundleId(appName),
        version: manifest.version,
        manifestVersion: manifest.manifest_version ?? 3,
        platforms,
        counts,
        autoFixed,
        shimmed,
        blocking: blockingCount,
        convertible: blockingCount === 0,
        removedPermissions: permissionsToRemove,
        manifestChanges: changes,
        issues,
      };
      const out = JSON.stringify(payload, null, 2);
      console.log(out);
      if (reportPath) writeAnalyzeReport(reportPath, out);
    } else {
      printIssues(issues);
      if (changes.length > 0) {
        console.log(`\n${color("blue", `Manifest changes the converter would apply (${changes.length})`)}`);
        for (const c of changes) console.log(`  • ${c}`);
      }
      if (reportPath) {
        const md = buildReportMarkdown(
          {
            name,
            version: manifest.version,
            manifestVersion: manifest.manifest_version ?? 3,
            platforms,
            removedPermissions: permissionsToRemove,
            manifestChanges: changes,
          },
          issues
        );
        writeAnalyzeReport(reportPath, md);
      }
    }
    return blockingCount > 0 ? 1 : 0;
  } finally {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
}

function writeAnalyzeReport(path: string, content: string): void {
  try {
    writeFileSync(resolve(path), content, "utf-8");
    ok(`Report written → ${path}`);
  } catch (e) {
    warn(`Could not write report to ${path}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "bundle-id": { type: "string" },
        "app-name": { type: "string" },
        "min-safari": { type: "string" },
        platforms: { type: "string", default: "macos" },
        ci: { type: "boolean", default: false },
        "temp-load": { type: "boolean", default: false },
        zip: { type: "boolean", default: false },
        clean: { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        "open-xcode": { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        "install-dir": { type: "string" },
        "no-safari-restart": { type: "boolean", default: false },
        team: { type: "string" },
        "no-shim": { type: "boolean", default: false },
        "no-oauth-bridge": { type: "boolean", default: false },
        "keep-module": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        analyze: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        report: { type: "string" },
        doctor: { type: "boolean", default: false },
        list: { type: "boolean", default: false },
        uninstall: { type: "string" },
        quiet: { type: "boolean", short: "q", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail((e as Error).message);
    console.log(HELP);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  setVerbose(values.verbose);
  setQuiet(values.quiet && !values.verbose);

  if (values.version) {
    console.log(pkgVersion());
    process.exit(0);
  }
  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.doctor) process.exit(doctor());
  if (values.list) {
    const exts = listSafariExtensions();
    if (exts.length === 0) {
      info("No Safari Web Extensions are registered with this user.");
    } else {
      info(`Registered Safari Web Extensions (${exts.length}):`);
      for (const e of exts) console.log(`  ${e.bundleId}\n    ${color("dim", e.path)}`);
    }
    process.exit(0);
  }
  if (values.uninstall !== undefined) {
    process.exit(uninstallFromSafari(values.uninstall, values["install-dir"]) ? 0 : 1);
  }

  const input = positionals[0];
  if (!input) {
    fail("Missing <input> (a .zip, .crx, extension directory, or URL).");
    console.log(HELP);
    process.exit(2);
  }
  if (!isUrl(input) && !existsSync(input)) {
    fail(`Input not found: ${input}`);
    process.exit(1);
  }

  const platforms = values.platforms as Platforms;
  if (!["all", "macos", "ios"].includes(platforms)) {
    fail(`Invalid --platforms "${platforms}". Use all | macos | ios.`);
    process.exit(2);
  }

  if (values.install && (values["no-build"] || values["temp-load"])) {
    fail("--install requires a build; remove --no-build / --temp-load.");
    process.exit(2);
  }

  if (values["bundle-id"] !== undefined && !BUNDLE_ID_RE.test(values["bundle-id"])) {
    fail(`Invalid --bundle-id "${values["bundle-id"]}". Use reverse-DNS (e.g. com.example.myext): letters/digits/hyphens, dot-separated, 2+ segments.`);
    process.exit(2);
  }

  if (values["min-safari"] !== undefined && !SAFARI_VERSION_RE.test(values["min-safari"])) {
    fail(`Invalid --min-safari "${values["min-safari"]}". Use a version like 15.4 or 18.4 (1–3 numbers).`);
    process.exit(2);
  }

  if (values.team !== undefined && values.team !== "auto" && !TEAM_ID_RE.test(values.team)) {
    fail(`Invalid --team "${values.team}". Use a 10-character Apple Team ID (e.g. A1B2C3D4E5) or "auto".`);
    process.exit(2);
  }

  if (values.json && !values.analyze) {
    fail("--json is only valid with --analyze.");
    process.exit(2);
  }

  if (values.report !== undefined && !values.analyze) {
    fail("--report is only valid with --analyze.");
    process.exit(2);
  }

  let localInput = input;
  if (isUrl(input)) {
    info(`Downloading extension from ${input} …`);
    const dlScratch = mkdtempSync(join(tmpdir(), "c2s-dl-"));
    // Clean the download scratch on ANY exit (success or failure). The pipeline
    // exits via process.exit on multiple paths, so a finally won't always run;
    // an exit handler fires regardless and prevents leaking the downloaded archive.
    process.on("exit", () => rmSync(dlScratch, { recursive: true, force: true }));
    try {
      localInput = await downloadExtension(input, dlScratch);
    } catch (e) {
      fail((e as Error).message);
      process.exit(1);
    }
    ok(`Downloaded → ${basename(localInput)}`);
  }

  if (values.analyze) process.exit(analyzeOnly(localInput, platforms, values.json, values.strict, values.report));

  let team = values.team;
  if (team === "auto" || (team === undefined && values.install)) {
    const detected = detectXcodeTeam();
    if (detected) {
      team = detected;
      info(`Auto-detected Apple Team ID ${detected} from Xcode → team-signing (persists across Safari quits).`);
    } else {
      if (team === "auto") warn("No Apple team found in Xcode; falling back to ad-hoc signing.");
      team = undefined;
    }
  }

  let result;
  try {
    result = convert({
      input: localInput,
      output: values.output,
      bundleId: values["bundle-id"],
      appName: values["app-name"],
      minSafariVersion: values["min-safari"],
      platforms,
      copyResources: values.ci, // default false → symlink dev mode
      tempLoadOnly: values["temp-load"],
      generateShim: !values["no-shim"],
      oauthBridge: !values["no-oauth-bridge"],
      build: !values["no-build"],
      install: values.install,
      installDir: values["install-dir"],
      safariRestart: !values["no-safari-restart"],
      team,
      force: values.force,
      strict: values.strict,
      clean: values.clean,
      zip: values.zip,
      openXcode: values["open-xcode"],
      keepModuleBackground: values["keep-module"],
      verbose: values.verbose,
    });
  } catch (e) {
    fail((e as Error).message);
    process.exit(1);
  }

  console.log("");
  if (result.success) {
    ok(color("bold", `Done: ${result.extensionName}`));
    if (result.installedAppPath) {
      console.log(`  Installed: ${result.installedAppPath}`);
      console.log("  Safari → Settings → Extensions → enable the extension.");
      if (team) {
        console.log("  Team-signed: stays enabled across Safari quits (no unsigned toggle).");
        console.log("  Free personal team: re-run this command to re-sign before the ~7-day profile expires.");
      } else {
        console.log('  After each Safari restart, re-tick Develop → "Allow Unsigned Extensions".');
      }
    } else if (result.appPath) {
      console.log(`  App:    ${result.appPath}`);
      console.log(`  Install: re-run with --install, or  cp -R "${result.appPath}" ~/Applications/`);
      console.log("  Then: Safari → Settings → Extensions → enable.");
    } else if (result.xcodeProject) {
      console.log(`  Project: ${result.xcodeProject}`);
    } else if (result.stagedPath) {
      console.log(`  Staged:  ${result.stagedPath}`);
    }
    if (result.zipPath) console.log(`  Zip:     ${result.zipPath}`);
    process.exit(0);
  } else {
    fail("Conversion did not complete. See messages above.");
    process.exit(1);
  }
}

main().catch((e) => {
  fail((e as Error).message);
  process.exit(1);
});
