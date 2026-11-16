import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// The stub install has only a Safari engine, and Safari is refused off macOS.
test("piped --help survives a reader that has already gone", { skip: process.platform !== "darwin" && "Safari needs macOS" }, async (t) => {
  // An install layout with a Safari engine that prints nothing, then exits 0
  // after the reader has closed the pipe.
  const dir = mkdtempSync(join(tmpdir(), "viaduct-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(SRC, dir, { recursive: true });
  mkdirSync(join(dir, "engines/aqueduct/dist"), { recursive: true });
  writeFileSync(join(dir, "engines/aqueduct/dist/cli.js"), "setTimeout(() => process.exit(0), 300);\n");

  const cli = spawn(process.execPath, [join(dir, "cli.js"), "--help"], { env: { ...process.env, NO_COLOR: "1" } });
  cli.stdout.destroy();
  let stderr = "";
  cli.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
  const guard = setTimeout(() => cli.kill("SIGKILL"), 10_000);
  const [code, signal] = await new Promise((resolve) => cli.on("close", (...r) => resolve(r)));
  clearTimeout(guard);

  assert.equal(stderr, "");
  assert.equal(signal, null);
  assert.equal(code, 0);
});

test("the CLI runs the node_modules engine before the bundled one", { skip: process.platform !== "darwin" && "Safari needs macOS" }, (t) => {
  // The app's layout: cli/dist/cli.js, cli/package.json, cli/node_modules/.
  const root = mkdtempSync(join(tmpdir(), "viaduct-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(SRC, join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ optionalDependencies: { "@magicelk235/aqueduct": "^1.18.2" } }));
  mkdirSync(join(root, "dist/engines/aqueduct/dist"), { recursive: true });
  writeFileSync(join(root, "dist/engines/aqueduct/dist/cli.js"), "process.stdout.write('bundled');\n");
  const run = () => spawnSync(process.execPath, [join(root, "dist/cli.js")], { encoding: "utf8" });

  assert.equal(run().stdout, "bundled");

  const installed = join(root, "node_modules/@magicelk235/aqueduct");
  mkdirSync(join(installed, "dist"), { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ version: "1.18.3" }));
  writeFileSync(join(installed, "dist/cli.js"), "process.stdout.write('node_modules');\n");
  assert.equal(run().stdout, "node_modules");
});
