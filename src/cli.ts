#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convert } from "./convert.js";
import { extractExtension } from "./extract.js";
import { loadManifest, analyzeManifest } from "./manifest.js";
import { scanJsFiles } from "./analyze.js";
import { printIssues } from "./report.js";
import { run, info, ok, warn, fail, color } from "./util.js";
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

function analyzeOnly(input: string, verbose: boolean): number {
  const scratch = mkdtempSync(join(tmpdir(), "chrome2safari-"));
  try {
    const extPath = extractExtension(resolve(input), scratch);
    const manifest = loadManifest(extPath);
    info(`${manifest.name ?? "Unknown"} (MV${manifest.manifest_version ?? 3})`);
    const { issues: mIssues } = analyzeManifest(manifest);
    const issues = [...mIssues, ...scanJsFiles(extPath)];
    printIssues(issues);
    return 0;
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

  if (values.analyze) process.exit(analyzeOnly(input, values.verbose));

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
    if (result.appPath) {
      console.log(`  App:    ${result.appPath}`);
      console.log(`  Install: cp -R "${result.appPath}" /Applications/`);
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
