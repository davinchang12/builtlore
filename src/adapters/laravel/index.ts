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
  RepoInfo,
  SkippedFact,
  ViewRef,
} from "../../core/types.js";
import { BladeReader, viewFile, type BladeTarget } from "./blade.js";
import { analyzeClosure, analyzeControllerMethod, ClassLocator, type HandlerAnalysis, type RedirectTarget } from "./controllers.js";
import { shortClass } from "./php.js";
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
        const art = extractRoutesArtisan(repo.root);
        if (art.ok) {
          routes = mergeRoutes(art.routes, fromStatic.routes);
          mode = "artisan";
        } else {
          notes.push(`Artisan mode unavailable (${art.reason}); used static parsing.`);
        }
      } else if (options.mode === "artisan") {
        notes.push("Artisan mode requested but artisan/vendor not found; used static parsing.");
      }
    }
    notes.push(`Laravel routes: ${routes.length} (${mode} mode; files: ${fromStatic.filesRead.join(", ") || "none"}).`);

    // 2. Entries
    const locator = new ClassLocator(repo.root);
    const blade = new BladeReader(repo.root);
    const entries: EntryFact[] = [];
    const analyses = new Map<string, HandlerAnalysis | null>();
    const usedIds = new Set<string>();

    for (const r of routes) {
      let id = entryId(r);
      if (usedIds.has(id)) id = `${id}#${r.methods[0]}`;
      usedIds.add(id);

      let handler: HandlerRef = { kind: "unknown" };
      let analysis: HandlerAnalysis | null = null;
      if (r.action.kind === "controller") {
        analysis = analyzeControllerMethod(locator, r.action.class, r.action.method);
        handler = { kind: "controller", class: r.action.class, method: r.action.method, file: analysis?.file, line: analysis?.line };
        if (!analysis) {
          skipped.push({ kind: "skipped", reason: `Controller not found: ${r.action.class}@${r.action.method}`, source: { file: r.file, line: r.line } });
        }
      } else if (r.action.kind === "closure") {
        analysis = analyzeClosure(r.action.node, r.action.ctx, r.action.file);
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

      entries.push({
        kind: "entry",
        id,
        type: entryType(r, view),
        methods: r.methods.filter((m) => m !== "HEAD"),
        uri: r.uri,
        name: r.name,
        middleware: unique(r.middleware),
        handler,
        view,
        source: { file: r.file, line: r.line },
      });
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
          const method = link.trigger === "submit" ? link.method ?? "POST" : "GET";
          const to = resolver.resolve(link.target, method);
          if (to) {
            if (to !== e.id) edges.push({ kind: "navigates", from: e.id, to, trigger: link.trigger, source: { file: link.file, line: link.line } });
          } else {
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

    const facts: Fact[] = [...entries, ...dedupe(resolved), ...skipped];
    return { facts, notes };
  },
};

function entryId(r: RawRoute): string {
  if (r.name) return `route:${r.name}`;
  const methods = r.methods.filter((m) => m !== "HEAD").join("|");
  return `route:${methods} /${r.uri === "/" ? "" : r.uri}`;
}

function entryType(r: RawRoute, view?: ViewRef): EntryType {
  if (r.routeFile === "api" || r.uri.startsWith("api/")) return "api";
  if (r.action.kind === "redirect") return "redirect";
  const readOnly = r.methods.every((m) => m === "GET" || m === "HEAD" || m === "ANY");
  if (readOnly || view) return "page";
  return "action";
}

class TargetResolver {
  private byName = new Map<string, EntryFact>();
  private patterns: Array<{ entry: EntryFact; re: RegExp }> = [];

  constructor(private entries: EntryFact[]) {
    for (const e of entries) {
      if (e.name) this.byName.set(e.name, e);
      this.patterns.push({ entry: e, re: uriPattern(e.uri) });
    }
  }

  resolve(target: BladeTarget, method: string): string | null {
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
  }
  return [...byKey.values()];
}
