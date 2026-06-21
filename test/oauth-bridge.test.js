import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveChromeId } from "../dist/oauth-bridge.js";

// deriveChromeId reproduces Chrome's extension-id algorithm: SHA-256 the decoded
// `key` (DER public key), take the first 16 bytes, map each nibble 0–15 to a–p.
// The OAuth bridge routes messages by this id, so a wrong id silently breaks the
// handshake. The golden below is cross-checked against an independent SHA-256.

test("deriveChromeId reproduces Chrome's a–p id for a known key", () => {
  const id = deriveChromeId({ key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234" });
  assert.equal(id, "onimggcfembolhibancbbklgoefnpkok");
  assert.match(id, /^[a-p]{32}$/);
});

test("deriveChromeId is deterministic", () => {
  const k = { key: "AAAABBBBCCCCDDDD" };
  assert.equal(deriveChromeId(k), deriveChromeId(k));
});

test("deriveChromeId returns undefined for an unpacked or malformed key", () => {
  assert.equal(deriveChromeId({}), undefined); // unpacked extension, no key
  assert.equal(deriveChromeId({ key: "" }), undefined);
  assert.equal(deriveChromeId({ key: 123 }), undefined); // non-string
  // Base64 of nothing decodes to an empty buffer → undefined, not a bogus id.
  assert.equal(deriveChromeId({ key: "=" }), undefined);
});
