/**
 * Status lifecycle of a process as a graph, rendered two ways:
 *   - Mermaid stateDiagram-v2 for the Markdown docs (GitHub/GitLab render it)
 *   - static SVG laid out with ELK for the HTML docs (offline, prints well)
 * Only transitions found in code are drawn. A step whose starting status the
 * code does not check starts from "Any status (not checked in code)".
 */
import { createRequire } from "node:module";
import { NEGATIVE, type DocProcess } from "./model.js";

const require = createRequire(import.meta.url);

export interface GraphNode {
  id: string;
  label: string;
  kind: "start" | "state" | "any";
  final?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  who?: string;
  negative: boolean;
  background: boolean;
}

export interface StateGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function stateGraph(p: DocProcess): StateGraph {
  const ids = new Map<string, string>();
  const nodes: GraphNode[] = [];
  const stateNode = (stateId: string, label: string) => {
    let id = ids.get(stateId);
    if (!id) {
      id = `s${ids.size}`;
      ids.set(stateId, id);
      nodes.push({ id, label, kind: "state" });
    }
    return id;
  };
  const edges: GraphEdge[] = [];
  let start = false;
  let any = false;
  const push = (e: GraphEdge) => {
    if (!edges.some((x) => x.from === e.from && x.to === e.to && x.label === e.label)) edges.push(e);
  };

  for (const t of p.transitions) {
    const label = t.node.label;
    const negative = NEGATIVE.test(label) || t.to.some((s) => NEGATIVE.test(s.label));
    const sources: string[] = [];
    if (t.step.creates) {
      start = true;
      sources.push("start");
    }
    for (const f of t.from) sources.push(stateNode(f.id, f.label));
    if (!sources.length) {
      any = true;
      sources.push("any");
    }
    for (const to of t.to) {
      const target = stateNode(to.id, to.label);
      for (const s of sources) push({ from: s, to: target, label, who: t.lane.name, negative, background: false });
    }
  }
  for (const b of p.background) {
    const label = b.schedule ? `${b.by} (${b.schedule.charAt(0).toLowerCase()}${b.schedule.slice(1)})` : b.by;
    const sources = b.from.length ? b.from.map((f) => stateNode(f.id, f.label)) : ["any"];
    if (!b.from.length) any = true;
    for (const to of b.to) for (const s of sources) push({ from: s, to: stateNode(to.id, to.label), label, who: "automatic", negative: false, background: true });
  }
  if (start) nodes.unshift({ id: "start", label: "", kind: "start" });
  if (any) nodes.push({ id: "any", label: "Any status (not checked in code)", kind: "any" });
  const hasOut = new Set(edges.map((e) => e.from));
  for (const n of nodes) if (n.kind === "state" && !hasOut.has(n.id)) n.final = true;
  return { nodes, edges };
}

// --------------------------------------------------------------- Mermaid

