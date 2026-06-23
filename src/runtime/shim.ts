import { writeFileSync, readFileSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Manifest } from "../types.js";
import { TEMPLATE_DIR, RUNTIME_DIR } from "../paths.js";

export const SHIM_FILENAME = "safari-compat-shim.js";
export const POLYFILL_FILENAME = "browser-polyfill.min.js";
export const BACKGROUND_PAGE_FILENAME = "background.html";

/**
 * Copy the bundled webextension-polyfill into the staged extension so Chrome code
 * that calls promise-based `browser.*` runs on every browser. The polyfill no-ops
 * when a native `browser` already exists (Safari/Firefox) and otherwise wraps
 * `chrome.*` callbacks as promises. Must load BEFORE the compat shim so the shim's
 * `browser`-namespace patches apply to the polyfilled object. Returns the filename
 * or undefined if the template is unavailable.
 */
export function writePolyfill(targetDir: string): string | undefined {
  const src = join(TEMPLATE_DIR, POLYFILL_FILENAME);
  if (!existsSync(src)) return undefined;
  copyFileSync(src, join(targetDir, POLYFILL_FILENAME));
  return POLYFILL_FILENAME;
}

/**
 * Runtime compatibility shim, prepended to content scripts.
 * Patches the gaps documented in the engineering guide so calls degrade
 * gracefully instead of throwing.
 */
/** Build-time config baked into the shim. All values are derived generically
 *  from the source manifest — nothing extension-specific is hardcoded. */
export interface ShimConfig {
  /** chrome-extension://<id> origin to spoof on proxied requests, or "" if the
   *  source manifest had no `key` to derive an id from. */
  chromeOrigin?: string;
  /** Bare hostnames the extension declares it talks to (host_permissions +
   *  externally_connectable). A cross-origin request to one of these that the
   *  browser blocks (CORS/401/403) is retried through the native host. */
  proxyHosts?: string[];
}

export function shimSource(config: ShimConfig = {}): string {
  // The proxy allowlist + spoofed origin are injected as a JSON literal so the
  // shim needs no string interpolation of untrusted data into code. The runtime
  // JS lives in src/runtime/safari-compat-shim.js (a real, lintable .js file);
  // we read it and substitute the one placeholder. Reading bytes verbatim keeps
  // every regex backslash (/\\$(\\d+)/, /api\\.anthropic\\.com/) intact — no
  // template-literal escaping to corrupt them.
  const proxyCfg = JSON.stringify({
    origin: config.chromeOrigin || "",
    hosts: config.proxyHosts || [],
  });
  const runtime = readFileSync(join(RUNTIME_DIR, SHIM_FILENAME), "utf-8");
  return runtime.replace("__C2S_PROXY_CONFIG_JSON__", proxyCfg);
}

export function writeShim(targetDir: string, config: ShimConfig = {}): string {
  const p = join(targetDir, SHIM_FILENAME);
  writeFileSync(p, shimSource(config), "utf-8");
  return SHIM_FILENAME;
}

/** Hostnames the extension declares it talks to: host_permissions +
 *  externally_connectable.matches. These are the backends that may reject the
 *  Safari origin and therefore need native-host proxying. Generic — derived
 *  purely from the manifest. */
