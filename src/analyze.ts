import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Issue, Manifest, Platforms } from "./types.js";
import { UNSUPPORTED_APIS } from "./manifest.js";

function walkFiles(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith("__MACOSX")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, exts, acc);
    else if (exts.some((e) => entry.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Disk- and platform-aware checks that need the extension dir (not just the
 * manifest object): _locales/default_locale consistency, favicon access, and
 * iOS-specific distribution/UI caveats. Complements analyzeManifest().
 */
export function scanExtensionDir(extPath: string, manifest: Manifest, platforms: Platforms): Issue[] {
  const issues: Issue[] = [];

  // _locales dir present but no default_locale → Chrome AND Safari reject the load.
  if (existsSync(join(extPath, "_locales")) && !manifest.default_locale) {
    issues.push({
      severity: "error",
      category: "i18n",
      message: "_locales/ is present but default_locale is missing; the extension will fail to load.",
      file: "manifest.json",
      fix: "Add a default_locale key matching one of your _locales subfolders.",
    });
  }

  // _favicon / chrome://favicon has no Safari equivalent.
  for (const file of walkFiles(extPath, [".js", ".html", ".css"])) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (/chrome:\/\/favicon|[/'"]_favicon\//.test(content)) {
      const idx = content.search(/chrome:\/\/favicon|[/'"]_favicon\//);
      issues.push({
        severity: "warning",
        category: "api",
        message: "Favicon access via chrome://favicon / _favicon has no Safari equivalent.",
        file: relative(extPath, file),
        line: content.slice(0, idx).split("\n").length,
        fix: "Fetch favicons directly (e.g. <link> from the page) or drop the favicon UI.",
      });
      break; // one note is enough
    }
  }

  if (platforms === "ios" || platforms === "all") {
    issues.push({
      severity: "info",
      category: "ios",
      message: "Targeting iOS/iPadOS: popup/options UI must be responsive; side-by-side layouts break on small screens.",
      file: "manifest.json",
      fix: "Add responsive CSS; test in Safari on iOS. Distribution is App Store only (no dev-direct for end users).",
    });
    const platformGated = ["contextMenus", "notifications", "downloads", "cookies"].filter((p) =>
      [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].includes(p)
    );
    if (platformGated.length) {
      issues.push({
        severity: "info",
        category: "ios",
        message: `Some APIs (${platformGated.join(", ")}) behave differently or are gated on iOS.`,
        file: "manifest.json",
        fix: "Feature-detect and gate per platform; don't assume macOS parity on iOS.",
      });
    }
  }

  return issues;
}

function walkJs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry.startsWith("__MACOSX")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkJs(full, acc);
    else if (entry.endsWith(".js")) acc.push(full);
  }
  return acc;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Scan all JS files for Safari-unsupported API usage. */
export function scanJsFiles(extPath: string): Issue[] {
  const issues: Issue[] = [];
  for (const file of walkJs(extPath)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(extPath, file);

    for (const [api, info] of Object.entries(UNSUPPORTED_APIS)) {
      const pattern = api.replace(/\./g, "\\.");
      const re = new RegExp(pattern);
      const match = re.exec(content);
      if (match) {
        issues.push({
          severity: info.severity,
          category: "api",
          message: info.message,
          file: rel,
          line: lineOf(content, match.index),
          fix: info.fix,
        });
      }
    }

    if (/chrome\.webRequest\.on\w+/.test(content) && /\bblocking\b/.test(content)) {
      const idx = content.search(/chrome\.webRequest\.on\w+/);
      issues.push({
        severity: "error",
        category: "api",
        message: "Blocking webRequest detected; unsupported in Safari (and absent on iOS).",
        file: rel,
        line: lineOf(content, idx),
        fix: "Migrate to declarativeNetRequest rulesets.",
      });
    }

    if (/(setTimeout|setInterval)\s*\(/.test(content) && /(background|service[-_]?worker)/i.test(rel)) {
      const idx = content.search(/(setTimeout|setInterval)\s*\(/);
      issues.push({
        severity: "warning",
        category: "background",
        message: "setTimeout/setInterval are unreliable in suspended Safari background contexts.",
        file: rel,
        line: lineOf(content, idx),
        fix: "Use chrome.alarms for scheduled work; persist state to storage.local.",
      });
    }

    if (/(tabs\.connect|runtime\.onConnect)/.test(content)) {
      const idx = content.search(/(tabs\.connect|runtime\.onConnect)/);
      issues.push({
        severity: "warning",
        category: "safari18",
        message: "Safari 18: tabs.connect/onConnect fail for iframe ↔ content-script ports.",
        file: rel,
        line: lineOf(content, idx),
        fix: "Use contentWindow.postMessage from the page, then runtime.sendMessage from the iframe.",
      });
    }
  }
  return issues;
}
