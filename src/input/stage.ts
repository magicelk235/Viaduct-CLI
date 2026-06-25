import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, statSync, realpathSync, copyFileSync } from "node:fs";
import { basename, join, dirname, resolve, relative, sep } from "node:path";
import { cleanExtendedAttributes } from "./extract.js";

/** Names/globs excluded from the clean staged extension. */
const EXCLUDE_EXACT = new Set([
  ".DS_Store",
  "__MACOSX",
  ".git",
  ".gitignore",
  ".github",
  ".svn",
  "node_modules",
  "_metadata", // Chrome Web Store signing metadata
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

const EXCLUDE_SUFFIX = [".map", ".ts", ".tsx", ".md", ".log"];
// Doc/config files: bare name or name + extension only (e.g. "LICENSE",
// "LICENSE.txt"), never a prefix match — that would drop legit runtime files
// like "LICENSE_KEY.js" or "READMExporter.js".
const EXCLUDE_DOC_RE = /^(README|CHANGELOG|LICENSE)(\.[^.]+)?$/i;
const EXCLUDE_DOTFILE = [".eslint", ".prettier"];

function shouldExclude(name: string): boolean {
  if (EXCLUDE_EXACT.has(name)) return true;
  if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) return true;
  if (EXCLUDE_DOC_RE.test(name)) return true;
  if (EXCLUDE_DOTFILE.some((p) => name.startsWith(p))) return true;
  return false;
}

/**
 * Copy the extension into stageDir, dropping dev cruft and store metadata.
 * The manifest + shim are written separately by the caller afterward.
 * stageDir is recreated fresh each run.
 *
 * `keep` is a set of manifest-relative paths (forward-slash) that the manifest
 * declares as runtime assets; these are copied even if their name matches an
 * exclusion rule — otherwise a web-accessible LICENSE.txt or a .map served to a
 * page would be dropped and 404 in Safari.
 */
export function stageExtension(sourceDir: string, stageDir: string, keep: Set<string> = new Set()): void {
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const root = resolve(sourceDir);
  // Realpath'd root for the kept-symlink containment check below. resolve() doesn't
  // collapse symlinked ancestors, but realpathSync(srcLink) does — so on macOS where
  // scratch dirs live under /tmp (a symlink to /private/tmp), an in-tree target would
  // realpath to /private/... and fail `startsWith(root)`, silently dropping the asset.
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* source missing → cpSync errors anyway */ }
  cpSync(sourceDir, stageDir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, resolve(src)).split(sep).join("/");
      if (rel === "") return true; // the stage root itself
      // Never copy symlinks into the package. cpSync reproduces them verbatim, so a
      // link in the source (evil.txt -> /etc/hosts) would ship a dangling/absolute
      // link that leaks the build host's layout and 404s in Safari. Drop them.
      // lstat can throw on a broken/racing entry; an unguarded throw here escapes the
      // filter and aborts the whole copy with an opaque ENOENT — exclude on error.
      let st;
      try { st = lstatSync(src); } catch { return false; }
      if (st.isSymbolicLink()) return false;
      // A manifest-referenced path is always kept, even under an excluded ancestor.
      if (keep.has(rel)) return true;
      // Excluded if its own name OR any ancestor segment is excluded — this stops a
      // file like _metadata/junk.js (parent excluded) from riding in just because
      // its own basename is clean.
      const segments = rel.split("/");
      if (segments.some(shouldExclude)) {
        // Still allow an excluded directory to be entered when a kept path lives
        // inside it; cpSync won't recurse otherwise and the kept child is lost.
        const asDir = rel + "/";
        for (const k of keep) if (k.startsWith(asDir)) return true;
        return false;
      }
      return true;
    },
  });

  // The filter above drops ALL symlinks (verbatim-copied links 404 in Safari and
  // leak the build host's layout). But a manifest-referenced asset that happens to
  // be a symlink in the source (common with pnpm/monorepo asset linking) is a real
  // runtime dependency — dropping it 404s the page that needs it. For kept paths
  // only, dereference the link and copy the actual target file (staying inside the
  // source tree) so the bytes ship without the dangling-link hazard.
  for (const rel of keep) {
    const srcLink = join(root, rel);
    let lst;
    try { lst = lstatSync(srcLink); } catch { continue; }
    if (!lst.isSymbolicLink()) continue;
    let target;
    try {
      target = realpathSync(srcLink);
      // Only follow links whose target stays inside the source tree (compare against
      // the realpath'd root so a symlinked ancestor like /tmp→/private/tmp doesn't
      // make an in-tree target look external).
      if (target !== realRoot && !target.startsWith(realRoot + sep)) continue;
      if (!statSync(target).isFile()) continue;
    } catch { continue; }
    const dest = join(stageDir, rel);
    try { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(target, dest); } catch { /* best effort */ }
  }

  cleanExtendedAttributes(stageDir);
}

const SOURCEMAP_RE = /[ \t]*\/\/[#@] sourceMappingURL=(\S+)[ \t]*\r?$/gm;

function walkScripts(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith("__MACOSX")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkScripts(full, acc);
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".mjs"))) acc.push(full);
  }
  return acc;
}

