/**
 * Artisan mode: ask Laravel itself for the resolved route table.
 * Requires PHP and installed dependencies (vendor/). Falls back silently.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HttpMethod } from "../../core/types.js";
import { joinUri, type RawRoute } from "./routes-static.js";

interface ArtisanRoute {
  domain: string | null;
  method: string; // "GET|HEAD"
  uri: string;
  name: string | null;
  action: string; // "App\\Http\\Controllers\\X@index" | "Closure" | "Illuminate\\Routing\\ViewController"
  middleware: string[] | string;
}

export interface ArtisanResult {
  ok: boolean;
  routes: RawRoute[];
  reason?: string;
}

export function artisanAvailable(root: string): boolean {
  return existsSync(join(root, "artisan")) && existsSync(join(root, "vendor", "autoload.php"));
}

export function extractRoutesArtisan(root: string, php = "php", timeoutMs = 30000): ArtisanResult {
  if (!artisanAvailable(root)) return { ok: false, routes: [], reason: "artisan or vendor/ not found" };
  const run = (args: string[]) =>
    spawnSync(php, ["artisan", "route:list", "--json", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, APP_ENV: process.env.APP_ENV ?? "local" },
    });
  let res = run(["--except-vendor"]);
  if (res.status !== 0) res = run([]);
  if (res.error) {
    const missing = (res.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      routes: [],
      reason: missing
        ? `PHP not found at '${php}'. Add PHP to PATH or pass --php <path> (e.g. Laragon/XAMPP php.exe)`
        : `php not runnable: ${res.error.message}`,
    };
  }
  if (res.status !== 0) return { ok: false, routes: [], reason: (res.stderr || res.stdout || "route:list failed").trim().split("\n")[0] };

  let parsed: ArtisanRoute[];
  try {
    const start = res.stdout.indexOf("[");
    parsed = JSON.parse(res.stdout.slice(start));
  } catch {
    return { ok: false, routes: [], reason: "route:list returned non-JSON output" };
  }

  const routes: RawRoute[] = [];
  for (const r of parsed) {
    const action = r.action ?? "";
    // Skip framework/vendor internals that slipped through
    if (/^(Illuminate\\(?!Routing\\(View|Redirect)Controller)|Laravel\\|Livewire\\Features)/.test(action)) continue;
    let methods = r.method.split("|").map((m) => m.toUpperCase()) as HttpMethod[];
    if (normalizeMethods(methods) === "ANY") methods = ["ANY"];
    const uri = joinUri("", r.uri);
    const middleware = Array.isArray(r.middleware) ? r.middleware : String(r.middleware ?? "").split(/\r?\n|,/).filter(Boolean);
    let routeAction: RawRoute["action"] = { kind: "unknown", raw: action };
    if (action.includes("@")) {
      const [cls, method] = action.split("@");
      routeAction = { kind: "controller", class: cls.replace(/^\\/, ""), method };
    } else if (/^App\\/.test(action)) {
      routeAction = { kind: "controller", class: action, method: "__invoke" };
    }
    routes.push({
      methods,
      uri,
      name: r.name ?? undefined,
      middleware: middleware.map((m) => m.replace(/^Illuminate\\.*\\/, "").trim()),
      action: routeAction,
      file: uri.startsWith("api/") ? "routes/api.php" : "routes/web.php",
      routeFile: uri.startsWith("api/") ? "api" : "web",
    });
  }
  return { ok: true, routes };
}

/** Route::any / Route::redirect are listed by artisan with every verb. */
function normalizeMethods(methods: HttpMethod[]): string {
  const m = methods.filter((x) => x !== "HEAD");
  if (m.includes("ANY") || m.length >= 6) return "ANY";
  return m.join("|");
}

/**
 * Artisan gives the exact route table; static parsing knows source lines,
 * closures and Route::view names. Merge: artisan wins on the table, static
 * fills in what artisan cannot see.
 */
export function mergeRoutes(artisan: RawRoute[], fromStatic: RawRoute[]): RawRoute[] {
  const key = (r: RawRoute) => `${normalizeMethods(r.methods)} ${r.uri}`;
  const staticByKey = new Map(fromStatic.map((r) => [key(r), r]));
  const staticByName = new Map(fromStatic.filter((r) => r.name).map((r) => [r.name!, r]));
  return artisan.map((r) => {
    const s = (r.name && staticByName.get(r.name)) || staticByKey.get(key(r));
    if (!s) return r;
    return {
      ...r,
      file: s.file,
      line: s.line,
      action: r.action.kind === "unknown" ? s.action : r.action,
    };
  });
}
