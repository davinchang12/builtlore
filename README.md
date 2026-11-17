# builtlore

*The lore of what you built.*

**See how your app is actually built.** builtlore reads your code and draws its business processes on one interactive canvas: who does each step, how the status of a record changes, and every page, form and redirect behind it, with links back to the exact file and line.

![Process view: who does each step and how the status changes](docs/images/process.png)

> **Status: early alpha (v0.3).** Laravel is supported today. Go, Next.js and Flutter are next. See the [design document](docs/DESIGN.md) for the full plan.

## Why

AI writes code faster than teams can understand it. Requirements arrive through chat, documentation is thin, and the real business process lives in people's heads. Text docs don't fix that, because nobody reads them.

builtlore generates a map of the system **as it is built**, straight from the code, so developers, product people and AI agents can all see the same picture. It stays accurate because it is regenerated, not hand-maintained.

## What you get

- **Business processes, found in the code.** Swimlanes per role, with the status each step needs and the status it leaves behind. Roles come from middleware, policies, role checks and Blade conditions; statuses from strings, numbers, constants and enums, named from your model's label arrays.
- **Screens and flows.** Pages, form submissions, redirects and AJAX calls become steps and arrows, grouped into features.
- **Failure branches.** Validation errors, `withErrors()`, `with('error')` and `back()` show up as red dashed arrows, so you can see what happens when things go wrong.
- **Click through to code.** Every step shows its route, handler, view, middleware and the file and line that defines it.
- **One offline HTML file.** No server, no account, no network. Open it, share it, or attach it to a ticket.
- **A JSON model you can commit.** `builtlore.json` is a stable, diff-friendly description of your app's flows.
- **No guessing.** Anything builtlore can't resolve is listed under *Skipped*, never invented. A step with no role check sits in *Signed-in user*, not in an invented role.
- **Your corrections stick.** Rename roles and statuses, describe steps, regroup features in `builtlore.edits.yaml` (by hand, or in the canvas with `builtlore serve`); edits survive every rescan.
- **Documentation you can hand over.** `builtlore docs` writes a Markdown folder and one printable HTML file: roles × actions, each process with its status lifecycle, form rules, data dictionary, integrations, scheduled jobs, API, configuration, glossary and findings. Regenerate it any time; the parts people write are kept.
- **What changed, in words.** `builtlore diff main` tells a reviewer that "Approve" is now limited to Director, that "Ship" can now end at *Shipped*, or that a mail is no longer sent, instead of a list of changed files.

![Screens view](docs/images/canvas.png)

## Quick start

builtlore is not on npm yet. Run it from source (Node.js 22 or newer):

```bash
git clone https://github.com/<your-account>/builtlore.git
cd builtlore
npm install
npm run build
npm link            # makes the `builtlore` command available everywhere
```

Then, in any Laravel project:

```bash
cd path/to/your-laravel-app
builtlore scan --open
```

Once published, this becomes `npx builtlore scan --open`.

## Usage

```bash
builtlore scan                              # scan the current folder
builtlore scan ~/work/project-1 ~/work/project-2   # scan several projects, each gets its own map
builtlore view ~/work/project-1             # re-open the canvas for a scanned project
builtlore serve                             # open the canvas with editing on (see below)
builtlore docs                              # write the project documentation (see below)
builtlore diff main                         # what changed in behaviour since main (see below)
builtlore init                              # write builtlore.config.yaml and ignore .builtlore/
```

| Option | Meaning |
|---|---|
| `--mode auto` | Default. Use artisan if available, otherwise static parsing. |
| `--mode artisan` | Ask Laravel for the exact route table (`php artisan route:list`). Needs PHP and `vendor/`. |
| `--mode static` | Parse route files directly. Works without PHP. |
| `--out <file>` | Where to write the JSON model (default `builtlore.json`). |
| `--open` | Open the canvas after scanning. |
| `--php <path>` | PHP executable for artisan mode, e.g. Laragon or XAMPP `php.exe` (or set `BUILTLORE_PHP`). |

Each scan writes two files into the project:

- `builtlore.json`: the as-built model. Commit it to track how your app's flows change over time.
- `.builtlore/map.html`: the canvas. Generated, so `builtlore init` adds `.builtlore/` to `.gitignore`.

### The Process view

The canvas opens on **Process** when builtlore finds steps that change a record's status. One box per process (e.g. *Purchase request · status*):

