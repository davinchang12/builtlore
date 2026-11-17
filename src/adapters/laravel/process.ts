/**
 * Process layer for Laravel: who does a step (actors) and how it changes a
 * record's status. Teams write this in many styles, so several are read:
 *
 *   status values  'APPROVED' · 3 · PurchaseRequest::STATUS_HOLD · LeaveStatus::Approved
 *   status writes  $x->status = V · $x->update(['status' => V]) · Model::create([... 'status' => V])
 *   guards         if ($x->status != V) return back() · abort_unless($x->status == V, 403)
 *   actors         middleware role:/can:/custom · hasRole() · $user->jabatan == 'X'
 *                  · auth()->user()->nik == $x->manager_nik · @role / @can / @if in Blade
 *                  · route names (approve-manager), only for role words seen in the app
 *
 * Anything that cannot be resolved is left out, never guessed.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ActorRef, ProcessInfo, StatesFact, StatusCondition, StatusValue, StatusWrite } from "../../core/types.js";
import { ClassLocator } from "./controllers.js";
import { lineOf, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";

/** Columns that hold a workflow state (tested on the snake_case form, so StatusApproval works too). */
const STATUS_COLUMN_RE = /^(status|state|stage|step|phase|approval|approval_status|approval_state|workflow_status|status_[a-z0-9_]+|[a-z0-9_]+_status|is_approved?|approved?|flag_approval|approval_flag)$/i;
export const STATUS_COLUMN = { test: (c: string): boolean => STATUS_COLUMN_RE.test(snake(c)) };

function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

/** Custom middleware that only checks login, not a role. */
const AUTH_LIKE = /login|logged|auth|session|token|jwt|sso|signed|verify|verified|csrf|cors|locale|lang|csp|throttle|log|track|maintenance|xss|secure|header/i;

/** Properties of the current user that name a role. */
const ROLE_PROPS = /^(role|roles|role_name|role_id|level|user_level|jabatan|position|posisi|type|user_type|group|group_name|akses|hak_akses|access|access_level|divisi|division|department|departemen|bagian|title)$/i;
/** Properties that identify the current user. */
const IDENTITY_PROPS = /^(id|nik|nip|npk|username|user_name|email|employee_id|employee_no|kode|code|user_id)$/i;

/** Role words recognised in names even before the app uses them explicitly. */
const ROLE_WORDS = new Set([
  "admin", "superadmin", "administrator", "manager", "manajer", "supervisor", "spv", "atasan", "leader", "lead", "head",
  "kepala", "kabag", "kadiv", "director", "direktur", "gm", "ceo", "cfo", "coo", "hr", "hrd", "finance", "accounting",
  "procurement", "purchasing", "approver", "reviewer", "verifier", "verifikator", "checker", "validator", "auditor",
  "operator", "cashier", "kasir", "warehouse", "gudang", "legal", "pic", "owner", "requester", "staff", "secretary",
  "sekretaris", "treasury", "budget", "qc", "qa", "it", "ga",
]);

const NOT_ROLES = new Set(["user", "users", "auth", "guest", "web", "api"]);

const STANDARD_MIDDLEWARE = /^(auth|auth\.basic|auth\.session|guest|web|api|verified|signed|throttle|bindings|cache\.headers|password\.confirm|precognitive|can|role|permission|role_or_permission|abilities|ability|csrf|cors|encrypt|session|substitutebindings|sanctum|horizon)$/i;

// ---------------------------------------------------------------------------
// Class index: constants, enums, models
// ---------------------------------------------------------------------------

interface ClassInfo {
  fqcn: string;
  file: string;
  isEnum: boolean;
  isModel: boolean;
  constants: Map<string, StatusValue>;
  enumCases: Map<string, StatusValue>;
  /** status column -> enum class (from $casts) */
  casts: Map<string, string>;
  /** status column -> value -> label (from label arrays) */
  labels: Map<string, Map<string, string>>;
  /** status column -> default ($attributes) */
  defaults: Map<string, StatusValue>;
  /** protected $table = '...' */
  table?: string;
  line?: number;
}

export class ProcessReader {
  private classes = new Map<string, ClassInfo | null>();
  private shortIndex: Map<string, string[]> | null = null;
  /** Role names found explicitly anywhere in the app (lowercase). */
  readonly knownRoles = new Set<string>();

  constructor(
    private root: string,
    private locator: ClassLocator,
  ) {}

  // ----- classes ----------------------------------------------------------

  classInfo(fqcn: string): ClassInfo | null {
    if (this.classes.has(fqcn)) return this.classes.get(fqcn)!;
    const loaded = this.locator.load(fqcn);
    let info: ClassInfo | null = null;
    if (loaded) {
      walk(loaded.ast, (n) => {
        if (info) return false;
        if (n.kind === "class" || n.kind === "enum") {
          info = this.readClass(n, fqcn, loaded.file, loaded.names);
          return false;
        }
      });
    }
    this.classes.set(fqcn, info);
    return info;
  }

