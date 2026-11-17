/**
 * builtlore diff: what changed in how the app behaves between two versions.
 *
 * Both sides are scanned by the same builtlore version (a git ref is checked out in a
 * temporary worktree), so the differences come from the code, not from the tool.
 * The report speaks in steps, statuses, roles and rules, not in files and lines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanProject } from "./scan.js";
import type { BuiltMap, ExtractOptions, Process } from "./types.js";

export interface DiffItem {
  change: "added" | "removed" | "changed";
  text: string;
}

export interface DiffSection {
  id: string;
  title: string;
  items: DiffItem[];
}

// ---------------------------------------------------------------------------
// Loading a side: a builtlore.json file, a git ref, or the working folder
// ---------------------------------------------------------------------------

export interface DiffSide {
  label: string;
  map: BuiltMap;
}

/**
 * spec: a path to a JSON map, a git ref (scanned in a temporary worktree), or
 * undefined for the project folder as it is now. Nothing in the project is written.
 */
export async function loadSide(projectArg: string, spec: string | undefined, mode: ExtractOptions["mode"] = "static"): Promise<DiffSide> {
  const project = resolve(projectArg);
  if (!spec) return { label: "working folder", map: (await scanProject(project, { mode }, { write: false })).map };
  if (/\.json$/i.test(spec) && existsSync(resolve(spec))) {
    return { label: spec, map: JSON.parse(readFileSync(resolve(spec), "utf8")) as BuiltMap };
  }
  // Where the project sits inside the repository ("" at the top, "apps/web/" in a monorepo)
  const prefix = git(project, ["rev-parse", "--show-prefix"]);
  if (prefix === null) throw new Error(`${spec} is not a JSON file, and ${project} is not in a git repository.`);
  const commit = git(project, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
  if (commit === null) throw new Error(`Not a JSON file or a git ref: ${spec}`);
  const tmp = mkdtempSync(join(tmpdir(), "builtlore-diff-"));
  const tree = join(tmp, "tree");
  try {
    if (git(project, ["worktree", "add", "--detach", "--quiet", tree, commit]) === null) throw new Error(`Could not check out ${spec} in a temporary worktree.`);
    const sub = join(tree, prefix);
    const map = (await scanProject(sub, { mode }, { write: false })).map;
    return { label: `${spec} (${commit.slice(0, 7)})`, map };
  } finally {
    git(project, ["worktree", "remove", "--force", tree]);
    rmSync(tmp, { recursive: true, force: true });
    git(project, ["worktree", "prune"]);
  }
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

export function diffMaps(base: BuiltMap, head: BuiltMap): DiffSection[] {
  const sections: DiffSection[] = [
    { id: "steps", title: "Steps", items: stepItems(base, head) },
    { id: "who", title: "Who can do it", items: whoItems(base, head) },
    { id: "status", title: "Status flow", items: statusItems(base, head) },
    { id: "rules", title: "Business rules (validation)", items: ruleItems(base, head) },
    { id: "integrations", title: "Integrations", items: integrationItems(base, head) },
    { id: "data", title: "Data", items: dataItems(base, head) },
    { id: "automation", title: "Automation", items: automationItems(base, head) },
    { id: "config", title: "Configuration", items: configItems(base, head) },
  ];
  return sections.filter((s) => s.items.length);
}

const added = (text: string): DiffItem => ({ change: "added", text });
const removed = (text: string): DiffItem => ({ change: "removed", text });
const changed = (text: string): DiffItem => ({ change: "changed", text });

function byKey<T>(list: T[] | undefined, key: (x: T) => string): Map<string, T> {
  return new Map((list ?? []).map((x) => [key(x), x]));
}

function listText(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function stepName(map: BuiltMap, id: string): string {
  if (id.startsWith("command:")) return `command ${id.slice(8)}`;
  if (id.startsWith("job:")) return `job ${id.slice(4).split("\\").pop()}`;
  const n = map.nodes.find((x) => x.id === id);
  return n ? `"${n.label}"` : id;
}

function endpoint(n: { methods: string[]; uri: string }): string {
  return `${n.methods.filter((m) => m !== "HEAD").join("|")} /${n.uri.replace(/^\//, "")}`;
}

function stepItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const b = byKey(base.nodes, (n) => n.id);
  const h = byKey(head.nodes, (n) => n.id);
  for (const [id, n] of h) if (!b.has(id)) out.push(added(`New step "${n.label}" (${endpoint(n)})`));
  for (const [id, n] of b) if (!h.has(id)) out.push(removed(`Step "${n.label}" is gone (${endpoint(n)})`));
  for (const [id, n] of h) {
    const o = b.get(id);
    if (o && endpoint(o) !== endpoint(n)) out.push(changed(`"${n.label}" moved: ${endpoint(o)} → ${endpoint(n)}`));
  }
  return out;
}

function whoItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const b = byKey(base.nodes, (n) => n.id);
  for (const n of head.nodes) {
    const o = b.get(n.id);
    if (!o) continue;
    const was = o.who?.name;
    const now = n.who?.name;
    if (was === now) continue;
    if (!was) out.push(changed(`"${n.label}": now limited to ${now}`));
    else if (!now) out.push(changed(`"${n.label}": no longer limited to ${was}`));
    else out.push(changed(`"${n.label}": ${was} → ${now}`));
  }
  return out;
}

function statusItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const b = byKey(base.processes, (p) => p.subject);
  const h = byKey(head.processes, (p) => p.subject);
  for (const [subject, p] of h) if (!b.has(subject)) out.push(added(`New status flow "${p.name}" (${subject}, ${p.states.length} statuses)`));
  for (const [subject, p] of b) if (!h.has(subject)) out.push(removed(`Status flow "${p.name}" (${subject}) is gone`));
  for (const [subject, p] of h) {
    const o = b.get(subject);
    if (!o) continue;
    const label = (proc: Process, id: string) => `"${proc.states.find((s) => s.id === id)?.label ?? id.split("=").pop()}"`;
    const ob = new Set(o.states.map((s) => s.value));
    const hb = new Set(p.states.map((s) => s.value));
    for (const s of p.states) if (!ob.has(s.value)) out.push(added(`${p.name}: new status ${`"${s.label}"`}`));
    for (const s of o.states) if (!hb.has(s.value)) out.push(removed(`${p.name}: status "${s.label}" is no longer set anywhere`));
    const steps = new Set([...o.steps.map((s) => s.node), ...p.steps.map((s) => s.node)]);
    for (const node of steps) {
      const was = o.steps.find((s) => s.node === node);
      const now = p.steps.find((s) => s.node === node);
      const name = stepName(now ? head : base, node);
      if (!was && now) {
        if (now.to.length) out.push(added(`${p.name}: ${name} now sets ${listText(now.to.map((t) => label(p, t)))}`));
        continue;
      }
      if (was && !now) {
        if (head.nodes.some((n) => n.id === node)) out.push(removed(`${p.name}: ${name} no longer changes the status`));
        continue;
      }
      if (!was || !now) continue;
      const value = (id: string) => id.split("=").slice(1).join("=");
      const toWas = new Set(was.to.map(value));
      const toNow = new Set(now.to.map(value));
      const gainedTo = now.to.filter((t) => !toWas.has(value(t)));
      const lostTo = was.to.filter((t) => !toNow.has(value(t)));
      if (gainedTo.length) out.push(changed(`${p.name}: ${name} can now end at ${listText(gainedTo.map((t) => label(p, t)))}`));
      if (lostTo.length) out.push(changed(`${p.name}: ${name} no longer ends at ${listText(lostTo.map((t) => label(o, t)))}`));
      const fromOf = (s: typeof was) => [...new Set([...s.from, ...(s.pathInfo ?? []).flatMap((i) => i.from ?? [])])];
      const fWas = fromOf(was);
      const fNow = fromOf(now);
      const fw = new Set(fWas.map(value));
      const fn = new Set(fNow.map(value));
      if (fWas.length && !fNow.length) out.push(changed(`${p.name}: ${name} no longer checks the status first (was: only from ${listText(fWas.map((f) => label(o, f)))})`));
      else if (!fWas.length && fNow.length) out.push(changed(`${p.name}: ${name} now runs only from ${listText(fNow.map((f) => label(p, f)))}`));
      else {
        const gained = fNow.filter((f) => !fw.has(value(f)));
        const lost = fWas.filter((f) => !fn.has(value(f)));
        if (gained.length) out.push(changed(`${p.name}: ${name} now also runs from ${listText(gained.map((f) => label(p, f)))}`));
        if (lost.length) out.push(changed(`${p.name}: ${name} no longer runs from ${listText(lost.map((f) => label(o, f)))}`));
      }
      if (Boolean(was.creates) !== Boolean(now.creates)) out.push(changed(`${p.name}: ${name} ${now.creates ? "now creates" : "no longer creates"} the record`));
    }
  }
  return out;
}

