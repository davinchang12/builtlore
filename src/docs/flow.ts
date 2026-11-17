/**
 * Flowcharts for the docs, from what the code says (no invented steps):
 *   - processFlow: who does what, as swimlanes; arrows carry the status in between
 *   - screenFlow:  a feature's screens and actions, where each leads, and failure branches
 *   - areaMap:     how the areas of the app link to each other
 * Rendered as Mermaid flowcharts (Markdown) and as static SVG laid out by ELK (HTML).
 */
import { createRequire } from "node:module";
import type { MapNode } from "../core/types.js";
import { NEGATIVE, type DocFeature, type DocModel, type DocProcess } from "./model.js";

const require = createRequire(import.meta.url);

export type FlowNodeKind = "page" | "action" | "start" | "end" | "external" | "area";

export interface FlowNode {
  id: string;
  label: string;
  kind: FlowNodeKind;
  /** Swimlane (process flows). */
  lane?: string;
  negative?: boolean;
  /** Smaller second line ("POST /orders", "12 screens"). */
  sub?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  kind: "go" | "error" | "ajax" | "status";
  negative?: boolean;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  lanes?: Array<{ id: string; name: string }>;
  direction: "RIGHT" | "DOWN";
}

const MAX_NODES = 40;
/** Above this many arrows a swimlane stops helping. */
const MAX_LANE_EDGES = 36;

// ------------------------------------------------------------- process flow

/** Who does what, in order: one lane per role, steps linked by the status one leaves and the next needs. */
export function processFlow(p: DocProcess): FlowGraph | null {
  const ts = [...p.transitions, ...p.other];
  if (!ts.length) return null;
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const lanes = new Map<string, string>();
  for (const t of ts) {
    if (nodes.some((n) => n.id === `step|${t.node.id}`)) continue;
    lanes.set(t.lane.id, t.lane.name);
    nodes.push({ id: `step|${t.node.id}`, label: t.node.label, kind: "action", lane: t.lane.id });
  }
  const fromsOf = (t: (typeof ts)[number]) => [...t.from, ...t.pathFrom.flat()].map((s) => s.id);
  const ends = new Map<string, string>();
  for (const t of ts) {
    // A new record starts here
    if (t.step.creates) edges.push({ from: "start", to: `step|${t.node.id}`, kind: "go" });
    for (const st of t.to) {
      const next = ts.filter((c) => c !== t && fromsOf(c).includes(st.id));
      const negative = NEGATIVE.test(st.label) || NEGATIVE.test(st.value);
      if (next.length) {
        for (const c of next) {
          if (edges.some((e) => e.from === `step|${t.node.id}` && e.to === `step|${c.node.id}` && e.label === st.label)) continue;
          edges.push({ from: `step|${t.node.id}`, to: `step|${c.node.id}`, label: st.label, kind: "status", negative });
        }
      } else {
        // Nothing follows: the record ends in this status
        let end = ends.get(st.id);
        if (!end) {
          end = `end|${st.id}`;
          ends.set(st.id, end);
          nodes.push({ id: end, label: st.label, kind: "end", negative });
        }
        edges.push({ from: `step|${t.node.id}`, to: end, kind: "status", negative });
      }
    }
  }
  if (edges.some((e) => e.from === "start")) nodes.unshift({ id: "start", label: "", kind: "start" });
  if (!edges.length) return null;
  // One arrow per pair of boxes: several statuses between the same two steps read "A +2"
  const merged: FlowEdge[] = [];
  for (const e of edges) {
    const same = merged.find((x) => x.from === e.from && x.to === e.to);
    if (!same) merged.push({ ...e, ...(e.label ? { label: e.label } : {}) });
    else if (e.label && same.label && !same.label.split(" +")[0].includes(e.label)) {
      const [first, more] = same.label.split(" +");
      same.label = `${first} +${(Number(more) || 0) + 1}`;
      same.negative = same.negative && e.negative;
    }
  }
  // Too many arrows to read as a picture: the numbered steps above say it better
  if (merged.length > MAX_LANE_EDGES) return null;
  // Steps that leave the status as it is are listed in the text, not drawn floating
  const used = new Set(merged.flatMap((e) => [e.from, e.to]));
  const shown = nodes.filter((n) => used.has(n.id));
  const shownLanes = [...lanes].filter(([id]) => shown.some((n) => n.lane === id)).map(([id, name]) => ({ id, name }));
  return { nodes: shown, edges: merged, lanes: shownLanes, direction: "RIGHT" };
}