function mm(s: string): string {
  return s.replace(/[:;#"<>{}[\]]/g, (c) => ({ ":": " -", ";": ",", "#": "No.", '"': "'", "<": "â€¹", ">": "â€º", "{": "(", "}": ")", "[": "(", "]": ")" })[c]!).replace(/\s+/g, " ").trim();
}

export function mermaid(g: StateGraph): string {
  const lines = ["stateDiagram-v2", "  direction LR"];
  for (const n of g.nodes) {
    if (n.kind === "start") continue;
    if (n.kind === "any") lines.push(`  state "${mm(n.label)}" as any`);
    else lines.push(`  ${n.id} : ${mm(n.label)}`);
  }
  for (const e of g.edges) {
    const from = e.from === "start" ? "[*]" : e.from;
    const who = e.who && !e.background ? ` (${e.who})` : "";
    lines.push(`  ${from} --> ${e.to} : ${mm(e.label + who)}`);
  }
  if (g.nodes.some((n) => n.kind === "any")) lines.push("  classDef anyStatus stroke-dasharray: 4 3", "  class any anyStatus");
  return lines.join("\n");
}

// --------------------------------------------------------------- SVG

interface ElkNode {
  id: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}
interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: Array<{ text: string; width: number; height: number; x?: number; y?: number }>;
  sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>;
}

let elkInstance: { layout(g: unknown): Promise<{ width: number; height: number; children: ElkNode[]; edges: ElkEdge[] }> } | null = null;
function elk() {
  if (!elkInstance) {
    const ELK = require("elkjs/lib/elk.bundled.js");
    elkInstance = new ELK();
  }
  return elkInstance!;
}

const CHAR_W = 6.6;
/** Width of the text column (and roughly of an A4 page), and a height that still fits on one page. */
const PAGE_W = 860;
const MAX_H = 900;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Laid-out SVG of the state graph; plain markup, styled by the docs stylesheet. */
export async function stateSvg(g: StateGraph, title: string, uid: string): Promise<string> {
  const nodeLines = new Map(g.nodes.map((n) => [n.id, n.kind === "start" ? [] : wrap(n.label, n.kind === "any" ? 18 : 22)]));
  const edgeLines = g.edges.map((e) => [...wrap(e.label, 26), ...(e.who ? [e.background ? "automatic" : `by ${e.who}`] : [])]);
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      "elk.spacing.nodeNode": "36",
      "elk.spacing.edgeLabel": "6",
      "elk.spacing.edgeEdge": "14",
      "elk.layered.spacing.edgeNodeBetweenLayers": "16",
      "elk.edgeLabels.placement": "CENTER",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
    },
    children: g.nodes.map((n) => {
      if (n.kind === "start") return { id: n.id, width: 16, height: 16 };
      const lines = nodeLines.get(n.id)!;
      const w = Math.max(...lines.map((l) => l.length)) * CHAR_W + 28;
      return { id: n.id, width: Math.max(96, Math.round(w)), height: 18 + lines.length * 15 };
    }),
    edges: g.edges.map((e, i) => {
      const lines = edgeLines[i];
      return {
        id: `e${i}`,
        sources: [e.from],
        targets: [e.to],
        labels: [{ text: lines.join("\n"), width: Math.round(Math.max(...lines.map((l) => l.length)) * 6 + 10), height: lines.length * 13 + 6 }],
      };
    }),
  };
  // Long lifecycles get too wide left to right; use top to bottom when it reads larger on a page.
  const right = await elk().layout(structuredClone(graph));
  let laid = right;
  if (right.width > PAGE_W) {
    const down = await elk().layout({ ...structuredClone(graph), layoutOptions: { ...graph.layoutOptions, "elk.direction": "DOWN" } });
    const scale = (l: { width: number; height: number }) => Math.min(1, PAGE_W / l.width, MAX_H / l.height);
    if (scale(down) > scale(right) * 1.15) laid = down;
  }
  const W = Math.ceil(laid.width);
  const H = Math.ceil(laid.height);
  const parts: string[] = [];
  parts.push(`<svg class="lifecycle" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(
    `<defs><marker id="${uid}-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker>` +
      `<marker id="${uid}-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow neg"/></marker>` +
      `<marker id="${uid}-bg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow bg"/></marker></defs>`,
  );
  laid.edges.forEach((e, i) => {
    const meta = g.edges[i];
    const cls = meta.background ? "edge bg" : meta.negative ? "edge neg" : "edge";
    const marker = `${uid}-${meta.background ? "bg" : meta.negative ? "neg" : "arr"}`;
    for (const s of e.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
      parts.push(`<polyline class="${cls}" points="${pts}" marker-end="url(#${marker})"/>`);
    }
  });
  laid.edges.forEach((e, i) => {
    const lab = e.labels?.[0];
    if (!lab || lab.x === undefined || lab.y === undefined) return;
    const { x: lx, y: ly } = lab as { x: number; y: number };
    const lines = edgeLines[i];
    const meta = g.edges[i];
    parts.push(`<rect class="edge-label-bg" x="${round(lx)}" y="${round(ly)}" width="${lab.width}" height="${lab.height}" rx="3"/>`);
    lines.forEach((l, j) => {
      const isWho = meta.who && j === lines.length - 1;
      parts.push(`<text class="${isWho ? "edge-who" : "edge-text"}${meta.negative ? " neg" : ""}" x="${round(lx + lab.width / 2)}" y="${round(ly + 13 + j * 13)}" text-anchor="middle">${esc(l)}</text>`);
    });
  });
  for (const n of laid.children) {
    const meta = g.nodes.find((x) => x.id === n.id)!;
    const x = round(n.x ?? 0);
    const y = round(n.y ?? 0);
    if (meta.kind === "start") {
      parts.push(`<circle class="start" cx="${x + 8}" cy="${y + 8}" r="7"><title>New record</title></circle>`);
      continue;
    }
    const cls = meta.kind === "any" ? "state any" : meta.final ? "state final" : "state";
    parts.push(`<rect class="${cls}" x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="${meta.final ? n.height / 2 : 8}"/>`);
    const lines = nodeLines.get(n.id)!;
    lines.forEach((l, j) => {
      parts.push(`<text class="state-text${meta.kind === "any" ? " any" : ""}" x="${round(x + n.width / 2)}" y="${round(y + 9 + 12 + j * 15)}" text-anchor="middle">${esc(l)}</text>`);
    });
  }
  parts.push("</svg>");
  return parts.join("");
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
