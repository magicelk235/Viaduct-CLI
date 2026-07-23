import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { idempotentContentScriptGlobals } from "../dist/input/stage.js";

// Safari re-evaluates a document_end / all_frames content-script group a second time
// into a world that already holds it (about:blank/srcdoc subframes, some navigations).
// A file's top-level `const`/`let` then throws "Can't create duplicate variable" on the
// second eval and aborts the group — the extension dies (TWP: twpI18n / startMark). The
// transform demotes only column-0 const/let to var, whose redeclaration is a harmless
// no-op, exactly as Viaduct's own shim survives re-eval. Globals stay global (they must:
// TWP's files share twpI18n / startMark across the group), so behaviour is unchanged on
// the single-eval path.

function stage(files) {
  const dir = mkdtempSync(join(tmpdir(), "viaduct-cs-idem-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const read = (dir, f) => readFileSync(join(dir, f), "utf-8");

test("demotes top-level const/let to var in isolated-world content scripts", () => {
  const dir = stage({
    "lib/i18n.js": 'const twpI18n = (function () { return {}; })();\n',
    "cs/pageTranslator.js": 'const startMark = "@%";\nlet currentIndex;\nconst pageTranslator = {};\n',
    "cs/helper.js": "// no top-level lexical decls here\nwindow.x = 1;\n",
  });
  const manifest = {
    manifest_version: 2,
    content_scripts: [
      {
        matches: ["<all_urls>"],
        run_at: "document_end",
        all_frames: true,
        match_about_blank: true,
        js: ["lib/i18n.js", "cs/pageTranslator.js", "cs/helper.js"],
      },
    ],
  };
  try {
    const n = idempotentContentScriptGlobals(dir, manifest);
    assert.equal(n, 2); // i18n.js + pageTranslator.js changed, helper.js untouched
    assert.match(read(dir, "lib/i18n.js"), /^var twpI18n = /);
    assert.match(read(dir, "cs/pageTranslator.js"), /^var startMark = /m);
    assert.match(read(dir, "cs/pageTranslator.js"), /^var currentIndex;/m);
    assert.match(read(dir, "cs/pageTranslator.js"), /^var pageTranslator = /m);
    // untouched
    assert.equal(read(dir, "cs/helper.js").includes("window.x = 1;"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves indented (block-scoped) const/let alone", () => {
  const dir = stage({
    "cs.js":
      'const top = 1;\n' +
      'function f() {\n' +
      '  const inner = 2;\n' +
      '  let loop = 3;\n' +
      '  return inner + loop;\n' +
      '}\n',
  });
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }],
  };
  try {
    idempotentContentScriptGlobals(dir, manifest);
    const out = read(dir, "cs.js");
    assert.match(out, /^var top = 1;/m); // top-level demoted
    assert.match(out, /^ {2}const inner = 2;/m); // indented const preserved
    assert.match(out, /^ {2}let loop = 3;/m); // indented let preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips world:MAIN content scripts (page world, not re-injected the same way)", () => {
  const dir = stage({ "main.js": "const x = 1;\n" });
  const manifest = {
    manifest_version: 3,
    content_scripts: [{ matches: ["https://*/*"], js: ["main.js"], world: "MAIN" }],
  };
  try {
    const n = idempotentContentScriptGlobals(dir, manifest);
    assert.equal(n, 0);
    assert.match(read(dir, "main.js"), /^const x = 1;/); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only touches files referenced by content_scripts, not background/popup", () => {
  const dir = stage({
    "cs.js": "const inContent = 1;\n",
    "background.js": "const inBackground = 1;\n",
  });
  const manifest = {
    manifest_version: 2,
    content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }],
    background: { scripts: ["background.js"] },
  };
  try {
    idempotentContentScriptGlobals(dir, manifest);
    assert.match(read(dir, "cs.js"), /^var inContent = 1;/);
    assert.match(read(dir, "background.js"), /^const inBackground = 1;/); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips a leading slash on the js path (manifest uses /lib/x.js)", () => {
  const dir = stage({ "lib/i18n.js": "const twpI18n = 1;\n" });
  const manifest = {
    manifest_version: 2,
    content_scripts: [{ matches: ["<all_urls>"], js: ["/lib/i18n.js"] }],
  };
  try {
    const n = idempotentContentScriptGlobals(dir, manifest);
    assert.equal(n, 1);
    assert.match(read(dir, "lib/i18n.js"), /^var twpI18n = 1;/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