// ------------------------------------------------------------- screen flow

/**
 * A feature's screens and actions: page → (link, form, AJAX) → action → (redirect) → page,
 * with failure branches dashed. Data endpoints (JSON for tables and dropdowns) are left out.
 */
export function screenFlow(m: DocModel, f: DocFeature): FlowGraph | null {
  const shown = f.nodes.filter((n) => n.type !== "data");
  if (shown.length < 2) return null;
  const inFeature = new Set(shown.map((n) => n.id));
  const nodes: FlowNode[] = shown.map((n) => ({ id: n.id, label: n.label, kind: n.type === "page" ? "page" : "action", sub: endpointShort(n) }));
  const edges: FlowEdge[] = [];
  const external = new Map<string, FlowNode>();
  for (const e of m.map.edges) {
    if (!inFeature.has(e.from) || e.from === e.to) continue;
    if (!["link", "submit", "redirect", "ajax"].includes(e.trigger)) continue;
    let to = e.to;
    if (!inFeature.has(to)) {
      const target = m.map.nodes.find((n) => n.id === to);
      if (!target || target.hidden || target.type === "data") continue;
      // Leaving the feature: one small node per target
      if (!external.has(to)) {
        const fname = m.map.features.find((x) => x.id === target.feature)?.name ?? target.feature;
        external.set(to, { id: to, label: `${fname} › ${target.label}`, kind: "external" });
      }
      to = e.to;
    }
    const kind: FlowEdge["kind"] = e.outcome === "error" ? "error" : e.trigger === "ajax" ? "ajax" : "go";
    if (edges.some((x) => x.from === e.from && x.to === to && x.kind === kind)) continue;
    edges.push({ from: e.from, to, kind, label: e.outcome === "error" ? "fails" : undefined });
  }
  const ext = [...external.values()].slice(0, 8);
  const tidy = (ns: FlowNode[], es: FlowEdge[]): FlowGraph | null => {
    const ids = new Set(ns.map((n) => n.id));
    const kept = es.filter((e) => ids.has(e.from) && ids.has(e.to));
    const used = new Set(kept.flatMap((e) => [e.from, e.to]));
    const shownNodes = ns.filter((n) => used.has(n.id));
    return kept.length && shownNodes.length <= MAX_NODES ? { nodes: shownNodes, edges: kept, direction: "RIGHT" } : null;
  };
  const full = tidy([...nodes, ...ext], edges);
  if (full && full.nodes.length <= SCREEN_MAX) return full;
  // Busier: only which actions each screen offers (no redirects back, no other features)
  const pageIds = new Set(nodes.filter((n) => n.kind === "page").map((n) => n.id));
  const lean = tidy(nodes, edges.filter((e) => pageIds.has(e.from) && e.kind !== "error" && !pageIds.has(e.to)));
  // Too busy to read as a picture: the docs list it instead
  return lean && lean.nodes.length <= SCREEN_MAX ? lean : null;
}

/** Above this many boxes a screen diagram stops helping; the page lists where each screen leads instead. */
const SCREEN_MAX = 16;

function endpointShort(n: MapNode): string {
  return `${n.methods.filter((x) => x !== "HEAD").join("|")} /${n.uri.replace(/^\//, "")}`;
}

// ------------------------------------------------------------- area map

/** "Application", "Infrastructure", "Master": the part of a feature name before "›". */
export function areaOf(name: string): string {
  return name.includes(" › ") ? name.split(" › ")[0] : name;
}

