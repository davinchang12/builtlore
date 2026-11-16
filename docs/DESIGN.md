# builtlore — Design Document

> **Name.** `builtlore` = "the lore of what you built": the knowledge, flows and history of an application that usually live only in people's heads, made visible. Chosen 2026-11-16 (see [Open questions](#16-open-questions)).

**Status:** v0.2.0-alpha.0 (Laravel: Process view, Screens view, edits that survive rescans) · **Next:** project documentation (6.8) · **Last updated:** 2026-11-16

---

## 1. Summary

`builtlore` is a language-agnostic CLI that scans any application repository (Laravel, Go, Next.js, Flutter, …) and produces a **living, visual map of the application as it is actually built**: business-process flows from the first screen onward, the data behind them, the automated jobs that run on their own, how each feature grew over time in git, and where testing is missing.

One command produces one canvas that a developer, a product owner, a new hire, or an AI coding agent can all understand.

```
cd any-project
npx builtlore scan     # extract → synthesize → render
npx builtlore view     # open the canvas
```

---

## 2. Problem

AI now writes much of the code. Understanding has not kept up.

- **Code is produced faster than it is understood.** Developers ship features they cannot fully explain a month later, and AI agents debugging that code have no context beyond what they can grep.
- **Documentation is thin or missing.** Nobody has time to write it, and what exists goes stale within a week.
- **Requirements arrive through chat and conversation.** In fast sprints there is often no SRS, no backlog history, and no record of what was asked versus what was delivered.
- **Flows live in people's heads.** Even the author forgets how a flow branches, which tables it touches, or which scheduled job silently changes data at midnight.
- **Verification is eroding.** When code "just works" because an AI wrote it, end-to-end testing is skipped, and nobody checks whether a flow still works, still looks right, or got slower.
- **Teams run many apps in many stacks.** A tool tied to one language or framework does not help an organization with Laravel, Go, Next.js, and Flutter apps side by side.

Text-heavy documentation does not fix this: people do not read it. They need to **see** the system.

---

## 3. Goals and non-goals

### Goals

1. **One command, any stack.** Runs against a repository without being installed into it as a language-specific library.
2. **Business-process first.** Show flows the way a user or a business person would describe them, not just modules and call graphs.
3. **Visual first, detail on demand.** A canvas for the big picture; every node opens into full documentation.
4. **Grounded in facts.** Deterministic extraction is the backbone. AI only names, groups, and explains, and every inferred element is labeled as such.
5. **Living.** Re-running is cheap (incremental), and it fits in CI so the map never goes stale.
6. **Human corrections survive.** Anything a person fixes or annotates is never overwritten by a re-scan.
7. **Shows growth over time.** A timeline from git that shows features appearing and changing.
8. **Readable by AI agents.** The same map is exported as compact context for coding agents.

### Non-goals

- **Not a spec-first tool.** It documents what *is* built. (A later layer compares that with what was *requested*.)
- **Not a test runner.** It integrates with existing runners (e.g., Playwright) rather than replacing them.
- **Not a BI or monitoring tool.** It reads structure and history, not production metrics.
- **Not a diagram editor.** The canvas allows annotation and correction, but the map is generated from code.

---

## 4. Users and use cases

| User | Question they want answered |
|---|---|
| Developer (author) | "How does this flow actually work again, and what else breaks if I change it?" |
| New developer | "What does this app do, end to end, and where is the code for each step?" |
| Tech lead | "Which features are growing, which are stale, which have no tests?" |
| Product owner / business | "What is the real business process in this system today?" |
| AI coding agent | "Give me the relevant flow, files, tables, and jobs before I debug." |

---

## 5. Core concept

### 5.1 One source, three outputs

```
builtlore scan ──▶ builtlore.json  (the as-built model)
                     ├──▶ Canvas      for seeing    (big picture, interactive)
                     ├──▶ Docs        for reading   (one page per feature)
                     └──▶ AI context  for agents    (compact, linkable)
```

### 5.2 Layers

All information lives on one canvas, organized into layers that can be toggled, like layers on a map.

