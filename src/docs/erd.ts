/**
 * Entity-relationship diagrams from what the code says: foreign keys in migrations and
 * relations declared on models (and the database, when read). One diagram per group of
 * tables that link to each other; each box shows the keys and status columns.
 * Rendered as Mermaid erDiagram (Markdown) and as SVG laid out by ELK (HTML).
 */
import { createRequire } from "node:module";
import type { BuiltMap, DataTable, TableRelation } from "../core/types.js";

const require = createRequire(import.meta.url);

export interface ErdColumn {
  name: string;
  type?: string;
  mark?: "PK" | "FK";
}

export interface ErdTable {
  name: string;
  model?: string;
  columns: ErdColumn[];
  /** Columns not shown in the box. */
  more: number;
  /** Known from a migration (not only from a relation). */
  known: boolean;
}

export interface ErdGroup {
  tables: ErdTable[];
  relations: TableRelation[];
}

const STATUS_LIKE = /(^|_)(status|state|stage|approval)(_id)?$|^is_|^flag_/i;
const MAX_ROWS = 8;
/** Above this many tables a single diagram stops being readable. */
export const ERD_MAX_TABLES = 40;

/** A lookup table many others point at (employees, statuses, units): listed, not drawn. */
export interface ErdHub {
  table: string;
  /** Tables that point at it, with the key they use. */
  usedBy: Array<{ table: string; column?: string }>;
}

/** A table pointed at by this many other tables is a lookup, drawn as a list instead of arrows. */
const HUB_DEGREE = 6;

/**
 * Groups of tables linked by relations, largest first; tables with no relation are left out.
 * Lookup tables that many others point at are taken out first (as hubs), so the groups that
 * remain are the parts of the data model that belong together.
 */
export function erdModel(map: BuiltMap): { groups: ErdGroup[]; hubs: ErdHub[] } {
  const all = map.data?.relations ?? [];
  const incoming = new Map<string, Set<string>>();
  for (const r of all) {
    if (r.kind === "many-to-many") continue;
    const k = r.to.toLowerCase();
    if (!incoming.has(k)) incoming.set(k, new Set());
    incoming.get(k)!.add(r.from.toLowerCase());
  }
  // Take out the most used lookups first; go further only while one group stays too big to read
  let hubNames = new Set<string>();
  for (const degree of [HUB_DEGREE, 5, 4]) {
    hubNames = new Set([...incoming].filter(([, from]) => from.size >= degree).map(([k]) => k));
    const left = all.filter((r) => !hubNames.has(r.to.toLowerCase()) && !hubNames.has(r.from.toLowerCase()));
    const biggest = erdGroups(map, left)[0]?.tables.length ?? 0;
    if (biggest <= 20) break;
  }
  const hubs: ErdHub[] = [...hubNames].map((k) => {
    const rs = all.filter((r) => r.to.toLowerCase() === k && r.kind !== "many-to-many");
    return { table: rs[0]?.to ?? k, usedBy: rs.map((r) => ({ table: r.from, ...(r.column ? { column: r.column } : {}) })) };
  }).sort((a, b) => b.usedBy.length - a.usedBy.length);
  const rest = all.filter((r) => !hubNames.has(r.to.toLowerCase()) && !hubNames.has(r.from.toLowerCase()));
  return { groups: erdGroups(map, rest), hubs };
}

/** Groups of tables linked by relations, largest first; tables with no relation are left out. */
export function erdGroups(map: BuiltMap, only?: TableRelation[]): ErdGroup[] {
  const tables = map.data?.tables ?? [];
  const relations = mergePairs(only ?? map.data?.relations ?? []);
  if (!relations.length) return [];
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const names = new Map<string, string>(); // lower -> display
  const nameOf = (n: string) => {
    const k = n.toLowerCase();
    if (!names.has(k)) names.set(k, byName.get(k)?.name ?? n);
    return k;
  };
  // Union-find over table names
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const join = (a: string, b: string) => {
    for (const x of [a, b]) if (!parent.has(x)) parent.set(x, x);
    parent.set(find(a), find(b));
  };
  for (const r of relations) {
    join(nameOf(r.from), nameOf(r.to));
    if (r.via) join(nameOf(r.from), nameOf(r.via));
  }
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) groups.set(find(k), [...(groups.get(find(k)) ?? []), k]);
  return [...groups.values()]
    .map((members) => {
      const set = new Set(members);
      const rels = relations.filter((r) => set.has(r.from.toLowerCase()));
      return { tables: members.sort().map((k) => erdTable(names.get(k)!, byName.get(k), rels)), relations: rels };
    })
    .sort((a, b) => b.tables.length - a.tables.length || a.tables[0].name.localeCompare(b.tables[0].name));
}

