import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsAnthropicCorsBypass, applyDnr } from "../dist/dnr.js";

function stageWith(rulesets) {
  const dir = mkdtempSync(join(tmpdir(), "dnr-test-"));
  for (const [path, rules] of Object.entries(rulesets)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, JSON.stringify(rules));
  }
  return dir;
}

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

test("applyDnr strips Safari-crashing modifyHeaders rules and keeps the rest", () => {
  const dir = stageWith({
    "rules.json": [
      { id: 1, action: { type: "block" }, condition: { urlFilter: "ads" } },
      { id: 2, action: { type: "modifyHeaders" }, condition: { urlFilter: "x" } },
    ],
  });
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "rs", enabled: true, path: "rules.json" }] },
  });
  const kept = JSON.parse(readFileSync(join(dir, "rules.json"), "utf-8"));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].action.type, "block");
  assert.ok(notes.some((n) => /Stripped 1 modifyHeaders/.test(n)));
});

test("applyDnr notes a missing ruleset file by its id", () => {
  const dir = stageWith({}); // no files on disk
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "myrules", enabled: true, path: "gone.json" }] },
  });
  assert.ok(notes.some((n) => n.includes('"myrules"') && n.includes("missing")));
});

test("applyDnr falls back to the path when a ruleset has no id (no literal 'undefined')", () => {
  const dir = stageWith({}); // file absent → missing-file branch
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ enabled: true, path: "rules/a.json" }] },
  });
  const note = notes.find((n) => n.includes("missing"));
  assert.ok(note, "expected a missing-file note");
  assert.ok(!note.includes("undefined"), "note must not contain the literal 'undefined'");
  assert.ok(note.includes("rules/a.json"));
});

test("applyDnr leaves a clean block ruleset untouched and silent", () => {
  const rules = [{ id: 1, action: { type: "block" }, condition: { urlFilter: "ads" } }];
  const dir = stageWith({ "ok.json": rules });
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "ok", enabled: true, path: "ok.json" }] },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "ok.json"), "utf-8")), rules);
  assert.equal(notes.length, 0);
});

test("applyDnr notes a ruleset that is not valid JSON instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "dnr-test-"));
  writeFileSync(join(dir, "bad.json"), "{ not json");
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "bad", path: "bad.json" }] },
  });
  assert.ok(notes.some((n) => n.includes('"bad"') && n.includes("not valid JSON")));
});

test("applyDnr notes a ruleset whose JSON is not an array of rules", () => {
  const dir = stageWith({ "obj.json": { rules: [] } }); // object, not array
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "obj", path: "obj.json" }] },
  });
  assert.ok(notes.some((n) => n.includes('"obj"') && n.includes("not a JSON array")));
});

test("applyDnr warns about regexFilter rules Safari may silently drop", () => {
  const rules = [{ id: 1, action: { type: "block" }, condition: { regexFilter: "ad.*\\.js" } }];
  const dir = stageWith({ "rx.json": rules });
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "rx", path: "rx.json" }] },
  });
  assert.ok(notes.some((n) => /1 regexFilter rule/.test(n)));
});

test("applyDnr warns when enabled static rules exceed Safari's cap", () => {
  const rules = Array.from({ length: 30001 }, (_, i) => ({
    id: i + 1,
    action: { type: "block" },
    condition: { urlFilter: `x${i}` },
  }));
  const dir = stageWith({ "big.json": rules });
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "big", enabled: true, path: "big.json" }] },
  });
  assert.ok(notes.some((n) => /exceed the ~30000 Safari honors/.test(n)));
});

test("applyDnr does not count a disabled ruleset toward the cap", () => {
  const rules = Array.from({ length: 30001 }, (_, i) => ({
    id: i + 1,
    action: { type: "block" },
    condition: { urlFilter: `x${i}` },
  }));
  const dir = stageWith({ "big.json": rules });
  const notes = applyDnr(dir, {
    declarative_net_request: { rule_resources: [{ id: "big", enabled: false, path: "big.json" }] },
  });
  assert.ok(!notes.some((n) => /exceed the/.test(n)));
});