export function deriveProxyHosts(manifest: Manifest): string[] {
  const patterns: string[] = [];
  if (Array.isArray(manifest.host_permissions)) patterns.push(...manifest.host_permissions);
  const ec = manifest.externally_connectable;
  if (ec && Array.isArray(ec.matches)) patterns.push(...ec.matches);
  // CSP connect-src is where API endpoints are declared when host_permissions is
  // a broad wildcard (<all_urls>). These https/wss origins are the real backends.
  const csp = manifest.content_security_policy;
  const cspStr = typeof csp === "string" ? csp : csp?.extension_pages ?? "";
  const connect = /(?:^|;)\s*connect-src\s+([^;]+)/i.exec(cspStr);
  if (connect) {
    for (const tok of connect[1].split(/\s+/)) {
      if (/^(https?|wss?):\/\//i.test(tok)) patterns.push(tok);
    }
  }
  const hosts = new Set<string>();
  for (const pat of patterns) {
    if (typeof pat !== "string") continue;
    // Match patterns / CSP sources: "*://*.example.com/*", "https://api.foo.com/*",
    // "wss://api.foo.com". Strip scheme, leading "*.", port, and any path.
    const m = /^[^:]+:\/\/([^/]+)/.exec(pat);
    if (!m) continue;
    const host = m[1].replace(/^\*\./, "").replace(/:\d+$/, "");
    // Skip wildcard-only hosts (<all_urls>, "*") — too broad to proxy safely.
    if (!host || host === "*" || host.includes("*")) continue;
    hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

/**
 * Index just past the first REAL `<head ...>` tag, skipping any `<head>` that
 * sits inside an HTML comment (`<!-- <head> -->`). Injecting a <script> after a
 * commented-out head buries it inside the comment → it never runs (blank popup /
 * dead page). Returns -1 when there's no usable head tag.
 */
function headInsertIndex(html: string): number {
  const re = /<head[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    // Inside a comment if the last "<!--" before this point has no "-->" after it.
    const open = html.lastIndexOf("<!--", m.index);
    if (open !== -1 && html.indexOf("-->", open) > m.index) continue;
    return m.index + m[0].length;
  }
  return -1;
}

function walkHtmlFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === "node_modules" || name === ".git" || name.startsWith("__MACOSX")) continue;
    const full = join(dir, name);
    if (entry.isDirectory()) walkHtmlFiles(full, acc);
    else if (entry.isFile() && name.toLowerCase().endsWith(".html")) acc.push(full);
  }
  return acc;
}

/**
 * Inject the polyfill (optional) + shim as the first <head> scripts of every
 * extension HTML page (recursively — options/sidepanel pages often live in
 * subdirs). The tags use root-absolute src so they resolve from any depth.
 * Module scripts are deferred, so classic scripts placed in <head> run first —
 * the polyfill defines `browser`, then the shim patches missing chrome / browser
 * namespaces, all before bundle module-eval.
 */
export function injectShimIntoHtmlPages(dir: string, polyfillFile?: string): number {
  const shimTag = `<script src="/${SHIM_FILENAME}"></script>`;
  const polyTag = polyfillFile ? `<script src="/${polyfillFile}"></script>` : "";
  let count = 0;
  for (const file of walkHtmlFiles(dir)) {
    let html = readFileSync(file, "utf-8");
    // Insert only the missing tag(s) so a partial prior injection (either tag)
    // never produces duplicates. Polyfill stays before the shim.
    const missing = [polyTag, shimTag].filter((t) => t && !html.includes(t));
    if (missing.length === 0) continue;
    const toInsert = missing.join("\n    ");
    const at = headInsertIndex(html);
    if (at >= 0) {
      html = html.slice(0, at) + "\n    " + toInsert + html.slice(at);
    } else {
      html = toInsert + "\n" + html;
    }
    writeFileSync(file, html, "utf-8");
    count++;
  }
  return count;
}

/**
 * Side-panel/full-height pages wired as a Safari action popup collapse to a tiny
 * window because they carry no intrinsic size. Inject a sizing style so the popup
 * opens at usable dimensions. style-src allows 'unsafe-inline' in typical MV3 CSPs.
 */
