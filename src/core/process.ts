/**
 * Build business processes (swimlanes) from Process-layer facts.
 *
 * One process per record status (Model.column), across features: a request created
 * in one feature and approved in another is one flow, owned by the feature that
 * creates it. Lanes are actors; steps are the actions that touch it; each step moves the
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

  // History/log tables (SlideHistory, ApprovalLog) record the process; they are not a process of their own.
  const isLog = (s: Subject) => /(History|Histories|Hist|Log|Logs|Audit|Audits|Trail|Activity|Activities|Tracking)$/i.test(s.split(".")[0]) || /(_history|_histories|_log|_logs|_audit|_trail)$/i.test(s.split(".")[0]);
  const isAction = (n: MapNode) => !n.methods.every((m) => m === "GET");

  // Per feature: the subjects its actions write, and how a write with an unknown model
  // (".status") resolves there (to the feature's only subject on that column).
  const perFeature = input.features.map((feature) => {
    const actions = feature.nodes.map((id) => nodeById.get(id)).filter((n): n is MapNode => Boolean(n) && isAction(n!));
    const written = new Set<Subject>();
    for (const n of actions) for (const w of entryById.get(n.id)?.process?.writes ?? []) written.add(w.subject);
    const subjects = [...written].filter((s) => !s.startsWith(".") && !isLog(s));
    const resolve = (s: Subject): Subject | null => {
      if (!s.startsWith(".")) return s;
      const same = subjects.filter((x) => x.endsWith(s));
      return same.length === 1 ? same[0] : null;
    };
    // Only unknown-model writes: a process of their own, kept to this feature
    const local = subjects.length ? [] : [...written].filter((s) => s.startsWith("."));
    return { feature, actions, subjects, resolve, local };
  });

  // One process per record status (Model.column), across every feature that touches it:
  // created in "Device", approved in "Outstanding" is one flow, not two.
  const groups: Array<{ subject: Subject; home: Feature; parts: typeof perFeature }> = [];
  for (const pf of perFeature) {
    for (const s of pf.subjects) {
      const g = groups.find((x) => x.subject === s);
      if (g) g.parts.push(pf);
      else groups.push({ subject: s, home: pf.feature, parts: [pf] });
    }
    for (const s of pf.local) groups.push({ subject: s, home: pf.feature, parts: [pf] });
  }
  // Steps elsewhere that only check the status (approve in another feature) join too
  for (const g of groups) {
    if (g.subject.startsWith(".")) continue;
    for (const pf of perFeature) {
      if (g.parts.includes(pf)) continue;
      const touches = pf.actions.some((n) => conditionsOf(n.id).requires.some((r) => r.subject === g.subject));
      if (touches) g.parts.push(pf);
    }
  }

  const processes: Process[] = [];
  for (const { subject, home, parts } of groups) {
    {
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

      const featureOf = new Map<string, Feature>();
      for (const part of parts) for (const n of part.actions) {
        const resolve = part.resolve;
        // A feature that writes this status brings all its actions that check a role;
        // other features only bring the steps that touch the status
        const owns = part.subjects.includes(subject) || part.local.includes(subject);
        const p = entryById.get(n.id)?.process;
        const cond = conditionsOf(n.id);
        const writes = (p?.writes ?? []).filter((w) => resolve(w.subject) === subject);
        const requires = cond.requires.filter((r) => resolve(r.subject) === subject || (owns && r.subject.startsWith(".") && subject.endsWith(r.subject)));
        // A route that already names the record (/orders/{order}/hold) does not create it, even if it creates other rows
        const creates = Boolean(model && p?.creates.includes(model)) && !n.uri.includes("{");
        const explicitActors = cond.actors.filter((a) => a.via !== "name");
        if (!writes.length && !requires.length && !creates && !(owns && explicitActors.length)) continue;
        featureOf.set(n.id, part.feature);

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

      // The process belongs to the feature where the record is created, else where most of its steps are
      const counts = new Map<string, number>();
      for (const s of steps) {
        const f = featureOf.get(s.node);
        if (f) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
      }
      const creator = steps.find((s) => s.creates);
      const ownerId = (creator && featureOf.get(creator.node)?.id) ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? home.id;
      const owner = parts.find((x) => x.feature.id === ownerId)?.feature ?? home;
      const features = [ownerId, ...[...counts.keys()].filter((f) => f !== ownerId)];
      const ownerPart = parts.find((x) => x.feature.id === ownerId) ?? parts[0];
      const siblings = ownerPart.subjects;
      const spread = features.length > 1;
      const modelName = humanizeModel(model);
      processes.push({
        id: `${owner.id}:${subject}`,
        feature: owner.id,
        ...(spread ? { features } : {}),
        // Steps in several features: named by the record ("Temp access request"); in one feature: by the feature.
        // Two tables with the same status column in one feature: name both by table.
        name: spread && model
          ? /^(m_)?status(_id)?$/.test(column) ? modelName : `${modelName} · ${column}`
          : siblings.filter((s) => s.split(".").slice(1).join(".") === column).length > 1
            ? `${owner.name} · ${subject}`
            : siblings.length > 1 || !/^(m_)?status(_id)?$/.test(column) ? `${owner.name} · ${column}` : owner.name,
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

/** TempAccessRequest -> "Temp access request"; TMtdiH -> "TMtdiH" (codes stay as written). */
function humanizeModel(model: string): string {
  if (!/^[A-Z][a-z]+([A-Z][a-z]+)*$/.test(model)) return model;
  const words = model.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  if (signedIn) return { id: "signed-in-user", name: "Signed-in user", evidence: ["only requires login (auth middleware)"], provenance: "extracted" };
  // Called by other systems with a key: if (!$request->header('X-Api-Key') …) return 401
  if (entry?.process?.client) return { id: "api-client", name: "API client", evidence: [`requires an API key (${entry.process.client})`], provenance: "extracted" };
  // A login check in code or in a custom middleware (if (!Session::get('nik')) abort(...), isLogin)
  if (entry?.process?.login) return { id: "signed-in-user", name: "Signed-in user", evidence: [`only requires login (${entry.process.login})`], provenance: "extracted" };
  return { id: "anyone", name: "Anyone", evidence: ["no login or role check found"], provenance: "extracted" };
}

function describe(a: ActorRef): string {
  const where = { code: "code", view: "view", middleware: "middleware", name: "route name" }[a.via];
  return `${where}: ${a.detail}`;
}

export function laneKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lane";
}
