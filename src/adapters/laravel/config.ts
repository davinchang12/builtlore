/**
 * Configuration: which environment keys the code reads, by name only.
 * Values are never read: .env is not opened at all, and only the key names of
 * .env.example are used. Defaults written in code are noted as "has a default",
 * never copied.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigFact, SkippedFact } from "../../core/types.js";
import { phpFiles, type PhpCache } from "./files.js";
import { lineOf, phpText, stringValue, walk, type PhpNode } from "./php.js";

export interface ConfigResult {
  keys: ConfigFact[];
  /** config key ("services.erp.url") -> env keys behind it. */
  configEnv: Map<string, string[]>;
  skipped: SkippedFact[];
}

export function readConfig(root: string, php: PhpCache): ConfigResult {
  const keys = new Map<string, ConfigFact>();
  const configEnv = new Map<string, string[]>();
  const skipped: SkippedFact[] = [];
  const key = (name: string): ConfigFact => {
    let k = keys.get(name);
    if (!k) {
      k = { kind: "config", key: name, uses: [], inExample: false };
      keys.set(name, k);
    }
    return k;
  };

  // 1. config/*.php: return [ 'erp' => [ 'url' => env('ERP_URL') ] ]
  for (const file of phpFiles(root, "config", 2)) {
    const parsed = php.get(file);
    if (!parsed) continue;
    const prefix = file.replace(/^config\//, "").replace(/\.php$/, "").split("/").join(".");
    const seen = new Set<PhpNode>();
    walk(parsed.ast, (n) => {
      if (n.kind === "return" && n.expr?.kind === "array") {
        readConfigArray(n.expr, prefix, file, (envKey, path, call) => {
          seen.add(call);
          key(envKey).uses.push({ source: { file, line: lineOf(call) }, config: path, hasDefault: (call.arguments ?? []).length > 1 });
          for (let i = path.split(".").length; i >= 1; i--) {
            const p = path.split(".").slice(0, i).join(".");
            const list = configEnv.get(p) ?? [];
            if (!list.includes(envKey)) list.push(envKey);
            configEnv.set(p, list);
          }
        });
      }
    });
    // env() outside the returned array (rare) still counts
    walk(parsed.ast, (n) => {
      if (isEnvCall(n) && !seen.has(n)) recordEnv(n, file, key, skipped);
    });
  }

  // 2. env() anywhere else in the app (it returns null once config is cached)
  for (const dir of ["app", "routes", "bootstrap", "database"]) {
    for (const file of phpFiles(root, dir)) {
      const parsed = php.get(file);
      if (!parsed) continue;
      walk(parsed.ast, (n) => {
        if (isEnvCall(n)) recordEnv(n, file, key, skipped);
      });
    }
  }

  // 3. .env.example: key names only
  const example = join(root, ".env.example");
  if (existsSync(example)) {
    for (const line of readFileSync(example, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) key(m[1]).inExample = true;
    }
  }

  return { keys: [...keys.values()].sort((a, b) => a.key.localeCompare(b.key)), configEnv, skipped };
}

function readConfigArray(arr: PhpNode, path: string, file: string, onEnv: (key: string, path: string, call: PhpNode) => void): void {
  for (const it of arr.items ?? []) {
    if (it?.kind !== "entry") continue;
    const k = it.key ? stringValue(it.key) : null;
    const childPath = k !== null ? `${path}.${k}` : path;
    if (it.value?.kind === "array") readConfigArray(it.value, childPath, file, onEnv);
    else {
      walk(it.value, (n) => {
        if (isEnvCall(n)) {
          const envKey = stringValue(n.arguments?.[0]);
          if (envKey) onEnv(envKey, childPath, n);
        }
      });
    }
  }
}

function isEnvCall(n: PhpNode): boolean {
  return n?.kind === "call" && n.what?.kind === "name" && /^\\?(env|getenv)$/.test(n.what.name);
}

function recordEnv(n: PhpNode, file: string, key: (k: string) => ConfigFact, skipped: SkippedFact[]): void {
  const name = stringValue(n.arguments?.[0]);
  if (!name) {
    skipped.push({ kind: "skipped", reason: `Environment key not readable: ${phpText(n)}`, source: { file, line: lineOf(n) } });
    return;
  }
  key(name).uses.push({ source: { file, line: lineOf(n) }, hasDefault: (n.arguments ?? []).length > 1 });
}
