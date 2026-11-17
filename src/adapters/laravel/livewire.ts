/**
 * Livewire components (v2 app/Http/Livewire, v3 app/Livewire): a full-page component
 * routed with Route::get('/x', Component::class) is a page; the methods its view calls
 * (wire:click="approve", wire:submit="save") are the actions on that page.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClassLocator } from "./controllers.js";
import { lineOf, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";
import { viewFile } from "./blade.js";

export interface LivewireComponent {
  fqcn: string;
  /** "orders.table" for App\Livewire\Orders\Table, as used in <livewire:orders.table />. */
  alias: string;
  file: string;
  view?: string;
  viewPath?: string;
  /** Methods the view calls, with their node. */
  actions: Array<{ method: string; node: PhpNode; line?: number }>;
  names: NameContext;
  /** Typed public properties: order -> App\Models\Order. */
  props: Map<string, string>;
}

const LIFECYCLE = /^(render|mount|boot|booted|hydrate\w*|dehydrate\w*|updat(ing|ed)\w*|rules|messages|validationAttributes|placeholder|exception|getListeners)$/;
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").toLowerCase();

export function readLivewire(root: string, locator: ClassLocator): Map<string, LivewireComponent> {
  const byClass = new Map<string, LivewireComponent>();
  for (const [dir, ns] of [["app/Livewire", "App\\Livewire\\"], ["app/Http/Livewire", "App\\Http\\Livewire\\"]] as const) {
    const visit = (rel: string, nsPrefix: string, parts: string[]) => {
      const abs = join(root, rel);
      if (!existsSync(abs)) return;
      for (const name of readdirSync(abs).sort()) {
        const child = `${rel}/${name}`;
        if (statSync(join(root, child)).isDirectory()) visit(child, `${nsPrefix}${name}\\`, [...parts, name]);
        else if (name.endsWith(".php")) {
          const cls = name.slice(0, -4);
          const fqcn = `${nsPrefix}${cls}`;
          const comp = readComponent(root, locator, fqcn, [...parts, cls].map(kebab).join("."));
          if (comp) byClass.set(fqcn, comp);
        }
      }
    };
    visit(dir, ns, []);
  }
  return byClass;
}

function readComponent(root: string, locator: ClassLocator, fqcn: string, alias: string): LivewireComponent | null {
  const loaded = locator.load(fqcn);
  if (!loaded) return null;
  const { ast, names, file } = loaded;
  let cls: PhpNode = null;
  walk(ast, (n) => {
    if (n.kind === "class") {
      cls = n;
      return false;
    }
  });
  if (!cls) return null;
  const c = cls as PhpNode;
  const parent = c.extends?.name ? resolveName(c.extends.name, c.extends.resolution, names) : "";
  if (!/(^|\\)Livewire\\Component$|^Livewire\\/.test(parent) && !/Component$/.test(parent)) return null;
  // The view: render() { return view('livewire.orders.table') }, else Livewire's default
  let view: string | undefined;
  const methods = new Map<string, PhpNode>();
  const props = new Map<string, string>();
  for (const m of c.body ?? []) {
    if (m.kind === "method") methods.set(m.name?.name ?? m.name, m);
    if (m.kind === "propertystatement") {
      for (const p of m.properties ?? []) {
        const pn = p.name?.name ?? p.name;
        if (p.type?.name && typeof pn === "string") props.set(pn, resolveName(p.type.name, p.type.resolution, names));
      }
    }
  }
  walk(methods.get("render"), (n) => {
    if (view || n.kind !== "call") return;
    const fn = n.what?.kind === "name" ? n.what.name.replace(/^\\/, "") : null;
    if (fn === "view" && n.arguments?.[0]) view = stringValue(n.arguments[0]) ?? undefined;
    if (n.what?.offset?.name === "make" && /(^|\\)View$/.test(n.what.what?.name ?? "")) view = stringValue(n.arguments?.[0]) ?? undefined;
  });
  view ??= `livewire.${alias}`;
  const viewPath = viewFile(root, view) ?? undefined;
  // Methods the view calls
  const called = new Set<string>();
  if (viewPath) {
    const src = readFileSync(join(root, viewPath), "utf8");
    for (const m of src.matchAll(/wire:(?:click|submit|change|keydown|keyup|blur|dblclick)(?:\.[\w.-]+)?\s*=\s*["']\s*([A-Za-z_]\w*)/g)) {
      if (!m[1].startsWith("$")) called.add(m[1]);
    }
  }
  const actions = [...called]
    .filter((name) => methods.has(name) && !LIFECYCLE.test(name))
    .map((name) => ({ method: name, node: methods.get(name)!, line: lineOf(methods.get(name)) }));
  return { fqcn, alias, file, view, viewPath, actions, names, props };
}

/** <livewire:orders.table /> / @livewire('orders.table') / <livewire:orders.table … > in a view's text. */
export function embeddedComponents(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/<livewire:([\w.-]+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/@livewire\s*\(\s*['"]([\w.-]+)['"]/g)) out.add(m[1]);
  return [...out];
}
