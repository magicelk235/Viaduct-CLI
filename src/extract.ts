import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { run } from "./util.js";

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
}

/** Parse a .crx (Chrome) container, returning the embedded ZIP bytes. */
function crxToZip(crxPath: string): Buffer {
  const buf = readFileSync(crxPath);
  if (buf.subarray(0, 4).toString("ascii") !== "Cr24") {
    throw new Error(`Invalid CRX file (bad magic): ${crxPath}`);
  }
  const version = buf.readUInt32LE(4);
  let zipStart: number;
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    zipStart = 16 + pubKeyLen + sigLen;
  } else if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    zipStart = 12 + headerLen;
  } else {
    throw new Error(`Unsupported CRX version: ${version}`);
  }
  if (!Number.isFinite(zipStart) || zipStart < 0 || zipStart > buf.length) {
    throw new Error(`Invalid CRX file (header points past end of file): ${crxPath}`);
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
  return dir;
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

  const suffix = extname(inputPath).toLowerCase();
  const destDir = join(scratchDir, "extension");
  mkdirSync(destDir, { recursive: true });

  if (suffix === ".crx") {
    const zipBytes = crxToZip(inputPath);
    const tmpZip = join(scratchDir, "payload.zip");
    writeFileSync(tmpZip, zipBytes);
    unzipTo(tmpZip, destDir);
  } else if (suffix === ".zip") {
    unzipTo(inputPath, destDir);
  } else {
    throw new Error(`Unsupported input type "${suffix}". Use a .zip, .crx, or a directory.`);
  }

  const root = resolveExtensionRoot(destDir);
  cleanExtendedAttributes(root);
  return root;
}
