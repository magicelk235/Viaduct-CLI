import type { Manifest } from "./types.js";

/** True if the extension talks to api.anthropic.com (CSP, host_permissions, etc.). */
export function needsAnthropicCorsBypass(manifest: Manifest): boolean {
  return /api\.anthropic\.com/i.test(JSON.stringify(manifest));
}

/**
 * api.anthropic.com's org CORS gate keys on `sec-fetch-site`, a browser-controlled
 * forbidden header that JS cannot set and that Safari REFUSES to let a DNR ruleset
 * modify. We previously emitted a `modifyHeaders` rule that pinned `Origin` to the
 * official extension's value — but it (a) never defeated the gate, since the gate
 * ignores Origin, and (b) crashed Safari on load: WebKit dereferences a null rule
 * array inside `WebExtensionContext::loadDeclarativeNetRequestRules` →
 * `getRulesWithRuleIDs`, taking the whole browser down (EXC_BAD_ACCESS).
 *
 * So we no longer ship any CORS-bypass ruleset. The only viable path for
 * api.anthropic.com is an out-of-process native-messaging proxy (full signed build).
 */
export function applyDnr(_stageDir: string, manifest: Manifest): string[] {
  if (!needsAnthropicCorsBypass(manifest)) return [];
  return [
    "api.anthropic.com calls hit an org CORS gate that cannot be bypassed in-browser; " +
      "no DNR ruleset shipped (a modifyHeaders rule crashes Safari). Use a native-messaging proxy.",
  ];
}
