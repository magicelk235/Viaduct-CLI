import { test } from "node:test";
import assert from "node:assert/strict";
import { countBlocking } from "../dist/report.js";

const err = { severity: "error", category: "x", message: "e" };
const warn = { severity: "warning", category: "x", message: "w" };
const info = { severity: "info", category: "x", message: "i" };
const autoFixedErr = { severity: "error", category: "x", message: "e", autoFixed: true };

test("countBlocking counts unfixed errors only by default", () => {
  assert.equal(countBlocking([err, warn, info]), 1);
});

test("countBlocking excludes auto-fixed errors", () => {
  assert.equal(countBlocking([err, autoFixedErr]), 1);
});

test("countBlocking treats warnings as blocking in strict mode", () => {
  assert.equal(countBlocking([err, warn, info], true), 2);
});

test("countBlocking never counts info, even in strict mode", () => {
  assert.equal(countBlocking([info, info], true), 0);
});

test("countBlocking returns 0 for an empty list", () => {
  assert.equal(countBlocking([]), 0);
});
