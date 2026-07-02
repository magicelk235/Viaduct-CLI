import { readdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { run, info, warn } from "../util.js";
import type { Platforms } from "../types.js";

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

  // Extension targets carry a ".Extension" suffix in the generated id. Skip the
  // exact app id: a user bundle id that itself ends in ".Extension" (allowed by
  // BUNDLE_ID_RE) would otherwise be rewritten to the appex id on a re-run,
  // leaving both targets identical and failing verifyBuiltBundleId.
  const escapedBundleId = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  content = content.replace(
    new RegExp(`PRODUCT_BUNDLE_IDENTIFIER = "?(?!${escapedBundleId}"?;)[\\w.\\-$()]+\\.Extension"?;`, "g"),
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
  // The extension appex is sandboxed (ENABLE_APP_SANDBOX = YES) but xcrun only
  // grants ENABLE_OUTGOING_NETWORK_CONNECTIONS to the APP target — not the
  // extension. Without it the appex's URLSession can't resolve any host ("A
  // server with the specified hostname could not be found"), which kills the
  // native HTTP proxy. Grant outgoing network to every sandboxed target that
  // lacks it. Idempotent: skips a block that already has the setting.
  // Add the key right after the sandbox line in any block that doesn't already
  // declare it on the immediately following line. ponytail: the app target also
  // has it on a separate line, so it ends up duplicated within that block —
  // xcodebuild takes last-wins on identical values, so this is harmless; a
  // proper pbxproj parser would dedupe but isn't worth it for a cosmetic repeat.
  content = content.replace(
    /(\bENABLE_APP_SANDBOX = YES;)(?!\s*ENABLE_OUTGOING_NETWORK_CONNECTIONS)/g,
    "$1\n\t\t\t\tENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;"
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

/**
 * Replace the generated echo SafariWebExtensionHandler with one that proxies
 * `__c2sProxy` messages: it performs the HTTP request server-side (no browser
 * CORS) and can set the Chrome-extension Origin the in-browser shim cannot.
 * This is the only way to satisfy a backend whose CORS/org gate keys on the
 * Origin header, since Safari forbids JS and DNR from setting it.
 *
 * `allowHosts` (derived from the manifest) is enforced server-side too, so the
 * host can never be coerced into proxying an arbitrary URL. No-op (leaves the
 * echo handler) when there are no hosts to proxy.
 */
export function writeNativeProxyHandler(
  xcodeproj: string,
  chromeOrigin: string,
  allowHosts: string[]
): void {
  if (allowHosts.length === 0) return;
  const root = xcodeproj.replace(/[^/]+\.xcodeproj$/, "");
  const handlers = findFiles(root, (n) => n === "SafariWebExtensionHandler.swift", 4);
  if (handlers.length === 0) return;

  // These values land inside Swift string literals. Stripping only `"` is unsafe:
  // a host/origin carrying a backslash or newline (a malformed or hostile manifest
  // can produce one — deriveProxyHosts' [^/]+ host capture permits them) would
  // break the literal, failing the build or worse. Whitelist to the characters
  // actually valid in a hostname / origin and drop anything that survives empty.
  const hostsLiteral = allowHosts
    .map((h) => h.replace(/[^a-zA-Z0-9.\-:]/g, ""))
    .filter((h) => h.length > 0)
    .map((h) => `"${h}"`)
    .join(", ");
  const originLiteral = chromeOrigin.replace(/[^a-zA-Z0-9.\-:/]/g, "");
  const swift = `//
//  SafariWebExtensionHandler.swift — native-messaging HTTP proxy.
//  Auto-generated by viaduct. Do not edit.
//
import SafariServices
import Foundation
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling, URLSessionTaskDelegate {
    // Backends the extension declares it talks to; only these may be proxied.
    static let allowHosts: Set<String> = [${hostsLiteral}]
    // Origin the in-browser shim cannot set (Safari forbids it). "" → none.
    static let chromeOrigin = "${originLiteral}"

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        guard let dict = message as? [String: Any],
              dict["__c2sProxy"] as? Bool == true,
              let urlString = dict["url"] as? String,
              let url = URL(string: urlString),
              let host = url.host,
              Self.hostAllowed(host) else {
            // Not a proxy request (or not allowlisted): preserve the echo contract.
            self.reply(context, ["echo": message as Any])
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = (dict["method"] as? String) ?? "GET"
        if let headers = dict["headers"] as? [String: String] {
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        }
        if !Self.chromeOrigin.isEmpty {
            req.setValue(Self.chromeOrigin, forHTTPHeaderField: "Origin")
        }
        // Auth: the shim forwards the request's cookies as a "cookie" field, read
        // from chrome.cookies (Safari's real jar, httpOnly INCLUDED) — not from
        // document.cookie, which can't see an httpOnly session cookie. URLSession
        // does not share Safari's cookie jar, so this forwarded header is the only
        // way the backend sees the session. We must therefore stop URLSession from
        // applying/overwriting cookies from its own (empty) shared storage, or it
        // would clobber our explicit Cookie header and the backend would 401.
        if let cookie = dict["cookie"] as? String, !cookie.isEmpty {
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        req.httpShouldHandleCookies = false
        if let body = dict["body"] as? String { req.httpBody = body.data(using: .utf8) }

        // Don't let the (empty) shared storage inject/replace cookies — the request
        // already carries the authenticated Cookie header built from chrome.cookies.
        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        // Follow redirects only within the allowlist: URLSession copies our Cookie/
        // Origin headers onto the redirected request, so an open/hostile redirect
        // would leak the Safari session cookie off-allowlist. The delegate below
        // vetoes any cross-host hop that isn't allowlisted.
        let session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: req) { data, response, error in
            if let error = error {
                self.reply(context, ["error": error.localizedDescription])
                return
            }
            let http = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (k, v) in (http?.allHeaderFields ?? [:]) {
                if let ks = k as? String, let vs = v as? String { headers[ks] = vs }
            }
            self.reply(context, [
                "status": http?.statusCode ?? 200,
                "headers": headers,
                "bodyB64": (data ?? Data()).base64EncodedString(),
            ])
        }
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        if let host = request.url?.host, Self.hostAllowed(host) {
            completionHandler(request)
        } else {
            // Refuse the redirect; the shim receives the 3xx status/headers instead of
            // silently forwarding credentials to an off-allowlist host.
            completionHandler(nil)
        }
    }

    static func hostAllowed(_ host: String) -> Bool {
        let h = host.lowercased()
        for a in allowHosts where h == a || h.hasSuffix("." + a) { return true }
        return false
    }

    private func reply(_ context: NSExtensionContext, _ payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
`;
  for (const h of handlers) writeFileSync(h, swift, "utf-8");
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
  // Search the whole Products dir, not just Release/: macOS lands the app in
  // "Release", but an iOS build puts it in the SDK-suffixed "Release-iphoneos"
  // sibling — a hardcoded "Release" path finds no .app for iOS, so the build
  // reads as failed. The name match below still prevents a wrong-platform bundle.
  const productsDir = join(derived, "Build", "Products");
  const apps = findFiles(productsDir, (n) => n.endsWith(".app"), 4);
  // Match the app we built by name; a multi-platform Products dir can hold several .app
  // bundles, and readdir order is not guaranteed, so [0] could be the wrong one — never
  // fall back to an arbitrary bundle (it could be the iOS app for a macOS build).
  const built = apps.find((p) => basename(p) === `${appName}.app`);
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
 *
 * Handles BOTH bundle layouts: a macOS app nests everything under `Contents/`
 * (Contents/Info.plist, Contents/PlugIns/Foo.appex/Contents/Info.plist); an iOS
 * `.app` is flat (Info.plist + PlugIns/Foo.appex/Info.plist at the root).
 * Detecting the layout per-bundle keeps iOS builds from spuriously failing — the
 * old macOS-only `Contents/` paths returned null for every iOS app, which
 * convert.ts then treats as a fatal bundle-id mismatch and aborts the build.
 */
export function verifyBuiltBundleId(appPath: string, bundleId: string): BundleVerification {
  const expectedAppId = bundleId;
  const expectedExtId = `${bundleId}.Extension`;
  // macOS bundles hold Info.plist under Contents/; iOS bundles are flat. Resolve
  // the dir that actually carries Info.plist for each bundle (app and appex).
  const plistDir = (base: string) =>
    existsSync(join(base, "Contents", "Info.plist")) ? join(base, "Contents") : base;
  const appDir = plistDir(appPath);
  const appId = plistValue(join(appDir, "Info.plist"), "CFBundleIdentifier");

  const appexes = findFiles(join(appDir, "PlugIns"), (n) => n.endsWith(".appex"), 1);
  const extId = appexes.length
    ? plistValue(join(plistDir(appexes[0]), "Info.plist"), "CFBundleIdentifier")
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
  // Boundary after the 10 chars so an over-long token isn't truncated into a
  // wrong 10-char id; a real Apple team id is exactly 10 alphanumerics.
  const ids = [...res.stdout.matchAll(/teamID\s*=\s*"?([A-Z0-9]{10})(?![A-Z0-9])"?/g)].map((m) => m[1]);
  return ids[0] ?? null;
}

/**
 * Sanitize a raw extension name into an app name. Strips whitespace plus path/scheme
 * separators — the result becomes a directory name, an xcodebuild scheme, and part of
 * the bundle id. Falls back to "Extension" when nothing survives.
 */
export function deriveAppName(rawName: string): string {
  return rawName.replace(/[\s/\\:]+/g, "") || "Extension";
}

export function defaultBundleId(appName: string): string {
  // Strip non-alphanumerics, then drop any leading digits: a CFBundleIdentifier
  // segment that starts with a digit (e.g. "123App") is rejected by parts of
  // Apple's toolchain.
  const slug = appName.replace(/[^A-Za-z0-9]/g, "").replace(/^[0-9]+/, "");
  // When nothing alphanumeric/Latin survives (all-symbol, all-digit, emoji-only,
  // or non-Latin names), a constant fallback would give every such extension the
  // SAME bundle id — LaunchServices then treats them as one app and the second
  // install shadows the first. Derive a stable per-name suffix from the original
  // name so distinct names stay distinct.
  const suffix = slug || "ext" + createHash("sha1").update(appName).digest("hex").slice(0, 8);
  return `com.viaduct.${suffix}`;
}
