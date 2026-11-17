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
import type { BuiltMap, DataColumn, DataTable, Integration, MapNode, ProcessState, SourceRef, Validation } from "../core/types.js";
import { mermaid, stateGraph, type StateGraph } from "./diagram.js";
import { ERD_MAX_TABLES, erdMermaid, erdModel, type ErdGroup } from "./erd.js";
import { areaMap, flowMermaid, processFlow, screenFlow, type FlowGraph } from "./flow.js";
import { byLabel, CRUD_LABEL, endpoint, finalStates, NEGATIVE, processEdges, short, type CrudOp, type DocFeature, type DocModel, type DocProcess, type DocTransition } from "./model.js";

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
  /** A flowchart: swimlanes of who does what, screens and actions, or areas. */
  | { t: "flow"; graph: FlowGraph; title: string; caption: string; mermaid: string }
  /** How a group of tables relate (entity-relationship diagram). */
  | { t: "erd"; group: ErdGroup; title: string; mermaid: string }
  | { t: "mermaid"; code: string }
  /** A block of text to copy, e.g. YAML to paste into builtlore.edits.yaml. */
  | { t: "code"; lang: string; text: string }
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
  /** Where the page sits in the sidebar: a section ("Business processes"), an area ("Application") and a short title ("PID"). */
  nav?: { section: string; area?: string; short: string };
  blocks: Block[];
}

const SECTION = { process: "Business processes", data: "Data management", other: "Other screens" } as const;

export interface PageOptions {
  /** Where the canvas is, relative to the docs folder (or a URL in builtlore serve). */
  canvasHref?: string;
}

const DASH = "—";

export function buildPages(m: DocModel, opts: PageOptions = {}): Page[] {
  // Features with a business process first, then data management (CRUD), then the rest
  const rank = { process: 0, data: 1, other: 2 };
  const ordered = [...m.features].sort((a, b) => rank[a.kind] - rank[b.kind] || a.feature.name.localeCompare(b.feature.name));
  return [
    overview(m, opts),
    roles(m),
    ...ordered.map((f) => featurePage(m, f)),
    ...(m.features.some((f) => f.kind === "data") ? [dataManagement(m)] : []),
    glossary(m),
    businessRules(m),
    dataDictionary(m),
    integrations(m),
    automation(m),
    api(m),
    configuration(m),
    findingsPage(m),
    toWritePage(m),
  ];
}

