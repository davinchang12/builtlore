/**
 * Core data types.
 *
 * Adapters turn source code into Facts (deterministic, stack-specific).
 * The model builder turns Facts into a BuiltMap (stack-agnostic).
 */

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ANY";

/** page: renders a screen · action: form submit · api: routes/api.php · data: returns JSON (AJAX) · download: returns a file · redirect: Route::redirect */
export type EntryType = "page" | "action" | "api" | "data" | "download" | "redirect";

export interface SourceRef {
  file: string; // repo-relative, forward slashes
  line?: number;
}

/** A way into the application: a page, a form action, an API endpoint. */
export interface EntryFact {
  kind: "entry";
  id: string; // stable: "route:<name>" or "route:<METHOD> <uri>"
  type: EntryType;
  methods: HttpMethod[];
  uri: string;
  name?: string;
  middleware: string[];
  handler?: HandlerRef;
  /** View rendered by this entry, e.g. "booking.index" (Blade) or "Booking/Index" (Inertia). */
  view?: ViewRef;
  source: SourceRef;
  /** Who may do this and how it changes a record's status (Process layer). */
  process?: ProcessInfo;
  /** Validation rules applied to the request (validate(), Validator::make, FormRequest rules()). */
  validation?: Validation[];
  /** Request fields the handler reads ($request->input('x'), $request->x, only/except). */
  inputs?: string[];
  /** What the handler returns, when the code says. */
  responds?: ResponseKind[];
  /** Methods of the app's own classes the handler reaches (services, helpers), to link what they do to this step. */
  calls?: Reach[];
  /** Abilities a page handler checks and hands to its view (to show or hide buttons), not enforced. */
  pageAbilities?: string[];
}

/** An action the server does not check permissions for, while the page that calls it does. */
export interface PageOnlyCheck {
  /** Abilities the calling pages check before showing their buttons. */
  abilities: string[];
  /** Node ids of those pages. */
  pages: string[];
}

export type ResponseKind = "view" | "redirect" | "json" | "file";

// ---------------------------------------------------------------------------
// Documentation layer facts (v0.3): rules, data, automation, integrations, config
// ---------------------------------------------------------------------------

export interface ValidationRule {
  /** As written: "max:150", "Rule::in(['low', 'normal'])". */
  rule: string;
  /** Plain English when builtlore knows the rule, e.g. "at most 150 characters". */
  text?: string;
}

export interface FieldRules {
  field: string;
  rules: ValidationRule[];
  line?: number;
}

export interface Validation {
  /** inline: $request->validate() / Validator::make(); form-request: rules() of a FormRequest class. */
  via: "inline" | "form-request";
  /** FormRequest class, e.g. App\Http\Requests\StorePurchaseRequestRequest. */
  class?: string;
  fields: FieldRules[];
  source: SourceRef;
}

export interface DataColumn {
  name: string;
  /** Column type as written in the migration: string, decimal, foreignId, enum… */
  type: string;
  /** Length / precision as written: "150", "15, 2". */
  size?: string;
  nullable?: boolean;
  /** Default as written in the migration. */
  default?: string;
  unique?: boolean;
  index?: boolean;
  primary?: boolean;
  comment?: string;
  /** Allowed values (enum columns). */
  values?: string[];
  references?: { table: string; column: string; by: "explicit" | "convention"; onDelete?: string };
  /** Where the column was added (or last changed). */
  source: SourceRef;
}

export interface DataTable {
  name: string;
  /** Eloquent model for this table ($table or Laravel's naming convention). */
  model?: string;
  columns: DataColumn[];
  /** Migrations that created or changed the table, oldest first. */
  migrations: string[];
  /** Table comment from the migration. */
  comment?: string;
  /** The table is created outside the migrations that were read; only the changes are known. */
  partial?: boolean;
  source: SourceRef;
}

export interface TableFact {
  kind: "table";
  table: DataTable;
}

export interface ScheduledTask {
  /** What runs: an artisan command, a queued job, a closure or a shell command. */
  runs: { kind: "command" | "job" | "closure" | "exec"; name: string };
  /** Frequency calls as written: "weekdays()->dailyAt('08:00')". */
  when: string;
  /** Plain English, only when every frequency call is known: "Weekdays at 08:00". */
  whenText?: string;
  /** without overlapping, on one server… */
  options: string[];
  description?: string;
  source: SourceRef;
}

