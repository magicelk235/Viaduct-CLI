import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "./types.js";

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");

export const BRIDGE_POLYFILL = "identity-polyfill.js";
export const BRIDGE_PAGE = "page-bridge.js";
export const BRIDGE_PAGE_CS = "page-bridge-cs.js";

interface WarEntry {
  resources: string[];
  matches: string[];
  use_dynamic_url?: boolean;
}

/**
 * Wire the Safari OAuth bridge into a staged MV3 extension.
 *
 * Safari gives web pages no `chrome` namespace and routes externally_connectable
 * messages by the *Safari* extension id, but pages hardcode the *Chrome* id — so
 * the page↔extension OAuth handshake (launchWebAuthFlow + the `oauth_redirect`
 * callback message) silently dies. This emits three bridge assets and rewires the
 * manifest so the handshake completes:
 *   - identity-polyfill.js : shims chrome.identity in the SW + captures the SW's
 *     onMessageExternal handler and re-dispatches bridged page messages to it.
 *   - page-bridge.js       : MAIN-world fake `chrome.runtime` that relays over
 *     window.postMessage.
 *   - page-bridge-cs.js    : isolated-world relay page→SW (and back).
 *
 * No-op unless the extension has a background service worker. Mutates `manifest`.
 */
export function applyOAuthBridge(stageDir: string, manifest: Manifest): string[] {
  const notes: string[] = [];
  const sw = manifest.background?.service_worker;
  if (!sw) return notes; // only MV3 service-worker extensions have this handshake

  // 1. Emit the identity polyfill — it shims chrome.identity in the SW and is
  //    imported below regardless of whether the page bridge gets wired.
  for (const tmpl of [BRIDGE_POLYFILL, BRIDGE_PAGE, BRIDGE_PAGE_CS]) {
    if (!existsSync(join(TEMPLATE_DIR, tmpl))) {
      notes.push(`OAuth bridge template "${tmpl}" is missing from the install; skipping chrome.identity bridge.`);
      return notes;
    }
  }
  copyFileSync(join(TEMPLATE_DIR, BRIDGE_POLYFILL), join(stageDir, BRIDGE_POLYFILL));

  // 2. The SW (or its loader) must run the polyfill FIRST so the bridge receiver
  //    and chrome.identity shim install before the bundle evaluates.
  injectPolyfillImport(join(stageDir, sw));

  // 3. The loader uses ES `import`, so the background MUST stay a module.
  //    `sw` is truthy here, so `manifest.background` is guaranteed defined.
  manifest.background = { ...manifest.background, type: "module" };

  // 4. Wire the page-side bridge on the externally_connectable origins (that is
  //    exactly the set of pages allowed to message the extension). Without any
  //    such origins the page↔SW handshake can never fire, so don't emit the
  //    page-bridge files — they'd just be dead weight in the package.
  const matches = manifest.externally_connectable?.matches ?? [];
  if (matches.length === 0) {
    notes.push("chrome.identity shim emitted; page bridge skipped (no externally_connectable.matches to wire).");
    return notes;
  }

  // Page bridge is actually wired → emit its two assets now.
  copyFileSync(join(TEMPLATE_DIR, BRIDGE_PAGE), join(stageDir, BRIDGE_PAGE));
  copyFileSync(join(TEMPLATE_DIR, BRIDGE_PAGE_CS), join(stageDir, BRIDGE_PAGE_CS));

  manifest.content_scripts = manifest.content_scripts ?? [];
  // MAIN world: fake chrome.runtime in the page. Isolated world: relay to SW.
  manifest.content_scripts.unshift(
    { js: [BRIDGE_PAGE], matches, run_at: "document_start", all_frames: false, world: "MAIN" },
    { js: [BRIDGE_PAGE_CS], matches, run_at: "document_start", all_frames: false }
  );

  // 5. page-bridge.js must be web-accessible so a getURL/script-tag fallback works
  //    on Safari versions that ignore world:"MAIN" content scripts.
  addWebAccessible(manifest, BRIDGE_PAGE, matches);

  notes.push(`OAuth bridge wired (page↔SW) for: ${matches.join(", ")}`);
  return notes;
}

/** Prepend `import "./identity-polyfill.js";` to the SW entry if absent. */
function injectPolyfillImport(swPath: string): void {
  if (!existsSync(swPath)) return;
  const src = readFileSync(swPath, "utf-8");
  // Match the actual import, not a bare filename mention (a comment or URL referencing
  // identity-polyfill.js would otherwise suppress the required import).
  if (src.includes(`"./${BRIDGE_POLYFILL}"`)) return;
  writeFileSync(swPath, `import "./${BRIDGE_POLYFILL}";\n` + src, "utf-8");
}

/** Ensure `resource` is exposed to `matches` in web_accessible_resources (MV3 form). */
function addWebAccessible(manifest: Manifest, resource: string, matches: string[]): void {
  const war = Array.isArray(manifest.web_accessible_resources)
    ? (manifest.web_accessible_resources as WarEntry[])
    : [];
  const already = war.some(
    (e) => e && Array.isArray(e.resources) && e.resources.includes(resource)
  );
  if (!already) war.push({ resources: [resource], matches, use_dynamic_url: false });
  manifest.web_accessible_resources = war;
}
