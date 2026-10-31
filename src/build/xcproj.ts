import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Xcode 27's safari-web-extension-packager writes `project.xcproj`, a JSON document
 * with trailing commas, in place of the `project.pbxproj` plist every earlier Xcode
 * emitted. Each target carries a `"build-settings": { ... }` object whose values are
 * strings or string arrays, so the settings a conversion needs to change can be edited
 * as text, line by line, which keeps Xcode's own formatting and the trailing commas
 * JSON.parse would choke on. Every patcher in packager.ts and appicon.ts reads the
 * project through here and handles whichever file it finds.
 */

export type ProjectFile = { path: string; format: "pbxproj" | "xcproj"; content: string };

export function readProjectFile(xcodeproj: string): ProjectFile | null {
  const pbxproj = join(xcodeproj, "project.pbxproj");
  if (existsSync(pbxproj)) return { path: pbxproj, format: "pbxproj", content: readFileSync(pbxproj, "utf-8") };
  const xcproj = join(xcodeproj, "project.xcproj");
  if (existsSync(xcproj)) return { path: xcproj, format: "xcproj", content: readFileSync(xcproj, "utf-8") };
  return null;
}

export function writeProjectFile(file: ProjectFile, content: string): void {
  if (content !== file.content) writeFileSync(file.path, content, "utf-8");
}

/** One target's settings block: the text between the braces, and where it sits. */
export type SettingsBlock = { start: number; end: number; body: string };

// A build-settings object holds strings and string arrays only, never a nested
// object, so the first `}` after the opener closes it.
const BLOCK_RE = /"build-settings": \{/g;

export function settingsBlocks(content: string): SettingsBlock[] {
  const blocks: SettingsBlock[] = [];
  for (const m of content.matchAll(BLOCK_RE)) {
    const start = m.index! + m[0].length;
    const end = content.indexOf("}", start);
    if (end < 0) break;
    blocks.push({ start, end, body: content.slice(start, end) });
  }
  return blocks;
}

/** Value of a string setting in one block, or null. */
export function getSetting(body: string, key: string): string | null {
  const m = new RegExp(`"${key}": "((?:[^"\\\\]|\\\\.)*)"`).exec(body);
  return m ? m[1] : null;
}

/** Set a string setting in one block: replaces it in place or inserts it after `after`
 *  (or at the top of the block when that key is absent). Returns the new body. */
export function setSetting(body: string, key: string, value: string, after?: string): string {
  const re = new RegExp(`("${key}": )"(?:[^"\\\\]|\\\\.)*"`);
  if (re.test(body)) return body.replace(re, `$1"${value}"`);
  const indent = /\n([ \t]*)"/.exec(body)?.[1] ?? "        ";
  const line = `\n${indent}"${key}": "${value}",`;
  if (after) {
    const anchor = new RegExp(`\n[ \\t]*"${after}": (?:"(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]),`);
    const m = anchor.exec(body);
    if (m) return body.slice(0, m.index + m[0].length) + line + body.slice(m.index + m[0].length);
  }
  return line + body;
}

/** Rewrite every target's settings through `edit`, which gets the block body and
 *  returns the replacement; blocks are patched back to front so offsets stay valid. */
export function editSettingsBlocks(content: string, edit: (body: string) => string): string {
  const blocks = settingsBlocks(content);
  let out = content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const next = edit(b.body);
    if (next !== b.body) out = out.slice(0, b.start) + next + out.slice(b.end);
  }
  return out;
}

/** True for the appex target's settings, which the packager names `<app id>.Extension`. */
export function isExtensionBlock(body: string): boolean {
  return (getSetting(body, "PRODUCT_BUNDLE_IDENTIFIER") ?? "").endsWith(".Extension");
}
