import { test } from "node:test";
import assert from "node:assert/strict";
import { needsAnthropicCorsBypass } from "../dist/dnr.js";

test("needsAnthropicCorsBypass detects api.anthropic.com in host_permissions", () => {
  assert.equal(
    needsAnthropicCorsBypass({ host_permissions: ["https://api.anthropic.com/*"] }),
    true
  );
});

test("needsAnthropicCorsBypass detects the host anywhere in the manifest", () => {
  assert.equal(
    needsAnthropicCorsBypass({ content_security_policy: { extension_pages: "connect-src https://api.anthropic.com" } }),
    true
  );
});

test("needsAnthropicCorsBypass is false for unrelated extensions", () => {
  assert.equal(needsAnthropicCorsBypass({ host_permissions: ["https://example.com/*"] }), false);
  assert.equal(needsAnthropicCorsBypass({}), false);
});
