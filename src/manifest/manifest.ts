import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest, Issue } from "../types.js";

/**
 * Parse JSON that may carry // and /* *\/ comments or trailing commas — both are
 * illegal in strict JSON but common in hand-edited Chrome manifests (Chrome's own
 * loader tolerates comments). A single character-state scan skips comment runs and
 * trailing commas WITHOUT touching their look-alikes inside string literals (e.g.
 * the "//" in an "https://…" URL), then hands clean JSON to JSON.parse.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n"; // preserve line numbering for parse errors
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/', loop's i++ steps past it
      continue;
    }
    if (c === ",") {
      // Trailing comma? Peek past whitespace AND any comments; drop the comma when
      // the next significant character closes an object/array. Done in-scanner (not
      // a post-regex) so a "," inside a string literal is never affected.
      let j = i + 1;
      while (j < text.length) {
        const d = text[j];
        if (d === " " || d === "\t" || d === "\r" || d === "\n") j++;
        else if (d === "/" && text[j + 1] === "/") {
          j += 2;
          while (j < text.length && text[j] !== "\n") j++;
        } else if (d === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j += 2;
        } else break;
      }
      if (text[j] === "}" || text[j] === "]") continue; // skip trailing comma
    }
    out += c;
  }
  return JSON.parse(out) as T;
}

export function loadManifest(extPath: string): Manifest {
  const p = join(extPath, "manifest.json");
  if (!existsSync(p)) throw new Error(`No manifest.json found in ${extPath}`);
  return parseJsonc<Manifest>(readFileSync(p, "utf-8"));
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
      const msgs = parseJsonc<Record<string, { message?: string }>>(readFileSync(p, "utf-8"));
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

// Compatibility data tables live in compat-data.ts; imported for internal use
// and re-exported so existing importers (analyze.ts, report.ts) keep their path.
import { UNSUPPORTED_PERMISSIONS, SHIMMED_PERMISSIONS, UNSUPPORTED_APIS } from "./compat-data.js";
export { UNSUPPORTED_PERMISSIONS, SHIMMED_PERMISSIONS, UNSUPPORTED_APIS };

export interface ManifestAnalysis {
  issues: Issue[];
  permissionsToRemove: string[];
}

const MATCH_SCHEMES = new Set(["http", "https", "*", "file", "ftp"]);

/**
 * Validate a Chrome match pattern (https://developer.chrome.com/docs/extensions/mv3/match_patterns/).
 * Chrome only warns on a bad pattern, but Safari silently drops the entire
 * content script that contains it — so a malformed entry must surface as an
 * error before conversion. Returns null when valid, else a short reason.
 */
export function matchPatternError(pattern: string): string | null {
  if (pattern === "<all_urls>") return null;
  const m = /^(\*|https?|file|ftp):\/\/(.*)$/.exec(pattern);
  if (!m) return "missing or unsupported scheme (expected http/https/file/ftp/*://)";
  const scheme = m[1];
  if (!MATCH_SCHEMES.has(scheme)) return `unsupported scheme "${scheme}"`;
  const rest = m[2];

  // file:// is host-less, but Chrome accepts an optional "*" host placeholder
  // before the path (e.g. "file://*/*" is extremely common). Strip a leading
  // "*" so both "file:///path" (empty host) and "file://*/path" validate.
  if (scheme === "file") {
    const path = rest.startsWith("*") ? rest.slice(1) : rest;
    return path.startsWith("/") ? null : "file:// pattern path must start with '/'";
  }

  const slash = rest.indexOf("/");
  if (slash === -1) return "missing path (a match pattern must end with a path, e.g. '/*')";
  const host = rest.slice(0, slash);
  if (host === "") return "empty host";
  // '*' alone, or '*.' prefix, are the only legal wildcard host forms.
  if (host !== "*") {
    const body = host.startsWith("*.") ? host.slice(2) : host;
    if (body.includes("*")) return `host "${host}" may only use '*' as a full or leftmost-label wildcard`;
    if (body === "") return "empty host after '*.'";
  }
  return null;
}

/**
 * Validate manifest `commands` for Safari. Chrome and Safari both expect each
 * suggested_key chord to be `Modifier+[Modifier+]Key`, but Safari is stricter:
 * - A chord with NO modifier (or only Shift) is rejected — Chrome allows a few
 *   media keys bare, Safari does not register them and the command silently has
 *   no shortcut.
 * - Safari recognizes Ctrl/Command/Alt(Option)/MacCtrl/Shift; Chrome's "Search"
 *   modifier (ChromeOS) has no Safari equivalent.
 * Reserved commands (_execute_action etc.) are allowed and skipped.
 */