| Layer | Contents | Primary sources |
|---|---|---|
| **Process** | Business processes as swimlanes: who does each step, how the status changes | Actions + role checks + status writes and guards (see 6.7) |
| **Flows** (screens) | Entry points, screens/pages, steps, branches | Routes, pages, navigation, handlers |
| **Data** | Tables, relationships, stored procedures, which step reads/writes what | Migrations, ORM models, schema files, live DB (read-only) |
| **Automation** | Scheduled jobs, cron, queues, workers, webhooks | Scheduler definitions, cron configs, job classes |
| **History** | When each feature appeared, how it changed, who worked on it | Git history |
| **Tests** | Which flows are covered, results, screenshots | Test files, coverage reports, runner output |
| **Requirements** | What was requested vs. what is built | Human-captured notes, issues (later) |

v0.1 ships **Flows** only. Every other layer is a separate release. Dogfooding showed that Flows answers "how do users move through the screens", while people mostly ask "what is the business process"; so **Process** is the next layer and will become the default view, with Flows as the detailed technical tab.

---

## 6. Architecture

```
               ┌──────────────────────────────────────────────┐
 repository ──▶│ 1. DETECT      which stacks are present?      │
               │ 2. EXTRACT     adapters → raw facts           │  deterministic
               │ 3. HISTORY     git log → facts over time      │  deterministic
               │ 4. SYNTHESIZE  facts → features & flows       │  LLM (optional)
               │ 5. MERGE       apply human edits              │  deterministic
               │ 6. RENDER      canvas · docs · AI context     │  deterministic
               └──────────────────────────────────────────────┘
                                   │
                                   ▼
                  builtlore.json + .builtlore/ (cache, snapshots)
```

### 6.1 Detect

Look for marker files: `artisan` + `composer.json` (Laravel), `next.config.*` + `app/` or `pages/` (Next.js), `go.mod` (Go), `pubspec.yaml` with `flutter` (Flutter). A repository may contain several stacks (monorepo); each detected stack runs its adapter.

### 6.2 Extract (adapters)

Each stack has an **adapter** that turns source code into **facts**. Adapters are deterministic: same code in, same facts out. Parsing uses tree-sitter grammars where a regex is not enough.

```ts
interface Adapter {
  id: string;                                   // "laravel", "go-chi", ...
  detect(repo: RepoInfo): Promise<boolean>;
  extract(repo: RepoInfo): Promise<Fact[]>;
}

type Fact =
  | { kind: "entry";     id: string; type: "page" | "screen" | "api" | "command"; path: string; file: string; line: number }
  | { kind: "navigates"; from: string; to: string; trigger?: string; file: string; line: number }
  | { kind: "handles";   entry: string; symbol: string; file: string }
  | { kind: "dataAccess"; symbol: string; table: string; op: "read" | "write"; file: string }
  | { kind: "table";     name: string; columns: Column[]; source: "migration" | "schema" | "db" }
  | { kind: "relation";  from: string; to: string; via: string; confidence: "declared" | "inferred" }
  | { kind: "procedure"; name: string; body?: string; source: "db" | "migration" }
  | { kind: "schedule";  id: string; cron: string; target: string; file: string }
  | { kind: "test";      file: string; covers?: string[] }
  | { kind: "config";    key: string; file: string };   // names only, never values
```

Adapter order: **Laravel → Go → Next.js → Flutter.** Where each stack's entry points live:

| Stack | Entry points | Navigation / links | Scheduler |
|---|---|---|---|
| Laravel | `routes/web.php`, `routes/api.php` (incl. groups, prefixes, names, resource routes) | `redirect()->route()`, `to_route()`, Blade `route()` in links and form actions | `routes/console.php`, Console Kernel `schedule()` |
| Go | `net/http`, gin, echo, chi route registrations | (API only) | cron libraries |
| Next.js | `app/**/page.tsx`, `app/**/route.ts`, `pages/**` | `<Link href>`, `router.push`, `redirect()` | `vercel.json` crons |
| Flutter | GoRouter / Navigator route definitions | `context.go/push`, `Navigator.push` | (n/a) |

Adapters are the main contribution surface for the community: one adapter per framework, each small and testable against fixture repos.

#### Laravel adapter strategy (v0.1)

Two extraction modes, best available wins:

1. **Artisan mode (most accurate).** If PHP and the project's dependencies are installed, run `php artisan route:list --json`. Laravel resolves groups, prefixes, middleware, resource routes and route names itself, so the route table is exact.
2. **Static mode (always works).** Parse `routes/*.php` with php-parser: `Route::get/post/put/patch/delete/match/any`, `Route::resource/apiResource`, `Route::group/prefix/name/middleware/controller` chains, and both `[Controller::class, 'method']` and `'Controller@method'` handler styles. Unresolvable dynamic routes are reported as skipped, not guessed.

