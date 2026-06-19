import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import type { ConvertOptions, ConvertResult, Issue } from "./types.js";
import { extractExtension } from "./extract.js";
import { loadManifest, analyzeManifest, transformManifest, writeManifest, resolveI18nString, collectReferencedPaths } from "./manifest.js";
import { scanExtension } from "./analyze.js";
import { stageExtension, stripDanglingSourcemaps } from "./stage.js";
import { writeShim, writePolyfill, injectShimIntoHtmlPages, injectPopupSizing, convertServiceWorkerToBackgroundPage, deriveProxyHosts } from "./shim.js";
import { applyOAuthBridge, deriveChromeId } from "./oauth-bridge.js";
import { applyDnr } from "./dnr.js";
import { synthesizePlaceholderIcons } from "./icons.js";
import { writeTempLoadInstructions } from "./tempload.js";
import { installToSafari } from "./installer.js";
import {
  runPackager,
  patchProjectBundleIds,
  writeNativeProxyHandler,
  buildXcodeProject,
  verifyBuiltBundleId,
  pluginkitStatus,
  unsignedExtensionsAllowed,
  defaultBundleId,
} from "./packager.js";
import { printIssues, countBlocking, writeReportFile } from "./report.js";
import { info, ok, warn, fail, moveBundle, run } from "./util.js";

