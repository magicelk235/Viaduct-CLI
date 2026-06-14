import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Issue, Severity } from "./types.js";
import { color } from "./util.js";

const ORDER: Severity[] = ["error", "warning", "info"];
const LABEL: Record<Severity, string> = { error: "ERROR", warning: "WARN", info: "INFO" };
const HUE: Record<Severity, "red" | "yellow" | "blue"> = { error: "red", warning: "yellow", info: "blue" };

export function printIssues(issues: Issue[]): void {
  if (issues.length === 0) {
    console.log(color("green", "No compatibility issues found."));
    return;
  }
  const bySeverity: Record<Severity, Issue[]> = { error: [], warning: [], info: [] };
  let autoFixed = 0;
  for (const i of issues) {
    bySeverity[i.severity].push(i);
    if (i.autoFixed) autoFixed++;
  }
  for (const sev of ORDER) {
    const group = bySeverity[sev];
    if (group.length === 0) continue;
    console.log(`\n${color(HUE[sev], `${LABEL[sev]} (${group.length})`)}`);
    for (const i of group) {
      const loc = i.file ? color("dim", ` ${i.file}${i.line ? `:${i.line}` : ""}`) : "";
      const fixed = i.autoFixed ? color("green", " [auto-fixed]") : "";
      console.log(`  • [${i.category}]${loc}${fixed}`);
      console.log(`    ${i.message}`);
      if (i.fix && !i.autoFixed) console.log(color("dim", `    fix: ${i.fix}`));
      else if (i.fix && i.autoFixed) console.log(color("dim", `    ${i.fix}`));
    }
  }
  const parts = ORDER.map((sev) => {
    const n = bySeverity[sev].length;
    if (!n) return null;
    const word = sev === "info" ? "info" : n > 1 ? `${sev}s` : sev;
    return color(HUE[sev], `${n} ${word}`);
  }).filter(Boolean);
  console.log(`\n${parts.join(color("dim", " · "))}${autoFixed ? color("green", ` (${autoFixed} auto-fixed)`) : ""}`);
}

export function countBlocking(issues: Issue[], strict = false): number {
  return issues.filter(
    (i) => !i.autoFixed && (i.severity === "error" || (strict && i.severity === "warning"))
  ).length;
}

const HEADING: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Info" };

/**
 * Write a Markdown summary of the conversion next to the output, so the issue
 * report survives past the terminal scrollback (useful for CI logs / handoff).
 * Returns the path written.
 */
export function writeReportFile(
  dir: string,
  meta: {
    name: string;
    version?: string;
    manifestVersion: number;
    platforms: string;
    removedPermissions?: string[];
  },
  issues: Issue[]
): string {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let autoFixed = 0;
  for (const i of issues) {
    counts[i.severity]++;
    if (i.autoFixed) autoFixed++;
  }

  // Blocking = unresolved errors (auto-fixed ones don't block); same gate the
  // converter and --analyze use, so the verdict here agrees with the exit code.
  const blocking = countBlocking(issues);
  const status = blocking === 0 ? "✅ Convertible — no blocking issues" : `⛔ ${blocking} blocking error(s) — use --force to convert anyway`;

  const lines: string[] = [
    `# Conversion report — ${meta.name}`,
    "",
    `- Status: ${status}`,
    `- Version: ${meta.version ?? "(none)"}`,
    `- Manifest: MV${meta.manifestVersion}`,
    `- Platforms: ${meta.platforms}`,
    `- Issues: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info` +
      (autoFixed ? ` — ${autoFixed} auto-fixed` : ""),
    "",
  ];

  if (meta.removedPermissions && meta.removedPermissions.length > 0) {
    lines.push(`## Removed permissions (${meta.removedPermissions.length})`, "");
    for (const p of meta.removedPermissions) lines.push(`- \`${p}\``);
    lines.push("");
  }

  for (const sev of ORDER) {
    const group = issues.filter((i) => i.severity === sev);
    if (group.length === 0) continue;
    lines.push(`## ${HEADING[sev]} (${group.length})`, "");
    for (const i of group) {
      const loc = i.file ? ` \`${i.file}${i.line ? `:${i.line}` : ""}\`` : "";
      const tag = i.autoFixed ? " _(auto-fixed)_" : "";
      lines.push(`- **[${i.category}]**${loc}${tag} — ${i.message}`);
      if (i.fix) lines.push(`  - ${i.autoFixed ? "" : "fix: "}${i.fix}`);
    }
    lines.push("");
  }

  const p = join(dir, "CONVERSION_REPORT.md");
  writeFileSync(p, lines.join("\n"), "utf-8");
  return p;
}