/** One arrow per pair of tables: T_Pengajuan → M_Status by Status and NextStatus reads "Status, NextStatus". */
function mergePairs(relations: TableRelation[]): TableRelation[] {
  const out: TableRelation[] = [];
  for (const r of relations) {
    const same = out.find((x) => x.kind === r.kind && x.from.toLowerCase() === r.from.toLowerCase() && x.to.toLowerCase() === r.to.toLowerCase() && !x.via && !r.via);
    if (!same) out.push({ ...r, found: [...r.found] });
    else {
      if (r.column && !(same.column ?? "").split(", ").includes(r.column)) same.column = same.column ? `${same.column}, ${r.column}` : r.column;
      for (const f of r.found) if (!same.found.includes(f)) same.found.push(f);
    }
  }
  return out;
}

function erdTable(name: string, t: DataTable | undefined, rels: TableRelation[]): ErdTable {
  const lower = name.toLowerCase();
  const fks = new Set(rels.filter((r) => r.from.toLowerCase() === lower && r.column).flatMap((r) => r.column!.toLowerCase().split(", ")));
  const pks = new Set([
    ...rels.filter((r) => r.to.toLowerCase() === lower && r.toColumn).map((r) => r.toColumn!.toLowerCase()),
    ...(t?.columns.filter((c) => c.primary).map((c) => c.name.toLowerCase()) ?? []),
  ]);
  const cols: ErdColumn[] = [];
  const push = (c: ErdColumn) => {
    if (!cols.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) cols.push(c);
  };
  if (t) {
    for (const c of t.columns) if (pks.has(c.name.toLowerCase()) || c.primary) push({ name: c.name, type: c.type, mark: "PK" });
    for (const c of t.columns) if (fks.has(c.name.toLowerCase()) || c.references) push({ name: c.name, type: c.type, mark: "FK" });
    for (const c of t.columns) if (STATUS_LIKE.test(c.name)) push({ name: c.name, type: c.type });
  } else {
    // Known only from relations: just the keys they name
    for (const k of pks) push({ name: k, mark: "PK" });
    for (const k of fks) push({ name: k, mark: "FK" });
  }
  const shown = cols.slice(0, MAX_ROWS);
  const total = t ? t.columns.length : cols.length;
  return { name, ...(t?.model ? { model: t.model } : {}), columns: shown, more: Math.max(0, total - shown.length), known: Boolean(t) };
}

// ------------------------------------------------------------- Mermaid

