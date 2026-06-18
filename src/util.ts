import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";

const RESET = "\x1b[0m";
const COLORS = {
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
} as const;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function color(c: keyof typeof COLORS, s: string): string {
  return useColor ? `${COLORS[c]}${s}${RESET}` : s;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let verbose = false;
/** Enable live echo of every subprocess invocation and its output. */
export function setVerbose(v: boolean): void {
  verbose = v;
}

/** Run a command, capturing output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  if (verbose) console.error(color("dim", `$ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: `command not found: ${cmd}` };
  }
  const stdout = (res.stdout as string) ?? "";
  const stderr = (res.stderr as string) ?? "";
  if (verbose) {
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);
  }
  return { code: res.status ?? 1, stdout, stderr };
}

export function commandExists(cmd: string): boolean {
  return run("/usr/bin/which", [cmd]).code === 0;
}

// Diagnostics go to stderr so stdout carries only real output (e.g. the
// --analyze --json payload). A consumer piping stdout must get clean JSON, not
// interleaved progress lines.
export function info(msg: string): void {
  console.error(`${color("blue", "›")} ${msg}`);
}
export function ok(msg: string): void {
  console.error(`${color("green", "✓")} ${msg}`);
}
export function warn(msg: string): void {
  console.error(`${color("yellow", "!")} ${msg}`);
}
export function fail(msg: string): void {
  console.error(`${color("red", "✗")} ${msg}`);
}

/**
 * Move a bundle/dir to `dest`, leaving NO copy behind. A same-volume rename is
 * instant and preserves the code signature untouched; across volumes (EXDEV) we
 * ditto-copy then delete the source, so the end state is still a single moved app.
 */
export function moveBundle(src: string, dest: string): boolean {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    if (run("/usr/bin/ditto", [src, dest]).code !== 0) return false;
    rmSync(src, { recursive: true, force: true });
  }
  return existsSync(dest);
}
