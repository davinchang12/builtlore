/**
 * The documentation, as data: everything the Markdown and HTML outputs show,
 * derived from builtlore.json (code + edits). Renderers only format this.
 * Nothing here is inferred: every row points back to the code or to a person.
 */
import type {
  BackgroundWrite,
  BuiltMap,
  ConfigFact,
  DataColumn,
  DataTable,
  Feature,
  Integration,
  MapNode,
  Process,
  ProcessLane,
  ProcessState,
  ProcessStep,
  QueuedJob,
  ConsoleCommand,
  ScheduledTask,
  SourceRef,
  Validation,
} from "../core/types.js";

export interface DocTransition {
  step: ProcessStep;
  node: MapNode;
  lane: ProcessLane;
  from: ProcessState[];
  to: ProcessState[];
  /** Each sequence of statuses the step writes (one per branch); a single status when there is no sequence. */
  paths: ProcessState[][];
  /** Per path: the status it starts from, when its branch checks it (if ($latest == X)). */
  pathFrom: ProcessState[][];
  /** Per path: the checks it runs under ("medical", "not medical"). */
  pathWhen: string[][];
}

export interface DocBackground {
  /** "Job ExpireLeaveRequests" / "Command purchase-requests:remind" */
  by: string;
  schedule?: string;
  from: ProcessState[];
  to: ProcessState[];
  source: SourceRef;
}

export interface DocProcess {
  process: Process;
  transitions: DocTransition[];
  /** Steps that do not change the status (or whose change is not readable). */
  other: DocTransition[];
  background: DocBackground[];
  initial?: ProcessState;
}

export interface DocFeature {
  feature: Feature;
  slug: string;
  nodes: MapNode[];
  processes: DocProcess[];
  /** Processes owned by another feature that have steps here (approved here, created there). */
  shared: Array<{ process: Process; owner: Feature }>;
}

export interface RoleColumn {
  id: string;
  name: string;
  fallback: boolean;
  human: boolean;
  /** A named permission check (can:Slide Approve), not a role. */
  permission: boolean;
  evidence: string[];
}

export interface RuleRow {
  feature: Feature;
  node: MapNode;
  /** Pages whose form submits here. */
  forms: MapNode[];
  validation: Validation[];
}

export interface StatusRuleRow {
  process: Process;
  node: MapNode;
  from: ProcessState[];
  via: "guard" | "view" | "page";
}

export interface Finding {
  title: string;
  why: string;
  items: Array<{ text: string; source?: SourceRef }>;
}

export interface DocModel {
  map: BuiltMap;
  title: string;
  summary?: string;
  features: DocFeature[];
  roles: { columns: RoleColumn[]; rows: Array<{ feature: Feature; node: MapNode }> };
  rules: RuleRow[];
  statusRules: StatusRuleRow[];
  tables: DataTable[];
  relations: Array<{ table: string; column: DataColumn }>;
  integrations: Integration[];
  schedule: ScheduledTask[];
  commands: ConsoleCommand[];
  jobs: QueuedJob[];
  endpoints: Array<{ feature: Feature; node: MapNode }>;
  config: ConfigFact[];
  glossary: Array<[string, string]>;
  findings: Finding[];
  counts: Record<"features" | "pages" | "actions" | "processes" | "tables" | "tasks" | "integrations" | "endpoints" | "envKeys", number>;
}

const FALLBACK_LANES = new Set(["signed-in-user", "anyone"]);