const COMMAND_MODIFIERS = new Set(["Ctrl", "Command", "Alt", "Option", "MacCtrl", "Shift"]);

export function analyzeCommands(commands: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  for (const [name, def] of Object.entries(commands)) {
    const suggested = (def as { suggested_key?: unknown } | undefined)?.suggested_key;
    if (suggested === undefined) continue; // user can still bind it manually in Safari
    // suggested_key is either a string (all platforms) or a per-platform map.
    const chords =
      typeof suggested === "string"
        ? [suggested]
        : Object.values(suggested as Record<string, unknown>).filter((v): v is string => typeof v === "string");
    for (const chord of chords) {
      const parts = chord.split("+").map((p) => p.trim());
      const key = parts.pop();
      const mods = parts;
      const hasPrimaryModifier = mods.some((mo) => mo === "Ctrl" || mo === "Command" || mo === "Alt" || mo === "Option" || mo === "MacCtrl");
      if (!key || !hasPrimaryModifier) {
        issues.push({
          severity: "warning",
          category: "ui",
          message: `commands.${name} shortcut "${chord}" lacks a Ctrl/Command/Alt modifier; Safari ignores it and the command gets no shortcut.`,
          file: "manifest.json",
          fix: "Use a chord like Command+Shift+Y; Safari requires a primary modifier (Shift-only is not enough).",
        });
      }
      const unknownMod = mods.find((mo) => !COMMAND_MODIFIERS.has(mo));
      if (unknownMod) {
        issues.push({
          severity: "warning",
          category: "ui",
          message: `commands.${name} uses modifier "${unknownMod}" which Safari does not support.`,
          file: "manifest.json",
          fix: "Use Ctrl/Command/Alt/Option/MacCtrl/Shift; ChromeOS-only modifiers (e.g. Search) have no Safari equivalent.",
        });
      }
    }
  }
  return issues;
}

