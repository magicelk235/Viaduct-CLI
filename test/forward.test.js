import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("./fixtures/forward-harness.mjs", import.meta.url));
const engine = (name) => fileURLToPath(new URL(`./fixtures/engines/${name}`, import.meta.url));

const runHarness = (name, args) =>
  spawnSync(process.execPath, [HARNESS, engine(name), ...args], { encoding: "utf8", timeout: 10_000 });

test("exit codes come back unchanged", () => {
  for (const c of [0, 1, 2, 7]) assert.equal(runHarness("exit.mjs", [String(c)]).status, c);
});

test("arguments arrive verbatim", () => {
  const args = ["a b", "", "--team", "ÄÖ ☃", "--app-name=X Y", "-o", "/tmp/x y"];
  assert.deepEqual(JSON.parse(runHarness("echo-args.mjs", args).stdout), args);
});

test("stdout and stderr stay separate", () => {
  const r = runHarness("streams.mjs", []);
  assert.equal(r.stdout, "out1\nout2\n");
  assert.equal(r.stderr, "err1\n");
});

test("SIGTERM reaches the engine and its exit code wins", async () => {
  const harness = spawn(process.execPath, [HARNESS, engine("trap.mjs")]);
  let stdout = "";
  let stderr = "";
  let enginePid;
  let sent = false;
  // If forwarding breaks, don't leave either process behind.
  const guard = setTimeout(() => {
    harness.kill("SIGKILL");
    try {
      if (enginePid) process.kill(enginePid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 10_000);
  const maybeTerminate = () => {
    enginePid ??= Number(stderr.match(/^pid (\d+)\n/)?.[1]) || undefined;
    if (!sent && enginePid && stdout.includes("ready\n")) {
      sent = true;
      harness.kill("SIGTERM");
    }
  };
  harness.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; maybeTerminate(); });
  harness.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; maybeTerminate(); });

  const [code, signal] = await new Promise((resolve) => harness.on("close", (...r) => resolve(r)));
  clearTimeout(guard);

  assert.equal(signal, null);
  assert.equal(code, 130);
  assert.equal(stdout, "ready\nterm\n");
  assert.ok(enginePid, "engine pid was reported");
  assert.throws(() => process.kill(enginePid, 0), { code: "ESRCH" });
});

test("an engine killed by a signal kills the umbrella by the same signal", () => {
  assert.equal(runHarness("self-kill.mjs", []).signal, "SIGKILL");
});
