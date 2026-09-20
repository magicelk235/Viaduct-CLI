import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { run } from "../util.js";
import type { Manifest } from "../types.js";

/**
 * Apple's packager bakes the extension icon onto an opaque white squircle in
 * AppIcon.appiconset, so the Dock/Finder icon stays white in Dark Mode. Icon
 * Composer bundles (`AppIcon.icon`, Xcode 26+) carry per-appearance fills that
 * the system picks at render time, and Xcode still renders a flat fallback
 * from the same bundle for macOS < 26. This module writes one next to every
 * asset catalog the project has and wires it into the pbxproj; the appiconset
 * stays as-is since Xcode prefers the .icon when both share the AppIcon name.
 */

const LIGHT_FILL = "extended-srgb:1.00000,1.00000,1.00000,1.00000";
const DARK_FILL = "extended-srgb:0.14000,0.14000,0.15000,1.00000";
// Icon Composer's canvas is 1024pt and a layer image renders at its native pixel
// size, so the glyph's scale must be derived from the source dimensions.
const CANVAS = 1024;
// Glyph footprint inside the squircle. Matches the packager's composite, where
// the icon spans ~75% of the visible plate.
const GLYPH_FRACTION = 0.72;

/**
 * Pixel size of a PNG (IHDR) or SVG (viewBox, else width/height). Null when the
 * file carries neither, in which case the layer is assumed to fill the canvas.
 */
export function imageSize(path: string): { width: number; height: number } | null {
  const buf = readFileSync(path);
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  const svg = buf.toString("utf-8", 0, Math.min(buf.length, 4096));
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!open) return null;
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(open);
  if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  const w = /\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(open);
  const h = /\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(open);
  return w && h ? { width: Number(w[1]), height: Number(h[1]) } : null;
}

/** Major version of the selected Xcode, or null when xcodebuild is unusable. */
export function xcodeMajorVersion(): number | null {
  const res = run("xcodebuild", ["-version"]);
  if (res.code !== 0) return null;
  const m = /^Xcode (\d+)/m.exec(res.stdout);
  return m ? Number(m[1]) : null;
}

/**
 * The extension icon best suited as the .icon layer: the largest `icons` entry,
 * else the largest `action.default_icon`. Only PNG/SVG, and only if the file is
 * actually staged; anything else returns null and the packager's icon stands.
 */
export function sourceIconFor(manifest: Manifest, stageDir: string): string | null {
  const action = (manifest.action ?? manifest.browser_action) as Record<string, unknown> | undefined;
  const candidates: Array<Record<string, unknown> | string | undefined> = [manifest.icons as Record<string, unknown> | undefined, action?.default_icon as Record<string, unknown> | string | undefined];
  for (const set of candidates) {
    if (!set) continue;
    const paths =
      typeof set === "string"
        ? [set]
        : Object.entries(set)
            .filter(([, v]) => typeof v === "string")
            .sort(([a], [b]) => Number(b) - Number(a))
            .map(([, v]) => v as string);
    for (const rel of paths) {
      const ext = extname(rel).toLowerCase();
      if (ext !== ".png" && ext !== ".svg") continue;
      const full = join(stageDir, rel.replace(/^\/+/, ""));
      if (existsSync(full)) return full;
    }
  }
  return null;
}

export interface GlyphStats {
  /** Share of pixels with alpha ≥ 0.5. 1 means an opaque square. */
  coverage: number;
  /** Mean Rec.709 luminance of those pixels, 0–1. */
  luminance: number;
  /** Mean (max−min) channel spread of those pixels, 0–1. 0 is pure grayscale. */
  chroma: number;
}

/**
 * Pixel statistics of a PNG via `sips` → 32-bit BMP (sips handles every PNG
 * variant; BMP is trivial to read). Null when sips can't convert it.
 */
