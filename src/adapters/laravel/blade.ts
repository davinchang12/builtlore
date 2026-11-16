/**
 * Read Blade views and find where the user can go next: links (<a href>) and
 * forms (<form action>) that point at routes. Partials pulled in with
 * @include are part of the page; layouts pulled in with @extends are shared
 * navigation and are counted separately so they do not flood every flow.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BladeTarget =
  | { kind: "name"; name: string }
  | { kind: "uri"; uri: string }
  | { kind: "action"; raw: string };

export interface BladeLink {
  target: BladeTarget;
  /** ref: route()/url() used outside <a href> and <form action> (scripts, data-* attributes). */
  trigger: "link" | "submit" | "ref";
  /** HTTP method for forms, after @method()/_method spoofing. */
  method?: string;
  file: string;
  line: number;
  /** Raw conditions around the link: @if/@elseif expressions, "@role('x')", "@can('x')", "!(expr)" for @unless. */
  when?: string[];
}

export interface BladeAnalysis {
  file: string | null;
  links: BladeLink[];
  layouts: string[];
}

const VIEW_ROOT = "resources/views";

export function viewFile(root: string, name: string): string | null {
  if (name.includes("::")) return null; // package / namespaced views
  const base = name.split(".").join("/");
  for (const ext of [".blade.php", ".php"]) {
    const rel = `${VIEW_ROOT}/${base}${ext}`;
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

export class BladeReader {
  private cache = new Map<string, { links: BladeLink[]; includes: string[]; extends: string[] }>();

  constructor(private root: string) {}

  analyze(name: string): BladeAnalysis {
    const file = viewFile(this.root, name);
    if (!file) return { file: null, links: [], layouts: [] };
    const links: BladeLink[] = [];
    const layouts: string[] = [];

    // The page itself + its @include partials (depth-limited, cycle-safe)
    const seen = new Set<string>();
    const visit = (viewName: string, depth: number) => {
      if (seen.has(viewName) || depth > 5) return;
      seen.add(viewName);
      const parsed = this.parse(viewName);
      if (!parsed) return;
      links.push(...parsed.links);
      for (const inc of parsed.includes) visit(inc, depth + 1);
      for (const ext of parsed.extends) {
        if (!layouts.includes(ext)) layouts.push(ext);
      }
    };
    visit(name, 0);

    return { file, links, layouts };
  }

  /** Links in a layout and everything it extends/includes (counted, not drawn). */
  layoutLinkCount(name: string): number {
    let count = 0;
    const seen = new Set<string>();
    const visit = (viewName: string, depth: number) => {
      if (seen.has(viewName) || depth > 5) return;
      seen.add(viewName);
      const parsed = this.parse(viewName);
      if (!parsed) return;
      count += parsed.links.length;
      for (const inc of parsed.includes) visit(inc, depth + 1);
      for (const ext of parsed.extends) visit(ext, depth + 1);
    };
    visit(name, 0);
    return count;
  }

  private parse(name: string): { links: BladeLink[]; includes: string[]; extends: string[] } | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const file = viewFile(this.root, name);
    if (!file) return null;
    const src = readFileSync(join(this.root, file), "utf8");
    const result = { links: parseLinks(src, file), includes: parseIncludes(src), extends: parseExtends(src) };
    this.cache.set(name, result);
    return result;
  }
}

function lineAt(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function parseIncludes(src: string): string[] {
  const out: string[] = [];
  const re = /@(include|includeIf|includeFirst|each)\s*\(\s*(?:\[\s*)?['"]([^'"]+)['"]/g;
  const reWhen = /@(includeWhen|includeUnless)\s*\([^,]+,\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(m[2]);
  for (const m of src.matchAll(reWhen)) out.push(m[2]);
  // <x-...> anonymous components living in resources/views/components
  for (const m of src.matchAll(/<x-([a-z0-9\-.]+)[\s/>]/gi)) {
    if (!m[1].includes("::") && !m[1].endsWith("-layout")) out.push(`components.${m[1]}`);
  }
  return out;
}

function parseExtends(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/@extends\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  // Component layouts: <x-app-layout> -> components.app-layout or layouts.app
  for (const m of src.matchAll(/<x-([a-z0-9\-]+)-layout[\s>]/gi)) {
    out.push(`components.${m[1]}-layout`, `layouts.${m[1]}`);
  }
  return out;
}

/** Extract target from an attribute value: {{ route('x') }}, {{ url('/x') }}, {{ action(...) }}, /literal */
export function parseTarget(value: string): BladeTarget | null {
  const route = value.match(/route\(\s*['"]([^'"]+)['"]/);
  if (route) return { kind: "name", name: route[1] };
  const url = value.match(/url\(\s*['"]([^'"]*)['"]/);
  if (url) return { kind: "uri", uri: url[1] || "/" };
  const action = value.match(/action\(\s*([^)]*)\)/);
  if (action) return { kind: "action", raw: action[1] };
  const literal = value.trim();
  if (literal.startsWith("/") && !literal.startsWith("//") && !literal.includes("{{")) {
    return { kind: "uri", uri: literal.split(/[?#]/)[0] };
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  // Values may contain quotes inside {{ }} so match quote-aware.
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

function parseLinks(raw: string, file: string): BladeLink[] {
  const out: BladeLink[] = [];
  const src = stripBladeComments(raw);
  const covered: Array<[number, number]> = [];

  // <a ... href="...">
  for (const m of src.matchAll(/<a\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const href = attr(m[0], "href");
    if (!href) continue;
    const target = parseTarget(href);
    if (target) {
      out.push({ target, trigger: "link", file, line: lineAt(src, m.index ?? 0), _at: m.index ?? 0 } as BladeLink);
      covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }

  // <form ... action="..." method="..."> ... </form>
  for (const m of src.matchAll(/<form\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/form>/gi)) {
    const open = `<form${m[1]}>`;
    const action = attr(open, "action");
    if (!action) continue;
    const target = parseTarget(action);
    if (!target) continue;
    let method = (attr(open, "method") ?? "GET").toUpperCase();
    const body = m[2];
    const spoof =
      body.match(/@method\s*\(\s*['"](\w+)['"]\s*\)/) ??
      body.match(/name=["']_method["'][^>]*value=["'](\w+)["']/i) ??
      body.match(/value=["'](\w+)["'][^>]*name=["']_method["']/i);
    if (spoof) method = spoof[1].toUpperCase();
    out.push({ target, trigger: "submit", method, file, line: lineAt(src, m.index ?? 0), _at: m.index ?? 0 } as BladeLink);
    covered.push([m.index ?? 0, (m.index ?? 0) + open.length]);
  }

  // Everything else: route('x') / url('/x') in scripts, data-* attributes, onclick, etc.
  for (const m of src.matchAll(/\b(route|url)\(\s*['"]([^'"]*)['"]/g)) {
    const idx = m.index ?? 0;
    if (covered.some(([a, b]) => idx >= a && idx < b)) continue;
    const before = src.slice(Math.max(0, idx - 2), idx);
    if (before.endsWith(":") || before.endsWith(">") || before.endsWith("$")) continue; // Storage::url(), $x->url()
    if (m[1] === "url" && m[2] && !m[2].startsWith("/")) continue;
    const target: BladeTarget = m[1] === "route" ? { kind: "name", name: m[2] } : { kind: "uri", uri: m[2] || "/" };
    out.push({ target, trigger: "ref", file, line: lineAt(src, idx), _at: idx } as BladeLink);
  }

  // URLs written by hand in scripts: '/master/items/' + id (+ '/approve'), with type/method nearby.
  for (const block of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = block[1];
    const offset = (block.index ?? 0) + block[0].indexOf(body);
    const re = /(['"`])(\/[A-Za-z0-9_\-./]*)\1(?:\s*\+\s*[\w$.[\]()]+(?:\s*\+\s*(['"`])([A-Za-z0-9_\-./]*)\3)?)?/g;
    for (const m of body.matchAll(re)) {
      const [whole, , head, , tail] = m;
      if (head.length < 2 || /\.(js|css|png|jpe?g|svg|gif|ico|woff2?|json)$/i.test(head)) continue;
      const concatenated = whole.includes("+");
      const uri = concatenated ? `${head.replace(/\/$/, "")}/{x}${tail ? "/" + tail.replace(/^\//, "") : ""}` : head;
      const after = body.slice((m.index ?? 0) + whole.length, (m.index ?? 0) + whole.length + 200);
      const hint = after.match(/\b(?:type|method)\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i) ?? after.match(/_method['"]?\s*[:,]\s*['"](PUT|PATCH|DELETE)['"]/i);
      out.push({
        target: { kind: "uri", uri },
        trigger: "ref",
        method: hint ? hint[1].toUpperCase() : undefined,
        file,
        line: lineAt(src, offset + (m.index ?? 0)),
        _at: offset + (m.index ?? 0),
      } as BladeLink);
    }
  }
  const conditions = conditionMap(src);
  for (const l of out as Array<BladeLink & { _at?: number }>) {
    const at = l._at ?? offsetOfLine(src, l.line);
    delete l._at;
    const when = conditions(at);
    if (when.length) l.when = when;
  }
  return out;
}

/**
 * Conditions in effect at each offset of a Blade view. @else drops the
 * condition (its negation is not useful for documentation); @unless(x) is "!(x)".
 */
export function conditionMap(src: string): (offset: number) => string[] {
  type Frame = { start: number; end: number; conds: string[] };
  const spans: Frame[] = [];
  const stack: Array<{ kind: string; conds: string[]; start: number }> = [];
  const re = /@(if|elseif|else|endif|unless|endunless|can|elsecan|cannot|endcan|endcannot|role|hasrole|hasanyrole|hasallroles|endrole|endhasrole|endhasanyrole|endhasallroles)\b/g;
  const close = (end: number) => {
    const top = stack[stack.length - 1];
    if (top && top.conds.length) spans.push({ start: top.start, end, conds: top.conds });
  };
  for (const m of src.matchAll(re)) {
    const kind = m[1];
    const at = m.index ?? 0;
    const after = at + m[0].length;
    const arg = /^\s*\(/.test(src.slice(after, after + 20)) ? balanced(src, src.indexOf("(", after)) : null;
    const argEnd = arg ? arg.end : after;
    if (kind === "if" || kind === "unless") {
      if (!arg) continue;
      stack.push({ kind: "if", conds: [kind === "unless" ? `!(${arg.text})` : arg.text], start: argEnd });
    } else if (kind === "elseif" || kind === "elsecan") {
      close(at);
      const top = stack[stack.length - 1];
      if (top) {
        top.conds = arg ? [kind === "elsecan" ? `@can(${arg.text})` : arg.text] : [];
        top.start = argEnd;
      }
    } else if (kind === "else") {
      close(at);
      const top = stack[stack.length - 1];
      if (top) {
        top.conds = [];
        top.start = after;
      }
    } else if (kind === "can" || kind === "role" || kind === "hasrole" || kind === "hasanyrole" || kind === "hasallroles") {
      if (!arg) continue;
      stack.push({ kind: "block", conds: [`@${kind}(${arg.text})`], start: argEnd });
    } else if (kind === "cannot") {
      if (!arg) continue;
      stack.push({ kind: "block", conds: [], start: argEnd });
    } else {
      // any @end*
      close(at);
      stack.pop();
    }
  }
  return (offset: number) => spans.filter((s) => offset >= s.start && offset < s.end).flatMap((s) => s.conds);
}

function balanced(src: string, open: number): { text: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length && i < open + 2000; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { text: src.slice(open + 1, i).trim(), end: i + 1 };
  }
  return null;
}

function offsetOfLine(src: string, line: number): number {
  let idx = 0;
  for (let l = 1; l < line; l++) {
    const next = src.indexOf("\n", idx);
    if (next < 0) break;
    idx = next + 1;
  }
  return idx;
}

/** Blank out {{-- comments --}} while keeping offsets (and so line numbers) intact. */
function stripBladeComments(src: string): string {
  return src.replace(/\{\{--[\s\S]*?--\}\}/g, (c) => c.replace(/[^\n]/g, " "));
}