  private readClass(cls: PhpNode, fqcn: string, file: string, names: NameContext): ClassInfo {
    const short = fqcn.split("\\").pop()!;
    const info: ClassInfo = {
      fqcn,
      file,
      isEnum: cls.kind === "enum",
      isModel: false,
      constants: new Map(),
      enumCases: new Map(),
      casts: new Map(),
      labels: new Map(),
      defaults: new Map(),
      line: lineOf(cls),
    };
    const parent = cls.extends?.name ? resolveName(cls.extends.name, cls.extends.resolution, names) : "";
    info.isModel = /(^|\\)(Model|Authenticatable|Pivot)$/.test(parent);

    for (const member of cls.body ?? []) {
      if (member.kind === "classconstant") {
        for (const c of member.constants ?? []) {
          const name = c.name?.name ?? c.name;
          const v = literal(c.value);
          if (v !== null) info.constants.set(name, { value: v, code: `${short}::${name}`, label: constLabel(name), labelFrom: "constant" });
        }
      } else if (member.kind === "enumcase") {
        const name = member.name?.name ?? member.name;
        const v = member.value ? literal(member.value) : name;
        if (v !== null) info.enumCases.set(name, { value: v, code: `${short}::${name}`, label: humanize(name), labelFrom: "enum" });
      } else if (member.kind === "propertystatement") {
        for (const p of member.properties ?? []) {
          const name: string = p.name?.name ?? p.name;
          if (name === "table" && stringValue(p.value)) info.table = stringValue(p.value)!;
          if (p.value?.kind !== "array") continue;
          if (name === "casts") {
            for (const it of p.value.items ?? []) {
              const k = it?.key ? stringValue(it.key) : null;
              if (!k || !STATUS_COLUMN.test(k)) continue;
              const cast = it.value?.kind === "staticlookup" && (it.value.offset?.name ?? "") === "class" ? resolveName(it.value.what.name, it.value.what.resolution, names) : null;
              if (cast) info.casts.set(k, cast);
            }
          } else if (name === "attributes") {
            for (const it of p.value.items ?? []) {
              const k = it?.key ? stringValue(it.key) : null;
              if (!k || !STATUS_COLUMN.test(k)) continue;
              const v = this.value(it.value, names, fqcn);
              if (v) info.defaults.set(k, v);
            }
          } else if (/status|state|stage|label/i.test(name)) {
            this.readLabelArray(p.value, name, info);
          }
        }
      } else if (member.kind === "method") {
        const name: string = member.name?.name ?? member.name;
        if (name === "casts") {
          // Laravel 11: protected function casts(): array { return [...] }
          walk(member, (n) => {
            if (n.kind === "return" && n.expr?.kind === "array") {
              for (const it of n.expr.items ?? []) {
                const k = it?.key ? stringValue(it.key) : null;
                if (k && STATUS_COLUMN.test(k) && it.value?.kind === "staticlookup") {
                  info.casts.set(k, resolveName(it.value.what.name, it.value.what.resolution, names));
                }
              }
            }
          });
        } else if (/status|state|stage|label/i.test(name)) {
          walk(member, (n) => {
            if (n.kind === "array") this.readLabelArray(n, name, info);
            if (n.kind === "match") this.readMatchLabels(n, name, info);
          });
        }
      }
    }
    return info;
  }

  /** [1 => 'Draft', 'APPROVED' => 'Approved'] on a property/method named like status. */
  private readLabelArray(arr: PhpNode, holder: string, info: ClassInfo): void {
    const map = new Map<string, string>();
    for (const it of arr.items ?? []) {
      if (it?.kind !== "entry" || !it.key) continue;
      const k = literal(it.key) ?? this.constValueInClass(it.key, info);
      const v = stringValue(it.value);
      if (k !== null && v && v.length <= 60) map.set(k, v);
    }
    if (map.size >= 2) this.addLabels(info, columnFromHolder(holder), map);
  }

  private readMatchLabels(m: PhpNode, holder: string, info: ClassInfo): void {
    const map = new Map<string, string>();
    for (const arm of m.arms ?? []) {
      const v = stringValue(arm.body);
      if (!v) continue;
      for (const c of arm.conds ?? []) {
        const k = literal(c) ?? this.constValueInClass(c, info);
        if (k !== null) map.set(k, v);
      }
    }
    if (map.size >= 2) this.addLabels(info, columnFromHolder(holder), map);
  }

  private addLabels(info: ClassInfo, column: string, map: Map<string, string>): void {
    const existing = info.labels.get(column) ?? new Map<string, string>();
    for (const [k, v] of map) if (!existing.has(k)) existing.set(k, v);
    info.labels.set(column, existing);
  }

  private constValueInClass(node: PhpNode, info: ClassInfo): string | null {
    if (node?.kind !== "staticlookup") return null;
    const what = node.what?.name;
    const name = node.offset?.name;
    if ((what === "self" || what === "static") && name) return info.constants.get(name)?.value ?? null;
    return null;
  }

  // ----- values -----------------------------------------------------------

  /** Resolve a PHP expression used as a status value. */
  value(node: PhpNode, names: NameContext, selfClass?: string): StatusValue | null {
    if (!node) return null;
    if (node.kind === "cast" || node.kind === "parenthesis") return this.value(node.what ?? node.inner, names, selfClass);
    // Enum ->value
    if (node.kind === "propertylookup" && (node.offset?.name === "value" || node.offset?.name === "name")) return this.value(node.what, names, selfClass);
    const lit = literal(node);
    if (lit !== null) {
      const raw = node.kind === "string" ? `'${lit}'` : lit;
      return { value: lit, code: raw, label: node.kind === "string" ? literalLabel(lit) : undefined, labelFrom: node.kind === "string" ? "literal" : undefined };
    }
    if (node.kind === "staticlookup" && node.what?.kind === "name") {
      const member: string = node.offset?.name ?? "";
      if (member === "class") return null;
      const cls = node.what.name === "self" || node.what.name === "static" ? selfClass : resolveName(node.what.name, node.what.resolution, names);
      return cls ? this.member(cls, member) : null;
    }
    return null;
  }

  /** Class::MEMBER by class name as written in a view: FQCN or short name. */
  valueByName(className: string, member: string): StatusValue | null {
    const fq = className.replace(/^\\/, "");
    if (fq.includes("\\")) return this.member(fq, member);
    for (const cand of this.findShort(fq)) {
      const v = this.member(cand, member);
      if (v) return v;
    }
    return null;
  }

  private member(fqcn: string, member: string): StatusValue | null {
    const info = this.classInfo(fqcn);
    if (!info) return null;
    return info.constants.get(member) ?? info.enumCases.get(member) ?? null;
  }

