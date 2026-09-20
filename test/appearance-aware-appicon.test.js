import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import {
  sourceIconFor,
  bmpStats,
  invertsInDark,
  imageSize,
  iconComposerJson,
  writeAppearanceAwareIcon,
} from "../dist/build/appicon.js";

// Apple's packager composites the extension icon onto an opaque white plate, so
// the Dock icon stays white in Dark Mode. viaduct adds an Icon Composer bundle
// with a dark-appearance fill next to the packager's asset catalog.

/** Minimal RGBA PNG: only IHDR matters for imageSize; the rest keeps it a valid file. */
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 4) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 32-bit BI_BITFIELDS BMP (what sips emits) from an array of [r,g,b,a] pixels. */
function bmp(pixels) {
  const w = pixels.length;
  const header = Buffer.alloc(138);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(138 + w * 4, 2);
  header.writeUInt32LE(138, 10);
  header.writeUInt32LE(124, 14);
  header.writeInt32LE(w, 18);
  header.writeInt32LE(1, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(0x00ff0000, 54);
  header.writeUInt32LE(0x0000ff00, 58);
  header.writeUInt32LE(0x000000ff, 62);
  header.writeUInt32LE(0xff000000, 66);
  const data = Buffer.alloc(w * 4);
  pixels.forEach(([r, g, b, a], i) => data.writeUInt32LE(((a << 24) | (r << 16) | (g << 8) | b) >>> 0, i * 4));
  return Buffer.concat([header, data]);
}

// The packager's own project layout: <root>/<App>/Assets.xcassets referenced from a
// group with `path = <App>`, one build file in the app target's Resources phase.
const PBXPROJ = `// !$*UTF8*$!
{
	objects = {
/* Begin PBXBuildFile section */
		AAAAAAAAAAAAAAAAAAAAAAA1 /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = AAAAAAAAAAAAAAAAAAAAAAA2 /* Assets.xcassets */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
		AAAAAAAAAAAAAAAAAAAAAAA2 /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
		AAAAAAAAAAAAAAAAAAAAAAA3 = {
			isa = PBXGroup;
			children = (
				AAAAAAAAAAAAAAAAAAAAAAA4 /* App */,
			);
			sourceTree = "<group>";
		};
		AAAAAAAAAAAAAAAAAAAAAAA4 /* App */ = {
			isa = PBXGroup;
			children = (
				AAAAAAAAAAAAAAAAAAAAAAA2 /* Assets.xcassets */,
			);
			path = App;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXResourcesBuildPhase section */
		AAAAAAAAAAAAAAAAAAAAAAA5 /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			files = (
				AAAAAAAAAAAAAAAAAAAAAAA1 /* Assets.xcassets in Resources */,
			);
		};
/* End PBXResourcesBuildPhase section */
	};
}
`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-appicon-"));
  const xcodeproj = join(dir, "App.xcodeproj");
  mkdirSync(join(dir, "App", "Assets.xcassets", "AppIcon.appiconset"), { recursive: true });
  mkdirSync(xcodeproj);
  writeFileSync(join(xcodeproj, "project.pbxproj"), PBXPROJ, "utf-8");
  const icon = join(dir, "icon-128.png");
  writeFileSync(icon, png(128, 128));
  return { dir, xcodeproj, icon };
}

