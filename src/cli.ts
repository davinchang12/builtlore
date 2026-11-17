#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { adapters } from "./adapters/index.js";
import { detectStacks, scanProject, writeHtml, DEFAULT_CONFIG, loadConfig, type ScanResult } from "./core/scan.js";
import { serveProject } from "./core/serve.js";
import { CHECK_RULES, checkMarkdown, checkText, runCheck, type CheckRule } from "./core/check.js";
import { diffMaps, diffMarkdown, diffText, loadSide } from "./core/diff.js";
import { missingText } from "./docs/content.js";
import { DEFAULT_DOCS_DIR, writeDocs } from "./docs/index.js";
import type { BuiltMap } from "./core/types.js";
import { VERSION } from "./core/version.js";

const HELP = `builtlore ${VERSION}
See how your app is actually built: business flows on one canvas, generated from code.

Usage
  builtlore init [path]                 Detect stacks and write builtlore.config.yaml
  builtlore scan [paths...] [options]   Scan one or more projects (default: current folder)
  builtlore view [path] [--no-open]     Open the canvas for a scanned project
  builtlore serve [path] [--port 4321]  Scan and open the canvas with editing on:
                                        name steps, describe features, regroup, hide,
                                        write the project summary and glossary.
                                        Edits save to builtlore.edits.yaml and survive rescans.
  builtlore docs [path] [--out <dir>]   Scan and write the project documentation: Markdown
                                        (default docs/builtlore/) plus one printable index.html
  builtlore diff [base] [head]          What changed in behaviour: steps, statuses, roles, rules,
                                        integrations, data, automation, configuration.
                                        base/head: a git ref (scanned in a temporary worktree) or a
                                        builtlore.json file. Defaults: base HEAD, head = working folder.
  builtlore check [path]                For CI: fail when the committed builtlore.json is out of date,
                                        or (with --base and --fail-on) when a change adds new risks.

Scan options
  --mode <auto|static|artisan>         Laravel: artisan (exact, needs PHP + vendor/), static (no PHP), auto (default)
  --out <file>                         Output JSON path relative to the project (default: builtlore.json)
  --php <path>                         PHP executable for artisan mode (default: php on PATH; or set BUILTLORE_PHP)
  --open                               Open the canvas after scanning (single project only)
  --db                                 Opt-in, read-only: boot the app to read its database schema and status lookup
                                       tables (needs PHP and vendor/; Laravel reads .env, builtlore never does)

Docs options
  --out <dir>                          Docs folder relative to the project (default: docs/builtlore)
  --open                               Open index.html after writing
  (--mode and --php work as for scan)

Diff options
  --project <dir>                      Project folder (default: current folder)
  --md <file>                          Also write the report as Markdown (for a pull request)
  (both sides are scanned in static mode unless --mode is given)

Check options
  --base <ref|file>                    What to compare with (default: the committed builtlore.json)
  --fail-on <rules>                    Comma list: changes (default), open, page-only, unvalidated.
                                       open/page-only/unvalidated fail only on findings the base did not have
  --md <file>                          Also write the report as Markdown (for a pull request comment)

Examples
  builtlore scan
  builtlore scan ~/work/project-1 ~/work/project-2
  builtlore view ~/work/project-1
  builtlore docs --open
  builtlore diff main --md builtlore-diff.md
  builtlore check --base origin/main --fail-on open,page-only --md builtlore-check.md

Supported stacks: ${adapters.map((a) => a.name).join(", ")} (Go, Next.js and Flutter are planned)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      out: { type: "string" },
      php: { type: "string" },
      port: { type: "string" },
      md: { type: "string" },
      project: { type: "string" },
      base: { type: "string" },
      "fail-on": { type: "string" },
      db: { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, ...paths] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }

  switch (command) {
    case "init":
      return init(paths[0] ?? ".");
    case "scan":
      return scan(paths.length ? paths : ["."], {
        mode: values.mode as "auto" | "static" | "artisan" | undefined,
        out: values.out,
        php: values.php,
        open: values.open,
        db: values.db,
      });
    case "view":
      return view(paths[0] ?? ".", !values["no-open"]);
    case "docs":
      return docs(paths[0] ?? ".", {
        mode: values.mode as "auto" | "static" | "artisan" | undefined,
        out: values.out,
        php: values.php,
        open: values.open,
        db: values.db,
      });
    case "diff":
      return diff(values.project ?? ".", paths[0], paths[1], { mode: values.mode as "auto" | "static" | "artisan" | undefined, md: values.md });
    case "check":
      return check(paths[0] ?? values.project ?? ".", { base: values.base, failOn: values["fail-on"], md: values.md, mode: values.mode as "auto" | "static" | "artisan" | undefined });
    case "serve":
      return serve(paths[0] ?? ".", {
        mode: values.mode as "auto" | "static" | "artisan" | undefined,
        php: values.php,
        port: values.port ? Number(values.port) : undefined,
        open: !values["no-open"],
      });
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

async function init(pathArg: string): Promise<number> {
  const root = resolve(pathArg);
  const stacks = await detectStacks(root);
  if (!stacks.length) {
    console.error(`No supported stack detected in ${root}.`);
    return 1;
  }
  const cfgPath = join(root, "builtlore.config.yaml");
  if (!existsSync(cfgPath)) {
    writeFileSync(
      cfgPath,
      `# builtlore configuration
