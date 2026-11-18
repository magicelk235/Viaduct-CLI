import { test } from "node:test";
import assert from "node:assert/strict";
import { route, BROWSER_HELP } from "../src/route.js";

const mac = { platform: "darwin", nodeVersion: "24.0.0" };
const linux = { platform: "linux", nodeVersion: "24.0.0" };

const ok = (engine, args, help = false) => ({ ok: true, engine, args, help });
const err = (exitCode, message) => ({ ok: false, exitCode, message });
const VALUE = "--browser takes safari or firefox.";
const ONCE = "--browser can only be given once.";
const MACOS = "Safari conversion needs macOS. Use --browser firefox to convert for Firefox.";
const NODE = (v) => `Firefox conversion needs Node.js 22.13 or newer. This is Node.js ${v}.`;

test("no --browser passes every argument to aqueduct untouched", () => {
  const argv = ["ext.zip", "--install", "--team", "ABC123", "--app-name", "My Ext", "--background-launch"];
  assert.deepEqual(route(argv, mac), ok("aqueduct", argv));
  assert.deepEqual(route([], mac), ok("aqueduct", []));
});
test("--browser firefox goes to lavaduct, wherever it sits", () => {
  assert.deepEqual(route(["--browser", "firefox", "ext.zip", "-o", "out"], mac), ok("lavaduct", ["ext.zip", "-o", "out"]));
  assert.deepEqual(route(["ext.zip", "--browser=firefox", "--force"], mac), ok("lavaduct", ["ext.zip", "--force"]));
});
test("--browser safari is stripped on macOS", () => {
  assert.deepEqual(route(["ext.zip", "--browser", "safari"], mac), ok("aqueduct", ["ext.zip"]));
});
test("Safari off macOS is refused, explicit or default", () => {
  assert.deepEqual(route(["--browser", "safari", "x"], linux), err(2, MACOS));
  assert.deepEqual(route(["x"], linux), err(2, MACOS));
  assert.deepEqual(route(["x"], { ...linux, platform: "win32" }), err(2, MACOS));
  assert.deepEqual(route(["--browser", "firefox", "x"], linux), ok("lavaduct", ["x"]));
});
test("bad --browser values are usage errors", () => {
  for (const argv of [["--browser", "chrome"], ["--browser", "Firefox"], ["--browser"], ["--browser="], ["--browser", "--analyze", "x"]])
    assert.deepEqual(route(argv, mac), err(2, VALUE), argv.join(" "));
  assert.deepEqual(route(["--browser", "firefox", "--browser", "safari"], mac), err(2, ONCE));
  assert.deepEqual(route(["--browser=firefox", "--browser=firefox"], mac), err(2, ONCE));
});
test("anything after -- belongs to the engine", () => {
  assert.deepEqual(route(["x", "--", "--browser", "firefox", "--help"], mac), ok("aqueduct", ["x", "--", "--browser", "firefox", "--help"]));
});
test("help is noticed so the --browser block can follow it", () => {
  assert.deepEqual(route(["--help"], mac), ok("aqueduct", ["--help"], true));
  assert.deepEqual(route(["-h", "--browser", "firefox"], mac), ok("lavaduct", ["-h"], true));
});
test("Firefox needs Node 22.13; Safari doesn't", () => {
  for (const v of ["20.18.1", "22.12.9", "18.20.0"])
    assert.deepEqual(route(["--browser", "firefox", "x"], { platform: "darwin", nodeVersion: v }), err(1, NODE(v)));
  for (const v of ["22.13.0", "23.0.0", "24.1.0"])
    assert.equal(route(["--browser", "firefox", "x"], { platform: "darwin", nodeVersion: v }).ok, true);
  assert.equal(route(["x"], { platform: "darwin", nodeVersion: "18.0.0" }).ok, true);
});
test("BROWSER_HELP names both values and both engines", () => {
  for (const s of ["--browser", "safari", "firefox", "aqueduct", "lavaduct"]) assert.ok(BROWSER_HELP.includes(s));
});
