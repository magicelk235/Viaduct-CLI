#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { route, BROWSER_HELP } from "./route.js";
import { forward, exitLike } from "./forward.js";

const BROWSER_NAMES = { aqueduct: "Safari", lavaduct: "Firefox" };

function fail(message, exitCode) {
  const mark = process.stderr.isTTY && !process.env.NO_COLOR ? "\x1b[31m✗\x1b[0m" : "✗";
  process.stderr.write(`${mark} ${message}\n`);
  process.exit(exitCode);
}

const routed = route(process.argv.slice(2), { platform: process.platform, nodeVersion: process.versions.node });
if (!routed.ok) fail(routed.message, routed.exitCode);

const { engine, args, help } = routed;
const script = fileURLToPath(new URL(`./engines/${engine}/dist/cli.js`, import.meta.url));
if (!existsSync(script)) {
  fail(`This install of viaduct is missing its ${BROWSER_NAMES[engine]} engine (${engine}). Reinstall @magicelk235/viaduct.`, 1);
}

const result = await forward(script, args);
if (help && result.code === 0) {
  // Wait for the write so a piped --help isn't cut off by the exit.
  await new Promise((resolve) => process.stdout.write(BROWSER_HELP, resolve));
}
exitLike(result);
