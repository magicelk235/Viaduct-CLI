import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_HELP } from "../src/route.js";

// Every script path is absolute: each run's working directory is a fresh empty
// folder, so no viaduct.config.json is ever picked up.
const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const AQ = at("node_modules/@magicelk235/aqueduct/dist/cli.js");
const LV = at("node_modules/@magicelk235/lavaduct/dist/cli.js");
const VD = at("dist/cli.js");
const FX = at("test/fixtures/mv3-sample");
const AS_LINUX = at("test/fixtures/as-linux.mjs");

const [major, minor] = process.versions.node.split(".").map(Number);
const firefoxNode = major > 22 || (major === 22 && minor >= 13);

const MACOS = "✗ Safari conversion needs macOS. Use --browser firefox to convert for Firefox.\n";

function run(script, args, { preload } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "viaduct-run-"));
  try {
    const r = spawnSync(process.execPath, [...(preload ? ["--import", preload] : []), script, ...args], { cwd, encoding: "buffer" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function same(a, b) {
  assert.equal(b.status, a.status);
  assert.deepEqual(b.stdout, a.stdout);
  assert.deepEqual(b.stderr, a.stderr);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-passthrough-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hasPackager() {
  if (process.platform !== "darwin") return false;
  return spawnSync("xcrun", ["--find", "safari-web-extension-packager"], { stdio: "ignore" }).status === 0;
}

test("Safari output is byte-identical without --browser", (t) => {
  const tmp = tempDir(t);
  const cases = [
    [[FX, "--analyze"], 0],
    [[FX, "--analyze", "--json"], 0],
    [["--version"], 0],
    [["--bogus-flag"], 2],
    [[join(tmp, "missing.zip")], 1],
  ];
  for (const [argv, status] of cases) {
    const direct = run(AQ, argv);
    assert.equal(direct.status, status, argv.join(" "));
    same(direct, run(VD, argv));
  }
});

test("a Safari conversion's log is byte-identical", { skip: !hasPackager() && "needs macOS with safari-web-extension-packager" }, (t) => {
  const OUT = join(tempDir(t), "out");
  const argv = [FX, "--no-build", "-o", OUT];
  // A second run into the same folder adds a "Cleaned output dir" line, so
  // each run starts without it.
  rmSync(OUT, { recursive: true, force: true });
  const direct = run(AQ, argv);
  rmSync(OUT, { recursive: true, force: true });
  const viaduct = run(VD, argv);
  same(direct, viaduct);
  assert.equal(viaduct.status, 0);
  const log = viaduct.stderr.toString();
  assert.ok(log.includes('Loaded "MV3 Sample"'), log);
  assert.ok(log.includes("Staging clean"), log);
});

test("--browser firefox gives lavaduct's output", { skip: !firefoxNode && "lavaduct needs Node 22.13" }, () => {
  for (const argv of [[FX, "--analyze", "--json"], ["--version"]]) {
    same(run(LV, argv), run(VD, ["--browser", "firefox", ...argv]));
  }
});

test("--browser firefox on old Node says why", { skip: firefoxNode && "this Node runs lavaduct" }, () => {
  const r = run(VD, ["--browser", "firefox", FX]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.length, 0);
  assert.equal(r.stderr.toString(), `✗ Firefox conversion needs Node.js 22.13 or newer. This is Node.js ${process.versions.node}.\n`);
});

test("--help is the engine's help plus the --browser block", () => {
  const r = run(VD, ["--help"]);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout, Buffer.concat([run(AQ, ["--help"]).stdout, Buffer.from(BROWSER_HELP)]));
});

test("Safari is refused off macOS", () => {
  for (const argv of [[FX, "--analyze"], ["--browser", "safari", FX, "--analyze"]]) {
    const r = run(VD, argv, { preload: AS_LINUX });
    assert.equal(r.status, 2);
    assert.equal(r.stdout.length, 0);
    assert.equal(r.stderr.toString(), MACOS);
  }
  if (firefoxNode) {
    const r = run(VD, ["--browser", "firefox", "--version"], { preload: AS_LINUX });
    assert.equal(r.status, 0);
    assert.deepEqual(r.stdout, run(LV, ["--version"]).stdout);
  }
});

test("a missing engine is reported", (t) => {
  // The layout the app installs: package.json (for "type": "module") beside dist/.
  const install = tempDir(t);
  const tmpDist = join(install, "dist");
  cpSync(at("package.json"), join(install, "package.json"));
  cpSync(at("dist"), tmpDist, { recursive: true });
  // On Node too old for lavaduct, the Firefox route never gets as far as the
  // engine, so check the Safari one there instead.
  const [browser, engine, name] = firefoxNode ? ["firefox", "lavaduct", "Firefox"] : ["safari", "aqueduct", "Safari"];
  rmSync(join(tmpDist, "engines", engine), { recursive: true, force: true });
  const r = run(join(tmpDist, "cli.js"), ["--browser", browser, "--version"]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.toString().includes(`missing its ${name} engine (${engine}). Reinstall @magicelk235/viaduct.`), r.stderr.toString());
});
