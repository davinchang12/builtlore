import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseTarget } from "../src/adapters/laravel/blade.js";
import { extractRoutesStatic, joinUri, singular } from "../src/adapters/laravel/routes-static.js";
import { scanProject } from "../src/core/scan.js";
import type { BuiltMap } from "../src/core/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
// dist/test -> repo root
const repoRoot = join(here, "..", "..");
const fixture = join(repoRoot, "fixtures", "laravel-clinic");

function edge(map: BuiltMap, from: string, to: string) {
  return map.edges.find((e) => e.from === `route:${from}` && e.to === `route:${to}`);
}

describe("static route extraction", () => {
  const { routes, skipped } = extractRoutesStatic(fixture);
  const byName = new Map(routes.filter((r) => r.name).map((r) => [r.name!, r]));

  it("applies prefix, name and controller from fluent groups", () => {
    const r = byName.get("booking.create");
    assert.ok(r, "booking.create exists");
    assert.equal(r.uri, "booking/create");
    assert.deepEqual(r.action, { kind: "controller", class: "App\\Http\\Controllers\\BookingController", method: "create" });
    assert.ok(r.middleware.includes("auth"));
  });

  it("expands resource routes and honours except()", () => {
    assert.ok(byName.get("admin.vaccines.index"));
    assert.equal(byName.get("admin.vaccines.edit")?.uri, "admin/vaccines/{vaccine}/edit");
    assert.equal(byName.has("admin.vaccines.show"), false);
    assert.deepEqual(byName.get("admin.vaccines.update")?.methods, ["PUT", "PATCH"]);
  });

  it("follows require __DIR__ includes and api prefix", () => {
    assert.ok(byName.get("login"));
    assert.equal(byName.get("api.slots")?.uri, "api/slots");
    assert.equal(byName.get("api.slots")?.routeFile, "api");
  });

  it("reads Route::view, Route::redirect, closures and invokable controllers", () => {
    assert.deepEqual(byName.get("about")?.action, { kind: "view", view: "about" });
    assert.equal(byName.get("home")?.action.kind, "closure");
    assert.deepEqual(routes.find((r) => r.uri === "home")?.action, { kind: "redirect", to: "/" });
    assert.equal((byName.get("api.payments.webhook")?.action as { method: string }).method, "__invoke");
  });

  it("records source lines and skips nothing in the fixture", () => {
    assert.equal(byName.get("booking.store")?.file, "routes/web.php");
    assert.ok((byName.get("booking.store")?.line ?? 0) > 0);
    assert.deepEqual(skipped, []);
  });
});

describe("full scan (static mode)", () => {
  let map: BuiltMap;
  before(async () => {
    map = (await scanProject(fixture, { mode: "static", output: "builtlore.test.json" })).map;
  });
  after(() => rmSync(join(fixture, "builtlore.test.json"), { force: true }));

  it("groups steps into features", () => {
    const ids = map.features.map((f) => f.id).sort();
    for (const f of ["auth", "booking", "payment", "admin.vaccines", "tickets"]) assert.ok(ids.includes(f), `feature ${f}`);
  });

  it("classifies entries", () => {
    const type = (id: string) => map.nodes.find((n) => n.id === `route:${id}`)?.type;
    assert.equal(type("booking.create"), "page");
    assert.equal(type("booking.store"), "action");
    assert.equal(type("api.slots"), "api");
  });

  it("finds the happy path: create -> store -> payment -> ticket", () => {
    assert.equal(edge(map, "booking.create", "booking.store")?.trigger, "submit");
    assert.equal(edge(map, "booking.store", "payment.show")?.outcome, "success");
    assert.equal(edge(map, "payment.show", "payment.pay")?.trigger, "submit");
    assert.equal(edge(map, "payment.pay", "tickets.show")?.trigger, "redirect");
  });

  it("finds failure branches", () => {
    const validation = edge(map, "booking.store", "booking.create");
    assert.equal(validation?.outcome, "error");
    assert.equal(validation?.label, "validation failed");
    assert.equal(edge(map, "payment.pay", "payment.failed")?.outcome, "error");
    assert.equal(edge(map, "booking.cancel", "booking.show")?.trigger, "back");
  });

  it("resolves spoofed methods and POST forms that use a GET route name", () => {
    assert.equal(edge(map, "booking.show", "booking.cancel")?.trigger, "submit"); // @method('DELETE')
    assert.ok(edge(map, "admin.vaccines.edit", "admin.vaccines.update")); // _method=PUT
    assert.ok(map.edges.find((e) => e.from === "route:login" && e.to === "route:POST /login"));
    assert.ok(map.edges.find((e) => e.from === "route:register" && e.to === "route:POST /register")); // literal action="/register"
  });

  it("does not attach layout navigation to every page", () => {
    assert.equal(map.edges.filter((e) => e.to === "route:logout").length, 0);
    assert.ok(map.notes.some((n) => n.includes("shared layouts")));
  });

  it("writes a self-contained canvas", () => {
    const html = readFileSync(join(fixture, ".builtlore", "map.html"), "utf8");
    assert.ok(html.includes('id="builtlore-data"'));
    const json = html.split('id="builtlore-data" type="application/json">')[1].split("</script>")[0];
    assert.equal(JSON.parse(json).nodes.length, map.nodes.length);
  });
});

