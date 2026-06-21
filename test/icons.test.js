import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizePlaceholderIcons } from "../dist/icons.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function staging() {
  return mkdtempSync(join(tmpdir(), "icons-"));
}

test("synthesizePlaceholderIcons writes valid PNGs and wires manifest.icons", () => {
  const dir = staging();
  const manifest = { action: {} };
  const sizes = synthesizePlaceholderIcons(dir, manifest, "My Ext 🚀");
  assert.deepEqual(sizes, [48, 128, 256, 512]);
  for (const s of sizes) {
    const file = join(dir, `icon-${s}.png`);
    assert.ok(existsSync(file), `icon-${s}.png exists`);
    const buf = readFileSync(file);
    // Valid PNG signature.
    assert.ok(buf.subarray(0, 8).equals(PNG_SIG), `icon-${s}.png has a PNG signature`);
    // IHDR width/height (bytes 16-23) must equal the declared size — proves the
    // dimension bytes aren't transposed/off-by-one.
    assert.equal(buf.readUInt32BE(16), s, `IHDR width = ${s}`);
    assert.equal(buf.readUInt32BE(20), s, `IHDR height = ${s}`);
    // Ends with the IEND chunk.
    assert.equal(buf.subarray(buf.length - 8, buf.length - 4).toString("ascii"), "IEND");
  }
  assert.deepEqual(manifest.icons, {
    48: "icon-48.png", 128: "icon-128.png", 256: "icon-256.png", 512: "icon-512.png",
  });
  // Action's default_icon gets wired to the same set.
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
});

test("synthesizePlaceholderIcons is a no-op when manifest already declares icons", () => {
  const dir = staging();
  const manifest = { icons: { 16: "real.png" } };
  assert.deepEqual(synthesizePlaceholderIcons(dir, manifest, "x"), []);
  assert.deepEqual(manifest.icons, { 16: "real.png" }, "existing icons untouched");
});

test("synthesizePlaceholderIcons respects icons declared only under action.default_icon", () => {
  const dir = staging();
  const manifest = { action: { default_icon: "toolbar.png" } };
  assert.deepEqual(synthesizePlaceholderIcons(dir, manifest, "x"), []);
  assert.equal(manifest.icons, undefined, "no placeholder icons synthesized");
});

test("synthesizePlaceholderIcons color is deterministic for a given name", () => {
  const a = staging(), b = staging();
  synthesizePlaceholderIcons(a, { action: {} }, "Stable Name");
  synthesizePlaceholderIcons(b, { action: {} }, "Stable Name");
  // Same name → byte-identical PNGs (deterministic color from the name).
  assert.ok(readFileSync(join(a, "icon-48.png")).equals(readFileSync(join(b, "icon-48.png"))));
});
