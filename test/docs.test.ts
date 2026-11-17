import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { saveEdit } from "../src/core/edits.js";
import { scanProject } from "../src/core/scan.js";
import { serveProject } from "../src/core/serve.js";
import type { BuiltMap, DataTable, MapNode } from "../src/core/types.js";
import { renderDocs, writeDocs } from "../src/docs/index.js";
import { buildDocModel } from "../src/docs/model.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "..", "..", "fixtures", "laravel-workflow");

describe("documentation facts from the approval-workflow app", () => {
  let map: BuiltMap;
  const node = (id: string): MapNode => map.nodes.find((n) => n.id === `route:${id}`)!;
  const table = (name: string): DataTable => map.data!.tables.find((t) => t.name === name)!;
  const col = (t: string, c: string) => table(t).columns.find((x) => x.name === c);

  before(async () => {
    map = (await scanProject(fixture, { mode: "static", output: "builtlore.test.json" })).map;
  });
  after(() => rmSync(join(fixture, "builtlore.test.json"), { force: true }));

  describe("business rules (validation)", () => {
    it("reads rules() of a FormRequest, keeping each rule as written with a plain reading", () => {
      const v = node("menu.purchase-requests.store").validation!;
      assert.equal(v.length, 1);
      assert.equal(v[0].via, "form-request");
      assert.equal(v[0].class, "App\\Http\\Requests\\StorePurchaseRequestRequest");
      const field = (name: string) => v[0].fields.find((f) => f.field === name)!.rules;
      assert.deepEqual(field("title").map((r) => r.text), ["required", "text", "at most 150 characters"]);
      assert.equal(field("item_id")[1].text, "must exist in items.id");
      assert.equal(field("qty")[2].text, "at least 1", "min on an integer is a value, not a length");
      assert.equal(field("attachment").find((r) => r.rule === "max:2048")?.text, "at most 2048 KB", "max on a file is kilobytes");
      assert.deepEqual(field("priority")[1], { rule: "Rule::in(['low', 'normal', 'urgent'])", text: "one of: low, normal, urgent" });
    });

    it("reads inline $request->validate([...])", () => {
      const v = node("menu.leave-requests.store").validation!;
      assert.equal(v[0].via, "inline");
      assert.equal(v[0].source.file, "app/Http/Controllers/LeaveRequestController.php");
      const to = v[0].fields.find((f) => f.field === "to")!;
      assert.equal(to.rules.find((r) => r.rule === "after_or_equal:from")?.text, "on or after from");
    });

    it("does not take a model named *Request for a FormRequest", () => {
      // approveManager(PurchaseRequest $purchaseRequest): no validation, so no "validation failed" branch
      assert.equal(node("menu.purchase-requests.status.approve-manager").validation, undefined);
      assert.ok(!map.edges.some((e) => e.from === "route:menu.purchase-requests.status.approve-manager" && e.label === "validation failed"));
      assert.ok(!(node("menu.purchase-requests.status.hold-manager").inputs ?? []).includes("status"));
    });

    it("records the request fields a handler reads", () => {
      assert.deepEqual(node("menu.purchase-requests.status.reassign").inputs, ["pic_nik"]);
      assert.deepEqual(node("get_data.items").inputs, ["supplier_id"]);
    });
  });

  describe("data dictionary (migrations)", () => {
    it("reads every table created, with types, sizes, defaults and the model", () => {
      assert.deepEqual(map.data!.tables.map((t) => t.name), ["departments", "items", "leave_requests", "purchase_requests", "suppliers"]);
      assert.equal(table("purchase_requests").model, "PurchaseRequest");
      assert.equal(col("items", "price")?.type, "decimal");
      assert.equal(col("items", "price")?.size, "15, 2");
      assert.equal(col("purchase_requests", "status")?.default, "'WAITING_MANAGER'");
      assert.equal(col("departments", "code")?.unique, true);
      assert.equal(col("suppliers", "npwp")?.comment, "Tax ID");
      assert.deepEqual(col("leave_requests", "status")?.values, ["pending", "approved", "rejected"]);
      assert.equal(col("purchase_requests", "deleted_at")?.comment, "soft delete");
    });

    it("replays later migrations: added columns land after(), dropped ones disappear", () => {
      const t = table("purchase_requests");
      assert.deepEqual(t.migrations, ["2025_01_11_000001_create_purchase_requests_table", "2025_03_02_000001_add_approved_at_to_purchase_requests"]);
      const names = t.columns.map((c) => c.name);
      assert.equal(names.indexOf("approved_at"), names.indexOf("status") + 1);
      assert.ok(!names.includes("hold_reason"));
    });

    it("reads foreign keys: named, by Laravel convention, and on delete", () => {
      assert.deepEqual(col("purchase_requests", "item_id")?.references, { table: "items", column: "id", by: "explicit" });
      assert.deepEqual(col("items", "supplier_id")?.references, { table: "suppliers", column: "id", by: "convention" });
      assert.deepEqual(col("leave_requests", "user_id")?.references, { table: "users", column: "id", by: "convention", onDelete: "cascade" });
    });
  });

  describe("automation", () => {
    it("reads the scheduler in routes/console.php with plain-English frequencies", () => {
      const s = map.automation!.schedule;
      assert.deepEqual(
        s.map((t) => [t.runs.kind, t.runs.name, t.whenText]),
        [
          ["command", "purchase-requests:remind", "Weekdays at 08:00"],
          ["job", "App\\Jobs\\ExpireLeaveRequests", "Every hour"],
          ["command", "model:prune", "Every day at 00:00"],
        ],
      );
      assert.equal(s[0].when, "weekdays()->dailyAt('08:00')");
      assert.deepEqual(s[1].options, ["never runs twice at the same time"]);
    });

    it("reads console commands with their signature and description", () => {
      const c = map.automation!.commands.find((x) => x.name === "purchase-requests:remind")!;
      assert.equal(c.class, "App\\Console\\Commands\\RemindManagers");
      assert.equal(c.description, "Email managers about purchase requests waiting more than 2 days");
    });

    it("reads the statuses a job changes, and which records it touches", () => {
      const j = map.automation!.jobs.find((x) => x.class === "App\\Jobs\\ExpireLeaveRequests")!;
      assert.equal(j.queued, true);
      assert.equal(j.writes[0].subject, "LeaveRequest.status");
      assert.equal(j.writes[0].to.value, "rejected");
      assert.deepEqual(j.writes[0].when?.map((v) => v.value), ["pending"]);
      assert.deepEqual(j.dispatchedFrom, [{ file: "routes/console.php", line: 7 }]);
    });
  });

  describe("integrations", () => {
    const integration = (id: string) => map.integrations!.find((i) => i.id === id)!;

    it("finds HTTP APIs behind config() and env(), with the env key names", () => {
      const erp = integration("config:services.erp");
      assert.equal(erp.kind, "http");
      assert.deepEqual(erp.env, ["ERP_URL", "ERP_TOKEN"]);
      assert.equal(erp.usages[0].method, "POST");
      assert.equal(erp.usages[0].path, "/purchase-requests");
      assert.deepEqual(erp.usages[0].by, ["route:menu.purchase-requests.store"]);
      const portal = integration("env:EPORTAL_URL");
      assert.equal(portal.usages[0].path, "/api/validate/{nik}");
      assert.deepEqual(portal.usages[0].by, ["route:GET /logon/{nik}"]);
    });

    it("finds mail, notifications with their channels, and storage disks", () => {
      assert.deepEqual(integration("mail:App\\Mail\\WaitingApprovalReminder").usages[0].by, ["command:purchase-requests:remind"]);
      const n = integration("notification:App\\Notifications\\PurchaseRequestSubmitted");
      assert.deepEqual(n.channels, ["mail", "database"]);
      assert.deepEqual(n.usages[0].by, ["route:menu.purchase-requests.store"]);
      const s3 = integration("disk:s3");
      assert.equal(s3.usages[0].operation, "put");
      assert.deepEqual(s3.usages[0].by, ["route:menu.leave-requests.store"]);
    });
  });

  describe("configuration", () => {
    it("lists env keys by name, where they are read, and whether .env.example has them", () => {
      const key = (k: string) => map.config!.find((c) => c.key === k)!;
      assert.equal(key("ERP_URL").uses[0].config, "services.erp.url");
      assert.equal(key("ERP_URL").uses[0].hasDefault, true);
      assert.equal(key("ERP_TOKEN").uses[0].hasDefault, false);
      assert.equal(key("ERP_URL").inExample, true);
      assert.deepEqual(key("EPORTAL_URL").uses.map((u) => u.source.file), ["config/services.php", "app/Http/Controllers/LoginController.php"]);
      assert.equal(key("APP_KEY").uses.length, 0);
    });

    it("never records a value", () => {
      const json = JSON.stringify(map);
      assert.ok(!json.includes("erp.example.test"), "default value from config/services.php must not be copied");
    });
  });

  describe("roles × actions", () => {
    it("gives every action the same 'who' as the Process view", () => {
      assert.equal(node("menu.purchase-requests.status.approve").who?.name, "Procurement");
      assert.equal(node("menu.purchase-requests.status.approve-manager").who?.name, "Manager");
      assert.equal(node("master.departments.store").who?.name, "Admin");
      assert.equal(node("menu.leave-requests.reject").who?.name, "Signed-in user");
      assert.equal(node("menu.purchase-requests.index").who, undefined, "pages are not actions");
    });
  });

  describe("findings", () => {
    it("reports writes without validation, env() outside config and duplicate routes", () => {
      const f = buildDocModel(map).findings;
      const titled = (t: string) => f.find((x) => x.title === t);
      const unvalidated = titled("Writes without validation")!.items.map((i) => i.text);
      assert.ok(unvalidated.some((t) => t.includes("Reassign") && t.includes("pic_nik")));
      assert.ok(unvalidated.some((t) => t.includes("Update department")));
      assert.ok(!unvalidated.some((t) => t.includes("Save purchase request")), "FormRequest counts as validation");
      assert.deepEqual(titled("env() outside config")!.items[0].source, { file: "app/Http/Controllers/LoginController.php", line: 12 });
      assert.ok(titled("Duplicate routes"));
      assert.equal(titled("Not read by builtlore")!.items.length, map.skipped.filter((s) => !s.reason.startsWith("Redirect back from")).length);
    });
  });
});

