import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Issue } from "./types.js";

export function loadManifest(extPath: string): Manifest {
  const p = join(extPath, "manifest.json");
  if (!existsSync(p)) throw new Error(`No manifest.json found in ${extPath}`);
  return JSON.parse(readFileSync(p, "utf-8")) as Manifest;
}

/**
 * Resolve a __MSG_key__ manifest value from _locales. Chrome substitutes these
 * at load time; the converter needs the literal text to derive the app name /
 * bundle id / output dir (otherwise they become "__MSG_extName___Safari").
 * Lookup order: default_locale, English variants, then any locale present.
 * Message names are case-insensitive, matching Chrome. Returns the input
 * unchanged when it is not a __MSG_ reference; undefined when unresolvable.
 */
export function resolveI18nString(value: string | undefined, extPath: string, defaultLocale?: string): string | undefined {
  if (!value) return value;
  const ref = /^__MSG_(.+?)__$/.exec(value);
  if (!ref) return value;
  const key = ref[1].toLowerCase();
  const localesDir = join(extPath, "_locales");
  if (!existsSync(localesDir)) return undefined;
  let available: string[] = [];
  try {
    available = readdirSync(localesDir);
  } catch {
    return undefined;
  }
  const preferred = [defaultLocale, "en", "en_US", "en_GB"].filter((l): l is string => !!l);
  const seen = new Set<string>();
  for (const loc of [...preferred, ...available]) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    const p = join(localesDir, loc, "messages.json");
    if (!existsSync(p)) continue;
    try {
      const msgs = JSON.parse(readFileSync(p, "utf-8")) as Record<string, { message?: string }>;
      for (const k of Object.keys(msgs)) {
        if (k.toLowerCase() === key) {
          const msg = msgs[k]?.message;
          if (typeof msg === "string" && msg.trim()) return msg.trim();
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Permissions Safari does not implement. Value = remediation note. */
export const UNSUPPORTED_PERMISSIONS: Record<string, string> = {
  identity: "Safari lacks chrome.identity; use a hosted web OAuth2 flow + window.postMessage.",
  debugger: "chrome.debugger (CDP) is unsupported; build a Web Inspector Extension (devtools_page).",
  sidePanel: "Safari has no sidePanel API; falling back to an action popup.",
  tabGroups: "Safari has no tabGroups API.",
  offscreen: "Safari has no offscreen documents API; use the service worker or web workers.",
  webRequestBlocking: "Blocking webRequest is unsupported; use declarativeNetRequest.",
  gcm: "chrome.gcm is Chrome-only; relay via APNs in the host app or poll with chrome.alarms.",
  tts: "Text-to-speech API unavailable; bridge to AVSpeechSynthesizer natively or use Web Speech API.",
  ttsEngine: "TTS engine API unavailable.",
  platformKeys: "platformKeys unavailable.",
  "enterprise.platformKeys": "enterprise.platformKeys unavailable.",
  // OS-capability APIs — route through the native container app or drop.
  tabCapture: "tabCapture is unsupported; use getDisplayMedia() or a native bridge.",
  desktopCapture: "desktopCapture is unsupported; use getDisplayMedia() or a native bridge.",
  pageCapture: "pageCapture is unsupported; drop or reimplement via a native bridge.",
  proxy: "chrome.proxy has no Safari equivalent; drop or configure proxy natively.",
  privacy: "chrome.privacy has no Safari equivalent; drop.",
  contentSettings: "chrome.contentSettings has no Safari equivalent; drop.",
  browsingData: "chrome.browsingData has no Safari equivalent; drop.",
  management: "chrome.management has no Safari equivalent; drop or move to the native host app.",
  power: "chrome.power has no Safari equivalent; use IOKit natively or drop.",
  "system.cpu": "chrome.system.cpu has no Safari equivalent; native bridge or drop.",
  "system.memory": "chrome.system.memory has no Safari equivalent; native bridge or drop.",
  "system.storage": "chrome.system.storage has no Safari equivalent; native bridge or drop.",
  "system.display": "chrome.system.display has no Safari equivalent; native bridge or drop.",
  // Chrome-UI APIs — no Safari surface; reshape to popup/page or drop.
  omnibox: "Safari has no address-bar keyword API; drop the omnibox feature.",
  sessions: "chrome.sessions is unsupported; shim returns empty results.",
  topSites: "chrome.topSites is unsupported; shim returns an empty list.",
  search: "chrome.search is unsupported; shim opens queries in a search-engine tab.",
  declarativeContent: "declarativeContent rules never fire in Safari; use content scripts + chrome.action.",
  userScripts: "chrome.userScripts is unsupported; declare content scripts statically or use chrome.scripting.",
  idle: "chrome.idle is unsupported; shim derives state from page visibility.",
  instanceID: "instanceID push plumbing is Chrome-only; use APNs natively or poll.",
  // ChromeOS-only APIs — always drop on Safari.
  fileBrowserHandler: "fileBrowserHandler is ChromeOS-only; drop.",
  fileSystemProvider: "fileSystemProvider is ChromeOS-only; drop.",
  documentScan: "documentScan is ChromeOS-only; drop.",
  printerProvider: "printerProvider is ChromeOS/print-only; drop or move to a native bridge.",
  printing: "chrome.printing is ChromeOS-only; drop.",
  printingMetrics: "chrome.printingMetrics is ChromeOS-only; drop.",
  certificateProvider: "certificateProvider is ChromeOS-enterprise-only; drop.",
  vpnProvider: "vpnProvider is ChromeOS-only; use a Network Extension natively or drop.",
  wallpaper: "chrome.wallpaper is ChromeOS-only; drop.",
  loginScreenStorage: "loginScreenStorage is ChromeOS-kiosk-only; drop.",
  webAuthenticationProxy: "webAuthenticationProxy is enterprise-only; drop.",
  accessibilityFeatures: "accessibilityFeatures has no Safari equivalent; drop.",
  fontSettings: "fontSettings has no Safari equivalent; drop.",
};

/** chrome.* API call patterns flagged during JS scans. */
export const UNSUPPORTED_APIS: Record<string, { severity: Issue["severity"]; message: string; fix: string }> = {
  "chrome.identity.launchWebAuthFlow": {
    severity: "warning",
    message: "launchWebAuthFlow is unsupported and safari-web-extension:// redirects are blocked.",
    fix: "Open hosted auth in a tab, redirect to your own HTTPS callback, postMessage the code back.",
  },
  "chrome.identity": {
    severity: "warning",
    message: "chrome.identity is unsupported in Safari (all platforms).",
    fix: "Replace with a hosted OAuth2 redirect flow; shim stubs it so calls reject instead of throwing.",
  },
  "chrome.debugger": {
    severity: "warning",
    message: "chrome.debugger (Chrome DevTools Protocol) is unsupported.",
    fix: "Build a Safari Web Inspector Extension via the devtools_page manifest key.",
  },
  "chrome.gcm": {
    severity: "warning",
    message: "chrome.gcm push messaging is Chrome-only.",
    fix: "Use APNs in the native host app, or poll via chrome.alarms + fetch.",
  },
  "chrome.notifications": {
    severity: "warning",
    message: "chrome.notifications is missing in Safari.",
    fix: "Bridge to native notifications via sendNativeMessage, or inject a DOM banner.",
  },
  "chrome.contextMenus": {
    severity: "warning",
    message: "chrome.contextMenus is unsupported on Safari iOS.",
    fix: "Register a 'contextmenu' listener in a content script and relay via runtime.sendMessage.",
  },
  "cookies.onChanged": {
    severity: "warning",
    message: "cookies.onChanged is unsupported.",
    fix: "Poll cookies, or monitor session state from a content script.",
  },
  "runtime.setUninstallURL": {
    severity: "warning",
    message: "runtime.setUninstallURL is unsupported.",
    fix: "Remove or guard behind feature detection.",
  },
  "tabs.move": { severity: "warning", message: "tabs.move is unsupported.", fix: "Remove or rework UX." },
  "tabs.highlighted": {
    severity: "warning",
    message: "tabs.highlighted query is unsupported.",
    fix: "Use tabs.query({ active: true }).",
  },
  "webNavigation.onCreatedNavigationTarget": {
    severity: "warning",
    message: "webNavigation.onCreatedNavigationTarget is unsupported.",
    fix: "Use webNavigation.onCommitted.",
  },
  "webNavigation.onHistoryStateUpdated": {
    severity: "warning",
    message: "webNavigation.onHistoryStateUpdated is unsupported.",
    fix: "Monitor history changes from a content script.",
  },
  "chrome.tts\\b": {
    severity: "warning",
    message: "chrome.tts (text-to-speech) is unsupported in Safari.",
    fix: "Use the Web Speech API (speechSynthesis), or bridge to AVSpeechSynthesizer in the native host.",
  },
  "chrome.ttsEngine": {
    severity: "warning",
    message: "chrome.ttsEngine is unsupported in Safari.",
    fix: "Provide TTS via the native host (AVSpeechSynthesizer); there is no Safari TTS-engine API.",
  },
  "chrome.tabCapture": {
    severity: "warning",
    message: "chrome.tabCapture is unsupported in Safari.",
    fix: "Use navigator.mediaDevices.getDisplayMedia(), or a native bridge.",
  },
  "chrome.desktopCapture": {
    severity: "warning",
    message: "chrome.desktopCapture is unsupported in Safari.",
    fix: "Use navigator.mediaDevices.getDisplayMedia(), or a native bridge.",
  },
  "chrome.pageCapture": {
    severity: "warning",
    message: "chrome.pageCapture is unsupported in Safari.",
    fix: "Reconstruct via content-script DOM serialization, or drop.",
  },
  "chrome.proxy": {
    severity: "warning",
    message: "chrome.proxy has no Safari equivalent.",
    fix: "Configure proxying natively (Network Extension) or drop the feature.",
  },
  "chrome.privacy": {
    severity: "warning",
    message: "chrome.privacy has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.contentSettings": {
    severity: "warning",
    message: "chrome.contentSettings has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.browsingData": {
    severity: "warning",
    message: "chrome.browsingData has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.management": {
    severity: "warning",
    message: "chrome.management has no Safari equivalent.",
    fix: "Remove, or move management logic to the native host app.",
  },
  "chrome.power": {
    severity: "warning",
    message: "chrome.power has no Safari equivalent.",
    fix: "Use IOKit in the native host, or drop wake-lock behavior.",
  },
  "chrome.system": {
    severity: "warning",
    message: "chrome.system.* (cpu/memory/storage/display) has no Safari equivalent.",
    fix: "Route through a native bridge, or drop.",
  },
  "chrome.omnibox": {
    severity: "warning",
    message: "chrome.omnibox has no Safari equivalent (no address-bar keyword).",
    fix: "Drop the omnibox feature; expose the action via the popup instead.",
  },
  "chrome.fontSettings": {
    severity: "warning",
    message: "chrome.fontSettings has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.accessibilityFeatures": {
    severity: "warning",
    message: "chrome.accessibilityFeatures has no Safari equivalent.",
    fix: "Remove or guard behind feature detection.",
  },
  "chrome.readingList": {
    severity: "warning",
    message: "chrome.readingList has no JS API in Safari (native Reading List only).",
    fix: "Bridge through the native host, or drop.",
  },
  "chrome.sessions": {
    severity: "info",
    message: "chrome.sessions has no Safari equivalent; shim returns empty results.",
    fix: "Feature-detect; hide recently-closed UI on Safari.",
  },
  "chrome.topSites": {
    severity: "info",
    message: "chrome.topSites has no Safari equivalent; shim returns an empty list.",
    fix: "Feature-detect; hide top-sites UI on Safari.",
  },
  "chrome.declarativeContent": {
    severity: "warning",
    message: "chrome.declarativeContent rules never fire in Safari (shim stubs the constructors).",
    fix: "Use content scripts + chrome.action instead of declarative page rules.",
  },
  "chrome.search\\b": {
    severity: "info",
    message: "chrome.search has no Safari equivalent; shim opens the query in a search-engine tab.",
    fix: "Acceptable fallback for most flows; otherwise open a search URL yourself.",
  },
  "chrome.userScripts": {
    severity: "warning",
    message: "chrome.userScripts is unsupported in Safari; registration rejects.",
    fix: "Statically declare content scripts, or inject via chrome.scripting.",
  },
  "chrome.idle": {
    severity: "info",
    message: "chrome.idle is unsupported; shim derives state from page visibility.",
    fix: "Don't rely on machine-level idle detection on Safari.",
  },
  "chrome.instanceID": {
    severity: "warning",
    message: "chrome.instanceID (push plumbing) is Chrome-only; calls reject.",
    fix: "Use APNs via the native host, or poll with chrome.alarms.",
  },
  "chrome.bookmarks": {
    severity: "info",
    message: "chrome.bookmarks is limited/gated in Safari.",
    fix: "Verify availability + permission; feature-detect and degrade.",
  },
  "chrome.history": {
    severity: "info",
    message: "chrome.history is limited in Safari.",
    fix: "Verify availability; feature-detect and degrade.",
  },
  "chrome.downloads": {
    severity: "info",
    message: "chrome.downloads is only partially supported in Safari.",
    fix: "Test the flow; fall back to an <a download> link if unavailable.",
  },
};

export interface ManifestAnalysis {
  issues: Issue[];
  permissionsToRemove: string[];
}

export function analyzeManifest(m: Manifest): ManifestAnalysis {
  const issues: Issue[] = [];
  const permissionsToRemove: string[] = [];
  const allPerms = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];

  // Set-dedupe: a permission listed in BOTH permissions and optional_permissions
  // would otherwise produce two identical issues.
  for (const perm of new Set(allPerms)) {
    if (perm in UNSUPPORTED_PERMISSIONS) {
      issues.push({
        severity: "warning",
        category: "permission",
        message: `Unsupported permission "${perm}" will be removed.`,
        file: "manifest.json",
        fix: UNSUPPORTED_PERMISSIONS[perm],
        autoFixed: true,
      });
      permissionsToRemove.push(perm);
    }
  }

  if (m.update_url) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "update_url ignored by Safari (App Store updates only); removing.",
      file: "manifest.json",
      autoFixed: true,
    });
  }
  if (m.version && m.version.split(".").length > 3) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: `4-part version "${m.version}" exceeds Apple's 3-part CFBundleShortVersionString; truncating.`,
      file: "manifest.json",
      autoFixed: true,
    });
  }
  if (m.version_name) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "version_name has no Safari/App Store meaning; removing.",
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const csp =
    typeof m.content_security_policy === "string"
      ? m.content_security_policy
      : Object.values(m.content_security_policy ?? {}).join(" ");
  if (csp.includes("unsafe-eval")) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "CSP allows 'unsafe-eval'; Safari rejects eval in extension contexts regardless.",
      file: "manifest.json",
      fix: "Remove eval()/new Function usage; precompile templates or use JSON.parse.",
    });
  }

  if (m.minimum_chrome_version) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "minimum_chrome_version is meaningless for Safari; removing.",
      file: "manifest.json",
      autoFixed: true,
    });
  }

  const mv = m.manifest_version ?? 2;
  if (mv === 2 && m.background && m.background.persistent !== false) {
    issues.push({
      severity: "error",
      category: "background",
      message: "MV2 persistent background is unsupported; setting persistent:false.",
      file: "manifest.json",
      fix: "Prefer migrating to an MV3 service worker.",
      autoFixed: true,
    });
  }

  if (mv === 3 && m.background?.type === "module") {
    issues.push({
      severity: "warning",
      category: "background",
      message: 'background.type:"module" causes silent popup failures on Safari/TestFlight.',
      file: "manifest.json",
      fix: "Removing type:module (use --keep-module to preserve).",
      autoFixed: true,
    });
  }

  const action = m.action ?? m.browser_action;
  if (!action?.default_popup) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "Action has no default_popup; the toolbar button would be inert in Safari.",
      file: "manifest.json",
      fix: "Auto-wiring a detected popup/sidepanel HTML as default_popup.",
      autoFixed: true,
    });
  }

  if (m.externally_connectable?.ids?.length) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "externally_connectable by extension IDs is unsupported in Safari.",
      file: "manifest.json",
      fix: "Use matches for web-page messaging; ID-based connections will not resolve.",
    });
  }

  if (allPerms.includes("storage")) {
    issues.push({
      severity: "info",
      category: "storage",
      message: "storage.sync does NOT sync across iCloud devices in Safari (maps to local).",
      file: "manifest.json",
      fix: "Shim routes sync→local; implement custom cloud sync if cross-device is required.",
    });
  }

  if (m.commands && Object.keys(m.commands).length > 0) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "Keyboard commands are only partially supported in Safari; some chords are unavailable.",
      file: "manifest.json",
      fix: "Verify each shortcut in Safari → Settings → Extensions; provide an in-UI fallback.",
    });
  }

  if (m.chrome_url_overrides?.newtab) {
    issues.push({
      severity: "warning",
      category: "ui",
      message: "chrome_url_overrides.newtab has gaps in Safari and behaves inconsistently per platform.",
      file: "manifest.json",
      fix: "Test the new-tab override on macOS and iOS; consider dropping it if unreliable.",
    });
  }
  for (const k of Object.keys(m.chrome_url_overrides ?? {})) {
    if (k !== "newtab") {
      issues.push({
        severity: "warning",
        category: "ui",
        message: `chrome_url_overrides.${k} is not supported in Safari.`,
        file: "manifest.json",
        fix: "Remove the override; Safari only partially honors newtab.",
      });
    }
  }

  if (m.devtools_page) {
    issues.push({
      severity: "warning",
      category: "ui",
      message: "devtools_page panels use a different surface in Safari (Web Inspector Extensions).",
      file: "manifest.json",
      fix: "Reimplement DevTools panels via Safari Web Inspector extension APIs, or drop.",
    });
  }

  const hosts = [...(m.host_permissions ?? []), ...(m.permissions ?? [])];
  if (hosts.some((h) => h === "<all_urls>" || h === "*://*/*" || h === "http://*/*" || h === "https://*/*")) {
    issues.push({
      severity: "info",
      category: "permission",
      message: "Broad host access (<all_urls>): Safari asks the user per-site and defaults to 'Ask'.",
      file: "manifest.json",
      fix: "Expect degraded behavior until the user grants access; handle permission denials gracefully.",
    });
  }

  if (!m.icons || Object.keys(m.icons).length === 0) {
    issues.push({
      severity: "info",
      category: "ui",
      message: "No icons in the manifest; Safari shows a generic placeholder in the toolbar and Settings.",
      file: "manifest.json",
      fix: "Add at least 48px/96px (and 128px for the App Store) PNG icons under the icons key.",
    });
  }

  if (m.incognito) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: `incognito:"${m.incognito}" maps to Safari Private Browsing (off by default; user opts in per extension).`,
      file: "manifest.json",
      fix: "Don't rely on split-process isolation; assume spanning-like and re-test state separation.",
    });
  }

  return { issues, permissionsToRemove };
}

