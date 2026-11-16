import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import YAML from "yaml";
import { adapters } from "../adapters/index.js";
import { renderHtml } from "../render/html.js";
import { applyEdits, loadEdits } from "./edits.js";
import { buildMap } from "./model.js";
import type { BuiltMap, ExtractOptions, Fact } from "./types.js";
import { VERSION } from "./version.js";

export interface Config {
  mode: ExtractOptions["mode"];
  output: string;
  /** PHP executable for Laravel artisan mode. */
  php?: string;
}

export const DEFAULT_CONFIG: Config = { mode: "auto", output: "builtlore.json" };

export function loadConfig(root: string): Config {
  const path = join(root, "builtlore.config.yaml");
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = YAML.parse(readFileSync(path, "utf8")) ?? {};
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function detectStacks(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const a of adapters) if (await a.detect({ root })) found.push(a.id);
  return found;
}

export interface ScanResult {
  root: string;
  /** What the code says, before edits. */
  raw: BuiltMap;
  /** raw + builtlore.edits.yaml; this is what gets written. */
  map: BuiltMap;
  jsonPath: string;
  htmlPath: string;
}

export async function scanProject(rootArg: string, overrides: Partial<Config> = {}): Promise<ScanResult> {
  const root = resolve(rootArg);
  if (!existsSync(root)) throw new Error(`Path not found: ${root}`);
  const config = { ...loadConfig(root), ...stripUndefined(overrides) };

  const facts: Fact[] = [];
  const notes: string[] = [];
  const stacks: string[] = [];
  for (const adapter of adapters) {
    if (!(await adapter.detect({ root }))) continue;
    stacks.push(adapter.id);
    const res = await adapter.extract({ root }, { mode: config.mode, php: config.php });
    facts.push(...res.facts);
    notes.push(...res.notes);
  }
  if (!stacks.length) {
    throw new Error(
      `No supported stack detected in ${root}. Supported in this version: ${adapters.map((a) => a.name).join(", ")}.`,
    );
  }

  const raw = buildMap({
    projectName: projectName(root),
    commit: gitCommit(root),
    stacks,
    facts,
    notes,
    generator: `builtlore ${VERSION}`,
  });
  const map = applyEdits(raw, loadEdits(root));

  const jsonPath = join(root, config.output);
  writeFileSync(jsonPath, JSON.stringify(map, null, 2) + "\n");
  const htmlPath = writeHtml(root, map);
  return { root, raw, map, jsonPath, htmlPath };
}

export function writeHtml(root: string, map: BuiltMap): string {
  const dir = join(root, ".builtlore");
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, "map.html");
  writeFileSync(htmlPath, renderHtml(map));
  return htmlPath;
}

export function writeJson(root: string, map: BuiltMap): string {
  const jsonPath = join(root, loadConfig(root).output);
  writeFileSync(jsonPath, JSON.stringify(map, null, 2) + "\n");
  return jsonPath;
}

function projectName(root: string): string {
  const composer = join(root, "composer.json");
  if (existsSync(composer)) {
    try {
      const name = JSON.parse(readFileSync(composer, "utf8")).name;
      if (name && name !== "laravel/laravel") return name;
    } catch {
      /* ignore */
    }
  }
  return basename(root);
}

function gitCommit(root: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
