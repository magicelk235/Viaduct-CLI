import { spawnSync, type SpawnSyncOptions } from "node:child_process";

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

/** Run a command, capturing output. Never throws on non-zero exit. */
export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { code: 127, stdout: "", stderr: `command not found: ${cmd}` };
  }
  return {
    code: res.status ?? 1,
    stdout: (res.stdout as string) ?? "",
    stderr: (res.stderr as string) ?? "",
  };
}

export function commandExists(cmd: string): boolean {
  return run("/usr/bin/which", [cmd]).code === 0;
}

export function info(msg: string): void {
  console.log(`${color("blue", "›")} ${msg}`);
}
export function ok(msg: string): void {
  console.log(`${color("green", "✓")} ${msg}`);
}
export function warn(msg: string): void {
  console.log(`${color("yellow", "!")} ${msg}`);
}
export function fail(msg: string): void {
  console.error(`${color("red", "✗")} ${msg}`);
}
