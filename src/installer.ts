import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, info, ok, warn } from "./util.js";
import { pluginkitStatus } from "./packager.js";

/** Full path to LaunchServices' lsregister (not on PATH). */
export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export interface InstallOptions {
  /** The built .app produced by buildXcodeProject. */
  builtAppPath: string;
  appName: string;
  bundleId: string;
  /** Target dir for the installed app; defaults to ~/Applications. */
  installDir?: string;
  /** When false, skip the Safari quit/toggle/relaunch (gentler mode). */
  safariRestart: boolean;
  /** App is signed with a real Apple team → skip the unsigned toggle (it persists). */
  signed: boolean;
}

export interface InstallResult {
  /** Where the app was installed, or null if the copy failed. */
  installedAppPath: string | null;
  /** pluginkit reports the extension's bundle id as registered. */
  registered: boolean;
  /** We wrote AllowUnsignedAppExtensions = true. */
  unsignedToggleSet: boolean;
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** True when pluginkit's output lists the extension's bundle id. */
export function bundleRegistered(pluginkitOutput: string, bundleId: string): boolean {
  return pluginkitOutput.includes(bundleId);
}

function safariRunning(): boolean {
  return run("/usr/bin/pgrep", ["-x", "Safari"]).code === 0;
}

/**
 * Install the built host app so its Safari extension persists across Safari
 * restarts: copy to a stable dir, register with LaunchServices, optionally
 * enable Safari's unsigned-extension toggle and bounce Safari, then launch the
 * host app so Safari registers the appex.
 */
export function installToSafari(opts: InstallOptions): InstallResult {
  const result: InstallResult = {
    installedAppPath: null,
    registered: false,
    unsignedToggleSet: false,
  };

  const targetDir = expandHome(opts.installDir ?? "~/Applications");
  mkdirSync(targetDir, { recursive: true });
  const dest = join(targetDir, `${opts.appName}.app`);

  // Replace any stale copy so removed files don't linger.
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  info(`Installing host app → ${dest}`);
  const cp = run("/usr/bin/ditto", [opts.builtAppPath, dest]);
  if (cp.code !== 0) {
    warn(`Install copy failed: ${cp.stderr.trim() || cp.stdout.trim() || `ditto exit ${cp.code}`}`);
    return result;
  }
  result.installedAppPath = dest;
  ok(`Copied host app to ${dest}`);

  // The build already ad-hoc signs with the App Sandbox entitlement and seals the
  // bundle; ditto preserves that. Do NOT re-sign here — a plain `codesign --sign -`
  // would strip the entitlements and Safari would stop registering the appex.
  const reg = run(LSREGISTER, ["-f", dest]);
  if (reg.code === 0) ok("Registered with LaunchServices");
  else warn(`lsregister exit ${reg.code} — Safari may take a moment to see the app.`);

  // A team-signed extension loads without the (session-scoped) unsigned toggle, so skip
  // the whole Safari quit/toggle/relaunch dance when signed.
  const applyUnsigned = !opts.signed && opts.safariRestart;
  if (applyUnsigned) {
    if (safariRunning()) {
      warn("Quitting Safari to apply the unsigned-extension setting …");
      run("/usr/bin/osascript", ["-e", 'tell application "Safari" to quit']);
    }
    const def = run("/usr/bin/defaults", [
      "write",
      "com.apple.Safari",
      "AllowUnsignedAppExtensions",
      "-bool",
      "true",
    ]);
    if (def.code === 0) {
      result.unsignedToggleSet = true;
      ok('Set Safari "Allow Unsigned Extensions" = true');
    } else {
      warn('Could not set "Allow Unsigned Extensions"; enable it manually (Develop menu).');
    }
  }

  info("Launching host app to register the extension …");
  run("/usr/bin/open", [dest]);

  if (applyUnsigned) run("/usr/bin/open", ["-a", "Safari"]);

  result.registered = bundleRegistered(pluginkitStatus(), opts.bundleId);
  if (result.registered) ok("pluginkit lists the extension as registered.");
  else warn("pluginkit has not listed the extension yet (give Safari a moment, then check Settings → Extensions).");

  return result;
}