export function buildDocModel(map: BuiltMap): DocModel {
  const visible = map.nodes.filter((n) => !n.hidden);
  const nodeById = new Map(visible.map((n) => [n.id, n]));
  const featureById = new Map(map.features.map((f) => [f.id, f]));
  const automation = map.automation ?? { schedule: [], commands: [], jobs: [] };

  // ---- Features and their processes
  const usedSlugs = new Set<string>();
  const features: DocFeature[] = map.features
    .map((f) => {
      const nodes = f.nodes.map((id) => nodeById.get(id)).filter((n): n is MapNode => Boolean(n));
      let slug = slugify(f.id);
      while (usedSlugs.has(slug)) slug += "-2";
      usedSlugs.add(slug);
      const processes = (map.processes ?? []).filter((p) => p.feature === f.id).map((p) => docProcess(p, nodeById, automation));
      const shared = (map.processes ?? [])
        .filter((p) => p.feature !== f.id && p.features?.includes(f.id))
        .map((p) => ({ process: p, owner: featureById.get(p.feature)! }))
        .filter((x) => x.owner);
      return { feature: f, slug, nodes, processes, shared };
    })
    .filter((f) => f.nodes.length);

  // ---- Roles × actions
  const rows: Array<{ feature: Feature; node: MapNode }> = [];
  const columns = new Map<string, RoleColumn>();
  for (const f of features) {
    for (const n of f.nodes) {
      if (!n.who) continue;
      rows.push({ feature: f.feature, node: n });
      const c = columns.get(n.who.id) ?? { id: n.who.id, name: n.who.name, fallback: FALLBACK_LANES.has(n.who.id), human: n.who.provenance === "human", permission: n.who.kind === "permission", evidence: [] };
      for (const e of n.who.evidence) if (!c.evidence.includes(e) && c.evidence.length < 4) c.evidence.push(e);
      columns.set(n.who.id, c);
    }
  }
  const roleColumns = [...columns.values()].sort((a, b) => Number(a.fallback) - Number(b.fallback) || (a.fallback ? (a.id === "signed-in-user" ? -1 : 1) : a.name.localeCompare(b.name)));

  // ---- Business rules: validation per form, and status rules
  const rules: RuleRow[] = [];
  for (const f of features) {
    for (const n of f.nodes) {
      if (!n.validation?.length) continue;
      const forms = map.edges
        .filter((e) => e.to === n.id && e.trigger === "submit")
        .map((e) => nodeById.get(e.from))
        .filter((x): x is MapNode => Boolean(x));
      rules.push({ feature: f.feature, node: n, forms: uniqueBy(forms, (x) => x.id), validation: n.validation });
    }
  }
  const statusRules: StatusRuleRow[] = [];
  for (const f of features) {
    for (const p of f.processes) {
      for (const t of [...p.transitions, ...p.other]) {
        if (t.from.length && t.step.fromVia) statusRules.push({ process: p.process, node: t.node, from: t.from, via: t.step.fromVia });
      }
    }
  }

  // ---- Data
  const tables = map.data?.tables ?? [];
  const relations = tables.flatMap((t) => t.columns.filter((c) => c.references).map((c) => ({ table: t.name, column: c })));

  // ---- Endpoints: APIs, data and file endpoints
  const endpoints: Array<{ feature: Feature; node: MapNode }> = [];
  for (const f of features) for (const n of f.nodes) if (n.type === "api" || n.type === "data" || n.type === "download") endpoints.push({ feature: f.feature, node: n });

  const glossary = Object.entries(map.glossary ?? {}).sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));

  const model: DocModel = {
    map,
    title: map.project.title ?? map.project.name,
    summary: map.project.summary,
    features,
    roles: { columns: roleColumns, rows },
    rules,
    statusRules,
    tables,
    relations,
    integrations: map.integrations ?? [],
    schedule: automation.schedule,
    commands: automation.commands,
    jobs: automation.jobs,
    endpoints,
    config: map.config ?? [],
    glossary,
    findings: [],
    counts: {
      features: features.length,
      pages: visible.filter((n) => n.type === "page").length,
      actions: rows.length,
      processes: (map.processes ?? []).length,
      tables: tables.length,
      tasks: automation.schedule.length,
      integrations: (map.integrations ?? []).length,
      endpoints: endpoints.length,
      envKeys: (map.config ?? []).filter((c) => c.uses.length).length,
    },
  };
  model.findings = findings(model, featureById);
  return model;
}

