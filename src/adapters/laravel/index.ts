import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Adapter,
  AdapterResult,
  EntryFact,
  EntryType,
  ExtractOptions,
  Fact,
  HandlerRef,
  NavigatesFact,
  ProcessInfo,
  RepoInfo,
  SkippedFact,
  ViewRef,
} from "../../core/types.js";
import { readAutomation } from "./automation.js";
import { BladeReader, viewFile, type BladeTarget } from "./blade.js";
import { readConfig } from "./config.js";
import { analyzeClosure, analyzeControllerMethod, ClassLocator, findMethod, type HandlerAnalysis, type RedirectTarget } from "./controllers.js";
import { PhpCache } from "./files.js";
import { readIntegrations } from "./integrations.js";
import { readMigrations } from "./migrations.js";
import { parseViewConditions, ProcessReader } from "./process.js";
import { readRequest, type RequestReading } from "./validation.js";
import { lineOf, shortClass, type PhpNode } from "./php.js";
import { artisanAvailable, extractRoutesArtisan, mergeRoutes } from "./routes-artisan.js";
import { extractRoutesStatic, type RawRoute } from "./routes-static.js";

export const laravelAdapter: Adapter = {
  id: "laravel",
  name: "Laravel",

  async detect(repo: RepoInfo): Promise<boolean> {
    const composer = join(repo.root, "composer.json");
    if (!existsSync(join(repo.root, "artisan")) && !existsSync(join(repo.root, "routes", "web.php"))) return false;
    if (!existsSync(composer)) return existsSync(join(repo.root, "artisan"));
    try {
      const json = JSON.parse(readFileSync(composer, "utf8"));
      return Boolean(json.require?.["laravel/framework"] || json["require-dev"]?.["laravel/framework"] || existsSync(join(repo.root, "artisan")));
    } catch {
      return existsSync(join(repo.root, "artisan"));
    }
  },

  async extract(repo: RepoInfo, options: ExtractOptions): Promise<AdapterResult> {
    const notes: string[] = [];
    const skipped: SkippedFact[] = [];

    // 1. Route table
    const fromStatic = extractRoutesStatic(repo.root);
    skipped.push(...fromStatic.skipped);
    let routes: RawRoute[] = fromStatic.routes;
    let mode = "static";
    if (options.mode !== "static") {
      if (artisanAvailable(repo.root)) {
        const art = extractRoutesArtisan(repo.root, options.php ?? process.env.BUILTLORE_PHP ?? "php");
        if (art.ok) {
          routes = mergeRoutes(art.routes, fromStatic.routes);
          mode = "artisan";
        } else if (options.mode === "artisan") {
          notes.push(`Artisan mode unavailable (${art.reason}); used static mode instead.`);
        }
      } else if (options.mode === "artisan") {
        notes.push("Artisan mode requested but artisan/vendor not found; used static parsing.");
      }
    }
    notes.push(
      mode === "static"
        ? `Laravel routes: ${routes.length}, read directly from ${fromStatic.filesRead.join(", ") || "no route files"} (static mode, no PHP needed).`
        : `Laravel routes: ${routes.length}, from php artisan route:list (artisan mode).`,
    );
    routes = dropDuplicates(routes, notes);

    // 2. Entries
    const locator = new ClassLocator(repo.root);
    const blade = new BladeReader(repo.root);
    const reader = new ProcessReader(repo.root, locator);
    const entries: EntryFact[] = [];
    const analyses = new Map<string, HandlerAnalysis | null>();
    const usedIds = new Set<string>();
    const viewVars = new Map<string, Record<string, string>>();
    // A handler used by several routes is read once (and its unreadable rules reported once).
    const requestCache = new Map<string, RequestReading>();
    const readRequestOnce = (file: string, node: PhpNode, read: () => RequestReading): RequestReading => {
      const key = `${file}:${lineOf(node)}`;
      let got = requestCache.get(key);
      if (!got) {
        got = read();
        requestCache.set(key, got);
        skipped.push(...got.skipped);
      }
      return got;
    };

    for (const r of routes) {
      let id = entryId(r);
      if (usedIds.has(id)) id = `${id}#${r.methods[0]}`;
      usedIds.add(id);

      let handler: HandlerRef = { kind: "unknown" };
      let analysis: HandlerAnalysis | null = null;
      let process: ProcessInfo = { actors: [], writes: [], requires: [], creates: [] };
      let request: RequestReading | null = null;
      if (r.action.kind === "controller") {
        analysis = analyzeControllerMethod(locator, r.action.class, r.action.method);
        const m = findMethod(locator, r.action.class, r.action.method);
        if (m) {
          process = reader.analyzeHandler(m.node, m.names, m.file, r.action.class);
          request = readRequestOnce(m.file, m.node, () => readRequest(m.node, m.names, m.file, locator));
        }
        handler = { kind: "controller", class: r.action.class, method: r.action.method, file: analysis?.file, line: analysis?.line };
        if (!analysis) {
          skipped.push({ kind: "skipped", reason: `Controller not found: ${r.action.class}@${r.action.method}`, source: { file: r.file, line: r.line } });
        }
      } else if (r.action.kind === "closure") {
        analysis = analyzeClosure(r.action.node, r.action.ctx, r.action.file);
        process = reader.analyzeHandler(r.action.node, r.action.ctx, r.action.file);
        const a = r.action;
        request = readRequestOnce(a.file, a.node, () => readRequest(a.node, a.ctx, a.file, locator));
        handler = { kind: "closure", file: r.action.file, line: analysis.line };
      } else if (r.action.kind === "view") {
        analysis = { views: [{ engine: "blade", name: r.action.view }], redirects: [], validates: false };
        handler = { kind: "view" };
      } else if (r.action.kind === "redirect") {
        analysis = { views: [], redirects: [{ kind: "uri", uri: r.action.to, file: r.file, line: r.line }], validates: false };
        handler = { kind: "redirect" };
      }
      analyses.set(id, analysis);

      let view: ViewRef | undefined;
      const firstView = analysis?.views[0];
      if (firstView) {
        view = {
          engine: firstView.engine,
          name: firstView.name,
          file: firstView.engine === "blade" ? viewFile(repo.root, firstView.name) ?? undefined : undefined,
        };
      }

      for (const a of reader.actorsFromMiddleware(r.middleware)) {
        if (!process.actors.some((x) => x.name === a.name)) process.actors.push(a);
      }

      entries.push({
        kind: "entry",
        id,
        type: entryType(r, view, analysis),
        methods: r.methods.filter((m) => m !== "HEAD"),
        uri: r.uri,
        name: r.name,
        middleware: unique(r.middleware),
        handler,
        view,
        source: { file: r.file, line: r.line },
        process: process.actors.length || process.writes.length || process.requires.length || process.creates.length ? process : undefined,
        ...(request?.validation.length ? { validation: request.validation } : {}),
        ...(request?.inputs.length ? { inputs: request.inputs } : {}),
        ...(analysis ? { responds: respondsOf(analysis) } : {}),
      });
      // The page's view may check these: @if ($latestStatus == 4)
      if (process.statusVars) viewVars.set(id, process.statusVars);
    }

    // 3. Navigation edges
    const resolver = new TargetResolver(entries);
    const edges: NavigatesFact[] = [];
    let layoutLinks = 0;
    let inertiaViews = 0;
    const countedLayouts = new Set<string>();

    for (const e of entries) {
      const analysis = analyses.get(e.id);
      // a) View -> next step
      if (e.view?.engine === "blade") {
        const b = blade.analyze(e.view.name);
        for (const l of b.layouts) {
          if (countedLayouts.has(l)) continue;
          countedLayouts.add(l);
          layoutLinks += blade.layoutLinkCount(l);
        }
        for (const link of b.links) {
          const method = link.trigger === "submit" ? link.method ?? "POST" : link.trigger === "ref" ? link.method ?? "ANY" : "GET";
          const to = resolver.resolve(link.target, method);
          if (to) {
            if (to === e.id) continue;
            const trigger = link.trigger === "ref" ? (resolver.typeOf(to) === "page" ? "link" : "ajax") : link.trigger;
            const edge: NavigatesFact = { kind: "navigates", from: e.id, to, trigger, source: { file: link.file, line: link.line } };
            if (link.when) {
              const when = parseViewConditions(link.when, reader, link.file, link.line, viewVars.get(e.id));
              if (when.actors.length || when.requires.length) edge.when = when;
            }
            edges.push(edge);
          } else if (link.trigger !== "ref") {
            skipped.push({ kind: "skipped", reason: `Unresolved ${link.trigger} target ${describeTarget(link.target)}`, source: { file: link.file, line: link.line } });
          }
        }
      } else if (e.view?.engine === "inertia") {
        inertiaViews++;
      }
      // b) Handler -> redirect
      for (const red of analysis?.redirects ?? []) {
        const src = { file: red.file ?? e.source.file, line: red.line };
        if (red.kind === "back") {
          edges.push({ kind: "navigates", from: e.id, to: "back", trigger: "back", outcome: red.outcome, source: src });
          continue;
        }
        const to = resolver.resolveRedirect(red);
        if (to) edges.push({ kind: "navigates", from: e.id, to, trigger: "redirect", outcome: red.outcome, source: src });
        else skipped.push({ kind: "skipped", reason: `Unresolved redirect ${describeRedirect(red)}`, source: src });
      }
      // c) Validation failure -> back with errors
      if (analysis?.validates && !e.methods.every((m) => m === "GET")) {
        edges.push({
          kind: "navigates",
          from: e.id,
          to: "back",
          trigger: "back",
          outcome: "error",
          label: "validation failed",
          source: { file: analysis.file ?? e.source.file, line: analysis.line },
        });
      }
    }

    // 4. Resolve "back" to the page(s) that lead here
    const resolved: NavigatesFact[] = [];
    for (const edge of edges) {
      if (edge.to !== "back") {
        resolved.push(edge);
        continue;
      }
      const sources = edges.filter((x) => x.to === edge.from && (x.trigger === "submit" || x.trigger === "link")).map((x) => x.from);
      if (!sources.length) {
        skipped.push({ kind: "skipped", reason: `Redirect back from ${edge.from} with no known source page`, source: edge.source });
        continue;
      }
      for (const s of unique(sources)) resolved.push({ ...edge, to: s, trigger: "back" });
    }

    if (layoutLinks) notes.push(`Ignored ${layoutLinks} links from shared layouts (menus/navbars) to keep flows readable.`);
    if (inertiaViews) notes.push(`${inertiaViews} Inertia pages detected; Inertia navigation edges are planned for a later release.`);

    // 5. Actors from names (approve-manager), only for role words: known in the app or common ones
    for (const e of entries) {
      if (e.methods.every((m) => m === "GET")) continue;
      const explicit = (e.process?.actors.length ?? 0) > 0 || edges.some((x) => x.to === e.id && x.when?.actors.length);
      if (explicit) continue;
      const role = reader.roleFromName(e.name ?? "") ?? (e.handler?.method ? reader.roleFromName(e.handler.method) : null);
      if (!role) continue;
      const p = e.process ?? { actors: [], writes: [], requires: [], creates: [] };
      p.actors.push(reader.actor(role, "name", e.name ?? e.handler?.method ?? e.uri));
      e.process = p;
    }

    // 5b. What could not be read is reported, not guessed
    let unresolved = 0;
    for (const e of entries) {
      for (const u of e.process?.unresolved ?? []) {
        unresolved++;
        skipped.push({ kind: "skipped", reason: `Status change not readable yet: ${u.column} = ${u.code}`, source: u.source });
      }
      for (const sp of e.process?.procedures ?? []) {
        skipped.push({ kind: "skipped", reason: `Calls stored procedure ${sp}: status changes inside it are not visible in the code`, source: e.handler?.file ? { file: e.handler.file, line: e.handler.line } : e.source });
      }
    }
    if (unresolved) notes.push(`Process: ${unresolved} status change${unresolved === 1 ? "" : "s"} could not be read (value comes from input or an expression). See "Skipped" for the exact lines.`);

    // 6. Known states of the models involved
    const models = new Set<string>();
    const noteModel = (subject: string) => {
      const short = subject.split(".")[0];
      const fq = short ? reader.modelFor(short) : null;
      if (fq) models.add(fq);
    };
    for (const e of entries) {
      for (const w of e.process?.writes ?? []) noteModel(w.subject);
      for (const q of e.process?.requires ?? []) noteModel(q.subject);
      for (const c of e.process?.creates ?? []) noteModel(`${c}.`);
    }
    for (const x of edges) for (const q of x.when?.requires ?? []) noteModel(q.subject);
    const states = reader.statesFacts(models);
    const withStates = states.filter((st) => st.values.length || st.initial).length;
    const steps = entries.filter((e) => e.process?.writes.length).length;
    if (steps) {
      const described = withStates ? `; ${withStates} status column${withStates === 1 ? "" : "s"} with values listed on the model` : "";
      notes.push(`Process: ${steps} step${steps === 1 ? "" : "s"} change a status (including in the services they call)${described}.`);
    }

    // 7. Documentation layer: data, configuration, integrations, automation
    const php = new PhpCache(repo.root);
    const docs: Fact[] = [];
    const migrations = readMigrations(repo.root, {
      modelForTable: (t) => reader.modelForTable(t),
      tableForModel: (fq) => reader.tableForModel(fq),
    });
    skipped.push(...migrations.skipped);
    for (const table of migrations.tables) docs.push({ kind: "table", table });
    const config = readConfig(repo.root, php);
    skipped.push(...config.skipped);
    docs.push(...config.keys);
    const integrations = readIntegrations(repo.root, php, locator, config.configEnv);
    skipped.push(...integrations.skipped);
    for (const usage of integrations.usages) docs.push({ kind: "integration", usage });
    const automation = readAutomation(repo.root, php, reader);
    skipped.push(...automation.skipped);
    for (const task of automation.schedule) docs.push({ kind: "schedule", task });
    for (const command of automation.commands) docs.push({ kind: "command", command });
    for (const job of automation.jobs) docs.push({ kind: "job", job });
    const counts = [
      migrations.files ? `${migrations.tables.length} table${migrations.tables.length === 1 ? "" : "s"} from ${migrations.files} migration${migrations.files === 1 ? "" : "s"}` : "",
      automation.schedule.length ? `${automation.schedule.length} scheduled task${automation.schedule.length === 1 ? "" : "s"}` : "",
      integrations.usages.length ? `${integrations.usages.length} integration call${integrations.usages.length === 1 ? "" : "s"}` : "",
      config.keys.length ? `${config.keys.length} environment key${config.keys.length === 1 ? "" : "s"} (names only)` : "",
    ].filter(Boolean);
    if (counts.length) notes.push(`Docs: ${counts.join(", ")}.`);

    // A line reached from several steps (a shared service method) is reported once
    const seenSkip = new Set<string>();
    const uniqueSkipped = skipped.filter((s) => {
      const k = `${s.reason}|${s.source.file}|${s.source.line ?? ""}`;
      return seenSkip.has(k) ? false : (seenSkip.add(k), true);
    });
    const facts: Fact[] = [...entries, ...dedupe(resolved), ...uniqueSkipped, ...states, ...docs];
    return { facts, notes };
  },
};