| On the canvas | Means |
|---|---|
| Lane (row) | Who does the step. Found in route middleware (`role:procurement`, `can:admin`, custom ones like `isAtasan`), checks in the handler (`hasRole()`, `$user->jabatan == 'Atasan'`, `auth()->user()->nik == $pr->manager_nik` → *Manager*), policies and gates (`$this->authorize('approve', $order)` and `can:approve,order` read through `OrderPolicy::approve()` and `before()`; `Gate::define('x', …)` bodies), Blade conditions around the button (`@role`, `@can`, `@if`), and role words in route names (`approve-manager`). |
| *Signed-in user* (grey) | No role check found; the step only requires login: `auth` middleware, a custom login middleware (`isLogin`), or a check in code such as `if (!Session::get('nik')) abort(…)`, also inside a helper it calls. builtlore does not guess. |
| *API client* | Called by other systems with a key: the code reads `$request->header('X-…-Key')` or `bearerToken()` and answers 401/403 without it. |
| *Anyone* | No login, key or permission check found. Listed under *Open to anyone* in the docs' findings. |
| Step card | An action. The second line is the status it leaves the record in. |
| Arrow with a status | The record moves on in that status; the next step only runs in that status. That rule comes from a guard in code (`if ($pr->status != X) return back()`), an `@if` around the button, or the page the form is on. |
| Red dashed | Hold, reject, return, cancel. |
| Green pill | A status nothing follows. |
| Dashed column *At any status* | Steps the code lets run whatever the status is (no check found). One arrow per status leaves the bottom of the column, back to the steps that use it. |

Statuses are read however your team writes them: `'APPROVED'`, `3`, `PurchaseRequest::STATUS_HOLD`, `LeaveStatus::Approved`, `$attributes` defaults, and label arrays or `match` maps on the model (`3 => 'Approved by procurement'`). Values built from input are read when the code limits them: `'closed_' . $request->reason` with `in:fixed,duplicate` in the validation (or `Rule::in`, or an `in_array` guard) gives *closed_fixed* and *closed_duplicate*; input nothing limits is listed under *Skipped*. A number with no label shows as `status = 3` until someone names it (see *To write* in the docs).

One process per record status, across features: a request created under one menu and approved under another is one flow, named after the record and owned by the feature that creates it. `Model::where('status', 'pending')->update([...])` starts from *pending*.

When a page checks permissions only to show or hide its buttons (`$canInsert = Gate::allows('X Insert')` passed to the view) and the endpoints it calls do not check anything, those endpoints say so instead of being given a role, and the docs list them under *Permission checked only in the page*.

A step's status changes include what runs because of it: services it calls, listeners of the events it fires (`event(new OrderShipped($order))`, `OrderShipped::dispatch()`, registered in `$listen`, `Event::listen()`, subscribers, or discovered in `app/Listeners`), and model observers (`creating`/`created` set the first status; a status set in `updated()` runs after every save, so it is reported instead of placed). Mail and API calls made there are linked to the step too. `Model::where(...)->update()` fires no model events, so observers are not linked to it.

Click a lane, a status or a step to see where in the code builtlore found it.

### Reading the Screens view

| On the canvas | Means |
|---|---|
| Blue bar | Page: a GET route that renders a screen |
| Orange bar | Action: a form submission (POST, PUT, PATCH, DELETE) |
| Purple bar | API endpoint |
| Grey arrow | Link (`<a href>`) |
| Blue arrow | Form submit (`<form action>`, including `@method()` spoofing) |
| Dark arrow | Redirect from the handler |
| Teal bar | Data endpoint: returns JSON (AJAX, DataTables, dropdown data). Hidden by default |
| Slate bar | File: export or download (Excel, PDF, `response()->download()`). Hidden by default |
| Red dashed arrow | Failure branch: validation failed, `withErrors()`, `with('error')` |
| Teal dotted arrow | AJAX call from a page (`$.post`, `fetch`, DataTables `ajax:`) |

Shortcuts: `/` search, `f` fit to screen, `Esc` clear selection. Scroll to zoom, drag to pan. Use **only** next to a feature to focus on it. Tick **Show data & file endpoints** to see the AJAX and export endpoints behind each page.

Large apps: route name prefixes that act as menus or areas (`menu.*`, `master.*`, `admin.*`) are split into one feature per controller domain, so `MTDIController` and `StatusMTDIController` end up in the same feature.

### Editing: names, descriptions, grouping

Code tells builtlore *what* exists; only people know *why*. The quickest way: run `builtlore docs` and open **To write** (`docs/builtlore/to-write.md`). It lists everything still empty (the project summary, feature descriptions, names for statuses the code only knows as numbers, what each status-changing step means) as YAML you paste into `builtlore.edits.yaml` and fill in. Empty values are ignored, so you can fill in a few at a time.

