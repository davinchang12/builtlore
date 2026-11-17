/**
 * builtlore docs: write the documentation folder (Markdown + one HTML file).
 * Files builtlore wrote before are replaced; files it did not write are never
 * overwritten or deleted.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { BuiltMap } from "../core/types.js";
import { buildPages } from "./content.js";
import { renderDocsHtml } from "./html.js";
import { GENERATED_MARK, renderMarkdown } from "./markdown.js";
import { buildDocModel } from "./model.js";

export const DEFAULT_DOCS_DIR = "docs/builtlore";
const HTML_FILE = "index.html";
const HTML_MARK = '<meta name="generator" content="builtlore';

export interface DocsOutput {
  markdown: Map<string, string>;
  html: string;
}

/** Render the documentation in memory. `repoPrefix` is the path from the docs folder to the repository root. */
export async function renderDocs(map: BuiltMap, repoPrefix = "../../"): Promise<DocsOutput> {
  const model = buildDocModel(map);
  const pages = buildPages(model);
  const markdown = renderMarkdown(pages, { generator: map.generator, repoPrefix });
  const html = await renderDocsHtml(model, pages);
  return { markdown, html };
}

export interface DocsResult {
  dir: string;
  files: string[];
  html: string;
  removed: string[];
}

export async function writeDocs(root: string, map: BuiltMap, outDir = DEFAULT_DOCS_DIR): Promise<DocsResult> {
  const dir = resolve(root, outDir);
  const toRoot = relative(dir, root).split("\\").join("/");
  const out = await renderDocs(map, toRoot ? `${toRoot}/` : "");

  // Look before overwriting: only replace files builtlore generated.
  const targets = [...out.markdown.keys()].map((f) => join(dir, f));
  const htmlPath = join(dir, HTML_FILE);
  for (const path of [...targets, htmlPath]) {
    if (!existsSync(path)) continue;
    const head = readFileSync(path, "utf8").slice(0, 600);
    if (!head.includes(GENERATED_MARK) && !head.includes(HTML_MARK)) {
      throw new Error(`${relative(root, path)} exists and was not written by builtlore. Choose another folder with --out.`);
    }
  }

  // Remove pages builtlore wrote earlier that no longer exist (a feature was renamed or removed).
  const removed: string[] = [];
  const keep = new Set(targets.map((t) => resolve(t)));
  for (const sub of [dir, join(dir, "features")]) {
    if (!existsSync(sub)) continue;
    for (const name of readdirSync(sub)) {
      const path = resolve(sub, name);
      if (!name.endsWith(".md") || keep.has(path)) continue;
      if (readFileSync(path, "utf8").startsWith(GENERATED_MARK)) {
        rmSync(path);
        removed.push(relative(root, path).split("\\").join("/"));
      }
    }
  }

  const files: string[] = [];
  for (const [file, content] of out.markdown) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    files.push(relative(root, path).split("\\").join("/"));
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(htmlPath, out.html);
  return { dir, files, html: htmlPath, removed };
}