function docProcess(p: Process, nodeById: Map<string, MapNode>, automation: NonNullable<BuiltMap["automation"]>): DocProcess {
  const stateById = new Map(p.states.map((s) => [s.id, s]));
  const laneById = new Map(p.lanes.map((l) => [l.id, l]));
  const transitions: DocTransition[] = [];
  const other: DocTransition[] = [];
  for (const step of p.steps) {
    const node = nodeById.get(step.node);
    if (!node) continue; // hidden by a person
    const t: DocTransition = {
      step,
      node,
      lane: laneById.get(step.lane) ?? { id: step.lane, name: step.lane, evidence: [], provenance: "extracted" },
      from: step.from.map((id) => stateById.get(id)).filter((s): s is ProcessState => Boolean(s)),
      to: step.to.map((id) => stateById.get(id)).filter((s): s is ProcessState => Boolean(s)),
      paths: [],
      pathFrom: [],
      pathWhen: [],
    };
    t.paths = step.paths
      ? step.paths.map((p) => p.map((id) => stateById.get(id)).filter((s): s is ProcessState => Boolean(s))).filter((p) => p.length)
      : t.to.map((s) => [s]);
    t.pathFrom = t.paths.map((_, i) => (step.pathInfo?.[i]?.from ?? []).map((id) => stateById.get(id)).filter((s): s is ProcessState => Boolean(s)));
    t.pathWhen = t.paths.map((_, i) => step.pathInfo?.[i]?.when ?? []);
    // A path that is part of a longer one under the same checks says nothing new: keep the longer one
    const ids = t.paths.map((p) => p.map((s) => s.id).join(">"));
    const keep = t.paths.map((_, i) =>
      !t.paths.some((_, j) => j !== i && ids[j].length > ids[i].length && `>${ids[j]}>`.includes(`>${ids[i]}>`) && t.pathWhen[j].join("|") === t.pathWhen[i].join("|")),
    );
    t.paths = t.paths.filter((_, i) => keep[i]);
    t.pathFrom = t.pathFrom.filter((_, i) => keep[i]);
    t.pathWhen = t.pathWhen.filter((_, i) => keep[i]);
    (t.to.length ? transitions : other).push(t);
  }

  // Jobs and commands that change this status in the background
  const background: DocBackground[] = [];
  const scheduleOf = (kind: "job" | "command", name: string) => {
    const t = automation.schedule.find((s) => s.runs.kind === kind && s.runs.name === name);
    return t ? t.whenText ?? t.when : undefined;
  };
  const stateFor = (value: string) => p.states.find((s) => s.value === value);
  const add = (by: string, schedule: string | undefined, writes: BackgroundWrite[]) => {
    for (const w of writes) {
      if (w.subject !== p.subject) continue;
      const to = stateFor(w.to.value);
      if (!to) continue;
      background.push({
        by,
        schedule,
        from: (w.when ?? []).map((v) => stateFor(v.value)).filter((s): s is ProcessState => Boolean(s)),
        to: [to],
        source: w.source,
      });
    }
  };
  for (const j of automation.jobs) add(`Job ${short(j.class)}`, scheduleOf("job", j.class), j.writes);
  for (const c of automation.commands) add(`Command ${c.name}`, scheduleOf("command", c.name), c.writes);

  return { process: p, transitions, other, background, initial: p.initial ? stateById.get(p.initial) : undefined };
}

