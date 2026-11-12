import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(at(path), "utf8"));
const pkg = readJson("package.json");

test("package.json keeps the contract", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.os, undefined);
  assert.equal(pkg.engines.node, ">=18");
  assert.deepEqual(pkg.bin, { viaduct: "dist/cli.js" });
  for (const e of ["@magicelk235/aqueduct", "@magicelk235/lavaduct"]) assert.match(pkg.devDependencies[e], /^\d+\.\d+\.\d+$/);
});

test("the bundled engines are the pinned versions", () => {
  for (const e of ["aqueduct", "lavaduct"])
    assert.equal(readJson(`dist/engines/${e}/package.json`).version, pkg.devDependencies[`@magicelk235/${e}`]);
});

test("the tarball carries everything the app copies", () => {
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" }));
  const paths = packed.files.map((f) => f.path);
  for (const f of ["dist/cli.js", "dist/route.js", "dist/forward.js",
    "dist/engines/aqueduct/package.json", "dist/engines/aqueduct/dist/cli.js",
    "dist/engines/aqueduct/dist/runtime/safari-compat-shim.js", "dist/engines/aqueduct/dist/templates/browser-polyfill.min.js",
    "dist/engines/lavaduct/package.json", "dist/engines/lavaduct/dist/cli.js",
    "dist/engines/lavaduct/dist/runtime/firefox-compat-shim.js"]) assert.ok(paths.includes(f), f);
  assert.ok(!paths.some((p) => p.endsWith(".d.ts")));
});

test("dist/cli.js is executable", () => { assert.ok(statSync(at("dist/cli.js")).mode & 0o111); });
