import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Manifest } from "../types.js";

const SIZES = [48, 128, 256, 512];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** Build a size×size solid-RGB PNG. No deps beyond zlib. */
function solidPng(size: number, r: number, g: number, b: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type 2 = truecolor RGB
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  // Each scanline: 1 filter byte (0) + size pixels × 3 bytes.
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Deterministic pleasant color from the app name (stable across runs). */
function colorFor(seed: string): [number, number, number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  // Mid-brightness so the toolbar glyph stays visible on light and dark chrome.
  const hue = h % 360;
  return hslToRgb(hue, 0.55, 0.5);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * When the extension ships no icons, Safari shows a blank toolbar glyph and the
 * App Store rejects the upload. Synthesize a solid-color placeholder set so the
 * build is usable; the color is derived from the app name so it's at least
 * distinguishable. Mutates `manifest.icons` (and the action's default_icon).
 * No-op when the manifest already declares any icon. Returns the sizes written.
 */
export function synthesizePlaceholderIcons(stageDir: string, manifest: Manifest, appName: string): number[] {
  if (manifest.icons && Object.keys(manifest.icons).length > 0) return [];
  // MV3 allows icons declared only under action.default_icon — respect those too.
  const existingAction = (manifest.action ?? manifest.browser_action) as Record<string, unknown> | undefined;
  const actionIcon = existingAction?.default_icon;
  if (actionIcon && (typeof actionIcon === "string" || Object.keys(actionIcon).length > 0)) return [];

  const [r, g, b] = colorFor(appName);
  const icons: Record<string, string> = {};
  for (const size of SIZES) {
    const name = `icon-${size}.png`;
    writeFileSync(join(stageDir, name), solidPng(size, r, g, b));
    icons[String(size)] = name;
  }
  manifest.icons = icons;

  // Wire the toolbar button to the same set if an action exists.
  const action = (manifest.action ?? manifest.browser_action) as Record<string, unknown> | undefined;
  if (action && !action.default_icon) action.default_icon = { ...icons };

  return SIZES;
}