function findings(m: DocModel, featureById: Map<string, Feature>): Finding[] {
  const map = m.map;
  const out: Finding[] = [];
  const nodeLabel = (n: MapNode) => `${featureById.get(n.feature)?.name ?? n.feature} › ${n.label} (${n.methods.join("|")} /${n.uri === "/" ? "" : n.uri})`;

  const dup = map.notes.filter((n) => n.startsWith("Warning:"));
  if (dup.length) {
    out.push({
      title: "Duplicate routes",
      why: "Laravel uses only the last one.",
      items: dup.map((text) => ({ text: text.replace(/^Warning:\s*/, "") })),
    });
  }

  // Permission checked only where the button is shown: anyone who calls the endpoint directly gets through
  const pageOnly = map.nodes.filter((n) => !n.hidden && n.pageOnly);
  if (pageOnly.length) {
    out.push({
      title: "Permission checked only in the page",
      why: "The page hides the button without the permission, but the endpoint itself does not check it, so a direct request still works. Add the check on the server (middleware can:…, $this->authorize(), Gate::authorize()).",
      items: pageOnly.map((n) => ({
        text: `${nodeLabel(n)}: the page checks ${n.pageOnly!.abilities.join(", ")}`,
        source: n.handler?.file ? { file: n.handler.file, line: n.handler.line } : n.source,
      })),
    });
  }

  // Writes with no login, key or permission check at all
  const open = map.nodes.filter((n) => !n.hidden && n.who?.id === "anyone" && !n.methods.every((x) => x === "GET"));
  if (open.length) {
    out.push({
      title: "Open to anyone",
      why: "No login, API key or permission check found, so anyone who can reach the server can call these. Some are meant to be public (login, OTP, webhooks); check the rest.",
      items: open.map((n) => ({ text: nodeLabel(n), source: n.handler?.file ? { file: n.handler.file, line: n.handler.line } : n.source })),
    });
  }

  const unvalidated = map.nodes.filter(
    (n) => !n.hidden && n.who && (n.type === "action" || n.type === "api") && !n.methods.every((x) => x === "GET") && !n.validation?.length && (n.inputs?.length ?? 0) > 0,
  );
  if (unvalidated.length) {
    out.push({
      title: "Writes without validation",
      why: "Reads request fields, no validation found.",
      items: unvalidated.map((n) => ({ text: `${nodeLabel(n)} reads ${n.inputs!.map((i) => (i === "*" ? "all fields" : i)).join(", ")}`, source: n.handler?.file ? { file: n.handler.file, line: n.handler.line } : n.source })),
    });
  }

  const envOutside = map.config?.flatMap((c) => c.uses.filter((u) => !u.source.file.startsWith("config/")).map((u) => ({ key: c.key, u }))) ?? [];
  if (envOutside.length) {
    out.push({
      title: "env() outside config",
      why: "Returns null after config:cache. Use config().",
      items: envOutside.map(({ key, u }) => ({ text: `env('${key}')`, source: u.source })),
    });
  }

  const missing = map.config?.filter((c) => c.uses.length && !c.inExample && !c.framework) ?? [];
  const hasExample = map.config?.some((c) => c.inExample) ?? false;
  if (missing.length && hasExample) {
    out.push({
      title: "Missing from .env.example",
      why: "Read by the code, not listed for new installs.",
      items: missing.map((c) => ({ text: c.key, source: c.uses[0]?.source })),
    });
  }

  const incoming = new Set(map.edges.map((e) => e.to));
  const unreachable = map.nodes.filter((n) => !n.hidden && n.type === "page" && n.uri.includes("{") && !incoming.has(n.id));
  if (unreachable.length) {
    out.push({
      title: "Pages nothing leads to",
      why: "No link, form or redirect leads here. Opened from outside, or left over.",
      items: unreachable.map((n) => ({ text: nodeLabel(n), source: n.source })),
    });
  }

  const review = map.nodes.filter((n) => n.review);
  if (review.length) {
    out.push({
      title: "Descriptions to check",
      why: "Code changed after the description was written.",
      items: review.map((n) => ({ text: nodeLabel(n), source: n.source })),
    });
  }

  const orphans = map.notes.filter((n) => n.startsWith("Kept "));
  if (orphans.length) {
    out.push({ title: "Edits for removed code", why: "Still in builtlore.edits.yaml.", items: orphans.map((text) => ({ text })) });
  }

  // "Redirect back with no known source page" only affects arrows on the canvas: a scan note, not a finding
  const minor = (s: { reason: string }) => /^Redirect back from /.test(s.reason);
  const unread = map.skipped.filter((s) => !minor(s));
  if (unread.length) {
    out.push({
      title: "Not read by builtlore",
      why: "builtlore does not guess: these lines are not in the docs.",
      items: unread.map((s) => ({ text: s.reason, source: s.source })),
    });
  }

  // How the scan ran (mode, counts, what was left out on purpose): the same notes `builtlore scan` prints.
  const info = map.notes.filter((n) => !n.startsWith("Warning:") && !n.startsWith("Kept "));
  const notes = [...info.map((text) => ({ text })), ...map.skipped.filter(minor).map((s) => ({ text: s.reason, source: s.source }))];
  if (notes.length) out.push({ title: "Scan notes", why: "", items: notes });
  return out;
}

