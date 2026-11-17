/**
 * Turn adapter facts into the as-built model. Deterministic: features are
 * grouped by route name / URI, labels are derived from names. (An optional
 * AI pass that renames and regroups is planned; see docs/DESIGN.md.)
 */
import { buildProcesses, stepConditions, whoDoes } from "./process.js";
import type {
  BuiltMap,
  CommandFact,
  ConfigFact,
  EntryFact,
  Fact,
  Feature,
  Integration,
  IntegrationFact,
  JobFact,
  MapEdge,
  MapNode,
  NavigatesFact,
  ScheduleFact,
  SkippedFact,
  StatesFact,
  TableFact,
} from "./types.js";

const AUTH_NAMES = /^(login|logout|register|password|verification|two-factor|auth|sanctum)(\.|$)/;
const AUTH_URIS = /^(login|logout|register|forgot-password|reset-password|verify-email|email|confirm-password|two-factor-challenge)(\/|$)/;

const VERBS: Record<string, string> = {
  index: "List",
  create: "New",
  store: "Save",
  show: "View",
  edit: "Edit",
  update: "Update",
  destroy: "Delete",
};

export function buildMap(input: {
  projectName: string;
  commit?: string;
  stacks: string[];
  facts: Fact[];
  notes: string[];
  generator: string;
}): BuiltMap {
  const entries = input.facts.filter((f): f is EntryFact => f.kind === "entry");
  const navs = input.facts.filter((f): f is NavigatesFact => f.kind === "navigates");
  const skipped = input.facts.filter((f): f is SkippedFact => f.kind === "skipped");

  const { featureById, display } = assignFeatures(entries);
  const conditionsOf = stepConditions(entries, navs);
  const nodes: MapNode[] = entries.map((e) => {
    const feature = featureById.get(e.id)!;
    const node: MapNode = {
      id: e.id,
      type: e.type,
      label: labelOf(e, feature, display.get(feature) ?? featureName(feature)),
      methods: e.methods,
      uri: e.uri,
      name: e.name,
      feature,
      middleware: e.middleware,
      handler: e.handler,
      view: e.view,
      source: e.source,
      provenance: "extracted",
    };
    if (isAction(e)) node.who = whoDoes(e, conditionsOf);
    if (e.validation?.length) node.validation = e.validation;
    if (e.inputs?.length) node.inputs = e.inputs;
    if (e.responds?.length) node.responds = e.responds;
    return node;
  });

  // Actions the server lets anyone (or any signed-in user) run, while the page that calls them
  // checks a permission before showing its buttons: say so, without picking one for the action
  const entryById = new Map(entries.map((e) => [e.id, e]));
  for (const n of nodes) {
    if (!n.who || !/^(anyone|signed-in-user)$/.test(n.who.id)) continue;
    const pages = [...new Set(navs.filter((x) => x.to === n.id && ["ajax", "submit", "link"].includes(x.trigger)).map((x) => x.from))]
      .filter((id) => entryById.get(id)?.pageAbilities?.length);
    if (!pages.length) continue;
    const abilities = [...new Set(pages.flatMap((id) => entryById.get(id)!.pageAbilities!))];
    n.pageOnly = { abilities, pages };
    n.who = { ...n.who, evidence: [...n.who.evidence, `the calling page checks ${abilities.join(", ")} before showing its buttons; this endpoint does not check`] };
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: MapEdge[] = navs
    .filter((n) => nodeIds.has(n.from) && nodeIds.has(n.to))
    .map((n, i) => ({
      id: `e${i + 1}`,
      from: n.from,
      to: n.to,
      trigger: n.trigger,
      outcome: n.outcome,
      label: n.label ?? defaultEdgeLabel(n),
      source: n.source,
      provenance: "extracted",
    }));

  const byFeature = new Map<string, MapNode[]>();
  for (const n of nodes) {
    if (!byFeature.has(n.feature)) byFeature.set(n.feature, []);
    byFeature.get(n.feature)!.push(n);
  }
  const features: Feature[] = [...byFeature.entries()]
    .map(([id, ns]) => ({
      id,
      name: display.get(id) ?? featureName(id),
      nodes: ns.map((n) => n.id),
      files: [...new Set(ns.flatMap((n) => [n.handler?.file, n.view?.file].filter((f): f is string => Boolean(f))))].sort(),
      provenance: "extracted" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const processes = buildProcesses({
    entries,
    navs,
    states: input.facts.filter((f): f is StatesFact => f.kind === "states"),
    nodes,
    features,
  });

  const tables = input.facts.filter((f): f is TableFact => f.kind === "table").map((f) => f.table);
  const schedule = input.facts.filter((f): f is ScheduleFact => f.kind === "schedule").map((f) => f.task);
  const commands = input.facts.filter((f): f is CommandFact => f.kind === "command").map((f) => f.command);
  const jobs = input.facts.filter((f): f is JobFact => f.kind === "job").map((f) => f.job);
  const config = input.facts.filter((f): f is ConfigFact => f.kind === "config");
  const integrations = groupIntegrations(
    input.facts.filter((f): f is IntegrationFact => f.kind === "integration"),
    nodes,
    commands.map((c) => ({ id: `command:${c.name}`, class: c.class })),
    jobs.map((j) => ({ id: `job:${j.class}`, class: j.class })),
    reachedBy(entries),
  );

  return {
    schema: "builtlore/0.1",
    generatedAt: new Date().toISOString(),
    generator: input.generator,
    project: { name: input.projectName, commit: input.commit },
    stacks: input.stacks,
    features,
    nodes,
    edges,
    skipped,
    notes: input.notes,
    ...(processes.length ? { processes } : {}),
    ...(tables.length ? { data: { tables } } : {}),
    ...(schedule.length || commands.length || jobs.length ? { automation: { schedule, commands, jobs } } : {}),
    ...(integrations.length ? { integrations } : {}),
    ...(config.length ? { config } : {}),
  };
}

/** "App\Services\Approval@hold" -> the steps whose handler reaches it. */
function reachedBy(entries: EntryFact[]): Map<string, Array<{ id: string; dead: Set<number> }>> {
  const out = new Map<string, Array<{ id: string; dead: Set<number> }>>();
  for (const e of entries) {
    for (const r of e.calls ?? []) out.set(r.method, [...(out.get(r.method) ?? []), { id: e.id, dead: new Set(r.dead ?? []) }]);
  }
  return out;
}

/** Steps a person performs: form submits, writes and exports (not pages or data reads). */
export function isAction(e: Pick<EntryFact, "type" | "methods">): boolean {
  if (e.type === "action" || e.type === "download") return true;
  return e.type === "api" && !e.methods.every((m) => m === "GET");
}

/**
 * One integration per target (an API base URL, a mailable, a notification, a
 * disk), with every call to it and the steps, commands or jobs that make it.
 */
function groupIntegrations(
  facts: IntegrationFact[],
  nodes: MapNode[],
  commands: Array<{ id: string; class?: string }>,
  jobs: Array<{ id: string; class: string }>,
  reach: Map<string, Array<{ id: string; dead: Set<number> }>> = new Map(),
): Integration[] {
  const byTarget = new Map<string, Integration>();
  for (const { usage: u } of facts) {
    let g = byTarget.get(u.target);
    if (!g) {
      g = { id: u.target, kind: u.kind, name: u.name, usages: [] };
      byTarget.set(u.target, g);
    }
    if (u.env?.length) g.env = [...new Set([...(g.env ?? []), ...u.env])];
    if (u.channels?.length) g.channels = [...new Set([...(g.channels ?? []), ...u.channels])];
    const by: string[] = [];
    if (u.in) {
      const inn = u.in;
      if (inn.class === "closure") {
        for (const n of nodes) if (n.handler?.kind === "closure" && n.handler.file === u.source.file && `closure:${n.handler.line}` === inn.method) by.push(n.id);
      } else {
        for (const n of nodes) if (n.handler?.class === inn.class && n.handler.method === inn.method) by.push(n.id);
        for (const c of commands) if (c.class === inn.class) by.push(c.id);
        for (const j of jobs) if (j.class === inn.class) by.push(j.id);
        // Made in a service: the steps whose handler reaches that method
        // …unless the call sits in a branch that cannot run with the arguments that step passes
        if (!by.length) {
          for (const r of reach.get(`${inn.class}@${inn.method ?? ""}`) ?? []) {
            if (u.source.line !== undefined && r.dead.has(u.source.line)) continue;
            if (!by.includes(r.id)) by.push(r.id);
          }
        }
      }
    }
    g.usages.push({
      by,
      ...(u.in && u.in.class !== "closure" ? { in: u.in } : {}),
      ...(u.method ? { method: u.method } : {}),
      ...(u.path ? { path: u.path } : {}),
      ...(u.operation ? { operation: u.operation } : {}),
      source: u.source,
    });
  }
  const order = { http: 0, mail: 1, notification: 2, storage: 3 };
  return [...byTarget.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** Name prefixes that describe an area of the app rather than a feature. */
const AREAS = new Set(["api", "admin", "dashboard", "panel", "backoffice", "account", "settings"]);

export function featureOf(e: EntryFact): string {
  if ((e.name && AUTH_NAMES.test(e.name)) || AUTH_URIS.test(e.uri)) return "auth";
  if (e.name) {
    const parts = e.name.split(".");
    if (AREAS.has(parts[0]) && parts.length >= 2) return parts.slice(0, 2).join(".");
    if (parts.length >= 2) return parts[0];
  }
  const segs = e.uri.split("/").filter((s) => s && !s.startsWith("{"));
  const meaningful = segs[0] === "api" ? segs.slice(1) : segs;
  if (!meaningful.length) return segs[0] === "api" ? "api" : "home";
  return (segs[0] === "api" ? "api." : "") + meaningful[0];
}

/** Groups larger than this are split by controller domain when that gives meaningful groups. */
const SPLIT_THRESHOLD = 12;

/**
 * First pass: group by route name prefix / URI (featureOf). Big groups whose
 * entries belong to several controller "domains" (menu.* holding MTDI, Presentasi,
 * Review...) are areas, not features: split them by domain, so StatusMTDIController
 * and MTDIController land in the same feature.
 */
export function assignFeatures(entries: EntryFact[]): { featureById: Map<string, string>; display: Map<string, string> } {
  const featureById = new Map<string, string>();
  const display = new Map<string, string>();
  const displayRank = new Map<string, number>();
  const groups = new Map<string, EntryFact[]>();
  for (const e of entries) {
    const f = featureOf(e);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f)!.push(e);
  }
  for (const [base, list] of groups) {
    const domains = list.map((e) => domainOf(e, base));
    const distinct = new Set(domains.map((d) => d?.key).filter(Boolean));
    const split = list.length >= SPLIT_THRESHOLD && distinct.size >= 2 && list.length / distinct.size >= 2;
    list.forEach((e, i) => {
      const d = domains[i];
      if (split && d) {
        const id = `${base}.${d.key}`;
        featureById.set(e.id, id);
        // Prefer the spelling from a controller (MTDI) over one from a URI (mtdi).
        if ((displayRank.get(id) ?? -1) < d.rank) {
          display.set(id, `${featureName(base)} › ${d.label}`);
          displayRank.set(id, d.rank);
        }
      } else {
        featureById.set(e.id, base);
      }
    });
  }
  return { featureById, display };
}

const DOMAIN_NOISE = new Set([
  "status", "report", "reports", "laporan", "export", "import", "download", "upload", "detail", "details",
  "api", "admin", "master", "get", "data", "manage", "management", "approval", "history", "list", "base",
]);
const HANDLER_VERBS = new Set([
  "index", "show", "create", "store", "edit", "update", "destroy", "delete", "export", "import", "get", "download",
  "upload", "approve", "approved", "reject", "hold", "list", "view", "print", "data", "invoke",
]);

function splitWords(s: string): string[] {
  return s.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

function domainOf(e: EntryFact, base: string): { key: string; label: string; rank: number } | null {
  const cls = e.handler?.class?.split("\\").pop()?.replace(/Controller$/, "");
  let words: string[] = [];
  let rank = 2;
  if (cls) words = splitWords(cls).filter((w) => !DOMAIN_NOISE.has(w.toLowerCase()));
  if (!words.length && e.handler?.method) {
    rank = 1;
    words = splitWords(e.handler.method).filter((w) => !HANDLER_VERBS.has(w.toLowerCase()) && !DOMAIN_NOISE.has(w.toLowerCase()));
  }
  if (!words.length) {
    rank = 0;
    const fromName = e.name?.startsWith(base + ".") ? e.name.slice(base.length + 1).split(".")[0] : undefined;
    const fromUri = e.uri.split("/").filter((s) => s && !s.startsWith("{") && s !== "api")[1];
    const seg = fromName ?? fromUri;
    if (seg) words = seg.split(/[-_]+/).filter(Boolean);
  }
  if (!words.length) return null;
  const key = words.join("").toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = words
    .map((w, i) => (w.length > 1 && w === w.toUpperCase() ? w : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
    .join(" ");
  return key ? { key, label, rank } : null;
}

export function featureName(id: string): string {
  if (id === "auth") return "Authentication";
  if (id === "home") return "Home";
  return id
    .split(".")
    .map((p) => humanize(p))
    .join(" › ");
}

const LABEL_NOISE = new Set(["status", "statuses", "action", "actions"]);

const METHOD_VERBS: Record<string, string> = { POST: "Submit", PUT: "Update", PATCH: "Update", DELETE: "Delete" };

function labelOf(e: EntryFact, feature: string, featureLabel: string): string {
  const lastPart = featureLabel.split(" › ").pop() ?? featureLabel;
  const subject = lastPart === lastPart.toUpperCase() && lastPart.length > 1 ? lastPart : singularish(lastPart).toLowerCase();
  if (e.name) {
    const last = e.name.split(".").pop()!;
    if (VERBS[last]) return `${VERBS[last]} ${subject}`;
    const rest = e.name === feature ? last : e.name.startsWith(feature + ".") ? e.name.slice(feature.length + 1) : e.name;
    const [area, domainKey] = feature.split(".");
    if (domainKey && e.name.startsWith(area + ".")) {
      // menu.purchase-requests.status.approve-manager in feature menu.purchaserequest -> "Approve manager"
      const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
      const segs = e.name
        .slice(area.length + 1)
        .split(".")
        .filter((seg) => norm(seg) !== norm(domainKey) && !LABEL_NOISE.has(seg.toLowerCase()));
      if (segs.length) return humanize(segs.join(" "));
    }
    return humanize((rest || last).split(".").join(" "));
  }
  if (e.type === "redirect") return `Redirect /${e.uri}`;
  if (e.uri === "/") return "Home";
  const lastStatic = e.uri.split("/").filter((s) => s && !s.startsWith("{")).pop() ?? e.uri;
  const verb = METHOD_VERBS[e.methods[0]];
  return verb ? `${verb} ${humanize(lastStatic).toLowerCase()}` : humanize(lastStatic);
}

function defaultEdgeLabel(n: NavigatesFact): string | undefined {
  if (n.outcome === "error") return n.trigger === "back" ? "error" : "failed";
  if (n.outcome === "success") return "success";
  if (n.trigger === "submit") return "submit";
  if (n.trigger === "back") return "back";
  return undefined;
}

function humanize(s: string): string {
  const words = s.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function singularish(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