Then, for every route:

- **Handler → view:** follow the controller method to `return view('booking.index')` / `View::make()` and link the route to `resources/views/booking/index.blade.php`.
- **View → next step:** scan the Blade view for `route('name')` / `url()` / `action()` in `<a href>` and `<form action>` to create navigation edges (form `method` becomes the edge trigger, e.g. "submit").
- **Handler → next step:** `redirect()->route()`, `to_route()`, `redirect()->back()` (marked as "back"), plus `->with('error', …)` / `withErrors()` to label failure branches.

- **Scripts and attributes → AJAX / links (alpha.1):** `route()` / `url()` outside `<a href>` and `<form action>` (in `<script>`, `data-*`, `onclick`) become `ajax` edges when they target an action or data endpoint, `link` edges when they target a page. Blade comments are blanked first.
- **Response kind → node type (alpha.1):** JSON responses (`response()->json`, DataTables, `toJson()`) make a *data* node, file responses (`Excel::download`, `response()->download()`, PDF) a *download* node, unless the handler also renders a view or redirects. JSON returned by a write verb (store, update, approve, …) stays an *action*.
- **Duplicates (alpha.1):** routes with the same method and URI are reported (Laravel keeps the last one, and so does builtlore), as are route names shared by several routes.

Inertia (`Inertia::render('Booking/Index')`) and Livewire components are common Laravel front ends; they are detected and listed in v0.1, with full edge extraction planned for a later release.

#### Feature grouping

1. Base group: auth routes → `auth`; known area prefixes (`admin.`, `api.`, `master.`…) → first two name segments; otherwise first name segment, or first URI segment.
2. Groups with ≥ 12 entries whose entries belong to ≥ 2 controller *domains* (and ≥ 2 entries per domain on average) are areas, not features, and are split by domain. A domain is the controller name minus noise words (`Status`, `Report`, `Laporan`, `Export`, `Detail`, …), so `StatusMTDIController` joins `MTDIController`; generic controllers (`LaporanController`) fall back to the method name (`indexMTDI` → `MTDI`), then to the route name or URI.

### 6.3 History

From `git log --name-only`:

1. Map every commit to the features whose files it touched (file → feature ownership comes from extraction).
2. For each feature record: first commit (birth), last commit, churn over time, top contributors.
3. Optionally snapshot the full map at each tag or release into `.builtlore/snapshots/`, so two versions can be diffed (added / changed / removed).

### 6.4 Synthesize (LLM, optional)

The LLM receives **facts, not the whole repository**, plus small code excerpts on demand. It:

- groups entries into **features** with human-readable names,
- orders steps into **flows** with branches (e.g., "payment failed → back to checkout"),
- writes short summaries for docs.

Rules:
- Every LLM-produced element carries `provenance: "inferred"` and a confidence.
- Prompt inputs are cached by content hash; only changed facts are re-sent (incremental).
- Providers are pluggable: Anthropic, OpenAI, or any OpenAI-compatible local endpoint (e.g., Ollama).
- `--no-ai` skips this step entirely; the canvas then shows raw entries and navigation edges, which is still useful.

### 6.5 Merge (human edits) — implemented in alpha.3

Principle: **scans always start from the code; people's edits are applied on top.** Nothing a person writes is overwritten by a rescan, and nothing generated is passed off as human.

Edits live in `builtlore.edits.yaml` at the project root (committed with the code, reviewed in PRs like any other file). They are written by `builtlore serve` (the canvas with editing on) or by hand; the canvas writes through the YAML document API, so comments and ordering survive.

```yaml
features:
  booking:                         # feature id
    name: Booking a visit
    description: Patients pick a vaccine and a slot, then pay. Unpaid bookings expire after 24 hours.
steps:
  route:booking.index:             # stable step id: route name, or METHOD + URI
    label: My bookings
    description: Patient sees upcoming visits and can cancel one.
    feature: Booking a visit       # move: existing feature id/name, or a new name
    hidden: true                   # kept in the model, not drawn by default
    code: b6bb4d23ab               # fingerprint of the code when described
glossary:
  MTDI: Month-to-date input
```

