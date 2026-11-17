# Changelog

All notable changes to this project are documented here.

## 0.3.0-alpha.0 — 2026-11-17

Project documentation, generated from the code and the text people write.

### Added
- **`builtlore docs`**: one command that scans (same output as `builtlore scan`: `builtlore.json`, canvas, notes) and writes a Markdown folder (`docs/builtlore/` by default, `--out` to change), one self-contained `index.html` that prints cleanly to PDF, and `canvas.html` (the interactive canvas, also embedded in `index.html`). Written for someone new to the project: three parts (*Understand the system* in plain language, *Reference* for developers, *Health*); a *Start here* page with the main path of each process, who uses the system and what to read next; each process told as numbered steps, then the other paths (hold, reject, edit, automatic); each role with what it can do; developer tables folded away; a search box in the HTML (headings and table contents), and folded sections open when printing. Sections: system overview, roles × actions matrix, one page per feature with its business process (status lifecycle as a Mermaid diagram in Markdown, an SVG diagram in HTML), business rules, data dictionary, integrations, automation, API reference, configuration, glossary and findings. Every fact links to the file and line it comes from.
- **Business rules from validation**: `$request->validate()`, `validateWithBag()`, `$this->validate()`, `Validator::make()` / `validator()`, and `rules()` of FormRequest classes (including ones that extend the app's own base request, and rules returned from a variable). Each rule is kept as written with a plain-English reading (`max:150` → "at most 150 characters", `max:2048` on a file → "at most 2048 KB", `exists:items,id`, `Rule::in([...])`, custom rule classes and closures). The request fields a handler reads are recorded too.
- **Data dictionary from migrations**: `Schema::create` and `Schema::table` replayed oldest first (only `up()`): column types, sizes, nullable, defaults, unique/index/primary, comments, enum values, `->after()`, `->change()`, renamed and dropped columns, renamed and dropped tables, `timestamps`, `softDeletes`, `morphs`. Foreign keys from `constrained()` (named, or by Laravel's naming convention, and marked as such), `foreign()->references()->on()`, `foreignIdFor()`, `dropForeign()`, with on-delete rules. Tables are matched to models.
- **Automation**: the scheduler in `routes/console.php`, `app/Console/Kernel.php` and `bootstrap/app.php` (`Schedule::command/job/call/exec`, `$schedule->…`), with frequencies as written and in plain English when every call is known ("Weekdays at 08:00"); console commands (`$signature`, `$description`, `Artisan::command()->purpose()`); jobs in `app/Jobs`, where they are dispatched, and the statuses they change (including `where('status', …)` on the same query). Jobs that change a status appear in that process's lifecycle.
- **Integrations**: `Http::` calls with the base URL from a literal host, `config()` or `env()` and the path after it; credentials passed with `withToken(config(...))`; `Mail::…->send/queue`; `notify()` and `Notification::send()` with channels from the notification's `via()`; `Storage::disk()->…`, the default disk, and uploads stored with `->store(…, 's3')`. Each call is linked to the step, command or job that makes it.
- **Configuration**: environment keys read with `env()` in `config/*.php` (and the config key they become) and elsewhere, and the key names of `.env.example`. Values are never read: `.env` is not opened and defaults written in code are not copied.
- **Status changes in services**: builtlore follows calls from a handler into the app's own classes (`$this->approval->hold($x)` with the service set in the constructor, promoted constructor properties, `(new X)->m()`, `app(X::class)->m()`, static calls, `$this->helper()`), up to 3 levels deep, carrying the model type and status values of the arguments (`addStatus($x, Constants::STATUS_HOLD)`) and parameter defaults. Branches that cannot run with the values passed in (`if ($mode != 'pass')`) are left out.
- **Status history tables**: `$record->status()->create(['status_id' => …])` and `RecordStatus::create(['record_id' => $record->id, 'status_id' => …])` count as a status change of the record (not as a new record); `status_id` and `*_status_id` columns are read as status columns.
- **Status sequences and branches**: a step that writes several statuses in a row (submitted, then waiting for review) is shown as that sequence and ends at the last one; writes in different `if`/`else` branches (including code after `if (…) { …; return; }`) are alternatives. Docs tell each step as "→ A → B, or → C", and diagrams draw the sequence.
- **Where a step starts**: the record's current status read from a history table (`$latest = RecordStatus::where('record_id', $record->id)->latest()->value('status_id')`, `$record->statuses()->latest()->value(…)`, `$record->latestStatus->status_id`) is followed through `if ($latest == X) { … }` (that branch starts from X), guards (`if ($latest != X) return …`), and the page's view (`@if ($latestStatus == 4)` around a button, with `$latestStatus` set by the page's handler). A status in `A || B` is not taken as a requirement.
- **Branches per permission**: `if (Gate::allows('x') && !Gate::allows('y'))`, `$user->can('x')` and `hasRole('x')` mark their branch, so branches that cannot both run are kept apart; docs say which check each path runs under ("if medical", "if not medical").
- A route that already names the record (`/orders/{order}/…`) no longer counts as creating it; a status first seen as a bare number in a view takes its name from the code once found; a path contained in a longer one under the same checks is not repeated.
- **Process view connects more**: a step is linked to the steps that produce any status one of its branches starts from (not only a status the whole step checks); steps with no status check sit in a dashed *At any status* column instead of floating; the details panel lists each path a step can write and the check it runs under.
- **Integrations linked to steps through services**: email, notifications, HTTP calls and storage used inside a service are listed under the steps whose handler reaches that service method ("Sent by: Presentasi › Approved"), not only as `Service@method`; a call in a branch that cannot run with the arguments that step passes is not linked to it.
- History and log tables (`OrderHistory`, `ApprovalLog`) are no longer read as the record's status; only status tables (`OrderStatus`, `TStatusRequest`) and status relations are. Custom login-only middleware (`isLogin`) shows as *Signed-in user* in the API table; Laravel's sample `inspire` command is left out.
- **Roles and permissions apart**: named permission checks (`can:Menu X Approve`, `Gate::allows('x')`) are listed in one *Permissions* table; *Start here* lists roles and sums up permissions in one line.
- **Less noise**: keys that Laravel's own config files read (`REDIS_*`, `SESSION_*`…) are folded under *Laravel's own keys* and not reported as missing from `.env.example`; table columns are folded; "redirect back with no known source page" moved from Findings to the scan notes. The canvas opens with one process per feature (its main one); the others are one tick away.
- **Roles × actions**: every action records who does it, using the same rule as the Process view lanes (and the same edits: `roles:`, `actor:`).
- **Findings**: duplicate routes, writes without validation, `env()` outside config files, keys missing from `.env.example`, pages nothing leads to, descriptions to check, everything builtlore could not read, and the scan notes.
- **Project summary and glossary in `builtlore serve`**: a *Project* button opens the system name, summary and glossary for editing; saved under `project:` and `glossary:` in `builtlore.edits.yaml`. *Docs* opens the documentation as it would be written now (`/docs`).
- Unreadable rules, table names, URLs, disks, notification channels, env keys and schedule targets are listed under *Skipped* with file and line.

### Fixed
- A model whose name ends in `Request` (`PurchaseRequest $purchaseRequest`) was taken for a FormRequest, which added a false "validation failed" branch to steps such as approve and reject. A parameter now counts as a FormRequest only when its class extends `FormRequest`.

## 0.2.0-alpha.1 — 2026-11-16

Fixes from the first run of the Process view on a real 145-route app.

### Fixed
- **Permissions are not roles.** `can:Slide Approve`, `@can('Menu Presentasi Approve')` and other named permissions become lanes named exactly as the permission. Each step gets one lane: the most specific permission (route-level beats group-level), instead of joining every middleware ("Login / Master / Slide").
- Custom middleware that only checks login (`isLogin`, `checkSession`, `auth.sso`…) is no longer read as a role.
- History and log tables (`SlideHistory`, `approval_logs`…) no longer show up as a second, duplicate process.
- Status names written as sentences (`'Hold - Perlu Revisi'`) are kept exactly as written; only `CONSTANT_STYLE` and `snake_case` values are turned into words.
- "Revisi - Menunggu Approval" is no longer drawn as a rejection.
- Status labels no longer overlap: one label where an arrow fans out, one where several arrows arrive, wider columns, lane names wrap.

### Added
- More ways of writing a status are read: values in local variables (`$status = 'Finished'`), ternaries and `match`, arrays built before saving (`$data['status'] = …`), `DB::connection()->table()`, raw SQL (`UPDATE x SET status = '…'`), PascalCase columns (`StatusApproval`).
- Table names are matched to models (`$table`, or Laravel's plural convention), so `DB::table('presentasi')` and `Presentation` are one process.
- **Nothing is silently dropped.** Status changes builtlore cannot read yet (e.g. `$x->status = $request->status`) and stored procedure calls (`EXEC sp_…`) are listed under *Skipped* with file and line, plus a summary in the scan notes.

## 0.2.0-alpha.0 — 2026-11-16

### Added
- **Process view**, the new default tab when the app has status workflows: one swimlane diagram per process (feature × status column). Lanes are roles, cards are steps with the status they leave the record in, arrows carry the status the next step needs.
- **Roles found in code:** route middleware (`role:`, `can:`, custom middleware such as `isAtasan`), handler checks (`hasRole()`, `$user->jabatan == 'X'`, `abort_unless(auth()->user()->nik === $pr->manager_nik)` → *Manager*), Blade conditions around the button (`@role`, `@can`, `@if`), and role words in route names. Steps with no role check go to *Signed-in user*; nothing is guessed.
- **Statuses found in code**, in every common style: string literals, numbers, class constants, backed enums (including `$casts`), `$attributes` defaults; names from label arrays and `match` maps on the model.
- **Status rules:** guards in handlers (`if ($x->status != X) return back()`, `abort_unless`), `@if`/`@elseif` around links and buttons in Blade, and forms on a page that is itself only linked in some status.
- **Editing for processes** in `builtlore serve`: rename a role (`roles:`), name a status (`statuses:`), set who does a step (`actor:` on a step). Stored in `builtlore.edits.yaml`.
- Details panel shows *Who / When / Result* for each step, with the code that proves it.

### Fixed
- Saving a step whose description was empty failed on its first edit ("Expected YAML collection").
- README said Node 20; builtlore needs Node 22.

## 0.1.0-alpha.3 — 2026-11-16

### Added
- **Edits that survive rescans.** `builtlore serve` opens the canvas with editing on: rename a step or feature, describe what it is for, move a step to another feature (or a new one), hide internal steps. Edits are saved to `builtlore.edits.yaml` in the project (commit it) and applied on top of every scan, so a rescan never overwrites them. The file is plain YAML, can also be edited by hand, and keeps its comments when the canvas writes to it.
- **Needs-review flag.** When the code behind a described step changes (URL, methods, handler, view), the step gets an amber dot and a note to check the description. Saving the step again clears it.
- **Orphaned edits are kept**, not deleted, when a step disappears from the code (renamed or removed route), and are listed in the scan notes.
- Feature details: click a feature title on the canvas to see its description, steps and files.
- Descriptions show in the details panel and tooltips; steps with a description get a green dot.
- A project glossary (`glossary:` in `builtlore.edits.yaml`) is carried into `builtlore.json` for the upcoming docs output.

## 0.1.0-alpha.2 — 2026-11-16

### Changed
- **Canvas layout follows the user's journey.** Each feature is laid out on its own, left to right in the order a user meets the steps (entry page → list → create/detail → actions). Entry points are pages nothing links to and whose URL has no `{parameter}`; steps only reachable through JavaScript are placed right after the steps they lead to. Edges that go back (retry, "return to list", validation failed) no longer pull later steps to the left.
- **Features are packed into rows** in journey order instead of one large tangled graph. Edges between features are drawn faintly and highlighted when a step is selected.
- Notes say plainly when static mode is used: route files are read directly and no PHP is needed.

### Added
- URLs written by hand in scripts (`'/items/' + id + '/approve'`) are matched to routes, using a nearby `type:` / `method:` to pick the right one; ambiguous ones are left out rather than guessed.
- `/api/...` routes defined in `routes/web.php` that return JSON are treated as data endpoints of the web app.

## 0.1.0-alpha.1 — 2026-11-16

First round of fixes from running builtlore on a real 145-route internal Laravel app.

### Added
- **Data and file endpoints.** Routes that return JSON (`response()->json`, DataTables, `toJson()`) are shown as *data*; exports and downloads (`Excel::download`, `response()->download()`, PDF) as *file*. Both are hidden by default; tick *Show data & file endpoints* to see them. JSON returned from a write (store, update, approve…) stays an *action*.
- **AJAX and JavaScript links.** `route()` and `url()` used in `<script>` blocks, `data-*` attributes and inline handlers become edges: *AJAX* when they point at an action or data endpoint, *link* when they point at a page. Blade comments are ignored.
- **Duplicate route warnings.** Same method and URI defined more than once (Laravel keeps the last), and route names shared by several routes.
- `--php <path>` and `BUILTLORE_PHP` to use a PHP that is not on `PATH` (Laragon, XAMPP).
- Fixture `fixtures/laravel-workflow`: an approval-workflow app with area-prefixed routes, status controllers, AJAX dropdowns, DataTables and exports.

### Changed
- **Feature grouping for large apps.** Route name prefixes that act as areas (`menu.*`, `master.*`) are split by controller domain when the group is large, so `MTDIController` and `StatusMTDIController` share one feature. Feature names keep acronyms from controller names (`MTDI`).
- Shorter labels for status actions (`Approve manager` instead of `Menu purchase requests status approve manager`).
- Clearer message when PHP is not found.

## 0.1.0-alpha.0 — 2026-11-16

- First release: Laravel adapter (static and artisan modes), single-file canvas, `init` / `scan` / `view`.
