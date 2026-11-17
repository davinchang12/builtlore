/**
 * The documentation as a small document tree (pages of headings, paragraphs,
 * tables and diagrams). Built once, then rendered to Markdown and to HTML, so
 * both outputs always say the same thing.
 *
 * Written for someone new to the project first:
 *   - three parts: Understand (plain language), Reference (for developers), Health
 *   - every page opens with one line saying when to read it
 *   - processes are told as numbered steps; tables and code details are folded away
 */
import type { DataColumn, DataTable, Integration, MapNode, ProcessState, SourceRef, Validation } from "../core/types.js";
import { mermaid, stateGraph, type StateGraph } from "./diagram.js";
import { byLabel, endpoint, finalStates, NEGATIVE, processEdges, short, type DocFeature, type DocModel, type DocProcess, type DocTransition } from "./model.js";

export type Inline =
  | string
  | { code: string }
  | { b: string }
  | { i: string }
  | { link: string; to: string } // to = anchor id
  | { src: SourceRef }
  | { badge: string; kind: "code" | "human" | "missing" | "warn" | "role" | "neg" };

export type Block =
  | { t: "h"; level: 1 | 2 | 3 | 4; text: string; id?: string }
  | { t: "p"; c: Inline[] }
  | { t: "note"; kind: "info" | "missing" | "warn"; c: Inline[] }
  | { t: "list"; items: Inline[][] }
  /** Numbered steps. */
  | { t: "steps"; items: Inline[][] }
  | { t: "table"; head: string[]; rows: Inline[][][]; compact?: boolean }
  | { t: "diagram"; graph: StateGraph; title: string; id: string; mermaid: string }
  | { t: "mermaid"; code: string }
  /** The interactive canvas: embedded in the HTML, a link in Markdown. */
  | { t: "canvas"; href: string }
  /** Folded detail: open it when you need it. */
  | { t: "details"; summary: string; blocks: Block[] };

export type Part = "understand" | "reference" | "health";

export const PARTS: Record<Part, { title: string; lead: string }> = {
  understand: { title: "Understand the system", lead: "Start here. Plain language." },
  reference: { title: "Reference", lead: "Details for developers." },
  health: { title: "Health", lead: "What to check or fix." },
};

export interface Page {
  /** Markdown path relative to the docs folder. */
  file: string;
  /** Anchor of the page in the single-file HTML. */
  id: string;
  title: string;
  part: Part;
  /** One line: what this page is for. */
  lead?: string;
  /** Pages of a group (features) share one heading in the HTML. */
  group?: { id: string; title: string; lead: string };
  blocks: Block[];
}

export interface PageOptions {
  /** Where the canvas is, relative to the docs folder (or a URL in builtlore serve). */
  canvasHref?: string;
}

const DASH = "—";

export function buildPages(m: DocModel, opts: PageOptions = {}): Page[] {
  return [
    overview(m, opts),
    roles(m),
    ...m.features.map((f) => featurePage(m, f)),
    glossary(m),
    businessRules(m),
    dataDictionary(m),
    integrations(m),
    automation(m),
    api(m),
    configuration(m),
    findingsPage(m),
  ];
}

export const featureAnchor = (f: DocFeature) => `feature-${f.slug}`;
export const tableAnchor = (name: string) => `table-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
export const roleAnchor = (id: string) => `role-${id}`;
const anchor = (prefix: string, s: string) => `${prefix}-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** "add it in `builtlore serve`" */
const addIn = (): Inline[] => ["add it in ", { code: "builtlore serve" }];

// ---------------------------------------------------------------- overview

