import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./types.js";

export const DNR_RULES_FILENAME = "c2s_dnr_rules.json";
const RULESET_ID = "c2s_cors";
const DNR_PERMISSION = "declarativeNetRequestWithHostAccess";

// The official Chrome extension's accepted /v1/messages request.
const CHROME_EXT_ORIGIN = "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn";

/**
 * Pin Origin to the chrome-extension value the API accepts, matching the official
 * extension's request shape.
 *
 * NOTE: this does NOT defeat the org-level CORS gate ("CORS requests are not
 * allowed for this Organization"). That gate keys on `sec-fetch-site`: the
 * official Chrome extension is accepted because its privileged host_permissions
 * fetch sends `sec-fetch-site: none`, while Safari sends `cross-site`. Sec-Fetch-*
 * are browser-controlled forbidden headers — JS cannot set them, and Safari
 * REJECTS a DNR ruleset that tries to modify them (the extension fails to load
 * entirely). So the gate cannot be beaten from inside the browser; api.anthropic.com
 * calls must be made out-of-process via a native-messaging proxy (full signed
 * build — temp-loaded extensions cannot use native messaging).
 */
function anthropicCorsRules(): unknown[] {
  return [
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "origin", operation: "set", value: CHROME_EXT_ORIGIN }],
      },
      condition: {
        urlFilter: "||anthropic.com",
        resourceTypes: ["xmlhttprequest", "other"],
      },
    },
  ];
}

/** True if the extension talks to api.anthropic.com (CSP, host_permissions, etc.). */
export function needsAnthropicCorsBypass(manifest: Manifest): boolean {
  return /api\.anthropic\.com/i.test(JSON.stringify(manifest));
}

/**
 * Write the CORS-bypass ruleset and register it on the (already-transformed)
 * manifest. Mutates `manifest`. Returns human-readable notes for the CLI.
 */
export function applyDnr(stageDir: string, manifest: Manifest): string[] {
  if (!needsAnthropicCorsBypass(manifest)) return [];
  const notes: string[] = [];

  writeFileSync(
    join(stageDir, DNR_RULES_FILENAME),
    JSON.stringify(anthropicCorsRules(), null, 2) + "\n",
    "utf-8"
  );
  notes.push(`DNR ruleset written → ${DNR_RULES_FILENAME} (sets Origin for *.anthropic.com)`);

  const dnr = (manifest.declarative_net_request ??= {}) as {
    rule_resources?: Array<{ id: string; enabled: boolean; path: string }>;
  };
  const resources = (dnr.rule_resources ??= []);
  if (!resources.some((r) => r.id === RULESET_ID)) {
    resources.push({ id: RULESET_ID, enabled: true, path: DNR_RULES_FILENAME });
  }

  const perms = (manifest.permissions ??= []);
  if (!perms.includes(DNR_PERMISSION)) {
    perms.push(DNR_PERMISSION);
    notes.push(`Added "${DNR_PERMISSION}" permission`);
  }

  return notes;
}
