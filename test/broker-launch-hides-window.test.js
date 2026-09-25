import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { writeAppBroker, BROKER_LAUNCH_ARG } from "../dist/build/packager.js";
import { brokerAgentPlist } from "../dist/build/installer.js";

// The broker LaunchAgent starts the container app at login and relaunches it after a
// crash. Those launches must start windowless, or the window pops up on its own.

test("the broker LaunchAgent launches the app with the windowless-launch argument", () => {
  const app = "/Users/me/Applications/My Ext.app";
  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: brokerAgentPlist(app, "com.viaduct.MyExt.broker"),
  }).toString();
  const agent = JSON.parse(json);
  assert.deepEqual(agent.ProgramArguments, ["/usr/bin/open", "-g", "-W", app, "--args", BROKER_LAUNCH_ARG]);
  assert.equal(agent.RunAtLoad, true);
});

test("the app delegate hides its window on that launch and shows it on reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-broker-window-"));
  const appDir = join(dir, "App");
  mkdirSync(appDir, { recursive: true });
  const delegate = join(appDir, "AppDelegate.swift");
  writeFileSync(delegate, "// original app delegate placeholder\n", "utf-8");
  try {
    writeAppBroker(join(dir, "App.xcodeproj"), { brokerPort: 51234, brokerToken: "deadbeef" });
    const swift = readFileSync(delegate, "utf-8");
    const willFinish = swift.match(/func applicationWillFinishLaunching[\s\S]*?\n    }\n/)?.[0] ?? "";
    assert.ok(
      willFinish.includes(`CommandLine.arguments.contains("${BROKER_LAUNCH_ARG}")`) && willFinish.includes("orderOut"),
      "a launch carrying the agent's argument orders the window out before it is drawn",
    );
    const reopen = swift.match(/func applicationShouldHandleReopen[\s\S]*?\n    }\n/)?.[0] ?? "";
    assert.match(reopen, /makeKeyAndOrderFront/, "opening the app while it runs windowless shows the window");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
