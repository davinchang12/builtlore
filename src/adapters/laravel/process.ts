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
import type { ActorRef, ProcessInfo, Reach, StatesFact, StatusCondition, StatusValue, StatusWrite, Subject } from "../../core/types.js";
import { ClassLocator } from "./controllers.js";
import { flattenChain, lineOf, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";

/** Columns that hold a workflow state (tested on the snake_case form, so StatusApproval works too). */
const STATUS_COLUMN_RE = /^(status|state|stage|step|phase|approval|approval_status|approval_state|workflow_status|status_[a-z0-9_]+|[a-z0-9_]+_status|(?:[a-z0-9]+_)*status_id|is_approved?|approved?|flag_approval|approval_flag)$/i;

/** Relations that hold a record's status history: $request->status()->create([...]). */
const STATUS_RELATION = /^(status|statuses|state|states|latest_?status|status_?histor(y|ies))$/i;
/** Models whose rows ARE the status (TStatusRequest); History/Log tables only record what happened. */
const STATUS_MODEL = /(Status|State)(?!.*(History|Histories|Log|Logs|Audit))/;

/** How deep builtlore follows calls into services (controller → service → service). */
const MAX_CALL_DEPTH = 3;

interface AnalyzeOptions {
  /** Types of parameters passed in by the caller (service methods are often untyped). */
  seedTypes?: Map<string, string>;
  /** Status values of parameters passed in by the caller. */
  seedValues?: Map<string, StatusValue[]>;
  depth?: number;
  stack?: Set<string>;
}
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

  /** Table of a model class: $table, or Laravel's snake_case plural convention. */
  tableForModel(fqcn: string): string | null {
    const info = this.classInfo(fqcn);
    if (info?.table) return info.table;
    const short = fqcn.split("\\").pop();
    return short ? pluralSnake(short) : null;
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
  analyzeHandler(body: PhpNode, names: NameContext, file: string, selfClass?: string, opts: AnalyzeOptions = {}): ProcessInfo {
    const info: ProcessInfo = { actors: [], writes: [], requires: [], creates: [] };
    const types = new Map<string, string>(opts.seedTypes ?? []); // variable -> model short name
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

    const locals: Locals = { values: new Map(), arrays: new Map(), seeded: opts.seedValues };
    const statusVars = new Map<string, Subject>(); // $latestStatus -> Request.status_id
    walk(body, (n) => {
      // $x = Model::find(...) / new Model / auth()->user()
      if (n.kind === "assign" && n.left?.kind === "variable" && typeof n.left.name === "string") {
        const model = this.modelOfExpr(n.right, names, types);
        if (model) types.set(n.left.name, model);
        if (n.right?.kind === "variable" && types.has(n.right.name)) types.set(n.left.name, types.get(n.right.name)!);
        // $latestStatus = TStatusX::where('x_id', $x->id)->latest()->value('status_id')
        const current = this.currentStatusOf(n.right, names, types);
        if (current) statusVars.set(n.left.name, current);
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
          if (subj) this.recordWrite(info, subj, col, n.right, names, selfClass, locals, { file, line: lineOf(n) }, n);
        }
      }
      if (n.kind === "call" || n.kind === "new") {
        this.readCall(n, names, types, file, info, selfClass, userVars, locals);
      }
      if (n.kind === "if" && n.test && exits(n.body)) {
        // if (status != V) return / abort: the step requires V
        for (const c of comparisons(n.test)) {
          this.readGuard(c, names, types, file, info, selfClass, lineOf(n), true);
          this.readVarGuard(c, statusVars, names, selfClass, file, info, lineOf(n));
        }
        for (const a of this.actorsInExpr(n.test, userVars, names, types)) pushActor(info.actors, a);
      }
      return undefined;
    });
    if (statusVars.size) info.statusVars = Object.fromEntries(statusVars);

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

    // Where each write sits: its position, and which if/else branch it is in
    const branches = branchPaths(
      body,
      (test) => decideWithSeeds(test, opts.seedValues),
      (test) => this.branchAtoms(test, statusVars, names, selfClass, types),
    );
    for (const w of info.writes) {
      const at = this.writeAt.get(w);
      if (!at || w.order) continue;
      w.order = [offsetOf(at.node)];
      w.branch = [...(branches.get(at.node) ?? []), ...(at.alt !== undefined ? [`v${offsetOf(at.node)}:${at.alt}`] : [])];
    }
    info.writes = info.writes.filter((w) => !w.branch?.includes("dead:1"));
    const dead = new Set<number>();
    walk(body, (n) => {
      if (branches.get(n)?.includes("dead:1")) {
        const l = lineOf(n);
        if (l !== undefined) dead.add(l);
      }
    });
    if (dead.size) info.deadLines = [...dead].sort((a, b) => a - b);

    // Status changes made in services the handler calls ($this->approval->hold($request))
    this.followCalls(body, names, selfClass, types, locals, info, opts.depth ?? 0, opts.stack ?? new Set(), branches);
    return info;
  }

  /** The AST node of each write recorded in this scan, to place it in order and in its branch. */
  private writeAt = new WeakMap<StatusWrite, { node: PhpNode; alt?: number }>();

  // ----- current status and branch conditions -----------------------------

  /**
   * An expression that reads a record's current status:
   *   TStatusX::where('x_id', $x->id)->latest()->value('status_id')   (history table)
   *   $x->statuses()->latest()->value('status_id') · $x->latestStatus->status_id
   *   TStatusX::where('x_id', $x->id)->orderByDesc('id')->first()->status_id
   * Returns the subject ("X.status_id"), or null.
   */
  currentStatusOf(expr: PhpNode, names: NameContext, types: Map<string, string>): Subject | null {
    let node = expr;
    if (node?.kind === "cast" || node?.kind === "parenthesis") node = node.what ?? node.expr ?? node.inner;
    let column: string | null = null;
    let chainNode: PhpNode = null;
    if ((node?.kind === "propertylookup" || node?.kind === "nullsafepropertylookup") && STATUS_COLUMN.test(node.offset?.name ?? "")) {
      column = node.offset.name;
      chainNode = node.what;
      // $x->latestStatus->status_id
      if ((chainNode?.kind === "propertylookup" || chainNode?.kind === "nullsafepropertylookup") && chainNode.what?.kind === "variable" && /status/i.test(chainNode.offset?.name ?? "")) {
        const model = types.get(chainNode.what.name);
        return model ? `${model}.${column}` : null;
      }
    } else if (node?.kind === "call") chainNode = node;
    const chain = chainNode?.kind === "call" ? flattenChain(chainNode) : null;
    if (!chain) return null;
    if (!column) {
      const pick = chain.steps.find((s) => s.name === "value" || s.name === "pluck");
      const col = pick ? stringValue(pick.args[0]) : null;
      if (!col || !STATUS_COLUMN.test(col)) return null;
      column = col;
    }
    // Only reads that take one record's latest row (latest / orderByDesc / first / last)
    if (!chain.steps.some((s) => /^(latest|orderByDesc|orderBy|first|last|value|pluck|sole)$/.test(s.name))) return null;
    // History table queried by the owner's id
    if (chain.root.type === "static") {
      const model = this.modelName(chain.root.class, names);
      const where = chain.steps.find((s) => s.name === "where" && s.args.length === 2 && /_id$/.test(stringValue(s.args[0]) ?? "") && s.args[1]?.kind === "propertylookup" && s.args[1].offset?.name === "id" && s.args[1].what?.kind === "variable");
      const owner = where ? types.get(where.args[1].what.name) : undefined;
      if (owner && owner !== model) return `${owner}.${column}`;
      return model ? `${model}.${column}` : null;
    }
    // $x->statuses()->latest()->value(...)
    const base = chain.steps.length ? baseVariableOf(chainNode) : null;
    const model = base ? types.get(base) : undefined;
    return model ? `${model}.${column}` : null;
  }

  /** if ($latestStatus != X) return …: the step requires X. */
  private readVarGuard(c: Comparison, statusVars: Map<string, Subject>, names: NameContext, selfClass: string | undefined, file: string, info: ProcessInfo, line: number | undefined): void {
    const varOf = (n: PhpNode) => (n?.kind === "variable" && statusVars.has(n.name) ? statusVars.get(n.name)! : null);
    const requiresEqual = c.negated; // the code leaves when the comparison is true
    if (!requiresEqual) return;
    if (c.inArray) {
      const subject = varOf(c.left);
      const values = c.inArray.map((v) => this.value(v, names, selfClass)).filter((v): v is StatusValue => Boolean(v));
      if (subject && values.length) info.requires.push({ subject, values, via: "guard", source: { file, line } });
      return;
    }
    const subject = varOf(c.left) ?? varOf(c.right);
    const v = this.value(varOf(c.left) ? c.right : c.left, names, selfClass);
    if (subject && v) info.requires.push({ subject, values: [v], via: "guard", source: { file, line } });
  }

  /**
   * What an if-condition says about the branch it guards, as "key:value" atoms:
   *   Gate::allows('medical') -> gate·medical:1 (and :0 when negated)
   *   $latestStatus == 4 / $x->status == 'HOLD' -> st·X.status_id:4
   * Branches whose atoms disagree cannot both run.
   */
  branchAtoms(test: PhpNode, statusVars: Map<string, Subject>, names: NameContext, selfClass: string | undefined, types: Map<string, string>): { then: string[]; else: string[] } {
    const conj: PhpNode[] = [];
    const flatten = (n: PhpNode): boolean => {
      if (n?.kind === "parenthesis") return flatten(n.inner);
      if (n?.kind === "bin" && /^(&&|and)$/i.test(n.type)) return flatten(n.left) && flatten(n.right);
      if (n?.kind === "bin" && /^(\|\||or)$/i.test(n.type)) return false;
      conj.push(n);
      return true;
    };
    if (!flatten(test)) return { then: [], else: [] };
    const atom = (n: PhpNode, neg: boolean): string | null => {
      if (n?.kind === "parenthesis") return atom(n.inner, neg);
      if (n?.kind === "unary" && n.type === "!") return atom(n.what, !neg);
      if (n?.kind === "call") {
        const method: string | undefined = n.what?.offset?.name;
        const arg = stringValue(n.arguments?.[0]);
        if (!method || !arg) return null;
        const isGate = n.what?.kind === "staticlookup" && /(^|\\)Gate$/.test(n.what.what?.name ?? "");
        if (isGate && /^(allows|check|any)$/.test(method)) return `gate·${arg}:${neg ? 0 : 1}`;
        if (isGate && method === "denies") return `gate·${arg}:${neg ? 1 : 0}`;
        if (!isGate && (method === "can" || method === "cannot")) return `gate·${arg}:${(method === "can") !== neg ? 1 : 0}`;
        if (!isGate && /^(hasRole|hasAnyRole)$/.test(method)) return `role·${arg}:${neg ? 0 : 1}`;
        return null;
      }
      if (n?.kind === "bin" && /^(==|===|!=|!==)$/.test(n.type)) {
        const equal = !n.type.startsWith("!") !== neg;
        if (!equal) return null; // "is not X" names no single status
        const subjectOf2 = (x: PhpNode): Subject | null => {
          if (x?.kind === "variable" && statusVars.has(x.name)) return statusVars.get(x.name)!;
          const col = x?.kind === "propertylookup" ? x.offset?.name : null;
          return col && STATUS_COLUMN.test(col) ? subjectOf(x.what, types, col) : null;
        };
        const s = subjectOf2(n.left) ?? subjectOf2(n.right);
        const v = this.value(subjectOf2(n.left) ? n.right : n.left, names, selfClass);
        return s && v ? `st·${s}:${v.value}` : null;
      }
      return null;
    };
    return {
      then: conj.map((c) => atom(c, false)).filter((x): x is string => Boolean(x)),
      else: conj.length === 1 ? [atom(conj[0], true)].filter((x): x is string => Boolean(x)) : [],
    };
  }

  // ----- calls into services ----------------------------------------------

  private callCache = new Map<string, ProcessInfo>();
  private propCache = new Map<string, Map<string, string>>();

  /**
   * Follow calls to methods of the app's own classes (services, helpers, the same
   * controller) and take the status changes, guards and stored procedures found
   * there. Arguments carry their model type into the called method. Actors are not
   * taken over: a service may check several roles, and the step's own code says who.
   */
  private followCalls(
    body: PhpNode,
    names: NameContext,
    selfClass: string | undefined,
    types: Map<string, string>,
    valueLocals: Locals,
    info: ProcessInfo,
    depth: number,
    stack: Set<string>,
    branches: WeakMap<object, string[]>,
  ): void {
    if (depth >= MAX_CALL_DEPTH) return;
    const locals = new Map<string, string>(); // variable -> service class
    for (const p of body.arguments ?? []) {
      const t = p.type?.name;
      const v = p.name?.name ?? p.name;
      if (t && v) {
        const fq = resolveName(t, p.type.resolution, names);
        if (this.isService(fq)) locals.set(v, fq);
      }
    }
    walk(body, (n) => {
      if (n.kind === "assign" && n.left?.kind === "variable" && typeof n.left.name === "string") {
        const cls = this.newClass(n.right, names);
        if (cls && this.isService(cls)) locals.set(n.left.name, cls);
      }
    });

    walk(body, (n) => {
      if (n.kind !== "call") return;
      const what = n.what;
      const method = what?.offset?.name;
      if (typeof method !== "string" || (what.kind !== "propertylookup" && what.kind !== "nullsafepropertylookup" && what.kind !== "staticlookup")) return;
      const recv = what.what;
      let target: string | null = null;
      if (what.kind === "staticlookup") {
        if (recv?.kind === "name") target = recv.name === "self" || recv.name === "static" ? selfClass ?? null : resolveName(recv.name, recv.resolution, names);
      } else if (recv?.kind === "variable" && recv.name === "this") target = selfClass ?? null;
      else if ((recv?.kind === "propertylookup" || recv?.kind === "nullsafepropertylookup") && recv.what?.kind === "variable" && recv.what.name === "this") {
        target = selfClass ? this.propertyClass(selfClass, recv.offset?.name) : null;
      } else if (recv?.kind === "variable" && typeof recv.name === "string") target = locals.get(recv.name) ?? null;
      else target = this.newClass(recv, names);
      if (!target || !this.isService(target)) return;
      if (branches.get(n)?.includes("dead:1")) return; // in a branch that cannot run with the values passed in

      const found = this.methodOf(target, method);
      if (!found) return;
      const key = `${target}@${method}`;
      if (stack.has(key)) return;
      const seed = new Map<string, string>();
      const seedValues = new Map<string, StatusValue[]>();
      (n.arguments ?? []).forEach((a: PhpNode, i: number) => {
        const p = found.node.arguments?.[i];
        const pname = p?.name?.name ?? p?.name;
        if (!a || typeof pname !== "string") return;
        if (a.kind === "variable" && types.has(a.name)) seed.set(pname, types.get(a.name)!);
        // A status value passed in (a literal, a constant, or a variable holding one): the callee may write it
        const vs = this.values(a, names, selfClass, valueLocals);
        if (vs?.length) seedValues.set(pname, vs);
      });
      // Parameters left out take their default: function approve($x, $mode = 'normal')
      (found.node.arguments ?? []).forEach((p: PhpNode, i: number) => {
        const pname = p?.name?.name ?? p?.name;
        if (i < (n.arguments ?? []).length || typeof pname !== "string" || !p.value) return;
        const v = this.value(p.value, found.names, found.cls);
        if (v) seedValues.set(pname, [v]);
      });
      const cacheKey = `${key}|${[...seed].map(([k, v]) => `${k}:${v}`).join(",")}|${[...seedValues].map(([k, v]) => `${k}=${v.map((x) => x.value).join("/")}`).join(",")}`;
      let sub = this.callCache.get(cacheKey);
      if (!sub) {
        sub = this.analyzeHandler(found.node, found.names, found.file, found.cls, { seedTypes: seed, seedValues, depth: depth + 1, stack: new Set([...stack, key]) });
        this.callCache.set(cacheKey, sub);
      }
      // Remember what this step reaches, and which lines there cannot run with these arguments
      const reached: Reach[] = [{ method: key, ...(sub.deadLines?.length ? { dead: sub.deadLines } : {}) }, ...(sub.calls ?? [])];
      for (const r of reached) {
        const sig = `${r.method}|${(r.dead ?? []).join(",")}`;
        if (!(info.calls ?? []).some((x) => `${x.method}|${(x.dead ?? []).join(",")}` === sig)) (info.calls ??= []).push(r);
      }
      // The callee's writes happen at the call: in its place in the sequence and in its branch
      const callOrder = offsetOf(n);
      const callBranch = branches.get(n) ?? [];
      for (const w of sub.writes) {
        const placed: StatusWrite = { ...w, order: [callOrder, ...(w.order ?? [])], branch: [...callBranch, ...(w.branch ?? [])] };
        const key = (x: StatusWrite) => `${x.subject}|${x.to.value}|${(x.order ?? []).join(".")}`;
        if (!info.writes.some((x) => key(x) === key(placed))) info.writes.push(placed);
      }
      for (const r of sub.requires) info.requires.push(r);
      for (const c of sub.creates) if (!info.creates.includes(c)) info.creates.push(c);
      for (const u of sub.unresolved ?? []) if (!(info.unresolved ?? []).some((x) => x.source.file === u.source.file && x.source.line === u.source.line)) (info.unresolved ??= []).push(u);
      for (const sp of sub.procedures ?? []) if (!(info.procedures ?? []).includes(sp)) (info.procedures ??= []).push(sp);
    });
  }

  /** new X / (new X) / app(X::class) / resolve(X::class) -> FQCN */
  private newClass(n: PhpNode, names: NameContext): string | null {
    if (!n) return null;
    if (n.kind === "parenthesis") return this.newClass(n.inner, names);
    if (n.kind === "new" && n.what?.kind === "name") return resolveName(n.what.name, n.what.resolution, names);
    if (n.kind === "call" && n.what?.kind === "name" && /^\\?(app|resolve)$/.test(n.what.name)) {
      const a = n.arguments?.[0];
      if (a?.kind === "staticlookup" && (a.offset?.name ?? "") === "class" && a.what?.kind === "name") return resolveName(a.what.name, a.what.resolution, names);
    }
    return null;
  }

  /** An app class that is not a model, enum or form request: services, helpers, controllers. */
  private isService(fqcn: string): boolean {
    if (!fqcn.startsWith("App\\") && !this.locator.fileFor(fqcn)) return false;
    if (/\\Http\\Requests\\/.test(fqcn)) return false;
    const info = this.classInfo(fqcn);
    return Boolean(info && !info.isModel && !info.isEnum);
  }

  /** A method of a class or of its parents in the app. */
  private methodOf(fqcn: string, method: string, depth = 0): { node: PhpNode; names: NameContext; file: string; cls: string } | null {
    const loaded = this.locator.load(fqcn);
    if (!loaded || depth > 3) return null;
    let found: PhpNode = null;
    let parent: string | null = null;
    walk(loaded.ast, (n) => {
      if (found) return false;
      if (n.kind === "class" || n.kind === "trait") {
        parent = n.extends?.name ? resolveName(n.extends.name, n.extends.resolution, loaded.names) : null;
        for (const m of n.body ?? []) if (m.kind === "method" && (m.name?.name ?? m.name) === method && m.body) found = m;
        return false;
      }
    });
    if (found) return { node: found, names: loaded.names, file: loaded.file, cls: fqcn };
    return parent ? this.methodOf(parent, method, depth + 1) : null;
  }

  /** Class of $this->prop: typed property, promoted constructor parameter, or set in the constructor. */
  private propertyClass(fqcn: string, prop: unknown): string | null {
    if (typeof prop !== "string") return null;
    let props = this.propCache.get(fqcn);
    if (!props) {
      props = new Map();
      this.propCache.set(fqcn, props);
      const loaded = this.locator.load(fqcn);
      if (loaded) {
        const { names } = loaded;
        walk(loaded.ast, (n) => {
          if (n.kind !== "class") return;
          for (const m of n.body ?? []) {
            if (m.kind === "propertystatement") {
              for (const p of m.properties ?? []) {
                const pn = p.name?.name ?? p.name;
                if (p.type?.name && typeof pn === "string") props!.set(pn, resolveName(p.type.name, p.type.resolution, names));
              }
            }
            if (m.kind === "method" && (m.name?.name ?? m.name) === "__construct") {
              const params = new Map<string, string>();
              for (const a of m.arguments ?? []) {
                const an = a.name?.name ?? a.name;
                if (!a.type?.name || typeof an !== "string") continue;
                const t = resolveName(a.type.name, a.type.resolution, names);
                params.set(an, t);
                if (a.flags || a.visibility || a.readonly) props!.set(an, t); // promoted: private Service $svc
              }
              walk(m.body, (x) => {
                if (x.kind !== "assign" || x.left?.kind !== "propertylookup" || x.left.what?.name !== "this") return;
                const name = x.left.offset?.name;
                if (typeof name !== "string") return;
                const cls = this.newClass(x.right, names) ?? (x.right?.kind === "variable" ? params.get(x.right.name) ?? null : null);
                if (cls) props!.set(name, cls);
              });
            }
          }
          return false;
        });
      }
    }
    return props.get(prop) ?? null;
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
      if (!assigned?.length) return locals.seeded?.get(node.name) ?? null;
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
    at?: PhpNode,
  ): void {
    const vs = this.values(valueNode, names, selfClass, locals);
    if (vs) {
      vs.forEach((v, i) => {
        if (info.writes.some((w) => w.subject === subject && w.to.value === v.value && this.writeAt.get(w)?.node === at)) return;
        const w: StatusWrite = { subject, to: v, source };
        info.writes.push(w);
        // Several values from one expression (ternary, match) are alternatives, not a sequence
        if (at) this.writeAt.set(w, { node: at, alt: vs.length > 1 ? i : undefined });
      });
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
        this.readSql(sql, info, { file, line: lineOf(n) }, n);
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
    let subjectBase = subjectModel ?? tableSubject;

    // $request->status()->create([...]): a row in the record's status history, not a new record
    const rel = n.kind === "call" ? statusRelation(n.what?.what) : null;
    // TStatusRequest::create(['request_id' => $request->id, 'status_id' => …]): same, written from the other side
    const owner = !rel && subjectModel && STATUS_MODEL.test(subjectModel) ? this.ownerOf(n.arguments ?? [], types, subjectModel, locals) : null;
    if (owner) subjectBase = owner;

    if (subjectModel && !rel && /^(create|firstOrCreate|updateOrCreate|forceCreate|new|make)$/.test(method)) {
      if (!info.creates.includes(subjectModel)) info.creates.push(subjectModel);
    }
    for (const arg of n.arguments ?? []) {
      for (const entry of entriesOf(arg, locals)) {
        const k = stringValue(entry.key);
        if (!k || !STATUS_COLUMN.test(k)) continue;
        this.recordWrite(info, `${subjectBase ?? ""}.${k}`, k, entry.value, names, selfClass, locals, { file, line: lineOf(n) }, n);
      }
    }
  }

  /** The record a status-history row belongs to: ['request_id' => $request->id] with $request a known model. */
  private ownerOf(args: PhpNode[], types: Map<string, string>, rowModel: string, locals: Locals): string | null {
    for (const arg of args) {
      for (const e of entriesOf(arg, locals)) {
        const k = stringValue(e.key);
        const v = e.value;
        if (!k || !/_id$/.test(k) || STATUS_COLUMN.test(k)) continue;
        if (v?.kind === "propertylookup" && v.offset?.name === "id" && v.what?.kind === "variable") {
          const model = types.get(v.what.name);
          if (model && model !== rowModel) return model;
        }
      }
    }
    return null;
  }

  /** UPDATE ... SET status = 'X' in raw SQL; EXEC / CALL of stored procedures. */
  private readSql(sql: string, info: ProcessInfo, source: { file: string; line?: number }, at?: PhpNode): void {
    const upd = /\bupdate\s+\[?(?:\w+\]?\.\[?)?(\w+)\]?\s+set\s+([\s\S]+?)(?:\bwhere\b|$)/i.exec(sql);
    if (upd) {
      for (const m of upd[2].matchAll(/\[?(\w+)\]?\s*=\s*('([^']*)'|-?\d+|\?|:\w+)/g)) {
        if (!STATUS_COLUMN.test(m[1])) continue;
        const subject = `${this.modelForTable(upd[1]) ?? upd[1]}.${m[1]}`;
        if (m[3] !== undefined || /^-?\d+$/.test(m[2])) {
          const value = m[3] ?? m[2];
          const w: StatusWrite = { subject, to: { value, code: m[2], label: m[3] !== undefined ? literalLabel(value) : undefined, labelFrom: m[3] !== undefined ? "literal" : undefined }, source };
          info.writes.push(w);
          if (at) this.writeAt.set(w, { node: at });
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
export function parseViewConditions(
  conds: string[],
  reader: ProcessReader,
  file: string,
  line: number,
  /** View variables that hold a record's current status, from the handler: latestStatus -> X.status_id */
  vars: Record<string, Subject> = {},
): { actors: ActorRef[]; requires: StatusCondition[] } {
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
    let expr = raw;
    // A || B: a status comparison is only a requirement when every alternative is one
    const alternatives = raw.replace(/^!\(|\)$/g, "").split(/\|\||\s+or\s+/i);
    if (alternatives.length > 1) {
      const isStatusCmp = (part: string) =>
        new RegExp(String.raw`->(${COL_RE})(?:->value)?\s*(===?|!==?)|\$(\w+)\s*===?\s*(${VALUE_RE})|(${VALUE_RE})\s*===?\s*\$(\w+)|in_array\(`, "i").test(part) &&
        !/^\s*!?\s*\$\w+\s*$/.test(part);
      if (!alternatives.every((p) => isStatusCmp(p) && (/->\w+/.test(p) || Object.keys(vars).some((v) => p.includes(`$${v}`))))) expr = raw.replace(/\$\w+(?:->\w+)*\s*(===?|!==?|<>)\s*\S+/g, "");
    }
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
    // $latestStatus == 4, where the handler set $latestStatus to the record's current status
    const bare = new RegExp(String.raw`\$(\w+)\s*(===?|!==?|<>)\s*(${VALUE_RE})|(${VALUE_RE})\s*(===?|!==?|<>)\s*\$(\w+)(?!\s*->|\w)`, "g");
    for (const m of expr.matchAll(bare)) {
      const [variable, op, value] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[5], m[4]];
      const subject = vars[variable];
      if (!subject) continue;
      if (op.startsWith("=") === negatedBlock) continue;
      const v = viewValue(value, reader);
      if (v) requires.push({ subject, values: [v], via: "view", source: { file, line } });
    }
    for (const m of expr.matchAll(/(!\s*)?in_array\(\s*\$(\w+)\s*,\s*\[([^\]]*)\]/g)) {
      const subject = vars[m[2]];
      if (!subject || Boolean(m[1]) !== negatedBlock) continue;
      const values = [...m[3].matchAll(new RegExp(VALUE_RE, "g"))].map((x) => viewValue(x[0], reader)).filter((x): x is StatusValue => Boolean(x));
      if (values.length) requires.push({ subject, values, via: "view", source: { file, line } });
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
  /** Parameter values passed in by the caller: tambahStatus($x, Constant::STATUS_HOLD). */
  seeded?: Map<string, StatusValue[]>;
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

/** $param == 'x' / $param != 'x' with $param passed in as one known value: true or false; otherwise unknown. */
function decideWithSeeds(test: PhpNode, seeds: Map<string, StatusValue[]> | undefined): boolean | undefined {
  if (!seeds?.size || test?.kind !== "bin" || !/^(==|===|!=|!==)$/.test(test.type)) return undefined;
  const side = (a: PhpNode, b: PhpNode) => {
    if (a?.kind !== "variable" || typeof a.name !== "string") return undefined;
    const vs = seeds.get(a.name);
    const lit = literal(b);
    if (!vs || vs.length !== 1 || lit === null) return undefined;
    return vs[0].value === lit;
  };
  const eq = side(test.left, test.right) ?? side(test.right, test.left);
  if (eq === undefined) return undefined;
  return test.type.startsWith("!") ? !eq : eq;
}

/** $x in $x->a()->b(): the variable a call chain starts from. */
function baseVariableOf(n: PhpNode): string | null {
  let cur = n;
  while (cur) {
    if (cur.kind === "call") cur = cur.what;
    else if (cur.kind === "propertylookup" || cur.kind === "nullsafepropertylookup") cur = cur.what;
    else if (cur.kind === "variable") return typeof cur.name === "string" ? cur.name : null;
    else return null;
  }
  return null;
}

function offsetOf(n: PhpNode): number {
  return n?.loc?.start?.offset ?? (n?.loc?.start?.line ?? 0) * 1000;
}

/**
 * For every node, the if/else (and switch, ternary) branches it is in, as "<id>:<branch>".
 * Code after `if (x) { …; return; }` runs only when x is false, so it counts as the else branch.
 */
export function branchPaths(
  body: PhpNode,
  decide?: (test: PhpNode) => boolean | undefined,
  atoms?: (test: PhpNode) => { then: string[]; else: string[] },
): WeakMap<object, string[]> {
  const map = new WeakMap<object, string[]>();
  const visit = (node: PhpNode, path: string[]): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      let cur = path;
      for (const stmt of node) {
        visit(stmt, cur);
        if (stmt?.kind === "if") cur = afterIf(stmt, cur);
      }
      return;
    }
    if (typeof node.kind !== "string") return;
    map.set(node, path);
    const id = offsetOf(node);
    if (node.kind === "if") {
      // A condition known from the caller's arguments (if ($mode != 'skip')): the other branch never runs here
      const known = decide?.(node.test);
      visit(node.test, path);
      const what = atoms?.(node.test) ?? { then: [], else: [] };
      visit(node.body, [...path, `if${id}:0`, ...what.then, ...(known === false ? ["dead:1"] : [])]);
      visit(node.alternate, [...path, `if${id}:1`, ...what.else, ...(known === true ? ["dead:1"] : [])]);
      return;
    }
    if (node.kind === "switch") {
      visit(node.test, path);
      (node.body?.children ?? []).forEach((c: PhpNode, i: number) => visit(c, [...path, `sw${id}:${i}`]));
      return;
    }
    if (node.kind === "retif") {
      visit(node.test, path);
      visit(node.trueExpr, [...path, `t${id}:0`]);
      visit(node.falseExpr, [...path, `t${id}:1`]);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
      const v = node[key];
      if (v && typeof v === "object") visit(v, path);
    }
  };
  /** if (a) { return } elseif (b) { return }: what follows runs in the last else. */
  const afterIf = (stmt: PhpNode, path: string[]): string[] => {
    let cur = path;
    let node = stmt;
    while (node?.kind === "if" && exits(node.body)) {
      cur = [...cur, `if${offsetOf(node)}:1`, ...(atoms?.(node.test).else ?? [])];
      node = node.alternate;
    }
    return cur;
  };
  visit(body, []);
  return map;
}

/** $x->status() in $x->status()->create(...): the relation name when it holds status history. */
function statusRelation(n: PhpNode): string | null {
  if (n?.kind !== "call" || (n.what?.kind !== "propertylookup" && n.what?.kind !== "nullsafepropertylookup")) return null;
  const name = n.what.offset?.name;
  return typeof name === "string" && STATUS_RELATION.test(name) ? name : null;
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