function respondsOf(a: HandlerAnalysis): EntryFact["responds"] {
  const out: NonNullable<EntryFact["responds"]> = [];
  if (a.views.length) out.push("view");
  if (a.redirects.length) out.push("redirect");
  if (a.returnsJson) out.push("json");
  if (a.returnsFile) out.push("file");
  return out;
}

function entryId(r: RawRoute): string {
  if (r.name) return `route:${r.name}`;
  const methods = r.methods.filter((m) => m !== "HEAD").join("|");
  return `route:${methods} /${r.uri === "/" ? "" : r.uri}`;
}

function entryType(r: RawRoute, view: ViewRef | undefined, a: HandlerAnalysis | null): EntryType {
  if (r.routeFile === "api") return "api";
  // web.php routes under /api/... are usually AJAX endpoints of the web app
  if (r.uri.startsWith("api/") && !view && !(a?.returnsJson || a?.returnsFile)) return "api";
  if (r.action.kind === "redirect") return "redirect";
  if (!view && a) {
    if (a.returnsFile && !a.redirects.length) return "download";
    // JSON from a write (store/update/approve...) is an AJAX action; JSON from a read is a data endpoint.
    if (a.returnsJson && !a.redirects.length) return isWrite(r) ? "action" : "data";
  }
  const readOnly = r.methods.every((m) => m === "GET" || m === "HEAD" || m === "ANY");
  if (readOnly || view) return "page";
  return "action";
}

