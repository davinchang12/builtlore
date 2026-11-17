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
  StatusWrite,
  Subject,
} from "./types.js";

const VIA_PRIORITY: ActorRef["via"][] = ["code", "view", "middleware", "name"];

type Conditions = (id: string) => { requires: StatusCondition[]; via?: ProcessStep["fromVia"]; actors: ActorRef[] };

/** Conditions and actors that apply to a step, from its own code and from how it is reached. */
export function stepConditions(entries: EntryFact[], navs: NavigatesFact[]): Conditions {
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const incoming = new Map<string, NavigatesFact[]>();
  for (const e of navs) {
    if (!["link", "submit", "ajax"].includes(e.trigger)) continue;
    const list = incoming.get(e.to) ?? [];
    list.push(e);
    incoming.set(e.to, list);
  }
  return (id: string) => {
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
}

function compatible(a: string[] = [], b: string[] = []): boolean {
  const seen = new Map(a.map((x) => [x.slice(0, x.lastIndexOf(":")), x.slice(x.lastIndexOf(":") + 1)]));
  return b.every((x) => {
    const k = x.slice(0, x.lastIndexOf(":"));
    return !seen.has(k) || seen.get(k) === x.slice(x.lastIndexOf(":") + 1);
  });
}

function compareOrder(a: number[] = [], b: number[] = []): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Group a step's writes into sequences, one per branch: each sequence ends at a
 * write that no later write in a compatible branch follows.
 */
export function writeChains(writes: StatusWrite[]): StatusWrite[][] {
  if (writes.length <= 1) return writes.map((w) => [w]);
  if (writes.some((w) => !w.order)) return writes.map((w) => [w]);
  const sorted = [...writes].sort((x, y) => compareOrder(x.order, y.order));
  const finals = sorted.filter((w, i) => !sorted.slice(i + 1).some((l) => compareOrder(l.order, w.order) > 0 && compatible(w.branch, l.branch)));
  return finals.map((f) => {
    const chain: StatusWrite[] = [];
    for (const w of sorted) {
      if (compareOrder(w.order, f.order) > 0) break;
      if (compatible(w.branch, f.branch) && chain.every((c) => compatible(c.branch, w.branch))) chain.push(w);
    }
    return chain;
  });
}

/** Who does a step: the lane the Process view would put it in. */
export function whoDoes(entry: EntryFact, conditionsOf: Conditions): ProcessLane {
  return pickLane(conditionsOf(entry.id).actors, entry);
}

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
  const conditionsOf = stepConditions(input.entries, input.navs);

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
        // Seen first as a bare number (@if ($latest == 11)), named later by the code (Constant::STATUS_DONE)
        const seen = states.get(id);
        if (seen?.named === "raw" && v.label) Object.assign(seen, { label: v.label, code: v.code, named: "code" });
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
        // A route that already names the record (/orders/{order}/hold) does not create it, even if it creates other rows
        const creates = Boolean(model && p?.creates.includes(model)) && !n.uri.includes("{");
        const explicitActors = cond.actors.filter((a) => a.via !== "name");
        if (!writes.length && !requires.length && !creates && !explicitActors.length) continue;

        // Writes in sequence (a status history: "submitted", then "waiting for review") end at the last one;
        // writes in different if/else branches are alternatives.
        const chains: string[][] = [];
        const info: Array<{ from?: string[]; when?: string[] }> = [];
        for (const c of writeChains(writes)) {
          const ids = c.map((w) => stateId(w.to)).filter((s, i, a) => i === 0 || a[i - 1] !== s);
          // What the branch of the last write says: if ($latest == X) / if (Gate::allows('x'))
          const pathFrom: string[] = [];
          const when: string[] = [];
          for (const atom of c[c.length - 1].branch ?? []) {
            const at = atom.lastIndexOf(":");
            const key = atom.slice(0, at);
            const val = atom.slice(at + 1);
            if (key.startsWith("st·")) {
              const s = key.slice(3);
              if (s === subject || resolve(s) === subject || (s.startsWith(".") && subject.endsWith(s))) pathFrom.push(stateId({ value: val, code: val }));
            } else if (key.startsWith("gate·") || key.startsWith("role·")) when.push(val === "1" ? key.slice(5) : `not ${key.slice(5)}`);
          }
          const entry = { ...(pathFrom.length ? { from: [...new Set(pathFrom)] } : {}), ...(when.length ? { when: [...new Set(when)] } : {}) };
          const sig = `${ids.join(">")}|${JSON.stringify(entry)}`;
          if (chains.some((x, i) => `${x.join(">")}|${JSON.stringify(info[i])}` === sig)) continue;
          chains.push(ids);
          info.push(entry);
        }
        const to = [...new Set(chains.map((c) => c[c.length - 1]))];
        const hasInfo = info.some((x) => x.from || x.when);
        const paths = chains.some((c) => c.length > 1) || hasInfo ? chains : undefined;
        if (creates && !to.length && known?.initial) to.push(stateId(known.initial));
        // A new record starts in the first status it is given (a history may move on right away)
        if (creates && to.length && !initial) initial = chains.length ? chains[0][0] : to[0];
        let from = [...new Set(requires.flatMap((r) => r.values.map(stateId)))];
        let fromVia = from.length ? cond.via : undefined;
        // No check on the step itself, but every branch starts from a known status: that is where it starts
        if (!from.length && chains.length && info.every((x) => x.from)) {
          from = [...new Set(info.flatMap((x) => x.from!))];
          fromVia = "guard";
        }

        const lane = pickLane(cond.actors, entryById.get(n.id));
        if (!laneOf.has(lane.id)) laneOf.set(lane.id, lane);
        else for (const ev of lane.evidence) if (!laneOf.get(lane.id)!.evidence.includes(ev)) laneOf.get(lane.id)!.evidence.push(ev);
        steps.push({
          node: n.id,
          lane: lane.id,
          from,
          fromVia,
          to,
          creates: creates || undefined,
          ...(paths ? { paths } : {}),
          ...(paths && hasInfo ? { pathInfo: info } : {}),
        });
      }
      if (!steps.some((s) => s.to.length)) continue;
      if (!initial && known?.initial) initial = stateId(known.initial);
      // Values the code knows about but no step reaches stay listed (they may be set elsewhere).
      for (const v of known?.values ?? []) stateId(v);

      processes.push({
        id: `${feature.id}:${subject}`,
        feature: feature.id,
        // Two tables with the same status column in one feature: name both by table
        name: subjects.filter((s) => s.split(".").slice(1).join(".") === column).length > 1
          ? `${feature.name} · ${subject}`
          : subjects.length > 1 || !/^(m_)?status(_id)?$/.test(column) ? `${feature.name} · ${column}` : feature.name,
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
      kind: chosen.every((a) => a.kind === "permission") ? "permission" : "role",
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