export function glyphStats(pngPath: string): GlyphStats | null {
  const scratch = mkdtempSync(join(tmpdir(), "viaduct-icon-"));
  try {
    const bmp = join(scratch, "icon.bmp");
    const res = run("sips", ["-s", "format", "bmp", pngPath, "--out", bmp]);
    if (res.code !== 0 || !existsSync(bmp)) return null;
    return bmpStats(readFileSync(bmp));
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function maskShift(mask: number): number {
  if (mask === 0) return -1;
  let s = 0;
  while (((mask >>> s) & 1) === 0) s++;
  return s;
}

export function bmpStats(buf: Buffer): GlyphStats | null {
  if (buf.length < 54 || buf.toString("ascii", 0, 2) !== "BM") return null;
  const dataOffset = buf.readUInt32LE(10);
  const dibSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 32 || (compression !== 0 && compression !== 3) || width <= 0 || height === 0) return null;
  // BI_BITFIELDS with a V3+ header carries explicit channel masks; BI_RGB is BGRA.
  const masks =
    compression === 3 && dibSize >= 56
      ? [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), buf.readUInt32LE(66)]
      : [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000];
  const [rs, gs, bs, as] = masks.map(maskShift);
  const total = width * height;
  if (buf.length < dataOffset + total * 4) return null;

  let opaque = 0;
  let lum = 0;
  let chroma = 0;
  for (let i = 0; i < total; i++) {
    const px = buf.readUInt32LE(dataOffset + i * 4);
    // No alpha channel → treat every pixel as opaque.
    const a = as < 0 ? 255 : (px >>> as) & 0xff;
    if (a < 128) continue;
    const r = ((px >>> rs) & 0xff) / 255;
    const g = ((px >>> gs) & 0xff) / 255;
    const b = ((px >>> bs) & 0xff) / 255;
    opaque++;
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  if (opaque === 0) return { coverage: 0, luminance: 0, chroma: 0 };
  return { coverage: opaque / total, luminance: lum / opaque, chroma: chroma / opaque };
}

/**
 * A near-black, near-grayscale glyph (a silhouette logo) vanishes on the dark
 * plate; the dark appearance repaints it white, the way Apple's own mono icons
 * do. Opaque squares are left alone: filling one white would erase whatever is
 * drawn inside it.
 */
export function invertsInDark(stats: GlyphStats | null): boolean {
  return !!stats && stats.coverage < 0.85 && stats.luminance < 0.3 && stats.chroma < 0.12;
}

export function iconComposerJson(imageName: string, size: { width: number; height: number } | null, invertInDark: boolean): string {
  const longest = size ? Math.max(size.width, size.height) : CANVAS;
  const layer: Record<string, unknown> = {
    "image-name": imageName,
    name: "icon",
    position: { scale: Number(((GLYPH_FRACTION * CANVAS) / longest).toFixed(4)), "translation-in-points": [0, 0] },
  };
  if (invertInDark) {
    layer["fill-specializations"] = [
      { value: "automatic" },
      { appearance: "dark", value: { solid: LIGHT_FILL } },
    ];
  }
  const doc = {
    "fill-specializations": [
      { value: { "automatic-gradient": LIGHT_FILL } },
      { appearance: "dark", value: { "automatic-gradient": DARK_FILL } },
    ],
    groups: [
      {
        layers: [layer],
        shadow: { kind: "neutral", opacity: 0.5 },
        // Off: the glass tint washes brand colors toward the plate color.
        translucency: { enabled: false, value: 0.5 },
      },
    ],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Write `AppIcon.icon` into `dir`, with the source image copied as its only layer. */
export function writeIconBundle(dir: string, sourceIcon: string, invertInDark: boolean): void {
  const bundle = join(dir, "AppIcon.icon");
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Assets"), { recursive: true });
  const imageName = `icon${extname(sourceIcon).toLowerCase()}`;
  copyFileSync(sourceIcon, join(bundle, "Assets", imageName));
  writeFileSync(join(bundle, "icon.json"), iconComposerJson(imageName, imageSize(sourceIcon), invertInDark), "utf-8");
}

function pbxId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24).toUpperCase();
}

interface PbxGroup {
  id: string;
  path: string | null;
  children: string[];
}

function parseGroups(pbx: string): PbxGroup[] {
  const groups: PbxGroup[] = [];
  const re = /\t\t([0-9A-F]{24})[^\n]*= \{\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = \(\n([\s\S]*?)\t\t\t\);\n([\s\S]*?)\t\t\};/g;
  for (const m of pbx.matchAll(re)) {
    const children = Array.from(m[2].matchAll(/^\t\t\t\t([0-9A-F]{24}) /gm), (c) => c[1]);
    const p = /^\t\t\tpath = "?([^";]+)"?;/m.exec(m[3]);
    groups.push({ id: m[1], path: p ? p[1] : null, children });
  }
  return groups;
}