- **Order of application:** feature edits first (so steps can be moved into a renamed feature by its new name), then step edits; features emptied by moves disappear.
- **Needs review:** saving a described step records a fingerprint of type, methods, URI, handler and view. If a later scan differs, the step is flagged (amber dot, note) instead of silently showing an outdated description. Saving again acknowledges it.
- **Orphans:** edits whose id no longer exists are kept and listed in the scan notes; never deleted automatically.
- **Untouched generated names stay generated**, so they keep improving as the extractor improves; only names a person actually changed are pinned (`provenance: human`).
- `builtlore serve` binds to 127.0.0.1 and requires a per-session token in a custom header for writes (blocks cross-site requests from other tabs).
- The same file will hold later human inputs: status names for the Process view (`statuses:`), actor names (`roles:`), and documentation prose (6.8).

### 6.6 Render

- **Canvas:** one self-contained HTML file (no server needed). Each feature is laid out separately with ELK (layered, orthogonal edges) and the feature boxes are packed into rows. Layout follows a **journey order**: entry points are pages with no incoming forward edge and no `{parameter}` in the URL; steps are ranked breadth-first along links, submits, AJAX calls and redirects; steps reachable only through invisible JavaScript are placed after the steps they lead to. Edges that go against that order are laid out reversed (and drawn the right way round), so back/retry/"return to list" edges never reorder steps. Edges between features are faint curves, highlighted on selection. Search, feature filters, a data/file toggle, details panel, SVG export. Planned: hand-drawn style and export to `.excalidraw` for free-form editing.
- **Docs:** Markdown, one page per feature, plus an index; can be served as a static site.
- **AI context:** a compact `builtlore.md` (and later an MCP server) that agents can read: feature → flow → files → tables → jobs.

### 6.7 Process view — implemented in 0.2.0-alpha.0

Goal: one swimlane diagram per business process (e.g. "Purchase request"), readable by non-developers, generated from code.

**Steps** come from actions (store, update, approve, hold, delegate…), already extracted.

**Actors (lanes)**, found by builtlore, most specific first:
1. Route middleware: `role:manager`, `can:approve`, custom middleware such as `isAtasan`.
2. Authorization in the handler: `$this->authorize()`, `Gate::allows()`, policies.
3. Conditions on the current user: `if ($user->jabatan == ...)`, `if (auth()->user()->nik == $request->nik_atasan)`.
4. Names: `atasan-approve`, `approveManager`, `changePIC`.
5. Otherwise the lane is "actor unknown". Never guessed.

**Status transitions** — teams mix styles, so all are read:
- Writes: `$model->status = X`, `->update(['status' => X])`, `Model::where(...)->update([...])`, on any status-like column (`status`, `state`, `approval_status`, `stage`, `step`, `is_approved`, …).
- Values: string literals; class constants (`PurchaseRequest::STATUS_HOLD`, resolved by reading the class); enums (`LeaveStatus::Approved`); numbers (`status = 3`), named from label arrays on the model, `getStatusLabelAttribute`, `match`/`switch` maps, or Blade badges (`@if($row->status == 3) Approved`).
- Guards: `if ($x->status !== 'APPROVED_MANAGER') return back()->with('error', ...)` gives the "from" state of a transition.
- Unnamed values stay raw (`status = 3`) until a human names them once in `builtlore.edits.yaml`:

```yaml
statuses:
  purchase-request:
    1: Waiting for manager
    3: Approved by procurement
```

**Rendering:** lanes = actors, boxes = steps (business label), arrows = transitions labelled with the resulting status, red dashed = rejection/hold/back. AI naming stays optional and labelled as inferred.

**As implemented (alpha.0):**
- Facts: `EntryFact.process` (actors, writes, guard requirements, models created), `NavigatesFact.when` (actors and status conditions around the link/button in Blade), `StatesFact` (known values per `Model.column`: constants `STATUS_*`, enum cases via `$casts`, label arrays / `match` maps, `$attributes` default).
- Subjects are `Model.column`; Blade variables map to models by name (`$purchaseRequest` → `PurchaseRequest`), otherwise `.column` joins the feature's only subject on that column.
- A step's "from" states, in order of strength: guard in the handler → condition around the button that leads to it → condition around the link to the page the form is on.
- Lane choice by source: code → view → middleware → route name; several names from the same source are joined ("Admin / Manager"). Fallback lanes: *Signed-in user* (auth middleware) or *Anyone*.
- Name-based roles only match a role vocabulary (common words + every role found explicitly elsewhere in the app).
- Columns: creation steps first; each step is placed after the step that produces the status it needs (BFS, loops drawn under the cards).
- Human edits: `roles:` (lane id → name), `statuses:` (`Model.column` → value → label), `actor:` per step.