  /** Classes under app/ with this short name. */
  findShort(short: string): string[] {
    if (!this.shortIndex) {
      this.shortIndex = new Map();
      const appDir = join(this.root, "app");
      const visit = (dir: string, ns: string, depth: number) => {
        if (depth > 6 || !existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) visit(full, `${ns}${name}\\`, depth + 1);
          else if (name.endsWith(".php")) {
            const s = name.slice(0, -4);
            const list = this.shortIndex!.get(s) ?? [];
            list.push(`${ns}${s}`);
            this.shortIndex!.set(s, list);
          }
        }
      };
      visit(appDir, "App\\", 0);
    }
    return this.shortIndex.get(short) ?? [];
  }

  private tables: Map<string, string> | null = null;

  /** Model short name for a database table: $table, or Laravel's snake_case plural convention. */
  modelForTable(table: string): string | null {
    if (!this.tables) {
      this.tables = new Map();
      this.findShort("__index__");
      for (const [short, list] of this.shortIndex ?? []) {
        for (const fq of list) {
          const info = this.classInfo(fq);
          if (!info?.isModel) continue;
          const t = (info.table ?? pluralSnake(short)).toLowerCase();
          if (!this.tables.has(t)) this.tables.set(t, short);
        }
      }
    }
    const t = table.toLowerCase().replace(/^.*\./, "");
    return this.tables.get(t) ?? null;
  }

  modelFor(short: string): string | null {
    for (const c of this.findShort(short)) if (this.classInfo(c)?.isModel) return c;
    return null;
  }

  /** States facts for every model that has a status column we learned about. */
  statesFacts(models: Iterable<string>): StatesFact[] {
    const out: StatesFact[] = [];
    for (const fqcn of new Set(models)) {
      const info = this.classInfo(fqcn);
      if (!info) continue;
      const short = fqcn.split("\\").pop()!;
      const columns = new Set<string>([...info.labels.keys(), ...info.casts.keys(), ...info.defaults.keys()]);
      for (const col of columns) {
        const values: StatusValue[] = [];
        const enumCls = info.casts.get(col);
        if (enumCls) for (const v of this.classInfo(enumCls)?.enumCases.values() ?? []) values.push(v);
        for (const v of info.constants.values()) if (/^(STATUS|STATE|STAGE)_/i.test(v.code.split("::")[1] ?? "") && col === "status") values.push(v);
        const labels = info.labels.get(col);
        for (const v of values) {
          const l = labels?.get(v.value);
          if (l) {
            v.label = l;
            v.labelFrom = "labels";
          }
        }
        for (const [value, label] of labels ?? []) {
          if (!values.some((v) => v.value === value)) values.push({ value, code: /^\d+$/.test(value) ? value : `'${value}'`, label, labelFrom: "labels" });
        }
        const initial = info.defaults.get(col);
        if (initial) {
          const known = values.find((v) => v.value === initial.value);
          if (known) Object.assign(initial, { label: known.label, labelFrom: known.labelFrom });
        }
        out.push({ kind: "states", subject: `${short}.${col}`, values, initial, source: { file: info.file, line: info.line } });
      }
    }
    return out;
  }

  // ----- handlers ---------------------------------------------------------

  /** Actors, status writes and guards in a controller method or closure body. */
  analyzeHandler(body: PhpNode, names: NameContext, file: string, selfClass?: string): ProcessInfo {
    const info: ProcessInfo = { actors: [], writes: [], requires: [], creates: [] };
    const types = new Map<string, string>(); // variable -> model short name
    const userVars = new Set<string>(["user", "authUser", "currentUser", "me"]);

    // Parameter types: (PurchaseRequest $purchaseRequest)
    for (const p of body.arguments ?? []) {
      const t = p.type?.name;
      const v = p.name?.name ?? p.name;
      if (t && v) {
        const fq = resolveName(t, p.type.resolution, names);
        if (this.classInfo(fq)?.isModel) types.set(v, fq.split("\\").pop()!);
      }
    }

    const locals: Locals = { values: new Map(), arrays: new Map() };
    walk(body, (n) => {
      // $x = Model::find(...) / new Model / auth()->user()
      if (n.kind === "assign" && n.left?.kind === "variable" && typeof n.left.name === "string") {
        const model = this.modelOfExpr(n.right, names, types);
        if (model) types.set(n.left.name, model);
        if (isCurrentUser(n.right, userVars)) userVars.add(n.left.name);
        // $status = 'Approved' / $data = ['status' => ...]
        const list = locals.values.get(n.left.name) ?? [];
        list.push(n.right);
        locals.values.set(n.left.name, list);
        if (n.right?.kind === "array") {
          const arr = locals.arrays.get(n.left.name) ?? [];
          for (const it of n.right.items ?? []) if (it?.kind === "entry" && it.key) arr.push({ key: it.key, value: it.value });
          locals.arrays.set(n.left.name, arr);
        }
      }
      // $data['status'] = 'Approved'
      if (n.kind === "assign" && n.left?.kind === "offsetlookup" && n.left.what?.kind === "variable" && n.left.offset) {
        const arr = locals.arrays.get(n.left.what.name) ?? [];
        arr.push({ key: n.left.offset, value: n.right });
        locals.arrays.set(n.left.what.name, arr);
      }
    });

    walk(body, (n) => {
      if (n.kind === "assign" && n.left?.kind === "propertylookup") {
        // $x->status = V
        const col = n.left.offset?.name;
        if (col && STATUS_COLUMN.test(col) && n.operator === "=") {
          const subj = subjectOf(n.left.what, types, col);
          if (subj) this.recordWrite(info, subj, col, n.right, names, selfClass, locals, { file, line: lineOf(n) });
        }
      }
      if (n.kind === "call" || n.kind === "new") {
        this.readCall(n, names, types, file, info, selfClass, userVars, locals);
      }
      if (n.kind === "if" && n.test && exits(n.body)) {
        // if (status != V) return / abort: the step requires V
        for (const c of comparisons(n.test)) this.readGuard(c, names, types, file, info, selfClass, lineOf(n), true);
        for (const a of this.actorsInExpr(n.test, userVars, names, types)) pushActor(info.actors, a);
      }
      return undefined;
    });

    // Ability checks: $this->authorize('approve-manager'), Gate::authorize('x')
    walk(body, (n) => {
      if (n.kind !== "call") return;
      const name = n.what?.offset?.name ?? n.what?.name;
      if (/^(authorize|allows|denies|authorizeForUser)$/.test(name ?? "") && n.arguments?.[0]) {
        const ability = stringValue(n.arguments[0]);
        if (ability && !/^(view|viewAny|create|update|delete|restore|forceDelete|approve|reject)$/.test(ability)) {
          pushActor(info.actors, this.ability(ability, "code", `authorize('${ability}')`));
        }
      }
    });
    return info;
  }

  /** Resolve every value an expression can have: literals, constants, ternaries, match arms, local variables. */
  private values(node: PhpNode, names: NameContext, selfClass: string | undefined, locals: Locals, depth = 0): StatusValue[] | null {
    if (!node || depth > 4) return null;
    const one = this.value(node, names, selfClass);
    if (one) return [one];
    if (node.kind === "retif") {
      const a = this.values(node.trueExpr ?? node.test, names, selfClass, locals, depth + 1);
      const b = this.values(node.falseExpr, names, selfClass, locals, depth + 1);
      return a && b ? [...a, ...b] : null;
    }
    if (node.kind === "match") {
      const out: StatusValue[] = [];
      for (const arm of node.arms ?? []) {
        const v = this.values(arm.body, names, selfClass, locals, depth + 1);
        if (!v) return null;
        out.push(...v);
      }
      return out.length ? out : null;
    }
    // $data['status'] from an array built earlier
    if (node.kind === "offsetlookup" && node.what?.kind === "variable" && node.offset) {
      const key = stringValue(node.offset);
      const entries = (locals.arrays.get(node.what.name) ?? []).filter((e) => stringValue(e.key) === key);
      if (!key || !entries.length) return null;
      const out: StatusValue[] = [];
      for (const e of entries) {
        const v = this.values(e.value, names, selfClass, locals, depth + 1);
        if (!v) return null;
        out.push(...v);
      }
      return out;
    }
    if (node.kind === "variable" && typeof node.name === "string") {
      const assigned = locals.values.get(node.name);
      if (!assigned?.length) return null;
      const out: StatusValue[] = [];
      for (const a of assigned) {
        const v = this.values(a, names, selfClass, locals, depth + 1);
        if (!v) return null;
        out.push(...v);
      }
      return out;
    }
    return null;
  }

  private recordWrite(
    info: ProcessInfo,
    subject: string,
    column: string,
    valueNode: PhpNode,
    names: NameContext,
    selfClass: string | undefined,
    locals: Locals,
    source: { file: string; line?: number },
  ): void {
    const vs = this.values(valueNode, names, selfClass, locals);
    if (vs) {
      for (const v of vs) if (!info.writes.some((w) => w.subject === subject && w.to.value === v.value)) info.writes.push({ subject, to: v, source });
    } else {
      (info.unresolved ??= []).push({ column: `${subject.split(".")[0] ? subject.split(".")[0] + "." : ""}${column}`, code: exprText(valueNode), source });
    }
  }

  private readCall(
    n: PhpNode,
    names: NameContext,
    types: Map<string, string>,
    file: string,
    info: ProcessInfo,
    selfClass: string | undefined,
    userVars: Set<string>,
    locals: Locals,
  ): void {
    const fnName: string | undefined = n.kind === "call" && n.what?.kind === "name" ? n.what.name : undefined;
    const callName: string | undefined = n.kind === "call" ? n.what?.offset?.name : undefined;
    // Raw SQL and stored procedures: DB::update("update mtdi set status = 'Approved' ..."), DB::select('EXEC sp_x ?')
    if (callName && /^(update|statement|select|insert|unprepared|affectingStatement)$/.test(callName) && n.arguments?.[0]) {
      const sql = stringValue(n.arguments[0]) ?? stringPrefix(n.arguments[0]);
      if (sql) {
        this.readSql(sql, info, { file, line: lineOf(n) });
        if (/^\s*(update|insert|exec|call|select)/i.test(sql)) return;
      }
    }
    // abort_unless(cond, 403) / abort_if(cond, 403) / throw_unless
    if (fnName && /^(abort_unless|abort_if|throw_unless|throw_if)$/.test(fnName) && n.arguments?.[0]) {
      const positive = /unless/.test(fnName);
      for (const c of comparisons(n.arguments[0])) this.readGuard(c, names, types, file, info, selfClass, lineOf(n), !positive);
      if (positive) for (const a of this.actorsInExpr(n.arguments[0], userVars, names, types)) pushActor(info.actors, a);
      return;
    }
    const method: string | undefined = n.kind === "new" ? "new" : n.what?.offset?.name;
    if (!method) return;
    const writeLike = /^(update|create|fill|forceFill|insert|updateOrCreate|firstOrCreate|updateOrInsert|make|forceCreate|new|upsert)$/.test(method);
    if (!writeLike) return;
    let subjectModel: string | null = null;
    if (n.kind === "new") subjectModel = this.modelName(n.what, names);
    else if (n.what?.kind === "staticlookup") subjectModel = this.modelName(n.what.what, names);
    else if (n.what.what?.kind === "variable") subjectModel = types.get(n.what.what.name) ?? null;
    else subjectModel = this.modelOfChain(n.what.what, names, types);
    const table = this.tableOfChain(n.what?.what);
    const tableSubject = table ? this.modelForTable(table) ?? table : null;
    const subjectBase = subjectModel ?? tableSubject;

    if (subjectModel && /^(create|firstOrCreate|updateOrCreate|forceCreate|new|make)$/.test(method)) {
      if (!info.creates.includes(subjectModel)) info.creates.push(subjectModel);
    }
    for (const arg of n.arguments ?? []) {
      for (const entry of entriesOf(arg, locals)) {
        const k = stringValue(entry.key);
        if (!k || !STATUS_COLUMN.test(k)) continue;
        this.recordWrite(info, `${subjectBase ?? ""}.${k}`, k, entry.value, names, selfClass, locals, { file, line: lineOf(n) });
      }
    }
  }

  /** UPDATE ... SET status = 'X' in raw SQL; EXEC / CALL of stored procedures. */
  private readSql(sql: string, info: ProcessInfo, source: { file: string; line?: number }): void {
    const upd = /\bupdate\s+\[?(?:\w+\]?\.\[?)?(\w+)\]?\s+set\s+([\s\S]+?)(?:\bwhere\b|$)/i.exec(sql);
    if (upd) {
      for (const m of upd[2].matchAll(/\[?(\w+)\]?\s*=\s*('([^']*)'|-?\d+|\?|:\w+)/g)) {
        if (!STATUS_COLUMN.test(m[1])) continue;
        const subject = `${this.modelForTable(upd[1]) ?? upd[1]}.${m[1]}`;
        if (m[3] !== undefined || /^-?\d+$/.test(m[2])) {
          const value = m[3] ?? m[2];
          info.writes.push({ subject, to: { value, code: m[2], label: m[3] !== undefined ? literalLabel(value) : undefined, labelFrom: m[3] !== undefined ? "literal" : undefined }, source });
        } else (info.unresolved ??= []).push({ column: subject, code: `SQL parameter ${m[2]}`, source });
      }
    }
    for (const m of sql.matchAll(/\b(?:exec(?:ute)?|call)\s+\[?([\w.\]\[]+)/gi)) {
      const name = m[1].replace(/[[\]]/g, "");
      if (!/^(sp_executesql)$/i.test(name)) (info.procedures ??= []).includes(name) || info.procedures!.push(name);
    }
  }

  private readGuard(
    c: Comparison,
    names: NameContext,
    types: Map<string, string>,
    file: string,
    info: ProcessInfo,
    selfClass: string | undefined,
    line: number | undefined,
    exitWhenTrue: boolean,
  ): void {
    // exitWhenTrue: the code leaves when the comparison is true, so the step requires its negation.
    const side = statusSide(c);
    if (!side) return;
    const requiresEqual = exitWhenTrue ? c.negated : !c.negated;
    if (!requiresEqual) return; // "must not be X" is not drawn
    const values = side.values.map((v) => this.value(v, names, selfClass)).filter((v): v is StatusValue => Boolean(v));
    const subj = subjectOf(side.record, types, side.column);
    if (values.length && subj) info.requires.push({ subject: subj, values, via: "guard", source: { file, line } });
  }

  private modelName(node: PhpNode, names: NameContext): string | null {
    if (node?.kind !== "name") return null;
    const fq = resolveName(node.name, node.resolution, names);
    return this.classInfo(fq)?.isModel ? fq.split("\\").pop()! : null;
  }

  private modelOfExpr(node: PhpNode, names: NameContext, types: Map<string, string>): string | null {
    if (!node) return null;
    if (node.kind === "new") return this.modelName(node.what, names);
    if (node.kind === "call") return this.modelOfChain(node, names, types);
    return null;
  }

  /** Root model of a chain such as PurchaseRequest::where(...)->first() or $pr->fresh(). */
  private modelOfChain(node: PhpNode, names: NameContext, types: Map<string, string>): string | null {
    let cur = node;
    while (cur) {
      if (cur.kind === "call") cur = cur.what;
      else if (cur.kind === "propertylookup" || cur.kind === "nullsafepropertylookup") cur = cur.what;
      else if (cur.kind === "staticlookup") return this.modelName(cur.what, names);
      else if (cur.kind === "variable") return types.get(cur.name) ?? null;
      else return null;
    }
    return null;
  }

  /** DB::table('purchase_requests')->where(...)->update([...]) -> "purchase_requests" */
  private tableOfChain(node: PhpNode): string | null {
    let cur = node;
    while (cur) {
      if (cur.kind === "call") {
        if (cur.what?.offset?.name === "table" && cur.arguments?.[0]) return stringValue(cur.arguments[0]);
        cur = cur.what;
      } else if (cur.kind === "propertylookup" || cur.kind === "staticlookup") cur = cur.what;
      else return null;
    }
    return null;
  }

  // ----- actors -----------------------------------------------------------

  actorsInExpr(expr: PhpNode, userVars: Set<string>, names: NameContext, types: Map<string, string>): ActorRef[] {
    const out: ActorRef[] = [];
    void names;
    void types;
    walk(expr, (n) => {
      if (n.kind === "bin" && /^(==|===|!=|!==)$/.test(n.type)) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]]) {
          const prop = userProp(a, userVars);
          if (!prop) continue;
          if (ROLE_PROPS.test(prop)) {
            const lit = literal(b);
            if (lit && !/^\d+$/.test(lit)) out.push(this.actor(lit, "code", `user ${prop} == '${lit}'`));
            else if (lit) out.push(this.actor(`${humanize(prop)} ${lit}`, "code", `user ${prop} == ${lit}`));
          } else if (IDENTITY_PROPS.test(prop) && b?.kind === "propertylookup") {
            const field = b.offset?.name;
            const role = field ? roleFromField(field) : null;
            if (role) out.push(this.actor(role, "code", `user ${prop} == ${field}`));
          }
        }
      }
      if (n.kind === "call" && n.what?.kind === "propertylookup" && userProp(n.what, userVars, true)) {
        const m: string = n.what.offset?.name ?? "";
        if (/^(hasRole|hasAnyRole|hasAllRoles|is|isRole|hasPermissionTo)$/.test(m)) {
          for (const r of argStrings(n.arguments?.[0])) out.push(this.actor(r, "code", `${m}('${r}')`));
        } else {
          const is = /^is([A-Z]\w+)$/.exec(m);
          if (is && is[1] !== "Active" && is[1] !== "Verified") out.push(this.actor(humanize(is[1]), "code", `${m}()`));
        }
      }
    });
    return out;
  }

  actorsFromMiddleware(middleware: string[]): ActorRef[] {
    const out: ActorRef[] = [];
    for (const mw of middleware) {
      const [name, params = ""] = mw.split(":");
      const lname = name.toLowerCase();
      if (lname === "role" || lname === "role_or_permission") {
        for (const r of params.split(/[|,]/).map((x) => x.trim()).filter(Boolean)) out.push(this.actor(r, "middleware", mw));
      } else if (lname === "can" || lname === "permission" || lname === "ability" || lname === "abilities") {
        const ability = params.split(",")[0]?.trim();
        if (!ability) continue;
        out.push(this.ability(ability, "middleware", mw));
      } else if (!STANDARD_MIDDLEWARE.test(lname) && !lname.includes("\\") && !AUTH_LIKE.test(name)) {
        const stripped = name.replace(/middleware$/i, "").replace(/^(is|check|ensure|only|must|has|role)[-_.]?/i, "").replace(/^(user)?(is)?/i, "");
        const hadPrefix = stripped.length < name.replace(/middleware$/i, "").length;
        const words = splitWords(stripped);
        const candidate = params && /^(check)?role$/i.test(name) ? params : words.join(" ");
        if (!candidate) continue;
        if (hadPrefix || words.some((w) => ROLE_WORDS.has(w) || this.knownRoles.has(w))) out.push(this.actor(candidate, "middleware", mw));
      }
    }
    return out;
  }

  /** A role word inside a route or ability name: approve-manager -> Manager. */
  roleFromName(name: string): string | null {
    const words = splitWords(name);
    for (const w of words) {
      if (NOT_ROLES.has(w)) continue;
      if (this.knownRoles.has(w) || ROLE_WORDS.has(w)) return w;
    }
    return null;
  }

  actor(name: string, via: ActorRef["via"], detail: string): ActorRef {
    const display = displayRole(name);
    if (via !== "name") for (const w of splitWords(display)) if (!NOT_ROLES.has(w)) this.knownRoles.add(w);
    return { name: display, via, detail, kind: "role" };
  }

  /**
   * can:X / @can('X') / permission:X. Kebab or snake ability names with a role word
   * (approve-manager) name a role; anything else is a named permission, kept as written
   * ("Slide Approve"), because that is how the team knows it.
   */
  ability(name: string, via: ActorRef["via"], detail: string): ActorRef {
    if (/^[a-z0-9]+([-_.][a-z0-9]+)+$/.test(name)) {
      const role = this.roleFromName(name);
      if (role) return this.actor(role, via, detail);
    }
    if (/^[a-z]+$/.test(name) && (ROLE_WORDS.has(name) || this.knownRoles.has(name))) return this.actor(name, via, detail);
    return { name, via, detail, kind: "permission" };
  }
}

