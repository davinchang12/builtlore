# Changelog

All notable changes to this project are documented here.

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