### 6.8 Project documentation (after the Process view)

Goal: documentation an enterprise team would hand over or audit, generated from code and kept current by rescans, with the "why" written by people once and kept.

| Section | Content | Source |
|---|---|---|
| System overview | What the app is for, who uses it, modules | Code + optional AI draft (marked *inferred* until a person confirms) + edits |
| Roles and permissions | Matrix of roles × actions | Middleware, gates, policies, user conditions (Process layer) |
| Business processes | Swimlane per process, status lifecycle, purpose | Process layer + edits |
| Screens and flows | Pages, what leads where | Flows layer (exists) |
| Business rules | Required fields, formats, limits, per form | `validate()` rules, Form Requests, guard conditions |
| Data dictionary | Tables, columns, relationships | Migrations, models (Data layer) |
| Integrations | External APIs, SSO, mail, notifications, storage | `Http::`, `Mail::`, `Notification`, `Storage`, SDK calls |
| Automation | Scheduler, jobs, queues | Console kernel / `routes/console.php`, job classes |
| API reference | Endpoints, parameters, responses | Routes + validation + returns |
| Configuration | Required `.env` keys (names only, never values) | `config/*.php`, `env()` calls |
| Glossary | Project terms | Edits (`glossary:`) |
| Findings | Duplicate routes, unreachable pages, unvalidated writes | Scan notes |
| Change history | When modules appeared and changed, by whom | Git (History layer) |

Each fact carries provenance (*from code* / *inferred* / *written by a person*) so readers know what to trust. Outputs: a Markdown folder (versioned with the repo), a static HTML docs site, and Word/PDF export for formal handover. Prose fields are edited the same way as names (canvas or YAML) and survive rescans.

---

## 7. Data model (`builtlore.json`)

```json
{
  "schema": "builtlore/0.1",
  "generatedAt": "2026-11-16T07:00:00Z",
  "commit": "a1b2c3d",
  "stacks": ["laravel"],
  "features": [
    {
      "id": "booking",
      "name": "Booking",
      "summary": "Users pick a vaccine, a branch and a time slot, then pay.",
      "provenance": "inferred",
      "confidence": 0.82,
      "entries": ["route:booking.index", "route:booking.pay", "route:booking.store"],
      "files": [
        "app/Http/Controllers/BookingController.php",
        "resources/views/booking/index.blade.php",
        "resources/views/booking/pay.blade.php"
      ],
      "history": { "born": "2026-03-02", "lastChanged": "2026-11-10", "commits": 47 }
    }
  ],
  "flows": [
    {
      "id": "checkout",
      "name": "Book and pay for a vaccine",
      "feature": "booking",
      "steps": [
        { "id": "s1", "entry": "route:booking.index", "label": "Choose vaccine and slot" },
        { "id": "s2", "entry": "route:booking.pay",   "label": "Pay" },
        { "id": "s3", "entry": "route:ticket.show",   "label": "Receive e-ticket" }
      ],
      "edges": [
        { "from": "s1", "to": "s2" },
        { "from": "s2", "to": "s3", "label": "paid" },
        { "from": "s2", "to": "s1", "label": "payment failed" }
      ],
      "provenance": "inferred"
    }
  ],
  "entities": { "tables": [], "procedures": [], "schedules": [] },
  "tests": []
}
```

Provenance values: `extracted` (from code, deterministic) · `inferred` (from LLM) · `human` (from `builtlore.edits.yaml`).

---

## 8. CLI

| Command | What it does |
|---|---|
| `builtlore init` | Detect stacks, write a default `builtlore.config.yaml`, add `.builtlore/` to `.gitignore` |
| `builtlore scan [paths...]` | Run the full pipeline and write `builtlore.json`; several project paths can be given, each gets its own map |
| `builtlore view` | Open the canvas in the browser |
| `builtlore serve` | Scan and serve the canvas on 127.0.0.1 with editing on; saves to `builtlore.edits.yaml` |
| `builtlore docs` | Generate Markdown docs into `docs/builtlore/` |
| `builtlore diff <refA> <refB>` | Show features/flows added, changed, removed between two git refs |
| `builtlore check` | CI mode: exit non-zero if the committed map is out of date |