const WRITE_VERBS = /^(store|update|destroy|delete|save|approve|reject|hold|cancel|submit|insert|change|assign|reassign|delegat|upload|import|revis|confirm|close|reopen|send|toggle|set)/i;

function isWrite(r: RawRoute): boolean {
  const method = r.action.kind === "controller" ? r.action.method : "";
  const last = r.name?.split(".").pop() ?? "";
  return WRITE_VERBS.test(method) || WRITE_VERBS.test(last.replace(/[-_]/g, ""));
}

/**
 * Two routes with the same method and URI: Laravel keeps the last one registered.
 * Keep the same one and say so, because it is almost always a copy-paste leftover.
 */
function dropDuplicates(routes: RawRoute[], notes: string[]): RawRoute[] {
  const key = (r: RawRoute) => `${r.methods.filter((m) => m !== "HEAD").join("|")} /${r.uri === "/" ? "" : r.uri}`;
  const lastIndex = new Map<string, number>();
  routes.forEach((r, i) => lastIndex.set(key(r), i));
  const seen = new Map<string, RawRoute[]>();
  for (const r of routes) {
    const k = key(r);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k)!.push(r);
  }
  for (const [k, list] of seen) {
    if (list.length < 2) continue;
    const where = list.map((r) => `${r.file}${r.line ? ":" + r.line : ""}`).join(", ");
    notes.push(`Warning: duplicate route ${k} defined ${list.length} times (${where}); Laravel uses the last one.`);
  }
  const byName = new Map<string, RawRoute[]>();
  for (const r of routes) if (r.name) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  for (const [name, list] of byName) {
    if (list.length < 2 || new Set(list.map(key)).size < 2) continue;
    notes.push(`Warning: route name '${name}' is used by ${list.length} different routes; route('${name}') points to the last one.`);
  }
  return routes.filter((r, i) => lastIndex.get(key(r)) === i);
}

