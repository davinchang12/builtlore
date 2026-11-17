/**
 * Human edits: the part of the documentation that code cannot know.
 *
 * Scans always start from the code. Edits live in builtlore.edits.yaml (commit
 * it) and are applied on top of every scan, so a rescan never overwrites what
 * someone wrote. Each edit points at a stable id (a route name or METHOD + URI).
 * When the code behind an edited step changes, the step is flagged for review
 * instead of silently keeping an outdated note; when the step disappears, the
 * edit is kept and reported as orphaned.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { laneKey } from "./process.js";
import type { BuiltMap, Feature, MapNode } from "./types.js";

export const EDITS_FILE = "builtlore.edits.yaml";

export interface StepEdit {
  label?: string;
  description?: string;
  /** Move the step to another feature: an existing feature id or a new feature name. */
  feature?: string;
  hidden?: boolean;
  /** Who does this step in the business process (lane name). */
  actor?: string;
  /** Fingerprint of the code when the edit was made; used to flag changes. */
  code?: string;
}

export interface FeatureEdit {
  name?: string;
  description?: string;
}

export interface ProjectEdit {
  /** Display name for the system, e.g. "Procurement portal". */
  name?: string;
  /** What the system is for and who uses it; opens the documentation. */
  summary?: string;
}

export interface Edits {
  project: ProjectEdit;
  features: Record<string, FeatureEdit>;
  steps: Record<string, StepEdit>;
  glossary: Record<string, string>;
  /** Lane id -> display name, e.g. manager: Area manager */
  roles: Record<string, string>;
  /** Subject -> value -> label, e.g. PurchaseRequest.status: { "3": Approved by procurement } */
  statuses: Record<string, Record<string, string>>;
}

const HEADER = `# builtlore edits: names, descriptions and grouping written by people.
# builtlore applies this file on top of every scan; scans never overwrite it.
# Edit it here or in the canvas (builtlore serve). Commit it with your code.
`;

export function emptyEdits(): Edits {
  return { project: {}, features: {}, steps: {}, glossary: {}, roles: {}, statuses: {} };
}

export function loadEdits(root: string): Edits {
  const path = join(root, EDITS_FILE);
  if (!existsSync(path)) return emptyEdits();
  const parsed = YAML.parse(readFileSync(path, "utf8")) ?? {};
  const project = objectOf<unknown>(parsed.project);
  return {
    project: {
      ...(typeof project.name === "string" && project.name.trim() ? { name: project.name.trim() } : {}),
      ...(typeof project.summary === "string" && project.summary.trim() ? { summary: project.summary.trim() } : {}),
    },
    features: objectOf(parsed.features),
    steps: objectOf(parsed.steps),
    glossary: objectOf(parsed.glossary),
    roles: objectOf(parsed.roles),
    statuses: Object.fromEntries(Object.entries(objectOf<Record<string, unknown>>(parsed.statuses)).map(([k, v]) => [k, Object.fromEntries(Object.entries(objectOf<unknown>(v)).map(([a, b]) => [String(a), String(b)]))])),
  };
}

/** Fingerprint of what a step does in code (not where it is). */
export function codeFingerprint(n: Pick<MapNode, "methods" | "uri" | "handler" | "view" | "type">): string {
  const basis = [
    n.type,
    [...n.methods].sort().join("|"),
    n.uri,
    n.handler ? `${n.handler.class ?? n.handler.kind}@${n.handler.method ?? ""}` : "",
    n.view ? n.view.name : "",
  ].join("\n");
  return createHash("sha1").update(basis).digest("hex").slice(0, 10);
}