// ---------------------------------------------------------------------------
// Blade conditions
// ---------------------------------------------------------------------------

const VALUE_RE = String.raw`'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|\\?[A-Za-z_][\w\\]*::[A-Za-z_]\w*`;
const COL_RE = String.raw`[a-z_][a-z0-9_]*`;

/** Read status conditions and actors from the raw conditions around a link in a view. */
export function parseViewConditions(conds: string[], reader: ProcessReader, file: string, line: number): { actors: ActorRef[]; requires: StatusCondition[] } {
  const actors: ActorRef[] = [];
  const requires: StatusCondition[] = [];
  for (const raw of conds) {
    const directive = /^@(role|hasrole|hasanyrole|hasallroles|can)\s*\(\s*['"]([^'"]+)['"]/i.exec(raw);
    if (directive) {
      const kind = directive[1].toLowerCase();
      if (kind === "can") {
        pushActor(actors, reader.ability(directive[2], "view", `@can('${directive[2]}')`));
      } else {
        for (const r of directive[2].split(/[|,]/).map((s) => s.trim()).filter(Boolean)) pushActor(actors, reader.actor(r, "view", `@${kind}('${r}')`));
      }
      continue;
    }
    const negatedBlock = raw.startsWith("!(");
    const expr = raw;
    // status comparisons: $x->status == V, V === $x->status
    const cmp = new RegExp(String.raw`\$(\w+)((?:->\w+)*?)->(${COL_RE})(?:->value)?\s*(===?|!==?|<>)\s*(${VALUE_RE})|(${VALUE_RE})\s*(===?|!==?|<>)\s*\$(\w+)((?:->\w+)*?)->(${COL_RE})(?:->value)?`, "gi");
    for (const m of expr.matchAll(cmp)) {
      const [variable, column, op, value] = m[1] ? [m[1], m[3], m[4], m[5]] : [m[9], m[11], m[7], m[6]];
      if (!STATUS_COLUMN.test(column)) continue;
      const equal = op.startsWith("=");
      if (equal === negatedBlock) continue; // only "must be X"
      const v = viewValue(value, reader);
      if (v) requires.push({ subject: viewSubject(variable, column, reader), values: [v], via: "view", source: { file, line } });
    }
    // in_array($x->status, [A, B])
    for (const m of expr.matchAll(new RegExp(String.raw`(!\s*)?in_array\(\s*\$(\w+)(?:->\w+)*?->(${COL_RE})(?:->value)?\s*,\s*\[([^\]]*)\]`, "gi"))) {
      if (Boolean(m[1]) !== negatedBlock || !STATUS_COLUMN.test(m[3])) continue;
      const values = [...m[4].matchAll(new RegExp(VALUE_RE, "g"))].map((x) => viewValue(x[0], reader)).filter((x): x is StatusValue => Boolean(x));
      if (values.length) requires.push({ subject: viewSubject(m[2], m[3], reader), values, via: "view", source: { file, line } });
    }
    if (negatedBlock) continue;
    // actors: user role property, hasRole(), identity == record field
    const userExpr = String.raw`(?:auth\(\)->user\(\)|Auth::user\(\)|\$user|\$authUser|\$currentUser|request\(\)->user\(\)|\$request->user\(\))\??`;
    for (const m of expr.matchAll(new RegExp(String.raw`${userExpr}->(\w+)\s*===?\s*(${VALUE_RE})`, "g"))) {
      if (ROLE_PROPS.test(m[1])) {
        const lit = unquote(m[2]);
        pushActor(actors, reader.actor(/^\d+$/.test(lit) ? `${humanize(m[1])} ${lit}` : lit, "view", `user ${m[1]} == ${m[2]}`));
      }
    }
    for (const m of expr.matchAll(new RegExp(String.raw`${userExpr}->(?:hasRole|hasAnyRole|is)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")`, "g"))) {
      for (const r of [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2])) pushActor(actors, reader.actor(r, "view", `hasRole('${r}')`));
    }
    for (const m of expr.matchAll(new RegExp(String.raw`(?:${userExpr}->(\w+)|(?:auth\(\)|Auth::)id\(\))\s*===?\s*\$\w+->(\w+)|\$\w+->(\w+)\s*===?\s*(?:${userExpr}->(\w+)|(?:auth\(\)|Auth::)id\(\))`, "g"))) {
      const prop = m[1] ?? m[4] ?? "id";
      const field = m[2] ?? m[3];
      if (!IDENTITY_PROPS.test(prop)) continue;
      const role = roleFromField(field);
      if (role) pushActor(actors, reader.actor(role, "view", `user ${prop} == ${field}`));
    }
  }
  return { actors, requires };
}