export interface ScheduleFact {
  kind: "schedule";
  task: ScheduledTask;
}

/** A status change made by a command or job, with the records it applies to when the code says. */
export interface BackgroundWrite extends StatusWrite {
  /** where('status', X) on the same query: only records in these states. */
  when?: StatusValue[];
}

export interface ConsoleCommand {
  /** "purchase-requests:remind" */
  name: string;
  signature: string;
  class?: string;
  description?: string;
  writes: BackgroundWrite[];
  source: SourceRef;
}

export interface CommandFact {
  kind: "command";
  command: ConsoleCommand;
}

export interface QueuedJob {
  class: string;
  /** Implements ShouldQueue. */
  queued: boolean;
  writes: BackgroundWrite[];
  /** Where it is dispatched or scheduled. */
  dispatchedFrom: SourceRef[];
  source: SourceRef;
}

export interface JobFact {
  kind: "job";
  job: QueuedJob;
}

export type IntegrationKind = "http" | "mail" | "notification" | "storage";

export interface IntegrationUsage {
  kind: IntegrationKind;
  /** Stable grouping key: "config:services.erp.url", "env:EPORTAL_URL", "host:api.x.com", "mail:WaitingApprovalReminder", "disk:s3". */
  target: string;
  /** Display name: "services.erp", "EPORTAL_URL", "api.x.com", "WaitingApprovalReminder", "s3". */
  name: string;
  /** HTTP verb. */
  method?: string;
  /** Literal path after the base URL. */
  path?: string;
  /** Environment keys behind the target (names only). */
  env?: string[];
  /** Notification channels from via(). */
  channels?: string[];
  /** Storage operation (put, get, delete…). */
  operation?: string;
  /** The class and method that contains the call. */
  in?: { class: string; method?: string };
  source: SourceRef;
}

export interface IntegrationFact {
  kind: "integration";
  usage: IntegrationUsage;
}

export interface ConfigUse {
  source: SourceRef;
  /** Config key that reads it: "services.erp.url". */
  config?: string;
  /** A fallback is written in code (the value itself is never recorded). */
  hasDefault: boolean;
}

export interface ConfigFact {
  kind: "config";
  /** Environment variable name. Values are never read. */
  key: string;
  uses: ConfigUse[];
  /** Listed in .env.example (names only). */
  inExample: boolean;
  /** A key the framework's own config files read (APP_KEY, REDIS_HOST…), not one the app added. */
  framework?: boolean;
}

// ---------------------------------------------------------------------------
// Process layer facts: actors and status
// ---------------------------------------------------------------------------

/** A status value as found in code, e.g. 3, 'APPROVED_MANAGER', PurchaseRequest::STATUS_HOLD. */
export interface StatusValue {
  /** Canonical value (constants and enum cases resolved): "3", "APPROVED_MANAGER", "approved". */
  value: string;
  /** How it is written in code, e.g. "PurchaseRequest::STATUS_HOLD". */
  code: string;
  /** Human label when the code gives one (label arrays, constant/enum names). */
  label?: string;
  labelFrom?: "labels" | "constant" | "enum" | "literal";
}

/** "PurchaseRequest.status"; ".status" when the model is unknown (e.g. a Blade variable). */
export type Subject = string;

export interface StatusWrite {
  subject: Subject;
  to: StatusValue;
  source: SourceRef;
  /** Position in the step's code (call site first when written in a called method), to put writes in sequence. */
  order?: number[];
  /** if/else branches the write is in ("<id>:<branch>"); writes in different branches of one if are alternatives. */
  branch?: string[];
}

export interface StatusCondition {
  subject: Subject;
  /** The record must be in one of these states. */
  values: StatusValue[];
  via: "guard" | "view";
  source: SourceRef;
}

