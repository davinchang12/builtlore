/**
 * Build business processes (swimlanes) from Process-layer facts.
 *
 * One process per feature and status column ("Purchase request · status").
 * Lanes are actors; steps are the actions of the feature; each step moves the
 * record from the states it requires to the states it writes. Where code says
 * nothing, the process says nothing: no invented actors or transitions.
 */
import type {
  ActorRef,
  EntryFact,
  Feature,
  MapNode,
  NavigatesFact,
  Process,
  ProcessLane,
  ProcessState,
  ProcessStep,
  StatesFact,
  StatusCondition,
  StatusValue,
  Subject,
} from "./types.js";

const VIA_PRIORITY: ActorRef["via"][] = ["code", "view", "middleware", "name"];

export function buildProcesses(input: {
  entries: EntryFact[];
  navs: NavigatesFact[];
  states: StatesFact[];
  nodes: MapNode[];
  features: Feature[];
}): Process[] {
  const entryById = new Map(input.entries.map((e) => [e.id, e]));
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const catalog = new Map(input.states.map((s) => [s.subject, s]));
  const incoming = new Map<string, NavigatesFact[]>();
  for (const e of input.navs) {
    if (!["link", "submit", "ajax"].includes(e.trigger)) continue;
    const list = incoming.get(e.to) ?? [];
    list.push(e);
    incoming.set(e.to, list);
  }

  // Conditions and actors that apply to a step, from its own code and from how it is reached.
  const conditionsOf = (id: string): { requires: StatusCondition[]; via?: ProcessStep["fromVia"]; actors: ActorRef[] } => {
    const own = entryById.get(id)?.process;
    const actors: ActorRef[] = [...(own?.actors ?? [])];
    const guard = own?.requires ?? [];
    const inc = incoming.get(id) ?? [];
    const fromView = inc.flatMap((e) => e.when?.requires ?? []);
    for (const e of inc) for (const a of e.when?.actors ?? []) actors.push(a);
    if (guard.length) return { requires: guard, via: "guard", actors };
    if (fromView.length) return { requires: fromView, via: "view", actors };
    // Submitted from a page that is itself only reachable in some states (Edit while "On hold")
    const viaPage: StatusCondition[] = [];
    for (const e of inc) {
      if (e.trigger !== "submit") continue;
      for (const into of incoming.get(e.from) ?? []) {
        viaPage.push(...(into.when?.requires ?? []));
        for (const a of into.when?.actors ?? []) actors.push(a);
      }
    }
    return { requires: viaPage, via: viaPage.length ? "page" : undefined, actors };
  };

  const processes: Process[] = [];
  for (const feature of input.features) {
    const featureNodes = feature.nodes.map((id) => nodeById.get(id)).filter((n): n is MapNode => Boolean(n));
    const actions = featureNodes.filter((n) => !n.methods.every((m) => m === "GET"));

    // Subjects written by this feature
    const written = new Map<Subject, number>();
    for (const n of actions) for (const w of entryById.get(n.id)?.process?.writes ?? []) written.set(w.subject, (written.get(w.subject) ?? 0) + 1);
    // History/log tables (SlideHistory, ApprovalLog) record the process; they are not a process of their own.
    const isLog = (s: Subject) => /(History|Histories|Hist|Log|Logs|Audit|Audits|Trail|Activity|Activities|Tracking)$/i.test(s.split(".")[0]) || /(_history|_histories|_log|_logs|_audit|_trail)$/i.test(s.split(".")[0]);
    const subjects = [...written.keys()].filter((s) => !s.startsWith(".") && !isLog(s));
    // Writes with an unknown model join the feature's only subject on that column
    const resolve = (s: Subject): Subject | null => {
      if (!s.startsWith(".")) return s;
      const same = subjects.filter((x) => x.endsWith(s));
      return same.length === 1 ? same[0] : null;
    };
    for (const s of written.keys()) if (s.startsWith(".") && !resolve(s) && !subjects.length) subjects.push(s);

    for (const subject of subjects) {
      const model = subject.split(".")[0];
      const column = subject.split(".").slice(1).join(".");
      const states = new Map<string, ProcessState>();
      const known = catalog.get(subject);
      const stateId = (v: StatusValue): string => {
        const id = `${subject}=${v.value}`;
        if (!states.has(id)) {
          const fromCatalog = known?.values.find((k) => k.value === v.value);
          const best = fromCatalog?.label ? fromCatalog : v;
          states.set(id, {
            id,
            value: v.value,
            code: fromCatalog?.code ?? v.code,
            label: best.label ?? `${column} = ${v.value}`,
            named: best.label ? "code" : "raw",
          });
        }
        return id;
      };

      const steps: ProcessStep[] = [];
      const laneOf = new Map<string, ProcessLane>();
      let initial: string | undefined;

      for (const n of actions) {
        const p = entryById.get(n.id)?.process;
        const cond = conditionsOf(n.id);
        const writes = (p?.writes ?? []).filter((w) => resolve(w.subject) === subject);
        const requires = cond.requires.filter((r) => resolve(r.subject) === subject || (r.subject.startsWith(".") && subject.endsWith(r.subject)));
        const creates = Boolean(model && p?.creates.includes(model));
        const explicitActors = cond.actors.filter((a) => a.via !== "name");
        if (!writes.length && !requires.length && !creates && !explicitActors.length) continue;

        const to = [...new Set(writes.map((w) => stateId(w.to)))];
        if (creates && !to.length && known?.initial) to.push(stateId(known.initial));
        if (creates && to.length && !initial) initial = to[0];
        const from = [...new Set(requires.flatMap((r) => r.values.map(stateId)))];

        const lane = pickLane(cond.actors, entryById.get(n.id));
        if (!laneOf.has(lane.id)) laneOf.set(lane.id, lane);
        else for (const ev of lane.evidence) if (!laneOf.get(lane.id)!.evidence.includes(ev)) laneOf.get(lane.id)!.evidence.push(ev);
        steps.push({ node: n.id, lane: lane.id, from, fromVia: from.length ? cond.via : undefined, to, creates: creates || undefined });
      }
      if (!steps.some((s) => s.to.length)) continue;
      if (!initial && known?.initial) initial = stateId(known.initial);
      // Values the code knows about but no step reaches stay listed (they may be set elsewhere).
      for (const v of known?.values ?? []) stateId(v);

      processes.push({
        id: `${feature.id}:${subject}`,
        feature: feature.id,
        name: subjects.length > 1 || column !== "status" ? `${feature.name} · ${column}` : feature.name,
        subject,
        states: [...states.values()],
        initial,
        lanes: [...laneOf.values()],
        steps,
      });
    }
  }
  return processes;
}