/** Apply edits to a freshly scanned map. Returns a new map; the input is not modified. */
export function applyEdits(raw: BuiltMap, edits: Edits): BuiltMap {
  const map: BuiltMap = JSON.parse(JSON.stringify(raw));
  const nodeIds = new Set(map.nodes.map((n) => n.id));
  const featureById = new Map(map.features.map((f) => [f.id, f]));
  const orphans: string[] = [];
  const changed: string[] = [];

  for (const [id, e] of Object.entries(edits.features)) {
    const f = featureById.get(id);
    if (!f) {
      orphans.push(`feature:${id}`);
      continue;
    }
    if (e.name) {
      f.name = e.name;
      f.provenance = "human";
    }
    if (e.description) f.description = e.description;
  }

  for (const [id, e] of Object.entries(edits.steps)) {
    if (!nodeIds.has(id)) {
      orphans.push(id);
      continue;
    }
    const n = map.nodes.find((x) => x.id === id)!;
    if (e.label) {
      n.label = e.label;
      n.provenance = "human";
    }
    if (e.description) n.description = e.description;
    if (e.hidden) n.hidden = true;
    if (e.code && e.code !== codeFingerprint(n) && (e.label || e.description)) {
      n.review = "The code behind this step changed after it was described. Check the name and description still fit.";
      changed.push(id);
    }
    if (e.feature && e.feature !== n.feature) {
      const target = resolveFeature(map, featureById, e.feature);
      const from = featureById.get(n.feature);
      if (from) from.nodes = from.nodes.filter((x) => x !== id);
      target.nodes.push(id);
      n.feature = target.id;
    }
  }

  // Features emptied by moves disappear; files are recomputed for moved steps.
  map.features = map.features.filter((f) => f.nodes.length);
  for (const f of map.features) {
    const ns = f.nodes.map((id) => map.nodes.find((n) => n.id === id)!).filter(Boolean);
    f.files = [...new Set(ns.flatMap((n) => [n.handler?.file, n.view?.file].filter((x): x is string => Boolean(x))))].sort();
  }
  map.features.sort((a, b) => a.name.localeCompare(b.name));

  if (Object.keys(edits.glossary).length) map.glossary = Object.fromEntries(Object.entries(edits.glossary).map(([k, v]) => [String(k), String(v)]));
  if (edits.project?.name) map.project.title = edits.project.name;
  if (edits.project?.summary) map.project.summary = edits.project.summary;
  applyProcessEdits(map, edits);
  // Who does each action (role matrix): same overrides as the Process view lanes
  for (const n of map.nodes) {
    if (!n.who) continue;
    const actor = edits.steps[n.id]?.actor;
    if (actor) n.who = { id: laneKey(actor), name: actor, evidence: ["set by a person"], provenance: "human" };
    const name = edits.roles[n.who.id];
    if (name) n.who = { ...n.who, name, provenance: "human" };
  }
  const edited = Object.keys(edits.steps).length + Object.keys(edits.features).length;
  if (edited) {
    map.notes.push(`Applied ${edited - orphans.length} edit${edited - orphans.length === 1 ? "" : "s"} from ${EDITS_FILE}.`);
  }
  if (changed.length) {
    map.notes.push(`Needs review: ${changed.length} described step${changed.length === 1 ? "" : "s"} changed in code since the description was written.`);
  }
  if (orphans.length) {
    map.notes.push(
      `Kept ${orphans.length} edit${orphans.length === 1 ? "" : "s"} for things no longer in the code (renamed or removed): ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? ", …" : ""}. Remove them from ${EDITS_FILE} when no longer needed.`,
    );
  }
  return map;
}

function applyProcessEdits(map: BuiltMap, edits: Edits): void {
  for (const p of map.processes ?? []) {
    // Who does what: per-step overrides first, then lane names
    for (const step of p.steps) {
      const actor = edits.steps[step.node]?.actor;
      if (!actor) continue;
      const id = laneKey(actor);
      if (!p.lanes.some((l) => l.id === id)) p.lanes.push({ id, name: actor, evidence: ["set by a person"], provenance: "human" });
      step.lane = id;
    }
    p.lanes = p.lanes.filter((l) => p.steps.some((s) => s.lane === l.id));
    for (const lane of p.lanes) {
      const name = edits.roles[lane.id];
      if (name) {
        lane.name = name;
        lane.provenance = "human";
      }
    }
    const labels = edits.statuses[p.subject] ?? {};
    for (const st of p.states) {
      const label = labels[st.value];
      if (label) {
        st.label = label;
        st.named = "human";
      }
    }
  }
}

function resolveFeature(map: BuiltMap, byId: Map<string, Feature>, ref: string): Feature {
  const existing = byId.get(ref) ?? map.features.find((f) => f.name.toLowerCase() === ref.toLowerCase());
  if (existing) return existing;
  const id = `custom:${slug(ref)}`;
  const f: Feature = { id, name: ref, nodes: [], files: [], provenance: "human" };
  map.features.push(f);
  byId.set(id, f);
  return f;
}