describe("builtlore docs output", () => {
  let dir: string;
  let map: BuiltMap;
  const out = "docs/builtlore";
  const read = (f: string) => readFileSync(join(dir, out, f), "utf8");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "builtlore-docs-"));
    cpSync(fixture, dir, { recursive: true, filter: (src) => !src.includes(join("docs", "builtlore")) });
    saveEdit(dir, { target: "project", id: "project", fields: { name: "Procurement portal", summary: "Staff request items; managers and procurement approve them." } });
    saveEdit(dir, { target: "glossary", id: "PR", fields: { definition: "Purchase request" } });
    saveEdit(dir, { target: "feature", id: "menu.purchaserequest", fields: { description: "Request items to buy." } });
    saveEdit(dir, { target: "role", id: "atasan", fields: { name: "Direct supervisor" } });
    map = (await scanProject(dir, { mode: "static" })).map;
    await writeDocs(dir, map);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a Markdown folder and one HTML file", () => {
    for (const f of ["README.md", "roles.md", "business-rules.md", "data-dictionary.md", "integrations.md", "automation.md", "api.md", "configuration.md", "glossary.md", "findings.md", "index.html", "canvas.html", "features/menu-purchaserequest.md"]) {
      assert.ok(existsSync(join(dir, out, f)), f);
    }
  });

  it("opens with the summary and glossary written by people", () => {
    assert.ok(read("README.md").includes("# Procurement portal"));
    assert.ok(read("README.md").includes("Staff request items; managers and procurement approve them."));
    assert.ok(read("glossary.md").includes("| **PR** | Purchase request |"));
    assert.ok(read("features/menu-purchaserequest.md").includes("Request items to buy."));
    assert.ok(read("roles.md").includes("Direct supervisor"), "role names from edits apply to the matrix");
  });

  it("draws the status lifecycle with Mermaid, including changes made by jobs", () => {
    const pr = read("features/menu-purchaserequest.md");
    assert.ok(pr.includes("```mermaid\nstateDiagram-v2"));
    assert.ok(pr.includes("[*] --> s0 : Save purchase request (Signed-in user)"));
    assert.ok(pr.includes("s0 : Waiting for manager"));
    const leave = read("features/menu-leaverequest.md");
    assert.match(leave, /--> s\d : Job ExpireLeaveRequests \(every hour\)/);
    assert.ok(leave.includes('state "Any status (no check in code)" as any'), "a step with no status check starts from any status");
  });

  it("links facts to the file and line they come from", () => {
    assert.ok(read("business-rules.md").includes("(../../app/Http/Requests/StorePurchaseRequestRequest.php#L10)"));
    assert.ok(read("features/menu-purchaserequest.md").includes("(../../../app/Http/Controllers/PurchaseRequestController.php)"));
  });

  it("writes a self-contained, printable HTML file with SVG diagrams", () => {
    const html = read("index.html");
    assert.ok(html.includes('<meta name="generator" content="builtlore'));
    assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(html), "no external files");
    assert.ok(html.includes("@media print"));
    assert.equal((html.match(/<svg class="lifecycle"/g) ?? []).length, map.processes!.length);
    for (const id of ["overview", "roles", "features", "business-rules", "data", "integrations", "automation", "api", "configuration", "glossary", "findings"]) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
  });

  it("includes the canvas: embedded in the HTML, linked from the Markdown", () => {
    assert.ok(read("index.html").includes('<iframe class="canvas-frame" src="canvas.html"'));
    assert.ok(read("README.md").includes("[Open the canvas](canvas.html)"));
    assert.ok(read("canvas.html").includes('id="builtlore-data"'));
  });

  it("starts with the main processes and who uses the system, in plain words", () => {
    const readme = read("README.md");
    assert.ok(readme.includes("[Menu › Purchase request](features/menu-purchaserequest.md): **Waiting for manager** → **Approved by manager** → **Approved by procurement**"));
    assert.ok(readme.includes("[Manager](roles.md#role-manager): Approve manager, Hold manager"));
    assert.ok(readme.includes("**Understand the system**") && readme.includes("**Reference**") && readme.includes("**Health**"));
  });

  it("tells each process as numbered steps, then the other paths", () => {
    const pr = read("features/menu-purchaserequest.md");
    assert.ok(pr.includes("1. **Signed-in user**: Save purchase request → **Waiting for manager**"));
    assert.ok(pr.includes("2. **Manager**: Approve manager → **Approved by manager**"));
    assert.ok(pr.includes("3. **Procurement**: Approve → **Approved by procurement**"));
    assert.ok(pr.includes("- **Manager**: Hold manager when **Waiting for manager** → **On hold**"));
    assert.ok(read("features/menu-leaverequest.md").includes("- **Automatic**: Job ExpireLeaveRequests, every hour when **Pending** → **Rejected**"));
  });

  it("folds developer details away and lists each role's actions", () => {
    assert.ok(read("features/menu-purchaserequest.md").includes("<summary>For developers: routes, screens, files</summary>"));
    assert.ok(read("roles.md").includes("- **Menu › Purchase request**: Approve manager, Hold manager"));
    const html = read("index.html");
    assert.ok(html.includes('<input id="q" type="search"'), "search box");
    assert.ok(html.includes('addEventListener("beforeprint"'), "folded sections open when printing");
  });

  it("lists the scan notes under Findings", () => {
    assert.ok(read("findings.md").includes("## Scan notes"));
    assert.ok(read("findings.md").includes("static mode, no PHP needed"));
  });

  it("shows env key names but no values", async () => {
    writeFileSync(join(dir, ".env"), "ERP_TOKEN=super-secret-token\n");
    const fresh = (await scanProject(dir, { mode: "static" })).map;
    const docs = await renderDocs(fresh);
    const all = [...docs.markdown.values(), docs.html].join("\n");
    assert.ok(all.includes("ERP_TOKEN"));
    assert.ok(!all.includes("super-secret-token"));
    assert.ok(!all.includes("erp.example.test"));
  });

  it("replaces only its own files and removes pages of features that are gone", async () => {
    writeFileSync(join(dir, out, "features", "old-feature.md"), "<!-- Generated by builtlore 0.0.1 -->\n# Old\n");
    writeFileSync(join(dir, out, "notes.md"), "# My own notes\n");
    const res = await writeDocs(dir, map);
    assert.deepEqual(res.removed, [`${out}/features/old-feature.md`]);
    assert.ok(existsSync(join(dir, out, "notes.md")), "files builtlore did not write are kept");
  });

  it("refuses to overwrite a file it did not write", async () => {
    const other = join(dir, "handwritten");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "README.md"), "# Our handbook\n");
    await assert.rejects(() => writeDocs(dir, map, "handwritten"), /not written by builtlore/);
    assert.equal(readFileSync(join(other, "README.md"), "utf8"), "# Our handbook\n");
    assert.deepEqual(readdirSync(other), ["README.md"]);
  });

  it("serves the current docs from builtlore serve", async () => {
    const h = await serveProject(dir, { mode: "static", port: 0 });
    try {
      const res = await fetch(new URL("/docs", h.url));
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes("Procurement portal"));
      assert.ok(html.includes('<iframe class="canvas-frame" src="/"'), "in serve the docs embed the live canvas");
    } finally {
      h.server.close();
    }
  });
});