test("sourceIconFor prefers the largest manifest icon, then the action icon, and skips missing or non-image files", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-srcicon-"));
  try {
    writeFileSync(join(dir, "small.png"), "");
    writeFileSync(join(dir, "big.png"), "");
    writeFileSync(join(dir, "act.svg"), "");
    assert.equal(sourceIconFor({ icons: { 16: "small.png", 128: "big.png" } }, dir), join(dir, "big.png"));
    // 256 is declared but missing on disk → fall through to the next largest.
    assert.equal(sourceIconFor({ icons: { 256: "gone.png", 128: "big.png", 16: "small.png" } }, dir), join(dir, "big.png"));
    // Leading slash (manifest-root absolute) resolves inside the stage dir.
    assert.equal(sourceIconFor({ icons: { 128: "/big.png" } }, dir), join(dir, "big.png"));
    // No `icons` → action.default_icon, string or size map.
    assert.equal(sourceIconFor({ action: { default_icon: "act.svg" } }, dir), join(dir, "act.svg"));
    assert.equal(sourceIconFor({ browser_action: { default_icon: { 19: "act.svg" } } }, dir), join(dir, "act.svg"));
    // Formats Icon Composer can't take are not candidates.
    writeFileSync(join(dir, "photo.jpg"), "");
    assert.equal(sourceIconFor({ icons: { 128: "photo.jpg" } }, dir), null);
    assert.equal(sourceIconFor({}, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dark grayscale silhouette inverts in Dark Mode; colored, light, or opaque-square glyphs do not", () => {
  const T = [0, 0, 0, 0];
  const black = [20, 20, 22, 255];
  // Half-covered black glyph → would vanish on the dark plate.
  assert.equal(invertsInDark(bmpStats(bmp([black, black, T, T]))), true);
  // Same glyph in red: chroma keeps it visible.
  assert.equal(invertsInDark(bmpStats(bmp([[200, 30, 30, 255], [200, 30, 30, 255], T, T]))), false);
  // Light gray glyph: already visible on dark.
  assert.equal(invertsInDark(bmpStats(bmp([[230, 230, 230, 255], [230, 230, 230, 255], T, T]))), false);
  // Opaque black square: filling it white would erase whatever is drawn on it.
  assert.equal(invertsInDark(bmpStats(bmp([black, black, black, black]))), false);
  // Semi-transparent pixels below 50% alpha don't count as glyph.
  const faint = [20, 20, 22, 100];
  assert.equal(bmpStats(bmp([faint, faint, T, T])).coverage, 0);
  // Not a BMP / unsupported depth → null, and null never inverts.
  assert.equal(bmpStats(Buffer.from("PNG junk")), null);
  assert.equal(invertsInDark(null), false);
});

test("imageSize reads PNG IHDR and SVG viewBox or width/height", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-imgsize-"));
  try {
    writeFileSync(join(dir, "a.png"), png(800, 801));
    assert.deepEqual(imageSize(join(dir, "a.png")), { width: 800, height: 801 });
    writeFileSync(join(dir, "vb.svg"), `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" viewBox="0 0 48 32"><rect/></svg>`);
    assert.deepEqual(imageSize(join(dir, "vb.svg")), { width: 48, height: 32 });
    writeFileSync(join(dir, "wh.svg"), `<svg width="64px" height='64'></svg>`);
    assert.deepEqual(imageSize(join(dir, "wh.svg")), { width: 64, height: 64 });
    writeFileSync(join(dir, "none.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`);
    assert.equal(imageSize(join(dir, "none.svg")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("icon.json scales the layer from its pixel size and only adds a dark glyph fill when asked", () => {
  // Layers render at native pixel size on a 1024pt canvas: a 128px glyph needs
  // scale ×8 to fill the canvas, times the 0.72 plate fraction.
  const small = JSON.parse(iconComposerJson("icon.png", { width: 128, height: 128 }, false));
  assert.equal(small.groups[0].layers[0].position.scale, 5.76);
  const wide = JSON.parse(iconComposerJson("icon.png", { width: 1024, height: 512 }, false));
  assert.equal(wide.groups[0].layers[0].position.scale, 0.72);
  const unknown = JSON.parse(iconComposerJson("icon.svg", null, false));
  assert.equal(unknown.groups[0].layers[0].position.scale, 0.72);

  // Plate: light by default, dark under the dark appearance.
  const fills = small["fill-specializations"];
  assert.equal(fills.length, 2);
  assert.equal(fills[0].appearance, undefined);
  assert.equal(fills[1].appearance, "dark");
  assert.notEqual(fills[0].value["automatic-gradient"], fills[1].value["automatic-gradient"]);

  // Glyph keeps its own colors unless inversion was requested.
  assert.equal(small.groups[0].layers[0]["fill-specializations"], undefined);
  const inverted = JSON.parse(iconComposerJson("icon.png", { width: 128, height: 128 }, true));
  const glyphFills = inverted.groups[0].layers[0]["fill-specializations"];
  assert.deepEqual(glyphFills[0], { value: "automatic" });
  assert.equal(glyphFills[1].appearance, "dark");
  assert.ok(glyphFills[1].value.solid);
});

test("writeAppearanceAwareIcon writes AppIcon.icon beside the asset catalog and registers it in the pbxproj", () => {
  const { dir, xcodeproj, icon } = project();
  try {
    const written = writeAppearanceAwareIcon(xcodeproj, icon, false);
    assert.deepEqual(written, [join(dir, "App", "AppIcon.icon")]);
    assert.ok(existsSync(join(dir, "App", "AppIcon.icon", "icon.json")));
    assert.ok(existsSync(join(dir, "App", "AppIcon.icon", "Assets", "icon.png")));
    // The packager's catalog is left in place: Xcode prefers the .icon and still
    // has the appiconset if the .icon is ever removed.
    assert.ok(existsSync(join(dir, "App", "Assets.xcassets", "AppIcon.appiconset")));

    const pbx = readFileSync(join(xcodeproj, "project.pbxproj"), "utf-8");
    const ref = /^\t\t([0-9A-F]{24}) \/\* AppIcon\.icon \*\/ = \{isa = PBXFileReference; lastKnownFileType = folder\.iconcomposer\.icon; path = AppIcon\.icon; sourceTree = "<group>"; \};$/m.exec(pbx);
    assert.ok(ref, "file reference registered");
    const build = new RegExp(`^\\t\\t([0-9A-F]{24}) /\\* AppIcon\\.icon in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref[1]} /\\* AppIcon\\.icon \\*/; \\};$`, "m").exec(pbx);
    assert.ok(build, "build file points at the new reference");
    // Sits in the same group as the catalog (so `path = App` resolves it) …
    assert.match(pbx, new RegExp(`AAAAAAAAAAAAAAAAAAAAAAA2 /\\* Assets\\.xcassets \\*/,\\n\\t\\t\\t\\t${ref[1]} /\\* AppIcon\\.icon \\*/,\\n\\t\\t\\t\\);\\n\\t\\t\\tpath = App;`));
    // … and in the same Resources phase as the catalog's build file.
    assert.match(pbx, new RegExp(`AAAAAAAAAAAAAAAAAAAAAAA1 /\\* Assets\\.xcassets in Resources \\*/,\\n\\t\\t\\t\\t${build[1]} /\\* AppIcon\\.icon in Resources \\*/,`));

    // Second run is a no-op: no duplicate entries.
    assert.deepEqual(writeAppearanceAwareIcon(xcodeproj, icon, false), []);
    assert.equal(readFileSync(join(xcodeproj, "project.pbxproj"), "utf-8"), pbx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAppearanceAwareIcon leaves a project alone when the catalog it references is not on disk", () => {
  const { dir, xcodeproj, icon } = project();
  try {
    rmSync(join(dir, "App", "Assets.xcassets"), { recursive: true, force: true });
    assert.deepEqual(writeAppearanceAwareIcon(xcodeproj, icon, false), []);
    assert.equal(readFileSync(join(xcodeproj, "project.pbxproj"), "utf-8"), PBXPROJ);
    assert.ok(!existsSync(join(dir, "App", "AppIcon.icon")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