const ident = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export function erdMermaid(g: ErdGroup): string {
  const lines = ["erDiagram"];
  for (const t of g.tables) {
    if (!t.columns.length) continue;
    lines.push(`  ${ident(t.name)} {`);
    for (const c of t.columns) lines.push(`    ${ident(c.type ?? "key").replace(/^(\d)/, "_$1")} ${ident(c.name)}${c.mark ? ` ${c.mark}` : ""}`);
    lines.push("  }");
  }
  for (const r of g.relations) {
    const label = JSON.stringify(r.via ? `via ${r.via}` : r.column ?? "");
    if (r.kind === "many-to-many") lines.push(`  ${ident(r.from)} }o--o{ ${ident(r.to)} : ${label}`);
    else lines.push(`  ${ident(r.to)} ${r.kind === "one-to-one" ? "||--o|" : "||--o{"} ${ident(r.from)} : ${label}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- SVG

interface ElkOut {
  width: number;
  height: number;
  children?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }>;
  edges?: Array<{ id: string; labels?: Array<{ width: number; height: number; x?: number; y?: number }>; sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }> }>;
}
let elkInstance: { layout(g: unknown): Promise<ElkOut> } | null = null;
function elk() {
  if (!elkInstance) {
    const ELK = require("elkjs/lib/elk.bundled.js");
    elkInstance = new ELK();
  }
  return elkInstance!;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const round = (n: number) => Math.round(n * 10) / 10;
const HEAD = 26;
const ROW = 17;

export async function erdSvg(g: ErdGroup, title: string, uid: string): Promise<string> {
  const id = (name: string) => `t_${ident(name.toLowerCase())}`;
  const size = (t: ErdTable) => {
    const rows = t.columns.length + (t.more ? 1 : 0);
    const longest = Math.max(t.name.length * 7.4, ...t.columns.map((c) => (c.name.length + (c.type?.length ?? 0) + 6) * 6.3));
    return { width: Math.max(150, Math.round(longest + 24)), height: HEAD + Math.max(1, rows) * ROW + 6 };
  };
  const tableIds = new Set(g.tables.map((t) => id(t.name)));
  const edges = g.relations.filter((r) => tableIds.has(id(r.from)) && tableIds.has(id(r.to)));
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "LEFT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "28",
      "elk.spacing.edgeLabel": "4",
      "elk.edgeLabels.placement": "CENTER",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
    },
    children: g.tables.map((t) => ({ id: id(t.name), ...size(t) })),
    edges: edges.map((r, i) => {
      const text = r.via ? `via ${r.via}` : r.column ?? "";
      return { id: `e${i}`, sources: [id(r.from)], targets: [id(r.to)], ...(text ? { labels: [{ text, width: Math.round(text.length * 5.8 + 10), height: 15 }] } : {}) };
    }),
  };
  const laid = await elk().layout(structuredClone(graph));
  const W = Math.ceil(laid.width);
  const H = Math.ceil(laid.height);
  const out: string[] = [];
  out.push(`<svg class="erd${W > 1200 ? " wide" : ""}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`);
  out.push(`<defs><marker id="${uid}-one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M10,1 L10,11" class="erd-mark"/><path d="M7,1 L7,11" class="erd-mark"/></marker>` +
    `<marker id="${uid}-many" viewBox="0 0 12 12" refX="1" refY="6" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M11,6 L1,1 M11,6 L1,11 M11,6 L1,6" class="erd-mark"/></marker></defs>`);
  for (const e of laid.edges ?? []) {
    const r = edges[Number(e.id.slice(1))];
    for (const s of e.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
      // Crow's foot on the "many" side (the table holding the key), a bar on the "one" side
      const startMarker = r.kind === "one-to-one" ? `${uid}-one` : `${uid}-many`;
      const endMarker = r.kind === "many-to-many" ? `${uid}-many` : `${uid}-one`;
      out.push(`<polyline class="erd-edge${r.kind === "many-to-many" ? " m2m" : ""}${r.found.includes("migration") || r.found.includes("database") ? "" : " model-only"}" points="${pts}" marker-start="url(#${startMarker})" marker-end="url(#${endMarker})"/>`);
    }
  }
  for (const e of laid.edges ?? []) {
    const lab = e.labels?.[0];
    if (!lab || lab.x === undefined || lab.y === undefined) continue;
    const r = edges[Number(e.id.slice(1))];
    const text = r.via ? `via ${r.via}` : r.column ?? "";
    out.push(`<rect class="edge-label-bg" x="${round(lab.x)}" y="${round(lab.y)}" width="${lab.width}" height="${lab.height}" rx="3"/>`);
    out.push(`<text class="erd-label" x="${round(lab.x + lab.width / 2)}" y="${round(lab.y + 11)}" text-anchor="middle">${esc(text)}</text>`);
  }
  for (const n of laid.children ?? []) {
    const t = g.tables.find((x) => id(x.name) === n.id)!;
    const x = round(n.x ?? 0);
    const y = round(n.y ?? 0);
    const w = n.width ?? 0;
    const h = n.height ?? 0;
    out.push(`<g class="erd-table${t.known ? "" : " unknown"}"><title>${esc(t.name)}${t.model ? ` (${t.model})` : ""}${t.known ? "" : " · not in the migrations"}</title>`);
    out.push(`<rect class="erd-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`);
    out.push(`<path class="erd-head" d="M${x} ${y + 6} Q${x} ${y} ${x + 6} ${y} H${x + w - 6} Q${x + w} ${y} ${x + w} ${y + 6} V${y + HEAD} H${x} Z"/>`);
    out.push(`<text class="erd-name" x="${round(x + 10)}" y="${round(y + 17)}">${esc(t.name)}</text>`);
    t.columns.forEach((c, i) => {
      const cy = y + HEAD + 13 + i * ROW;
      if (c.mark) out.push(`<text class="erd-key" x="${round(x + 10)}" y="${round(cy)}">${c.mark}</text>`);
      out.push(`<text class="erd-col${c.mark ? " key" : ""}" x="${round(x + 34)}" y="${round(cy)}">${esc(c.name)}</text>`);
      if (c.type) out.push(`<text class="erd-type" x="${round(x + w - 10)}" y="${round(cy)}" text-anchor="end">${esc(c.type)}</text>`);
    });
    if (t.more) out.push(`<text class="erd-more" x="${round(x + 34)}" y="${round(y + HEAD + 13 + t.columns.length * ROW)}">+${t.more} more column${t.more === 1 ? "" : "s"}</text>`);
    if (!t.columns.length && !t.more) out.push(`<text class="erd-more" x="${round(x + 10)}" y="${round(y + HEAD + 13)}">columns not in the migrations</text>`);
    out.push("</g>");
  }
  out.push("</svg>");
  return out.join("");
}
