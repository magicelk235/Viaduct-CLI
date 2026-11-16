// Picks the engine script to run. viaduct declares a caret range for each
// engine, and whatever installed it (npm, or Viaduct.app's updater) puts the
// newest in-range engine in node_modules. That copy wins. The copy bundled in
// dist/engines/ is the bottom of the range and runs when there's no usable
// node_modules copy: old app installs, offline installs, broken installs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// "^X.Y.Z" -> [X, Y, Z]; anything else -> null.
export function caretFloor(range) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
  return m ? m.slice(1).map(Number) : null;
}

// npm's caret rule, without prereleases: ^1.2.3 is >=1.2.3 <2.0.0, ^0.1.3 is
// >=0.1.3 <0.2.0, ^0.0.3 is only 0.0.3.
function satisfies(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  const floor = caretFloor(range);
  if (!v || !floor) return false;
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = floor;
  if (x > 0) return a === x && (b > y || (b === y && c >= z));
  if (y > 0) return a === 0 && b === y && c >= z;
  return a === 0 && b === 0 && c === z;
}

// The node_modules copy Node would resolve, found by walking up from dist/ by
// hand so the engine's exports/files fields can't hide it. Like Node, the
// nearest copy is the only candidate: a further one belongs to something else.
function installedEngine(engine, distDir) {
  for (let dir = distDir; ; dir = dirname(dir)) {
    const root = join(dir, "node_modules", "@magicelk235", engine);
    if (existsSync(join(root, "package.json"))) {
      try {
        const { version } = readJson(join(root, "package.json"));
        const range = readJson(join(distDir, "..", "package.json")).optionalDependencies?.[`@magicelk235/${engine}`];
        const script = join(root, "dist", "cli.js");
        return satisfies(version, range) && existsSync(script) ? script : null;
      } catch {
        return null;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

export function engineScript(engine, distDir) {
  return installedEngine(engine, distDir) ?? join(distDir, "engines", engine, "dist", "cli.js");
}
