# Changelog

All notable changes to this project are documented here.

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
