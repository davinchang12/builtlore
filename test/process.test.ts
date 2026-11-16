import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyEdits, loadEdits, saveEdit } from "../src/core/edits.js";
import { scanProject } from "../src/core/scan.js";
import type { BuiltMap, Process } from "../src/core/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "..", "..", "fixtures", "laravel-workflow");

describe("process view (actors and status)", () => {
  let dir: string;
  let raw: BuiltMap;
  let map: BuiltMap;
  const proc = (subject: string): Process => map.processes!.find((p) => p.subject === subject)!;
  const step = (p: Process, route: string) => p.steps.find((s) => s.node === `route:${route}`)!;
  const label = (p: Process, id: string | undefined) => p.states.find((s) => s.id === id)?.label;
  const lane = (p: Process, route: string) => p.lanes.find((l) => l.id === step(p, route).lane)!.name;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "builtlore-process-"));
    cpSync(fixture, dir, { recursive: true });
    const r = await scanProject(dir, { mode: "static" });
    raw = r.raw;
    map = r.map;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("finds one process per status column that the feature changes", () => {
    assert.deepEqual(map.processes!.map((p) => p.subject).sort(), ["LeaveRequest.status", "PurchaseRequest.status"]);
  });

  it("reads status values written as literals, numbers, constants and enums, with labels from the model", () => {
    const pr = proc("PurchaseRequest.status");
    assert.equal(label(pr, step(pr, "menu.purchase-requests.store").to[0]), "Waiting for manager"); // constant
    assert.equal(label(pr, step(pr, "menu.purchase-requests.status.approve-manager").to[0]), "Approved by manager"); // literal
    assert.equal(label(pr, step(pr, "menu.purchase-requests.status.approve").to[0]), "Approved by procurement"); // number 3
    const lr = proc("LeaveRequest.status");
    assert.equal(label(lr, step(lr, "menu.leave-requests.approve").to[0]), "Approved"); // enum case
  });

  it("uses the model default as the starting status when a step creates the record", () => {
    const lr = proc("LeaveRequest.status");
    assert.ok(step(lr, "menu.leave-requests.store").creates);
    assert.equal(label(lr, lr.initial), "Pending");
    assert.equal(label(lr, step(lr, "menu.leave-requests.store").to[0]), "Pending");
  });

  it("knows which status a step needs: guards in code, conditions in the view, and the page it is submitted from", () => {
    const pr = proc("PurchaseRequest.status");
    const hold = step(pr, "menu.purchase-requests.status.hold-manager");
    assert.equal(hold.fromVia, "guard");
    assert.deepEqual(hold.from.map((f) => label(pr, f)), ["Waiting for manager"]);
    const approveManager = step(pr, "menu.purchase-requests.status.approve-manager");
    assert.equal(approveManager.fromVia, "view");
    const update = step(pr, "menu.purchase-requests.update");
    assert.equal(update.fromVia, "page"); // Edit page is only linked when on hold
    assert.deepEqual(update.from.map((f) => label(pr, f)), ["On hold"]);
  });

  it("finds who does each step from code, views, middleware and names", () => {
    const pr = proc("PurchaseRequest.status");
    assert.equal(lane(pr, "menu.purchase-requests.status.approve-manager"), "Manager"); // nik == manager_nik
    assert.equal(lane(pr, "menu.purchase-requests.status.approve"), "Procurement"); // role:procurement
    assert.equal(lane(pr, "menu.purchase-requests.status.reassign"), "Admin"); // @role('admin')
    assert.equal(lane(pr, "menu.purchase-requests.store"), "Signed-in user"); // auth only, never guessed
    const lr = proc("LeaveRequest.status");
    assert.equal(lane(lr, "menu.leave-requests.approve"), "Atasan"); // Auth::user()->jabatan == 'Atasan'
  });

  it("renames roles and statuses and reassigns steps through builtlore.edits.yaml", () => {
    saveEdit(dir, { target: "role", id: "atasan", fields: { name: "Direct supervisor" } }, raw);
    saveEdit(dir, { target: "status", id: "PurchaseRequest.status", fields: { value: "3", label: "Ready to order" } }, raw);
    // First edit of a step with an empty description must not fail
    saveEdit(dir, { target: "step", id: "route:menu.purchase-requests.store", fields: { description: "", actor: "Requester", hidden: false } }, raw);
    const edited = applyEdits(raw, loadEdits(dir));
    const pr = edited.processes!.find((p) => p.subject === "PurchaseRequest.status")!;
    const lr = edited.processes!.find((p) => p.subject === "LeaveRequest.status")!;
    assert.equal(lr.lanes.find((l) => l.id === "atasan")?.name, "Direct supervisor");
    assert.equal(pr.states.find((s) => s.value === "3")?.label, "Ready to order");
    const store = pr.steps.find((s) => s.node === "route:menu.purchase-requests.store")!;
    assert.equal(pr.lanes.find((l) => l.id === store.lane)?.name, "Requester");
    assert.equal(loadEdits(dir).statuses["PurchaseRequest.status"]["3"], "Ready to order");
  });
});
