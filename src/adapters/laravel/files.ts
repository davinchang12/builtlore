import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { nameContext, parsePhp, type NameContext, type PhpNode } from "./php.js";

/** Repo-relative paths of .php files under `dir` (recursive, sorted). vendor/ and node_modules/ are never entered. */
export function phpFiles(root: string, dir: string, depth = 8): string[] {
  const out: string[] = [];
  const visit = (rel: string, d: number) => {
    const abs = join(root, rel);
    if (d > depth || !existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === "vendor" || name === "node_modules" || name.startsWith(".")) continue;
      const childRel = `${rel}/${name}`;
      const st = statSync(join(abs, name));
      if (st.isDirectory()) visit(childRel, d + 1);
      else if (name.endsWith(".php") && !name.endsWith(".blade.php")) out.push(childRel);
    }
  };
  visit(dir, 0);
  return out;
}

export interface ParsedFile {
  file: string;
  ast: PhpNode;
  names: NameContext;
}

/** Parse each file once per scan. */
export class PhpCache {
  private cache = new Map<string, ParsedFile | null>();
  constructor(private root: string) {}

  get(file: string): ParsedFile | null {
    if (this.cache.has(file)) return this.cache.get(file)!;
    const abs = join(this.root, file);
    let parsed: ParsedFile | null = null;
    if (existsSync(abs)) {
      const ast = parsePhp(readFileSync(abs, "utf8"), file);
      if (ast) parsed = { file, ast, names: nameContext(ast) };
    }
    this.cache.set(file, parsed);
    return parsed;
  }
}