Implemented in v0.1: `init`, `scan`, `view`, `serve`, flags `--mode auto|static|artisan`, `--out`, `--open`, `--php <path>`, `--port`.
Planned flags: `--no-ai` (becomes meaningful once the AI pass exists; v0.1 is fully deterministic), `--since <ref>` (incremental), `--provider`, `--model`, `--workspace <file>` (named sets of projects).

---

## 9. Distribution and tech stack

**Decision for v0.1: TypeScript, distributed via npm and as standalone binaries.**

| Concern | Choice | Why |
|---|---|---|
| CLI language | TypeScript (Node ≥ 22 / Bun) | Same language as the viewer; fastest path to a working prototype |
| Distribution | `npx builtlore`, plus single-file binaries via `bun build --compile` | Works on machines without Node for Go/PHP/Flutter teams |
| Parsing | PHP: `php-parser` (pure JS, PHP 8 syntax). Other stacks: `web-tree-sitter` (WASM grammars) when their adapters land | No native build step; each adapter picks the most reliable parser for its language |
| Git | `git` CLI via child process | Simple, fast, always available where git is |
| Canvas | elkjs (layered layout) + a small dependency-free SVG viewer, inlined into one HTML file | Interactive, auto-layout, offline; no frontend build step. React Flow remains an option if the editor grows |
| LLM | Provider interface; Anthropic / OpenAI / OpenAI-compatible | Bring your own key; local models supported |
| License | MIT (proposed) | Maximizes adoption |

Alternative considered: a Go CLI (single binary by default). Rejected for v0.1 because the viewer must be built in JS anyway, and two languages slow down a solo maintainer. Can be revisited.

---

## 10. Privacy and security

- `--no-ai` mode: no code leaves the machine.
- With AI: only extracted facts and short excerpts are sent, never the whole repository; prompts are logged locally on request (`--debug-prompts`) so users can see exactly what was sent.
- Local models are first-class (OpenAI-compatible endpoint).
- Database access (Data layer) uses read-only credentials from environment variables; credentials are never written to the map.
- Config extraction records **key names only**, never values; `.env` files are never read for values.

---

## 11. Landscape and differentiation

| Tool | What it does | Gap relative to builtlore |
|---|---|---|
| DeepWiki, deepwiki-open, CodeWiki, RepoWiki | AI-generated wiki and architecture diagrams from a repo | Code-centric prose for developers; no business-flow canvas, no timeline, no DB/jobs layer |
| GitHub Spec Kit | Spec-driven development: spec → plan → tasks → code | Spec-first; assumes requirements are written before code |
| Faultlines | Feature and flow map from git history + code structure, multi-stack; outputs JSON for CLI, CI, dashboard, MCP | Engineer-focused (hotspots, ownership, risk), not a business-process canvas for non-developers |
| Blueprint (macOS app) | Agent-maintained architecture map; flows played over the diagram; version timeline (added/changed/removed) | macOS only; centered on architecture components; no data/automation layers or requirement comparison |
| GitDiagram | Architecture diagram from repo tree | No flows, no history |
| Gource | Animated history of files and folders | Shows files growing, not features or processes |
| Playwright agents, Bug0, other AI E2E tools | Natural-language end-to-end testing | Testing only; builtlore will integrate rather than compete |

**builtlore's position:** an open-source, self-hostable tool that combines a **business-process canvas**, **data and automation layers**, a **git growth timeline**, and **human corrections that survive**, readable by non-developers and AI agents alike.

---

## 12. Roadmap

| Version | Scope |
|---|---|
| **v0.1** | Flows layer for **one** stack · `scan`, `view` · single-HTML canvas · `--no-ai` mode |
| v0.1 (alpha.3) | Human edits + stable IDs + `serve` (done, 6.5) |
| v0.2 | **Process layer:** swimlanes from actors + status transitions (6.7); default view — alpha.0 done |
| v0.3 | **Project documentation** (6.8): `builtlore docs` → Markdown, HTML site, Word/PDF |
| v0.3.x | History layer: feature birth, churn, contributors · timeline slider · `diff` · `check` for CI · GitHub Action |
| v0.4 | Data layer: migrations/ORM → ERD · live read-only DB (FKs, stored procedures) · step ↔ table links |
| v0.5 | Automation layer: schedulers, cron, queues, webhooks as time/event-triggered flows |
| v0.6 | More adapters (Go, then Next.js, then Flutter) · adapter SDK and contributor guide |
| v0.7 | Tests layer: coverage per flow · Playwright skeleton generation · results and screenshots on the canvas |
| v0.8 | Requirements layer: capture requests from notes/chat · requested vs. built comparison |
| later | MCP server for agents · VS Code extension · multi-repo "organization map" |

