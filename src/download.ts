import { get } from "node:https";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

// Chrome extension IDs are 32 chars from the alphabet a–p (base16-ish mojibake).
const EXT_ID_RE = /^[a-p]{32}$/;

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** Pull the 32-char extension ID out of a Chrome Web Store detail URL. */
export function extractStoreId(url: string): string | undefined {
  let host: string;
  let segments: string[];
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    segments = u.pathname.split("/").filter(Boolean);
  } catch {
    return undefined;
  }
  const isStore =
    host === "chromewebstore.google.com" ||
    host === "chrome.google.com"; // legacy /webstore/detail/...
  if (!isStore) return undefined;
  // Last path segment that looks like an extension ID wins; store URLs put it last.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (EXT_ID_RE.test(segments[i])) return segments[i];
  }
  return undefined;
}

/** Build the clients2 CRX download endpoint (302-redirects to the real CRX). */
export function crxEndpoint(id: string): string {
  const x = `id=${id}&installsource=ondemand&uc`;
  return (
    "https://clients2.google.com/service/update2/crx" +
    "?response=redirect&acceptformat=crx2,crx3&prodversion=120.0" +
    `&x=${encodeURIComponent(x)}`
  );
}

interface HttpResult {
  buffer: Buffer;
  finalUrl: string;
  contentType: string;
}

function httpGet(url: string, redirectsLeft = MAX_REDIRECTS): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    // Guard against resolve/reject racing each other: a size-cap reject and a
    // buffered `end` (which would resolve with the truncated buffer) can both
    // fire, and whichever lands second is a silent no-op. Settle exactly once.
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = get(url, (res) => {
      const status = res.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.resume(); // drain
        if (!location) {
          done(() => reject(new Error(`Redirect (${status}) with no Location header: ${url}`)));
          return;
        }
        if (redirectsLeft <= 0) {
          done(() => reject(new Error(`Too many redirects fetching ${url}`)));
          return;
        }
        const next = new URL(location, url);
        // Only follow https redirects; an untrusted endpoint must not be able to
        // redirect the fetch to http:// (or another scheme) and reach an internal host.
        if (next.protocol !== "https:") {
          done(() => reject(new Error(`Refusing non-https redirect to ${next.protocol}// from ${url}`)));
          return;
        }
        done(() => resolve(httpGet(next.toString(), redirectsLeft - 1)));
        return;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        done(() => reject(new Error(`HTTP ${status} fetching ${url}`)));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BYTES) {
          res.destroy();
          req.destroy();
          done(() => reject(new Error(`Download exceeds ${MAX_BYTES} bytes: ${url}`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        done(() => resolve({
          buffer: Buffer.concat(chunks),
          finalUrl: url,
          contentType: String(res.headers["content-type"] ?? ""),
        }));
      });
      res.on("error", (e) => done(() => reject(e)));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`Timed out after ${TIMEOUT_MS}ms fetching ${url}`));
    });
    req.on("error", (e) => done(() => reject(e)));
  });
}

/** Sniff CRX/ZIP magic; fall back to the URL's extension. */
function inferKind(buf: Buffer, url: string): "crx" | "zip" {
  if (buf.subarray(0, 4).toString("ascii") === "Cr24") return "crx";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return "zip";
  }
  const lower = url.toLowerCase();
  if (lower.endsWith(".crx")) return "crx";
  if (lower.endsWith(".zip")) return "zip";
  throw new Error(
    "Downloaded file is not a CRX or ZIP (got an unexpected response, e.g. an HTML error page).",
  );
}

/**
 * Download an extension from a Chrome Web Store URL or a direct .crx/.zip URL.
 * Returns the local path to the saved archive (for extractExtension).
 */
export async function downloadExtension(url: string, scratchDir: string): Promise<string> {
  const storeId = extractStoreId(url);
  let fetchUrl = url;
  if (storeId) {
    fetchUrl = crxEndpoint(storeId);
  } else if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/i.test(url)) {
    throw new Error(
      `Could not find a 32-char extension ID in the store URL.\n` +
        `Expected something like https://chromewebstore.google.com/detail/<name>/<id>`,
    );
  }

  const { buffer } = await httpGet(fetchUrl);
  const kind = inferKind(buffer, storeId ? "store.crx" : url);
  const dest = join(scratchDir, `download.${kind}`);
  writeFileSync(dest, buffer);
  return dest;
}
