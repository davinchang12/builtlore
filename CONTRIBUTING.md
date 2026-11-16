# Contributing to builtlore

Thanks for helping. builtlore is young, so issues that say "this didn't work on my app" are just as valuable as code.

## Development setup

```bash
npm install
npm run build
npm test                 # builds, then runs node:test against fixtures/
npm run scan:fixture     # scans fixtures/laravel-clinic and writes its canvas
```

Open `fixtures/laravel-clinic/.builtlore/map.html` in a browser to see the result.

## Project layout

```
src/
  cli.ts                  command-line entry (init, scan, view)
  core/
    types.ts              Fact and BuiltMap types (the contract between adapters and the rest)
    model.ts              facts -> features, nodes, edges (stack-agnostic)
    scan.ts               detect stacks, run adapters, write builtlore.json and the canvas
  adapters/
    index.ts              registered adapters
    laravel/              the Laravel adapter
  render/html.ts          builds the single-file canvas
assets/                   viewer.js and viewer.css, inlined into the canvas
fixtures/                 small sample apps used by the tests
test/                     tests (node:test)
docs/DESIGN.md            design document and roadmap
```

## Principles

1. **Deterministic first.** Adapters read code; they never guess. If something cannot be resolved, emit a `skipped` fact with a reason.
2. **Stable IDs.** Node IDs come from route names or method + URI, never from generated text, so they survive re-scans.
3. **Business flows over code structure.** Prefer what a user would call a step ("Pay") over what a compiler would call it.
4. **Offline by default.** No network calls unless a user explicitly opts in.

## Writing an adapter

An adapter turns a framework's source code into facts. See `src/core/types.ts`:

```ts
interface Adapter {
  id: string;                     // "go-chi", "nextjs-app-router", ...
  name: string;
  detect(repo: RepoInfo): Promise<boolean>;
  extract(repo: RepoInfo, options: ExtractOptions): Promise<AdapterResult>;
}
```

An adapter emits:

- `entry` facts: pages, actions and API endpoints, with source file and line.
- `navigates` facts: links, form submissions, redirects and failure branches between entries.
- `skipped` facts: anything seen but not resolvable.

Steps:

1. Add a small fixture app under `fixtures/<stack>-<name>/` with at least one success path and one failure branch.
2. Implement the adapter under `src/adapters/<stack>/` and register it in `src/adapters/index.ts`.
3. Add tests under `test/` that assert on specific edges, not just counts.
4. Document what the adapter reads in the README table.

Planned adapters, in order: Go (net/http, gin, echo, chi), Next.js (App Router and Pages Router), Flutter (GoRouter, Navigator).

## Pull requests

- Keep PRs focused; one adapter or one feature per PR.
- Run `npm test` before opening the PR.
- If you change the JSON model, update `docs/DESIGN.md` and bump the schema version.
