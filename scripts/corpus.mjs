#!/usr/bin/env node
// Corpus runner: download a curated set of popular Chrome extensions and run
// `chrome2safari --analyze --json` against each, then aggregate convertibility.
// This surfaces real-world conversion bugs and produces a headline number
// ("converts N% of the corpus"). No Xcode needed — analyze is pure logic.
//
// Usage:  node scripts/corpus.mjs            (uses the built-in list)
//         node scripts/corpus.mjs id1 id2 …  (override with explicit ext IDs)
//
// Each entry is [extensionId, friendlyName]. IDs are the 32-char store IDs.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

const CORPUS = [
  ["cjpalhdlnbpafiamejdnhcphjbkeiagm", "uBlock Origin"],
  ["gighmmpiobklfepjocnamgkkbiglidom", "AdBlock"],
  ["cfhdojbkjhnklbpkdaibdccddilifddb", "Adblock Plus"],
  ["bgnkhhnnamicmpeenaelnjfhikgbkllg", "AdGuard"],
  ["dbepggeogbaibhgnhhndojpepiihcmeb", "Vimium"],
  ["aapbdbdomjkkjkaonfhkkikfgjllcleb", "Google Translate"],
  ["fmkadmapgofadopljbjfkapdkoienihi", "React Developer Tools"],
  ["lmhkpmbekcpmknklioeibfkpmmfibljd", "Redux DevTools"],
  ["nngceckbapebfimnlniiiahkandclblb", "Bitwarden"],
  ["hdokiejnpimakedhajhdlcegeplioahd", "LastPass"],
  ["fheoggkfdfchfphceeifdbepaooicaho", "McAfee WebAdvisor"],
  ["mlomiejdfkolichcflejclcbmpeaniij", "Ghostery"],
  ["pkehgijcmpdhfbdbbnkijodmdjhbjlgp", "Privacy Badger"],
  ["edibdbjcniadpccecjdfdjjppcpchdlm", "I dont care about cookies"],
  ["bhlhnicpbhignbdhedgjhgdocnmhomnp", "ColorZilla"],
  ["dhdgffkkebhmkfjojejmpbldmpobfkfo", "Tampermonkey"],
  ["jlhmfgmfgeifomenelglieieghnjghma", "Cisco Webex"],
  ["nkbihfbeogaeaoehlefnkodbefgpgknn", "MetaMask"],
  ["oldceeleldhonbafppcapldpdifcinji", "Grammarly"],
  ["liecbddmkiiihnedobmlmillhodjkdmb", "Loom"],
];

const ids = process.argv.slice(2);
const list = ids.length ? ids.map((id) => [id, id]) : CORPUS;

function analyze(id) {
  const url = `https://chromewebstore.google.com/detail/x/${id}`;
  try {
    // stderr (progress) is inherited so the operator sees life; stdout is the JSON.
    const stdout = execFileSync("node", [CLI, url, "--analyze", "--json"], {
      encoding: "utf-8",
      // Capture stderr so a download failure surfaces its real, actionable
      // message (the CLI exits 1 and writes the reason to stderr).
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, report: JSON.parse(stdout) };
  } catch (e) {
    // The CLI exits 1 on blocking issues but still prints JSON; recover it.
    if (e.stdout) {
      try {
        return { ok: true, report: JSON.parse(e.stdout) };
      } catch {
        /* fall through to error */
      }
    }
    return { ok: false, error: (e.stderr || e.message || "").toString().trim().split("\n").pop() };
  }
}

const results = [];
for (const [id, name] of list) {
  process.stderr.write(`\n=== ${name} (${id}) ===\n`);
  const r = analyze(id);
  if (!r.ok) {
    process.stderr.write(`  ✗ failed: ${r.error}\n`);
    results.push({ name, id, status: "download-or-parse-error", error: r.error });
    continue;
  }
  const d = r.report;
  if (d.error) {
    results.push({ name, id, status: "analyze-error", error: d.error });
    continue;
  }
  results.push({
    name: d.name || name,
    id,
    status: d.convertible ? "convertible" : "blocked",
    mv: d.manifestVersion,
    blocking: d.blocking,
    counts: d.counts,
    removedPermissions: d.removedPermissions,
  });
}

// ---- Summary ----
const total = results.length;
const convertible = results.filter((r) => r.status === "convertible").length;
const blocked = results.filter((r) => r.status === "blocked").length;
const errored = results.filter((r) => r.status.includes("error")).length;
const analyzed = convertible + blocked;

console.log("\n================ CORPUS SUMMARY ================");
for (const r of results) {
  const tag =
    r.status === "convertible"
      ? "OK  "
      : r.status === "blocked"
        ? "BLOCK"
        : "ERR ";
  const detail =
    r.status === "convertible" || r.status === "blocked"
      ? `MV${r.mv}  blocking=${r.blocking}  removed=[${(r.removedPermissions || []).join(",")}]`
      : r.error || "";
  console.log(`  ${tag}  ${r.name.padEnd(28)} ${detail}`);
}
console.log("-----------------------------------------------");
console.log(`  total:        ${total}`);
console.log(`  analyzed:     ${analyzed}  (download+parse succeeded)`);
console.log(`  convertible:  ${convertible}${analyzed ? `  (${Math.round((convertible / analyzed) * 100)}% of analyzed)` : ""}`);
console.log(`  blocked:      ${blocked}`);
console.log(`  errored:      ${errored}  (download/network/parse)`);
console.log("===============================================");

// Non-zero exit only if NOTHING analyzed (likely a real breakage), not for
// individual blocked/errored extensions which are expected in a real corpus.
process.exit(analyzed === 0 ? 1 : 0);
