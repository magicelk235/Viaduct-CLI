#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convert } from "./convert.js";
import { extractExtension } from "./extract.js";
import { loadManifest, analyzeManifest } from "./manifest.js";
import { scanJsFiles, scanExtensionDir } from "./analyze.js";
import { printIssues } from "./report.js";
import { run, info, ok, warn, fail, color, commandExists } from "./util.js";
import { LSREGISTER } from "./installer.js";
import { detectXcodeTeam } from "./packager.js";
import type { Platforms } from "./types.js";

const HELP = `chrome2safari — convert a Chrome extension to a Safari Web Extension

USAGE
  chrome2safari <input> [options]
  chrome2safari <input> --analyze         # report only, no conversion
  chrome2safari --doctor                  # check local toolchain

INPUT
  A .zip, .crx, or an unpacked extension directory.

OPTIONS
  -o, --output <dir>        Output directory (default: ./<AppName>_Safari)
      --bundle-id <id>      Reverse-DNS bundle id (default: com.chrome2safari.<app>)
      --app-name <name>     Host app name (default: extension name)
      --platforms <p>       all | macos | ios            (default: macos)
      --ci                  Clean-copy resources into the project (CI/TestFlight-safe)
                            Default omits --copy-resources → symlinks for live dev edits.
      --temp-load           Stage only, for Safari 18 "Add Temporary Extension…" (no Xcode)
      --no-build            Generate the Xcode project but do not run xcodebuild
      --install             Install the built app to ~/Applications + register it with Safari
      --install-dir <dir>   Install target directory (default: ~/Applications)
      --no-safari-restart   With --install, don't quit/relaunch Safari or set the unsigned toggle
      --team [<id>]         Sign with an Apple Developer Team ID (real signing → the
                            extension persists across Safari quits; no unsigned toggle).
                            --team auto (or plain --install) auto-detects the team from
                            Xcode. Omit for ad-hoc signing. Free personal teams expire ~7 days.
      --no-shim             Do not generate/inject the compatibility shim
      --keep-module         Keep background.type:"module" (default strips it)
      --force               Convert despite blocking errors
      --analyze             Analyze and report only
      --doctor              Verify xcrun/packager/xcodebuild availability
  -v, --verbose             Verbose output
  -h, --help                Show this help
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
    ["plutil", () => run("plutil", ["-help"]).code === 0 || true, ""],
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

function analyzeOnly(input: string, platforms: Platforms, verbose: boolean): number {
  const scratch = mkdtempSync(join(tmpdir(), "chrome2safari-"));
  try {
    const extPath = extractExtension(resolve(input), scratch);
    const manifest = loadManifest(extPath);
    info(`${manifest.name ?? "Unknown"} (MV${manifest.manifest_version ?? 3})`);
    const { issues: mIssues } = analyzeManifest(manifest);
    const issues = [...mIssues, ...scanJsFiles(extPath), ...scanExtensionDir(extPath, manifest, platforms)];
    printIssues(issues);
    return issues.some((i) => i.severity === "error") ? 1 : 0;
  } finally {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "bundle-id": { type: "string" },
        "app-name": { type: "string" },
        platforms: { type: "string", default: "macos" },
        ci: { type: "boolean", default: false },
        "temp-load": { type: "boolean", default: false },
        "no-build": { type: "boolean", default: false },
        install: { type: "boolean", default: false },
        "install-dir": { type: "string" },
        "no-safari-restart": { type: "boolean", default: false },
        team: { type: "string" },
        "no-shim": { type: "boolean", default: false },
        "keep-module": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        analyze: { type: "boolean", default: false },
        doctor: { type: "boolean", default: false },
        verbose: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    fail((e as Error).message);
    console.log(HELP);
    process.exit(2);
  }

  const { values, positionals } = parsed;

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.doctor) process.exit(doctor());

  const input = positionals[0];
  if (!input) {
    fail("Missing <input> (a .zip, .crx, or extension directory).");
    console.log(HELP);
    process.exit(2);
  }
  if (!existsSync(input)) {
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

  if (values.analyze) process.exit(analyzeOnly(input, platforms, values.verbose));

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
      input,
      output: values.output,
      bundleId: values["bundle-id"],
      appName: values["app-name"],
      platforms,
      copyResources: values.ci, // default false → symlink dev mode
      tempLoadOnly: values["temp-load"],
      generateShim: !values["no-shim"],
      build: !values["no-build"],
      install: values.install,
      installDir: values["install-dir"],
      safariRestart: !values["no-safari-restart"],
      team,
      force: values.force,
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
    process.exit(0);
  } else {
    fail("Conversion did not complete. See messages above.");
    process.exit(1);
  }
}

main();
