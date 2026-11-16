# Changelog

All notable changes to this project are documented here.

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