export function convert(opts: ConvertOptions): ConvertResult {
  const result: ConvertResult = {
    success: false,
    extensionName: "Unknown",
    manifestVersion: 3,
    issues: [],
  };

  const scratch = mkdtempSync(join(tmpdir(), "viaduct-"));
  // Throwaway DerivedData from buildXcodeProject; removed once the built app is moved out.
  let derivedDir: string | undefined;
  const cleanup = () => {
    if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    if (derivedDir && existsSync(derivedDir)) rmSync(derivedDir, { recursive: true, force: true });
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
    result.extensionName = resolveI18nString(manifest.name, extPath, manifest.default_locale) ?? manifest.name ?? "Unknown";
    result.manifestVersion = manifest.manifest_version ?? 3;
    ok(`Loaded "${result.extensionName}" (MV${result.manifestVersion})`);

    // Compute the real Chrome id NOW, before transformManifest strips the `key`.
    // Used to bake the original id into the OAuth bridge templates so pages that
    // check chrome.runtime.id keep working after conversion.
    const chromeId = deriveChromeId(manifest);

    const { issues: manifestIssues, permissionsToRemove } = analyzeManifest(manifest);
    const issues: Issue[] = [...manifestIssues, ...scanExtension(extPath, manifest, opts.platforms)];
    result.issues = issues;

    const blocking = countBlocking(issues, opts.strict);
    if (blocking > 0 && !opts.force) {
      printIssues(issues);
      const what = opts.strict ? "blocking issue(s) (--strict: warnings count)" : "blocking error(s)";
      fail(`${blocking} ${what}. Re-run with --force to convert anyway.`);
      return result;
    }

    // Strip whitespace plus path/scheme separators — the name becomes a directory
    // name, an xcodebuild scheme, and part of the bundle id.
    const appName = (opts.appName ?? result.extensionName).replace(/[\s/\\:]+/g, "") || "Extension";
    const bundleId = opts.bundleId ?? defaultBundleId(appName);
    result.resolvedBundleId = bundleId;

    const outputDir = resolve(opts.output ?? join(process.cwd(), `${appName}_Safari`));
    if (opts.clean && existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
      ok(`Cleaned output dir → ${outputDir}`);
    }
    mkdirSync(outputDir, { recursive: true });

    // Persistent staged dir (NOT in scratch) so dev-mode symlinks survive cleanup.
    const stageDir = join(outputDir, "staged_extension");
    info("Staging clean extension assets …");
    stageExtension(extPath, stageDir, collectReferencedPaths(manifest));

    let shimFile: string | undefined;
    let polyfillFile: string | undefined;
    if (opts.generateShim) {
      polyfillFile = writePolyfill(stageDir);
      if (polyfillFile) ok("Bundled webextension-polyfill (browser.* promises on all browsers)");
      shimFile = writeShim(stageDir, {
        chromeOrigin: chromeId ? `chrome-extension://${chromeId}` : "",
        proxyHosts: deriveProxyHosts(manifest),
      });
      const n = injectShimIntoHtmlPages(stageDir, polyfillFile);
      if (n > 0) ok(`Shim${polyfillFile ? " + polyfill" : ""} injected into ${n} HTML page(s)`);
    }

    const transformed = transformManifest(manifest, permissionsToRemove, stageDir, {
      keepModuleBackground: opts.keepModuleBackground,
      shimFile,
      polyfillFile,
      minSafariVersion: opts.minSafariVersion,
    });

    const dnrNotes = applyDnr(stageDir, transformed);
    for (const n of dnrNotes) warn(n);

    if (opts.oauthBridge !== false) {
      const bridgeNotes = applyOAuthBridge(stageDir, transformed, chromeId);
      for (const n of bridgeNotes) ok(n);
    }

    if (convertServiceWorkerToBackgroundPage(stageDir, transformed, polyfillFile)) {
      ok("Service worker → persistent background page (Safari reachability)");
    }

    const synthIcons = synthesizePlaceholderIcons(stageDir, transformed, appName);
    if (synthIcons.length > 0) ok(`Synthesized placeholder icons (${synthIcons.join("/")}px) — manifest had none`);

    const strippedMaps = stripDanglingSourcemaps(stageDir);
    if (strippedMaps > 0) ok(`Stripped dangling sourcemap refs from ${strippedMaps} script(s)`);

    writeManifest(stageDir, transformed);
    const popupFile = (transformed.action ?? transformed.browser_action)?.default_popup;
    if (popupFile) {
      // A SIDE-PANEL page wired as the popup needs an explicit height or its
      // height:100% layout collapses in a popover (Claude's sidepanel.html). Gate
      // strictly on the side_panel manifest field OR a "side panel" filename —
      // NOT generic names like index.html (that would blow up normal popups like
      // Urban VPN's). Everything else gets the floor-only treatment.
      const panelPath = transformed.side_panel?.default_path;
      const stripFrag = (p?: string) => (typeof p === "string" ? p.split(/[#?]/)[0].replace(/^\//, "") : p);
      const base = stripFrag(popupFile) ?? "";
      const isSidePanel =
        (!!panelPath && stripFrag(panelPath) === base) ||
        /(^|\/)side[_-]?panel\.html$/i.test(base);
      injectPopupSizing(stageDir, popupFile, isSidePanel);
    }
    result.stagedPath = stageDir;
    ok(`Staged → ${stageDir}`);

    const reportPath = writeReportFile(
      outputDir,
      {
        name: result.extensionName,
        version: transformed.version,
        manifestVersion: result.manifestVersion,
        platforms: opts.platforms,
        removedPermissions: permissionsToRemove,
      },
      issues
    );
    ok(`Report → ${reportPath}`);

    if (opts.zip) {
      const zipPath = join(outputDir, `${appName}_SafariExtension.zip`);
      if (existsSync(zipPath)) rmSync(zipPath, { force: true });
      // ditto -c -k zips the staged dir's CONTENTS (--keepParent off) so the archive
      // unpacks straight to manifest.json — the shape Safari's temp-load expects.
      const z = run("ditto", ["-c", "-k", "--sequesterRsrc", stageDir, zipPath]);
      if (z.code === 0 && existsSync(zipPath)) {
        result.zipPath = zipPath;
        ok(`Zipped staged extension → ${zipPath}`);
      } else {
        warn(`Could not create the extension zip (${z.stderr.trim() || "ditto failed"}).`);
      }
    }

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

    // Install the native HTTP proxy handler so requests to the extension's own
    // backends can be sent with the Chrome origin (the in-browser shim can't set
    // it). Generic: hosts/origin derived from the manifest, no-op if none.
    const proxyHosts = deriveProxyHosts(manifest);
    if (proxyHosts.length > 0) {
      writeNativeProxyHandler(xcodeproj, chromeId ? `chrome-extension://${chromeId}` : "", proxyHosts);
      ok(`Native proxy handler wired for ${proxyHosts.length} backend host(s)`);
    }

    if (opts.openXcode) {
      const o = run("/usr/bin/open", ["-a", "Xcode", xcodeproj]);
      if (o.code === 0) ok("Opened the project in Xcode");
      else warn(`Could not open Xcode (${o.stderr.trim() || `exit ${o.code}`}).`);
    }

    if (!opts.build) {
      ok("Skipping build (--no-build). Open the project in Xcode to build.");
      result.success = true;
      printIssues(issues);
      return result;
    }

    info(opts.team ? `Building (signed: team ${opts.team}) …` : "Building (ad-hoc signed) …");
    const build = buildXcodeProject(xcodeproj, appName, opts.platforms, opts.team);
    if (!build) {
      fail("Build failed. See output above.");
      printIssues(issues);
      return result;
    }
    const builtApp = build.builtApp;
    derivedDir = build.derivedDir;
    ok(`Built & signed → ${builtApp}`);

    // The check v2 lacked: confirm the COMPILED bundle ids match intent (before it moves).
    const v = verifyBuiltBundleId(builtApp, bundleId);
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

    // The unsigned toggle only matters for ad-hoc builds; a team-signed app ignores it.
    if (!opts.team) {
      const allowed = unsignedExtensionsAllowed();
      if (allowed === false) {
        warn('Safari "Allow Unsigned Extensions" is OFF — enable it (Develop menu) or the extension will not load.');
      } else if (allowed === null) {
        warn('Could not read Safari "Allow Unsigned Extensions"; enable it manually for ad-hoc builds.');
      }
    }

    if (opts.install) {
      // Move the Release product straight into ~/Applications — no intermediate copy.
      const inst = installToSafari({
        builtAppPath: builtApp,
        appName,
        bundleId,
        installDir: opts.installDir,
        safariRestart: opts.safariRestart,
        signed: !!opts.team,
      });
      if (inst.installedAppPath) {
        result.appPath = inst.installedAppPath;
        result.installedAppPath = inst.installedAppPath;
        ok(`Installed → ${inst.installedAppPath}`);
      } else {
        const stableApp = join(outputDir, basename(builtApp));
        if (moveBundle(builtApp, stableApp)) result.appPath = stableApp;
        warn(`Install did not complete; the built app is at ${result.appPath ?? builtApp}.`);
      }
    } else {
      // No install: relocate the signed product out of the throwaway build dir to a
      // stable path in the output dir. A move, not a copy.
      const stableApp = join(outputDir, basename(builtApp));
      if (moveBundle(builtApp, stableApp)) {
        result.appPath = stableApp;
        ok(`Built app → ${stableApp}`);
      } else {
        warn("Could not relocate the built app out of the temporary build dir.");
      }
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