/** Directory of a file reference on disk, walking its group chain up to the root. */
function groupDir(groups: PbxGroup[], fileRef: string, root: string): string | null {
  const segments: string[] = [];
  let child = fileRef;
  for (let depth = 0; depth < 16; depth++) {
    const parent = groups.find((g) => g.children.includes(child));
    if (!parent) return depth === 0 ? null : join(root, ...segments.reverse());
    if (parent.path) segments.push(parent.path);
    child = parent.id;
  }
  return null;
}

/**
 * Add an appearance-aware `AppIcon.icon` beside every `Assets.xcassets` the project
 * references and register it (file reference, group child, Resources build file)
 * so actool compiles it. Returns the bundle paths written; empty when the project
 * already has one or has no asset catalog to sit next to.
 */
export function writeAppearanceAwareIcon(xcodeproj: string, sourceIcon: string, invertInDark: boolean): string[] {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (!existsSync(pbxproj)) return [];
  let pbx = readFileSync(pbxproj, "utf-8");
  if (pbx.includes("folder.iconcomposer.icon")) return [];
  const root = dirname(xcodeproj);
  const groups = parseGroups(pbx);
  const written: string[] = [];

  const catalogs = Array.from(pbx.matchAll(/^\t\t([0-9A-F]{24}) \/\* [^*]*\*\/ = \{isa = PBXFileReference;[^\n]*lastKnownFileType = folder\.assetcatalog;[^\n]*\};$/gm));
  for (const cat of catalogs) {
    const catRef = cat[1];
    const dir = groupDir(groups, catRef, root);
    if (!dir || !existsSync(join(dir, "Assets.xcassets"))) continue;
    const buildFiles = Array.from(pbx.matchAll(new RegExp(`^\\t\\t([0-9A-F]{24}) /\\* [^*]*\\*/ = \\{isa = PBXBuildFile; fileRef = ${catRef} [^\\n]*\\};$`, "gm")));
    if (buildFiles.length === 0) continue;

    const iconRef = pbxId(`viaduct-appicon-ref:${catRef}`);
    pbx = pbx.replace(
      cat[0],
      `${cat[0]}\n\t\t${iconRef} /* AppIcon.icon */ = {isa = PBXFileReference; lastKnownFileType = folder.iconcomposer.icon; path = AppIcon.icon; sourceTree = "<group>"; };`,
    );
    pbx = pbx.replace(new RegExp(`^(\\t\\t\\t\\t${catRef} /\\* [^*]*\\*/,)$`, "m"), `$1\n\t\t\t\t${iconRef} /* AppIcon.icon */,`);
    for (const bf of buildFiles) {
      const buildId = pbxId(`viaduct-appicon-build:${bf[1]}`);
      pbx = pbx.replace(bf[0], `${bf[0]}\n\t\t${buildId} /* AppIcon.icon in Resources */ = {isa = PBXBuildFile; fileRef = ${iconRef} /* AppIcon.icon */; };`);
      pbx = pbx.replace(new RegExp(`^(\\t\\t\\t\\t${bf[1]} /\\* [^*]*\\*/,)$`, "m"), `$1\n\t\t\t\t${buildId} /* AppIcon.icon in Resources */,`);
    }
    writeIconBundle(dir, sourceIcon, invertInDark);
    written.push(join(dir, "AppIcon.icon"));
  }
  if (written.length > 0) writeFileSync(pbxproj, pbx, "utf-8");
  return written;
}
