/**
 * Follow a route's handler (controller method or closure) and find what it
 * does next: which view it renders, where it redirects, and whether it can
 * fail back to the previous page (validation, withErrors, with('error')).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  flattenChain,
  lineOf,
  nameContext,
  parsePhp,
  resolveClass,
  stringValue,
  walk,
  type Chain,
  type NameContext,
  type PhpNode,
} from "./php.js";
import { requestKind } from "./validation.js";

export interface HandlerAnalysis {
  file?: string;
  line?: number;
  views: Array<{ engine: "blade" | "inertia"; name: string; line?: number }>;
  redirects: RedirectTarget[];
  /** Request validation present: Laravel redirects back with errors on failure. */
  validates: boolean;
  /** Returns JSON (response()->json, DataTables, ->toJson()): an AJAX/data endpoint. */
  returnsJson?: boolean;
  /** Returns a file (download, stream, Excel/PDF export). */
  returnsFile?: boolean;
}

export type RedirectTarget =
  | { kind: "name"; name: string; outcome?: "success" | "error"; line?: number; file?: string }
  | { kind: "uri"; uri: string; outcome?: "success" | "error"; line?: number; file?: string }
  | { kind: "action"; class: string; method: string; outcome?: "success" | "error"; line?: number; file?: string }
  | { kind: "back"; outcome?: "success" | "error"; line?: number; file?: string };

const ERROR_KEYS = /^(error|errors|danger|fail|failed|failure|warning)$/i;
const SUCCESS_KEYS = /^(success|status|message|info|ok)$/i;

/** Resolves PSR-4 class names to files using composer.json. */
export class ClassLocator {
  private psr4: Array<[string, string]> = [];
  private cache = new Map<string, { ast: PhpNode; names: NameContext; file: string } | null>();

  constructor(private root: string) {
    const composerPath = join(root, "composer.json");
    if (existsSync(composerPath)) {
      try {
        const composer = JSON.parse(readFileSync(composerPath, "utf8"));
        const map = { ...(composer.autoload?.["psr-4"] ?? {}), ...(composer["autoload-dev"]?.["psr-4"] ?? {}) };
        for (const [ns, dir] of Object.entries(map)) {
          const dirs = Array.isArray(dir) ? dir : [dir];
          for (const d of dirs) this.psr4.push([ns as string, String(d)]);
        }
      } catch {
        /* ignore malformed composer.json */
      }
    }
    if (!this.psr4.length) this.psr4.push(["App\\", "app/"]);
    this.psr4.sort((a, b) => b[0].length - a[0].length);
  }

  fileFor(fqcn: string): string | null {
    for (const [ns, dir] of this.psr4) {
      if (fqcn.startsWith(ns)) {
        const relPath = join(dir, fqcn.slice(ns.length).split("\\").join("/") + ".php");
        if (existsSync(join(this.root, relPath))) return relPath.split("\\").join("/");
      }
    }
    return null;
  }

  load(fqcn: string): { ast: PhpNode; names: NameContext; file: string } | null {
    if (this.cache.has(fqcn)) return this.cache.get(fqcn)!;
    const file = this.fileFor(fqcn);
    let entry: { ast: PhpNode; names: NameContext; file: string } | null = null;
    if (file) {
      const ast = parsePhp(readFileSync(join(this.root, file), "utf8"), file);
      if (ast) entry = { ast, names: nameContext(ast), file };
    }
    this.cache.set(fqcn, entry);
    return entry;
  }
}

export function analyzeControllerMethod(locator: ClassLocator, fqcn: string, method: string): HandlerAnalysis | null {
  const loaded = locator.load(fqcn);
  if (!loaded) return null;
  let found: PhpNode | null = null;
  walk(loaded.ast, (n) => {
    if (found) return false;
    if (n.kind === "method" && (n.name?.name ?? n.name) === method) {
      found = n;
      return false;
    }
  });
  if (!found) return { file: loaded.file, views: [], redirects: [], validates: false };
  const analysis = analyzeBody(found, loaded.names, loaded.file);
  analysis.file = loaded.file;
  analysis.line = lineOf(found);
  // FormRequest parameter => validation happens before the method body runs
  // (a model named PurchaseRequest is not one: the class must extend FormRequest)
  for (const p of (found as PhpNode).arguments ?? []) {
    const typeName: string | undefined = p.type?.name;
    if (!typeName) continue;
    const resolved = resolveClass(p.type, loaded.names) ?? typeName;
    if (requestKind(resolved, locator) === "form") analysis.validates = true;
  }
  return analysis;
}

/** The AST of a controller method, for further analysis. */
export function findMethod(locator: ClassLocator, fqcn: string, method: string): { node: PhpNode; names: NameContext; file: string } | null {
  const loaded = locator.load(fqcn);
  if (!loaded) return null;
  let found: PhpNode | null = null;
  walk(loaded.ast, (n) => {
    if (found) return false;
    if (n.kind === "method" && (n.name?.name ?? n.name) === method) {
      found = n;
      return false;
    }
  });
  return found ? { node: found, names: loaded.names, file: loaded.file } : null;
}

export function analyzeClosure(node: PhpNode, names: NameContext, file: string): HandlerAnalysis {
  const analysis = analyzeBody(node, names, file);
  analysis.file = file;
  analysis.line = lineOf(node);
  return analysis;
}

