import { run, info, ok, warn } from "../util.js";
import { pluginkitStatus } from "./packager.js";
import { bundleRegistered } from "./installer.js";

export interface VerifyResult {
  registered: boolean;
  /** pluginkit reports the extension as enabled/allowed (not just present). */
  enabled: boolean | null;
}

// pluginkit's verbose (`-mAvvv`) output prints a per-plugin block. Within the
// block for our appex it lists a status line; an extension Safari has accepted
// shows `"enabled" = 1` (or no explicit disable). We can't drive WebInspector
// from a plain CLI, so "loads cleanly" is approximated by: registered AND not
// flagged disabled. Console-error capture is a platform limit, not done here.
// ponytail: pluginkit-flag heuristic, upgrade to WebInspector relay if console errors are needed.
export function parseEnabled(pluginkitVerbose: string, extBundleId: string): boolean | null {
  const marker = `${extBundleId}.Extension`;
  const idx = pluginkitVerbose.indexOf(marker);
  if (idx === -1) return null;
  // The plugin's block runs from its id to the next blank-line separator.
  const rest = pluginkitVerbose.slice(idx);
  const end = rest.indexOf("\n\n");
  const block = end === -1 ? rest : rest.slice(0, end);
  if (/"enabled"\s*=\s*0/.test(block) || /\bdisabled\b/i.test(block)) return false;
  if (/"enabled"\s*=\s*1/.test(block)) return true;
  // Present but no explicit enabled flag: registered-but-unknown, treat as null.
  return null;
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
  const enabled = parseEnabled(status, bundleId);

  if (!registered) {
    warn("Extension is not registered with Safari yet. Open Safari → Settings → Extensions and enable it, then re-run --verify.");
  } else if (enabled === false) {
    warn("Extension is registered but disabled. Enable it in Safari → Settings → Extensions.");
  } else {
    ok("Extension is registered with Safari." + (enabled ? " Enabled." : " (Enable it in Settings → Extensions if not already.)"));
  }
  return { registered, enabled };
}
