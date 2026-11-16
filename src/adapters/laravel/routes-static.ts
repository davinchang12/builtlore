/**
 * Static Laravel route extraction: reads routes/*.php without running PHP.
 *
 * Supports Route::get/post/put/patch/delete/options/any/match/view/redirect,
 * resource/apiResource (+ only/except), group() with array attributes or fluent
 * prefix/name/as/middleware/controller chains, and require/include of other
 * route files. Anything that cannot be resolved is reported as skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { HttpMethod, SkippedFact } from "../../core/types.js";
import {
  arrayEntries,
  flattenChain,
  lineOf,
  nameContext,
  parsePhp,
  resolveClass,
  stringList,
  stringValue,
  type ChainStep,
  type NameContext,
  type PhpNode,
} from "./php.js";

export interface RawRoute {
  methods: HttpMethod[];
  uri: string; // normalized, no leading slash except root "/"
  name?: string;
  middleware: string[];
  action: RouteAction;
  file: string; // repo-relative
  line?: number;
  routeFile: "web" | "api" | "other";
}

export type RouteAction =
  | { kind: "controller"; class: string; method: string }
  | { kind: "closure"; node: PhpNode; ctx: NameContext; file: string }
  | { kind: "view"; view: string }
  | { kind: "redirect"; to: string }
  | { kind: "unknown"; raw?: string };

interface GroupCtx {
  prefix: string;
  namePrefix: string;
  middleware: string[];
  controller?: string;
  namespace?: string; // legacy 'namespace' group attribute
}

export interface StaticRouteResult {
  routes: RawRoute[];
  skipped: SkippedFact[];
  filesRead: string[];
}

const VERBS: Record<string, HttpMethod[]> = {
  get: ["GET", "HEAD"],
  post: ["POST"],
  put: ["PUT"],
  patch: ["PATCH"],
  delete: ["DELETE"],
  options: ["OPTIONS"],
  any: ["ANY"],
};

const ROUTE_FACADES = new Set(["Route", "Illuminate\\Support\\Facades\\Route"]);

export function extractRoutesStatic(root: string): StaticRouteResult {
  const result: StaticRouteResult = { routes: [], skipped: [], filesRead: [] };
  const seen = new Set<string>();

  const entryFiles: Array<{ path: string; kind: RawRoute["routeFile"]; ctx: GroupCtx }> = [
    { path: join(root, "routes/web.php"), kind: "web", ctx: { prefix: "", namePrefix: "", middleware: ["web"] } },
    { path: join(root, "routes/api.php"), kind: "api", ctx: { prefix: "api", namePrefix: "", middleware: ["api"] } },
  ];

  for (const f of entryFiles) {
    if (existsSync(f.path)) processFile(f.path, f.kind, f.ctx);
  }
  return result;

  function rel(p: string): string {
    return relative(root, p).split("\\").join("/");
  }

  function processFile(path: string, kind: RawRoute["routeFile"], ctx: GroupCtx): void {
    const abs = resolve(path);
    if (seen.has(abs)) return;
    seen.add(abs);
    result.filesRead.push(rel(abs));
    const ast = parsePhp(readFileSync(abs, "utf8"), abs);
    if (!ast) {
      result.skipped.push({ kind: "skipped", reason: "Could not parse PHP file", source: { file: rel(abs) } });
      return;
    }
    const names = nameContext(ast);
    processStatements(ast.children ?? [], { abs, kind, names }, ctx);
  }

  interface FileCtx {
    abs: string;
    kind: RawRoute["routeFile"];
    names: NameContext;
  }

  function processStatements(stmts: PhpNode[], file: FileCtx, ctx: GroupCtx): void {
    for (const stmt of stmts) {
      if (!stmt) continue;
      if (stmt.kind === "namespace") {
        processStatements(stmt.children ?? [], file, ctx);
        continue;
      }
      const expr = stmt.kind === "expressionstatement" ? stmt.expression : stmt;
      if (!expr) continue;
      if (expr.kind === "include") {
        handleInclude(expr, file, ctx);
        continue;
      }
      if (expr.kind === "call") {
        handleCall(expr, file, ctx);
      }
    }
  }

  function handleInclude(expr: PhpNode, file: FileCtx, ctx: GroupCtx): void {
    const target = stringValue(expr.target);
    if (!target) {
      result.skipped.push({ kind: "skipped", reason: "Dynamic route file include", source: { file: rel(file.abs), line: lineOf(expr) } });
      return;
    }
    const resolved = target.startsWith("__DIR__")
      ? join(dirname(file.abs), target.slice("__DIR__".length))
      : resolve(dirname(file.abs), target);
    if (existsSync(resolved)) processFile(resolved, file.kind === "api" ? "api" : file.kind, ctx);
    else result.skipped.push({ kind: "skipped", reason: `Included route file not found: ${target}`, source: { file: rel(file.abs), line: lineOf(expr) } });
  }

  function handleCall(expr: PhpNode, file: FileCtx, ctx: GroupCtx): void {
    const chain = flattenChain(expr);
    if (!chain || chain.root.type !== "static") return;
    const facade = resolveClass(chain.root.class, file.names);
    const shortName = chain.root.class?.name?.replace(/^\\/, "");
    if (!ROUTE_FACADES.has(shortName) && !(facade && ROUTE_FACADES.has(facade))) return;

    // Attributes collected before the terminal verb/group call.
    const pre: GroupCtx = { ...ctx, middleware: [...ctx.middleware] };
    let i = 0;
    for (; i < chain.steps.length; i++) {
      const step = chain.steps[i];
      if (applyGroupAttr(step, pre, file)) continue;
      break;
    }
    const terminal = chain.steps[i];
    if (!terminal) return;
    const post = chain.steps.slice(i + 1);
    const line = terminal.line ?? lineOf(expr);

    if (terminal.name === "group") {
      handleGroup(terminal, pre, file);
      return;
    }
    if (terminal.name in VERBS) {
      addRoute(VERBS[terminal.name], terminal.args[0], terminal.args[1], pre, post, file, line);
      return;
    }
    if (terminal.name === "match") {
      const methods = stringList(terminal.args[0]).map((m) => m.toUpperCase() as HttpMethod);
      addRoute(methods, terminal.args[1], terminal.args[2], pre, post, file, line);
      return;
    }
    if (terminal.name === "view") {
      const view = stringValue(terminal.args[1]);
      addRoute(["GET", "HEAD"], terminal.args[0], null, pre, post, file, line, view ? { kind: "view", view } : { kind: "unknown" });
      return;
    }
    if (terminal.name === "redirect" || terminal.name === "permanentRedirect") {
      const to = stringValue(terminal.args[1]);
      addRoute(["ANY"], terminal.args[0], null, pre, post, file, line, to ? { kind: "redirect", to } : { kind: "unknown" });
      return;
    }
    if (terminal.name === "resource" || terminal.name === "apiResource") {
      addResource(terminal, pre, post, file, terminal.name === "apiResource");
      return;
    }
    if (terminal.name === "fallback") return;
    result.skipped.push({
      kind: "skipped",
      reason: `Unsupported route definition Route::${terminal.name}()`,
      source: { file: rel(file.abs), line },
    });
  }

  /** prefix/name/as/middleware/controller/namespace before group() or a verb. */
  function applyGroupAttr(step: ChainStep, ctx: GroupCtx, file: FileCtx): boolean {
    switch (step.name) {
      case "prefix": {
        const p = stringValue(step.args[0]);
        if (p !== null) ctx.prefix = joinUri(ctx.prefix, p);
        return true;
      }
      case "name":
      case "as": {
        const n = stringValue(step.args[0]);
        if (n !== null) ctx.namePrefix += n;
        return true;
      }
      case "middleware":
        ctx.middleware.push(...step.args.flatMap((a) => stringList(a)));
        return true;
      case "withoutMiddleware":
      case "domain":
      case "where":
      case "whereNumber":
      case "whereAlpha":
      case "whereUuid":
      case "scopeBindings":
      case "withoutScopedBindings":
        return true;
      case "controller": {
        const c = resolveClass(step.args[0], file.names);
        if (c) ctx.controller = c;
        return true;
      }
      case "namespace": {
        const ns = stringValue(step.args[0]);
        if (ns !== null) ctx.namespace = ns.replace(/^\\/, "");
        return true;
      }
      default:
        return false;
    }
  }

  function handleGroup(step: ChainStep, ctx: GroupCtx, file: FileCtx): void {
    let attrsNode: PhpNode | null = null;
    let body: PhpNode | null = null;
    if (step.args.length >= 2) {
      attrsNode = step.args[0];
      body = step.args[1];
    } else {
      body = step.args[0];
    }
    const inner: GroupCtx = { ...ctx, middleware: [...ctx.middleware] };
    if (attrsNode) {
      const attrs = arrayEntries(attrsNode);
      const p = stringValue(attrs.prefix);
      if (p !== null) inner.prefix = joinUri(inner.prefix, p);
      const as = stringValue(attrs.as);
      if (as !== null) inner.namePrefix += as;
      if (attrs.middleware) inner.middleware.push(...stringList(attrs.middleware));
      const ns = stringValue(attrs.namespace);
      if (ns !== null) inner.namespace = ns.replace(/^\\/, "");
    }
    if (!body) return;
    if (body.kind === "closure" || body.kind === "arrowfunc") {
      const stmts = body.kind === "closure" ? body.body?.children ?? [] : [{ kind: "expressionstatement", expression: body.body }];
      processStatements(stmts, file, inner);
      return;
    }
    // Route::group(base_path('routes/x.php')) or a string path
    const path = stringValue(body);
    const basePathArg =
      body.kind === "call" && body.what?.name === "base_path" ? stringValue(body.arguments?.[0]) : null;
    const target = basePathArg ? join(root, basePathArg) : path ? resolve(dirname(file.abs), path) : null;
    if (target && existsSync(target)) processFile(target, file.kind, inner);
    else result.skipped.push({ kind: "skipped", reason: "Route group with unresolvable body", source: { file: rel(file.abs), line: step.line } });
  }

  function resolveAction(node: PhpNode | null, ctx: GroupCtx, file: FileCtx): RouteAction {
    if (!node) return { kind: "unknown" };
    if (node.kind === "closure" || node.kind === "arrowfunc") {
      return { kind: "closure", node, ctx: file.names, file: rel(file.abs) };
    }
    if (node.kind === "array") {
      const items = node.items.map((it: PhpNode) => (it?.kind === "entry" ? it.value : it));
      // ['uses' => 'Controller@method', 'as' => 'name'] legacy style
      const entries = arrayEntries(node);
      if (entries.uses) return resolveAction(entries.uses, ctx, file);
      if (items.length === 2) {
        const cls = resolveClass(items[0], file.names);
        const method = stringValue(items[1]);
        if (cls && method) return { kind: "controller", class: cls, method };
      }
      return { kind: "unknown", raw: "array" };
    }
    const s = stringValue(node);
    if (s !== null) {
      if (s.includes("@")) {
        const [cls, method] = s.split("@");
        return { kind: "controller", class: qualifyLegacy(cls, ctx), method };
      }
      if (ctx.controller) return { kind: "controller", class: ctx.controller, method: s };
      return { kind: "controller", class: qualifyLegacy(s, ctx), method: "__invoke" };
    }
    const cls = resolveClass(node, file.names);
    if (cls) return { kind: "controller", class: cls, method: "__invoke" };
    return { kind: "unknown" };
  }

  function qualifyLegacy(cls: string, ctx: GroupCtx): string {
    if (cls.startsWith("\\")) return cls.slice(1);
    if (cls.startsWith("App\\")) return cls;
    const ns = ctx.namespace ?? "App\\Http\\Controllers";
    return `${ns}\\${cls}`;
  }

  function addRoute(
    methods: HttpMethod[],
    uriNode: PhpNode,
    actionNode: PhpNode | null,
    ctx: GroupCtx,
    post: ChainStep[],
    file: FileCtx,
    line: number | undefined,
    presetAction?: RouteAction,
  ): void {
    const uri = stringValue(uriNode);
    if (uri === null) {
      result.skipped.push({ kind: "skipped", reason: "Route with dynamic URI", source: { file: rel(file.abs), line } });
      return;
    }
    // Legacy: Route::get('/x', ['as' => 'name', 'uses' => 'C@m'])
    let legacyName: string | undefined;
    if (actionNode?.kind === "array") {
      const as = stringValue(arrayEntries(actionNode).as);
      if (as) legacyName = ctx.namePrefix + as;
    }
    const route: RawRoute = {
      methods,
      uri: joinUri(ctx.prefix, uri),
      middleware: [...ctx.middleware],
      action: presetAction ?? resolveAction(actionNode, ctx, file),
      file: rel(file.abs),
      line,
      routeFile: file.kind,
      name: legacyName,
    };
    for (const step of post) {
      if (step.name === "name") {
        const n = stringValue(step.args[0]);
        if (n !== null) route.name = ctx.namePrefix + n;
      } else if (step.name === "middleware") {
        route.middleware.push(...step.args.flatMap((a) => stringList(a)));
      }
    }
    result.routes.push(route);
  }

  function addResource(step: ChainStep, ctx: GroupCtx, post: ChainStep[], file: FileCtx, api: boolean): void {
    const base = stringValue(step.args[0]);
    const cls = resolveClass(step.args[1], file.names);
    if (!base || !cls) {
      result.skipped.push({ kind: "skipped", reason: "Resource route with dynamic name or controller", source: { file: rel(file.abs), line: step.line } });
      return;
    }
    let actions = api
      ? ["index", "store", "show", "update", "destroy"]
      : ["index", "create", "store", "show", "edit", "update", "destroy"];
    const extraMiddleware: string[] = [];
    let customNames: Record<string, string> = {};
    for (const p of post) {
      if (p.name === "only") actions = actions.filter((a) => stringList(p.args[0]).concat(p.args.slice(1).flatMap(stringList)).includes(a));
      if (p.name === "except") {
        const ex = p.args.flatMap(stringList);
        actions = actions.filter((a) => !ex.includes(a));
      }
      if (p.name === "middleware") extraMiddleware.push(...p.args.flatMap(stringList));
      if (p.name === "names") {
        const entries = arrayEntries(p.args[0]);
        customNames = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, stringValue(v) ?? ""]));
      }
    }

    // "photos.comments" -> photos/{photo}/comments
    const segments = base.split(".");
    const uriParts: string[] = [];
    segments.forEach((seg, idx) => {
      uriParts.push(seg);
      if (idx < segments.length - 1) uriParts.push(`{${singular(seg)}}`);
    });
    const collection = uriParts.join("/");
    const param = `{${singular(segments[segments.length - 1]).replace(/-/g, "_")}}`;
    const spec: Record<string, { methods: HttpMethod[]; uri: string }> = {
      index: { methods: ["GET", "HEAD"], uri: collection },
      create: { methods: ["GET", "HEAD"], uri: `${collection}/create` },
      store: { methods: ["POST"], uri: collection },
      show: { methods: ["GET", "HEAD"], uri: `${collection}/${param}` },
      edit: { methods: ["GET", "HEAD"], uri: `${collection}/${param}/edit` },
      update: { methods: ["PUT", "PATCH"], uri: `${collection}/${param}` },
      destroy: { methods: ["DELETE"], uri: `${collection}/${param}` },
    };
    for (const a of actions) {
      result.routes.push({
        methods: spec[a].methods,
        uri: joinUri(ctx.prefix, spec[a].uri),
        name: customNames[a] ? ctx.namePrefix + customNames[a] : `${ctx.namePrefix}${base}.${a}`,
        middleware: [...ctx.middleware, ...extraMiddleware],
        action: { kind: "controller", class: cls, method: a },
        file: rel(file.abs),
        line: step.line,
        routeFile: file.kind,
      });
    }
  }
}

export function joinUri(prefix: string, uri: string): string {
  const parts = [prefix, uri]
    .flatMap((p) => p.split("/"))
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts.join("/") : "/";
}

export function singular(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
