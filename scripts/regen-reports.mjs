#!/usr/bin/env node
// Regenerate CONVERSION_REPORT.md for every local test extension into
// `test extensions/_results/<App>_Safari/`, using the current built CLI.
// No Xcode build — staging + report only (--no-build). Run: node scripts/regen-reports.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, mkdtempSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const SRC_DIR = join(ROOT, "test extensions");
const OUT_DIR = join(SRC_DIR, "_results");

// A source is convertible if it's a .zip/.crx/.xpi, or a directory holding a manifest.json
// (directly or one level down). Skip _results itself and already-converted *_Safari dirs.
function isExtensionSource(name) {
  if (name === "_results" || name.endsWith("_Safari") || name.startsWith(".")) return false;
  const p = join(SRC_DIR, name);
  let st;
  try { st = statSync(p); } catch { return false; }
  if (st.isFile()) return /\.(zip|crx|xpi)$/i.test(name);
  if (st.isDirectory()) {
    if (existsSync(join(p, "manifest.json"))) return true;
    try {
      return readdirSync(p).some((c) => {
        try { return statSync(join(p, c)).isDirectory() && existsSync(join(p, c, "manifest.json")); }
        catch { return false; }
      });
    } catch { return false; }
  }
  return false;
}

const sources = readdirSync(SRC_DIR).filter(isExtensionSource).sort();
console.log(`Regenerating reports for ${sources.length} source(s) → ${OUT_DIR}\n`);

let ok = 0, fail = 0;
for (const name of sources) {
  const src = join(SRC_DIR, name);
  // Convert into a scratch dir, then copy the produced CONVERSION_REPORT.md (and the
  // <App>_Safari dir name viaduct derives) back into _results so existing paths update.
  const scratch = mkdtempSync(join(tmpdir(), "regen-"));
  try {
    execFileSync("node", [CLI, src, "--no-build", "--output", join(scratch, "out")], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // viaduct wrote scratch/out/CONVERSION_REPORT.md (output dir is exactly what we passed).
    const report = join(scratch, "out", "CONVERSION_REPORT.md");
    if (!existsSync(report)) throw new Error("no report produced");
    // Mirror into _results under the same _Safari folder name this source maps to.
    // Derive the target name from the existing _results dir if present, else from output.
    const destDir = join(OUT_DIR, deriveResultName(name));
    cpSync(report, join(destDir, "CONVERSION_REPORT.md"));
    console.log(`  ✓ ${name} → ${deriveResultName(name)}/CONVERSION_REPORT.md`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${String(e.message || e).split("\n")[0]}`);
    fail++;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
console.log(`\nDone: ${ok} ok, ${fail} failed.`);

// Map a source name to its _results/<X>_Safari folder. Prefer an existing folder whose
// staged_extension came from this source; fall back to "<basename>_Safari".
function deriveResultName(srcName) {
  const base = srcName.replace(/\.(zip|crx|xpi)$/i, "");
  const candidate = `${base}_Safari`;
  if (existsSync(join(OUT_DIR, candidate))) return candidate;
  // zips often map to a PascalCase app dir (claude-chrome.zip → ClaudeChrome_Safari);
  // try to find an existing dir by fuzzy match on alphanumerics.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(base);
  for (const d of readdirSync(OUT_DIR)) {
    if (d.endsWith("_Safari") && norm(d.replace(/_Safari$/, "")) === want) return d;
  }
  return candidate;
}