export function injectPopupSizing(dir: string, popupFile: string, fullHeight = false): void {
  const file = join(dir, popupFile);
  let html: string;
  try {
    html = readFileSync(file, "utf-8");
  } catch {
    return;
  }
  const marker = "c2s-popup-size";
  if (html.includes(marker)) return;
  // color-scheme lets Safari paint the popup canvas in the OS theme *before* the
  // app's CSS/JS boots — without it the popover flashes light even in dark mode.
  //
  // The ONLY job here is to stop a popover collapsing to nothing when the page
  // carries no intrinsic size (empty <body> filled by JS) — NOT to dictate size.
  // An extension knows its own dimensions; overriding them with !important fixed
  // sizes makes correctly-sized popups too big/small (Urban VPN's app forced to
  // 780x600). So:
  //  - margin:0 !important — the one override worth forcing: a stray app
  //    `body{margin:auto}` (Tampermonkey) offsets the popover otherwise.
  //  - min-width/min-height as a FLOOR only, NO !important — a non-important rule
  //    that loses to any size the app's own CSS sets, so it only takes effect when
  //    the app declares nothing (the empty-at-load case). No fixed width/height,
  //    no max caps: the popover follows the content/app, Safari clamps the ceiling.
  // ponytail: floor-only; if some app still opens too small add a per-extension
  // size override, don't reintroduce a global fixed size.
  //
  // fullHeight: a SIDE-PANEL page wired as the popup (Claude's sidepanel.html).
  // Side panels lay out against the panel's full height (height:100%/100vh). In a
  // popover with no fixed height, 100% resolves to ~0 and the app collapses to a
  // sliver. Give html/body an explicit large height so the app's % layout fills.
  // Use !important on height ONLY (the collapse is the bug); width still follows
  // the app. This is gated to side-panel pages, so normal popups are untouched.
  const sizeFloor = fullHeight
    ? `html,body{margin:0!important;height:600px!important;min-width:380px;}`
    : `html,body{margin:0!important;}body{min-width:320px;min-height:160px;}`;
  const style = `<style id="${marker}">:root{color-scheme:light dark;}${sizeFloor}</style>`;
  const at = headInsertIndex(html);
  if (at >= 0) {
    html = html.slice(0, at) + "\n    " + style + html.slice(at);
  } else {
    html = style + "\n" + html;
  }
  writeFileSync(file, html, "utf-8");
}

/**
 * Safari starts module service workers unreliably for temp-loaded extensions —
 * the SW often never runs, so anything probing it (e.g. the OAuth content-script
 * bridge) times out with "background not running/reachable". Convert the MV3
 * service worker into a non-persistent background page that loads the compat shim
 * first (so missing chrome.* events are backfilled before the bundle module-evals
 * and aborts) then the SW loader as a module. Mutates `manifest`. No-op when there
 * is no service_worker. Must run AFTER the OAuth bridge so the loader already
 * imports its polyfill.
 */
