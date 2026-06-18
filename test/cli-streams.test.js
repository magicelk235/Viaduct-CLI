import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

// Regression: --analyze --json must put ONLY the JSON payload on stdout.
// Progress/diagnostic lines (info/ok/warn) belong on stderr, or a consumer
// piping stdout gets unparseable interleaved output.
test("analyze --json keeps stdout free of diagnostic lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "c2s-streams-"));
  try {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "Streams", version: "1.0.0", permissions: ["storage"] })
    );
    const res = spawnSync("node", [CLI, dir, "--analyze", "--json"], { encoding: "utf-8" });
    // stdout must parse cleanly as JSON with no prefix/suffix noise.
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.name, "Streams");
    // No stray glyphs from info/ok/warn leaked to stdout.
    assert.ok(!/[›✓!]/.test(res.stdout), `stdout had diagnostic glyphs:\n${res.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