function overview(m: DocModel, opts: PageOptions): Page {
  const map = m.map;
  const blocks: Block[] = [];
  if (m.summary) blocks.push({ t: "p", c: [m.summary] });
  else blocks.push({ t: "note", kind: "missing", c: [{ b: "No summary yet" }, " (what the system is for, who uses it): ", ...addIn(), " → Project."] });

  const c = m.counts;
  const counts = ([["feature", c.features], ["page", c.pages], ["action", c.actions], ["process", c.processes], ["table", c.tables], ["scheduled task", c.tasks], ["integration", c.integrations]] as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .map(([w, n]) => `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`);
  blocks.push({ t: "p", c: [{ i: counts.join(" · ") }] });

  // Main processes, one line each: the usual path from the first status to the last
  // One line per feature: its main process (the one with the most statuses)
  const processes = m.features
    .filter((f) => f.processes.length)
    .map((f) => ({ f, p: [...f.processes].sort((a, b) => b.process.states.length - a.process.states.length)[0] }));
  if (processes.length) {
    blocks.push({ t: "h", level: 2, text: "Main processes", id: "main-processes" });
    blocks.push({
      t: "list",
      items: processes.map(({ f, p }) => {
        const path = happyPath(p).states;
        const line: Inline[] = [{ link: f.feature.name, to: featureAnchor(f) }, ": "];
        path.forEach((s, i) => {
          if (i) line.push(" → ");
          line.push(stateText(s));
        });
        if (!path.length) line.push(DASH);
        return line;
      }),
    });
  }

  // Who uses it: roles in full, named permissions in one line
  const cols = m.roles.columns;
  if (cols.length) {
    blocks.push({ t: "h", level: 2, text: "Who uses it", id: "who-uses-it" });
    const roleCols = cols.filter((c) => !c.permission);
    const permCols = cols.filter((c) => c.permission);
    if (roleCols.length) {
      blocks.push({
        t: "list",
        items: roleCols.map((col) => {
          const actions = [...new Set(m.roles.rows.filter((r) => r.node.who!.id === col.id).map((r) => r.node.label))];
          const more = actions.length > 4 ? ` +${actions.length - 4} more` : "";
          return [{ link: col.name, to: roleAnchor(col.id) }, `: ${actions.slice(0, 4).join(", ")}${more}`];
        }),
      });
    }
    if (permCols.length) {
      const names = permCols.slice(0, 6).map((c) => c.name).join(", ");
      blocks.push({
        t: "p",
        c: [
          { b: `${permCols.length} permission${permCols.length === 1 ? "" : "s"}` },
          ` (named access checks such as ${names}${permCols.length > 6 ? ", …" : ""}). Who holds them is set in the app's data. `,
          { link: "Which actions need which permission", to: "permissions" },
          ".",
        ],
      });
    }
  }

  blocks.push({ t: "h", level: 2, text: "Modules", id: "modules" });
  blocks.push({
    t: "table",
    head: ["Feature", "Purpose", "Process"],
    rows: m.features.map((f) => [
      [{ link: f.feature.name, to: featureAnchor(f) }],
      [f.feature.description ?? DASH],
      [f.processes.length ? "yes" : DASH],
    ]),
  });

  blocks.push({ t: "h", level: 2, text: "Where to read next", id: "read-next" });
  blocks.push({
    t: "list",
    items: [
      [{ b: "New to the project" }, ": ", { link: "Who uses it", to: "roles" }, " → ", { link: "Features", to: "features" }, " → ", { link: "Glossary", to: "glossary" }, "."],
      [{ b: "Changing the code" }, ": ", { link: "Business rules", to: "business-rules" }, ", ", { link: "Data", to: "data" }, ", ", { link: "API", to: "api" }, "."],
      [{ b: "Running it" }, ": ", { link: "Configuration", to: "configuration" }, ", ", { link: "Automation", to: "automation" }, ", ", { link: "Integrations", to: "integrations" }, "."],
      [{ b: "Checking health" }, ": ", { link: "Findings", to: "findings" }, "."],
    ],
  });

  if (opts.canvasHref) {
    blocks.push({ t: "h", level: 2, text: "Canvas", id: "canvas" });
    blocks.push({ t: "canvas", href: opts.canvasHref });
  }

  const meta = [`Generated ${map.generatedAt.slice(0, 10)}`, map.project.commit ? `commit ${map.project.commit}` : "", map.generator].filter(Boolean).join(" · ");
  blocks.push({
    t: "details",
    summary: "How this documentation is made",
    blocks: [
      {
        t: "list",
        items: [
          ["Read from the code by builtlore, with file:line for every fact."],
          [{ badge: "person", kind: "human" }, " written by a person in ", { code: "builtlore.edits.yaml" }, " (", { code: "builtlore serve" }, ")."],
          [{ badge: "check", kind: "warn" }, " code changed after it was described."],
          ["builtlore does not guess: what it could not read is in ", { link: "Findings", to: "findings" }, "."],
          [{ i: meta }],
        ],
      },
    ],
  });
  return { file: "README.md", id: "overview", title: m.title, part: "understand", blocks };
}

// ---------------------------------------------------------------- roles

function roles(m: DocModel): Page {
  const blocks: Block[] = [];
  const cols = m.roles.columns;
  const page = (b: Block[]): Page => ({ file: "roles.md", id: "roles", title: "Who uses it", part: "understand", lead: "Each role and what it can do.", blocks: b });
  if (!m.roles.rows.length) return page([{ t: "note", kind: "info", c: ["No actions found."] }]);

  const actionsOf = (id: string) => {
    const byFeature = new Map<string, string[]>();
    for (const r of m.roles.rows) {
      if (r.node.who!.id !== id) continue;
      byFeature.set(r.feature.name, [...(byFeature.get(r.feature.name) ?? []), r.node.label]);
    }
    return byFeature;
  };
  const permCols = cols.filter((c) => c.permission);
  for (const col of cols.filter((c) => !c.permission)) {
    blocks.push({ t: "h", level: 2, text: col.name, id: roleAnchor(col.id) });
    if (col.id === "signed-in-user") blocks.push({ t: "p", c: [{ i: "Anyone who is logged in (no role check found)." }] });
    else if (col.id === "anyone") blocks.push({ t: "p", c: [{ i: "No login or role check found." }] });
    blocks.push({ t: "list", items: [...actionsOf(col.id)].map(([f, actions]) => [{ b: f }, `: ${actions.join(", ")}`]) });
    if (col.evidence.length && !col.fallback) blocks.push({ t: "p", c: [{ i: `Found in ${col.evidence.slice(0, 2).join("; ")}` }, ...(col.human ? [" ", { badge: "person", kind: "human" } as Inline] : [])] });
  }

  // Named permissions: one table, not one section each
  if (permCols.length) {
    blocks.push({ t: "h", level: 2, text: "Permissions", id: "permissions" });
    blocks.push({ t: "p", c: [{ i: "Named access checks (can:…, @can, Gate::allows). Who holds each one is set in the app's data, not in the code." }] });
    blocks.push({
      t: "table",
      head: ["Permission", "Actions"],
      rows: permCols.map((c) => [
        [{ b: c.name }, ...(c.human ? [" ", { badge: "person", kind: "human" } as Inline] : [])],
        [[...actionsOf(c.id)].map(([f, actions]) => `${f}: ${actions.join(", ")}`).join("; ")],
      ]),
    });
  }

  // The matrix: roles as columns, the permission (if any) as text
  const roleCols = cols.filter((c) => !c.permission);
  const rows: Inline[][][] = [];
  let lastFeature = "";
  for (const r of m.roles.rows) {
    const fname = r.feature.name !== lastFeature ? r.feature.name : "";
    lastFeature = r.feature.name;
    const perm = permCols.find((c) => c.id === r.node.who!.id);
    rows.push([
      [fname ? { b: fname } : ""],
      [r.node.label],
      ...roleCols.map((c): Inline[] => (r.node.who!.id === c.id ? [{ badge: "●", kind: "role" }] : [""])),
      ...(permCols.length ? [perm ? [perm.name] : [""]] : []),
    ]);
  }
  blocks.push({
    t: "details",
    summary: "All actions in one table",
    blocks: [{ t: "table", head: ["Feature", "Action", ...roleCols.map((c) => c.name), ...(permCols.length ? ["Permission"] : [])], rows, compact: true }],
  });
  return page(blocks);
}

// ---------------------------------------------------------------- features

function featurePage(m: DocModel, f: DocFeature): Page {
  const blocks: Block[] = [];
  if (f.feature.description) blocks.push({ t: "p", c: [f.feature.description] });
  else blocks.push({ t: "note", kind: "missing", c: [{ b: "No description yet" }, ": ", ...addIn(), "."] });

  // What you can do here, in plain words
  const pages = f.nodes.filter((n) => n.type === "page");
  const actions = f.nodes.filter((n) => n.who);
  const can: Inline[][] = [];
  if (pages.length) can.push([{ b: "Screens" }, `: ${pages.map((n) => n.label).join(", ")}`]);
  const byWho = new Map<string, string[]>();
  for (const n of actions) byWho.set(n.who!.name, [...(byWho.get(n.who!.name) ?? []), n.label]);
  for (const [who, list] of byWho) can.push([{ b: who }, `: ${list.join(", ")}`]);
  if (can.length) {
    blocks.push({ t: "h", level: 2, text: "What you can do here", id: `${featureAnchor(f)}-can` });
    blocks.push({ t: "list", items: can });
  }

  for (const p of f.processes) blocks.push(...processBlocks(f, p));

  // Developer details, folded
  const dev: Block[] = [];
  dev.push({
    t: "table",
    head: ["Step", "Type", "Route", "Who", "Description"],
    rows: f.nodes.map((n) => [
      [n.label, ...(n.review ? [" ", { badge: "check", kind: "warn" } as Inline] : [])],
      [kindLabel(n)],
      [{ code: endpoint(n) }],
      [n.who ? n.who.name : DASH],
      [n.description ?? DASH],
    ]),
  });
  const flow: Inline[][] = [];
  for (const n of pages) {
    const out = m.map.edges.filter((e) => e.from === n.id && e.to !== n.id && ["link", "submit", "redirect", "ajax"].includes(e.trigger));
    const targets = [...new Set(out.map((e) => e.to))]
      .map((id) => m.map.nodes.find((x) => x.id === id))
      .filter((x): x is MapNode => Boolean(x) && !x!.hidden);
    if (targets.length) flow.push([{ b: n.label }, " → ", targets.map((t) => (t.feature === n.feature ? t.label : byLabel(m, t.id))).join(", ")]);
  }
  if (flow.length) dev.push({ t: "p", c: [{ b: "Where each screen leads" }] }, { t: "list", items: flow });
  if (f.feature.files.length) dev.push({ t: "p", c: [{ b: "Files" }] }, { t: "list", items: f.feature.files.map((x) => [{ src: { file: x } }]) });
  blocks.push({ t: "details", summary: "For developers: routes, screens, files", blocks: dev });

  return {
    file: `features/${f.slug}.md`,
    id: featureAnchor(f),
    title: f.feature.name,
    part: "understand",
    group: { id: "features", title: "Features", lead: "What each part of the app does, and how a record moves through it." },
    blocks,
  };
}

function stateText(s: ProcessState): Inline {
  return s.named === "raw" ? { code: s.label } : { b: s.label };
}

function states(list: ProcessState[]): Inline[] {
  const out: Inline[] = [];
  list.forEach((s, i) => {
    if (i) out.push(" or ");
    out.push(stateText(s));
  });
  return out;
}

/** Steps in reading order: creation first, then by how far their starting status is from the start. */
function storyOrder(p: DocProcess): DocTransition[] {
  const edges = processEdges(p);
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const seed = (id: string) => {
    if (!dist.has(id)) {
      dist.set(id, 0);
      queue.push(id);
    }
  };
  const starts = edges.filter((e) => e.from === "start");
  for (const e of starts.filter((x) => !x.transition?.node.uri.includes("{"))) seed(e.to.id);
  if (!dist.size) for (const e of starts) seed(e.to.id);
  if (p.initial && !dist.size) seed(p.initial.id);
  while (queue.length) {
    const s = queue.shift()!;
    for (const e of edges) {
      if (typeof e.from === "string" || e.from.id !== s || dist.has(e.to.id)) continue;
      dist.set(e.to.id, dist.get(s)! + 1);
      queue.push(e.to.id);
    }
  }
  // A new record comes from a form with no record in its URL (POST /orders), not from /orders/{order}/...
  const fromOf = (t: DocTransition) => (t.from.length ? t.from : t.pathFrom.flat());
  const rank = (t: DocTransition) => (t.step.creates ? (t.node.uri.includes("{") ? -1 : -2) : fromOf(t).length ? Math.min(...fromOf(t).map((s) => dist.get(s.id) ?? 500)) : 1000);
  return [...p.transitions].sort((a, b) => rank(a) - rank(b) || Number(NEGATIVE.test(a.node.label)) - Number(NEGATIVE.test(b.node.label)));
}

/** The usual path: from the first status, follow arrows that are not hold/reject/cancel. Also returns the steps taken. */
function happyPath(p: DocProcess): { states: ProcessState[]; steps: DocTransition[] } {
  const edges = processEdges(p).filter((e) => !e.background);
  const order = storyOrder(p);
  const rank = (e: (typeof edges)[number]) => (e.transition ? order.indexOf(e.transition) : 999);
  const first = edges.filter((e) => e.from === "start").sort((a, b) => rank(a) - rank(b))[0];
  const start = first?.to ?? p.initial;
  if (!start) return { states: [], steps: [] };
  const states = [start];
  const steps: DocTransition[] = first?.transition ? [first.transition] : [];
  const seen = new Set([start.id]);
  let cur = start;
  for (;;) {
    const next = edges
      .filter((e) => typeof e.from !== "string" && e.from.id === cur.id && !e.negative && !seen.has(e.to.id))
      .sort((a, b) => Number(a.transition !== steps[steps.length - 1]) - Number(b.transition !== steps[steps.length - 1]) || rank(a) - rank(b))[0];
    if (!next) break;
    states.push(next.to);
    seen.add(next.to.id);
    if (next.transition && !steps.includes(next.transition)) steps.push(next.transition);
    cur = next.to;
  }
  return { states, steps };
}

/** "→ A → B, or (when X) → C": the statuses a step writes, in sequence, per branch. */
function pathsText(t: DocTransition): Inline[] {
  const out: Inline[] = [];
  t.paths.forEach((path, i) => {
    if (i) out.push(";", " or");
    const from = !t.from.length ? t.pathFrom[i] ?? [] : [];
    if (from.length) out.push(" when ", ...states(from));
    path.forEach((s) => out.push(" → ", stateText(s)));
    if (t.pathWhen[i]?.length) out.push(" ", { i: `(if ${t.pathWhen[i].join(", ")})` });
  });
  return out;
}

function processBlocks(f: DocFeature, p: DocProcess): Block[] {
  const blocks: Block[] = [];
  const id = `process-${f.slug}-${p.process.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  blocks.push({ t: "h", level: 2, text: f.processes.length > 1 ? `How it works: ${p.process.subject}` : "How it works", id });

  // The usual path as numbered steps, then the other paths (hold, reject, edit, automatic)
  const order = storyOrder(p);
  const main = happyPath(p).steps;
  const usual = main.length ? main : order;
  const rest = order.filter((t) => !usual.includes(t));
  const line = (t: DocTransition, withFrom: boolean): Inline[] => {
    const out: Inline[] = [{ b: t.lane.name }, `: ${t.node.label}`];
    const branchFrom = t.pathFrom.some((x) => x.length);
    if (withFrom && !t.step.creates && (t.from.length || !branchFrom)) out.push(" when ", ...(t.from.length ? states(t.from) : [{ i: "any status" } as Inline]));
    out.push(...pathsText(t));
    return out;
  };
  blocks.push({ t: "steps", items: usual.map((t) => line(t, false)) });
  const others: Inline[][] = rest.map((t) => line(t, true));
  for (const b of p.background) {
    const l: Inline[] = [{ b: "Automatic" }, `: ${b.by}${b.schedule ? `, ${b.schedule.toLowerCase()}` : ""}`];
    l.push(" when ", ...(b.from.length ? states(b.from) : [{ i: "any status" } as Inline]));
    l.push(" → ", ...states(b.to));
    others.push(l);
  }
  if (others.length) {
    blocks.push({ t: "p", c: [{ b: "Other paths" }] });
    blocks.push({ t: "list", items: others });
  }
  const finals = finalStates(p);
  if (finals.length) blocks.push({ t: "p", c: ["Can end as ", ...states(finals), "."] });
  if (p.other.length) blocks.push({ t: "p", c: [{ i: `Also: ${p.other.map((t) => `${t.node.label} (${t.lane.name})`).join(", ")}. Status unchanged.` }] });
  const graph = stateGraph(p);
  if (graph.edges.length) blocks.push({ t: "diagram", graph, title: `${f.feature.name}: status flow`, id, mermaid: mermaid(graph) });

  blocks.push({
    t: "details",
    summary: `Statuses in code (${p.process.subject})`,
    blocks: [
      {
        t: "table",
        head: ["Status", "In code"],
        rows: p.process.states.map((s) => [[s.label, ...(s.named === "human" ? [" ", { badge: "person", kind: "human" } as Inline] : [])], [{ code: s.code }]]),
        compact: true,
      },
    ],
  });
  return blocks;
}

function viaText(via: "guard" | "view" | "page"): string {
  return via === "guard" ? "code" : via === "view" ? "button" : "form page";
}

function kindLabel(n: MapNode): string {
  return { page: "Page", action: "Action", api: "API", data: "Data", download: "File", redirect: "Redirect" }[n.type];
}

// ---------------------------------------------------------------- glossary

function glossary(m: DocModel): Page {
  const blocks: Block[] = [];
  if (!m.glossary.length) blocks.push({ t: "note", kind: "missing", c: [{ b: "No terms yet" }, ": ", ...addIn(), " → Project."] });
  else blocks.push({ t: "table", head: ["Term", "Meaning"], rows: m.glossary.map(([k, v]) => [[{ b: k }], [v]]) });
  return { file: "glossary.md", id: "glossary", title: "Glossary", part: "understand", lead: "Words and abbreviations used in this project.", blocks };
}

// ---------------------------------------------------------------- business rules

function businessRules(m: DocModel): Page {
  const blocks: Block[] = [];
  blocks.push({ t: "h", level: 2, text: "Form rules", id: "form-rules" });
  if (!m.rules.length) blocks.push({ t: "note", kind: "info", c: ["No validation found."] });
  let lastFeature = "";
  for (const r of m.rules) {
    if (r.feature.name !== lastFeature) {
      blocks.push({ t: "h", level: 3, text: r.feature.name, id: anchor("rules", r.feature.id) });
      lastFeature = r.feature.name;
    }
    const head: Inline[] = [{ b: r.node.label }];
    if (r.forms.length) head.push(` · form on ${r.forms.map((x) => x.label).join(", ")}`);
    blocks.push({ t: "p", c: head });
    for (const v of r.validation) blocks.push(...validationTable(v));
  }
  blocks.push({ t: "h", level: 2, text: "Allowed only in status", id: "status-rules" });
  if (!m.statusRules.length) blocks.push({ t: "note", kind: "info", c: ["No status checks found."] });
  else
    blocks.push({
      t: "table",
      head: ["Step", "Status", "Checked by"],
      rows: m.statusRules.map((s) => [[s.node.label, ` (${s.process.subject.split(".")[0]})`], states(s.from), [viaText(s.via)]]),
    });
  return { file: "business-rules.md", id: "business-rules", title: "Business rules", part: "reference", lead: "What each form accepts, and when a step is allowed.", blocks };
}

function validationTable(v: Validation): Block[] {
  const by: Inline[] = v.via === "form-request" ? [{ code: short(v.class ?? "") }, " ", { src: v.source }] : [{ src: v.source }];
  return [
    { t: "table", head: ["Field", "Rule"], rows: v.fields.map((f) => [[{ code: f.field }], [f.rules.map((r) => r.text ?? r.rule).join(", ")]]) },
    { t: "p", c: by },
  ];
}

// ---------------------------------------------------------------- data

function dataDictionary(m: DocModel): Page {
  const blocks: Block[] = [];
  const page = (b: Block[]): Page => ({ file: "data-dictionary.md", id: "data", title: "Data", part: "reference", lead: "Database tables and columns, from the migrations.", blocks: b });
  if (!m.tables.length) return page([{ t: "note", kind: "info", c: ["No migrations found."] }]);
  blocks.push({
    t: "table",
    head: ["Table", "Model", "Columns", "Note"],
    rows: m.tables.map((t) => [[{ link: t.name, to: tableAnchor(t.name) }], t.model ? [{ code: t.model }] : [DASH], [String(t.columns.length)], [t.comment ?? (t.partial ? "created elsewhere" : DASH)]]),
    compact: true,
  });
  if (m.relations.length) {
    blocks.push({ t: "h", level: 2, text: "Relationships", id: "relationships" });
    const known = new Set(m.tables.map((t) => t.name));
    const er = ["erDiagram"];
    for (const { table, column } of m.relations) er.push(`  ${erName(column.references!.table)} ||--o{ ${erName(table)} : "${column.name}"`);
    blocks.push({ t: "mermaid", code: er.join("\n") });
    blocks.push({
      t: "list",
      items: m.relations.map(({ table, column }) => [
        { code: `${table}.${column.name}` },
        " → ",
        { code: `${column.references!.table}.${column.references!.column}` },
        ...(column.references!.onDelete ? [`, on delete ${column.references!.onDelete}`] : []),
        ...(column.references!.by === "convention" ? [" ", { i: "(by name)" } as Inline] : []),
        ...(known.has(column.references!.table) ? [] : [" ", { i: "(not in migrations)" } as Inline]),
      ]),
    });
  }
  const knownValues = statusValuesByColumn(m);
  for (const t of m.tables) {
    blocks.push({ t: "h", level: 2, text: t.name, id: tableAnchor(t.name) });
    const meta: Inline[] = [];
    if (t.model) meta.push({ code: t.model }, " · ");
    if (t.partial) meta.push("created elsewhere · ");
    meta.push(`${t.migrations.length} migration${t.migrations.length === 1 ? "" : "s"}`);
    const keys = t.columns.filter((c) => c.primary || c.references).map((c) => c.name);
    if (keys.length) meta.push(` · keys: ${keys.join(", ")}`);
    blocks.push({ t: "p", c: meta });
    blocks.push({
      t: "details",
      summary: `Columns (${t.columns.length})`,
      blocks: [{ t: "table", head: ["Column", "Type", "Null", "Default", "Key", "Note"], rows: t.columns.map((c) => columnRow(t, c, knownValues)), compact: true }],
    });
  }
  return page(blocks);
}

function erName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

function statusValuesByColumn(m: DocModel): Map<string, ProcessState[]> {
  const out = new Map<string, ProcessState[]>();
  for (const p of m.map.processes ?? []) {
    const [model, column] = p.subject.split(".");
    const table = m.tables.find((t) => t.model === model);
    if (table && column) out.set(`${table.name}.${column}`, p.states);
  }
  return out;
}

function columnRow(t: DataTable, c: DataColumn, known: Map<string, ProcessState[]>): Inline[][] {
  const keys: string[] = [];
  if (c.primary) keys.push("PK");
  if (c.references) keys.push(`FK → ${c.references.table}`);
  if (c.unique) keys.push("unique");
  else if (c.index && !c.references) keys.push("index");
  const notes: string[] = [];
  if (c.comment) notes.push(c.comment);
  if (c.values?.length) notes.push(c.values.join(", "));
  const st = known.get(`${t.name}.${c.name}`);
  if (st?.length) notes.push(st.map((s) => (s.label !== s.value ? `${s.value} = ${s.label}` : s.value)).join(", "));
  return [[{ code: c.name }], [`${c.type}${c.size ? `(${c.size})` : ""}`], [c.nullable ? "yes" : ""], c.default !== undefined ? [{ code: c.default }] : [""], [keys.join(", ")], [notes.join("; ")]];
}

// ---------------------------------------------------------------- integrations

function integrations(m: DocModel): Page {
  const blocks: Block[] = [];
  const page = (b: Block[]): Page => ({ file: "integrations.md", id: "integrations", title: "Integrations", part: "reference", lead: "Outside systems the app talks to.", blocks: b });
  if (!m.integrations.length) return page([{ t: "note", kind: "info", c: ["No outside systems found."] }]);
  const section = (kind: Integration["kind"], title: string, head: string[], row: (g: Integration) => Inline[][]) => {
    const list = m.integrations.filter((g) => g.kind === kind);
    if (!list.length) return;
    blocks.push({ t: "h", level: 2, text: title, id: `integrations-${kind}` });
    blocks.push({ t: "table", head, rows: list.map(row) });
  };
  const usedBy = (g: Integration): Inline[] => {
    const out: Inline[] = [];
    g.usages.forEach((u, i) => {
      if (i) out.push("; ");
      if (u.by.length) out.push(u.by.map((b) => byLabel(m, b)).join(", "));
      else if (u.in) out.push({ code: `${short(u.in.class)}@${u.in.method ?? ""}` });
      out.push(" ", { src: u.source });
    });
    return out;
  };
  const env = (g: Integration): Inline[] => (g.env?.length ? [g.env.join(", ")] : [DASH]);
  section("http", "HTTP APIs", ["Service", "Calls", "Env keys", "Used by"], (g) => [
    [{ b: g.name }],
    [[...new Set(g.usages.map((u) => `${u.method ?? "?"} ${u.path ?? "/"}`))].join(", ")],
    env(g),
    usedBy(g),
  ]);
  section("mail", "Email", ["Email", "Sent by"], (g) => [[{ b: g.name }], usedBy(g)]);
  section("notification", "Notifications", ["Notification", "Channels", "Sent by"], (g) => [[{ b: g.name }], [g.channels?.join(", ") ?? "?"], usedBy(g)]);
  section("storage", "File storage", ["Disk", "Does", "Env keys", "Used by"], (g) => [
    [{ b: g.name }],
    [[...new Set(g.usages.map((u) => u.operation ?? ""))].filter(Boolean).join(", ")],
    env(g),
    usedBy(g),
  ]);
  return page(blocks);
}

// ---------------------------------------------------------------- automation

function automation(m: DocModel): Page {
  const blocks: Block[] = [];
  const page = (b: Block[]): Page => ({ file: "automation.md", id: "automation", title: "Automation", part: "reference", lead: "What runs on its own: schedule, commands, jobs.", blocks: b });
  if (!m.schedule.length && !m.commands.length && !m.jobs.length) return page([{ t: "note", kind: "info", c: ["No scheduled tasks, commands or jobs found."] }]);
  if (m.schedule.length) {
    blocks.push({ t: "h", level: 2, text: "Schedule", id: "schedule" });
    blocks.push({
      t: "table",
      head: ["When", "Runs", "Code"],
      rows: m.schedule.map((s) => {
        const cmd = s.runs.kind === "command" ? m.commands.find((c) => c.name === s.runs.name) : undefined;
        const runs: Inline[] = s.runs.kind === "job" ? [`Job ${short(s.runs.name)}`] : s.runs.kind === "closure" ? ["Code in the scheduler"] : [{ code: s.runs.name }];
        if (s.runs.kind === "command" && cmd?.description) runs.push(`: ${cmd.description}`);
        if (s.runs.kind === "command" && !cmd) runs.push(" ", { i: "(Laravel / package)" });
        if (s.description) runs.push(` · ${s.description}`);
        if (s.options.length) runs.push(` · ${s.options.join(", ")}`);
        return [[s.whenText ?? { code: s.when }], runs, [{ code: s.when }, " ", { src: s.source }]];
      }),
    });
  }
  const writesText = (writes: { subject: string; to: { label?: string; value: string }; when?: Array<{ label?: string; value: string }> }[]): Inline[] => {
    if (!writes.length) return [DASH];
    return [writes.map((w) => `${w.subject.split(".")[0]}: ${w.when?.length ? `${w.when.map((v) => v.label ?? v.value).join(" / ")} → ` : "→ "}${w.to.label ?? w.to.value}`).join("; ")];
  };
  if (m.commands.length) {
    blocks.push({ t: "h", level: 2, text: "Commands", id: "commands" });
    blocks.push({
      t: "table",
      head: ["Command", "Description", "Status change", "Calls"],
      rows: m.commands.map((c) => [[{ code: c.name }], [c.description ?? DASH], writesText(c.writes), [effectsOf(m, `command:${c.name}`)]]),
    });
  }
  if (m.jobs.length) {
    blocks.push({ t: "h", level: 2, text: "Jobs", id: "jobs" });
    blocks.push({
      t: "table",
      head: ["Job", "Queued", "Started by", "Status change", "Calls"],
      rows: m.jobs.map((j) => {
        const sched = m.schedule.filter((s) => s.runs.kind === "job" && s.runs.name === j.class);
        const from: Inline[] = sched.map((s) => (s.whenText ?? s.when).toLowerCase());
        const others = j.dispatchedFrom.filter((d) => !sched.some((s) => s.source.file === d.file && s.source.line === d.line));
        others.forEach((d) => {
          if (from.length) from.push(", ");
          from.push({ src: d });
        });
        return [[{ code: short(j.class) }, " ", { src: j.source }], [j.queued ? "yes" : "no"], from.length ? from : [DASH], writesText(j.writes), [effectsOf(m, `job:${j.class}`)]];
      }),
    });
  }
  return page(blocks);
}

function effectsOf(m: DocModel, by: string): string {
  const out = m.integrations.filter((g) => g.usages.some((u) => u.by.includes(by))).map((g) => `${{ http: "API", mail: "email", notification: "notification", storage: "storage" }[g.kind]} ${g.name}`);
  return out.join(", ") || DASH;
}

// ---------------------------------------------------------------- API

function api(m: DocModel): Page {
  const blocks: Block[] = [];
  const page = (b: Block[]): Page => ({ file: "api.md", id: "api", title: "API", part: "reference", lead: "Endpoints called by scripts on the pages and by other systems.", blocks: b });
  if (!m.endpoints.length) return page([{ t: "note", kind: "info", c: ["No API, data or file endpoints found."] }]);
  blocks.push({
    t: "table",
    head: ["Endpoint", "Type", "Access", "Input", "Returns"],
    rows: m.endpoints.map(({ node: n }) => [
      [n.validation?.length ? { link: endpoint(n), to: anchor("api", n.id) } : { code: endpoint(n) }],
      [kindLabel(n)],
      [n.who ? n.who.name : accessOf(n)],
      [inputsOf(n)],
      [n.responds?.map((r) => ({ view: "page", redirect: "redirect", json: "JSON", file: "file" })[r]).join(", ") || DASH],
    ]),
  });
  for (const { node: n } of m.endpoints) {
    if (!n.validation?.length) continue;
    blocks.push({ t: "h", level: 3, text: endpoint(n), id: anchor("api", n.id) });
    for (const v of n.validation) blocks.push(...validationTable(v));
  }
  return page(blocks);
}

function inputsOf(n: MapNode): string {
  const params = [...n.uri.matchAll(/\{([^}?]+)(\?)?\}/g)].map((x) => `{${x[1]}}`);
  const validated = n.validation?.flatMap((v) => v.fields.map((f) => f.field)) ?? [];
  const read = (n.inputs ?? []).filter((i) => !validated.includes(i)).map((i) => (i === "*" ? "all fields" : `${i} (not validated)`));
  return [...params, ...validated, ...read].join(", ") || DASH;
}

function accessOf(n: MapNode): string {
  // auth, sanctum, or the app's own login check (isLogin, checkSession, auth.sso…)
  if (n.middleware.some((x) => /^auth(:|$)|^auth\.|sanctum/i.test(x) || (!x.includes(":") && /login|logged|session|sso|token|jwt/i.test(x)))) return "Signed-in user";
  // web / api are Laravel's route groups, not access checks
  const checks = n.middleware.filter((x) => !/^(web|api|throttle(:.*)?|bindings|substituteBindings)$/i.test(x));
  return checks.length ? checks.join(", ") : "Anyone";
}

// ---------------------------------------------------------------- configuration

function configuration(m: DocModel): Page {
  const blocks: Block[] = [];
  const used = m.config.filter((c) => c.uses.length);
  const own = used.filter((c) => !c.framework);
  const framework = used.filter((c) => c.framework);
  const unused = m.config.filter((c) => !c.uses.length && c.inExample);
  const table = (list: typeof used): Block => ({
    t: "table",
    head: ["Key", "Config", "Read in", "Default", ".env.example"],
    rows: list.map((c) => [
      [{ code: c.key }],
      [[...new Set(c.uses.map((u) => u.config).filter(Boolean))].join(", ") || DASH],
      c.uses.flatMap((u, i): Inline[] => [...(i ? ["; "] : []), { src: u.source }]),
      [c.uses.some((u) => u.hasDefault) ? "yes" : "no"],
      [c.inExample ? "yes" : c.framework ? "no" : { badge: "missing", kind: "warn" }],
    ]),
  });
  blocks.push({ t: "p", c: [{ i: "Names only. Values are never read." }] });
  if (!used.length) blocks.push({ t: "note", kind: "info", c: ["No env() calls found."] });
  if (own.length) {
    blocks.push({ t: "h", level: 2, text: "Keys this app adds", id: "config-app" });
    blocks.push(table(own));
  }
  if (framework.length) blocks.push({ t: "details", summary: `Laravel's own keys (${framework.length})`, blocks: [table(framework)] });
  if (unused.length) {
    blocks.push({ t: "p", c: [{ b: "Only in .env.example" }, " (used by Laravel or packages): ", ...unused.flatMap((c, i): Inline[] => [...(i ? [", "] : []), { code: c.key }])] });
  }
  return { file: "configuration.md", id: "configuration", title: "Configuration", part: "reference", lead: "Environment keys to set when installing.", blocks };
}

// ---------------------------------------------------------------- findings

function findingsPage(m: DocModel): Page {
  const blocks: Block[] = [];
  const problems = m.findings.filter((f) => f.title !== "Scan notes");
  if (!problems.length) blocks.push({ t: "note", kind: "info", c: ["Nothing to report."] });
  else blocks.push({ t: "list", items: problems.map((f) => [{ link: `${f.title} (${f.items.length})`, to: anchor("finding", f.title) }]) });
  for (const f of m.findings) {
    const list: Block[] = [];
    if (f.why) list.push({ t: "p", c: [{ i: f.why }] });
    list.push({ t: "list", items: f.items.map((it) => [it.text, ...(it.source ? [" ", { src: it.source } as Inline] : [])]) });
    blocks.push({ t: "h", level: 2, text: `${f.title} (${f.items.length})`, id: anchor("finding", f.title) });
    if (f.title === "Scan notes") blocks.push({ t: "details", summary: "How the scan ran", blocks: list });
    else blocks.push(...list);
  }
  return { file: "findings.md", id: "findings", title: "Findings", part: "health", lead: "Things to check or fix, with file:line.", blocks };
}
