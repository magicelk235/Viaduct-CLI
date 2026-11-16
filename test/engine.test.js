import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { engineScript } from "../src/engine.js";

const RANGES = { "@magicelk235/aqueduct": "^1.18.2", "@magicelk235/lavaduct": "^0.1.3" };

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// A viaduct install at <root>: dist/ with a bundled engine, and package.json
// with the engine ranges.
function install(t, root = mkdtempSync(join(tmpdir(), "viaduct-engine-"))) {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(join(root, "package.json"), JSON.stringify({ name: "@magicelk235/viaduct", optionalDependencies: RANGES }));
  for (const e of ["aqueduct", "lavaduct"]) put(join(root, `dist/engines/${e}/dist/cli.js`), "");
  return { root, dist: join(root, "dist") };
}

function installed(modules, engine, version, { cli = true } = {}) {
  const dir = join(modules, "@magicelk235", engine);
  put(join(dir, "package.json"), JSON.stringify({ name: `@magicelk235/${engine}`, version }));
  if (cli) put(join(dir, "dist/cli.js"), "");
  return join(dir, "dist/cli.js");
}

const bundled = (dist, engine) => join(dist, `engines/${engine}/dist/cli.js`);

test("an in-range engine in node_modules wins over the bundled one", (t) => {
  const { root, dist } = install(t);
  const aq = installed(join(root, "node_modules"), "aqueduct", "1.19.0");
  const lv = installed(join(root, "node_modules"), "lavaduct", "0.1.4");
  assert.equal(engineScript("aqueduct", dist), aq);
  assert.equal(engineScript("lavaduct", dist), lv);
});

test("an engine hoisted next to viaduct is found", (t) => {
  const project = mkdtempSync(join(tmpdir(), "viaduct-hoisted-"));
  const { dist } = install(t, join(project, "node_modules/@magicelk235/viaduct"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const aq = installed(join(project, "node_modules"), "aqueduct", "1.18.2");
  assert.equal(engineScript("aqueduct", dist), aq);
});

test("without node_modules the bundled engine runs", (t) => {
  const { dist } = install(t);
  assert.equal(engineScript("aqueduct", dist), bundled(dist, "aqueduct"));
});

test("a node_modules copy without dist/cli.js falls back to the bundled engine", (t) => {
  const { root, dist } = install(t);
  installed(join(root, "node_modules"), "aqueduct", "1.19.0", { cli: false });
  assert.equal(engineScript("aqueduct", dist), bundled(dist, "aqueduct"));
});

test("a node_modules copy outside the range falls back to the bundled engine", (t) => {
  const { root, dist } = install(t);
  const modules = join(root, "node_modules");
  for (const [engine, version] of [["aqueduct", "2.0.0"], ["aqueduct", "1.18.1"], ["aqueduct", "1.19.0-beta.1"],
    ["lavaduct", "0.2.0"], ["lavaduct", "1.0.0"]]) {
    installed(modules, engine, version);
    assert.equal(engineScript(engine, dist), bundled(dist, engine), `${engine} ${version}`);
  }
});

test("an unreadable node_modules package.json falls back to the bundled engine", (t) => {
  const { root, dist } = install(t);
  installed(join(root, "node_modules"), "aqueduct", "1.19.0");
  put(join(root, "node_modules/@magicelk235/aqueduct/package.json"), "{");
  assert.equal(engineScript("aqueduct", dist), bundled(dist, "aqueduct"));
});
