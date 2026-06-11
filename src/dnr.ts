import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./types.js";

/** True if the extension talks to api.anthropic.com (CSP, host_permissions, etc.). */
export function needsAnthropicCorsBypass(manifest: Manifest): boolean {
  return /api\.anthropic\.com/i.test(JSON.stringify(manifest));
}

interface DnrRule {
  action?: { type?: string };
}

/**
 * Sanitize declarativeNetRequest for Safari and report anything dropped.
 *
 * Static rulesets: Safari (current WebKit) crashes the WHOLE browser when a DNR
 * ruleset contains a "modifyHeaders" action — reading the rule back from its
 * SQLite store null-derefs in WebExtensionContext::loadDeclarativeNetRequestRules
 * → getRulesWithRuleIDs (EXC_BAD_ACCESS). The runtime shim already strips such
 * rules from update{Session,Dynamic}Rules calls, but static rule_resources files
 * load straight from disk and never pass through the shim — so strip them here.
 * block/redirect/allow/upgradeScheme rules pass through untouched.
 *
 * api.anthropic.com's org CORS gate keys on `sec-fetch-site`, a browser-controlled
 * forbidden header that JS cannot set and that Safari refuses to let DNR modify;
 * the only viable path is an out-of-process native-messaging proxy, so no
 * CORS-bypass ruleset is shipped — just a note.
 */
export function applyDnr(stageDir: string, manifest: Manifest): string[] {
  const notes: string[] = [];

  for (const res of manifest.declarative_net_request?.rule_resources ?? []) {
    const file = join(stageDir, res.path);
    if (!existsSync(file)) {
      notes.push(`DNR ruleset "${res.id}" points to missing file ${res.path}; Safari will fail to load it.`);
      continue;
    }
    let rules: unknown;
    try {
      rules = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      notes.push(`DNR ruleset "${res.id}" (${res.path}) is not valid JSON; Safari will fail to load it.`);
      continue;
    }
    if (!Array.isArray(rules)) continue;
    const safe = (rules as DnrRule[]).filter((r) => r?.action?.type !== "modifyHeaders");
    if (safe.length !== rules.length) {
      writeFileSync(file, JSON.stringify(safe, null, 2) + "\n", "utf-8");
      notes.push(
        `Stripped ${rules.length - safe.length} modifyHeaders rule(s) from DNR ruleset "${res.id}" — ` +
          "modifyHeaders crashes Safari's DNR rule store; other rules kept."
      );
    }
  }

  if (needsAnthropicCorsBypass(manifest)) {
    notes.push(
      "api.anthropic.com calls hit an org CORS gate that cannot be bypassed in-browser; " +
        "no DNR ruleset shipped (a modifyHeaders rule crashes Safari). Use a native-messaging proxy."
    );
  }
  return notes;
}