export const featureAnchor = (f: DocFeature) => `feature-${f.slug}`;
export const tableAnchor = (name: string) => `table-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
export const roleAnchor = (id: string) => `role-${id}`;
const anchor = (prefix: string, s: string) => `${prefix}-${s.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** "write it in builtlore.edits.yaml (To write)" */
const addIn = (): Inline[] => ["write it in ", { code: "builtlore.edits.yaml" }, " (", { link: "To write", to: "to-write" }, ")"];

// ---------------------------------------------------------------- overview

function overview(m: DocModel, opts: PageOptions): Page {
  const map = m.map;
  const blocks: Block[] = [];
  if (m.summary) blocks.push({ t: "p", c: [m.summary] });
  else blocks.push({ t: "note", kind: "missing", c: [{ b: "No summary yet" }, " (what the system is for, who uses it): ", ...addIn(), "."] });

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
        const line: Inline[] = [{ link: p.process.features?.length ? p.process.name : f.feature.name, to: featureAnchor(f) }, ": "];
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

  // How the areas of the app connect, as a flowchart
  const areas = areaMap(m);
  if (areas && areas.nodes.length > 2) {
    blocks.push({ t: "h", level: 2, text: "How the areas connect", id: "area-map" });
    blocks.push({ t: "flow", graph: areas, title: "How the areas connect", caption: "Arrows: links, forms and redirects from one area's screens to another's", mermaid: flowMermaid(areas) });
  }

  blocks.push({ t: "h", level: 2, text: "Modules", id: "modules" });
  const rank = { process: 0, data: 1, other: 2 };
  blocks.push({
    t: "table",
    head: ["Feature", "Kind", "Purpose"],
    rows: [...m.features]
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.feature.name.localeCompare(b.feature.name))
      .map((f) => [
        [{ link: f.feature.name, to: featureAnchor(f) }],
        [f.kind === "process" ? "Business process" : f.kind === "data" ? "Data management" : DASH],
        [f.feature.description ?? DASH],
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
          [{ badge: "person", kind: "human" }, " written by a person in ", { code: "builtlore.edits.yaml" }, " (", { link: "To write", to: "to-write" }, ")."],
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
  // Buttons the page shows only with a permission the server does not check
  const pageOnly = actions.filter((n) => n.pageOnly);
  if (pageOnly.length) {
    const abilities = [...new Set(pageOnly.flatMap((n) => n.pageOnly!.abilities))];
    can.push([
      { badge: "page only", kind: "warn" },
      ` The page shows ${pageOnly.length === actions.length ? "these actions" : pageOnly.map((n) => n.label).join(", ")} only with ${abilities.join(", ")}; the server does not check it (`,
      { link: "Findings", to: "findings" },
      ").",
    ]);
  }
  if (can.length) {
    blocks.push({ t: "h", level: 2, text: "What you can do here", id: `${featureAnchor(f)}-can` });
    blocks.push({ t: "list", items: can });
  }

  // Data management (CRUD): one compact table instead of a story
  if (f.kind === "data") {
    const rank: CrudOp[] = ["add", "edit", "delete", "import", "export", "other"];
    const writes = f.ops.filter((o) => o.node.type !== "page" && o.op !== "list" && o.op !== "view").sort((a, b) => rank.indexOf(a.op) - rank.indexOf(b.op));
    blocks.push({ t: "h", level: 2, text: "Data management", id: `${featureAnchor(f)}-data` });
    blocks.push({ t: "p", c: [{ i: `Operations: ${crudSummary(f.ops.map((o) => o.op))}.` }] });
    blocks.push({
      t: "table",
      head: ["Operation", "Step", "Who", "Fields checked"],
      rows: writes.map(({ op, node }) => {
        const fields = (node.validation ?? []).flatMap((v) => v.fields.map((x) => x.field));
        return [
          [CRUD_LABEL[op]],
          [node.label],
          [node.who ? node.who.name : DASH, ...(node.pageOnly ? [" ", { badge: "page only", kind: "warn" } as Inline] : [])],
          [fields.length ? `${fields.slice(0, 6).join(", ")}${fields.length > 6 ? ` +${fields.length - 6}` : ""}` : DASH],
        ];
      }),
    });
  }

  for (const p of f.processes) blocks.push(...processBlocks(m, f, p));

  // Where each screen leads (links, forms, script calls, redirects); data endpoints left out
  const flow: Inline[][] = [];
  for (const n of pages) {
    const out = m.map.edges.filter((e) => e.from === n.id && e.to !== n.id && ["link", "submit", "redirect", "ajax"].includes(e.trigger));
    const targets = [...new Set(out.map((e) => e.to))]
      .map((id) => m.map.nodes.find((x) => x.id === id))
      .filter((x): x is MapNode => Boolean(x) && !x!.hidden && x!.type !== "data");
    if (targets.length) flow.push([{ b: n.label }, " → ", targets.map((t) => (t.feature === n.feature ? t.label : byLabel(m, t.id))).join(", ")]);
  }
  // Screens and actions as a flowchart when it stays readable; as a list when the feature is busy
  const screens = screenFlow(m, f);
  if (screens || flow.length) blocks.push({ t: "h", level: 2, text: "Screens and actions", id: `${featureAnchor(f)}-screens` });
  if (screens) blocks.push({ t: "flow", graph: screens, title: `${f.feature.name}: screens and actions`, caption: "Boxes: screens · rounded with a bar: actions · dashed red: when it fails · dotted: called from the page's script", mermaid: flowMermaid(screens) });
  else if (flow.length) blocks.push({ t: "list", items: flow });
  // Processes owned by another feature that this one takes part in (created there, approved here)
  if (f.shared.length) {
    blocks.push({ t: "h", level: 2, text: "Also part of", id: `${featureAnchor(f)}-shared` });
    blocks.push({
      t: "list",
      items: f.shared.map(({ process, owner }): Inline[] => {
        const here = process.steps.filter((s) => f.nodes.some((n) => n.id === s.node)).map((s) => m.map.nodes.find((n) => n.id === s.node)?.label ?? s.node);
        const ownerDoc = m.features.find((x) => x.feature.id === owner.id);
        return [{ b: process.name }, `: ${here.join(", ")} happen here; the whole flow is in `, ownerDoc ? { link: owner.name, to: featureAnchor(ownerDoc) } : owner.name, "."];
      }),
    });
  }

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
  if (flow.length && screens) dev.push({ t: "p", c: [{ b: "Where each screen leads" }] }, { t: "list", items: flow });
  if (f.feature.files.length) dev.push({ t: "p", c: [{ b: "Files" }] }, { t: "list", items: f.feature.files.map((x) => [{ src: { file: x } }]) });
  blocks.push({ t: "details", summary: "For developers: routes, screens, files", blocks: dev });

  return {
    file: `features/${f.slug}.md`,
    id: featureAnchor(f),
    title: f.feature.name,
    part: "understand",
    group: { id: "features", title: "Features", lead: "What each part of the app does, and how a record moves through it." },
    nav: { section: SECTION[f.kind], ...(f.area !== f.feature.name ? { area: f.area } : {}), short: f.short },
    blocks,
  };
}

/** "Add · Edit · Delete · Import · Export" in that order, each once. */
function crudSummary(ops: CrudOp[]): string {
  const order: CrudOp[] = ["list", "view", "add", "edit", "delete", "import", "export", "other"];
  return order.filter((o) => ops.includes(o)).map((o) => CRUD_LABEL[o]).join(" · ");
}

// ---------------------------------------------------------------- data management

/** Every master-data feature in one table: what can be done and who may do it. */
function dataManagement(m: DocModel): Page {
  const data = m.features.filter((f) => f.kind === "data").sort((a, b) => a.feature.name.localeCompare(b.feature.name));
  const cols: CrudOp[] = ["add", "edit", "delete", "import", "export"];
  const blocks: Block[] = [];
  blocks.push({
    t: "p",
    c: [
      `${data.length} feature${data.length === 1 ? "" : "s"} only keep a list up to date (add, edit, delete, import, export) with no status flow. They are summed up here; each still has its own page.`,
    ],
  });
  const pageOnly = data.filter((f) => f.nodes.some((n) => n.pageOnly)).length;
  if (pageOnly) blocks.push({ t: "note", kind: "warn", c: [`In ${pageOnly} of them the permission is checked only in the page, not on the server (`, { link: "Findings", to: "findings" }, ")."] });
  blocks.push({
    t: "table",
    head: ["Feature", ...cols.map((c) => CRUD_LABEL[c]), "Who"],
    rows: data.map((f) => {
      const who = [...new Set(f.nodes.filter((n) => n.who).map((n) => n.who!.name))];
      const pagePerms = [...new Set(f.nodes.flatMap((n) => n.pageOnly?.abilities ?? []))];
      return [
        [{ link: f.feature.name, to: featureAnchor(f) }],
        ...cols.map((c): Inline[] => [f.ops.some((o) => o.op === c && o.node.type !== "page") ? "✓" : ""]),
        [who.join(", ") || DASH, ...(pagePerms.length ? [{ i: ` (page: ${pagePerms.join(", ")})` } as Inline] : [])],
      ];
    }),
    compact: true,
  });
  return { file: "data-management.md", id: "data-management", title: "Data management overview", part: "understand", lead: "Lists the app keeps (master data), what can be done with each, and who may do it.", blocks };
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
  // No step creates the record here (made elsewhere: import, another app, a stored procedure):
  // start where the flow is entered (a status steps check but none sets), else at the first status written
  const targets = new Set(edges.map((e) => e.to.id));
  const entry = edges
    .filter((e) => typeof e.from !== "string" && !targets.has(e.from.id))
    .sort((a, b) => rank(a) - rank(b))[0];
  const fromAny = edges.filter((e) => e.from === "any" && !e.negative).sort((a, b) => rank(a) - rank(b))[0];
  const start = first?.to ?? p.initial ?? (entry && typeof entry.from !== "string" ? entry.from : undefined) ?? fromAny?.to;
  if (!start) return { states: [], steps: [] };
  const states = [start];
  const lead = first ?? (!p.initial && !entry ? fromAny : undefined);
  const steps: DocTransition[] = lead?.transition ? [lead.transition] : [];
  const seen = new Set([start.id]);
  let cur = start;
  for (;;) {
    const next =
      edges
        .filter((e) => typeof e.from !== "string" && e.from.id === cur.id && !e.negative && !seen.has(e.to.id))
        .sort((a, b) => Number(a.transition !== steps[steps.length - 1]) - Number(b.transition !== steps[steps.length - 1]) || rank(a) - rank(b))[0] ??
      // Stuck right at the start (created with an empty status, then submitted by a step that checks nothing):
      // a step that runs at any status moves it on. Later in the flow such steps are side paths.
      (states.length === 1
        ? edges.filter((e) => e.from === "any" && !e.negative && !seen.has(e.to.id) && e.transition && !steps.includes(e.transition)).sort((a, b) => rank(a) - rank(b))[0]
        : undefined);
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

function processBlocks(m: DocModel, f: DocFeature, p: DocProcess): Block[] {
  const blocks: Block[] = [];
  const id = `process-${f.slug}-${p.process.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  blocks.push({ t: "h", level: 2, text: f.processes.length > 1 ? `How it works: ${p.process.subject}` : "How it works", id });

  // The usual path as numbered steps, then the other paths (hold, reject, edit, automatic)
  const order = storyOrder(p);
  const main = happyPath(p).steps;
  const usual = main.length ? main : order;
  const rest = order.filter((t) => !usual.includes(t));
  const line = (t: DocTransition, withFrom: boolean): Inline[] => {
    const out: Inline[] = [{ b: t.lane.name }, `: ${t.node.feature === f.feature.id ? t.node.label : byLabel(m, t.node.id)}`];
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
  if (p.other.length) blocks.push({ t: "p", c: [{ i: `Also: ${p.other.map((t) => `${t.node.feature === f.feature.id ? t.node.label : byLabel(m, t.node.id)} (${t.lane.name})`).join(", ")}. Status unchanged.` }] });
  // Who does what, as swimlanes: each arrow carries the status one step leaves and the next needs
  const lanes = processFlow(p);
  if (lanes && lanes.nodes.filter((n) => n.kind === "action").length > 1) {
    blocks.push({ t: "p", c: [{ b: "Who does what" }] });
    blocks.push({ t: "flow", graph: lanes, title: `${p.process.name}: who does what`, caption: "One row per role · arrows carry the status in between · rounded green: where it ends, red: stopped", mermaid: flowMermaid(lanes) });
  }
  const graph = stateGraph(p);
  if (graph.edges.length > 40) {
    blocks.push({ t: "note", kind: "info", c: [`${graph.edges.length} status moves: too many to draw as one picture. The steps above list each of them.`] });
  } else if (graph.edges.length) {
    blocks.push({ t: "p", c: [{ b: "Status flow" }] });
    blocks.push({ t: "diagram", graph, title: `${f.feature.name}: status flow`, id, mermaid: mermaid(graph) });
  }

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
  if (!m.glossary.length) blocks.push({ t: "note", kind: "missing", c: [{ b: "No terms yet" }, ": ", ...addIn(), "."] });
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
  const page = (b: Block[]): Page => ({ file: "data-dictionary.md", id: "data", title: "Data", part: "reference", lead: "Database tables, columns and how they relate, from the migrations and the models.", blocks: b });
  const rels = m.map.data?.relations ?? [];
  if (!m.tables.length && !rels.length) return page([{ t: "note", kind: "info", c: ["No migrations or model relations found."] }]);
  // The list of tables, folded: the pictures of how they relate come first
  const tableList: Block = m.tables.length
    ? {
        t: "details",
        summary: `All tables (${m.tables.length})`,
        blocks: [
          {
            t: "table",
            head: ["Table", "Model", "Columns", "Note"],
            rows: m.tables.map((t) => [[{ link: t.name, to: tableAnchor(t.name) }], t.model ? [{ code: t.model }] : [DASH], [String(t.columns.length)], [t.comment ?? (t.partial ? "created elsewhere" : DASH)]]),
            compact: true,
          },
        ],
      }
    : { t: "note", kind: "info", c: ["No migrations found: the tables are known from the relations on the models only."] };
  if (!rels.length) blocks.push(tableList);
  if (rels.length) {
    blocks.push({ t: "h", level: 2, text: "How the tables relate", id: "relationships" });
    const { groups, hubs } = erdModel(m.map);
    const known = new Set(m.tables.map((t) => t.name.toLowerCase()));
    blocks.push({
      t: "p",
      c: [
        { i: `${rels.length} relation${rels.length === 1 ? "" : "s"}. Crow's foot: the "many" side, which holds the key. Dashed: declared only on a model (no foreign key in the migrations).` },
      ],
    });
    // Lookup tables many others point at: a list, so the pictures show what belongs together
    if (hubs.length) {
      blocks.push({ t: "p", c: [{ b: "Lookup tables" }, " (pointed at by many tables, left out of the pictures below)"] });
      blocks.push({
        t: "list",
        items: hubs.map((h) => {
          const by = [...new Set(h.usedBy.map((u) => u.table))];
          const cols = [...new Set(h.usedBy.flatMap((u) => (u.column ? [u.column] : [])))];
          return [{ code: h.table }, ` ← ${by.length} tables${cols.length ? ` by ${cols.slice(0, 4).join(", ")}${cols.length > 4 ? ", …" : ""}` : ""}: ${by.slice(0, 8).join(", ")}${by.length > 8 ? ", …" : ""}`];
        }),
      });
    }
    groups.forEach((g, i) => {
      const title = groups.length > 1 ? `Group ${i + 1}: ${g.tables.slice(0, 3).map((t) => t.name).join(", ")}${g.tables.length > 3 ? ", …" : ""}` : "Tables";
      if (groups.length > 1) blocks.push({ t: "p", c: [{ b: title }, ` (${g.tables.length} tables)`] });
      if (g.tables.length > ERD_MAX_TABLES) blocks.push({ t: "note", kind: "info", c: [`${g.tables.length} tables linked together: too many for one picture. The list below has every relation.`] });
      else blocks.push({ t: "erd", group: g, title, mermaid: erdMermaid(g) });
    });
    blocks.push({
      t: "details",
      summary: `Every relation (${rels.length})`,
      blocks: [
        {
          t: "table",
          head: ["From", "To", "Kind", "Found in"],
          rows: rels.map((r) => [
            [{ code: r.column ? `${r.from}.${r.column}` : r.from }, ...(known.has(r.from.toLowerCase()) || !m.tables.length ? [] : [" ", { i: "(not in migrations)" } as Inline])],
            [{ code: r.via ? `${r.to} via ${r.via}` : r.toColumn ? `${r.to}.${r.toColumn}` : r.to }],
            [r.kind.replace(/-/g, " ")],
            [
              r.found.map((f) => (f === "model" ? `model${r.methods?.length ? ` (${r.methods.join(", ")})` : ""}` : f)).join(", "),
              ...(r.by === "convention" ? [" ", { i: "(key by Laravel's naming rule)" } as Inline] : []),
            ],
          ]),
          compact: true,
        },
      ],
    });
    blocks.push(tableList);
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
    // Its relations in words
    const lower = t.name.toLowerCase();
    const out = rels.filter((r) => r.from.toLowerCase() === lower);
    const inc = rels.filter((r) => r.to.toLowerCase() === lower && r.from.toLowerCase() !== lower);
    const rel: Inline[] = [];
    if (out.length) rel.push({ b: "Points to" }, ": ", out.map((r) => (r.via ? `${r.to} (via ${r.via})` : `${r.to}${r.column ? ` by ${r.column}` : ""}`)).join(", "));
    if (inc.length) rel.push(...(out.length ? [" · "] : []), { b: "Pointed at by" }, ": ", [...new Set(inc.map((r) => r.from))].join(", "));
    if (rel.length) blocks.push({ t: "p", c: rel });
    blocks.push({
      t: "details",
      summary: `Columns (${t.columns.length})`,
      blocks: [{ t: "table", head: ["Column", "Type", "Null", "Default", "Key", "Note"], rows: t.columns.map((c) => columnRow(t, c, knownValues)), compact: true }],
    });
  }
  return page(blocks);
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

// ---------------------------------------------------------------- to write

export interface MissingText {
  summary: boolean;
  glossary: boolean;
  features: Array<{ id: string; name: string; hint: string }>;
  statuses: Array<{ subject: string; value: string; process: string }>;
  steps: Array<{ id: string; label: string; hint: string }>;
  total: number;
}

/**
 * What only people can write and nobody has yet: the project summary, the glossary,
 * what each feature is for, names for statuses the code only knows by value, and
 * what the status-changing steps mean. Never filled in by builtlore.
 */
export function missingText(map: BuiltMap): MissingText {
  const features = map.features
    .filter((f) => !f.description)
    .map((f) => {
      const ns = f.nodes.map((id) => map.nodes.find((n) => n.id === id)).filter((n): n is MapNode => Boolean(n && !n.hidden));
      const pages = ns.filter((n) => n.type === "page").length;
      return { id: f.id, name: f.name, hint: `${f.name}: ${ns.length} step${ns.length === 1 ? "" : "s"}${pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : ""}` };
    });
  const statuses = (map.processes ?? []).flatMap((p) =>
    p.states
      .filter((s) => s.named === "raw")
      .map((s) => ({ subject: p.subject, value: s.value, process: p.name }))
      .sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true })),
  );
  const changing = new Set((map.processes ?? []).flatMap((p) => p.steps.filter((s) => s.to.length || s.creates).map((s) => s.node)));
  const steps = map.nodes
    .filter((n) => changing.has(n.id) && !n.description && !n.hidden)
    .map((n) => ({ id: n.id, label: n.label, hint: `${n.label}: ${endpoint(n)}` }));
  const summary = !map.project.summary;
  const glossary = !Object.keys(map.glossary ?? {}).length;
  return { summary, glossary, features, statuses, steps, total: Number(summary) + Number(glossary) + features.length + statuses.length + steps.length };
}

