import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyEdits, EDITS_FILE, loadEdits, saveEdit } from "../src/core/edits.js";
import { scanProject } from "../src/core/scan.js";
import { serveProject } from "../src/core/serve.js";
import type { BuiltMap } from "../src/core/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "..", "..", "fixtures", "laravel-clinic");

describe("human edits (builtlore.edits.yaml)", () => {
  let dir: string;
  let raw: BuiltMap;
  const edited = () => applyEdits(raw, loadEdits(dir));
  const node = (m: BuiltMap, id: string) => m.nodes.find((n) => n.id === `route:${id}`)!;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "builtlore-edits-"));
    cpSync(fixture, dir, { recursive: true });
    raw = (await scanProject(dir, { mode: "static" })).raw;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("renames and describes steps and features, and survives a rescan", async () => {
    saveEdit(dir, { target: "step", id: "route:booking.index", fields: { label: "My bookings", description: "Upcoming visits." } }, raw);
    saveEdit(dir, { target: "feature", id: "booking", fields: { name: "Booking a visit", description: "How patients book." } }, raw);
    const rescanned = (await scanProject(dir, { mode: "static" })).map;
    const n = node(rescanned, "booking.index");
    assert.equal(n.label, "My bookings");
    assert.equal(n.description, "Upcoming visits.");
    assert.equal(n.provenance, "human");
    const f = rescanned.features.find((x) => x.id === "booking")!;
    assert.equal(f.name, "Booking a visit");
    assert.equal(f.description, "How patients book.");
    assert.ok(JSON.parse(readFileSync(join(dir, "builtlore.json"), "utf8")).nodes.some((x: { label: string }) => x.label === "My bookings"));
  });

  it("keeps comments and hand-written parts of the file", () => {
    const path = join(dir, EDITS_FILE);
    writeFileSync(path, readFileSync(path, "utf8") + "# reviewed with the clinic team\n");
    saveEdit(dir, { target: "glossary", id: "Slot", fields: { definition: "A bookable 15-minute window." } }, raw);
    const text = readFileSync(path, "utf8");
    assert.match(text, /reviewed with the clinic team/);
    assert.match(text, /Slot: A bookable 15-minute window\./);
    assert.deepEqual(edited().glossary, { Slot: "A bookable 15-minute window." });
  });

  it("moves a step into an existing feature (by renamed name) or a new one", () => {
    saveEdit(dir, { target: "step", id: "route:payment.failed", fields: { feature: "Booking a visit" } }, raw);
    let m = edited();
    assert.equal(node(m, "payment.failed").feature, "booking");
    assert.equal(m.features.filter((f) => f.name === "Booking a visit").length, 1);

    saveEdit(dir, { target: "step", id: "route:payment.failed", fields: { feature: "Problems" } }, raw);
    m = edited();
    assert.equal(node(m, "payment.failed").feature, "custom:problems");
    assert.equal(m.features.find((f) => f.id === "custom:problems")?.name, "Problems");
  });

  it("hides a step without removing it from the model", () => {
    saveEdit(dir, { target: "step", id: "route:about", fields: { hidden: true } }, raw);
    assert.equal(node(edited(), "about").hidden, true);
    saveEdit(dir, { target: "step", id: "route:about", fields: { hidden: false } }, raw);
    assert.equal(node(edited(), "about").hidden, undefined);
    assert.ok(!(loadEdits(dir).steps["route:about"]), "empty entries are removed");
  });

  it("flags described steps whose code changed, and keeps edits for removed steps", () => {
    const changed: BuiltMap = JSON.parse(JSON.stringify(raw));
    node(changed, "booking.index").uri = "my/bookings";
    changed.nodes = changed.nodes.filter((n) => n.id !== "route:payment.failed");
    const m = applyEdits(changed, loadEdits(dir));
    assert.match(node(m, "booking.index").review ?? "", /changed/);
    assert.ok(m.notes.some((n) => n.startsWith("Needs review: 1")), m.notes.join("\n"));
    assert.ok(m.notes.some((n) => n.includes("route:payment.failed")), m.notes.join("\n"));
    assert.ok(loadEdits(dir).steps["route:payment.failed"], "orphaned edit is kept");
  });

  it("serve saves edits only with the session token", async () => {
    const h = await serveProject(dir, { mode: "static", port: 0 });
    try {
      const page = await (await fetch(h.url)).text();
      const token = /BUILTLORE_EDIT = \{"token":"([0-9a-f]+)"\}/.exec(page)?.[1];
      assert.ok(token, "page carries the edit token");
      const patch = { target: "step", id: "route:home", fields: { description: "Landing page." } };
      const denied = await fetch(h.url + "api/edit", { method: "POST", body: JSON.stringify(patch) });
      assert.equal(denied.status, 403);
      const ok = await fetch(h.url + "api/edit", {
        method: "POST",
        headers: { "X-Builtlore-Token": token!, "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      assert.equal(ok.status, 200);
      assert.equal(loadEdits(dir).steps["route:home"]?.description, "Landing page.");
      assert.ok(existsSync(join(dir, ".builtlore", "map.html")));
    } finally {
      h.server.close();
    }
  });
});