function viewValue(text: string, reader: ProcessReader): StatusValue | null {
  const t = text.trim();
  if (/^'.*'$|^".*"$/.test(t)) {
    const v = t.slice(1, -1);
    return { value: v, code: `'${v}'`, label: literalLabel(v), labelFrom: "literal" };
  }
  if (/^-?\d/.test(t)) return { value: t, code: t };
  const m = /^(\\?[A-Za-z_][\w\\]*)::(\w+)$/.exec(t);
  if (m) return reader.valueByName(m[1], m[2]);
  return null;
}

function viewSubject(variable: string, column: string, reader: ProcessReader): string {
  const studly = variable.charAt(0).toUpperCase() + variable.slice(1);
  const model = reader.modelFor(studly) ? studly : "";
  return `${model}.${column}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Locals {
  values: Map<string, PhpNode[]>;
  arrays: Map<string, Array<{ key: PhpNode; value: PhpNode }>>;
}

/** Key/value entries of array literals in an argument, including arrays built in local variables. */
function entriesOf(arg: PhpNode, locals: Locals): Array<{ key: PhpNode; value: PhpNode }> {
  const out: Array<{ key: PhpNode; value: PhpNode }> = [];
  for (const arr of arrays(arg)) for (const it of arr.items ?? []) if (it?.kind === "entry" && it.key) out.push({ key: it.key, value: it.value });
  const vars: PhpNode[] = [];
  walk(arg, (n) => {
    if (n.kind === "variable") vars.push(n);
  });
  for (const v of vars) out.push(...(locals.arrays.get(v.name) ?? []));
  return out;
}

/** Leading literal part of a concatenated SQL string. */
function stringPrefix(n: PhpNode): string | null {
  if (n?.kind === "bin" && n.type === ".") return stringValue(n.left) ?? stringPrefix(n.left);
  if (n?.kind === "encapsed") return (n.value ?? []).map((p: PhpNode) => (p?.expression?.kind === "string" ? p.expression.value : "?")).join("");
  return null;
}

/** Short source-like text of an expression, for reports. */
export function exprText(n: PhpNode, depth = 0): string {
  if (!n || depth > 6) return "…";
  switch (n.kind) {
    case "variable":
      return `$${n.name}`;
    case "string":
      return `'${n.value}'`;
    case "number":
      return String(n.value);
    case "boolean":
      return n.value ? "true" : "false";
    case "propertylookup":
    case "nullsafepropertylookup":
      return `${exprText(n.what, depth + 1)}->${n.offset?.name ?? "…"}`;
    case "staticlookup":
      return `${n.what?.name ?? exprText(n.what, depth + 1)}::${n.offset?.name ?? "…"}`;
    case "offsetlookup":
      return `${exprText(n.what, depth + 1)}[${exprText(n.offset, depth + 1)}]`;
    case "call":
      return `${n.what?.kind === "name" ? n.what.name : exprText(n.what, depth + 1)}(${(n.arguments ?? []).map((a: PhpNode) => exprText(a, depth + 1)).join(", ")})`;
    case "retif":
      return `${exprText(n.test, depth + 1)} ? ${exprText(n.trueExpr, depth + 1)} : ${exprText(n.falseExpr, depth + 1)}`;
    case "bin":
      return `${exprText(n.left, depth + 1)} ${n.type} ${exprText(n.right, depth + 1)}`;
    case "name":
      return n.name;
    default:
      return n.kind;
  }
}

interface Comparison {
  left: PhpNode;
  right: PhpNode;
  /** true for != / !== / !in_array */
  negated: boolean;
  inArray?: PhpNode[];
}

function comparisons(expr: PhpNode, negate = false): Comparison[] {
  if (!expr) return [];
  if (expr.kind === "parenthesis") return comparisons(expr.inner, negate);
  if (expr.kind === "unary" && expr.type === "!") return comparisons(expr.what, !negate);
  if (expr.kind === "bin") {
    if (/^(&&|and|\|\||or)$/i.test(expr.type)) return negate ? [] : [...comparisons(expr.left), ...comparisons(expr.right)];
    if (/^(==|===|!=|!==|<>)$/.test(expr.type)) {
      const neg = expr.type.startsWith("!") || expr.type === "<>";
      return [{ left: expr.left, right: expr.right, negated: neg !== negate }];
    }
  }
  if (expr.kind === "call" && expr.what?.kind === "name" && expr.what.name === "in_array" && expr.arguments?.[1]?.kind === "array") {
    return [{ left: expr.arguments[0], right: null, negated: negate, inArray: expr.arguments[1].items.map((i: PhpNode) => (i?.kind === "entry" ? i.value : i)) }];
  }
  return [];
}

function statusSide(c: Comparison): { record: PhpNode; column: string; values: PhpNode[] } | null {
  const col = (n: PhpNode): string | null => {
    let node = n;
    if (node?.kind === "propertylookup" && node.offset?.name === "value") node = node.what;
    return node?.kind === "propertylookup" && STATUS_COLUMN.test(node.offset?.name ?? "") ? node.offset.name : null;
  };
  const unwrap = (n: PhpNode) => (n?.kind === "propertylookup" && n.offset?.name === "value" ? n.what : n);
  if (c.inArray) {
    const column = col(c.left);
    return column ? { record: unwrap(c.left).what, column, values: c.inArray } : null;
  }
  const lc = col(c.left);
  if (lc) return { record: unwrap(c.left).what, column: lc, values: [c.right] };
  const rc = col(c.right);
  if (rc) return { record: unwrap(c.right).what, column: rc, values: [c.left] };
  return null;
}

function subjectOf(record: PhpNode, types: Map<string, string>, column: string): string | null {
  if (record?.kind === "variable" && typeof record.name === "string") {
    if (record.name === "this" || record.name === "request") return null;
    return `${types.get(record.name) ?? ""}.${column}`;
  }
  return `.${column}`;
}

function exits(body: PhpNode): boolean {
  const stmts = body?.kind === "block" ? body.children : [body];
  return (stmts ?? []).some((s: PhpNode) => {
    if (!s) return false;
    if (s.kind === "return" || s.kind === "throw") return true;
    const e = s.kind === "expressionstatement" ? s.expression : s;
    return e?.kind === "call" && e.what?.kind === "name" && /^(abort|abort_if|abort_unless|redirect|back|throw_if)$/.test(e.what.name);
  });
}

function arrays(n: PhpNode): PhpNode[] {
  if (!n) return [];
  if (n.kind === "array") return [n];
  if (n.kind === "bin" && n.type === "+") return [...arrays(n.left), ...arrays(n.right)];
  if (n.kind === "call" && n.what?.kind === "name" && /^array_merge$/.test(n.what.name)) return (n.arguments ?? []).flatMap(arrays);
  return [];
}

function isCurrentUser(n: PhpNode, userVars: Set<string>): boolean {
  return userProp({ kind: "propertylookup", what: n, offset: { name: "__self" } }, userVars) === "__self";
}

/** If n is <current user>->prop, return prop. With `call`, accept method lookups too. */
function userProp(n: PhpNode, userVars: Set<string>, call = false): string | null {
  if (n?.kind !== "propertylookup" && n?.kind !== "nullsafepropertylookup") return null;
  const prop: string = n.offset?.name;
  const base = n.what;
  const isUser =
    (base?.kind === "variable" && userVars.has(base.name)) ||
    (base?.kind === "call" &&
      ((base.what?.kind === "propertylookup" && base.what.offset?.name === "user" &&
        ((base.what.what?.kind === "call" && /^(auth|request)$/.test(base.what.what.what?.name)) || base.what.what?.kind === "variable")) ||
        (base.what?.kind === "staticlookup" && base.what.offset?.name === "user" && /(^|\\)Auth$/.test(base.what.what?.name ?? ""))));
  void call;
  return isUser ? prop : null;
}

function argStrings(n: PhpNode): string[] {
  if (!n) return [];
  const s = stringValue(n);
  if (s !== null) return s.split("|").map((x) => x.trim()).filter(Boolean);
  if (n.kind === "array") return n.items.map((i: PhpNode) => stringValue(i?.kind === "entry" ? i.value : i)).filter((x: string | null): x is string => Boolean(x));
  return [];
}

/** manager_nik -> Manager, atasan_id -> Atasan, created_by / user_id -> Creator */
function roleFromField(field: string): string | null {
  if (/^(user_id|created_by|creator_id|owner_id|requester_id|requested_by|submitted_by|nik|nip|user_nik)$/i.test(field)) return "Creator";
  const m = /^(.+?)_?(nik|nip|npk|id|user_id|username|email|code|kode)$/i.exec(field);
  if (!m) return null;
  const base = m[1].replace(/_$/, "");
  if (/^(user|created|creator|owner)$/i.test(base)) return "Creator";
  if (/^(pic|current_pic)$/i.test(base)) return "PIC";
  return base.length >= 2 ? displayRole(base) : null;
}

function pushActor(list: ActorRef[], a: ActorRef): void {
  if (!list.some((x) => x.name.toLowerCase() === a.name.toLowerCase() && x.via === a.via)) list.push(a);
}

function literal(n: PhpNode): string | null {
  if (!n) return null;
  if (n.kind === "string") return n.value;
  if (n.kind === "number") return String(n.value);
  if (n.kind === "boolean") return n.value ? "true" : "false";
  if (n.kind === "unary" && n.type === "-" && n.what?.kind === "number") return `-${n.what.value}`;
  return null;
}

function unquote(s: string): string {
  return /^'.*'$|^".*"$/.test(s) ? s.slice(1, -1) : s;
}

function pluralSnake(short: string): string {
  const sn = snake(short);
  if (/(s|x|z|ch|sh)$/.test(sn)) return sn + "es";
  if (/[^aeiou]y$/.test(sn)) return sn.slice(0, -1) + "ies";
  return sn + "s";
}

export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

export function humanize(s: string): string {
  const words = splitWords(s);
  if (!words.length) return s;
  const out = words.join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const ACRONYMS = new Set(["hr", "hrd", "gm", "ceo", "cfo", "coo", "pic", "qc", "qa", "it", "ga", "spv"]);

export function displayRole(s: string): string {
  const words = splitWords(s);
  if (!words.length) return s;
  return words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

function constLabel(name: string): string {
  return humanize(name.replace(/^(STATUS|STATE|STAGE|STEP|APPROVAL)_/i, ""));
}

/** APPROVED_MANAGER -> "Approved manager", waiting_approval -> "Waiting approval"; "Hold - Perlu Revisi" stays as written. */
function literalLabel(v: string): string | undefined {
  if (/^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(v) || /^[a-z0-9]+([_-][a-z0-9]+)*$/.test(v)) return /[A-Za-z]/.test(v) ? humanize(v) : undefined;
  return /[A-Za-z]/.test(v) && v.length <= 60 ? v.trim() : undefined;
}

function columnFromHolder(holder: string): string {
  const m = /^(?:get)?([a-z_]*?)(?:_?(?:status|state|stage))/i.exec(holder);
  if (m && m[1] && !/^(all|list|get)$/i.test(m[1])) {
    const prefix = splitWords(m[1]).join("_");
    if (prefix && !/^(all|list|labels?)$/.test(prefix)) return `${prefix}_status`;
  }
  return "status";
}