class TargetResolver {
  private byName = new Map<string, EntryFact>();
  private byId = new Map<string, EntryFact>();
  private patterns: Array<{ entry: EntryFact; re: RegExp }> = [];

  constructor(private entries: EntryFact[]) {
    for (const e of entries) {
      this.byId.set(e.id, e);
      if (e.name) this.byName.set(e.name, e);
      this.patterns.push({ entry: e, re: uriPattern(e.uri) });
    }
  }

  typeOf(id: string): EntryType | undefined {
    return this.byId.get(id)?.type;
  }

  resolve(target: BladeTarget, method: string): string | null {
    if (method === "ANY") {
      if (target.kind === "name") return this.byName.get(target.name)?.id ?? null;
      if (target.kind === "uri") return this.byUri(target.uri, "GET") ?? this.byUri(target.uri, "POST") ?? this.byUri(target.uri, "ANY");
    }
    if (target.kind === "name") {
      // route('login') in a POST form points at the POST route on the same URI.
      const named = this.byName.get(target.name);
      if (!named) return null;
      const m = method.toUpperCase();
      if (named.methods.includes(m as never) || named.methods.includes("ANY")) return named.id;
      return this.byUri(named.uri, m) ?? named.id;
    }
    if (target.kind === "uri") return this.byUri(target.uri, method);
    const m = target.raw.match(/([A-Za-z_\\]+)::class\s*,\s*['"](\w+)['"]/) ?? target.raw.match(/['"]([A-Za-z_\\]+)@(\w+)['"]/);
    if (!m) return null;
    return this.byHandler(m[1], m[2]);
  }

  resolveRedirect(r: RedirectTarget): string | null {
    if (r.kind === "name") return this.byName.get(r.name)?.id ?? null;
    if (r.kind === "uri") return this.byUri(r.uri, "GET");
    if (r.kind === "action") return this.byHandler(r.class, r.method);
    return null;
  }

  private byUri(uri: string, method: string): string | null {
    const path = uri.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+|\/+$/g, "") || "/";
    const m = method.toUpperCase();
    const candidates = this.patterns.filter((p) => p.re.test(path));
    if (m === "ANY") {
      // No method known (a URL in a script): only resolve when it is unambiguous.
      return candidates.length === 1 ? candidates[0].entry.id : null;
    }
    const exact = candidates.find((p) => p.entry.methods.includes(m as never) || p.entry.methods.includes("ANY"));
    return (exact ?? (m === "GET" ? undefined : candidates[0]))?.entry.id ?? null;
  }

  private byHandler(cls: string, method: string): string | null {
    const short = shortClass(cls);
    const e = this.entries.find((x) => x.handler?.class && shortClass(x.handler.class) === short && x.handler.method === method);
    return e?.id ?? null;
  }
}

function uriPattern(uri: string): RegExp {
  if (uri === "/") return /^\/?$/;
  const parts = uri.split("/").map((seg) => {
    if (/^\{[^}]+\?\}$/.test(seg)) return "(?:/[^/]+)?";
    if (/^\{[^}]+\}$/.test(seg)) return "/[^/]+";
    return "/" + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("").slice(1)}$`);
}

function describeTarget(t: BladeTarget): string {
  return t.kind === "name" ? `route('${t.name}')` : t.kind === "uri" ? `'${t.uri}'` : `action(${t.raw})`;
}

function describeRedirect(r: RedirectTarget): string {
  if (r.kind === "name") return `route('${r.name}')`;
  if (r.kind === "uri") return `'${r.uri}'`;
  if (r.kind === "action") return `${r.class}@${r.method}`;
  return "back";
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** One edge per (from, to, trigger, outcome); distinct reasons are merged into the label. */
function dedupe(edges: NavigatesFact[]): NavigatesFact[] {
  const byKey = new Map<string, NavigatesFact>();
  for (const e of edges) {
    const k = `${e.from}|${e.to}|${e.trigger}|${e.outcome ?? ""}`;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...e });
      continue;
    }
    const labels = [prev.label, e.label].filter((l): l is string => Boolean(l));
    prev.label = labels.length ? [...new Set(labels)].join(" / ") : undefined;
    if (e.when) {
      prev.when = prev.when ?? { actors: [], requires: [] };
      for (const a of e.when.actors) if (!prev.when.actors.some((x) => x.name === a.name)) prev.when.actors.push(a);
      prev.when.requires.push(...e.when.requires);
    }
  }
  return [...byKey.values()];
}
