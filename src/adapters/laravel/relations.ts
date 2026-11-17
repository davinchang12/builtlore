/**
 * Relations between tables from Eloquent models: belongsTo, hasMany, hasOne,
 * belongsToMany. Keys left out follow Laravel's own rules (belongsTo('customer')
 * -> customer_id) and are marked as such. Older apps often declare relations only
 * here, not as foreign keys in migrations.
 */
import type { SkippedFact, SourceRef } from "../../core/types.js";
import type { ClassLocator } from "./controllers.js";
import { lineOf, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";
import type { ProcessReader } from "./process.js";

export interface ModelRelation {
  /** Table that holds the foreign key (the "many" side, or the side that belongs to the other). */
  from: string;
  column?: string;
  to: string;
  toColumn?: string;
  kind: "one-to-many" | "one-to-one" | "many-to-many";
  /** Pivot table of a many-to-many relation. */
  via?: string;
  /** "convention": a key left out, named by Laravel's rules. */
  by: "explicit" | "convention";
  /** "Order::items()" */
  method: string;
  source: SourceRef;
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

export function readModelRelations(reader: ProcessReader, locator: ClassLocator): { relations: ModelRelation[]; skipped: SkippedFact[] } {
  const relations: ModelRelation[] = [];
  const skipped: SkippedFact[] = [];
  for (const fq of reader.allModels()) {
    const loaded = locator.load(fq);
    if (!loaded) continue;
    const { names, ast, file } = loaded;
    const short = fq.split("\\").pop()!;
    const table = reader.tableForModel(fq);
    if (!table) continue;
    const pk = primaryKey(ast) ?? "id";
    const classOf = (n: PhpNode, ns: NameContext): string | null => {
      if (n?.kind === "staticlookup" && (n.offset?.name ?? "") === "class" && n.what?.kind === "name") {
        const raw = n.what.name;
        return raw === "self" || raw === "static" ? fq : resolveName(raw, n.what.resolution, ns);
      }
      const s = stringValue(n);
      return s ? s.replace(/^\\/, "") : null;
    };
    walk(ast, (n) => {
      if (n.kind !== "method") return;
      const method: string = n.name?.name ?? n.name;
      walk(n.body, (x) => {
        if (x.kind !== "call" || x.what?.kind !== "propertylookup" || x.what.what?.kind !== "variable" || x.what.what.name !== "this") return;
        const rel = x.what.offset?.name;
        if (!/^(belongsTo|hasMany|hasOne|belongsToMany)$/.test(rel ?? "")) return;
        const source = { file, line: lineOf(x) };
        const related = classOf(x.arguments?.[0], names);
        const relatedTable = related ? reader.tableForModel(related) : null;
        if (!related || !relatedTable) {
          skipped.push({ kind: "skipped", reason: `Relation ${short}::${method}() not readable: related model is not a known class`, source });
          return false;
        }
        const relatedShort = related.split("\\").pop()!;
        const arg = (i: number) => stringValue(x.arguments?.[i]);
        const label = `${short}::${method}()`;
        if (rel === "belongsTo") {
          const fk = arg(1);
          relations.push({ from: table, column: fk ?? `${snake(method)}_id`, to: relatedTable, toColumn: arg(2) ?? "id", kind: "one-to-many", by: fk ? "explicit" : "convention", method: label, source });
        } else if (rel === "hasMany" || rel === "hasOne") {
          const fk = arg(1);
          relations.push({ from: relatedTable, column: fk ?? `${snake(short)}_id`, to: table, toColumn: arg(2) ?? pk, kind: rel === "hasOne" ? "one-to-one" : "one-to-many", by: fk ? "explicit" : "convention", method: label, source });
        } else {
          // belongsToMany(Role::class, 'role_user', 'user_id', 'role_id')
          const pivot = arg(1) ?? [snake(short), snake(relatedShort)].sort().join("_");
          relations.push({ from: table, to: relatedTable, kind: "many-to-many", via: pivot, by: arg(1) ? "explicit" : "convention", method: label, source });
        }
        return false;
      });
      return false;
    });
  }
  return { relations, skipped };
}

function primaryKey(ast: PhpNode): string | null {
  let found: string | null = null;
  walk(ast, (n) => {
    if (found) return false;
    if (n.kind === "propertystatement") {
      for (const p of n.properties ?? []) if ((p.name?.name ?? p.name) === "primaryKey" && stringValue(p.value)) found = stringValue(p.value);
    }
  });
  return found;
}