/** Produce the Safari-ready manifest. Pure: does not write to disk. */
export function transformManifest(
  m: Manifest,
  permissionsToRemove: string[],
  extPath: string,
  opts: { keepModuleBackground: boolean; shimFile?: string; polyfillFile?: string }
): Manifest {
  const out: Manifest = JSON.parse(JSON.stringify(m));

  delete out.update_url;
  delete out.key;
  delete out.minimum_chrome_version;
  delete out.version_name;

  if (out.version) {
    const parts = out.version.split(".");
    if (parts.length > 3) out.version = parts.slice(0, 3).join(".");
  }

  const removeSet = new Set(permissionsToRemove);
  if (out.permissions) out.permissions = out.permissions.filter((p) => !removeSet.has(p));
  if (out.optional_permissions) {
    out.optional_permissions = out.optional_permissions.filter((p) => !removeSet.has(p));
    if (out.optional_permissions.length === 0) delete out.optional_permissions;
  }

  const mv = out.manifest_version ?? 2;
  if (mv === 2 && out.background) {
    out.background.persistent = false;
  }
  if (mv === 3 && out.background?.type === "module" && !opts.keepModuleBackground) {
    delete out.background.type;
  }

  out.browser_specific_settings = {
    ...(out.browser_specific_settings ?? {}),
    safari: { strict_min_version: "15.4" },
  };

  // Ensure the toolbar button does something: wire a popup if one exists.
  const actionKey = out.action ? "action" : out.browser_action ? "browser_action" : "action";
  const action = (out[actionKey] as Manifest["action"]) ?? {};
  if (!action.default_popup) {
    for (const candidate of ["popup.html", "sidepanel.html", "panel.html", "index.html"]) {
      if (existsSync(join(extPath, candidate))) {
        action.default_popup = candidate;
        break;
      }
    }
  }
  // Don't inject an empty action onto extensions that never had a toolbar button.
  if (Object.keys(action).length > 0) out[actionKey] = action;

  // Prepend the compat shim to every content script so sync/identity/sidePanel are
  // patched. Then prepend the polyfill so `browser` exists before the shim runs —
  // final order per script: [polyfill, shim, ...original].
  if ((opts.shimFile || opts.polyfillFile) && Array.isArray(out.content_scripts)) {
    for (const cs of out.content_scripts) {
      if (!Array.isArray(cs.js)) continue;
      if (opts.shimFile && !cs.js.includes(opts.shimFile)) cs.js.unshift(opts.shimFile);
      if (opts.polyfillFile && !cs.js.includes(opts.polyfillFile)) cs.js.unshift(opts.polyfillFile);
    }
  }

  return out;
}

export function writeManifest(targetDir: string, manifest: Manifest): void {
  writeFileSync(join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}
