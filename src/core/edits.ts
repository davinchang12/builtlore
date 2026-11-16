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
import type { BuiltMap, Feature, MapNode } from "./types.js";

export const EDITS_FILE = "builtlore.edits.yaml";

export interface StepEdit {
  label?: string;
  description?: string;
  /** Move the step to another feature: an existing feature id or a new feature name. */
  feature?: string;
  hidden?: boolean;
  /** Fingerprint of the code when the edit was made; used to flag changes. */
  code?: string;
}

export interface FeatureEdit {
  name?: string;
  description?: string;
}

export interface Edits {
  features: Record<string, FeatureEdit>;
  steps: Record<string, StepEdit>;
  glossary: Record<string, string>;
}

const HEADER = `# builtlore edits: names, descriptions and grouping written by people.
# builtlore applies this file on top of every scan; scans never overwrite it.
# Edit it here or in the canvas (builtlore serve). Commit it with your code.
`;

export function emptyEdits(): Edits {
  return { features: {}, steps: {}, glossary: {} };
}

export function loadEdits(root: string): Edits {
  const path = join(root, EDITS_FILE);
  if (!existsSync(path)) return emptyEdits();
  const parsed = YAML.parse(readFileSync(path, "utf8")) ?? {};
  return {
    features: objectOf(parsed.features),
    steps: objectOf(parsed.steps),
    glossary: objectOf(parsed.glossary),
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

  if (Object.keys(edits.glossary).length) map.glossary = { ...edits.glossary };
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
  | { target: "step"; id: string; fields: StepEdit }
  | { target: "feature"; id: string; fields: FeatureEdit }
  | { target: "glossary"; id: string; fields: { definition?: string } };

/**
 * Write one edit to builtlore.edits.yaml, keeping comments and the rest of the
 * file as they are. Empty values remove the field; an empty entry is removed.
 */
export function saveEdit(root: string, patch: EditPatch, raw?: BuiltMap): void {
  const path = join(root, EDITS_FILE);
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const doc: YAML.Document = YAML.parseDocument(YAML.isMap(YAML.parseDocument(source).contents) ? source : HEADER);

  if (patch.target === "glossary") {
    const def = clean(patch.fields.definition);
    if (def) doc.setIn(["glossary", patch.id], def);
    else doc.deleteIn(["glossary", patch.id]);
  } else {
    const section = patch.target === "step" ? "steps" : "features";
    const allowed = patch.target === "step" ? ["label", "description", "feature", "hidden"] : ["name", "description"];
    for (const [k, v] of Object.entries(patch.fields as Record<string, unknown>)) {
      if (!allowed.includes(k)) continue;
      const value = typeof v === "string" ? clean(v) : v === true ? true : undefined;
      if (value === undefined) doc.deleteIn([section, patch.id, k]);
      else doc.setIn([section, patch.id, k], value);
    }
    if (patch.target === "step") {
      // Saving a described step records the code it describes (and clears a pending review).
      const node = raw?.nodes.find((n) => n.id === patch.id);
      const described = doc.getIn([section, patch.id, "label"]) || doc.getIn([section, patch.id, "description"]);
      if (node && described) doc.setIn([section, patch.id, "code"], codeFingerprint(node));
      else doc.deleteIn([section, patch.id, "code"]);
    }
    const entry = doc.getIn([section, patch.id]);
    if (YAML.isMap(entry) && entry.items.length === 0) doc.deleteIn([section, patch.id]);
  }
  for (const section of ["features", "steps", "glossary"]) {
    const s = doc.get(section);
    if (YAML.isMap(s) && s.items.length === 0) doc.delete(section);
  }

  const empty = !YAML.isMap(doc.contents) || doc.contents.items.length === 0;
  let text = empty ? HEADER : doc.toString({ lineWidth: 0 });
  if (!text.startsWith("#")) text = HEADER + text;
  writeFileSync(path, text);
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
