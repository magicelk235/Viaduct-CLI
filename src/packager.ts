import { readdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { run, info, ok, warn } from "./util.js";
import type { Platforms } from "./types.js";

function findFiles(dir: string, predicate: (name: string, full: string) => boolean, depth = 3, acc: string[] = []): string[] {
  if (depth < 0) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (predicate(entry.name, full)) acc.push(full);
    // staged_extension is the web-extension payload — never contains Xcode artifacts.
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "staged_extension") {
      findFiles(full, predicate, depth - 1, acc);
    }
  }
  return acc;
}

export interface PackageOptions {
  stagedDir: string;
  outputDir: string;
  bundleId: string;
  appName: string;
  platforms: Platforms;
  copyResources: boolean;
}

/** Run the Apple packager. Returns path to the generated .xcodeproj, or null. */
export function runPackager(opts: PackageOptions): string | null {
  const args = [
    "safari-web-extension-packager",
    opts.stagedDir,
    "--project-location",
    opts.outputDir,
    "--app-name",
    opts.appName,
    "--bundle-identifier",
    opts.bundleId,
    "--swift",
    "--no-open",
    "--no-prompt",
    "--force",
  ];
  if (opts.copyResources) args.push("--copy-resources");
  if (opts.platforms === "macos") args.push("--macos-only");
  else if (opts.platforms === "ios") args.push("--ios-only");

  info(`xcrun ${args.join(" ")}`);
  const res = run("xcrun", args);
  if (res.code !== 0) {
    warn(`packager stderr:\n${res.stderr.trim()}`);
    return null;
  }

  const projects = findFiles(opts.outputDir, (n) => n.endsWith(".xcodeproj"), 4);
  // Prefer the project we just generated; a stale .xcodeproj from a prior run in a
  // reused outputDir can otherwise be picked (readdir order is not guaranteed).
  return projects.find((p) => basename(p) === `${opts.appName}.xcodeproj`) ?? projects[0] ?? null;
}

/**
 * Force every PRODUCT_BUNDLE_IDENTIFIER in the project to the intended value.
 * App targets → bundleId; extension/appex targets → bundleId.Extension.
 * This is best-effort; the authoritative check is verifyBuiltBundleId().
 */
export function patchProjectBundleIds(xcodeproj: string, bundleId: string): void {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxproj)) return;
  let content = readFileSync(pbxproj, "utf-8");
  const extId = `${bundleId}.Extension`;

  // Extension targets carry a ".Extension" suffix in the generated id.
  content = content.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = "?[\w.\-$()]+\.Extension"?;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = "${extId}";`
  );
  // Remaining ones are the app target(s). The value-scoped negative lookahead
  // `(?![\w.\-$()]*\.Extension"?;)` only inspects the current identifier, so it
  // skips lines already rewritten to "<id>.Extension" without scanning the rest
  // of the file (a `.*` lookahead would match any later .Extension line).
  content = content.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = "?(?![\w.\-$()]*\.Extension"?;)[\w.\-$()]+"?;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = "${bundleId}";`
  );
  writeFileSync(pbxproj, content, "utf-8");

  // The generated Swift references the extension id for "open preferences" deep links.
  for (const swift of findFiles(xcodeproj.replace(/[^/]+\.xcodeproj$/, ""), (n) => n.endsWith(".swift"), 4)) {
    let s = readFileSync(swift, "utf-8");
    if (s.includes("extensionBundleIdentifier")) {
      s = s.replace(/let extensionBundleIdentifier = "[^"]+"/g, `let extensionBundleIdentifier = "${extId}"`);
      writeFileSync(swift, s, "utf-8");
    }
  }
}

function pickScheme(xcodeproj: string, appName: string, platforms: Platforms): string | null {
  const res = run("xcodebuild", ["-project", xcodeproj, "-list", "-json"]);
  if (res.code !== 0) return null;
  let schemes: string[] = [];
  try {
    schemes = JSON.parse(res.stdout)?.project?.schemes ?? [];
  } catch {
    return null;
  }
  const want = platforms === "ios" ? "iOS" : "macOS";
  const preferred = [`${appName} (${want})`, appName, `${want} (App)`];
  for (const p of preferred) if (schemes.includes(p)) return p;
  const byPlat = schemes.find((s) => s.includes(want));
  return byPlat ?? schemes[0] ?? null;
}

/**
 * Build the Xcode project. With `team` → automatic Apple-issued dev signing, which
 * Safari loads WITHOUT the session-scoped "Allow Unsigned Extensions" toggle, so the
 * extension survives quitting Safari. Without `team` → ad-hoc signing (needs the toggle,
 * which resets every Safari session). Returns the freshly built .app still sitting in
 * the throwaway DerivedData dir, plus that dir — the caller MOVES the app to its final
 * home (no intermediate copy) and then deletes the dir.
 */