# mode: auto | static | artisan   (Laravel: artisan needs PHP + vendor/, static works anywhere)
mode: ${DEFAULT_CONFIG.mode}
# Where the as-built model is written (commit this file to track changes over time)
output: ${DEFAULT_CONFIG.output}
`,
    );
    console.log(`Created ${rel(cfgPath)}`);
  } else {
    console.log("builtlore.config.yaml already exists");
  }
  const gi = join(root, ".gitignore");
  const line = ".builtlore/";
  if (!existsSync(gi) || !readFileSync(gi, "utf8").split(/\r?\n/).includes(line)) {
    appendFileSync(gi, `${existsSync(gi) ? "\n" : ""}${line}\n`);
    console.log("Added .builtlore/ to .gitignore");
  }
  console.log(`Detected: ${stacks.join(", ")}. Next: builtlore scan`);
  return 0;
}

async function scan(paths: string[], opts: { mode?: "auto" | "static" | "artisan"; out?: string; php?: string; open: boolean; db?: boolean }): Promise<number> {
  let failures = 0;
  const done: string[] = [];
  for (const p of paths) {
    const started = Date.now();
    try {
      const res = await scanProject(p, { mode: opts.mode, output: opts.out, php: opts.php, database: opts.db || undefined });
      printScan(res, started);
      done.push(res.htmlPath);
    } catch (err) {
      failures++;
      console.error(`\n✖ ${p}: ${(err as Error).message}`);
    }
  }
  if (opts.open && done.length === 1) openFile(done[0]);
  if (paths.length > 1) console.log(`\nScanned ${paths.length - failures}/${paths.length} projects.`);
  return failures ? 1 : 0;
}

/** What `builtlore scan` prints; `builtlore docs` prints the same before its own lines. */
function printScan(res: ScanResult, started: number): void {
  const m = res.map;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n✔ ${m.project.title ?? m.project.name}  (${m.stacks.join(", ")}, ${secs}s)`);
  console.log(`  ${m.features.length} features · ${m.nodes.length} steps · ${m.edges.length} transitions · ${m.skipped.length} skipped`);
  for (const n of m.notes) console.log(`  · ${n}`);
  console.log(`  map:    ${rel(res.jsonPath)}`);
  console.log(`  canvas: ${rel(res.htmlPath)}`);
}

async function view(pathArg: string, open: boolean): Promise<number> {
  const root = resolve(pathArg);
  const cfg = loadConfig(root);
  const jsonPath = join(root, cfg.output);
  if (!existsSync(jsonPath)) {
    console.error(`No ${cfg.output} in ${root}. Run: builtlore scan ${pathArg}`);
    return 1;
  }
  const map = JSON.parse(readFileSync(jsonPath, "utf8")) as BuiltMap;
  const html = writeHtml(root, map);
  console.log(`Canvas: ${rel(html)}`);
  if (open) openFile(html);
  return 0;
}

