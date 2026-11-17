/**
 * Inertia pages: where a page component sends the user, from route('name') in
 * resources/js/Pages/<Name>.vue|jsx|tsx|js|svelte, with the call around it:
 *   router.post(route('orders.store'), …) / form.put(route('orders.update', id)) / useForm(…).delete(route(…))
 *   <Link :href="route('orders.show', id)"> / <Link href={route('orders.show', id)}> / router.visit(route(…))
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface InertiaLink {
  route: string;
  method: string;
  file: string;
  line: number;
}

const EXT = [".vue", ".jsx", ".tsx", ".js", ".ts", ".svelte"];

export function inertiaPageFile(root: string, name: string): string | null {
  for (const dir of ["resources/js/Pages", "resources/js/pages", "resources/ts/Pages"]) {
    for (const ext of EXT) {
      const rel = `${dir}/${name}${ext}`;
      if (existsSync(join(root, rel))) return rel;
    }
  }
  return null;
}

export function inertiaLinks(root: string, name: string): InertiaLink[] {
  const file = inertiaPageFile(root, name);
  if (!file) return [];
  const src = readFileSync(join(root, file), "utf8");
  const out: InertiaLink[] = [];
  for (const m of src.matchAll(/route\(\s*['"]([\w.-]+)['"]/g)) {
    const before = src.slice(Math.max(0, m.index! - 80), m.index!);
    // The nearest call before route(…): .post( / .put( / .patch( / .delete( / .get( / .visit(
    const call = /\.(post|put|patch|delete|get|visit)\s*\(\s*$/i.exec(before);
    const method = call ? (call[1].toLowerCase() === "visit" ? "GET" : call[1].toUpperCase()) : "GET";
    out.push({ route: m[1], method, file, line: src.slice(0, m.index!).split("\n").length });
  }
  return out;
}
