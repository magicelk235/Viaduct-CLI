import { existsSync, readFileSync, readdirSync, statSync, lstatSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, realpathSync, rmSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { run } from "../util.js";

/** Strip macOS extended attributes that break code signing. */
export function cleanExtendedAttributes(path: string): void {
  run("xattr", ["-cr", path]);
}

function unzipTo(zipPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  // ditto preserves structure and is the macOS-native extractor; fall back to unzip.
  const r = run("ditto", ["-x", "-k", "--sequesterRsrc", zipPath, destDir]);
  if (r.code !== 0) {
    const u = run("unzip", ["-q", "-o", zipPath, "-d", destDir]);
    if (u.code !== 0) {
      throw new Error(`Failed to unzip ${zipPath}: ${r.stderr || u.stderr}`);
    }
  }
  assertNoPathEscape(destDir);
}

/**
 * Guard against zip-slip. Both extractors (`ditto -x -k` and `unzip`) already
 * sanitize `../` path entries — verified: a crafted archive's `../../escape`
 * entry lands inside destDir, not the parent. So this walk's real job is the
 * SYMLINK vector: an in-tree symlink whose realpath stays inside passes a naive
 * location check yet still lets later cpSync staging follow it out of the package.
 * It also backstops any future extractor that's less strict about path entries.
 */
function assertNoPathEscape(destDir: string): void {
  const root = realpathSync(resolve(destDir));
  const prefix = root.endsWith(sep) ? root : root + sep;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      // Reject symlinks outright. realpathSync below resolves them, so a symlink
      // whose target is INSIDE the tree would pass the location check yet still
      // let later cpSync staging follow the link out of the package.
      if (entry.isSymbolicLink() || lstatSync(full).isSymbolicLink()) {
        rmSync(destDir, { recursive: true, force: true });
        throw new Error(`Refusing archive: contains a symlink (zip-slip risk): ${entry.name}`);
      }
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (real !== root && !real.startsWith(prefix)) {
        rmSync(destDir, { recursive: true, force: true });
        throw new Error(`Refusing archive: entry escapes extraction directory (zip-slip): ${entry.name}`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
}

/** Parse a .crx (Chrome) container, returning the embedded ZIP bytes. */
function crxToZip(crxPath: string): Buffer {
  const buf = readFileSync(crxPath);
  if (buf.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error(`Invalid CRX file (bad magic): ${crxPath}`);
  }
  // Magic (4) + version (4) = 8 bytes minimum before we can read the version.
  if (buf.length < 8) throw new Error(`Invalid CRX file (truncated header): ${crxPath}`);
  const version = buf.readUInt32LE(4);
  let zipStart: number;
  if (version === 2) {
    // v2 header: magic(4) version(4) pubKeyLen(4) sigLen(4) = 16 bytes min.
    if (buf.length < 16) throw new Error(`Invalid CRX file (truncated v2 header): ${crxPath}`);
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else if (version === 3) {
    // v3 header: magic(4) version(4) headerLen(4) = 12 bytes min.
    if (buf.length < 12) throw new Error(`Invalid CRX file (truncated v3 header): ${crxPath}`);
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }
  if (!Number.isFinite(zipStart) || zipStart < 0 || zipStart >= buf.length) {
    // >= : a header that fills the whole file leaves a 0-byte ZIP, which would
    // fail later with a vague unzip error instead of this CRX-specific one.
    throw new Error(`Invalid CRX file (no ZIP payload after header): ${crxPath}`);
  }
  return buf.subarray(zipStart);
}

/**
 * Resolve the directory that actually contains manifest.json.
 * Many zips wrap the extension in a single top-level folder.
 */
function resolveExtensionRoot(dir: string): string {
  if (existsSync(join(dir, "manifest.json"))) return dir;
  const entries = readdirSync(dir).filter((e) => !e.startsWith("__MACOSX") && e !== ".DS_Store");
  const subdirs = entries.filter((e) => {
    try {
      return statSync(join(dir, e)).isDirectory();
    } catch {
      return false; // broken symlink or unreadable entry
    }
  });
  if (subdirs.length === 1 && existsSync(join(dir, subdirs[0], "manifest.json"))) {
    return join(dir, subdirs[0]);
  }
  // A repo-style layout nests the extension alongside siblings that are NOT the
  // extension (host binaries, docs, build scripts) — e.g. the Chrome
  // native-messaging sample's `extension/` + `host/` + `README.md`. The single
  // top-level-folder check above misses that. So when the root has no manifest,
  // look for subdirs that DO carry one: if exactly one does, descend into it.
  // Two or more is ambiguous (a monorepo of extensions) — stay put and let the
  // caller error rather than silently pick the wrong one.
  const manifestSubdirs = subdirs.filter((e) => existsSync(join(dir, e, "manifest.json")));
  if (manifestSubdirs.length === 1) {
    return join(dir, manifestSubdirs[0]);
  }
  return dir;
}

/**
 * Sniff the archive kind from MAGIC BYTES, not the file extension. Users often
 * download a CRX renamed to .zip (or a zip-based .xpi), so trust the content:
 * "Cr24" → crx, "PK\x03\x04" → zip. Returns null when neither magic matches.
 */
function sniffArchiveKind(path: string): "crx" | "zip" | null {
  const head = Buffer.alloc(4);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (head.toString("ascii") === "Cr24") return "crx";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return "zip";
  return null;
}

/**
 * Extract a .zip / .crx archive (or pass through a directory) into scratchDir.
 * Returns the path to the extension root (the folder holding manifest.json).
 */
export function extractExtension(inputPath: string, scratchDir: string): string {
  const stat = statSync(inputPath);
  if (stat.isDirectory()) {
    const root = resolveExtensionRoot(inputPath);
    cleanExtendedAttributes(root);
    return root;
  }

  const destDir = join(scratchDir, "extension");
  mkdirSync(destDir, { recursive: true });

  // Prefer magic bytes (authoritative) over the extension (a renamed CRX/.xpi is
  // common); fall back to the suffix only when the bytes are inconclusive.
  const suffix = extname(inputPath).toLowerCase();
  const kind = sniffArchiveKind(inputPath) ?? (suffix === ".crx" ? "crx" : suffix === ".zip" || suffix === ".xpi" ? "zip" : null);

  if (kind === "crx") {
    const zipBytes = crxToZip(inputPath);
    const tmpZip = join(scratchDir, "payload.zip");
    writeFileSync(tmpZip, zipBytes);
    unzipTo(tmpZip, destDir);
  } else if (kind === "zip") {
    unzipTo(inputPath, destDir);
  } else {
    throw new Error(`Unsupported input "${inputPath}": not a CRX or ZIP archive (or a directory).`);
  }

  const root = resolveExtensionRoot(destDir);
  cleanExtendedAttributes(root);
  return root;
}
