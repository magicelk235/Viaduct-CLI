import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeAppBroker } from "../dist/build/packager.js";
import { brokerAgentPlist } from "../dist/build/installer.js";

// The broker LaunchAgent used to relaunch the container app every time it quit, so the
// app could never stay quit and Finder refused to trash it ("can't be moved to the Trash
// because it's open"). A quit now stops the agent, and the agent gives up on a deleted app.

test("the broker LaunchAgent keeps the app alive only while the app exists", () => {
  const app = "/Users/me/Applications/My Ext.app";
  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: brokerAgentPlist(app, "com.viaduct.MyExt.broker"),
  }).toString();
  assert.deepEqual(JSON.parse(json).KeepAlive, { PathState: { [app]: true } });
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-broker-quit-"));
  const appDir = join(dir, "App");
  mkdirSync(join(appDir, "Resources", "Base.lproj"), { recursive: true });
  writeFileSync(join(appDir, "AppDelegate.swift"), "// original app delegate placeholder\n", "utf-8");
  // Apple's template, as safari-web-extension-packager generates it.
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
  return { dir, appDir };
}

test("quitting the app stops its broker LaunchAgent", () => {
  const { dir, appDir } = project();
  try {
    writeAppBroker(join(dir, "App.xcodeproj"), { brokerPort: 51234, brokerToken: "deadbeef" });
    const swift = readFileSync(join(appDir, "AppDelegate.swift"), "utf-8");
    const willTerminate = swift.match(/func applicationWillTerminate[\s\S]*?\n    }\n/)?.[0] ?? "";
    assert.match(willTerminate, /"bootout", "gui\/" \+ String\(getuid\(\)\) \+ "\/" \+ id \+ "\.broker"/);
    assert.match(willTerminate, /waitUntilExit/, "the agent is gone before the app exits, so it can't relaunch it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the setup button closes the window instead of quitting the broker", () => {
  const { dir, appDir } = project();
  try {
    writeAppBroker(join(dir, "App.xcodeproj"), { brokerPort: 51234, brokerToken: "deadbeef" });
    const vc = readFileSync(join(appDir, "ViewController.swift"), "utf-8");
    assert.doesNotMatch(vc, /terminate/);
    assert.match(vc, /self\.view\.window\?\.close\(\)/);
    assert.match(readFileSync(join(appDir, "Resources", "Script.js"), "utf-8"), /"Open Safari Settings…"/);
    assert.match(readFileSync(join(appDir, "Resources", "Base.lproj", "Main.html"), "utf-8"), />Open Safari Extensions Preferences…</);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
