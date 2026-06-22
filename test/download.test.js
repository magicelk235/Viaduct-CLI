import { test } from "node:test";
import assert from "node:assert/strict";
import { isUrl, extractStoreId, crxEndpoint } from "../dist/input/download.js";

test("isUrl recognizes http and https only", () => {
  assert.equal(isUrl("https://example.com/x.crx"), true);
  assert.equal(isUrl("http://example.com/x.zip"), true);
  assert.equal(isUrl("HTTPS://EXAMPLE.COM"), true);
  assert.equal(isUrl("ftp://example.com/x.zip"), false);
  assert.equal(isUrl("./local/path.zip"), false);
  assert.equal(isUrl("file:///tmp/x.zip"), false);
});

test("extractStoreId pulls the 32-char id from a modern store URL", () => {
  const id = extractStoreId(
    "https://chromewebstore.google.com/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm"
  );
  assert.equal(id, "cjpalhdlnbpafiamejdnhcphjbkeiagm");
});

test("extractStoreId handles the legacy chrome.google.com/webstore host", () => {
  const id = extractStoreId(
    "https://chrome.google.com/webstore/detail/ublock-origin/cjpalhdlnbpafiamejdnhcphjbkeiagm"
  );
  assert.equal(id, "cjpalhdlnbpafiamejdnhcphjbkeiagm");
});

test("extractStoreId ignores non-store hosts and malformed urls", () => {
  assert.equal(extractStoreId("https://example.com/detail/x/cjpalhdlnbpafiamejdnhcphjbkeiagm"), undefined);
  assert.equal(extractStoreId("not a url"), undefined);
});

test("extractStoreId returns undefined when no id-shaped segment is present", () => {
  assert.equal(extractStoreId("https://chromewebstore.google.com/detail/ublock-origin"), undefined);
  // An id with an out-of-alphabet char (z is not in a–p) must not match.
  assert.equal(
    extractStoreId("https://chromewebstore.google.com/detail/x/zjpalhdlnbpafiamejdnhcphjbkeiagm"),
    undefined
  );
});

test("crxEndpoint builds a clients2 redirect URL embedding the id", () => {
  const url = crxEndpoint("cjpalhdlnbpafiamejdnhcphjbkeiagm");
  assert.match(url, /^https:\/\/clients2\.google\.com\/service\/update2\/crx\?/);
  assert.match(url, /response=redirect/);
  assert.match(url, /acceptformat=crx2,crx3/);
  // The id is embedded inside the percent-encoded `x` param.
  assert.ok(decodeURIComponent(url).includes("id=cjpalhdlnbpafiamejdnhcphjbkeiagm"));
});
