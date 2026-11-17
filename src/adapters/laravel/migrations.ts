/**
 * Data dictionary from migrations: Schema::create / Schema::table (columns
 * added, changed, renamed, dropped), foreign keys, enums, comments. Migrations
 * are replayed oldest first (file name order), reading only up().
 * Anything that is not a plain Blueprint call (raw SQL, loops, table names in
 * variables) is reported, never guessed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DataColumn, DataTable, SkippedFact } from "../../core/types.js";
import { flattenChain, lineOf, nameContext, parsePhp, phpText, resolveClass, stringList, stringValue, walk, type ChainStep, type NameContext, type PhpNode } from "./php.js";

export interface MigrationResult {
  tables: DataTable[];
  skipped: SkippedFact[];
  files: number;
}

const INCREMENTS = /^(increments|bigIncrements|smallIncrements|tinyIncrements|mediumIncrements|integerIncrements)$/;
const SIZED = /^(string|char)$/;
const PRECISION = /^(decimal|unsignedDecimal|float|double)$/;
const PLAIN_TYPES = new Set([
  "text", "mediumText", "longText", "tinyText", "integer", "tinyInteger", "smallInteger", "mediumInteger", "bigInteger",
  "unsignedInteger", "unsignedTinyInteger", "unsignedSmallInteger", "unsignedMediumInteger", "unsignedBigInteger",
  "boolean", "date", "dateTime", "dateTimeTz", "time", "timeTz", "timestamp", "timestampTz", "year", "binary", "json", "jsonb",
  "uuid", "ulid", "ipAddress", "macAddress", "geometry", "point", "lineString", "polygon", "geography", "vector",
  "string", "char", "decimal", "unsignedDecimal", "float", "double",
]);
const IGNORED = /^(engine|charset|collation|temporary|dropIndex|dropUnique|dropPrimary|dropFullText|dropSpatialIndex|renameIndex|fullText|spatialIndex)$/;

/** Read database/migrations/*.php. `tableForModel` resolves foreignIdFor(Model::class). */
export function readMigrations(
  root: string,
  helpers: { modelForTable(table: string): string | null; tableForModel(fqcn: string): string | null },
): MigrationResult {
  const dir = join(root, "database", "migrations");
  const out: MigrationResult = { tables: [], skipped: [], files: 0 };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith(".php")).sort();
  const tables = new Map<string, DataTable>();

  for (const name of files) {
    const file = `database/migrations/${name}`;
    const ast = parsePhp(readFileSync(join(dir, name), "utf8"), file);
    if (!ast) {
      out.skipped.push({ kind: "skipped", reason: "Migration could not be parsed", source: { file } });
      continue;
    }
    out.files++;
    const names = nameContext(ast);
    let up: PhpNode = null;
    walk(ast, (n) => {
      if (up) return false;
      if (n.kind === "method" && (n.name?.name ?? n.name) === "up") {
        up = n;
        return false;
      }
    });
    if (!up) {
      out.skipped.push({ kind: "skipped", reason: "Migration has no up() method", source: { file } });
      continue;
    }
    const ctx: Ctx = { file, migration: name.replace(/\.php$/, ""), names, tables, skipped: out.skipped, helpers };
    walk(up, (n) => {
      if (n.kind !== "call") return;
      const handled = readSchemaCall(n, ctx);
      if (handled) return false;
      // Raw SQL in a migration changes the schema in ways builtlore does not read.
      const chain = flattenChain(n);
      const root = chain?.root.type === "static" ? resolveClass(chain.root.class, names) ?? "" : "";
      if (/(^|\\)DB$/.test(root) && chain!.steps.some((s) => /^(statement|unprepared|raw)$/.test(s.name))) {
        out.skipped.push({ kind: "skipped", reason: `Raw SQL in a migration is not read: ${phpText(n).slice(0, 120)}`, source: { file, line: lineOf(n) } });
        return false;
      }
    });
  }
  for (const t of tables.values()) {
    const model = helpers.modelForTable(t.name);
    if (model) t.model = model;
  }
  out.tables = [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface Ctx {
  file: string;
  migration: string;
  names: NameContext;
  tables: Map<string, DataTable>;
  skipped: SkippedFact[];
  helpers: { modelForTable(table: string): string | null; tableForModel(fqcn: string): string | null };
}

/** Schema::create/table/rename/drop… Returns true when the call was a Schema call. */
function readSchemaCall(n: PhpNode, ctx: Ctx): boolean {
  const chain = flattenChain(n);
  if (!chain || chain.root.type !== "static") return false;
  const cls = resolveClass(chain.root.class, ctx.names) ?? "";
  if (!/(^|\\)Schema$/.test(cls)) return false;
  // Schema::connection('x')->create(...): the last step is the operation
  const op = chain.steps[chain.steps.length - 1];
  const line = lineOf(n);
  const src = { file: ctx.file, line };
  const tableName = stringValue(op.args[0]);
  const needsTable = /^(create|table|drop|dropIfExists|rename|dropColumns)$/.test(op.name);
  if (needsTable && tableName === null) {
    ctx.skipped.push({ kind: "skipped", reason: `Table name not readable in migration: ${phpText(n).slice(0, 120)}`, source: src });
    return true;
  }
  switch (op.name) {
    case "create": {
      const t: DataTable = { name: tableName!, columns: [], migrations: [ctx.migration], source: src };
      ctx.tables.set(t.name, t);
      readBlueprint(op.args[1], t, ctx);
      return true;
    }
    case "table": {
      let t = ctx.tables.get(tableName!);
      if (!t) {
        t = { name: tableName!, columns: [], migrations: [], partial: true, source: src };
        ctx.tables.set(t.name, t);
      }
      if (!t.migrations.includes(ctx.migration)) t.migrations.push(ctx.migration);
      readBlueprint(op.args[1], t, ctx);
      return true;
    }
    case "rename": {
      const to = stringValue(op.args[1]);
      const t = ctx.tables.get(tableName!);
      if (!to) {
        ctx.skipped.push({ kind: "skipped", reason: `New table name not readable: ${phpText(n)}`, source: src });
      } else if (t) {
        ctx.tables.delete(t.name);
        t.name = to;
        if (!t.migrations.includes(ctx.migration)) t.migrations.push(ctx.migration);
        ctx.tables.set(to, t);
        for (const other of ctx.tables.values()) for (const c of other.columns) if (c.references?.table === tableName) c.references.table = to;
      }
      return true;
    }
    case "drop":
    case "dropIfExists":
      ctx.tables.delete(tableName!);
      return true;
    case "dropColumns": {
      const t = ctx.tables.get(tableName!);
      if (t) for (const c of stringList(op.args[1])) dropColumn(t, c);
      return true;
    }
    default:
      // hasTable, hasColumn, disableForeignKeyConstraints…: no schema change
      return true;
  }
}

function readBlueprint(fn: PhpNode, t: DataTable, ctx: Ctx): void {
  if (!fn || (fn.kind !== "closure" && fn.kind !== "arrowfunc")) {
    if (fn) ctx.skipped.push({ kind: "skipped", reason: `Blueprint callback not readable for table ${t.name}`, source: { file: ctx.file, line: lineOf(fn) } });
    return;
  }
  const param: string = fn.arguments?.[0]?.name?.name ?? fn.arguments?.[0]?.name ?? "table";
  walk(fn.body ?? fn, (n) => {
    if (n.kind !== "call") return;
    const chain = flattenChain(n);
    if (!chain || !chain.steps.length) return false;
    if (baseVariable(n) !== param) return; // e.g. a nested helper call: look inside
    readColumnChain(chain.steps, t, ctx, lineOf(n));
    return false;
  });
}

function baseVariable(n: PhpNode): string | null {
  let cur = n;
  while (cur) {
    if (cur.kind === "call") cur = cur.what;
    else if (cur.kind === "propertylookup" || cur.kind === "nullsafepropertylookup") cur = cur.what;
    else if (cur.kind === "variable") return typeof cur.name === "string" ? cur.name : null;
    else return null;
  }
  return null;
}

function readColumnChain(steps: ChainStep[], t: DataTable, ctx: Ctx, line?: number): void {
  const [first, ...mods] = steps;
  const src = { file: ctx.file, line };
  const arg = (i: number) => stringValue(first.args[i]);
  // ->after('status') places a new column; ->first() puts it first
  const afterStep = mods.find((s) => s.name === "after");
  const after = afterStep ? stringValue(afterStep.args[0]) : null;
  const placeFirst = mods.some((s) => s.name === "first");
  const add = (c: DataColumn) => {
    const existing = t.columns.findIndex((x) => x.name === c.name);
    if (existing >= 0) {
      t.columns[existing] = c;
      return;
    }
    const at = after ? t.columns.findIndex((x) => x.name === after) : -1;
    if (placeFirst) t.columns.unshift(c);
    else if (at >= 0) t.columns.splice(at + 1, 0, c);
    else t.columns.push(c);
  };
  const m = first.name;

  // Columns that expand to several
  if (m === "timestamps" || m === "timestampsTz" || m === "nullableTimestamps") {
    for (const name of ["created_at", "updated_at"]) add({ name, type: m === "timestampsTz" ? "timestampTz" : "timestamp", nullable: true, source: src });
    return;
  }
  if (m === "softDeletes" || m === "softDeletesTz") {
    add({ name: arg(0) ?? "deleted_at", type: m === "softDeletesTz" ? "timestampTz" : "timestamp", nullable: true, comment: "soft delete", source: src });
    return;
  }
  if (m === "rememberToken") {
    add({ name: "remember_token", type: "string", size: "100", nullable: true, source: src });
    return;
  }
  if (/^(morphs|nullableMorphs|uuidMorphs|nullableUuidMorphs|ulidMorphs|nullableUlidMorphs)$/.test(m)) {
    const base = arg(0);
    if (!base) return unreadable(first, t, ctx, line);
    const nullable = m.startsWith("nullable");
    add({ name: `${base}_type`, type: "string", nullable, index: true, comment: "polymorphic: model class", source: src });
    add({ name: `${base}_id`, type: /uuid/i.test(m) ? "uuid" : /ulid/i.test(m) ? "ulid" : "unsignedBigInteger", nullable, index: true, comment: "polymorphic: model id", source: src });
    return;
  }
  // Changes to existing columns
  if (m === "dropColumn" || m === "dropColumns") {
    for (const a of first.args) for (const c of stringList(a)) dropColumn(t, c);
    return;
  }
  if (m === "renameColumn") {
    const from = arg(0);
    const to = arg(1);
    const c = t.columns.find((x) => x.name === from);
    if (c && to) c.name = to;
    else if (!from || !to) unreadable(first, t, ctx, line);
    return;
  }
  if (m === "dropTimestamps" || m === "dropTimestampsTz") {
    dropColumn(t, "created_at");
    dropColumn(t, "updated_at");
    return;
  }
  if (m === "dropSoftDeletes" || m === "dropSoftDeletesTz") return dropColumn(t, arg(0) ?? "deleted_at");
  if (m === "dropRememberToken") return dropColumn(t, "remember_token");
  if (m === "dropMorphs") {
    const base = arg(0);
    if (base) {
      dropColumn(t, `${base}_type`);
      dropColumn(t, `${base}_id`);
    }
    return;
  }
  if (m === "dropForeign") {
    const cols = first.args[0]?.kind === "array" ? stringList(first.args[0]) : [];
    const name = arg(0);
    const conventional = name ? new RegExp(`^${t.name}_(.+)_foreign$`).exec(name)?.[1] : undefined;
    for (const col of conventional ? [conventional] : cols) {
      const c = t.columns.find((x) => x.name === col);
      if (c) delete c.references;
    }
    return;
  }
  if (m === "foreign") {
    const cols = stringList(first.args[0]);
    const refs = readReference(mods, cols[0], ctx);
    if (cols.length === 1 && refs) {
      const c = t.columns.find((x) => x.name === cols[0]);
      if (c) c.references = refs;
      else unreadable(first, t, ctx, line, `foreign key on a column not defined in the migrations read: ${cols[0]}`);
    } else if (!refs) unreadable(first, t, ctx, line);
    return;
  }
  if (m === "primary" || m === "unique" || m === "index") {
    const cols = stringList(first.args[0]);
    for (const col of cols) {
      const c = t.columns.find((x) => x.name === col);
      if (c) c[m] = true;
    }
    return;
  }
  if (m === "comment" && !mods.length) {
    const text = arg(0);
    if (text) t.comment = text;
    return;
  }
  if (IGNORED.test(m)) return;

  // New (or changed) column
  const name = arg(0);
  let col: DataColumn | null = null;
  if (m === "id") col = { name: name ?? "id", type: "id", primary: true, comment: "auto-increment", source: src };
  else if (INCREMENTS.test(m) && name) col = { name, type: m, primary: true, comment: "auto-increment", source: src };
  else if ((m === "foreignId" || m === "foreignUuid" || m === "foreignUlid") && name) col = { name, type: m, source: src };
  else if (m === "foreignIdFor") {
    const fq = resolveClass(first.args[0], ctx.names);
    const table = fq ? ctx.helpers.tableForModel(fq) : null;
    const colName = arg(1) ?? (fq ? `${snake(fq.split("\\").pop()!)}_id` : null);
    if (!colName) return unreadable(first, t, ctx, line);
    col = { name: colName, type: "foreignId", source: src };
    if (table && mods.some((s) => s.name === "constrained")) col.references = { table, column: "id", by: "convention" };
  } else if ((m === "enum" || m === "set") && name) {
    const values = first.args[1]?.kind === "array" ? stringList(first.args[1]) : [];
    col = { name, type: m, source: src };
    if (values.length) col.values = values;
  } else if (PLAIN_TYPES.has(m) && name) {
    col = { name, type: m, source: src };
    if (SIZED.test(m) && first.args[1]) col.size = phpText(first.args[1]);
    if (PRECISION.test(m) && first.args.length > 1) col.size = first.args.slice(1).map((a) => phpText(a)).join(", ");
  }
  if (!col) return unreadable(first, t, ctx, line);

  const changing = mods.some((s) => s.name === "change");
  const existing = t.columns.find((x) => x.name === col!.name);
  if (changing && existing) {
    // ->change(): the new definition replaces the old one; keep the foreign key
    col.references = existing.references;
  }
  applyModifiers(col, mods, ctx);
  add(col);
}

function applyModifiers(col: DataColumn, mods: ChainStep[], ctx: Ctx): void {
  for (const s of mods) {
    switch (s.name) {
      case "nullable":
        col.nullable = s.args[0] ? phpText(s.args[0]) !== "false" : true;
        break;
      case "default":
        col.default = phpText(s.args[0]);
        break;
      case "useCurrent":
        col.default = "CURRENT_TIMESTAMP";
        break;
      case "unique":
      case "index":
      case "primary":
        col[s.name] = true;
        break;
      case "comment": {
        const c = stringValue(s.args[0]);
        if (c) col.comment = c;
        break;
      }
      case "constrained": {
        const table = stringValue(s.args[0]);
        const column = stringValue(s.args[1]) ?? "id";
        if (table) col.references = { table, column, by: "explicit" };
        else {
          const base = col.name.replace(/_id$/, "");
          if (base !== col.name && !col.references) col.references = { table: plural(base), column: "id", by: "convention" };
        }
        col.index = true;
        break;
      }
      case "references": {
        const ref = readReference([s, ...mods.slice(mods.indexOf(s) + 1)], col.name, ctx);
        if (ref) col.references = ref;
        break;
      }
      case "cascadeOnDelete":
        if (col.references) col.references.onDelete = "cascade";
        break;
      case "nullOnDelete":
        if (col.references) col.references.onDelete = "set null";
        break;
      case "restrictOnDelete":
        if (col.references) col.references.onDelete = "restrict";
        break;
      case "noActionOnDelete":
        if (col.references) col.references.onDelete = "no action";
        break;
      case "onDelete": {
        const v = stringValue(s.args[0]);
        if (col.references && v) col.references.onDelete = v;
        break;
      }
    }
  }
}

/** ->references('id')->on('items') (or ->constrained('items')) after foreign('item_id'). */
function readReference(mods: ChainStep[], column: string | undefined, ctx: Ctx): DataColumn["references"] | null {
  void ctx;
  const refCol = mods.find((s) => s.name === "references");
  const on = mods.find((s) => s.name === "on");
  const constrained = mods.find((s) => s.name === "constrained");
  let ref: DataColumn["references"] | null = null;
  if (on) {
    const table = stringValue(on.args[0]);
    const col = refCol ? stringList(refCol.args[0])[0] : "id";
    if (table && col) ref = { table, column: col, by: "explicit" };
  } else if (constrained) {
    const table = stringValue(constrained.args[0]);
    if (table) ref = { table, column: stringValue(constrained.args[1]) ?? "id", by: "explicit" };
    else if (column && /_id$/.test(column)) ref = { table: plural(column.replace(/_id$/, "")), column: "id", by: "convention" };
  }
  if (!ref) return null;
  for (const s of mods) {
    if (s.name === "cascadeOnDelete") ref.onDelete = "cascade";
    if (s.name === "nullOnDelete") ref.onDelete = "set null";
    if (s.name === "restrictOnDelete") ref.onDelete = "restrict";
    if (s.name === "onDelete") ref.onDelete = stringValue(s.args[0]) ?? ref.onDelete;
  }
  return ref;
}

function dropColumn(t: DataTable, name: string): void {
  t.columns = t.columns.filter((c) => c.name !== name);
}

function unreadable(step: ChainStep, t: DataTable, ctx: Ctx, line?: number, why?: string): void {
  ctx.skipped.push({
    kind: "skipped",
    reason: why ? `Migration (${t.name}): ${why}` : `Migration statement not read (${t.name}): $table->${step.name}(${step.args.map((a) => phpText(a)).join(", ")})`,
    source: { file: ctx.file, line },
  });
}

/** Laravel's plural for table names (Str::plural), for the common English cases. */
export function plural(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return word + "es";
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