function toWriteYaml(t: MissingText): string {
  const key = (s: string) => (/^[A-Za-z0-9_.-]+$/.test(s) && !/^\d+$/.test(s) ? s : JSON.stringify(s));
  const lines = [
    "# Paste into builtlore.edits.yaml (merge with what is there), write the text, run builtlore docs.",
    "# Empty values are ignored, so fill in a few at a time.",
  ];
  if (t.summary) lines.push("project:", '  summary: ""  # What is the system for, and who uses it?');
  if (t.features.length) {
    lines.push("features:");
    for (const f of t.features) lines.push(`  ${key(f.id)}:`, `    description: ""  # ${f.hint}`);
  }
  if (t.statuses.length) {
    lines.push("statuses:");
    const bySubject = new Map<string, MissingText["statuses"]>();
    for (const s of t.statuses) bySubject.set(s.subject, [...(bySubject.get(s.subject) ?? []), s]);
    for (const [subject, list] of bySubject) {
      lines.push(`  ${key(subject)}:  # ${list[0].process}`);
      for (const s of list) lines.push(`    ${JSON.stringify(s.value)}: ""  # shown as ${s.value}`);
    }
  }
  if (t.steps.length) {
    lines.push("steps:");
    for (const s of t.steps) lines.push(`  ${key(s.id)}:`, `    description: ""  # ${s.hint}`);
  }
  if (t.glossary) lines.push("glossary:", "  # Term: what it means in this business");
  return lines.join("\n");
}