export function analyzeManifest(m: Manifest): ManifestAnalysis {
  const issues: Issue[] = [];
  const permissionsToRemove: string[] = [];
  const allPerms = [
    ...(Array.isArray(m.permissions) ? m.permissions : []),
    ...(Array.isArray(m.optional_permissions) ? m.optional_permissions : []),
  ];

  // Bad match patterns make Safari silently drop the whole content script.
  // Guard against a malformed manifest where these aren't arrays/strings — Chrome
  // rejects such a manifest, but the converter must report rather than crash.
  const contentScripts = Array.isArray(m.content_scripts) ? m.content_scripts : [];
  contentScripts.forEach((cs, i) => {
    const matches = Array.isArray(cs?.matches) ? cs.matches : [];
    for (const pat of matches) {
      if (typeof pat !== "string") continue;
      const err = matchPatternError(pat);
      if (err) {
        issues.push({
          severity: "error",
          category: "content_scripts",
          message: `Invalid match pattern "${pat}" in content_scripts[${i}]: ${err}.`,
          file: "manifest.json",
          fix: "Safari drops the entire content script for one bad pattern; correct or remove it.",
        });
      }
    }
    // world:"MAIN" injects into the page's JS context. Safari only added support in
    // 18.4; on earlier versions the script silently does not run, and it never has
    // access to chrome.* — a common source of "works in Chrome, dead in Safari".
    if (cs?.world === "MAIN") {
      issues.push({
        severity: "warning",
        category: "content_scripts",
        message: `content_scripts[${i}] uses world:"MAIN"; supported only on Safari 18.4+ and has no chrome.* access.`,
        file: "manifest.json",
        fix: "Provide an ISOLATED-world fallback, or feature-detect and degrade on older Safari.",
      });
    }
  });

  // Set-dedupe: a permission listed in BOTH permissions and optional_permissions
  // would otherwise produce two identical issues.
  for (const perm of new Set(allPerms)) {
    if (perm in UNSUPPORTED_PERMISSIONS) {
      const shimmed = SHIMMED_PERMISSIONS.has(perm);
      issues.push({
        severity: "warning",
        category: "permission",
        message: shimmed
          ? `Permission "${perm}" is removed (Safari rejects it), but the shim emulates the API so it keeps working.`
          : `Unsupported permission "${perm}" will be removed.`,
        file: "manifest.json",
        fix: UNSUPPORTED_PERMISSIONS[perm],
        autoFixed: true,
        shimmed,
      });
      permissionsToRemove.push(perm);
    }
  }

  // Under MV3, URL match patterns belong in host_permissions, not permissions.
  // A pattern left in permissions is legal MV2 but SILENTLY IGNORED under MV3 —
  // Safari (and Chrome MV3) grant no host access, so the extension "works in the
  // old build, breaks after migration". Flag each misplaced entry; it's a likely
  // bug the converter won't auto-move (intent is ambiguous).
  if ((m.manifest_version ?? 2) === 3) {
    const fields: Array<["permissions" | "optional_permissions", "host_permissions" | "optional_host_permissions"]> = [
      ["permissions", "host_permissions"],
      ["optional_permissions", "optional_host_permissions"],
    ];
    for (const [src, dest] of fields) {
      const declared = Array.isArray(m[src]) ? (m[src] as unknown[]) : [];
      for (const perm of declared) {
        if (typeof perm !== "string") continue;
        const looksLikeHost = perm === "<all_urls>" || perm.includes("://");
        if (looksLikeHost && !(perm in UNSUPPORTED_PERMISSIONS)) {
          issues.push({
            severity: "warning",
            category: "permission",
            message: `"${perm}" is a host match pattern in "${src}"; under MV3 it is ignored and grants no host access.`,
            file: "manifest.json",
            fix: `Move it into "${dest}" (MV3 requires URL patterns there, not in "${src}").`,
          });
        }
      }
    }
  }

  if (!m.description || (typeof m.description === "string" && !m.description.trim())) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "No description in the manifest; the App Store requires one for submission.",
      file: "manifest.json",
      fix: "Add a short description; Safari shows it in Settings → Extensions and the App Store needs it.",
    });
  }

  if (m.key) {
    issues.push({
      severity: "info",
      category: "manifest",
      message: "key (Chrome CRX packing identity) has no meaning for Safari; removing.",
      file: "manifest.json",
      fix: "Safari derives extension identity from the bundle id; the key field is dropped.",
      autoFixed: true,
    });
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
  if (!m.version || (typeof m.version === "string" && !m.version.trim())) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "No version in the manifest; Apple requires a CFBundleShortVersionString and the build will fail.",
      file: "manifest.json",
      fix: 'Add a numeric "version" (e.g. "1.0.0") to the manifest.',
    });
  } else if (typeof m.version === "string") {
    // Apple's CFBundleShortVersionString (like Chrome) needs dot-separated
    // non-negative integers, each 0–65535. A part like "beta" or "1-rc1" loads
    // in Chrome from an unpacked dir but fails the Xcode build with an opaque
    // error, so surface it up front.
    const parts = m.version.split(".");
    const badPart = parts.find((p) => !/^\d+$/.test(p) || Number(p) > 65535);
    if (badPart !== undefined) {
      issues.push({
        severity: "warning",
        category: "manifest",
        message: `version "${m.version}" has a non-numeric/out-of-range part ("${badPart}"); Apple requires integer parts (0–65535) and the build will fail.`,
        file: "manifest.json",
        fix: 'Use a numeric dotted version like "1.2.3" (no suffixes such as -rc1 or +build).',
      });
    } else if (parts.length > 3) {
      issues.push({
        severity: "info",
        category: "manifest",
        message: `4-part version "${m.version}" exceeds Apple's 3-part CFBundleShortVersionString; truncating.`,
        file: "manifest.json",
        autoFixed: true,
      });
    }
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

  // Only the extension_pages policy governs the extension's own pages/SW; the
  // sandbox policy intentionally relaxes rules for sandboxed iframes, so scanning
  // it for "remote script-src" would false-flag legitimate sandbox allowances.
  // A bare string is the MV2 form, which maps to extension_pages.
  const cspObj = m.content_security_policy;
  const csp =
    typeof cspObj === "string"
      ? cspObj
      : (cspObj?.extension_pages ?? "");
  if (csp.includes("unsafe-eval")) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: "CSP allows 'unsafe-eval'; Safari rejects eval in extension contexts regardless.",
      file: "manifest.json",
      fix: "Remove eval()/new Function usage; precompile templates or use JSON.parse.",
    });
  }

  // A script-src/script-src-elem directive that whitelists a remote origin (a
  // hosted CDN, etc.) means the extension loads code from the network. Safari
  // forbids remote script in extension pages and the App Store review rejects it.
  const scriptSrc = /(?:^|;)\s*script-src(?:-elem)?\s+([^;]+)/gi;
  const remoteSrc = new Set<string>();
  for (const dm of csp.matchAll(scriptSrc)) {
    for (const token of dm[1].trim().split(/\s+/)) {
      // A bare "*" (or scheme-wildcard like https://*) whitelists the whole network.
      if (token === "*" || /^(https?:|\/\/|wss?:|\*:)/i.test(token) || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?$/i.test(token)) {
        remoteSrc.add(token);
      }
    }
  }
  if (remoteSrc.size > 0) {
    issues.push({
      severity: "warning",
      category: "manifest",
      message: `CSP script-src allows remote origin(s) (${[...remoteSrc].join(", ")}); Safari blocks remote scripts and the App Store rejects them.`,
      file: "manifest.json",
      fix: "Bundle the script into the extension and load it locally; remove remote script-src entries.",
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
      severity: "warning",
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

  const action = m.action ?? m.browser_action ?? m.page_action;
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

  // Surfaced from the permission too (not just JS) because native-messaging calls
  // are often in minified bundles the source scanner attributes imprecisely.
  if (allPerms.includes("nativeMessaging")) {
    issues.push({
      severity: "warning",
      category: "permission",
      message: "nativeMessaging works differently in Safari: there is no native-messaging-hosts manifest or host binary.",
      file: "manifest.json",
      fix: "Route messages to the containing macOS app's SafariWebExtensionHandler (beginRequest); the permission stays but the host model changes.",
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
    for (const issue of analyzeCommands(m.commands)) issues.push(issue);
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

  const hosts = [
    ...(Array.isArray(m.host_permissions) ? m.host_permissions : []),
    ...(Array.isArray(m.permissions) ? m.permissions : []),
  ];
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
      message: "No icons in the manifest; synthesizing a solid-color placeholder set (48/128/256/512px).",
      file: "manifest.json",
      fix: "Replace with real PNG icons for production; the placeholder only avoids a blank toolbar glyph.",
      autoFixed: true,
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

/**
 * Collect every concrete file path the manifest references as a runtime asset
 * (scripts, pages, css, icons, web_accessible_resources, DNR rulesets, …),
 * normalized to forward-slash relative paths. Glob/wildcard resource entries
 * (containing '*') are skipped — only literal paths are returned. Used by the
 * stager so a declared resource is never dropped as "dev cruft" (e.g. a
 * web-accessible LICENSE.txt or a .map served to a page), which would 404 at
 * runtime in Safari.
 */
export function collectReferencedPaths(m: Manifest): Set<string> {
  const paths = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p === "string" && p && !p.includes("*")) {
      // Drop any #fragment/?query (e.g. "devpanel.html#popup") so the concrete
      // file on disk is preserved during staging, not a phantom "…#popup" name.
      const filePart = p.split(/[#?]/)[0];
      if (filePart) paths.add(filePart.replace(/^\.?\//, "").replace(/\\/g, "/"));
    }
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  for (const cs of arr(m.content_scripts) as Array<{ js?: unknown; css?: unknown }>) {
    for (const j of arr(cs?.js)) add(j);
    for (const c of arr(cs?.css)) add(c);
  }
  for (const b of arr(m.background?.scripts)) add(b);
  add(m.background?.service_worker);
  add(m.background?.page);
  for (const a of [m.action, m.browser_action, m.page_action]) {
    add((a as { default_popup?: unknown } | undefined)?.default_popup);
    const di = (a as { default_icon?: unknown } | undefined)?.default_icon;
    if (typeof di === "string") add(di);
    else if (di && typeof di === "object") for (const p of Object.values(di)) add(p);
  }
  for (const p of Object.values(m.icons ?? {})) add(p);
  add(m.options_page);
  add(m.options_ui?.page);
  add(m.devtools_page);
  for (const p of Object.values(m.chrome_url_overrides ?? {})) add(p);
  for (const p of arr(m.sandbox?.pages)) add(p);
  for (const r of m.declarative_net_request?.rule_resources ?? []) add(r?.path);
  // side_panel.default_path: the shim opens this page at runtime (see shim.ts),
  // so a miss here drops the panel HTML and open() 404s in Safari.
  add((m as { side_panel?: { default_path?: unknown } }).side_panel?.default_path);
  add((m as { sidebar_action?: { default_panel?: unknown } }).sidebar_action?.default_panel);
  add((m as { storage?: { managed_schema?: unknown } }).storage?.managed_schema);

  // web_accessible_resources: MV2 string[] or MV3 [{resources: string[]}].
  for (const entry of arr(m.web_accessible_resources)) {
    if (typeof entry === "string") add(entry);
    else for (const r of arr((entry as { resources?: unknown })?.resources)) add(r);
  }
  return paths;
}

/** Produce the Safari-ready manifest. Pure: does not write to disk. */
export function transformManifest(
  m: Manifest,
  permissionsToRemove: string[],
  extPath: string,
  opts: { keepModuleBackground: boolean; shimFile?: string; polyfillFile?: string; minSafariVersion?: string }
): Manifest {
  const out: Manifest = JSON.parse(JSON.stringify(m));

  delete out.update_url;
  delete out.key;
  delete out.minimum_chrome_version;
  delete out.version_name;

  if (out.version) {
    // Safari/Xcode require dot-separated integers (max 3 components, each ≤ 65535).
    // Keep leading numeric parts and stop at the first non-numeric one; if nothing
    // usable remains, fall back to 1.0.0 rather than writing a manifest that fails the build.
    const numeric: string[] = [];
    for (const p of out.version.split(".")) {
      if (!/^\d+$/.test(p)) break;
      numeric.push(String(Math.min(Number(p), 65535)));
      if (numeric.length === 3) break;
    }
    out.version = numeric.length ? numeric.join(".") : "1.0.0";
  }

  const removeSet = new Set(permissionsToRemove);
  if (Array.isArray(out.permissions)) out.permissions = out.permissions.filter((p) => !removeSet.has(p));
  if (Array.isArray(out.optional_permissions)) {
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

  // page_action has no Safari equivalent; fold it into the toolbar-button key that
  // is valid for THIS manifest version. On MV3 that's `action`; on MV2 it must be
  // `browser_action` — injecting an `action` key into an MV2 manifest makes Safari
  // reject it at load (same rule the popup-wiring below relies on). (MV3 dropped the
  // show-only-on-some-pages distinction; Safari treats both as a plain action.)
  if (out.page_action && !out.action && !out.browser_action) {
    const foldKey = mv === 3 ? "action" : "browser_action";
    out[foldKey] = out.page_action as Manifest["action"];
    delete out.page_action;
  }

  // MV3 requires content_security_policy to be an object keyed by context, not the
  // bare MV2 string. Safari silently ignores a string-form CSP under MV3, so the
  // extension runs with the default policy instead of the author's. Wrap it.
  if (mv === 3 && typeof out.content_security_policy === "string") {
    out.content_security_policy = { extension_pages: out.content_security_policy };
  }

  // MV3 requires web_accessible_resources to be an array of {resources, matches}
  // objects. A bare MV2 string[] makes Safari reject the manifest at load. Wrap
  // the flat list, exposing it to all URLs (the MV2 default visibility).
  if (mv === 3 && Array.isArray(out.web_accessible_resources)) {
    const flat = out.web_accessible_resources as unknown[];
    // Handle mixed arrays per-entry: a bare string[] is MV2-style, but hand-edited
    // manifests sometimes mix loose strings with MV3 objects. Wrap only the loose
    // strings and pass the already-valid objects through untouched.
    const looseStrings = flat.filter((e): e is string => typeof e === "string");
    const objects = flat.filter((e) => typeof e === "object" && e !== null);
    if (looseStrings.length > 0) {
      out.web_accessible_resources = [
        { resources: looseStrings, matches: ["<all_urls>"] },
        ...objects,
      ] as Manifest["web_accessible_resources"];
    }
  }

  out.browser_specific_settings = {
    ...(out.browser_specific_settings ?? {}),
    safari: { strict_min_version: opts.minSafariVersion ?? "15.4" },
  };

  // Ensure the toolbar button does something: wire a popup if one exists. Pick the
  // key valid for this manifest version — MV2 has no `action` (only browser_action),
  // so injecting `action` there produces a manifest Safari rejects at load.
  const defaultActionKey = mv === 3 ? "action" : "browser_action";
  const actionKey = out.action ? "action" : out.browser_action ? "browser_action" : defaultActionKey;
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
