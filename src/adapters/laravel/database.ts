/**
 * Optional, read-only database layer (--db). builtlore runs a small PHP script that boots
 * the app itself, so Laravel reads its own .env and credentials; builtlore never sees them.
 * It reads:
 *   - the schema: tables, columns, foreign keys (Laravel 11+ Schema API, else information_schema)
 *   - lookup tables a status column points at (T_Request.Status -> M_Status): code and name,
 *     to name statuses the code only knows by value
 * Nothing is written. Without PHP or vendor/, or when the connection fails, it says so and the
 * scan goes on from the code alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataTable, LabelFact, TableRelation } from "../../core/types.js";

export interface DbSnapshot {
  driver: string;
  tables: Array<{
    name: string;
    view?: boolean;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
    foreignKeys: Array<{ columns: string[]; foreignTable: string; foreignColumns: string[] }>;
  }>;
  lookups: Array<{ table: string; key: string; labelColumn: string; rows: Array<[string, string]> }>;
  error?: string;
}

const SCRIPT = String.raw`<?php
error_reporting(E_ERROR);
ini_set('display_errors', 'stderr');
$root = $argv[1];
$req = json_decode(file_get_contents($argv[2]), true);
require $root . '/vendor/autoload.php';
$app = require $root . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$db = Illuminate\Support\Facades\DB::connection();
$schema = Illuminate\Support\Facades\Schema::connection(null);
$driver = $db->getDriverName();
$out = ['driver' => $driver, 'tables' => [], 'lookups' => []];
$rows = function ($sql) use ($db) { return array_map(function ($r) { return (array) $r; }, $db->select($sql)); };
try {
  if (method_exists($schema, 'getTables')) {
    $list = array_map(function ($t) { return ['name' => $t['name'], 'view' => false]; }, $schema->getTables());
    if (method_exists($schema, 'getViews')) foreach ($schema->getViews() as $v) $list[] = ['name' => $v['name'], 'view' => true];
    foreach ($list as $t) {
      $cols = [];
      foreach ($schema->getColumns($t['name']) as $c) $cols[] = ['name' => $c['name'], 'type' => $c['type_name'] ?? $c['type'], 'nullable' => (bool) $c['nullable']];
      $fks = [];
      if (!$t['view']) foreach ($schema->getForeignKeys($t['name']) as $f) $fks[] = ['columns' => $f['columns'], 'foreignTable' => $f['foreign_table'], 'foreignColumns' => $f['foreign_columns']];
      $out['tables'][] = ['name' => $t['name'], 'view' => $t['view'], 'columns' => $cols, 'foreignKeys' => $fks];
    }
  } else {
    if ($driver === 'mysql' || $driver === 'mariadb') {
      $cols = $rows("SELECT c.TABLE_NAME t, c.COLUMN_NAME c, c.DATA_TYPE d, c.IS_NULLABLE n, tb.TABLE_TYPE k FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_SCHEMA = c.TABLE_SCHEMA WHERE c.TABLE_SCHEMA = DATABASE() ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION");
      $fks = $rows("SELECT TABLE_NAME t, COLUMN_NAME c, REFERENCED_TABLE_NAME ft, REFERENCED_COLUMN_NAME fc FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL");
    } elseif ($driver === 'sqlsrv') {
      $cols = $rows("SELECT c.TABLE_NAME t, c.COLUMN_NAME c, c.DATA_TYPE d, c.IS_NULLABLE n, tb.TABLE_TYPE k FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES tb ON tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_SCHEMA = c.TABLE_SCHEMA ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION");
      $fks = $rows("SELECT tp.name t, cp.name c, tr.name ft, cr.name fc FROM sys.foreign_keys fk JOIN sys.tables tp ON fk.parent_object_id = tp.object_id JOIN sys.tables tr ON fk.referenced_object_id = tr.object_id JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns cp ON fkc.parent_column_id = cp.column_id AND fkc.parent_object_id = cp.object_id JOIN sys.columns cr ON fkc.referenced_column_id = cr.column_id AND fkc.referenced_object_id = cr.object_id");
    } elseif ($driver === 'pgsql') {
      $cols = $rows("SELECT c.table_name t, c.column_name c, c.data_type d, c.is_nullable n, tb.table_type k FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema WHERE c.table_schema = current_schema() ORDER BY c.table_name, c.ordinal_position");
      $fks = $rows("SELECT tc.table_name t, kcu.column_name c, ccu.table_name ft, ccu.column_name fc FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY'");
    } elseif ($driver === 'sqlite') {
      $cols = []; $fks = [];
      foreach ($rows("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'") as $t) {
        foreach ($rows("PRAGMA table_info('" . $t['name'] . "')") as $c) $cols[] = ['t' => $t['name'], 'c' => $c['name'], 'd' => $c['type'], 'n' => $c['notnull'] ? 'NO' : 'YES', 'k' => $t['type'] === 'view' ? 'VIEW' : 'BASE TABLE'];
        foreach ($rows("PRAGMA foreign_key_list('" . $t['name'] . "')") as $f) $fks[] = ['t' => $t['name'], 'c' => $f['from'], 'ft' => $f['table'], 'fc' => $f['to']];
      }
    } else { throw new Exception('Database driver not supported yet: ' . $driver); }
    $by = [];
    foreach ($cols as $c) {
      $t = $c['t'];
      if (!isset($by[$t])) $by[$t] = ['name' => $t, 'view' => stripos($c['k'] ?? '', 'VIEW') !== false, 'columns' => [], 'foreignKeys' => []];
      $by[$t]['columns'][] = ['name' => $c['c'], 'type' => $c['d'], 'nullable' => strtoupper($c['n']) === 'YES'];
    }
    foreach ($fks as $f) if (isset($by[$f['t']])) $by[$f['t']]['foreignKeys'][] = ['columns' => [$f['c']], 'foreignTable' => $f['ft'], 'foreignColumns' => [$f['fc']]];
    $out['tables'] = array_values($by);
  }
} catch (Throwable $e) { $out['error'] = $e->getMessage(); }
foreach ($req['lookups'] as $l) {
  try {
    $listing = $schema->getColumnListing($l['table']);
    $label = null;
    foreach ($listing as $c) if (strcasecmp($c, $l['key']) !== 0 && preg_match('/(nama|name|label|keterangan|^ket$|desc|description|title|caption|text|status_?name)/i', $c)) { $label = $c; break; }
    if (!$label) continue;
    $data = $db->table($l['table'])->select([$l['key'], $label])->limit(200)->get();
    $pairs = [];
    foreach ($data as $r) { $r = (array) $r; $pairs[] = [(string) $r[$l['key']], (string) $r[$label]]; }
    $out['lookups'][] = ['table' => $l['table'], 'key' => $l['key'], 'labelColumn' => $label, 'rows' => $pairs];
  } catch (Throwable $e) {}
}
echo "BUILTLORE_JSON:" . json_encode($out);
`;

/** Run the read-only script with the app's own PHP and Laravel. BUILTLORE_DB_SNAPSHOT=<file> replays a saved result (tests). */
export function readDatabase(root: string, php: string, lookups: Array<{ table: string; key: string }>): DbSnapshot {
  const replay = process.env.BUILTLORE_DB_SNAPSHOT;
  if (replay) return JSON.parse(readFileSync(replay, "utf8")) as DbSnapshot;
  if (!existsSync(join(root, "vendor", "autoload.php"))) return { driver: "", tables: [], lookups: [], error: "vendor/ is missing (run composer install): the database layer boots the app to read it" };
  const dir = mkdtempSync(join(tmpdir(), "builtlore-db-"));
  try {
    const script = join(dir, "read.php");
    const req = join(dir, "req.json");
    writeFileSync(script, SCRIPT);
    writeFileSync(req, JSON.stringify({ lookups }));
    const r = spawnSync(php, [script, root, req], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { driver: "", tables: [], lookups: [], error: `Could not run PHP (${php}): ${r.error.message}` };
    const at = (r.stdout ?? "").indexOf("BUILTLORE_JSON:");
    if (at < 0) return { driver: "", tables: [], lookups: [], error: `The app did not start: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
    return JSON.parse(r.stdout.slice(at + "BUILTLORE_JSON:".length)) as DbSnapshot;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Facts from a snapshot: tables the migrations do not have, foreign keys, and status names from lookup tables. */
export function databaseFacts(
  snap: DbSnapshot,
  known: DataTable[],
  statusRelations: Array<{ from: string; column: string; to: string; toColumn: string }>,
  modelForTable: (t: string) => string | null,
): { tables: DataTable[]; relations: TableRelation[]; labels: LabelFact[] } {
  const source = { file: `(database: ${snap.driver})` };
  const knownNames = new Set(known.map((t) => t.name.toLowerCase()));
  const tables: DataTable[] = snap.tables
    .filter((t) => !knownNames.has(t.name.toLowerCase()) && !/^(migrations|sqlite_\w+)$/i.test(t.name))
    .map((t) => {
      const model = modelForTable(t.name);
      return {
        name: t.name,
        ...(model ? { model } : {}),
        columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, source })),
        migrations: [],
        comment: t.view ? "database view (read from the database)" : "read from the database",
        source,
      };
    });
  const relations: TableRelation[] = snap.tables.flatMap((t) =>
    t.foreignKeys.flatMap((f) =>
      f.columns.map((col, i) => ({ from: t.name, column: col, to: f.foreignTable, toColumn: f.foreignColumns[i] ?? f.foreignColumns[0], kind: "one-to-many" as const, found: ["database" as const], by: "explicit" as const, source })),
    ),
  );
  const labels: LabelFact[] = [];
  for (const l of snap.lookups) {
    const users = statusRelations.filter((r) => r.to.toLowerCase() === l.table.toLowerCase() && r.toColumn.toLowerCase() === l.key.toLowerCase());
    for (const u of users) {
      for (const [value, label] of l.rows) {
        if (label.trim() && label.trim() !== value) labels.push({ kind: "label", column: u.column, value, label: label.trim(), source: { file: `(database: ${l.table}.${l.labelColumn})` } });
      }
    }
  }
  return { tables, relations, labels };
}