function rulesOf(map: BuiltMap, id: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of map.nodes.find((n) => n.id === id)?.validation ?? []) {
    for (const f of v.fields) out.set(f.field, f.rules.map((r) => r.text ?? r.rule).join(", "));
  }
  return out;
}

function ruleItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const b = new Set(base.nodes.map((n) => n.id));
  for (const n of head.nodes) {
    if (!b.has(n.id)) continue;
    const was = rulesOf(base, n.id);
    const now = rulesOf(head, n.id);
    for (const [field, rules] of now) {
      const old = was.get(field);
      if (old === undefined) out.push(added(`"${n.label}": new field ${field}: ${rules || "no rules"}`));
      else if (old !== rules) out.push(changed(`"${n.label}": ${field}: ${old || "no rules"} → ${rules || "no rules"}`));
    }
    for (const field of was.keys()) if (!now.has(field)) out.push(removed(`"${n.label}": field ${field} is no longer checked`));
  }
  return out;
}

function integrationItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const kind = { http: "HTTP API", mail: "Mail", notification: "Notification", storage: "Storage" } as const;
  const b = byKey(base.integrations, (i) => i.id);
  const h = byKey(head.integrations, (i) => i.id);
  const users = (i: NonNullable<BuiltMap["integrations"]>[number]) => [...new Set(i.usages.flatMap((u) => u.by))];
  for (const [id, i] of h) {
    const o = b.get(id);
    const now = users(i);
    if (!o) {
      out.push(added(`New ${kind[i.kind].toLowerCase()} ${i.name}${now.length ? ` (by ${listText(now.map((x) => stepName(head, x)))})` : ""}`));
      continue;
    }
    const was = users(o);
    const gained = now.filter((x) => !was.includes(x));
    const lost = was.filter((x) => !now.includes(x));
    if (gained.length) out.push(changed(`${kind[i.kind]} ${i.name}: now also used by ${listText(gained.map((x) => stepName(head, x)))}`));
    if (lost.length) out.push(changed(`${kind[i.kind]} ${i.name}: no longer used by ${listText(lost.map((x) => stepName(base, x)))}`));
  }
  for (const [id, i] of b) if (!h.has(id)) out.push(removed(`${kind[i.kind]} ${i.name} is no longer used`));
  return out;
}

function dataItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const b = byKey(base.data?.tables, (t) => t.name);
  const h = byKey(head.data?.tables, (t) => t.name);
  for (const [name, t] of h) {
    const o = b.get(name);
    if (!o) {
      out.push(added(`New table ${name} (${t.columns.length} columns)`));
      continue;
    }
    const oc = byKey(o.columns, (c) => c.name);
    const hc = byKey(t.columns, (c) => c.name);
    for (const [c, col] of hc) {
      const was = oc.get(c);
      if (!was) out.push(added(`${name}: new column ${c} (${col.type}${col.nullable ? ", optional" : ""})`));
      else {
        const desc = (x: typeof col) => `${x.type}${x.size ? `(${x.size})` : ""}${x.nullable ? ", optional" : ""}${x.default !== undefined ? `, default ${x.default}` : ""}`;
        if (desc(was) !== desc(col)) out.push(changed(`${name}.${c}: ${desc(was)} → ${desc(col)}`));
      }
    }
    for (const c of oc.keys()) if (!hc.has(c)) out.push(removed(`${name}: column ${c} is dropped`));
  }
  for (const name of b.keys()) if (!h.has(name)) out.push(removed(`Table ${name} is dropped`));
  return out;
}

function automationItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const when = (t: { whenText?: string; when: string }) => t.whenText ?? t.when;
  const bs = byKey(base.automation?.schedule, (t) => `${t.runs.kind}:${t.runs.name}`);
  const hs = byKey(head.automation?.schedule, (t) => `${t.runs.kind}:${t.runs.name}`);
  for (const [k, t] of hs) {
    const o = bs.get(k);
    if (!o) out.push(added(`Scheduled: ${t.runs.name}, ${when(t)}`));
    else if (when(o) !== when(t)) out.push(changed(`Schedule of ${t.runs.name}: ${when(o)} → ${when(t)}`));
  }
  for (const [k, t] of bs) if (!hs.has(k)) out.push(removed(`No longer scheduled: ${t.runs.name}`));
  const bc = byKey(base.automation?.commands, (c) => c.name);
  const hc = byKey(head.automation?.commands, (c) => c.name);
  for (const [n] of hc) if (!bc.has(n)) out.push(added(`New command ${n}`));
  for (const [n] of bc) if (!hc.has(n)) out.push(removed(`Command ${n} is gone`));
  const bj = byKey(base.automation?.jobs, (j) => j.class);
  const hj = byKey(head.automation?.jobs, (j) => j.class);
  for (const [c] of hj) if (!bj.has(c)) out.push(added(`New job ${c.split("\\").pop()}`));
  for (const [c] of bj) if (!hj.has(c)) out.push(removed(`Job ${c.split("\\").pop()} is gone`));
  return out;
}