async function docs(pathArg: string, opts: { mode?: "auto" | "static" | "artisan"; out?: string; php?: string; open: boolean; db?: boolean }): Promise<number> {
  const started = Date.now();
  try {
    const res = await scanProject(pathArg, { mode: opts.mode, php: opts.php, database: opts.db || undefined });
    printScan(res, started);
    const written = await writeDocs(res.root, res.map, opts.out ?? DEFAULT_DOCS_DIR);
    const m = res.map;
    console.log(`\n✔ Docs  ${rel(written.dir)}`);
    console.log(`  ${written.files.length} Markdown pages · index.html (print to PDF) · canvas.html`);
    if (written.removed.length) console.log(`  · removed ${written.removed.length} page${written.removed.length === 1 ? "" : "s"} of features no longer in the code`);
    const missing = missingText(m);
    if (missing.total) console.log(`  · To write (only people know it): ${missing.total} item${missing.total === 1 ? "" : "s"}, ready to paste: ${rel(join(written.dir, "to-write.md"))}`);
    console.log(`  html:   ${rel(written.html)}`);
    console.log(`  start:  ${rel(join(written.dir, "README.md"))}`);
    if (opts.open) openFile(written.html);
    return 0;
  } catch (err) {
    console.error(`\n✖ ${pathArg}: ${(err as Error).message}`);
    return 1;
  }
}

async function serve(pathArg: string, opts: { mode?: "auto" | "static" | "artisan"; php?: string; port?: number; open: boolean }): Promise<number> {
  try {
    const h = await serveProject(pathArg, { mode: opts.mode, php: opts.php, port: opts.port });
    console.log(`\n✔ Editing ${h.root}`);
    console.log(`  canvas: ${h.url}`);
    console.log(`  edits:  ${rel(join(h.root, "builtlore.edits.yaml"))} (commit this file)`);
    console.log("  Press Ctrl+C to stop.");
    if (opts.open) openFile(h.url);
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => { h.server.close(); resolve(); });
    });
    return 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") console.error(`Port ${opts.port ?? 4321} is in use. Try: builtlore serve --port 4322`);
    else console.error(`✖ ${e.message}`);
    return 1;
  }
}

async function diff(project: string, base: string | undefined, head: string | undefined, opts: { mode?: "auto" | "static" | "artisan"; md?: string }): Promise<number> {
  try {
    const mode = opts.mode ?? "static";
    const b = await loadSide(project, base ?? "HEAD", mode);
    const h = await loadSide(project, head, mode);
    const sections = diffMaps(b.map, h.map);
    console.log(diffText(sections, b.label, h.label));
    if (opts.md) {
      writeFileSync(resolve(opts.md), diffMarkdown(sections, b.label, h.label));
      console.log(`\nMarkdown: ${rel(resolve(opts.md))}`);
    }
    return 0;
  } catch (err) {
    console.error(`✖ ${(err as Error).message}`);
    return 1;
  }
}

async function check(project: string, opts: { base?: string; failOn?: string; md?: string; mode?: "auto" | "static" | "artisan" }): Promise<number> {
  try {
    const root = resolve(project);
    const failOn = (opts.failOn ?? "changes").split(",").map((s) => s.trim()).filter(Boolean) as CheckRule[];
    const unknown = failOn.filter((r) => !CHECK_RULES.includes(r));
    if (unknown.length) {
      console.error(`✖ Unknown --fail-on rule: ${unknown.join(", ")}. Use ${CHECK_RULES.join(", ")}.`);
      return 2;
    }
    // Default base: the map committed with the code
    let baseSpec = opts.base;
    if (!baseSpec) {
      const committed = join(root, loadConfig(root).output);
      if (!existsSync(committed)) {
        console.error(`✖ No ${loadConfig(root).output} to compare with. Run builtlore scan and commit it, or pass --base <git ref>.`);
        return 2;
      }
      baseSpec = committed;
    }
    const mode = opts.mode ?? "static";
    const b = await loadSide(root, baseSpec, mode);
    const h = await loadSide(root, undefined, mode);
    const result = runCheck(b.map, h.map, failOn);
    console.log(checkText(result, b.label, h.label));
    if (result.failed.includes("changes") && !opts.base) console.log("  The committed map is out of date: run builtlore scan and commit builtlore.json.");
    if (opts.md) writeFileSync(resolve(opts.md), checkMarkdown(result, b.label, h.label));
    return result.failed.length ? 1 : 0;
  } catch (err) {
    console.error(`✖ ${(err as Error).message}`);
    return 2;
  }
}

function openFile(path: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => console.log(`Open in your browser: ${path}`)).unref();
  } catch {
    console.log(`Open in your browser: ${path}`);
  }
}

function rel(p: string): string {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
