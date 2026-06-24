import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative } from "node:path";
import type { Manifest } from "../types.js";
import { TEMPLATE_DIR } from "../paths.js";

export const BRIDGE_POLYFILL = "identity-polyfill.js";
export const BRIDGE_PAGE = "page-bridge.js";
export const BRIDGE_PAGE_CS = "page-bridge-cs.js";

/** Placeholder the bridge templates carry; replaced with the real Chrome id when derivable. */
const EXT_ID_PLACEHOLDER = "__C2S_EXTENSION_ID__";

/**
 * Derive an extension's Chrome id from its manifest `key` (base64 DER public key).
 * Chrome's rule: SHA-256 the decoded key, take the first 16 bytes, and map each
 * nibble 0–15 to a–p. Returns undefined for an unpacked extension (no key) or a
 * malformed key, in which case the templates fall back to the live runtime id.
 */
export function deriveChromeId(manifest: Manifest): string | undefined {
  const key = manifest.key;
  if (typeof key !== "string" || key.length === 0) return undefined;
  let der: Buffer;
  try {
    der = Buffer.from(key, "base64");
  } catch {
    return undefined;
  }
  if (der.length === 0) return undefined;
  const digest = createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/** Replace the build-time extension-id placeholder in a staged template file. */
function substituteExtId(filePath: string, chromeId: string | undefined): void {
  if (!chromeId || !existsSync(filePath)) return;
  const src = readFileSync(filePath, "utf-8");
  if (!src.includes(EXT_ID_PLACEHOLDER)) return;
  writeFileSync(filePath, src.split(EXT_ID_PLACEHOLDER).join(chromeId), "utf-8");
}

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
export function applyOAuthBridge(stageDir: string, manifest: Manifest, chromeId?: string): string[] {
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
  // The bridge templates carry a placeholder Chrome id. When the caller passes the
  // extension's real Chrome id (derived from the source manifest `key`) we bake it
  // in; otherwise the placeholder stays and the templates fall back to the live
  // runtime id at execution time. Either way the bridge works for ANY extension.
  copyFileSync(join(TEMPLATE_DIR, BRIDGE_POLYFILL), join(stageDir, BRIDGE_POLYFILL));
  substituteExtId(join(stageDir, BRIDGE_POLYFILL), chromeId);

  // 2. The SW (or its loader) must run the polyfill FIRST so the bridge receiver
  //    and chrome.identity shim install before the bundle evaluates.
  injectPolyfillImport(stageDir, sw);

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
  substituteExtId(join(stageDir, BRIDGE_PAGE), chromeId);
  copyFileSync(join(TEMPLATE_DIR, BRIDGE_PAGE_CS), join(stageDir, BRIDGE_PAGE_CS));

  manifest.content_scripts = manifest.content_scripts ?? [];
  // Idempotent: don't append a second pair of bridge entries if this manifest was
  // already bridged (re-convert / retry / incremental build), which would inject
  // the MAIN-world bridge twice.
  const alreadyBridged = manifest.content_scripts.some(
    (cs) => Array.isArray(cs.js) && cs.js.includes(BRIDGE_PAGE)
  );
  if (!alreadyBridged) {
    // MAIN world: fake chrome.runtime in the page. Isolated world: relay to SW.
    manifest.content_scripts.unshift(
      { js: [BRIDGE_PAGE], matches, run_at: "document_start", all_frames: false, world: "MAIN" },
      { js: [BRIDGE_PAGE_CS], matches, run_at: "document_start", all_frames: false }
    );
  }

  // 5. page-bridge.js must be web-accessible so a getURL/script-tag fallback works
  //    on Safari versions that ignore world:"MAIN" content scripts.
  addWebAccessible(manifest, BRIDGE_PAGE, matches);

  notes.push(`OAuth bridge wired (page↔SW) for: ${matches.join(", ")}`);
  return notes;
}

/**
 * Prepend `import "<rel>/identity-polyfill.js";` to the SW entry if absent.
 * The polyfill is copied to the stage ROOT, but the SW may live in a subdir
 * (e.g. service-worker/index.js). A bare "./identity-polyfill.js" then resolves
 * to service-worker/identity-polyfill.js → 404 → the whole SW module fails to
 * load and never registers its onConnect/onMessage listeners. So compute the
 * path FROM the SW's own directory back to the root where the polyfill sits.
 */
function injectPolyfillImport(stageDir: string, swRel: string): void {
  const swPath = join(stageDir, swRel);
  if (!existsSync(swPath)) return;
  const src = readFileSync(swPath, "utf-8");
  // Relative path from the SW's dir to the root polyfill. For a root SW this is
  // "./identity-polyfill.js"; for service-worker/index.js it's "../identity-polyfill.js".
  let rel = relative(dirname(swRel), BRIDGE_POLYFILL).split("\\").join("/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  // Match the actual import, not a bare filename mention (a comment or URL referencing
  // identity-polyfill.js would otherwise suppress the required import).
  if (src.includes(`"${rel}"`)) return;
  writeFileSync(swPath, `import "${rel}";\n` + src, "utf-8");
}

/** Ensure `resource` is exposed to `matches` in web_accessible_resources (MV3 form). */
function addWebAccessible(manifest: Manifest, resource: string, matches: string[]): void {
  // Normalize whatever's there into MV3 object form, preserving existing entries.
  // A bare MV2 string[] (or a stray loose string in a mixed array) gets wrapped
  // rather than dropped; only a wholly-malformed non-array value resets to empty.
  const existing = manifest.web_accessible_resources;
  const raw: unknown[] = Array.isArray(existing) ? existing : [];
  const looseStrings = raw.filter((e): e is string => typeof e === "string");
  const war = raw.filter(
    (e): e is WarEntry => typeof e === "object" && e !== null
  );
  if (looseStrings.length > 0) {
    war.push({ resources: looseStrings, matches: ["<all_urls>"] });
  }
  const already = war.some(
    (e) => Array.isArray(e.resources) && e.resources.includes(resource)
  );
  if (!already) war.push({ resources: [resource], matches, use_dynamic_url: false });
  manifest.web_accessible_resources = war;
}
