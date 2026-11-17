/**
 * builtlore check: for CI. Compares a base (the committed builtlore.json, a git ref, or a
 * saved map) with the code as it is now, and fails when
 *   - changes:     the behaviour differs (the committed map is out of date, or a PR changed it)
 *   - open:        a new write anyone can call (no login, key or permission check)
 *   - page-only:   a new action whose permission is checked only by the page that calls it
 *   - unvalidated: a new write that reads request fields without validation
 * Findings that were already there in the base do not fail the check.
 */
import { buildDocModel } from "../docs/model.js";
import { diffMaps, diffMarkdown, diffText, type DiffSection } from "./diff.js";
import type { BuiltMap } from "./types.js";

export type CheckRule = "changes" | "open" | "page-only" | "unvalidated";
export const CHECK_RULES: CheckRule[] = ["changes", "open", "page-only", "unvalidated"];

const FINDING: Record<Exclude<CheckRule, "changes">, string> = {
  open: "Open to anyone",
  "page-only": "Permission checked only in the page",
  unvalidated: "Writes without validation",
};

export interface CheckResult {
  sections: DiffSection[];
  /** New findings per rule (not in the base). */
  added: Array<{ rule: CheckRule; title: string; items: string[] }>;
  failed: CheckRule[];
}

export function runCheck(base: BuiltMap, head: BuiltMap, failOn: CheckRule[]): CheckResult {
  const sections = diffMaps(base, head);
  const findingsOf = (m: BuiltMap) => new Map(buildDocModel(m).findings.map((f) => [f.title, new Set(f.items.map((i) => i.text))]));
  const before = findingsOf(base);
  const after = findingsOf(head);
  const added: CheckResult["added"] = [];
  for (const rule of Object.keys(FINDING) as Array<keyof typeof FINDING>) {
    const title = FINDING[rule];
    const was = before.get(title) ?? new Set<string>();
    const items = [...(after.get(title) ?? [])].filter((t) => !was.has(t));
    if (items.length) added.push({ rule, title, items });
  }
  const failed: CheckRule[] = [];
  if (failOn.includes("changes") && sections.length) failed.push("changes");
  for (const a of added) if (failOn.includes(a.rule)) failed.push(a.rule);
  return { sections, added, failed };
}

export function checkText(r: CheckResult, base: string, head: string): string {
  const lines = [diffText(r.sections, base, head)];
  for (const a of r.added) {
    lines.push("", `New: ${a.title} (${a.items.length})`);
    for (const i of a.items) lines.push(`  ! ${i}`);
  }
  lines.push("", r.failed.length ? `✖ Check failed: ${r.failed.join(", ")}` : "✔ Check passed");
  return lines.join("\n");
}

export function checkMarkdown(r: CheckResult, base: string, head: string): string {
  const parts = [diffMarkdown(r.sections, base, head)];
  for (const a of r.added) {
    parts.push(`### New: ${a.title}`, "", ...a.items.map((i) => `- ${i}`), "");
  }
  parts.push(r.failed.length ? `**Check failed:** ${r.failed.join(", ")}` : "**Check passed.**", "");
  return parts.join("\n");
}