function toWritePage(m: DocModel): Page {
  const t = missingText(m.map);
  const blocks: Block[] = [];
  if (!t.total) {
    blocks.push({ t: "note", kind: "info", c: ["Everything that only people can write is written."] });
  } else {
    const parts = [
      t.summary ? "the project summary" : "",
      t.glossary ? "the glossary" : "",
      t.features.length ? `${t.features.length} feature description${t.features.length === 1 ? "" : "s"}` : "",
      t.statuses.length ? `${t.statuses.length} status name${t.statuses.length === 1 ? "" : "s"} (the code only has the value)` : "",
      t.steps.length ? `${t.steps.length} description${t.steps.length === 1 ? "" : "s"} of steps that change a status` : "",
    ].filter(Boolean);
    blocks.push({ t: "p", c: ["Missing: ", parts.join(", "), "."] });
    blocks.push({ t: "p", c: ["Copy this into ", { code: "builtlore.edits.yaml" }, " at the project root, write the text between the quotes, and run ", { code: "builtlore docs" }, " again. Commit the file: every scan applies it, and a step whose code changes later is marked to check."] });
    blocks.push({ t: "code", lang: "yaml", text: toWriteYaml(t) });
  }
  return { file: "to-write.md", id: "to-write", title: "To write", part: "health", lead: "Text only people can write, ready to fill in.", blocks };
}