/** How the areas of the app link to each other (links, forms, redirects between their screens). */
export function areaMap(m: DocModel): FlowGraph | null {
  const areaByNode = new Map<string, string>();
  const size = new Map<string, number>();
  for (const f of m.features) {
    const a = areaOf(f.feature.name);
    size.set(a, (size.get(a) ?? 0) + f.nodes.filter((n) => n.type === "page").length);
    for (const n of f.nodes) areaByNode.set(n.id, a);
  }
  const counts = new Map<string, number>();
  for (const e of m.map.edges) {
    if (!["link", "submit", "redirect"].includes(e.trigger)) continue;
    const a = areaByNode.get(e.from);
    const b = areaByNode.get(e.to);
    if (!a || !b || a === b) continue;
    counts.set(`${a}\u0000${b}`, (counts.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  const linked = new Set([...counts.keys()].flatMap((k) => k.split("\u0000")));
  if (!linked.size) return null;
  const nodes: FlowNode[] = [...linked].map((a) => ({ id: `area|${a}`, label: a, kind: "area", sub: `${size.get(a) ?? 0} screen${size.get(a) === 1 ? "" : "s"}` }));
  const edges: FlowEdge[] = [...counts].map(([k, n]) => {
    const [a, b] = k.split("\u0000");
    return { from: `area|${a}`, to: `area|${b}`, kind: "go", label: n > 1 ? `${n} links` : undefined };
  });
  if (nodes.length > MAX_NODES) return null;
  return { nodes, edges, direction: "RIGHT" };
}

// ------------------------------------------------------------- Mermaid

function mm(s: string): string {
  return s.replace(/["<>{}[\]|#;]/g, (c) => ({ '"': "'", "<": "‹", ">": "›", "{": "(", "}": ")", "[": "(", "]": ")", "|": "/", "#": "No.", ";": "," })[c]!).replace(/\s+/g, " ").trim();
}

export function flowMermaid(g: FlowGraph): string {
  const id = new Map<string, string>();
  g.nodes.forEach((n, i) => id.set(n.id, `n${i}`));
  const shape = (n: FlowNode) => {
    const text = mm(n.label) || " ";
    switch (n.kind) {
      case "start": return `${id.get(n.id)}(( ))`;
      case "end": return `${id.get(n.id)}([${JSON.stringify(text)}])`;
      case "page": return `${id.get(n.id)}[${JSON.stringify(text)}]`;
      case "external": return `${id.get(n.id)}>${JSON.stringify(text)}]`;
      case "area": return `${id.get(n.id)}[${JSON.stringify(n.sub ? `${text} · ${n.sub}` : text)}]`;
      default: return `${id.get(n.id)}(${JSON.stringify(text)})`;
    }
  };
  const lines = [`flowchart ${g.direction === "DOWN" ? "TD" : "LR"}`];
  if (g.lanes?.length) {
    for (const n of g.nodes.filter((x) => !x.lane)) lines.push(`  ${shape(n)}`);
    g.lanes.forEach((l, i) => {
      lines.push(`  subgraph L${i}[${JSON.stringify(mm(l.name))}]`);
      for (const n of g.nodes.filter((x) => x.lane === l.id)) lines.push(`    ${shape(n)}`);
      lines.push("  end");
    });
  } else for (const n of g.nodes) lines.push(`  ${shape(n)}`);
  g.edges.forEach((e) => {
    const a = id.get(e.from);
    const b = id.get(e.to);
    if (!a || !b) return;
    const arrow = e.kind === "error" || e.negative ? "-.->" : e.kind === "ajax" ? "-.->" : "-->";
    lines.push(`  ${a} ${arrow}${e.label ? `|${JSON.stringify(mm(e.label))}|` : ""} ${b}`);
  });
  const ends = g.nodes.filter((n) => n.kind === "end").map((n) => id.get(n.id));
  const negEnds = g.nodes.filter((n) => n.kind === "end" && n.negative).map((n) => id.get(n.id));
  const actions = g.nodes.filter((n) => n.kind === "action").map((n) => id.get(n.id));
  if (actions.length) lines.push("  classDef action fill:#fff7ed,stroke:#d97706", `  class ${actions.join(",")} action`);
  if (ends.length) lines.push("  classDef done fill:#ecfdf5,stroke:#059669", `  class ${ends.join(",")} done`);
  if (negEnds.length) lines.push("  classDef stop fill:#fef2f2,stroke:#dc2626", `  class ${negEnds.join(",")} stop`);
  return lines.join("\n");
}

// ------------------------------------------------------------- SVG

interface ElkShape {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkShape[];
  edges?: ElkEdgeOut[];
}
interface ElkEdgeOut {
  id: string;
  labels?: Array<{ text: string; width: number; height: number; x?: number; y?: number }>;
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
}

let elkInstance: { layout(g: unknown): Promise<ElkShape & { width: number; height: number }> } | null = null;
function elk() {
  if (!elkInstance) {
    const ELK = require("elkjs/lib/elk.bundled.js");
    elkInstance = new ELK();
  }
  return elkInstance!;
}

const CHAR_W = 6.6;
const PAGE_W = 860;
const MAX_H = 1100;
const LANE_LABEL_W = 120;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function wrap(text: string, max: number, lines = 3): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + " " + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = `${out[lines - 1].slice(0, max - 1)}…`;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Swimlanes drawn by builtlore itself (a general layout engine puts lanes side by side):
 * columns follow the order of the flow, one row band per role, forward arrows as
 * curves, arrows back to an earlier column routed under the cards, one label per status and target.
 */
function laneSvg(g: FlowGraph, title: string, uid: string): string {
  const NODE_H = 46;
  const GAP_Y = 14;
  const GAP_X = 92;
  const PAD = 14;
  const LABEL_W = 124;
  const ids = g.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const inc = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of g.edges) {
    out.get(e.from)?.push(e.to);
    inc.get(e.to)?.push(e.from);
  }
  // Columns: longest path from the sources, ignoring edges that close a loop
  const order: string[] = [];
  const state = new Map<string, number>();
  const back = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
    order.unshift(id);
  };
  for (const id of ["start", ...ids]) if (out.has(id) && !state.get(id) && !(inc.get(id) ?? []).length) visit(id);
  for (const id of ids) if (!state.get(id)) visit(id);
  const col = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of order) for (const t of out.get(id) ?? []) if (!back.has(`${id}>${t}`)) col.set(t, Math.max(col.get(t)!, col.get(id)! + 1));
  // Start dots and end pills sit in the lane of the step next to them
  const laneOf = new Map<string, string>();
  for (const n of g.nodes) if (n.lane) laneOf.set(n.id, n.lane);
  for (const n of g.nodes) {
    if (n.lane) continue;
    const near = n.kind === "start" ? (out.get(n.id) ?? [])[0] : (inc.get(n.id) ?? [])[0];
    laneOf.set(n.id, (near && laneOf.get(near)) ?? g.lanes![0].id);
  }
  const lanes = [...g.lanes!].sort((a, b) => {
    const first = (l: string) => Math.min(...ids.filter((id) => laneOf.get(id) === l).map((id) => col.get(id)!));
    return first(a.id) - first(b.id);
  });
  const textOf = new Map(g.nodes.map((n) => [n.id, n.kind === "start" ? [] : wrap(n.label, n.kind === "end" ? 18 : 20, 2)]));
  const widthOf = (n: FlowNode) => (n.kind === "start" ? 16 : Math.max(n.kind === "end" ? 80 : 120, Math.round(Math.max(...textOf.get(n.id)!.map((l) => l.length)) * CHAR_W + 30)));
  const cols = Math.max(...[...col.values()]) + 1;
  const colW = Array.from({ length: cols }, (_, c) => Math.max(16, ...g.nodes.filter((n) => col.get(n.id) === c).map(widthOf)));
  const colX: number[] = [];
  let x = LABEL_W + PAD;
  for (let c = 0; c < cols; c++) {
    colX.push(x);
    x += colW[c] + GAP_X;
  }
  const W = Math.ceil(x - GAP_X + PAD);
  // Rows: cards of a lane in the same column stack
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>();
  const bands: Array<{ name: string; y: number; h: number }> = [];
  let y = PAD;
  for (const l of lanes) {
    const mine = g.nodes.filter((n) => laneOf.get(n.id) === l.id);
    const slots = new Map<number, number>();
    for (const n of mine) {
      const c = col.get(n.id)!;
      const k = slots.get(c) ?? 0;
      slots.set(c, k + 1);
      const w = widthOf(n);
      const h = n.kind === "start" ? 16 : NODE_H;
      pos.set(n.id, { x: colX[c] + (colW[c] - w) / 2, y: y + PAD + k * (NODE_H + GAP_Y) + (NODE_H - h) / 2, w, h });
    }
    const rows = Math.max(1, ...slots.values());
    const h = rows * NODE_H + (rows - 1) * GAP_Y + PAD * 2;
    bands.push({ name: l.name, y, h });
    y += h;
  }
  let H = y + PAD;
  const parts: string[] = [];
  const edgeParts: string[] = [];
  const labelParts: string[] = [];
  // Edges
  const labelled = new Set<string>();
  const stacked = new Map<string, number>(); // labels already placed in front of a card
  let under = 0;
  const bottom = y;
  for (const e of g.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const neg = e.kind === "error" || e.negative;
    const cls = neg ? "edge neg" : "edge";
    const marker = `${uid}-${neg ? "neg" : "arr"}`;
    let d: string;
    let lx: number;
    let ly: number;
    if (b.x > a.x + a.w) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, k = Math.max(30, (x2 - x1) / 2);
      d = `M${round(x1)} ${round(y1)} C${round(x1 + k)} ${round(y1)} ${round(x2 - k)} ${round(y2)} ${round(x2 - 2)} ${round(y2)}`;
      lx = x2 - GAP_X / 2;
      ly = y2 - 13;
    } else {
      // Back to an earlier (or the same) column: under all lanes
      const low = bottom + 10 + under * 9;
      under++;
      const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2;
      d = `M${round(x1)} ${round(a.y + a.h)} L${round(x1)} ${round(low)} L${round(x2)} ${round(low)} L${round(x2)} ${round(b.y + b.h + 2)}`;
      lx = (x1 + x2) / 2;
      ly = low - 5;
      H = Math.max(H, low + 16);
    }
    edgeParts.push(`<path class="${cls}" d="${d}" fill="none" marker-end="url(#${marker})"/>`);
    // One label per status and target; several statuses into one card stack upwards
    const key = `${e.to}|${e.label}`;
    if (!e.label || labelled.has(key)) continue;
    labelled.add(key);
    if (b.x > a.x + a.w) {
      const k = stacked.get(e.to) ?? 0;
      stacked.set(e.to, k + 1);
      ly = Math.max(12, ly - k * 17);
    }
    const text = e.label.length > 26 ? `${e.label.slice(0, 25)}…` : e.label;
    const lw = Math.round(text.length * 5.8 + 10);
    labelParts.push(`<rect class="edge-label-bg" x="${round(lx - lw / 2)}" y="${round(ly - 9)}" width="${lw}" height="15" rx="3"/>`);
    labelParts.push(`<text class="edge-text${neg ? " neg" : ""}" x="${round(lx)}" y="${round(ly + 2)}" text-anchor="middle">${esc(text)}</text>`);
  }
  parts.push(`<svg class="flow lanes${W > 1200 ? " wide" : ""}" viewBox="0 0 ${W} ${Math.ceil(H)}" width="${W}" height="${Math.ceil(H)}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(
    `<defs><marker id="${uid}-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>` +
      `<marker id="${uid}-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow neg"/></marker></defs>`,
  );
  bands.forEach((b, i) => {
    parts.push(`<rect class="lane${i % 2 ? " alt" : ""}" x="2" y="${round(b.y)}" width="${W - 4}" height="${round(b.h)}"/>`);
    const lines = wrap(b.name, 16, 3);
    lines.forEach((line, j) => parts.push(`<text class="lane-name" x="12" y="${round(b.y + b.h / 2 - (lines.length - 1) * 7 + 4 + j * 14)}">${esc(line)}</text>`));
  });
  parts.push(...edgeParts);
  for (const n of g.nodes) {
    const p = pos.get(n.id)!;
    if (n.kind === "start") {
      parts.push(`<circle class="start" cx="${round(p.x + 8)}" cy="${round(p.y + 8)}" r="7"><title>Start</title></circle>`);
      continue;
    }
    const cls = `node ${n.kind}${n.negative ? " neg" : ""}`;
    parts.push(`<rect class="${cls}" x="${round(p.x)}" y="${round(p.y)}" width="${p.w}" height="${p.h}" rx="${n.kind === "end" ? p.h / 2 : 10}"/>`);
    if (n.kind === "action") parts.push(`<rect class="node-bar" x="${round(p.x + 5)}" y="${round(p.y + 7)}" width="4" height="${p.h - 14}" rx="2"/>`);
    const lines = textOf.get(n.id)!;
    lines.forEach((l, j) => parts.push(`<text class="node-text" x="${round(p.x + p.w / 2 + (n.kind === "action" ? 3 : 0))}" y="${round(p.y + p.h / 2 - (lines.length - 1) * 7.5 + 4 + j * 15)}" text-anchor="middle">${esc(l)}</text>`));
  }
  parts.push(...labelParts);
  parts.push("</svg>");
  return parts.join("");
}

/** Laid-out SVG of a flowchart; plain markup, styled by the docs stylesheet. */
export async function flowSvg(g: FlowGraph, title: string, uid: string): Promise<string> {
  if (g.lanes?.length) return laneSvg(g, title, uid);
  const textOf = new Map(g.nodes.map((n) => [n.id, n.kind === "start" ? [] : wrap(n.label, n.kind === "end" ? 18 : 22)]));
  const size = (n: FlowNode) => {
    if (n.kind === "start") return { width: 16, height: 16 };
    const lines = textOf.get(n.id)!;
    const sub = n.sub ? [n.sub.length > 34 ? `${n.sub.slice(0, 33)}…` : n.sub] : [];
    const w = Math.max(...lines.map((l) => l.length), ...sub.map((s) => s.length * 0.85)) * CHAR_W + 26;
    return { width: Math.max(n.kind === "end" ? 70 : 104, Math.round(w)), height: 14 + lines.length * 15 + (sub.length ? 13 : 0) };
  };
  const edgeText = g.edges.map((e) => (e.label ? wrap(e.label, 22, 2) : []));
  const elkEdges = g.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.from],
    targets: [e.to],
    ...(edgeText[i].length ? { labels: [{ text: edgeText[i].join("\n"), width: Math.round(Math.max(...edgeText[i].map((l) => l.length)) * 6 + 10), height: edgeText[i].length * 13 + 4 }] } : {}),
  }));
  const options = (direction: string) => ({
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.json.edgeCoords": "ROOT",
    "elk.json.shapeCoords": "ROOT",
    "elk.layered.spacing.nodeNodeBetweenLayers": "56",
    "elk.spacing.nodeNode": "26",
    "elk.spacing.edgeLabel": "4",
    "elk.spacing.edgeEdge": "12",
    "elk.edgeLabels.placement": "CENTER",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.padding": "[top=12,left=12,bottom=12,right=12]",
  });
  const build = (direction: string) => {
    const loose = g.nodes.filter((n) => !n.lane).map((n) => ({ id: n.id, ...size(n) }));
    const lanes = (g.lanes ?? []).map((l) => ({
      id: `lane|${l.id}`,
      layoutOptions: { "elk.padding": `[top=14,left=${LANE_LABEL_W},bottom=14,right=16]`, "elk.direction": direction },
      children: g.nodes.filter((n) => n.lane === l.id).map((n) => ({ id: n.id, ...size(n) })),
    }));
    // A fresh copy each time: ELK writes the routes into the objects it is given
    return structuredClone({ id: "root", layoutOptions: options(direction), children: [...loose, ...lanes], edges: elkEdges });
  };
  const right = await elk().layout(build(g.direction));
  let laid = right;
  if (!g.lanes?.length && right.width > PAGE_W) {
    const down = await elk().layout(build("DOWN"));
    const scale = (l: { width: number; height: number }) => Math.min(1, PAGE_W / l.width, MAX_H / l.height);
    if (scale(down) > scale(right) * 1.15) laid = down;
  }

  const W = Math.ceil(laid.width);
  const H = Math.ceil(laid.height);
  const out: string[] = [];
  out.push(`<svg class="flow" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`);
  out.push(
    `<defs><marker id="${uid}-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>` +
      `<marker id="${uid}-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow neg"/></marker></defs>`,
  );
  // Lanes: full-width bands with the role on the left
  const laneShapes = (laid.children ?? []).filter((c) => c.id.startsWith("lane|"));
  laneShapes
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0))
    .forEach((l, i) => {
      const name = g.lanes!.find((x) => `lane|${x.id}` === l.id)?.name ?? "";
      out.push(`<rect class="lane${i % 2 ? " alt" : ""}" x="${round(l.x ?? 0)}" y="${round(l.y ?? 0)}" width="${round(W - (l.x ?? 0) - 4)}" height="${round(l.height ?? 0)}" rx="6"/>`);
      wrap(name, 16, 3).forEach((line, j, arr) => {
        out.push(`<text class="lane-name" x="${round((l.x ?? 0) + 10)}" y="${round((l.y ?? 0) + (l.height ?? 0) / 2 - (arr.length - 1) * 7 + 4 + j * 14)}">${esc(line)}</text>`);
      });
    });
  const shapes = new Map<string, ElkShape>();
  const collect = (list: ElkShape[] = []) => {
    for (const s of list) {
      shapes.set(s.id, s);
      collect(s.children);
    }
  };
  collect(laid.children);
  // Edges may come back on the root or on a lane (where both ends sit); coordinates are root-relative
  const laidEdges: ElkEdgeOut[] = [...(laid.edges ?? []), ...laneShapes.flatMap((l) => l.edges ?? [])];
  for (const le of laidEdges) {
    const i = Number(le.id.slice(1));
    const meta = g.edges[i];
    const cls = meta.kind === "error" || meta.negative ? "edge neg" : meta.kind === "ajax" ? "edge ajax" : "edge";
    const marker = `${uid}-${meta.kind === "error" || meta.negative ? "neg" : "arr"}`;
    for (const s of le.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
      out.push(`<polyline class="${cls}" points="${pts}" marker-end="url(#${marker})"/>`);
    }
  }
  for (const le of laidEdges) {
    const i = Number(le.id.slice(1));
    const lab = le.labels?.[0];
    if (!lab || lab.x === undefined || lab.y === undefined) continue;
    const meta = g.edges[i];
    out.push(`<rect class="edge-label-bg" x="${round(lab.x)}" y="${round(lab.y)}" width="${lab.width}" height="${lab.height}" rx="3"/>`);
    edgeText[i].forEach((l, j) => {
      out.push(`<text class="edge-text${meta.kind === "error" || meta.negative ? " neg" : ""}" x="${round(lab.x! + lab.width / 2)}" y="${round(lab.y! + 12 + j * 13)}" text-anchor="middle">${esc(l)}</text>`);
    });
  }
  for (const n of g.nodes) {
    const s = shapes.get(n.id);
    if (!s) continue;
    const x = round(s.x ?? 0);
    const y = round(s.y ?? 0);
    const w = s.width ?? 0;
    const h = s.height ?? 0;
    if (n.kind === "start") {
      out.push(`<circle class="start" cx="${x + 8}" cy="${y + 8}" r="7"><title>Start</title></circle>`);
      continue;
    }
    const cls = `node ${n.kind}${n.negative ? " neg" : ""}`;
    const rx = n.kind === "end" ? h / 2 : n.kind === "action" ? 10 : 4;
    out.push(`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`);
    if (n.kind === "action") out.push(`<rect class="node-bar" x="${x + 5}" y="${y + 6}" width="4" height="${round(h - 12)}" rx="2"/>`);
    const lines = textOf.get(n.id)!;
    const cx = round(x + w / 2 + (n.kind === "action" ? 3 : 0));
    lines.forEach((l, j) => out.push(`<text class="node-text" x="${cx}" y="${round(y + 18 + j * 15)}" text-anchor="middle">${esc(l)}</text>`));
    if (n.sub) out.push(`<text class="node-sub" x="${cx}" y="${round(y + 18 + lines.length * 15 - 1)}" text-anchor="middle">${esc(n.sub.length > 34 ? `${n.sub.slice(0, 33)}…` : n.sub)}</text>`);
  }
  out.push("</svg>");
  return out.join("");
}