describe("artisan mode", () => {
  const php = spawnSync("php", ["-v"]);
  const hasPhp = php.status === 0;
  let dir = "";

  before(() => {
    if (!hasPhp) return;
    dir = mkdtempSync(join(tmpdir(), "builtlore-artisan-"));
    cpSync(fixture, dir, { recursive: true });
    mkdirSync(join(dir, "vendor"), { recursive: true });
    writeFileSync(join(dir, "vendor", "autoload.php"), "<?php\n");
    // A stand-in for `php artisan route:list --json` using Laravel's output format.
    const routes = [
      { domain: null, method: "GET|HEAD", uri: "/", name: "home", action: "Closure", middleware: ["web"] },
      { domain: null, method: "GET|HEAD", uri: "about", name: "about", action: "Illuminate\\Routing\\ViewController", middleware: ["web"] },
      { domain: null, method: "GET|HEAD", uri: "booking/create", name: "booking.create", action: "App\\Http\\Controllers\\BookingController@create", middleware: ["web", "auth"] },
      { domain: null, method: "POST", uri: "booking", name: "booking.store", action: "App\\Http\\Controllers\\BookingController@store", middleware: ["web", "auth"] },
      { domain: null, method: "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS", uri: "home", name: null, action: "Illuminate\\Routing\\RedirectController", middleware: ["web"] },
      { domain: null, method: "GET|HEAD", uri: "up", name: null, action: "Illuminate\\Foundation\\Http\\HealthController", middleware: [] },
    ];
    writeFileSync(join(dir, "artisan"), `<?php\necho ${JSON.stringify(JSON.stringify(routes))};\n`);
  });
  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("uses the artisan route table and enriches it from static parsing", { skip: !hasPhp && "php not installed" }, async () => {
    const { map } = await scanProject(dir, { mode: "auto" });
    assert.ok(map.notes.some((n) => n.includes("artisan mode")), map.notes.join("\n"));
    assert.equal(map.nodes.length, 5, "framework routes like /up are dropped");
    const about = map.nodes.find((n) => n.id === "route:about");
    assert.equal(about?.view?.name, "about", "Route::view name comes from static parsing");
    assert.equal(map.nodes.find((n) => n.id === "route:booking.store")?.source.file, "routes/web.php");
    assert.equal(map.nodes.find((n) => n.uri === "home")?.type, "redirect");
    assert.ok(edge(map, "booking.create", "booking.store"));
  });
});

describe("helpers", () => {
  it("parses Blade link targets", () => {
    assert.deepEqual(parseTarget("{{ route('booking.show', $b) }}"), { kind: "name", name: "booking.show" });
    assert.deepEqual(parseTarget("{{ url('/about') }}"), { kind: "uri", uri: "/about" });
    assert.deepEqual(parseTarget("/register?x=1"), { kind: "uri", uri: "/register" });
    assert.equal(parseTarget("https://example.com"), null);
    assert.equal(parseTarget("#top"), null);
  });

  it("joins URIs and singularizes resource names", () => {
    assert.equal(joinUri("admin/", "/vaccines"), "admin/vaccines");
    assert.equal(joinUri("", "/"), "/");
    assert.equal(singular("categories"), "category");
    assert.equal(singular("vaccines"), "vaccine");
    assert.equal(singular("boxes"), "box");
  });
});