function configItems(base: BuiltMap, head: BuiltMap): DiffItem[] {
  const out: DiffItem[] = [];
  const own = (m: BuiltMap) => byKey((m.config ?? []).filter((c) => !c.framework), (c) => c.key);
  const b = own(base);
  const h = own(head);
  for (const [k, c] of h) if (!b.has(k)) out.push(added(`New environment key ${k}${c.inExample ? "" : " (not in .env.example yet)"}`));
  for (const k of b.keys()) if (!h.has(k)) out.push(removed(`Environment key ${k} is no longer read`));
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const MARK = { added: "+", removed: "-", changed: "~" } as const;

export function diffText(sections: DiffSection[], base: string, head: string): string {
  if (!sections.length) return `No behaviour changes between ${base} and ${head}.`;
  const lines = [`What changed: ${base} → ${head}`];
  for (const s of sections) {
    lines.push("", `${s.title} (${s.items.length})`);
    for (const i of s.items) lines.push(`  ${MARK[i.change]} ${i.text}`);
  }
  return lines.join("\n");
}

export function diffMarkdown(sections: DiffSection[], base: string, head: string): string {
  const lines = ["## What changed in the app", "", `Compared by builtlore: \`${base}\` → \`${head}\`.`, ""];
  if (!sections.length) return [...lines, "No behaviour changes: same steps, statuses, roles, rules, integrations, data, automation and configuration.", ""].join("\n");
  const word = { added: "Added", removed: "Removed", changed: "Changed" } as const;
  for (const s of sections) {
    lines.push(`### ${s.title}`, "");
    for (const i of s.items) lines.push(`- **${word[i.change]}:** ${i.text}`);
    lines.push("");
  }
  return lines.join("\n");
}
