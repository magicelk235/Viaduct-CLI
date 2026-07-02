import { run, info, ok, warn } from "../util.js";
import { pluginkitStatus } from "./packager.js";
import { bundleRegistered } from "./installer.js";

export interface VerifyResult {
  registered: boolean;
  /** pluginkit reports the extension as enabled/allowed (not just present). */
  enabled: boolean | null;
}

// Enabled/disabled state is NOT in pluginkit's verbose (`-mAvvv`) block — that block
// only carries Path/UUID/SDK/Display Name/… (no "enabled" key, and the words
// enabled/disabled never appear). State lives in the FLAGS COLUMN of the compact
// `-mv`/`-m` listing: each line is `<flags><bundleId>(<ver>)\t<UUID>\t…`. Per
// `man pluginkit`, the annotation chars are: `+` = user elected to use, `-` =
// elected to ignore, `!` = elected for debugger use, `=` = superseded, `?` =
// unknown; no annotation means no election recorded (default policy), NOT
// "enabled". Parse that column, not the verbose block (the old `"enabled"=N`
// regexes were dead on real output, and a bare `\bdisabled\b` scan
// false-flagged any extension whose Path or name merely contained the word
// "disabled"). Returns null when the id isn't found (caller already checks
// registration separately).
// ponytail: flag-column heuristic, upgrade to WebInspector relay if console errors are needed.
export function parseEnabled(pluginkitCompact: string, extBundleId: string): boolean | null {
  const id = `${extBundleId}.Extension`;
  for (const line of pluginkitCompact.split("\n")) {
    const at = line.indexOf(id);
    if (at === -1) continue;
    // Everything before the id on its line is the annotation column (plus indent).
    const flags = line.slice(0, at).trim();
    if (flags.includes("+") || flags.includes("!")) return true; // elected to use
    if (flags.includes("-")) return false;                       // elected to ignore
    return null; // blank/'='/'?' → no election recorded / unknown
  }
  return null;
}

// Compact, machine-parseable plugin listing whose leading flag column carries the
// enabled/disabled state (unlike the verbose -mAvvv block used for registration).
export function pluginkitCompactStatus(): string {
  return run("pluginkit", ["-mv", "-p", "com.apple.Safari.web-extension"]).stdout;
}

/**
 * Post-install sanity check: confirm Safari actually registered (and didn't
 * disable) the extension. Launches Safari so the appex gets a chance to register,
 * then polls pluginkit. Best-effort — a `null` enabled state means "registered,
 * couldn't confirm enabled", not failure.
 */
export function verifyInSafari(bundleId: string): VerifyResult {
  info("Verifying the extension loaded in Safari …");
  // Nudge Safari to scan extensions; harmless if already open.
  run("/usr/bin/open", ["-a", "Safari"]);

  const status = pluginkitStatus();
  const registered = bundleRegistered(status, bundleId);
  // State comes from the compact flag column, not the verbose block.
  const enabled = parseEnabled(pluginkitCompactStatus(), bundleId);

  if (!registered) {
    warn("Extension is not registered with Safari yet. Open Safari → Settings → Extensions and enable it, then re-run --verify.");
  } else if (enabled === false) {
    warn("Extension is registered but disabled. Enable it in Safari → Settings → Extensions.");
  } else {
    ok("Extension is registered with Safari." + (enabled ? " Enabled." : " (Enable it in Settings → Extensions if not already.)"));
  }
  return { registered, enabled };
}