export interface ActorRef {
  /** Display name, e.g. "Manager". */
  name: string;
  via: "middleware" | "code" | "view" | "name";
  /** What it was read from, e.g. "role:procurement", "auth()->user()->nik == $pr->manager_nik". */
  detail: string;
  /** "permission": a named permission (can:Slide Approve); "role": a role or position. */
  kind?: "role" | "permission";
}

export interface ProcessInfo {
  actors: ActorRef[];
  writes: StatusWrite[];
  requires: StatusCondition[];
  /** Models this step creates (Model::create, new Model). */
  creates: string[];
  /** Status writes whose value builtlore could not read (reported, never guessed). */
  unresolved?: Array<{ column: string; code: string; source: SourceRef; why?: string }>;
  /** Stored procedures called (their status changes are not visible in the code). */
  procedures?: string[];
  /** Variables holding a record's current status ($latestStatus = TStatusX::where(…)->latest()->value('status_id')), for the view. */
  statusVars?: Record<string, Subject>;
  /** Methods of the app's own classes this handler reaches ("App\Services\Approval@hold"), with the lines that cannot run there given the values passed in. */
  calls?: Reach[];
  /** Lines of this body in branches that cannot run with the values passed in. */
  deadLines?: number[];
  /** Things found on the way that are reported instead of placed (e.g. a status set in an updated() observer). */
  skipped?: Array<{ reason: string; source: SourceRef }>;
  /** The step requires login, and where that check is ("Helper::canUseAPI(): Session::get('nik_real')", "middleware isLogin"). */
  login?: string;
  /** The step is for other systems: it requires an API key or token ("header X-Api-Key in Controller::authenticate()"). */
  client?: string;
}

export interface Reach {
  method: string;
  dead?: number[];
}

/** Known values of a status column: constants, enum cases, label arrays, defaults. */
export interface StatesFact {
  kind: "states";
  subject: Subject;
  values: StatusValue[];
  /** Default for new records ($attributes on the model). */
  initial?: StatusValue;
  source: SourceRef;
}

export interface HandlerRef {
  kind: "controller" | "closure" | "view" | "redirect" | "unknown";
  /** Fully-qualified class, e.g. App\Http\Controllers\BookingController */
  class?: string;
  method?: string;
  /** Repo-relative file containing the handler code, when resolvable. */
  file?: string;
  line?: number;
}

export interface ViewRef {
  engine: "blade" | "inertia" | "livewire";
  name: string;
  file?: string;
}

/** ajax: referenced from a script or data attribute (fetch, DataTables, $.post) */
export type EdgeTrigger = "link" | "submit" | "redirect" | "back" | "ajax" | "include";

/** Navigation from one entry to another. */
export interface NavigatesFact {
  kind: "navigates";
  from: string; // entry id
  to: string; // entry id, or "back" (resolved later)
  trigger: EdgeTrigger;
  /** "error" when the edge is a failure branch (withErrors, with('error')). */
  outcome?: "success" | "error";
  label?: string;
  source: SourceRef;
  /** Conditions around the link or button in the view (@if status, @role, @can). */
  when?: { actors: ActorRef[]; requires: StatusCondition[] };
}

/** Something the adapter saw but could not resolve. Reported, never guessed. */
export interface SkippedFact {
  kind: "skipped";
  reason: string;
  source: SourceRef;
}

export type Fact =
  | EntryFact
  | NavigatesFact
  | SkippedFact
  | StatesFact
  | TableFact
  | ScheduleFact
  | CommandFact
  | JobFact
  | IntegrationFact
  | ConfigFact;

export interface RepoInfo {
  root: string; // absolute path
}

export interface AdapterResult {
  facts: Fact[];
  /** Human-readable notes about how extraction ran (mode, fallbacks). */
  notes: string[];
}

export interface Adapter {
  id: string;
  name: string;
  detect(repo: RepoInfo): Promise<boolean>;
  extract(repo: RepoInfo, options: ExtractOptions): Promise<AdapterResult>;
}

export interface ExtractOptions {
  /** "auto" tries artisan first, then static parsing. */
  mode: "auto" | "static" | "artisan";
  /** PHP executable for artisan mode (default: "php" on PATH). */
  php?: string;
}

// ---------------------------------------------------------------------------
// The as-built model (builtlore.json)
// ---------------------------------------------------------------------------