---

## 13. v0.1 plan

**First stack: Laravel** (decided). It is the dominant stack in the author's own environment, so v0.1 can be dogfooded on real apps from day one. Laravel's explicit route files, named routes and conventional folders (controllers, Blade views, migrations, scheduler) also make deterministic extraction reliable. Order after that: Go → Next.js → Flutter.

### Milestones

Status (2026-11-16): milestones 1–3 done (CLI, Laravel adapter with static and artisan modes, canvas). Milestone 5 started: first run on a real 145-route internal app led to alpha.1 (area/domain grouping, data and file endpoints, AJAX edges, duplicate warnings, `--php`; 24 tests). Next: Process view (6.7), then 4 (AI synthesis) as an opt-in.

1. **Skeleton** — repo, TypeScript CLI with `init` / `scan` / `view`, a small fixture Laravel app (booking flow with success and failure branches) for tests, CI.
2. **Extraction** — Laravel adapter (see [Laravel adapter strategy](#laravel-adapter-strategy-v01)): artisan mode + static mode for routes, handler → view, Blade links/forms → edges, redirects → edges with failure labels. Snapshot tests against fixtures.
3. **Canvas** — SVG viewer with ELK layout bundled into one HTML file; search, feature filters, click a node to see file and line.
4. **Synthesis** — provider interface; feature grouping and flow naming; provenance + confidence; content-hash cache.
5. **Dogfood** — run on two real apps; fix the top 10 issues; write the README with a GIF.
6. **Release** — publish to npm, tag v0.1.0, write a short launch post.

### Definition of done for v0.1

- `npx builtlore scan && npx builtlore view` works on a real Laravel app with no config, with or without PHP installed.
- A person who has never seen the app can describe its main flows after 5 minutes on the canvas.
- `--no-ai` produces a useful (if unnamed) map fully offline.
- Scan of a mid-size app (≈300 files) finishes in under 60 seconds.

---

## 14. Repository layout

v0.1 is a single npm package; it can be split into workspaces once there are several adapters.

```
builtlore/
├── src/
│   ├── cli.ts            # init / scan / view
│   ├── core/             # fact types, model builder, scan pipeline
│   ├── adapters/
│   │   └── laravel/      # routes (static + artisan), controllers, Blade
│   └── render/           # single-file HTML canvas (Process + Screens views)
├── assets/               # viewer.js + viewer.css (inlined into the canvas)
├── fixtures/
│   ├── laravel-clinic/   # sample app with success and failure branches
│   └── laravel-workflow/ # approval workflow: area prefixes, status controllers, AJAX, exports
├── test/                 # node:test suites
├── docs/DESIGN.md
└── README.md
```

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| LLM invents flows that do not exist | Deterministic facts are the backbone; inferred items are labeled; `--no-ai` always works |
| Scope creep (six layers) | Ship one layer per release; v0.1 is Flows for one stack only |
| Framework diversity (custom routers, monorepos) | Adapter interface + fixtures; accept partial maps and say what was skipped |
| Large repos are slow or costly | Incremental scans by git diff; cache by content hash; send facts, not code |
| Maps go stale | `check` in CI; GitHub Action regenerates on merge |

---

## 16. Open questions

1. ~~Name.~~ Decided: `builtlore` (2026-11-16). The working name `builtmap` was dropped because it is one letter away from "buildmap", already used by several tools, which hurts search and word of mouth. Checked at decision time: free on npm, no GitHub repositories, no product found under the exact name. Rejected alternatives: `asbuilt` (AsBuiltReport), `pathlore` (registered trademark in the software class), anything close to `wayfinder` (an official Laravel package).
2. ~~First stack.~~ Decided: Laravel, then Go → Next.js → Flutter.
3. **Canvas style.** Clean diagram by default with hand-drawn as an option, or the reverse?
4. **Default LLM provider** and whether to ship a recommended local model.
5. **License.** MIT (proposed) vs. Apache-2.0.
