// Runs an engine as a child process with the same stdio, working directory
// and environment, and makes the umbrella end the way the engine ended.

import { spawn } from "node:child_process";
import { constants } from "node:os";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
let relays = [];

export function forward(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    // The engine decides how to wind down; the umbrella just passes signals on
    // and waits for it.
    for (const signal of FORWARDED_SIGNALS) {
      const relay = () => child.kill(signal);
      relays.push([signal, relay]);
      process.on(signal, relay);
    }
    child.on("error", (error) => {
      removeRelays();
      reject(error);
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function removeRelays() {
  for (const [name, relay] of relays) process.off(name, relay);
  relays = [];
}

export function exitLike({ code, signal }) {
  removeRelays();
  if (signal) {
    process.kill(process.pid, signal);
    // Still here when Node ignores the signal (SIGPIPE): use the shell's convention.
    process.exit(128 + constants.signals[signal]);
  }
  process.exit(code);
}