export function buildXcodeProject(
  xcodeproj: string,
  appName: string,
  platforms: Platforms,
  team?: string
): { builtApp: string; derivedDir: string } | null {
  const scheme = pickScheme(xcodeproj, appName, platforms);
  if (!scheme) {
    warn("No Xcode scheme found; skipping build.");
    return null;
  }
  // Build into a temp DerivedData OUTSIDE the project tree. When the project lives on
  // an iCloud-synced volume (e.g. ~/Desktop or ~/Documents), the file provider stamps
  // the freshly built .appex with `com.apple.fileprovider.fpfs#P` / `com.apple.FinderInfo`,
  // and codesign then aborts with "resource fork, Finder information, or similar detritus
  // not allowed" — so signing the App Sandbox entitlement fails and the build dies.
  // $TMPDIR is never file-provider managed, so the bundle stays clean for signing.
  const derived = mkdtempSync(join(tmpdir(), "c2s-dd-"));
  const signing = team
    ? [
        // Real Apple-issued development signing. Automatic style + -allowProvisioningUpdates
        // lets Xcode create/refresh the development provisioning profile (the App Sandbox
        // entitlement requires one). A team-signed extension loads in Safari without the
        // unsigned toggle and persists across restarts.
        "-allowProvisioningUpdates",
        "CODE_SIGN_STYLE=Automatic",
        `DEVELOPMENT_TEAM=${team}`,
        "CODE_SIGN_IDENTITY=Apple Development",
      ]
    : [
        // Ad-hoc sign WITH entitlements. The targets set ENABLE_APP_SANDBOX=YES, which
        // Xcode turns into the App Sandbox entitlement at sign time — and Safari refuses
        // to register a web-extension appex that lacks it. CODE_SIGNING_ALLOWED=NO skips
        // signing AND entitlement application, so the extension silently never appears in
        // Safari. Manual style + empty team/profile lets the ad-hoc "-" identity sign
        // without a provisioning profile.
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGN_STYLE=Manual",
        "DEVELOPMENT_TEAM=",
        "PROVISIONING_PROFILE_SPECIFIER=",
        "CODE_SIGNING_REQUIRED=NO",
      ];
  const args = [
    "-project",
    xcodeproj,
    "-scheme",
    scheme,
    "-configuration",
    "Release",
    "-derivedDataPath",
    derived,
    ...signing,
    "build",
  ];
  info(`xcodebuild -scheme "${scheme}" (${team ? `team ${team}` : "ad-hoc"} signed)`);
  const res = run("xcodebuild", args);
  if (res.code !== 0) {
    warn(`build failed:\n${res.stderr.slice(-2000) || res.stdout.slice(-2000)}`);
    rmSync(derived, { recursive: true, force: true });
    return null;
  }
  const productsDir = join(derived, "Build", "Products", "Release");
  const apps = findFiles(productsDir, (n) => n.endsWith(".app"), 4);
  // Match the app we built by name; a multi-platform Release dir can hold several .app
  // bundles, and readdir order is not guaranteed, so [0] could be the wrong one.
  const built = apps.find((p) => basename(p) === `${appName}.app`) ?? apps[0];
  if (!built) {
    rmSync(derived, { recursive: true, force: true });
    return null;
  }
  // Hand the signed .app back where it sits (in DerivedData). The caller moves it to its
  // final home in one hop — no copy onto the iCloud-synced project tree — then deletes
  // derivedDir. A move preserves the signature/seal untouched (no re-stamp, no re-sign).
  return { builtApp: built, derivedDir: derived };
}

function plistValue(plistPath: string, key: string): string | null {
  if (!existsSync(plistPath)) return null;
  const res = run("plutil", ["-extract", key, "raw", "-o", "-", plistPath]);
  return res.code === 0 ? res.stdout.trim() : null;
}

export interface BundleVerification {
  ok: boolean;
  appId: string | null;
  extId: string | null;
  expectedAppId: string;
  expectedExtId: string;
}

/**
 * Read the BUILT bundle Info.plists and confirm the identifiers match intent.
 * This is the check v2 lacked: it patched the project but never verified the
 * compiled .appex, so Safari registered the packager-default id.
 */
export function verifyBuiltBundleId(appPath: string, bundleId: string): BundleVerification {
  const expectedAppId = bundleId;
  const expectedExtId = `${bundleId}.Extension`;
  const appId = plistValue(join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier");

  const appexes = findFiles(join(appPath, "Contents", "PlugIns"), (n) => n.endsWith(".appex"), 1);
  const extId = appexes.length
    ? plistValue(join(appexes[0], "Contents", "Info.plist"), "CFBundleIdentifier")
    : null;

  return {
    ok: appId === expectedAppId && extId === expectedExtId,
    appId,
    extId,
    expectedAppId,
    expectedExtId,
  };
}

/** Query macOS pluginkit for Safari web-extension registration. */
export function pluginkitStatus(): string {
  const res = run("pluginkit", ["-mAvvv", "-p", "com.apple.Safari.web-extension"]);
  return res.stdout.trim();
}

/**
 * Best-effort read of Safari's "Allow Unsigned Extensions" toggle.
 * It is session-scoped and required to load ad-hoc-signed extensions.
 */
export function unsignedExtensionsAllowed(): boolean | null {
  const res = run("defaults", ["read", "com.apple.Safari", "AllowUnsignedAppExtensions"]);
  if (res.code !== 0) return null;
  return res.stdout.trim() === "1";
}

/**
 * Best-effort read of an Apple Developer Team ID cached by Xcode. When an Apple
 * account is signed into Xcode it records each team under
 * IDEProvisioningTeamByIdentifier in com.apple.dt.Xcode (keyed by Apple ID). We
 * return the first 10-char team id we can parse, so the tool can team-sign
 * without the user knowing or passing the id. Returns null when no account is
 * signed in or the value can't be read.
 */
export function detectXcodeTeam(): string | null {
  const res = run("defaults", ["read", "com.apple.dt.Xcode", "IDEProvisioningTeamByIdentifier"]);
  if (res.code !== 0) return null;
  const ids = [...res.stdout.matchAll(/teamID\s*=\s*"?([A-Z0-9]{10})"?/g)].map((m) => m[1]);
  return ids[0] ?? null;
}

export function defaultBundleId(appName: string): string {
  // Strip non-alphanumerics, then drop any leading digits: a CFBundleIdentifier
  // segment that starts with a digit (e.g. "123App") is rejected by parts of
  // Apple's toolchain. Fall back to "extension" when nothing usable remains.
  const slug = appName.replace(/[^A-Za-z0-9]/g, "").replace(/^[0-9]+/, "");
  return `com.chrome2safari.${slug || "extension"}`;
}
