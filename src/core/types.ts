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
}

/** Something the adapter saw but could not resolve. Reported, never guessed. */
export interface SkippedFact {
  kind: "skipped";
  reason: string;
  source: SourceRef;
}

export type Fact = EntryFact | NavigatesFact | SkippedFact;

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
}