Or edit in the canvas:

```bash
builtlore serve            # scans, then opens http://127.0.0.1:4321 with editing on
```

![Editing a feature in builtlore serve](docs/images/editing.png)

Click a step or a feature title and edit it: give it a business name, write what happens there, move it to another feature (or type a new feature name), or hide it. Every save goes to **`builtlore.edits.yaml`** in your project:

```yaml
features:
  menu.mtdi:
    name: Monthly target input (MTDI)
    description: Area managers enter monthly targets; the regional head approves them.
steps:
  route:menu.mtdi.status.approve:
    label: Regional head approves
    description: Locks the targets for the month. Rejected targets go back to the area manager.
    code: 4f1c2a9be0
glossary:
  MTDI: Month-to-date input
```

- **Commit this file.** Rescans start from the code and apply the edits on top, so nothing you write is overwritten.
- You can edit the file by hand too; comments are kept.
- When the code behind a described step changes, the step gets an **amber dot** and a "check the description" note, rather than silently showing something outdated. Saving it again clears the flag.
- Edits for steps that no longer exist are kept and listed in the scan notes, so you can decide what to do with them.

The **Project** button holds the text that opens the documentation: the system's name, what it is for, and a glossary of the terms your team uses. **Docs** shows the documentation as `builtlore docs` would write it right now.

```yaml
project:
  name: Procurement portal
  summary: Staff request items; their manager approves, then procurement orders them from the ERP.
```

`serve` only listens on `127.0.0.1`, and writes need a per-session token, so other websites open in your browser cannot change your files.

### Project documentation

```bash
builtlore docs                      # scan + docs/builtlore/ (Markdown, index.html, canvas.html)
builtlore docs --out handover --open
```

| Section | What is in it | Read from |
|---|---|---|
| Start here | Summary, main path of each process, who uses the system, modules, what to read next, the canvas | `project:` and feature descriptions in `builtlore.edits.yaml`, Process layer |
| Who uses it | Each role and what it can do (plus the full role × action matrix) | Middleware, handler checks, Blade conditions (same as the Process view) |
| Features | Per feature: what you can do there, how it works as numbered steps, a *who does what* swimlane flowchart, the status diagram, and a *screens and actions* flowchart (Mermaid / SVG); routes and files folded for developers. Features that only add, edit, delete, import or export (master data) get one table of operations instead, and a *Data management overview* sums them all up | Process layer, jobs that change a status, routes and views |
| Business rules | Per form: each field's rules as written and in plain English; when each step is allowed | `validate()`, `Validator::make()`, FormRequest `rules()`, status guards |
| Data dictionary | Tables, columns, types, defaults, keys, relationships, known status values | `database/migrations` (oldest first), models |
| Integrations | HTTP APIs, email, notifications and channels, file storage, and which step calls them | `Http::`, `Mail::`, `notify()`, `Notification::send()`, `Storage::`, `->store()` |
| Automation | Schedule in plain English, commands, jobs, the statuses they change | `routes/console.php`, `app/Console/Kernel.php`, `app/Console/Commands`, `app/Jobs` |
| API reference | API, data (JSON) and file endpoints: access, parameters, validation, response | Routes, handlers, validation |
| Configuration | Environment keys, where they are read, whether `.env.example` lists them | `env()` calls, `config/*.php`, key names of `.env.example` |
| Glossary | Your terms | `glossary:` in `builtlore.edits.yaml` |
| Findings | Permission checked only in the page, writes open to anyone, duplicate routes, writes without validation, `env()` outside config, missing `.env.example` keys, pages nothing leads to, and everything builtlore could not read | Scan |
| To write | What only people can write and nobody has yet, as YAML to paste into `builtlore.edits.yaml` | Scan + `builtlore.edits.yaml` |

The Markdown pages link every fact to its file and line, and render on GitHub and GitLab (diagrams included). `index.html` is a single offline file with a folding table of contents (business processes first, master data and other screens folded, grouped by area) and the canvas embedded; print it from the browser to get a PDF. `builtlore docs` also does everything `builtlore scan` does, so one command is enough. builtlore only replaces files it wrote, and refuses to overwrite anything else.

### What changed between two versions

```bash
builtlore diff                       # HEAD vs the working folder (before you commit)
builtlore diff main                  # main vs the working folder (a branch, before the pull request)
builtlore diff v1.2 v1.3             # two tags
builtlore diff old.json new.json     # two saved maps
builtlore diff main --md builtlore-diff.md   # also write Markdown to paste in the pull request
```