export function convertServiceWorkerToBackgroundPage(dir: string, manifest: Manifest, polyfillFile?: string): boolean {
  const sw = manifest.background?.service_worker;
  if (!sw) return false;
  const polyTag = polyfillFile && existsSync(join(dir, polyfillFile)) ? `<script src="${polyfillFile}"></script>\n` : "";
  // --no-shim conversions have no shim file; don't reference a missing script.
  const shimTag = existsSync(join(dir, SHIM_FILENAME)) ? `<script src="${SHIM_FILENAME}"></script>\n` : "";

  // importScripts() is undefined in a module background page, so the first call
  // throws and aborts SW evaluation BEFORE its onConnect/onMessage listeners
  // register (→ popup's runtime.connect() gets "No onConnect listeners found").
  // The default extension CSP is script-src 'self' (no eval), so a runtime
  // fetch+eval polyfill can't substitute. Instead hoist each importScripts target
  // into background.html as a classic <script> BEFORE the SW module (the imported
  // files are self-contained IIFEs that just need to run in global scope first —
  // exactly what a prior <script> tag gives), then neutralize the calls in the SW
  // so the now-undefined global is never invoked. CSP-safe and generic.
  const importTags = hoistImportScripts(dir, sw);

  // manifest.name is raw (may be unresolved "__MSG_*__" or contain <,>,& — e.g.
  // "Save to Notion <Beta>"). Escape it so a stray "<" / "</title>" can't break
  // out of the title and corrupt the background page's HTML.
  const title = String(manifest.name ?? "Extension")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>${title} background</title>
${polyTag}${shimTag}${importTags}<script type="module" src="${sw}"></script>
`;
  writeFileSync(join(dir, BACKGROUND_PAGE_FILENAME), html, "utf-8");
  // MV3 (Safari) rejects persistent background: "A manifest_version >= 3 must be non-persistent."
  manifest.background = { page: BACKGROUND_PAGE_FILENAME, persistent: false };
  return true;
}

/**
 * Find importScripts("a.js", "b.js") calls in the SW bundle, resolve each path
 * relative to the SW file, and return <script src="..."> tags for the ones that
 * exist on disk (root-relative so they resolve from background.html). The calls
 * themselves are replaced in the SW source with a void 0 no-op so the undefined
 * worker global is never invoked. Paths are resolved against the SW's directory;
 * the emitted src is relative to the extension root (where background.html lives).
 * Returns "" when there are no resolvable importScripts calls.
 */
/**
 * Given the index of an opening "(" in `src`, return the index just PAST its
 * matching ")", honoring nested parens and skipping string literals (', ", `)
 * and // and / * * / comments so their parens/quotes don't throw off the count.
 * Returns -1 if no balanced close is found. Template-literal `${}` expressions
 * are tracked so a ")" inside an interpolation still counts.
 */
function matchBalancedParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      // skip the string literal
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
    } else if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 1;
    }
  }
  return -1;
}

function hoistImportScripts(dir: string, swPath: string): string {
  const swFile = join(dir, swPath);
  let src: string;
  try {
    src = readFileSync(swFile, "utf-8");
  } catch {
    return "";
  }
  if (!/\bimportScripts\s*\(/.test(src)) return "";

  const swDir = dirname(swPath); // e.g. "service-worker"
  const tags: string[] = [];
  const seen = new Set<string>();
  // Find each importScripts( ... ) call and its argument list. A regex with
  // [^)]* truncates at the FIRST ")", which is wrong when an argument itself
  // contains parens — e.g. webpack's `importScripts(o.p+o.u(t))`. That left the
  // outer ")" dangling after the no-op replacement and broke the bundle with a
  // SyntaxError. Scan for the balanced closing paren instead (string-literal and
  // comment aware), so the WHOLE call is replaced regardless of nesting.
  const callOpenRe = /\bimportScripts\s*\(/g;
  let neutralized = 0;
  let out = "";
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = callOpenRe.exec(src))) {
    const openParen = mm.index + mm[0].length - 1; // index of the "(" itself
    const end = matchBalancedParen(src, openParen); // index just past the ")"
    if (end < 0) continue; // unbalanced (shouldn't happen in valid JS) → leave as-is
    const argList = src.slice(openParen + 1, end - 1);
    const argRe = /["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = argRe.exec(argList))) {
      const rawPath = m[1];
      // Resolve relative to the SW dir → a path from the extension root.
      const fromRoot = join(swDir, rawPath).split("\\").join("/");
      if (seen.has(fromRoot)) continue;
      if (!existsSync(join(dir, fromRoot))) continue; // unresolved → skip the tag; no-op still applies
      seen.add(fromRoot);
      tags.push(`<script src="${fromRoot}"></script>`);
    }
    out += src.slice(last, mm.index) + "void 0 /* importScripts hoisted to background.html */";
    last = end;
    neutralized++;
    callOpenRe.lastIndex = end; // continue scanning after the full call
  }
  out += src.slice(last);
  src = out;

  // Write whenever ANY call was neutralized — even an unresolved target must be
  // de-fanged (it would throw on the undefined global), not just hoisted ones.
  if (neutralized > 0) writeFileSync(swFile, src, "utf-8");
  return tags.length ? tags.join("\n") + "\n" : "";
}
