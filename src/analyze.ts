import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Issue, Manifest, Platforms } from "./types.js";
import { UNSUPPORTED_APIS, parseJsonc } from "./manifest.js";

/**
 * Recursive file finder. Dirent-based so each entry costs no extra stat (only
 * symlinks are stat'ed to resolve their target kind); `seen` holds realpaths of
 * visited directories to break symlink cycles.
 */
function walkFiles(dir: string, exts: string[], acc: string[] = [], seen = new Set<string>()): string[] {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return acc;
  }
  if (seen.has(real)) return acc;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    // staged_extension is this tool's own output; scanning it duplicates every issue.
    if (name === "node_modules" || name === ".git" || name === "staged_extension" || name.startsWith("__MACOSX")) continue;
    const full = join(dir, name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walkFiles(full, exts, acc, seen);
    else if (isFile && exts.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Lazy line resolver for one file: builds a newline-offset index on first use,
 * then answers each lookup with a binary search — instead of re-slicing and
 * splitting the whole content per match (quadratic on big bundled JS).
 */
function makeLineResolver(content: string): (index: number) => number {
  let offsets: number[] | null = null;
  return (index) => {
    if (!offsets) {
      offsets = [0];
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) offsets.push(i + 1);
      }
    }
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Compile detection patterns once. Almost every key is a plain dotted name —
// after dot-escaping the regex matches a literal string, so indexOf (much
// faster than regex over the whole file) finds it directly. Only keys carrying
// real regex metachars (e.g. "chrome.tts\b") keep a compiled RegExp.
const API_PATTERNS = Object.entries(UNSUPPORTED_APIS).map(([api, info]) => {
  const name = api.replace(/\\b/g, "");
  if (api.includes("\\")) {
    return { name, literal: null as string | null, re: new RegExp(api.replace(/\./g, "\\.")), info };
  }
  return { name, literal: api, re: null as RegExp | null, info };
});
const FAVICON_RE = /chrome:\/\/favicon|[/'"]_favicon\//;
const BLOCKING_WEBREQUEST_RE = /chrome\.webRequest\.on\w+/;
const TIMER_RE = /(setTimeout|setInterval)\s*\(/;
const BACKGROUND_FILE_RE = /(background|service[-_]?worker)/i;
const CONNECT_RE = /(tabs\.connect|runtime\.onConnect)/;
const IMPORT_SCRIPTS_RE = /\bimportScripts\s*\(/;

function scanJsContent(content: string, rel: string, issues: Issue[]): void {
  const lineAt = makeLineResolver(content);

  const hits: Array<{ name: string; at: number; info: (typeof API_PATTERNS)[number]["info"] }> = [];
  for (const { name, literal, re, info } of API_PATTERNS) {
    const at = literal !== null ? content.indexOf(literal) : re!.exec(content)?.index ?? -1;
    if (at >= 0) hits.push({ name, at, info });
  }
  for (const h of hits) {
    // A more specific match (chrome.identity.launchWebAuthFlow) subsumes the
    // generic namespace one (chrome.identity) — skip the duplicate.
    if (hits.some((o) => o !== h && o.name.startsWith(h.name + "."))) continue;
    issues.push({
      severity: h.info.severity,
      category: "api",
      message: h.info.message,
      file: rel,
      line: lineAt(h.at),
      fix: h.info.fix,
    });
  }

  const wr = BLOCKING_WEBREQUEST_RE.exec(content);
  // Blocking mode is opted into via the literal "blocking" string in the
  // addListener extraInfoSpec array. Match the quoted token, not the bare word
  // (which fires on comments, CSS classes, and unrelated identifiers).
  if (wr && /["']blocking["']/.test(content)) {
    issues.push({
      severity: "error",
      category: "api",
      message: "Blocking webRequest detected; unsupported in Safari (and absent on iOS).",
      file: rel,
      line: lineAt(wr.index),
      fix: "Migrate to declarativeNetRequest rulesets.",
    });
  }

  if (BACKGROUND_FILE_RE.test(rel)) {
    const m = TIMER_RE.exec(content);
    if (m) {
      issues.push({
        severity: "warning",
        category: "background",
        message: "setTimeout/setInterval are unreliable in suspended Safari background contexts.",
        file: rel,
        line: lineAt(m.index),
        fix: "Use chrome.alarms for scheduled work; persist state to storage.local.",
      });
    }
  }

  // chrome2safari converts the MV3 service worker into a module background page
  // (<script type="module">). importScripts() is a worker-global function absent
  // in module scope, so the first call throws and the background dies silently.
  // Flag it anywhere — outside a worker it was already non-functional. (Not gated
  // on the filename: the SW entry is often named sw.js / index.js, not "background".)
  const is = IMPORT_SCRIPTS_RE.exec(content);
  if (is) {
    issues.push({
      severity: "error",
      category: "background",
      message: "importScripts() is undefined once the service worker is converted to a module background page.",
      file: rel,
      line: lineAt(is.index),
      fix: 'Replace importScripts("a.js","b.js") with static ES imports (import "./a.js";) at the top of the worker.',
    });
  }

  const cm = CONNECT_RE.exec(content);
  if (cm) {
    issues.push({
      severity: "warning",
      category: "safari18",
      message: "Safari 18: tabs.connect/onConnect fail for iframe ↔ content-script ports.",
      file: rel,
      line: lineAt(cm.index),
      fix: "Use contentWindow.postMessage from the page, then runtime.sendMessage from the iframe.",
    });
  }
}

/**
 * Single-pass source scan: walks the extension once, reads each file once, and
 * runs every disk-backed check (unsupported chrome.* APIs, blocking webRequest,
 * background timers, Safari 18 port gaps, favicon access, _locales consistency,
 * iOS caveats).
 */
export function scanExtension(extPath: string, manifest: Manifest, platforms: Platforms): Issue[] {
  const issues: Issue[] = [];

  // Declared icon paths that don't exist on disk → Safari fails to load the
  // extension (and the App Store rejects the upload). Collect every referenced
  // icon path from manifest.icons and each action's default_icon, then flag the
  // missing ones. Web-accessible/CSS icons aren't checked — only manifest-declared.
  const iconPaths = new Set<string>();
  for (const p of Object.values(manifest.icons ?? {})) {
    if (typeof p === "string") iconPaths.add(p);
  }
  for (const a of [manifest.action, manifest.browser_action, manifest.page_action]) {
    const di = (a as { default_icon?: unknown } | undefined)?.default_icon;
    if (typeof di === "string") iconPaths.add(di);
    else if (di && typeof di === "object") {
      for (const p of Object.values(di as Record<string, unknown>)) {
        if (typeof p === "string") iconPaths.add(p);
      }
    }
  }
  for (const p of iconPaths) {
    if (!existsSync(join(extPath, p))) {
      issues.push({
        severity: "error",
        category: "icons",
        message: `Declared icon "${p}" is missing from the package; Safari will fail to load the extension.`,
        file: "manifest.json",
        fix: "Add the icon file, or remove the reference from manifest.json.",
      });
      continue;
    }
    // Safari's extension toolbar/store pipeline only renders PNG icons; an .svg/.webp/.jpg
    // icon loads in Chrome but shows a blank glyph in Safari (and the App Store rejects it).
    const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
    if (ext && ext !== ".png") {
      issues.push({
        severity: "warning",
        category: "icons",
        message: `Icon "${p}" is ${ext} — Safari only renders PNG icons (Chrome accepts more formats).`,
        file: "manifest.json",
        fix: "Convert the icon to PNG and update the manifest path.",
      });
    }
  }

  // Manifest-referenced files that don't exist on disk → Safari silently drops the
  // content script / fails to load the page. Collected as {path → where} so a
  // missing file is reported once with a useful location. Only author-declared
  // paths are checked here (analyze runs on the raw manifest, before the converter
  // injects its own shim/polyfill/bridge scripts — so no false positives on those).
  const refs = new Map<string, string>();
  const addRef = (p: unknown, where: string) => {
    if (typeof p === "string" && p && !refs.has(p)) refs.set(p, where);
  };
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  // arr()/typeof guards keep a malformed manifest (non-array js/scripts, etc.) from
  // crashing the scan — Chrome would reject it, but the converter should report.
  arr(manifest.content_scripts).forEach((cs: any, i) => {
    for (const j of arr(cs?.js)) addRef(j, `content_scripts[${i}].js`);
    for (const c of arr(cs?.css)) addRef(c, `content_scripts[${i}].css`);
  });
  for (const b of arr(manifest.background?.scripts)) addRef(b, "background.scripts");
  addRef(manifest.background?.service_worker, "background.service_worker");
  addRef(manifest.background?.page, "background.page");
  for (const a of [manifest.action, manifest.browser_action, manifest.page_action]) {
    addRef((a as { default_popup?: unknown } | undefined)?.default_popup, "action.default_popup");
  }
  addRef(manifest.options_page, "options_page");
  addRef(manifest.options_ui?.page, "options_ui.page");
  addRef(manifest.devtools_page, "devtools_page");
  for (const p of arr(manifest.sandbox?.pages)) addRef(p, "sandbox.pages");
  for (const [p, where] of refs) {
    if (!existsSync(join(extPath, p))) {
      issues.push({
        severity: "error",
        category: "manifest",
        message: `${where} references "${p}", which is missing from the package.`,
        file: "manifest.json",
        fix: "Safari silently drops the script/page for a missing file; add it or remove the reference.",
      });
    }
  }

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

  // default_locale set → its _locales/<locale>/messages.json must exist and parse,
  // or the load fails with an opaque error.
  if (manifest.default_locale) {
    const msgs = join(extPath, "_locales", manifest.default_locale, "messages.json");
    if (!existsSync(msgs)) {
      issues.push({
        severity: "error",
        category: "i18n",
        message: `default_locale "${manifest.default_locale}" has no _locales/${manifest.default_locale}/messages.json.`,
        file: "manifest.json",
        fix: "Create the messages.json for the default locale, or change default_locale to an existing one.",
      });
    } else {
      try {
        parseJsonc(readFileSync(msgs, "utf-8"));
      } catch {
        issues.push({
          severity: "error",
          category: "i18n",
          message: `_locales/${manifest.default_locale}/messages.json is not valid JSON; the extension will fail to load.`,
          file: `_locales/${manifest.default_locale}/messages.json`,
          fix: "Fix the JSON syntax.",
        });
      }
    }
  }

  let faviconNoted = false;
  for (const file of walkFiles(extPath, [".js", ".mjs", ".html", ".css"])) {
    const isJs = file.endsWith(".js") || file.endsWith(".mjs");
    // html/css files are only read for the (once-per-extension) favicon check.
    if (!isJs && faviconNoted) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const rel = relative(extPath, file);

    // _favicon / chrome://favicon has no Safari equivalent. One note is enough.
    if (!faviconNoted) {
      const m = FAVICON_RE.exec(content);
      if (m) {
        faviconNoted = true;
        issues.push({
          severity: "warning",
          category: "api",
          message: "Favicon access via chrome://favicon / _favicon has no Safari equivalent.",
          file: rel,
          line: makeLineResolver(content)(m.index),
          fix: "Fetch favicons directly (e.g. <link> from the page) or drop the favicon UI.",
        });
      }
    }

    if (isJs) scanJsContent(content, rel, issues);
  }

  if (platforms === "ios" || platforms === "all") {
    issues.push({
      severity: "info",
      category: "ios",
      message: "Targeting iOS/iPadOS: popup/options UI must be responsive; side-by-side layouts break on small screens.",
      file: "manifest.json",
      fix: "Add responsive CSS; test in Safari on iOS. Distribution is App Store only (no dev-direct for end users).",
    });
    const allPerms = [
      ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
      ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
    ];
    const platformGated = ["contextMenus", "notifications", "downloads", "cookies"].filter((p) => allPerms.includes(p));
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
