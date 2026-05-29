import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { ConvertOptions, ConvertResult, Issue } from "./types.js";
import { extractExtension } from "./extract.js";
import { loadManifest, analyzeManifest, transformManifest, writeManifest } from "./manifest.js";
import { scanJsFiles } from "./analyze.js";
import { stageExtension } from "./stage.js";
import { writeShim, SHIM_FILENAME } from "./shim.js";
import { writeTempLoadInstructions } from "./tempload.js";
import {
  runPackager,
  patchProjectBundleIds,
  buildXcodeProject,
  verifyBuiltBundleId,
  pluginkitStatus,
  unsignedExtensionsAllowed,
  defaultBundleId,
} from "./packager.js";
import { printIssues, countBlocking } from "./report.js";
import { info, ok, warn, fail, color } from "./util.js";

export function convert(opts: ConvertOptions): ConvertResult {
  const result: ConvertResult = {
    success: false,
    extensionName: "Unknown",
    manifestVersion: 3,
    issues: [],
  };

  const scratch = mkdtempSync(join(tmpdir(), "chrome2safari-"));
  const cleanup = () => {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    info(`Extracting ${basename(opts.input)} …`);
    const extPath = extractExtension(resolve(opts.input), scratch);

    const manifest = loadManifest(extPath);
    result.extensionName = manifest.name ?? "Unknown";
    result.manifestVersion = manifest.manifest_version ?? 3;
    ok(`Loaded "${result.extensionName}" (MV${result.manifestVersion})`);

    const { issues: manifestIssues, permissionsToRemove } = analyzeManifest(manifest);
    const jsIssues = scanJsFiles(extPath);
    const issues: Issue[] = [...manifestIssues, ...jsIssues];
    result.issues = issues;

    const blocking = countBlocking(issues);
    if (blocking > 0 && !opts.force) {
      printIssues(issues);
      fail(`${blocking} blocking error(s). Re-run with --force to convert anyway.`);
      return result;
    }

    const appName = (opts.appName ?? result.extensionName).replace(/\s+/g, "");
    const bundleId = opts.bundleId ?? defaultBundleId(appName);
    result.resolvedBundleId = bundleId;

    const outputDir = resolve(opts.output ?? join(process.cwd(), `${appName}_Safari`));
    mkdirSync(outputDir, { recursive: true });

    // Persistent staged dir (NOT in scratch) so dev-mode symlinks survive cleanup.
    const stageDir = join(outputDir, "staged_extension");
    info("Staging clean extension assets …");
    stageExtension(extPath, stageDir);

    let shimFile: string | undefined;
    if (opts.generateShim) {
      shimFile = writeShim(stageDir);
    }

    const transformed = transformManifest(manifest, permissionsToRemove, stageDir, {
      keepModuleBackground: opts.keepModuleBackground,
      shimFile: shimFile === SHIM_FILENAME ? SHIM_FILENAME : undefined,
    });
    writeManifest(stageDir, transformed);
    result.stagedPath = stageDir;
    ok(`Staged → ${stageDir}`);

    if (opts.tempLoadOnly) {
      const notes = writeTempLoadInstructions(stageDir);
      ok(`Safari 18+ temp-load ready. See ${notes}`);
      result.success = true;
      printIssues(issues);
      return result;
    }

    info("Running safari-web-extension-packager …");
    const xcodeproj = runPackager({
      stagedDir: stageDir,
      outputDir,
      bundleId,
      appName,
      platforms: opts.platforms,
      copyResources: opts.copyResources,
    });
    if (!xcodeproj) {
      fail("Packager did not produce an Xcode project.");
      printIssues(issues);
      return result;
    }
    result.xcodeProject = xcodeproj;
    ok(`Xcode project → ${xcodeproj}`);

    info("Patching bundle identifiers …");
    patchProjectBundleIds(xcodeproj, bundleId);

    if (!opts.build) {
      ok("Skipping build (--no-build). Open the project in Xcode to build.");
      result.success = true;
      printIssues(issues);
      return result;
    }

    info("Building (ad-hoc signed) …");
    const appPath = buildXcodeProject(xcodeproj, appName, outputDir, opts.platforms);
    if (!appPath) {
      fail("Build failed. See output above.");
      printIssues(issues);
      return result;
    }
    result.appPath = appPath;
    ok(`Built → ${appPath}`);

    // The check v2 lacked: confirm the COMPILED bundle ids match intent.
    const v = verifyBuiltBundleId(appPath, bundleId);
    if (!v.ok) {
      fail("Bundle identifier mismatch in the built app — Safari would register the wrong extension.");
      console.error(`    app  expected ${v.expectedAppId}  got ${v.appId ?? "∅"}`);
      console.error(`    appex expected ${v.expectedExtId} got ${v.extId ?? "∅"}`);
      console.error("    This is the exact failure mode of the previous attempt. Aborting as failed.");
      printIssues(issues);
      return result;
    }
    ok(`Bundle ids verified: ${v.appId} / ${v.extId}`);

    const pk = pluginkitStatus();
    if (pk) info(`pluginkit:\n${pk}`);

    const allowed = unsignedExtensionsAllowed();
    if (allowed === false) {
      warn('Safari "Allow Unsigned Extensions" is OFF — enable it (Develop menu) or the extension will not load.');
    } else if (allowed === null) {
      warn('Could not read Safari "Allow Unsigned Extensions"; enable it manually for ad-hoc builds.');
    }

    result.success = true;
    printIssues(issues);
    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}
