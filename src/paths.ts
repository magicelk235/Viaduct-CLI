import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for bundled-asset locations. paths.ts lives at the
// package source/dist ROOT, so resolving relative to *this* file stays correct
// no matter how deep the importer is nested (src/runtime/, src/build/, …). The
// build copies src/templates → dist/templates and src/runtime → dist/runtime,
// so both dirs sit beside the compiled paths.js at runtime.
const ROOT = dirname(fileURLToPath(import.meta.url));

/** Bundled template assets (OAuth bridge scripts, browser-polyfill). */
export const TEMPLATE_DIR = join(ROOT, "templates");
/** Bundled runtime JS (the compat-shim source read at conversion time). */
export const RUNTIME_DIR = join(ROOT, "runtime");
/** Package root (one level up from dist/ — where package.json lives). */
export const PACKAGE_ROOT = join(ROOT, "..");