/**
 * One lane per step: the most specific actor from the strongest source.
 * Roles beat permissions; among permissions the last one wins (route-level
 * middleware comes after group-level, e.g. can:Master then can:Slide Approve).
 */
function pickLane(actors: ActorRef[], entry: EntryFact | undefined): ProcessLane {
  for (const via of VIA_PRIORITY) {
    const found = actors.filter((a) => a.via === via);
    if (!found.length) continue;
    const roles = found.filter((a) => a.kind !== "permission");
    const chosen = roles.length ? [...new Map(roles.map((r) => [r.name, r])).values()] : [found[found.length - 1]];
    const name = chosen.map((a) => a.name).join(" / ");
    return {
      id: laneKey(name),
      name,
      evidence: chosen.map((a) => describe(a)),
      provenance: via === "name" ? "inferred" : "extracted",
    };
  }
  const signedIn = (entry?.middleware ?? []).some((m) => /^auth(:|$)|^auth\.|sanctum/i.test(m));
  return signedIn
    ? { id: "signed-in-user", name: "Signed-in user", evidence: ["only requires login (auth middleware)"], provenance: "extracted" }
    : { id: "anyone", name: "Anyone", evidence: ["no login or role check found"], provenance: "extracted" };
}

function describe(a: ActorRef): string {
  const where = { code: "code", view: "view", middleware: "middleware", name: "route name" }[a.via];
  return `${where}: ${a.detail}`;
}

export function laneKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lane";
}
