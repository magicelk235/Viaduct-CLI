import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeAppBroker, writeNativeHandler } from "../dist/build/packager.js";

// The native-messaging container app used to run under a LaunchAgent that restarted it
// at login and after every quit, so it never stayed quit and Finder refused to trash it
// ("can't be moved to the Trash because it's open"). It now runs only while Safari
// does: the appex starts it on demand, it quits with Safari, and a user quit sticks for
// the rest of that Safari session.

function project() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-broker-safari-"));
  const appDir = join(dir, "App");
  const extDir = join(dir, "App Extension");
  mkdirSync(join(appDir, "Resources", "Base.lproj"), { recursive: true });
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(appDir, "AppDelegate.swift"), "// template\n", "utf-8");
  writeFileSync(join(extDir, "SafariWebExtensionHandler.swift"), "// template\n", "utf-8");
  // Apple's template files, as safari-web-extension-packager generates them.
  writeFileSync(
    join(appDir, "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      "<plist version=\"1.0\">\n<dict>\n\t<key>SFSafariWebExtensionConverterVersion</key>\n\t<string>27.0</string>\n</dict>\n</plist>\n",
    "utf-8",
  );
  writeFileSync(
    join(appDir, "ViewController.swift"),
    "        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in\n" +
      "            DispatchQueue.main.async {\n" +
      "                NSApplication.shared.terminate(nil)\n" +
      "            }\n" +
      "        }\n",
    "utf-8",
  );
  writeFileSync(
    join(appDir, "Resources", "Script.js"),
    "document.getElementsByClassName('open-preferences')[0].innerText = \"Quit and Open Safari Settings…\";\n",
    "utf-8",
  );
  writeFileSync(
    join(appDir, "Resources", "Base.lproj", "Main.html"),
    '<button class="open-preferences">Quit and Open Safari Extensions Preferences…</button>\n',
    "utf-8",
  );
  const xcodeproj = join(dir, "App.xcodeproj");
  writeAppBroker(xcodeproj, { brokerPort: 51234, brokerToken: "deadbeef" });
  writeNativeHandler(xcodeproj, { chromeOrigin: "", allowHosts: [], nativeMessaging: true, brokerPort: 51234, brokerToken: "deadbeef" });
  return { dir, appDir, extDir };
}

const method = (swift, name) => swift.match(new RegExp(`func ${name}[\\s\\S]*?\\n    }\\n`))?.[0] ?? "";

test("the app registers the URL scheme the extension launches it through", () => {
  const { dir, appDir } = project();
  try {
    const plist = join(appDir, "Info.plist");
    const json = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist]).toString());
    assert.deepEqual(json.CFBundleURLTypes?.[0]?.CFBundleURLSchemes, ["$(PRODUCT_BUNDLE_IDENTIFIER).broker"]);
    assert.equal(json.SFSafariWebExtensionConverterVersion, "27.0", "the template's keys survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the extension starts the app when no broker is listening, without focus", () => {
  const { dir, extDir } = project();
  try {
    const swift = readFileSync(join(extDir, "SafariWebExtensionHandler.swift"), "utf-8");
    const launch = method(swift, "launchBroker");
    assert.match(launch, /\.broker:launch/);
    assert.match(launch, /launchDeclined = true/, "an app that exits without serving is not launched again");
    assert.match(launch, /Date\(\) < launchRetryAfter \{ return false \}/, "calls queued behind a failed launch fail fast");
    assert.match(launch, /activates = false/);
    assert.match(method(swift, "handleNative"), /launchBroker\(\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the app quits with Safari and a user quit sticks for that Safari session", () => {
  const { dir, appDir } = project();
  try {
    const swift = readFileSync(join(appDir, "AppDelegate.swift"), "utf-8");
    const didFinish = method(swift, "applicationDidFinishLaunching");
    assert.match(didFinish, /didTerminateApplicationNotification/);
    assert.match(swift, /"com\.apple\.Safari", "com\.apple\.SafariTechnologyPreview"/);
    assert.match(swift, /open urls: \[URL\]\) \{\s+launchedByExtension = true/, "the extension's URL launch is told apart from the user's");
    assert.match(didFinish, /let userLaunch = !launchedByExtension/, "and stays windowless");
    assert.match(didFinish, /declinedKey[\s\S]*NSApp\.terminate/);
    assert.match(method(swift, "applicationWillTerminate"), /set\(sessions, forKey: Self\.declinedKey\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the setup button closes the window instead of quitting the broker", () => {
  const { dir, appDir } = project();
  try {
    const vc = readFileSync(join(appDir, "ViewController.swift"), "utf-8");
    assert.doesNotMatch(vc, /terminate/);
    assert.match(vc, /self\.view\.window\?\.close\(\)/);
    assert.match(readFileSync(join(appDir, "Resources", "Script.js"), "utf-8"), /"Open Safari Settings…"/);
    assert.match(readFileSync(join(appDir, "Resources", "Base.lproj", "Main.html"), "utf-8"), />Open Safari Extensions Preferences…</);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