/**
 * Strip `//# sourceMappingURL=…` comments that point at a .map file no longer
 * present in the staged extension (stageExtension excludes *.map as dev cruft).
 * A dangling reference makes Safari's Web Inspector emit a 404 for the missing
 * map on every load. Only strips refs whose target is gone and is a local path —
 * data: URIs (inline maps) and existing maps are left untouched. Returns the
 * number of files modified.
 */
export function stripDanglingSourcemaps(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(SOURCEMAP_RE, (whole, url: string) => {
      if (url.startsWith("data:")) return whole; // inline map, self-contained
      // Resolve relative to the script; keep the ref if the map actually shipped.
      const mapPath = resolve(dirname(file), url);
      if (existsSync(mapPath)) return whole;
      changed = true;
      return "";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Safari's `chrome.scripting` (and `chrome.runtime` etc.) are EXOTIC, IMMUTABLE host
// slots: the shim cannot install the `ExecutionWorld`/`RegistrationWorld` enum objects
// onto them (assign/defineProperty are silent no-ops, delete re-materializes the empty
// native slot — proven live). Bundles read e.g. `chrome.scripting.ExecutionWorld.ISOLATED`
// at runtime and get `undefined.ISOLATED` → TypeError that aborts the call (Bitwarden:
// "undefined is not an object (evaluating 'chrome.scripting.ExecutionWorld.ISOLATED')").
// Since the enum members are fixed string constants, rewrite the reads to their literal
// values directly in the staged source. Covers chrome|browser, dot or ["bracket"] access
// for the namespace step, and the two enums Safari omits. Returns files modified.
//
// ponytail: literal-substitution, not a JS parser. These enums are only ever read as
// `.ExecutionWorld.<MEMBER>` member chains in real bundles (verified across the corpus);
// a regex is enough and can't mangle unrelated code. If a bundle ever aliased the enum
// object itself (`const W = chrome.scripting.ExecutionWorld`) we'd need AST work — add
// then.
const ENUM_VALUES: Record<string, Record<string, string>> = {
  ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
  RegistrationWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
};
// e.g.  chrome.scripting.ExecutionWorld.ISOLATED  |  browser["scripting"].RegistrationWorld.MAIN
const ENUM_RE =
  /\b(?:chrome|browser)\s*(?:\.\s*scripting|\[\s*["']scripting["']\s*\])\s*\.\s*(ExecutionWorld|RegistrationWorld)\s*\.\s*([A-Z_]+)\b/g;

export function inlineImmutableEnums(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(ENUM_RE, (whole, enumName: string, member: string) => {
      const val = ENUM_VALUES[enumName]?.[member];
      if (val == null) return whole; // unknown member — leave it untouched
      changed = true;
      return JSON.stringify(val); // "ISOLATED"
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}

// Bundles route extension-page ports (popup / side panel / devtools) by testing the
// sender's URL against a RegExp built from chrome.runtime.id:
//   new RegExp(chrome.runtime.id + "/src/popup.html").test(port.sender.url)
// On Chrome that works because runtime.id IS the host of every extension URL. On Safari
// it CANNOT: runtime.id is the App-Extension BUNDLE id ("com.x.Extension (TEAM)"), while
// sender.url's host is the per-install UUID — two different strings, and the bundle id even
// contains regex metacharacters. Safari exposes chrome.runtime.id as a frozen/exotic slot
// (assignment AND defineProperty silently no-op, and chrome.runtime itself can't be replaced
// — all proven live), so the shim cannot fix runtime.id at runtime. The port is never
// routed → the bg posts no reply → the popup's init RPC never resolves (e.g. Grammarly hangs
// on "starting…").
//
// Fix at conversion time: drop the `runtime.id +` prefix so the matcher becomes
//   new RegExp("/src/popup.html").test(sender.url)
// which is host-agnostic and matches the real Safari URL (any UUID host, and tolerant of
// Safari's "?tabId=N" query — the path substring still matches). It stays path-specific, so
// popup/sidePanel/devtools matchers remain distinct and content-script URLs don't match.
//
// ponytail: literal substitution, not a JS parser. Targets the exact, common shape
// `new RegExp(<chrome|browser>[.|["..."]]runtime.id + "<path>")`. A bundle that built the
// pattern some other way (string concat into a var first) would need AST work — add then.
const RUNTIME_ID_URL_RE =
  /new\s+RegExp\s*\(\s*(?:chrome|browser|self|globalThis)?\s*(?:\.\s*chrome|\.\s*browser)?\s*\.\s*runtime\s*\.\s*id\s*\+\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/g;

export function rewriteRuntimeIdUrlMatchers(stageDir: string): number {
  let modified = 0;
  for (const file of walkScripts(stageDir)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let changed = false;
    const next = content.replace(RUNTIME_ID_URL_RE, (whole, quote: string, path: string) => {
      // Only rewrite when the appended literal looks like a URL path (starts with "/").
      // That's the port-routing idiom; anything else we leave alone to stay conservative.
      if (!path.startsWith("/")) return whole;
      changed = true;
      return "new RegExp(" + quote + path + quote + ")";
    });
    if (changed) {
      writeFileSync(file, next, "utf-8");
      modified++;
    }
  }
  return modified;
}
