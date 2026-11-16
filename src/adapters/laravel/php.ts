/**
 * Small helpers on top of php-parser (glayzzle). AST nodes are typed loosely on
 * purpose: php-parser's own typings are incomplete, and we only read a handful
 * of node kinds.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Engine = require("php-parser");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PhpNode = any;

const engine = new Engine({
  parser: { php8: true, suppressErrors: true, extractDoc: false },
  ast: { withPositions: true },
  lexer: { short_tags: true },
});

export function parsePhp(code: string, filename: string): PhpNode | null {
  try {
    return engine.parseCode(code, filename);
  } catch {
    return null;
  }
}

export function lineOf(node: PhpNode): number | undefined {
  return node?.loc?.start?.line;
}

/** Literal string value, or concatenation of literal strings. `null` if dynamic. */
export function stringValue(node: PhpNode): string | null {
  if (!node) return null;
  if (node.kind === "string") return node.value;
  if (node.kind === "nowdoc") return node.value;
  if (node.kind === "bin" && node.type === ".") {
    const l = stringValue(node.left);
    const r = stringValue(node.right);
    return l !== null && r !== null ? l + r : null;
  }
  if (node.kind === "magic" && node.value === "__DIR__") return "__DIR__";
  return null;
}

/** Array of literal strings (or a single literal string) -> string[] */
export function stringList(node: PhpNode): string[] {
  if (!node) return [];
  const s = stringValue(node);
  if (s !== null) return [s];
  if (node.kind === "array") {
    return node.items
      .map((it: PhpNode) => stringValue(it?.kind === "entry" ? it.value : it))
      .filter((v: string | null): v is string => v !== null);
  }
  return [];
}

/** Read a PHP array literal with string keys into a plain object of nodes. */
export function arrayEntries(node: PhpNode): Record<string, PhpNode> {
  const out: Record<string, PhpNode> = {};
  if (!node || node.kind !== "array") return out;
  for (const it of node.items) {
    if (it?.kind === "entry" && it.key) {
      const k = stringValue(it.key);
      if (k !== null) out[k] = it.value;
    }
  }
  return out;
}

export interface ChainStep {
  name: string;
  args: PhpNode[];
  line?: number;
}

export interface Chain {
  root:
    | { type: "static"; class: PhpNode }
    | { type: "function"; name: string }
    | { type: "other" };
  steps: ChainStep[];
}

/**
 * Flatten a fluent call chain into ordered steps.
 *   Route::prefix('a')->name('b.')->group(fn)
 *   -> root static Route, steps [prefix('a'), name('b.'), group(fn)]
 */
export function flattenChain(node: PhpNode): Chain | null {
  if (!node || node.kind !== "call") return null;
  const what = node.what;
  if (what.kind === "propertylookup" || what.kind === "nullsafepropertylookup") {
    const inner = what.what?.kind === "call" ? flattenChain(what.what) : null;
    const name = identName(what.offset);
    if (!name) return null;
    const step = { name, args: node.arguments ?? [], line: lineOf(node) };
    if (inner) {
      inner.steps.push(step);
      return inner;
    }
    return { root: { type: "other" }, steps: [step] };
  }
  if (what.kind === "staticlookup") {
    const name = identName(what.offset);
    if (!name) return null;
    return {
      root: { type: "static", class: what.what },
      steps: [{ name, args: node.arguments ?? [], line: lineOf(node) }],
    };
  }
  if (what.kind === "name") {
    return {
      root: { type: "function", name: what.name.replace(/^\\/, "") },
      steps: [{ name: what.name.replace(/^\\/, ""), args: node.arguments ?? [], line: lineOf(node) }],
    };
  }
  return null;
}

function identName(n: PhpNode): string | null {
  if (!n) return null;
  if (n.kind === "identifier") return n.name;
  if (typeof n.name === "string") return n.name;
  return null;
}

/** Namespace + `use` imports of a file, for resolving class names. */
export interface NameContext {
  namespace: string;
  uses: Map<string, string>; // alias -> FQCN
}

export function nameContext(ast: PhpNode): NameContext {
  const ctx: NameContext = { namespace: "", uses: new Map() };
  const visit = (nodes: PhpNode[]) => {
    for (const n of nodes ?? []) {
      if (n.kind === "namespace") {
        ctx.namespace = (n.name ?? "").replace(/^\\/, "");
        visit(n.children);
      } else if (n.kind === "usegroup") {
        const prefix = n.name ? n.name.replace(/^\\/, "") + "\\" : "";
        for (const item of n.items ?? []) {
          const fqcn = (prefix + item.name).replace(/^\\/, "");
          const alias = item.alias?.name ?? fqcn.split("\\").pop()!;
          ctx.uses.set(alias, fqcn);
        }
      }
    }
  };
  visit(ast?.children ?? []);
  return ctx;
}

/** Resolve a class reference (name node, `X::class`, or string) to a FQCN. */
export function resolveClass(node: PhpNode, ctx: NameContext): string | null {
  if (!node) return null;
  if (node.kind === "staticlookup" && identName(node.offset) === "class") {
    return resolveClass(node.what, ctx);
  }
  if (node.kind === "name") {
    return resolveName(node.name, node.resolution, ctx);
  }
  const s = stringValue(node);
  if (s !== null) return s.replace(/^\\/, "");
  return null;
}

export function resolveName(name: string, resolution: string | undefined, ctx: NameContext): string {
  if (name.startsWith("\\") || resolution === "fqn") return name.replace(/^\\/, "");
  const [first, ...rest] = name.split("\\");
  const imported = ctx.uses.get(first);
  if (imported) return [imported, ...rest].join("\\");
  return ctx.namespace ? `${ctx.namespace}\\${name}` : name;
}

/** Short class name: App\Http\Controllers\BookingController -> BookingController */
export function shortClass(fqcn: string): string {
  return fqcn.split("\\").pop() ?? fqcn;
}

/** Depth-first walk over every AST node. Return `false` from fn to skip children. */
export function walk(node: PhpNode, fn: (n: PhpNode, parent: PhpNode | null) => boolean | void, parent: PhpNode | null = null): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) walk(c, fn, parent);
    return;
  }
  if (typeof node.kind !== "string") return;
  if (fn(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    const v = node[key];
    if (v && typeof v === "object") walk(v, fn, node);
  }
}
