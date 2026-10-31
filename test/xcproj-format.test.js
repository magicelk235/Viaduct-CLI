import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchProjectBundleIds, setBuildVersion, unsandboxAppTarget, grantDownloadsFolder } from "../dist/build/packager.js";
import { writeAppearanceAwareIcon } from "../dist/build/appicon.js";
import { deflateSync } from "node:zlib";

// Xcode 27's packager writes project.xcproj (JSON with trailing commas) instead of
// project.pbxproj. Every project patch used to look for the plist only, so on Xcode 27
// none of them ran: the appex shipped without outgoing network (the native proxy and
// the WebSocket tunnel failed to resolve any host), the app stayed sandboxed (native
// messaging could not launch a host), the version stayed 1.0 (Safari served stale
// resources across reinstalls), and the Dock icon stayed the packager's white tile.

const XCPROJ = `{
  "default-configuration": "Release",
  "files": [
    {
      "kind": "group",
      "path": "App",
      "children": [
        { "path": "AppDelegate.swift", "target-membership": [ "App/compile-sources" ] },
        {
          "kind": "variant-group",
          "name": "Main.storyboard",
          "target-membership": [
            "App/resources",
          ],
          "children": [
            {
              "path": "Base.lproj/Main.storyboard",
            },
          ],
        },
        { "path": "Assets.xcassets", "target-membership": [ "App/resources" ] },
        { "path": "Info.plist" },
      ],
    }, {
      "kind": "group",
      "path": "App Extension",
      "children": [
        {
          "kind": "group",
          "path": "<PROJECT>/App Extension",
          "name": "Resources",
          "children": [
            { "path": "../../staged_extension/manifest.json", "target-membership": [ "App Extension/resources" ] },
          ],
        },
        { "path": "Info.plist" },
      ],
    },
  ],
  "targets": [
    {
      "name": "App",
      "product-type": "application",
      "build-settings": {
        "CODE_SIGN_STYLE": "Automatic",
        "CURRENT_PROJECT_VERSION": "1",
        "ENABLE_APP_SANDBOX": "YES",
        "ENABLE_HARDENED_RUNTIME": "YES",
        "ENABLE_OUTGOING_NETWORK_CONNECTIONS": "YES",
        "LD_RUNPATH_SEARCH_PATHS": [
          "$(inherited)",
          "@executable_path/../Frameworks",
        ],
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "com.example.Packaged",
      },
    }, {
      "name": "App Extension",
      "product-type": "app-extension",
      "build-settings": {
        "CODE_SIGN_STYLE": "Automatic",
        "CURRENT_PROJECT_VERSION": "1",
        "ENABLE_APP_SANDBOX": "YES",
        "ENABLE_HARDENED_RUNTIME": "YES",
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "com.example.Packaged.Extension",
      },
    },
  ],
  "build-settings": {
    "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
  },
}
`;

function png(w, h) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-xcproj-"));
  const xcodeproj = join(dir, "App.xcodeproj");
  mkdirSync(xcodeproj);
  writeFileSync(join(xcodeproj, "project.xcproj"), XCPROJ);
  mkdirSync(join(dir, "App", "Assets.xcassets"), { recursive: true });
  writeFileSync(join(dir, "App", "AppDelegate.swift"), 'let extensionBundleIdentifier = "com.example.Packaged.Extension"\n');
  return { dir, xcodeproj, file: join(xcodeproj, "project.xcproj") };
}

function block(content, name) {
  const i = content.indexOf(`"name": "${name}"`);
  const s = content.indexOf('"build-settings": {', i);
  return content.slice(s, content.indexOf("}", s));
}

test("bundle ids are forced on both targets and the appex gets outgoing network", () => {
  const { dir, xcodeproj, file } = project();
  try {
    patchProjectBundleIds(xcodeproj, "com.viaduct.Thing");
    const out = readFileSync(file, "utf-8");
    assert.match(block(out, "App"), /"PRODUCT_BUNDLE_IDENTIFIER": "com\.viaduct\.Thing",/);
    const ext = block(out, "App Extension");
    assert.match(ext, /"PRODUCT_BUNDLE_IDENTIFIER": "com\.viaduct\.Thing\.Extension",/);
    assert.match(ext, /"ENABLE_APP_SANDBOX": "YES",\n\s*"ENABLE_OUTGOING_NETWORK_CONNECTIONS": "YES",/);
    // The app target already had it; it is not duplicated.
    assert.equal(block(out, "App").split("ENABLE_OUTGOING_NETWORK_CONNECTIONS").length - 1, 1);
    assert.equal(readFileSync(join(dir, "App", "AppDelegate.swift"), "utf-8"), 'let extensionBundleIdentifier = "com.viaduct.Thing.Extension"\n');
    // Trailing commas and array settings survive, so xcodebuild still reads the file.
    assert.match(out, /"@executable_path\/\.\.\/Frameworks",\n\s*\],/);
    // A second run changes nothing.
    patchProjectBundleIds(xcodeproj, "com.viaduct.Thing");
    assert.equal(readFileSync(file, "utf-8"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the version stamp, the unsandboxed app and the appex Downloads grant land on the right targets", () => {
  const { dir, xcodeproj, file } = project();
  try {
    setBuildVersion(xcodeproj, { short: "1.0.42", build: "4242" });
    unsandboxAppTarget(xcodeproj);
    grantDownloadsFolder(xcodeproj);
    const out = readFileSync(file, "utf-8");
    for (const name of ["App", "App Extension"]) {
      assert.match(block(out, name), /"CURRENT_PROJECT_VERSION": "4242",/);
      assert.match(block(out, name), /"MARKETING_VERSION": "1\.0\.42",/);
    }
    assert.match(block(out, "App"), /"ENABLE_APP_SANDBOX": "NO",/);
    assert.doesNotMatch(block(out, "App"), /DOWNLOADS_FOLDER/);
    const ext = block(out, "App Extension");
    assert.match(ext, /"ENABLE_APP_SANDBOX": "YES",/);
    assert.match(ext, /"ENABLE_FILE_ACCESS_DOWNLOADS_FOLDER": "readwrite",/);
    assert.doesNotMatch(out, /"ENABLE_APP_SANDBOX": "YES",[^}]*"ENABLE_APP_SANDBOX"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the icon bundle is written beside the app's asset catalog and listed in its resources", () => {
  const { dir, xcodeproj, file } = project();
  const icon = join(dir, "icon.png");
  writeFileSync(icon, png(128, 128));
  try {
    assert.deepEqual(writeAppearanceAwareIcon(xcodeproj, icon, false), [join(dir, "App", "AppIcon.icon")]);
    assert.ok(existsSync(join(dir, "App", "AppIcon.icon", "icon.json")));
    const out = readFileSync(file, "utf-8");
    assert.match(out, /\{ "path": "Assets\.xcassets", "target-membership": \[ "App\/resources" \] \},\n\s*\{ "path": "AppIcon\.icon", "target-membership": \[ "App\/resources" \] \},/);
    assert.deepEqual(writeAppearanceAwareIcon(xcodeproj, icon, false), []);
    assert.equal(readFileSync(file, "utf-8"), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
