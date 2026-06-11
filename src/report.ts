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

export function countBlocking(issues: Issue[]): number {
  return issues.filter((i) => i.severity === "error" && !i.autoFixed).length;
}
