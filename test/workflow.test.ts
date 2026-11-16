import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scanProject } from "../src/core/scan.js";
import type { BuiltMap } from "../src/core/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "..", "..", "fixtures", "laravel-workflow");

describe("internal approval-workflow app", () => {
  let map: BuiltMap;
  const node = (id: string) => map.nodes.find((n) => n.id === `route:${id}`);
  const edge = (from: string, to: string) => map.edges.find((e) => e.from === `route:${from}` && e.to === `route:${to}`);

  before(async () => {
    map = (await scanProject(fixture, { mode: "static", output: "builtlore.test.json" })).map;
  });
  after(() => rmSync(join(fixture, "builtlore.test.json"), { force: true }));

  it("warns about duplicate routes and keeps only one", () => {
    assert.ok(map.notes.some((n) => n.startsWith("Warning: duplicate route GET /logon/{nik}")), map.notes.join("\n"));
    assert.equal(map.nodes.filter((n) => n.uri === "logon/{nik}").length, 1);
  });

  it("splits big area prefixes (menu.*, master.*) into features by controller domain", () => {
    const ids = map.features.map((f) => f.id);
    for (const f of ["menu.purchaserequest", "menu.leaverequest", "master.department", "master.supplier", "master.item"]) {
      assert.ok(ids.includes(f), `feature ${f} in ${ids.join(", ")}`);
    }
    assert.ok(!ids.includes("menu"), "no catch-all menu feature");
    assert.ok(ids.includes("report"), "small groups are not split");
  });

  it("puts status controllers in the same feature as their resource", () => {
    assert.equal(node("menu.purchase-requests.status.approve-manager")?.feature, "menu.purchaserequest");
    assert.equal(node("menu.purchase-requests.store")?.feature, "menu.purchaserequest");
    assert.equal(node("menu.leave-requests.reject")?.feature, "menu.leaverequest");
  });

  it("gives status actions short labels", () => {
    assert.equal(node("menu.purchase-requests.status.approve-manager")?.label, "Approve manager");
    assert.equal(node("menu.leave-requests.approve")?.label, "Approve");
    assert.equal(map.features.find((f) => f.id === "menu.purchaserequest")?.name, "Menu › Purchase request");
  });

  it("classifies JSON reads as data endpoints and exports as downloads", () => {
    assert.equal(node("get_data.suppliers")?.type, "data");
    assert.equal(node("get_data.items")?.type, "data");
    assert.equal(node("report.purchase-requests.export")?.type, "download");
    assert.equal(node("master.departments.update")?.type, "action", "a JSON write stays an action");
    assert.equal(node("menu.purchase-requests.index")?.type, "page", "DataTables + view is still a page");
  });

  it("connects pages to the endpoints their scripts call", () => {
    assert.equal(edge("menu.purchase-requests.create", "get_data.suppliers")?.trigger, "ajax"); // from an @include'd partial
    assert.equal(edge("menu.purchase-requests.create", "get_data.items")?.trigger, "ajax"); // url('/get_data/items')
    assert.equal(edge("master.departments.index", "master.departments.update")?.trigger, "ajax");
  });

  it("finds links built in JavaScript and data-* attributes", () => {
    assert.equal(edge("menu.purchase-requests.index", "menu.purchase-requests.show")?.trigger, "link");
    assert.equal(edge("menu.leave-requests.index", "menu.leave-requests.show")?.trigger, "link");
  });

  it("resolves URLs written by hand in scripts, using the HTTP method nearby", () => {
    assert.equal(edge("menu.leave-requests.show", "menu.leave-requests.reject")?.trigger, "ajax");
  });

  it("treats /api/... routes in web.php that return JSON as data endpoints", () => {
    assert.equal(node("master.departments.lookup")?.type, "data");
    assert.equal(edge("master.departments.index", "master.departments.lookup")?.trigger, "ajax");
  });

  it("says plainly that static mode needs no PHP", () => {
    assert.ok(map.notes.some((n) => n.includes("static mode, no PHP needed")), map.notes.join("\n"));
  });

  it("ignores links inside Blade comments", () => {
    assert.equal(edge("menu.purchase-requests.show", "report.purchase-requests"), undefined);
  });

  it("follows the approval steps from the detail page", () => {
    assert.equal(edge("menu.purchase-requests.show", "menu.purchase-requests.status.approve-manager")?.trigger, "submit");
    const back = (from: string, outcome: string) =>
      map.edges.find((e) => e.from === `route:${from}` && e.to === "route:menu.purchase-requests.show" && e.outcome === outcome);
    assert.ok(back("menu.purchase-requests.status.approve", "error"), "guard: back with error");
    assert.equal(back("menu.purchase-requests.status.hold-manager", "error")?.label, "validation failed");
    assert.ok(back("menu.purchase-requests.status.hold-manager", "success"), "success: back to the detail page");
  });
});