export type EditPatch =
  | { target: "project"; id: string; fields: ProjectEdit }
  | { target: "step"; id: string; fields: StepEdit }
  | { target: "feature"; id: string; fields: FeatureEdit }
  /** id = term; `from` renames an existing term. An empty definition removes the term. */
  | { target: "glossary"; id: string; fields: { definition?: string; from?: string } }
  | { target: "role"; id: string; fields: { name?: string } }
  | { target: "status"; id: string; fields: { value: string; label?: string } };

/**
 * Write one edit to builtlore.edits.yaml, keeping comments and the rest of the
 * file as they are. Empty values remove the field; an empty entry is removed.
 */
export function saveEdit(root: string, patch: EditPatch, raw?: BuiltMap): void {
  const path = join(root, EDITS_FILE);
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc: YAML.Document = YAML.parseDocument(YAML.isMap(YAML.parseDocument(source).contents) ? source : HEADER);

  if (patch.target === "project") {
    for (const k of ["name", "summary"] as const) {
      if (!(k in patch.fields)) continue;
      const v = clean(patch.fields[k]);
      if (v) doc.setIn(["project", k], v);
      else del(doc, ["project", k]);
    }
  } else if (patch.target === "glossary") {
    const term = patch.id.trim();
    const def = clean(patch.fields.definition);
    const renamedFrom = clean(patch.fields.from);
    if (renamedFrom && renamedFrom !== term) del(doc, ["glossary", renamedFrom]);
    if (def) doc.setIn(["glossary", term], def);
    else del(doc, ["glossary", term]);
  } else if (patch.target === "role") {
    const name = clean(patch.fields.name);
    if (name) doc.setIn(["roles", patch.id], name);
    else del(doc, ["roles", patch.id]);
  } else if (patch.target === "status") {
    const value = String(patch.fields.value);
    const label = clean(patch.fields.label);
    const key = value;
    if (label) doc.setIn(["statuses", patch.id, key], label);
    else del(doc, ["statuses", patch.id, key]);
    const entry = doc.getIn(["statuses", patch.id]);
    if (YAML.isMap(entry) && entry.items.length === 0) del(doc, ["statuses", patch.id]);
  } else {
    const section = patch.target === "step" ? "steps" : "features";
    const allowed = patch.target === "step" ? ["label", "description", "feature", "hidden", "actor"] : ["name", "description"];
    for (const [k, v] of Object.entries(patch.fields as Record<string, unknown>)) {
      if (!allowed.includes(k)) continue;
      const value = typeof v === "string" ? clean(v) : v === true ? true : undefined;
      if (value === undefined) del(doc, [section, patch.id, k]);
      else doc.setIn([section, patch.id, k], value);
    }
    if (patch.target === "step") {
      // Saving a described step records the code it describes (and clears a pending review).
      const node = raw?.nodes.find((n) => n.id === patch.id);
      const described = doc.getIn([section, patch.id, "label"]) || doc.getIn([section, patch.id, "description"]);
      if (node && described) doc.setIn([section, patch.id, "code"], codeFingerprint(node));
      else del(doc, [section, patch.id, "code"]);
    }
    const entry = doc.getIn([section, patch.id]);
    if (YAML.isMap(entry) && entry.items.length === 0) del(doc, [section, patch.id]);
  }
  for (const section of ["project", "features", "steps", "glossary", "roles", "statuses"]) {
    const s = doc.get(section);
    if (YAML.isMap(s) && s.items.length === 0) doc.delete(section);
  }

  const empty = !YAML.isMap(doc.contents) || doc.contents.items.length === 0;
  let text = empty ? HEADER : doc.toString({ lineWidth: 0 });
  if (!text.startsWith("#")) text = HEADER + text;
  writeFileSync(path, text);
}

/** deleteIn that tolerates missing paths. */
function del(doc: YAML.Document, path: Array<string | number>): void {
  if (doc.hasIn(path)) doc.deleteIn(path);
}

function clean(s: string | undefined): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\r\n/g, "\n").trim();
  return t || undefined;
}

function objectOf<T>(v: unknown): Record<string, T> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "group";
}
