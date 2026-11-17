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
  unresolved?: Array<{ column: string; code: string; source: SourceRef }>;
  /** Stored procedures called (their status changes are not visible in the code). */
  procedures?: string[];
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

export type Fact = EntryFact | NavigatesFact | SkippedFact | StatesFact;

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
  project: { name: string; commit?: string };
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
}

export interface Process {
  id: string;
  feature: string;
  name: string;
  subject: Subject;
  states: ProcessState[];
  initial?: string;
  lanes: ProcessLane[];
  steps: ProcessStep[];
}