```
What changed: main (ef2a380) → working folder

Who can do it (1)
  ~ "Approve": Manager → Director

Status flow (3)
  + Orders: new status "Shipped"
  ~ Orders: "Ship" can now end at "Shipped"
  ~ Orders: "Ship" no longer ends at "Sent"

Business rules (validation) (1)
  ~ "Save order": title: required, at most 100 characters → required, at most 150 characters

Integrations (1)
  - Mail OrderApproved is no longer used
```

It compares steps, who can do them, status flows, validation, integrations, tables and columns, the schedule, commands, jobs and environment keys. A git ref is checked out in a temporary worktree and scanned there, so both sides are read by the same builtlore version and nothing in your folder changes; the worktree is removed afterwards. Both sides use static mode (no PHP needed) unless you pass `--mode`. Run it from the project folder, or pass `--project <dir>` (also works when the app is a subfolder of the repository).

## What builtlore reads in a Laravel app

| Source | What it extracts |
|---|---|
| `routes/web.php`, `routes/api.php` and files they `require` | Routes, including `prefix`, `name`/`as`, `middleware`, `controller()` groups, array-style `group()`, `resource`/`apiResource` with `only`/`except`, `Route::view`, `Route::redirect`, `match`, `any` |
| Controllers (via `composer.json` PSR-4) | Rendered views (`view()`, `View::make`, `Inertia::render`), redirects (`redirect()->route()`, `to_route()`, `back()`, `redirect('/path')`, `intended()`, `action()`), validation (`$request->validate()`, Form Request parameters) |
| Route closures | Same as controllers |
| Blade views and `@include`d partials | Links and forms pointing at `route()`, `url()`, `action()` or literal paths |
| Scripts and attributes in Blade (`$.post("{{ route('x') }}")`, DataTables `ajax:`, `data-url="{{ route('x') }}"`) | AJAX calls and links built in JavaScript |
| Layouts (`@extends`, `<x-app-layout>`) | Counted but not drawn, so navigation menus do not connect every page to every other page |
| The route table as a whole | Warnings for duplicate routes (same method and URI defined twice) and route names used by more than one route |
| Validation and FormRequests | Rules per form field, kept as written with a plain-English reading |
| `database/migrations` | Tables, columns, foreign keys, enums and comments, with later changes replayed in order |
| `routes/console.php`, `app/Console`, `app/Jobs` | Scheduled tasks, commands, jobs, and the statuses they change |
| `Http::`, `Mail::`, notifications, `Storage::` | Integrations, and the step, command or job that uses each one (also when sent from a service, a listener or an observer) |
| `app/Providers`, `app/Listeners`, `app/Observers`, `app/Policies` | Event listeners (`$listen`, `Event::listen`, subscribers, discovery), observers (`::observe()`, `#[ObservedBy]`), policies (`$policies`, `Gate::policy`, `#[UsePolicy]`, naming convention) and `Gate::define` / `Gate::before` |
| `config/*.php`, `env()`, `.env.example` | Environment key names (never values) |

Inertia and Livewire pages are detected; following their navigation is planned.

## Privacy

builtlore runs entirely on your machine. It does not use AI and makes no network calls (`builtlore serve` listens on `127.0.0.1` only). It reads code only: it never opens `.env`, reads only the key names of `.env.example`, does not copy defaults written next to `env()`, and does not connect to your database. (Optional AI naming and a read-only database layer are planned, and will be opt-in; see the design document.)

## Roadmap

| Version | Scope |
|---|---|
| **v0.1** | Laravel flows · canvas · JSON model |
| v0.2 | Process view: swimlanes per role, status changes from strings, numbers, constants and enums; roles and statuses editable |
| **v0.3** | **Project documentation** (alpha): `builtlore docs` → Markdown + printable HTML: overview, roles × actions, processes, business rules, data dictionary, integrations, automation, API, configuration, glossary, findings, text to write · `builtlore diff`: behaviour changes between two versions. Next: change history, Word export |
| v0.3.x | History: when each feature appeared and how it changed (git) · timeline slider · CI check |
| v0.4 | Data layer: tables, relationships, stored procedures, step ↔ table links |
| v0.5 | Automation layer: schedulers, cron, queues, webhooks |
| v0.6 | Go, Next.js and Flutter adapters |
| v0.7 | Tests layer: which flows are covered, results on the canvas |
| v0.8 | Requirements layer: what was requested vs. what was built |

Details in [docs/DESIGN.md](docs/DESIGN.md).

## Contributing

Adapters for new frameworks are the most valuable contribution. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
