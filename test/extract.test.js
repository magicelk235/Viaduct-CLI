import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExtension } from "../dist/input/extract.js";

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

// Zip a directory with macOS-native ditto. keepParent=true wraps the contents in
// a top-level folder, exercising resolveExtensionRoot's single-wrapper unwrapping.
function zipDir(dir, keepParent = false) {
  const out = join(tmpdir(), `z-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const args = ["-c", "-k", "--sequesterRsrc"];
  if (keepParent) args.push("--keepParent");
  execFileSync("ditto", [...args, dir, out]);
  return out;
}

function manifestDir(extra = {}) {
  const d = tmp("ext-");
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "T", version: "1.0", ...extra }));
  return d;
}

test("extractExtension reads a plain zip and finds the manifest", () => {
  const zip = zipDir(manifestDir());
  const root = extractExtension(zip, tmp("out-"));
  const mf = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
  assert.equal(mf.name, "T");
});

test("extractExtension unwraps a single top-level folder (keepParent zip)", () => {
  const zip = zipDir(manifestDir(), true);
  const root = extractExtension(zip, tmp("out-"));
  assert.ok(readFileSync(join(root, "manifest.json"), "utf-8").includes('"name"'));
});

test("extractExtension descends into the lone manifest-bearing subdir among siblings", () => {
  // Repo-style layout: extension/ + host/ + README.md (Chrome native-messaging
  // sample). No root manifest; only `extension/` carries one — descend into it.
  const d = tmp("nested-");
  mkdirSync(join(d, "extension"), { recursive: true });
  mkdirSync(join(d, "host"), { recursive: true });
  writeFileSync(join(d, "extension", "manifest.json"), JSON.stringify({ name: "Nested", version: "1.0.0" }));
  writeFileSync(join(d, "host", "echo.json"), "{}");
  writeFileSync(join(d, "README.md"), "# docs");
  const root = extractExtension(d, tmp("out-"));
  assert.equal(JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8")).name, "Nested");
});

test("extractExtension stays put when two subdirs each carry a manifest (ambiguous)", () => {
  const d = tmp("monorepo-");
  mkdirSync(join(d, "ext-a"), { recursive: true });
  mkdirSync(join(d, "ext-b"), { recursive: true });
  writeFileSync(join(d, "ext-a", "manifest.json"), "{}");
  writeFileSync(join(d, "ext-b", "manifest.json"), "{}");
  const root = extractExtension(d, tmp("out-"));
  // Ambiguous → don't guess; return the dir as-is (caller errors on no manifest).
  assert.equal(root, d);
});

test("extractExtension parses a CRX3 container by magic bytes (even named .zip)", () => {
  const zipBytes = readFileSync(zipDir(manifestDir({ name: "CrxV3" })));
  // CRX3 header: "Cr24" + version(3, LE) + headerLen(LE) + header + embedded zip.
  const header = Buffer.from([0xaa, 0xbb, 0xcc]);
  const h = Buffer.alloc(12);
  h.write("Cr24", 0, "ascii");
  h.writeUInt32LE(3, 4);
  h.writeUInt32LE(header.length, 8);
  const crx = Buffer.concat([h, header, zipBytes]);
  // Name it .zip to prove magic-byte sniffing (not the suffix) drives detection.
  const crxPath = join(tmpdir(), `mislabeled-${Date.now()}.zip`);
  writeFileSync(crxPath, crx);
  const root = extractExtension(crxPath, tmp("out-"));
  const mf = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));
  assert.equal(mf.name, "CrxV3");
});

test("extractExtension rejects an archive containing a symlink (zip-slip guard)", () => {
  const d = manifestDir();
  symlinkSync("/etc/passwd", join(d, "link.txt"));
  const zip = zipDir(d, true); // keepParent so the symlink survives in the archive
  assert.throws(
    () => extractExtension(zip, tmp("out-")),
    /symlink|zip-slip/i
  );
});

test("extractExtension throws a clear error on a non-archive input", () => {
  const junk = join(tmpdir(), `junk-${Date.now()}.bin`);
  writeFileSync(junk, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.throws(() => extractExtension(junk, tmp("out-")), /not a CRX or ZIP/i);
});

test("extractExtension passes through an unpacked directory", () => {
  const d = manifestDir({ name: "Unpacked" });
  const root = extractExtension(d, tmp("out-"));
  assert.equal(JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8")).name, "Unpacked");
});