export interface DocEdge {
  from: ProcessState | "start" | "any";
  to: ProcessState;
  label: string;
  who: string;
  negative: boolean;
  background: boolean;
  transition?: DocTransition;
}

/**
 * Every arrow of a process: from the status a step needs (or a new record, or any
 * status when the code does not check) to each status it writes, in sequence.
 */
export function processEdges(p: DocProcess): DocEdge[] {
  const out: DocEdge[] = [];
  const push = (e: DocEdge) => {
    const key = (x: DocEdge) => `${typeof x.from === "string" ? x.from : x.from.id}>${x.to.id}>${x.label}`;
    if (!out.some((x) => key(x) === key(e))) out.push(e);
  };
  for (const t of p.transitions) {
    const label = t.node.label;
    const sources: DocEdge["from"][] = [];
    if (t.step.creates) sources.push("start");
    sources.push(...t.from);
    if (!sources.length) sources.push("any");
    t.paths.forEach((path, pi) => {
      const neg = (s: ProcessState) => NEGATIVE.test(label) || NEGATIVE.test(s.label);
      // A branch that checks the status (if ($latest == X)) starts from X, not from every source of the step
      const own: DocEdge["from"][] = t.pathFrom[pi]?.length && !t.from.length ? t.pathFrom[pi] : sources;
      for (const s of own) push({ from: s, to: path[0], label, who: t.lane.name, negative: neg(path[0]), background: false, transition: t });
      for (let i = 1; i < path.length; i++) push({ from: path[i - 1], to: path[i], label, who: t.lane.name, negative: neg(path[i]), background: false, transition: t });
    });
  }
  for (const b of p.background) {
    const label = b.schedule ? `${b.by} (${b.schedule.charAt(0).toLowerCase()}${b.schedule.slice(1)})` : b.by;
    const sources: DocEdge["from"][] = b.from.length ? b.from : ["any"];
    for (const to of b.to) for (const s of sources) push({ from: s, to, label, who: "automatic", negative: false, background: true });
  }
  return out;
}

/** Statuses the record can end in: reached by some arrow, and no arrow leaves them. */
export function finalStates(p: DocProcess): ProcessState[] {
  const edges = processEdges(p);
  const leaves = new Set(edges.filter((e) => typeof e.from !== "string").map((e) => (e.from as ProcessState).id));
  const seen = new Set<string>();
  return edges.map((e) => e.to).filter((s) => !leaves.has(s.id) && !seen.has(s.id) && (seen.add(s.id), true));
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "feature";
}

export function short(fqcn: string): string {
  return fqcn.split("\\").pop() ?? fqcn;
}

function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

/** "Step label" for a usage id: a node, a command or a job. */
export function byLabel(m: DocModel, id: string): string {
  if (id.startsWith("command:")) return `Command ${id.slice(8)}`;
  if (id.startsWith("job:")) return `Job ${short(id.slice(4))}`;
  const n = m.map.nodes.find((x) => x.id === id);
  if (!n) return id;
  const f = m.map.features.find((x) => x.id === n.feature);
  return `${f?.name ?? n.feature} › ${n.label}`;
}

export function endpoint(n: MapNode): string {
  return `${n.methods.join("|")} /${n.uri === "/" ? "" : n.uri}`;
}

export function where(s: SourceRef | undefined): string {
  if (!s) return "";
  return s.line ? `${s.file}:${s.line}` : s.file;
}

/** Same words the canvas draws as hold / reject / cancel. */
export const NEGATIVE = /reject|declin|\bhold|cancel|tolak|batal|\bvoid|fail|expire|ditolak|dibatalkan/i;
