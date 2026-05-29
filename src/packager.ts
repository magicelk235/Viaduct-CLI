import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, info, ok, warn } from "./util.js";
import type { Platforms } from "./types.js";

function findFiles(dir: string, predicate: (name: string, full: string) => boolean, depth = 3, acc: string[] = []): string[] {
  if (depth < 0 || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (predicate(entry, full)) acc.push(full);
    if (st.isDirectory() && entry !== "node_modules") findFiles(full, predicate, depth - 1, acc);
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

  const projects = findFiles(opts.outputDir, (n) => n.endsWith(".xcodeproj"), 2);
  return projects[0] ?? null;
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
  // Remaining ones are the app target(s).
  content = content.replace(
    /PRODUCT_BUNDLE_IDENTIFIER = "?(?!.*\.Extension")[\w.\-$()]+"?;/g,
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

/** Build with ad-hoc signing (local dev). Returns path to the built .app. */
export function buildXcodeProject(
  xcodeproj: string,
  appName: string,
  outputDir: string,
  platforms: Platforms
): string | null {
  const scheme = pickScheme(xcodeproj, appName, platforms);
  if (!scheme) {
    warn("No Xcode scheme found; skipping build.");
    return null;
  }
  const derived = join(outputDir, "DerivedData");
  const args = [
    "-project",
    xcodeproj,
    "-scheme",
    scheme,
    "-configuration",
    "Release",
    "-derivedDataPath",
    derived,
    "CODE_SIGN_IDENTITY=-",
    "CODE_SIGNING_REQUIRED=NO",
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ];
  info(`xcodebuild -scheme "${scheme}" (ad-hoc signed)`);
  const res = run("xcodebuild", args);
  if (res.code !== 0) {
    warn(`build failed:\n${res.stderr.slice(-2000) || res.stdout.slice(-2000)}`);
    return null;
  }
  const productsDir = join(derived, "Build", "Products", "Release");
  const apps = findFiles(productsDir, (n) => n.endsWith(".app"), 1);
  return apps[0] ?? null;
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

export function defaultBundleId(appName: string): string {
  const slug = appName.replace(/[^A-Za-z0-9]/g, "");
  return `com.chrome2safari.${slug || "extension"}`;
}
