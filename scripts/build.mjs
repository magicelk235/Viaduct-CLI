// Builds dist/: the umbrella's own source plus a copy of each engine's dist/.
// The app never runs npm install, so everything the CLI runs has to be in here.
// Each engine sits in its own folder with a package.json beside its dist/,
// because the engines read ../package.json for --version.

import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const pkg = readJson(at("package.json"));
const ENGINES = ["aqueduct", "lavaduct"];

// Check every engine before touching dist/, so a stale node_modules leaves the
// last good build in place.
const engines = ENGINES.map((engine) => {
  const root = at(`node_modules/@magicelk235/${engine}`);
  const installed = readJson(`${root}/package.json`);
  const pinned = pkg.devDependencies[`@magicelk235/${engine}`];
  if (installed.version !== pinned) {
    console.error(`build: node_modules has ${engine} ${installed.version}, package.json pins ${pinned}. Run npm ci.`);
    process.exit(1);
  }
  return { engine, root, installed };
});

rmSync(at("dist"), { recursive: true, force: true });
mkdirSync(at("dist"));
for (const file of readdirSync(at("src"))) {
  if (file.endsWith(".js")) cpSync(at(`src/${file}`), at(`dist/${file}`));
}
chmodSync(at("dist/cli.js"), 0o755);

for (const { engine, root, installed } of engines) {
  const out = at(`dist/engines/${engine}`);
  mkdirSync(out, { recursive: true });
  const { name, version } = installed;
  writeFileSync(`${out}/package.json`, `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`);
  cpSync(`${root}/dist`, `${out}/dist`, { recursive: true, filter: (src) => !src.endsWith(".d.ts") });
}