function analyzeBody(body: PhpNode, names: NameContext, file: string): HandlerAnalysis {
  const out: HandlerAnalysis = { views: [], redirects: [], validates: false, returnsJson: false, returnsFile: false };
  const consumed = new WeakSet<object>();

  walk(body, (n) => {
    if (n.kind !== "call" || consumed.has(n)) return;
    const chain = flattenChain(n);
    if (!chain) return;
    // Mark inner calls of this chain as consumed so we read each chain once.
    markInner(n, consumed);
    const line = lineOf(n);

    const rootName = chain.root.type === "function" ? chain.root.name : null;
    const rootStatic = chain.root.type === "static" ? resolveClass(chain.root.class, names) ?? "" : "";
    const first = chain.steps[0];

    // Views
    if (rootName === "view" && first.args[0]) {
      const v = stringValue(first.args[0]);
      if (v) out.views.push({ engine: "blade", name: v, line });
    }
    if (rootName === "inertia" && first.args[0]) {
      const v = stringValue(first.args[0]);
      if (v) out.views.push({ engine: "inertia", name: v, line });
    }
    if (/(^|\\)View$/.test(rootStatic) && first.name === "make") {
      const v = stringValue(first.args[0]);
      if (v) out.views.push({ engine: "blade", name: v, line });
    }
    if (/(^|\\)Inertia$/.test(rootStatic) && first.name === "render") {
      const v = stringValue(first.args[0]);
      if (v) out.views.push({ engine: "inertia", name: v, line });
    }

    // JSON / file responses
    const stepNames = chain.steps.map((s) => s.name);
    if (
      (rootName === "response" && stepNames.includes("json")) ||
      (/(^|\\)Response$/.test(rootStatic) && stepNames.includes("json")) ||
      rootName === "datatables" ||
      /(^|\\)(DataTables|Datatables)$/.test(rootStatic) ||
      stepNames.includes("toJson") ||
      (rootName === "json_encode")
    ) {
      out.returnsJson = true;
    }
    if (
      stepNames.some((n) => n === "download" || n === "streamDownload") ||
      (rootName === "response" && stepNames.includes("file"))
    ) {
      out.returnsFile = true;
    }
    if (/(^|\\)(Excel|PDF|Pdf|SnappyPdf)$/.test(rootStatic) && stepNames.some((n) => /^(download|stream|export)$/.test(n))) {
      out.returnsFile = true;
    }

    // Validation
    if (chain.steps.some((s) => s.name === "validate" || s.name === "validateWithBag")) out.validates = true;
    if (/(^|\\)Validator$/.test(rootStatic) && chain.steps.some((s) => s.name === "validate")) out.validates = true;

    // Redirects
    const target = redirectTarget(chain, rootName, rootStatic, names);
    if (target) {
      target.line = line;
      target.file = file;
      target.outcome = outcomeOf(chain);
      out.redirects.push(target);
    }
  });
  return out;
}

function markInner(n: PhpNode, consumed: WeakSet<object>): void {
  let cur = n.what?.what;
  while (cur && cur.kind === "call") {
    consumed.add(cur);
    cur = cur.what?.what;
  }
}

function redirectTarget(chain: Chain, rootName: string | null, rootStatic: string, names: NameContext): RedirectTarget | null {
  const steps = chain.steps;
  const isRedirectFacade = /(^|\\)Redirect$/.test(rootStatic);
  if (rootName === "to_route") {
    const name = stringValue(steps[0].args[0]);
    return name ? { kind: "name", name } : null;
  }
  if (rootName === "back") return { kind: "back" };
  if (rootName !== "redirect" && !isRedirectFacade) return null;

  // redirect('/path') or Redirect::to('/path')
  const startIdx = rootName === "redirect" ? 0 : -1;
  if (rootName === "redirect" && steps[0].args[0]) {
    const uri = stringValue(steps[0].args[0]);
    if (uri !== null) return { kind: "uri", uri };
  }
  const tail = rootName === "redirect" ? steps.slice(startIdx + 1) : steps;
  for (const s of tail) {
    switch (s.name) {
      case "route": {
        const name = stringValue(s.args[0]);
        if (name) return { kind: "name", name };
        break;
      }
      case "to":
      case "intended":
      case "away": {
        const arg = s.args[0];
        const uri = stringValue(arg);
        if (uri !== null) return { kind: "uri", uri };
        const inner = arg?.kind === "call" ? flattenChain(arg) : null;
        if (inner?.root.type === "function" && inner.root.name === "route") {
          const name = stringValue(inner.steps[0].args[0]);
          if (name) return { kind: "name", name };
        }
        break;
      }
      case "action": {
        const arg = s.args[0];
        if (arg?.kind === "array" && arg.items.length === 2) {
          const items = arg.items.map((it: PhpNode) => (it?.kind === "entry" ? it.value : it));
          const cls = resolveClass(items[0], names);
          const method = stringValue(items[1]);
          if (cls && method) return { kind: "action", class: cls, method };
        }
        break;
      }
      case "back":
      case "refresh":
        return { kind: "back" };
    }
  }
  return null;
}

function outcomeOf(chain: Chain): "success" | "error" | undefined {
  for (const s of chain.steps) {
    if (s.name === "withErrors") return "error";
    if (s.name === "with") {
      const key = stringValue(s.args[0]);
      if (key && ERROR_KEYS.test(key)) return "error";
      if (key && SUCCESS_KEYS.test(key)) return "success";
    }
  }
  return undefined;
}

export function repoRelative(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}
