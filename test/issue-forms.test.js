import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Viaduct.app opens these forms with fields prefilled from the URL
// (Sources/Features/IssueReports/IssueReport.swift), so their ids are a contract.
const ids = (form) => {
  const yaml = readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${form}`, import.meta.url), "utf8");
  return [...yaml.matchAll(/^\s+id:\s*(\S+)/gm)].map((m) => m[1]);
};

test("forms keep the field ids Viaduct.app prefills", () => {
  assert.deepEqual(ids("conversion-failure.yml").filter((i) => ["extension", "error", "os"].includes(i)).sort(), ["error", "extension", "os"]);
  for (const i of ["extension", "expected", "actual", "steps", "safari-version"]) assert.ok(ids("converted-but-broken.yml").includes(i), i);
});

test("both bug forms ask which browser", () => {
  for (const f of ["conversion-failure.yml", "converted-but-broken.yml"]) assert.ok(ids(f).includes("browser"), f);
});
