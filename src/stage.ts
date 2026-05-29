import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { basename } from "node:path";
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
const EXCLUDE_PREFIX = ["README", "CHANGELOG", "LICENSE", ".eslint", ".prettier"];

function shouldExclude(name: string): boolean {
  if (EXCLUDE_EXACT.has(name)) return true;
  if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) return true;
  if (EXCLUDE_PREFIX.some((p) => name.startsWith(p))) return true;
  return false;
}

/**
 * Copy the extension into stageDir, dropping dev cruft and store metadata.
 * The manifest + shim are written separately by the caller afterward.
 * stageDir is recreated fresh each run.
 */
export function stageExtension(sourceDir: string, stageDir: string): void {
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  cpSync(sourceDir, stageDir, {
    recursive: true,
    filter: (src) => !shouldExclude(basename(src)),
  });

  cleanExtendedAttributes(stageDir);
}
