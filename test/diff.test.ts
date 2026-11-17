/**
 * builtlore diff: two versions of a tiny Laravel app, the first committed in git,
 * the second in the working folder.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { diffMaps, diffMarkdown, loadSide, type DiffSection } from "../src/core/diff.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

const routes = (approveMw: string, extra = "") => `<?php
use App\\Http\\Controllers\\OrderController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/orders', [OrderController::class, 'store'])->name('orders.store');
Route::post('/orders/{order}/approve', [OrderController::class, 'approve'])->name('orders.approve')->middleware('${approveMw}');
Route::post('/orders/{order}/ship', [OrderController::class, 'ship'])->name('orders.ship');
${extra}`;

const controller = (v2: boolean) => `<?php
namespace App\\Http\\Controllers;
use App\\Mail\\OrderApproved;
use App\\Models\\Order;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Mail;
class OrderController extends Controller {
    public function store(Request $request) {
        $request->validate(['title' => 'required|max:${v2 ? 150 : 100}'${v2 ? ", 'note' => 'nullable'" : ""}]);
        Order::create(['title' => $request->title, 'status' => 'new']);
        return back();
    }
    public function approve(Order $order) {
        if ($order->status != 'new') abort(403);
        $order->status = 'approved';
        $order->save();
        ${v2 ? "" : "Mail::to('x@example.test')->send(new OrderApproved);"}
        return back();
    }
    public function ship(Order $order) {
        $order->status = '${v2 ? "shipped" : "sent"}';
        $order->save();
        return back();
    }
    public function cancel(Order $order) { $order->status = 'cancelled'; $order->save(); return back(); }
}
`;

const migration = (v2: boolean) => `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->string('status');
            ${v2 ? "$table->text('note')->nullable();" : ""}
        });
    }
};
`;

describe("builtlore diff", { skip: !hasGit && "git is not installed" }, () => {
  let dir: string;
  let sections: DiffSection[];
  const items = (id: string) => sections.find((s) => s.id === id)?.items.map((i) => `${i.change}: ${i.text}`) ?? [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "builtlore-diff-test-"));
    write(dir, {
      artisan: "<?php\n",
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" }, autoload: { "psr-4": { "App\\": "app/" } } }),
      "app/Models/Order.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model {}\n",
      "app/Mail/OrderApproved.php": "<?php\nnamespace App\\Mail;\nclass OrderApproved {}\n",
      "routes/web.php": routes("role:manager"),
      "app/Http/Controllers/OrderController.php": controller(false),
      "database/migrations/2024_01_01_000000_create_orders.php": migration(false),
      "config/services.php": "<?php\nreturn ['erp' => ['url' => env('ERP_URL')]];\n",
    });
    const g = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("add", ".");
    g("commit", "-q", "-m", "v1");
    write(dir, {
      "routes/web.php": routes("role:director", "Route::post('/orders/{order}/cancel', [OrderController::class, 'cancel'])->name('orders.cancel');\n"),
      "app/Http/Controllers/OrderController.php": controller(true),
      "database/migrations/2024_01_01_000000_create_orders.php": migration(true),
      "config/services.php": "<?php\nreturn ['erp' => ['url' => env('ERP_URL'), 'token' => env('ERP_TOKEN')]];\n",
    });
    const base = await loadSide(dir, "HEAD");
    const head = await loadSide(dir, undefined);
    sections = diffMaps(base.map, head.map);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lists new steps", () => {
    assert.ok(items("steps").some((t) => /^added: New step .*orders\/\{order\}\/cancel/.test(t)), items("steps").join("\n"));
  });

  it("says who can do a step now", () => {
    assert.ok(items("who").some((t) => /Manager → Director/i.test(t)), items("who").join("\n"));
  });

  it("describes status changes in words", () => {
    const s = items("status");
    assert.ok(s.some((t) => /new status "Shipped"/i.test(t)), s.join("\n"));
    assert.ok(s.some((t) => /can now end at "Shipped"/i.test(t)), s.join("\n"));
    assert.ok(s.some((t) => /no longer ends at "Sent"/i.test(t)), s.join("\n"));
  });

  it("shows changed validation rules", () => {
    const r = items("rules");
    assert.ok(r.some((t) => /title: .*100.* → .*150/.test(t)), r.join("\n"));
    assert.ok(r.some((t) => /new field note/.test(t)), r.join("\n"));
  });

  it("shows mail that is no longer sent, new columns and new environment keys", () => {
    assert.ok(items("integrations").some((t) => /OrderApproved/.test(t)), items("integrations").join("\n"));
    assert.ok(items("data").some((t) => /orders: new column note/.test(t)), items("data").join("\n"));
    assert.ok(items("config").some((t) => /ERP_TOKEN/.test(t)), items("config").join("\n"));
  });

  it("writes a Markdown report for a pull request", () => {
    const md = diffMarkdown(sections, "main", "branch");
    assert.match(md, /^## What changed in the app/);
    assert.match(md, /### Status flow/);
    assert.match(md, /- \*\*Added:\*\*/);
  });

  it("check fails on changes, and on new open writes only (not the ones already there)", async () => {
    const { runCheck } = await import("../src/core/check.js");
    const base = await loadSide(dir, "HEAD");
    const head = await loadSide(dir, undefined);
    const r = runCheck(base.map, head.map, ["changes", "open"]);
    assert.ok(r.failed.includes("changes"));
    const open = r.added.find((a) => a.rule === "open")!;
    assert.ok(open.items.some((i) => /cancel/.test(i)), open.items.join("\n"));
    assert.ok(!open.items.some((i) => /\/orders\b(?!\/)/.test(i) && /POST/.test(i) && !/cancel/.test(i)), "the store route was already open in the base");
    const same = runCheck(head.map, head.map, ["changes", "open", "page-only", "unvalidated"]);
    assert.deepEqual(same.failed, []);
  });

  it("leaves no worktree behind", () => {
    const list = spawnSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n");
    assert.equal(list.length, 1, list.join("\n"));
  });
});
