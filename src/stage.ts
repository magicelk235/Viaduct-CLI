import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  cpSync(sourceDir, stageDir, {
    recursive: true,
    filter: (src) => {
      if (!shouldExclude(basename(src))) return true;
      // Excluded by name — but keep it if the manifest references this exact path.
      const rel = relative(root, resolve(src)).split(sep).join("/");
      return keep.has(rel);
    },
  });

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