export type Provenance = "extracted" | "inferred" | "human";

export interface MapNode {
  id: string; // = entry id
  type: EntryType;
  label: string;
  methods: HttpMethod[];
  uri: string;
  name?: string;
  feature: string;
  middleware: string[];
  handler?: HandlerRef;
  view?: ViewRef;
  source: SourceRef;
  provenance: Provenance;
  /** Written by a person (builtlore.edits.yaml). */
  description?: string;
  /** Hidden by a person; kept in the model, not drawn by default. */
  hidden?: boolean;
  /** Set when the code changed after a person described this step. */
  review?: string;
  /** Who does this step (same rule as the Process view lanes); actions only. */
  who?: ProcessLane;
  /** No permission check on the server, but the page that calls it checks these before showing its buttons. */
  pageOnly?: PageOnlyCheck;
  validation?: Validation[];
  inputs?: string[];
  responds?: ResponseKind[];
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  trigger: EdgeTrigger;
  outcome?: "success" | "error";
  label?: string;
  source: SourceRef;
  provenance: Provenance;
}

export interface Feature {
  id: string;
  name: string;
  nodes: string[];
  files: string[];
  provenance: Provenance;
  description?: string;
}

export interface BuiltMap {
  schema: "builtlore/0.1";
  generatedAt: string;
  generator: string;
  project: {
    name: string;
    commit?: string;
    /** Display name written by a person. */
    title?: string;
    /** What the system is for, written by a person. */
    summary?: string;
  };
  stacks: string[];
  features: Feature[];
  nodes: MapNode[];
  edges: MapEdge[];
  skipped: SkippedFact[];
  notes: string[];
  /** Project terms and their meaning, written by people. */
  glossary?: Record<string, string>;
  /** Business processes: who does each step and how the status changes. */
  processes?: Process[];
  /** Tables and columns from migrations. */
  data?: { tables: DataTable[] };
  /** Scheduler, console commands and queued jobs. */
  automation?: { schedule: ScheduledTask[]; commands: ConsoleCommand[]; jobs: QueuedJob[] };
  /** External systems the app talks to: HTTP APIs, mail, notifications, file storage. */
  integrations?: Integration[];
  /** Environment keys the code reads (names only, never values). */
  config?: ConfigFact[];
}

export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  env?: string[];
  channels?: string[];
  usages: Array<{
    /** Steps (node ids), commands ("command:<name>") or jobs ("job:<class>") that make the call. */
    by: string[];
    in?: { class: string; method?: string };
    method?: string;
    path?: string;
    operation?: string;
    source: SourceRef;
  }>;
}

export interface ProcessState {
  id: string; // "<subject>=<value>"
  value: string;
  code: string;
  label: string;
  /** "code": named by the code (labels, constants, enums); "raw": just the value; "human": edited. */
  named: "code" | "raw" | "human";
}

export interface ProcessLane {
  id: string; // lowercase key
  name: string;
  /** "permission": a named permission check (can:Slide Approve), not a role or position. */
  kind?: "role" | "permission";
  /** Where builtlore found this actor; empty for the fallback lanes. */
  evidence: string[];
  provenance: Provenance;
}

export interface ProcessStep {
  node: string;
  lane: string;
  /** States the record must be in (empty: not found in code). */
  from: string[];
  fromVia?: "guard" | "view" | "page";
  /** State(s) after this step (empty: status unchanged or not found). */
  to: string[];
  /** This step creates the record. */
  creates?: boolean;
  /** When the step writes several statuses in a row (a status history), each sequence it can write, per branch. */
  paths?: string[][];
  /** Per path: the status it starts from and the checks it runs under (if (Gate::allows('x')), if ($latest == X)). */
  pathInfo?: Array<{ from?: string[]; when?: string[] }>;
}

export interface Process {
  id: string;
  /** The feature the process belongs to: where the record is created, else where most steps are. */
  feature: string;
  /** Every feature with a step in this process (owner first), when there is more than one. */
  features?: string[];
  name: string;
  subject: Subject;
  states: ProcessState[];
  initial?: string;
  lanes: ProcessLane[];
  steps: ProcessStep[];
}
