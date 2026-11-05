import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

test("piped --help survives a reader that has already gone", async (t) => {
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
