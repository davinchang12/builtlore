/**
 * Patterns for the documentation layer that the fixtures do not cover, each in
 * a tiny generated Laravel project.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { applyEdits, loadEdits, saveEdit } from "../src/core/edits.js";
import { scanProject } from "../src/core/scan.js";
import type { BuiltMap } from "../src/core/types.js";

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "builtlore-patterns-"));
  dirs.push(dir);
  const all: Record<string, string> = {
    artisan: "<?php\n",
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" }, autoload: { "psr-4": { "App\\": "app/" } } }),
    "routes/web.php": "<?php\n",
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

async function scan(files: Record<string, string>): Promise<BuiltMap> {
  return (await scanProject(project(files), { mode: "static" })).map;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const migration = (body: string) => `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Schema;
return new class extends Migration {
    public function up(): void
    {
${body}
    }
    public function down(): void
    {
        Schema::dropIfExists('orders');
    }
};
`;

describe("migrations", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "app/Models/Customer.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Customer extends Model { protected $table = 'clients'; }\n",
      "database/migrations/2024_01_01_000000_create_orders.php": migration(`
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->string('code', 20);
            $table->unsignedBigInteger('warehouse_id');
            $table->foreign('warehouse_id')->references('id')->on('warehouses')->nullOnDelete();
            $table->foreignIdFor(\\App\\Models\\Customer::class)->constrained();
            $table->morphs('owner');
            $table->comment('Customer orders');
        });
        Schema::create('drafts', function (Blueprint $table) { $table->id(); });
        Schema::table('users', function (Blueprint $table) {
            $table->string('nik', 20)->nullable()->after('id');
        });`),
      "database/migrations/2024_02_01_000000_change_orders.php": migration(`
        Schema::table('orders', function (Blueprint $table) {
            $table->renameColumn('code', 'order_no');
            $table->string('order_no', 40)->change();
            $table->dropForeign(['warehouse_id']);
            $table->point('location');
        });
        Schema::rename('orders', 'sales_orders');
        Schema::dropIfExists('drafts');
        DB::statement('ALTER TABLE sales_orders ADD CHECK (1 = 1)');
        $name = 'dynamic';
        Schema::create($name, function (Blueprint $table) { $table->id(); });`),
    });
  });

  const table = (n: string) => map.data!.tables.find((t) => t.name === n);
  const col = (t: string, c: string) => table(t)?.columns.find((x) => x.name === c);

  it("reads only up(), replays renames and drops, and keeps the table comment", () => {
    assert.deepEqual(map.data!.tables.map((t) => t.name), ["sales_orders", "users"]);
    assert.equal(table("sales_orders")!.comment, "Customer orders");
    assert.equal(table("sales_orders")!.migrations.length, 2);
  });

  it("follows renamed and changed columns", () => {
    assert.equal(col("sales_orders", "code"), undefined);
    assert.equal(col("sales_orders", "order_no")?.size, "40");
    assert.equal(col("sales_orders", "location")?.type, "point", "unknown column types are kept as written");
  });

  it("reads foreign keys from foreign()->references()->on(), foreignIdFor and dropForeign", () => {
    assert.equal(col("sales_orders", "warehouse_id")?.references, undefined, "dropped later");
    assert.deepEqual(col("sales_orders", "customer_id")?.references, { table: "clients", column: "id", by: "convention" });
  });

  it("expands morphs and marks tables created elsewhere as partial", () => {
    assert.ok(col("sales_orders", "owner_type") && col("sales_orders", "owner_id"));
    assert.equal(table("users")!.partial, true);
    assert.equal(col("users", "nik")?.nullable, true);
  });

  it("reports raw SQL and table names it cannot read", () => {
    assert.ok(map.skipped.some((s) => s.reason.startsWith("Raw SQL in a migration is not read")));
    assert.ok(map.skipped.some((s) => s.reason.startsWith("Table name not readable in migration")));
  });
});

describe("validation patterns", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\FormController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/a', [FormController::class, 'a'])->name('a');
Route::post('/b', [FormController::class, 'b'])->name('b');
Route::post('/c', [FormController::class, 'c'])->name('c');
Route::post('/d', [FormController::class, 'd'])->name('d');
Route::post('/e', [FormController::class, 'e'])->name('e');
`,
      "app/Http/Requests/BaseRequest.php": "<?php\nnamespace App\\Http\\Requests;\nuse Illuminate\\Foundation\\Http\\FormRequest;\nabstract class BaseRequest extends FormRequest {}\n",
      "app/Http/Requests/ERequest.php": `<?php
namespace App\\Http\\Requests;
class ERequest extends BaseRequest {
    public function rules(): array
    {
        $rules = ['email' => 'required|email|unique:users,email'];
        return $rules;
    }
}
`,
      "app/Http/Controllers/FormController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Http\\Requests\\ERequest;
use App\\Rules\\Uppercase;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Validator;
class FormController extends Controller {
    public function a(Request $request) {
        Validator::make($request->all(), ['code' => ['required', new Uppercase, function ($attr, $value, $fail) {}]])->validate();
        return back();
    }
    public function b(Request $request) {
        $this->validate($request, ['note' => 'required_if:type,other|nullable']);
        return back();
    }
    public function c(Request $request) {
        $request->validate($this->rulesFor($request->type));
        return back();
    }
    public function d(Request $request) {
        $request->validate(['qty' => 'required|numeric|between:1,10', 'tags' => 'array|max:3']);
        return back();
    }
    public function e(ERequest $request) {
        return back();
    }
}
`,
    });
  });
  const rules = (id: string) => map.nodes.find((n) => n.id === `route:${id}`)!.validation;

  it("reads Validator::make with rule objects and closures", () => {
    const code = rules("a")![0].fields[0];
    assert.equal(code.field, "code");
    assert.deepEqual(code.rules.map((r) => r.text), ["required", "custom rule Uppercase", "custom check written in code"]);
  });

  it("reads $this->validate() and conditional rules", () => {
    assert.equal(rules("b")![0].fields[0].rules[0].text, "required when type is other");
  });

  it("reports rules built at runtime instead of guessing", () => {
    assert.equal(rules("c"), undefined);
    assert.ok(map.skipped.some((s) => s.reason.startsWith("Validation rules not readable (built at runtime)")));
  });

  it("reads sizes by field type: numbers, lists", () => {
    const [qty, tags] = rules("d")![0].fields;
    assert.equal(qty.rules[2].text, "between 1 and 10");
    assert.equal(tags.rules[1].text, "at most 3 items");
  });

  it("follows FormRequest subclasses and rules returned from a variable", () => {
    const v = rules("e")![0];
    assert.equal(v.via, "form-request");
    assert.equal(v.fields[0].rules[2].text, "must not already exist in users.email");
  });
});

describe("scheduler, commands and jobs (Kernel, Artisan::command)", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "app/Console/Kernel.php": `<?php
namespace App\\Console;
use App\\Console\\Commands\\SyncStock;
use App\\Jobs\\CloseDay;
use Illuminate\\Console\\Scheduling\\Schedule;
use Illuminate\\Foundation\\Console\\Kernel as ConsoleKernel;
class Kernel extends ConsoleKernel {
    protected function schedule(Schedule $schedule): void
    {
        $schedule->command(SyncStock::class)->everyFiveMinutes()->between('8:00', '17:00')->onOneServer();
        $schedule->job(new CloseDay)->weeklyOn(1, '8:00');
        $schedule->call(function () {})->cron('0 3 * * *')->description('Clean temp files');
        $schedule->exec('backup.sh')->daily()->someFutureMethod();
    }
}
`,
      "app/Console/Commands/SyncStock.php": `<?php
namespace App\\Console\\Commands;
use Illuminate\\Console\\Command;
class SyncStock extends Command {
    protected $signature = 'stock:sync {--force}';
    public function handle(): void {}
}
`,
      "app/Jobs/CloseDay.php": "<?php\nnamespace App\\Jobs;\nclass CloseDay { public function handle(): void {} }\n",
      "routes/console.php": `<?php
use Illuminate\\Support\\Facades\\Artisan;
Artisan::command('report:send', function () {})->purpose('Send the daily report');
`,
      "routes/web.php": `<?php
use App\\Jobs\\CloseDay;
use Illuminate\\Support\\Facades\\Route;
Route::post('/close', function () { CloseDay::dispatch(); return back(); })->name('close');
`,
    });
  });

  it("reads $schedule->… in the console kernel", () => {
    const s = map.automation!.schedule;
    assert.deepEqual(s[0].runs, { kind: "command", name: "stock:sync" }, "X::class resolves to the signature");
    assert.equal(s[0].whenText, "Every 5 minutes, only between 8:00 and 17:00");
    assert.deepEqual(s[0].options, ["runs on one server only"]);
    assert.equal(s[1].whenText, "Every Monday at 08:00");
    assert.equal(s[2].runs.kind, "closure");
    assert.equal(s[2].whenText, 'Cron "0 3 * * *"');
    assert.equal(s[2].description, "Clean temp files");
  });

  it("keeps an unknown frequency as written, without a plain reading", () => {
    const backup = map.automation!.schedule[3];
    assert.equal(backup.runs.name, "backup.sh");
    assert.equal(backup.whenText, undefined);
    assert.equal(backup.when, "daily()->someFutureMethod()");
  });

  it("reads Artisan::command closures and job dispatches", () => {
    const names = map.automation!.commands.map((c) => c.name);
    assert.deepEqual(names, ["report:send", "stock:sync"]);
    assert.equal(map.automation!.commands[0].description, "Send the daily report");
    const job = map.automation!.jobs[0];
    assert.equal(job.queued, false);
    assert.deepEqual(job.dispatchedFrom.map((d) => d.file).sort(), ["app/Console/Kernel.php", "routes/web.php"]);
  });
});

describe("integration and configuration patterns", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      ".env": "SHOP_SECRET=do-not-read-me\n",
      ".env.example": "SHOP_URL=\n# comment\nexport OTHER_KEY=1\n",
      "config/filesystems.php": "<?php\nreturn ['disks' => ['s3' => ['key' => env('AWS_ACCESS_KEY_ID'), 'bucket' => env('AWS_BUCKET')]]];\n",
      "routes/web.php": `<?php
use App\\Http\\Controllers\\ShopController;
use App\\Notifications\\Shipped;
use Illuminate\\Support\\Facades\\Http;
use Illuminate\\Support\\Facades\\Notification;
use Illuminate\\Support\\Facades\\Route;
Route::post('/ship', function () {
    Http::baseUrl('https://api.shipping.example')->post('/v2/labels', []);
    Notification::send([], new Shipped);
    return back();
})->name('ship');
Route::post('/upload', [ShopController::class, 'upload'])->name('upload');
`,
      "app/Notifications/Shipped.php": `<?php
namespace App\\Notifications;
class Shipped { public function via($n): array { return $this->channels; } }
`,
      "app/Mail/OrderPlaced.php": "<?php\nnamespace App\\Mail;\nclass OrderPlaced {}\n",
      "app/Http/Controllers/ShopController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Mail\\OrderPlaced;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Http;
use Illuminate\\Support\\Facades\\Mail;
use Illuminate\\Support\\Facades\\Storage;
class ShopController extends Controller {
    public function upload(Request $request) {
        $request->file('photo')->store('photos', 's3');
        Storage::put('log.txt', 'x');
        Mail::to('a@example.test')->queue(new OrderPlaced);
        Http::get($this->url . '/ping');
        $x = env($request->key);
        return back();
    }
}
`,
    });
  });
  const integration = (id: string) => map.integrations?.find((i) => i.id === id);

  it("reads Http::baseUrl() and links a route closure to its step", () => {
    const api = integration("host:api.shipping.example")!;
    assert.equal(api.usages[0].path, "/v2/labels");
    assert.deepEqual(api.usages[0].by, ["route:ship"]);
  });

  it("records a URL built at runtime as such and reports it", () => {
    assert.ok(map.integrations!.some((i) => i.kind === "http" && i.name.startsWith("URL built at runtime")));
    assert.ok(map.skipped.some((s) => s.reason.startsWith("HTTP call with a URL built at runtime")));
  });

  it("reads uploads stored on a disk, the default disk, and the disk's env keys", () => {
    const s3 = integration("disk:s3")!;
    assert.equal(s3.usages[0].operation, "store");
    assert.deepEqual(s3.env, ["AWS_ACCESS_KEY_ID", "AWS_BUCKET"]);
    assert.ok(integration("disk:default disk"));
  });

  it("reads queued mail and Notification::send, reporting channels it cannot read", () => {
    assert.equal(integration("mail:App\\Mail\\OrderPlaced")!.usages[0].operation, "queue");
    assert.equal(integration("notification:App\\Notifications\\Shipped")!.channels, undefined);
    assert.ok(map.skipped.some((s) => s.reason.startsWith("Notification channels not readable")));
  });

  it("reads .env.example key names only and never opens .env", () => {
    const keys = map.config!.map((c) => c.key);
    assert.ok(keys.includes("SHOP_URL") && keys.includes("OTHER_KEY"));
    assert.ok(!keys.includes("SHOP_SECRET"));
    assert.ok(!JSON.stringify(map).includes("do-not-read-me"));
    assert.ok(map.skipped.some((s) => s.reason.startsWith("Environment key not readable")));
  });
});

describe("status changes made in services and status-history tables", () => {
  let map: BuiltMap;
  let dir: string;
  before(async () => {
    dir = project({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\OrderController;
use App\\Http\\Controllers\\OrderStatusController;
use Illuminate\\Support\\Facades\\Route;
Route::middleware('auth')->group(function () {
    Route::post('/orders', [OrderController::class, 'store'])->name('orders.store');
    Route::post('/orders/{order}/approve', [OrderStatusController::class, 'approve'])->name('orders.approve')->middleware('can:Order Approve');
    Route::post('/orders/{order}/reject', [OrderStatusController::class, 'reject'])->name('orders.reject')->middleware('role:supervisor');
    Route::post('/orders/{order}/ship', [OrderStatusController::class, 'ship'])->name('orders.ship');
    Route::post('/orders/{order}/decide', [OrderStatusController::class, 'decide'])->name('orders.decide');
    Route::post('/orders/{order}/check', [OrderStatusController::class, 'check'])->name('orders.check');
    Route::post('/orders/{order}/rereview', [OrderStatusController::class, 'rereview'])->name('orders.rereview');
    Route::get('/orders/{order}', [OrderController::class, 'show'])->name('orders.show');
    Route::get('/orders-data', [OrderController::class, 'data'])->name('orders.data')->withoutMiddleware('auth')->middleware('isLogin');
});
`,
      "app/Support/Constants.php": `<?php
namespace App\\Support;
class Constants {
    const STATUS_SUBMITTED = 1;
    const STATUS_APPROVED = 2;
    const STATUS_REJECTED = 3;
    const STATUS_SHIPPED = 4;
    const STATUS_WAITING_REVIEW = 5;
    const STATUS_ON_HOLD = 6;
}
`,
      "app/Models/Order.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model { public function statuses() { return $this->hasMany(OrderStatus::class); } }\n",
      "app/Models/OrderStatus.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass OrderStatus extends Model {}\n",
      "app/Models/OrderHistory.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass OrderHistory extends Model {}\n",
      "app/Mail/OrderRejected.php": "<?php\nnamespace App\\Mail;\nclass OrderRejected {}\n",
      "app/Mail/OrderReviewed.php": "<?php\nnamespace App\\Mail;\nclass OrderReviewed {}\n",
      "routes/console.php": "<?php\nuse Illuminate\\Support\\Facades\\Artisan;\nArtisan::command('inspire', function () {})->purpose('Display an inspiring quote');\n",
      "app/Services/OrderWorkflow.php": `<?php
namespace App\\Services;
use App\\Mail\\OrderRejected;
use App\\Mail\\OrderReviewed;
use App\\Models\\OrderHistory;
use App\\Models\\OrderStatus;
use App\\Support\\Constants;
use Illuminate\\Support\\Facades\\Mail;
class OrderWorkflow {
    public function submit($order) { $this->addStatus($order, Constants::STATUS_SUBMITTED); $this->review($order, 'pass'); }
    public function review($order, $mode = 'normal') {
        if ($mode != 'pass') {
            $this->addStatus($order, Constants::STATUS_APPROVED);
            Mail::to('reviewer@example.test')->send(new OrderReviewed);
        }
        $this->addStatus($order, Constants::STATUS_WAITING_REVIEW);
    }
    public function hold($order) { $this->addStatus($order, Constants::STATUS_ON_HOLD); }
    public function approve($order) {
        $latest = OrderStatus::where('order_id', $order->id)->latest()->value('status_id');
        if ($latest == Constants::STATUS_WAITING_REVIEW) { $this->addStatus($order, Constants::STATUS_APPROVED); }
        $this->loop($order);
    }
    public function loop($order) { $this->loop($order); }
    public function reject($order) {
        OrderStatus::create(['order_id' => $order->id, 'status_id' => Constants::STATUS_REJECTED]);
        Mail::to('buyer@example.test')->send(new OrderRejected);
    }
    public function ship($order) {
        $order->statuses()->create(['status_id' => Constants::STATUS_SHIPPED]);
        OrderHistory::create(['order_id' => $order->id, 'status' => 'Shipped by courier']);
    }
    private function addStatus($order, $status) { $order->statuses()->create(['status_id' => $status]); }
}
`,
      "app/Http/Controllers/OrderController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Order;
use App\\Services\\OrderWorkflow;
use Illuminate\\Http\\Request;
class OrderController extends Controller {
    public function store(Request $request) {
        $order = Order::create($request->validate(['title' => 'required']));
        (new OrderWorkflow)->submit($order);
        return back();
    }
    public function data() { return response()->json([]); }
    public function show(Order $order) {
        $latestStatus = OrderStatus::where('order_id', $order->id)->orderByDesc('id')->value('status_id');
        return view('orders.show', compact('order', 'latestStatus'));
    }
}
`,
      "app/Http/Controllers/OrderStatusController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Order;
use App\\Services\\OrderWorkflow;
use Illuminate\\Support\\Facades\\Gate;
class OrderStatusController extends Controller {
    private $workflow;
    public function __construct(private OrderWorkflow $flow) { $this->workflow = new OrderWorkflow; }
    public function approve(Order $order) { $this->workflow->approve($order); return back(); }
    public function reject(Order $order) { $this->flow->reject($order); return back(); }
    public function ship(Order $order) { app(OrderWorkflow::class)->ship($order); return back(); }
    public function rereview(Order $order) { $this->flow->review($order); return back(); }
    public function check(Order $order) {
        if (Gate::allows('manager') && !Gate::allows('auditor')) { $this->flow->hold($order); }
        if (Gate::allows('auditor')) { $this->flow->reject($order); }
        return back();
    }
    public function decide(\Illuminate\Http\Request $request, Order $order) {
        if ($request->type == 'hold') { $this->flow->hold($order); return back(); }
        $this->flow->reject($order);
        return back();
    }
}
`,
      "resources/views/orders/show.blade.php": `@if (in_array($latestStatus, [5, 4]))
<form method="POST" action="{{ route('orders.approve', $order) }}">@csrf</form>
@endif
@if ($latestStatus == 1 || $isAdmin)
<form method="POST" action="{{ route('orders.ship', $order) }}">@csrf</form>
@endif
`,
      ".env.example": "APP_KEY=\nREDIS_HOST=\n",
      "config/services.php": "<?php\nreturn ['shop' => ['key' => env('SHOP_KEY')], 'redis' => env('REDIS_PASSWORD')];\n",
    });
    map = (await scanProject(dir, { mode: "static" })).map;
  });
  const proc = () => map.processes!.find((p) => p.subject === "Order.status_id")!;
  const step = (id: string) => proc().steps.find((s) => s.node === `route:${id}`)!;
  const value = (stateId: string) => proc().states.find((s) => s.id === stateId)?.value;

  it("follows calls into services: (new X), $this->prop set in the constructor, promoted properties, app(X::class)", () => {
    assert.ok(proc(), `processes: ${map.processes?.map((p) => p.subject).join(", ")}`);
    assert.deepEqual(step("orders.approve").to.map(value), ["2"]);
    assert.deepEqual(step("orders.reject").to.map(value), ["3"]);
    assert.deepEqual(step("orders.ship").to.map(value), ["4"]);
  });

  it("carries status values passed as arguments into helper methods", () => {
    assert.deepEqual(step("orders.store").paths?.map((p) => p.map(value)), [["1", "5"]], "addStatus($order, Constants::STATUS_SUBMITTED), then review()");
    assert.deepEqual(step("orders.store").to.map(value), ["5"], "the step ends at the last status it writes");
    assert.equal(proc().states.find((s) => s.value === "2")?.label, "Approved", "named from the constant");
  });

  it("treats status-history rows as a status change of the record, not a new record", () => {
    assert.equal(step("orders.store").creates, true, "Order::create is the record");
    assert.ok(!map.processes!.some((p) => p.subject.startsWith("OrderStatus.")), "OrderStatus rows belong to Order");
    assert.equal(proc().name, "Orders", "a status_id column needs no suffix in the name");
  });

  it("tells permissions from roles, in lanes and in the docs", async () => {
    assert.equal(map.nodes.find((n) => n.id === "route:orders.approve")!.who?.kind, "permission");
    assert.equal(map.nodes.find((n) => n.id === "route:orders.reject")!.who?.kind, "role");
    const { renderDocs } = await import("../src/docs/index.js");
    const docs = await renderDocs(map);
    const roles = docs.markdown.get("roles.md")!;
    assert.ok(roles.includes("## Permissions") && roles.includes("| **Order Approve** |"));
    assert.ok(roles.includes("## Supervisor"));
    assert.ok(docs.markdown.get("README.md")!.includes("**1 permission**"));
  });

  it("separates Laravel's own env keys from the app's", async () => {
    const key = (k: string) => map.config!.find((c) => c.key === k)!;
    assert.equal(key("REDIS_PASSWORD").framework, true);
    assert.equal(key("SHOP_KEY").framework, undefined);
    const { buildDocModel } = await import("../src/docs/model.js");
    const missing = buildDocModel(map).findings.find((f) => f.title === "Missing from .env.example")!;
    assert.deepEqual(missing.items.map((i) => i.text), ["SHOP_KEY"]);
  });
});

describe("current status: history queries, Blade and Gate branches", () => {
  let p: NonNullable<BuiltMap["processes"]>[number];
  before(async () => {
    const map = (await scanProject(dirs.find((d) => existsSync(join(d, "app/Services/OrderWorkflow.php")))!, { mode: "static" })).map;
    p = map.processes!.find((x) => x.subject === "Order.status_id")!;
  });
  const step = (id: string) => p.steps.find((s) => s.node === `route:${id}`)!;
  const values = (ids: string[]) => ids.map((id) => id.split("=")[1]).sort();

  it("reads the status a branch starts from: if ($latest == X) after a latest-status query", () => {
    assert.deepEqual(step("orders.approve").pathInfo?.[0].from?.map((id) => id.split("=")[1]), ["5"]);
  });

  it("reads @if ($latestStatus == …) in the view, with $latestStatus set by the page's handler", () => {
    assert.deepEqual(values(step("orders.approve").from), ["4", "5"]);
    assert.equal(step("orders.approve").fromVia, "view");
  });

  it("does not take a status in A || B as a requirement", () => {
    assert.deepEqual(step("orders.ship").from, []);
  });

  it("keeps Gate::allows('x') and !Gate::allows('x') branches apart, and says who each is for", () => {
    const check = step("orders.check");
    assert.deepEqual(values(check.to), ["3", "6"]);
    assert.deepEqual(check.pathInfo?.map((i) => i.when), [["manager", "not auditor"], ["auditor"]]);
  });

  it("names a status first seen as a bare number once the code names it", () => {
    const s = p.states.find((x) => x.value === "4")!;
    assert.equal(s.label, "Shipped");
    assert.equal(s.named, "code");
  });
});

describe("links and labels for readers", () => {
  let map: BuiltMap;
  before(async () => {
    map = (await scanProject(dirs.find((d) => existsSync(join(d, "app/Services/OrderWorkflow.php")))!, { mode: "static" })).map;
  });

  it("does not read a history/log table as the record's status", () => {
    const p = map.processes!.find((x) => x.subject === "Order.status_id")!;
    assert.ok(!map.processes!.some((x) => x.subject === "Order.status"), "OrderHistory.status is a log, not Order.status");
    assert.deepEqual(p.steps.find((s) => s.node === "route:orders.ship")!.to.map((id) => id.split("=")[1]), ["4"]);
  });

  it("links mail sent in a service to the steps that call it", () => {
    const mail = map.integrations!.find((i) => i.id === "mail:App\\Mail\\OrderRejected")!;
    assert.deepEqual(mail.usages[0].by.sort(), ["route:orders.check", "route:orders.decide", "route:orders.reject"]);
  });

  it("does not link mail in a branch that cannot run with the arguments a step passes", () => {
    const mail = map.integrations!.find((i) => i.id === "mail:App\\Mail\\OrderReviewed")!;
    assert.deepEqual(mail.usages[0].by, ["route:orders.rereview"], "store calls review($order, 'pass'), which skips the mail");
  });

  it("calls a custom login-only middleware a signed-in user in the API table", async () => {
    const { renderDocs } = await import("../src/docs/index.js");
    const api = (await renderDocs(map)).markdown.get("api.md")!;
    assert.match(api, /`GET \/orders-data` \| Data \| Signed-in user \|/);
  });

  it("leaves out Laravel's sample inspire command", () => {
    assert.ok(!(map.automation?.commands ?? []).some((c) => c.name === "inspire"));
  });
});

describe("events, listeners and model observers", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "bootstrap/app.php": "<?php\nuse Illuminate\\Foundation\\Application;\nreturn Application::configure(basePath: dirname(__DIR__))->create();\n",
      "routes/web.php": `<?php
use App\\Http\\Controllers\\InvoiceController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/invoices', [InvoiceController::class, 'store'])->name('invoices.store');
Route::post('/invoices/{invoice}/send', [InvoiceController::class, 'send'])->name('invoices.send');
Route::post('/invoices/{invoice}/pay', [InvoiceController::class, 'pay'])->name('invoices.pay');
Route::post('/invoices/{invoice}/archive', [InvoiceController::class, 'archive'])->name('invoices.archive');
`,
      "app/Models/Invoice.php": `<?php
namespace App\\Models;
use App\\Observers\\InvoiceObserver;
use Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy;
use Illuminate\\Database\\Eloquent\\Model;
#[ObservedBy([InvoiceObserver::class])]
class Invoice extends Model {}
`,
      "app/Models/Payment.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Payment extends Model {}\n",
      "app/Mail/InvoiceMail.php": "<?php\nnamespace App\\Mail;\nclass InvoiceMail {}\n",
      "app/Mail/AuditMail.php": "<?php\nnamespace App\\Mail;\nclass AuditMail {}\n",
      "app/Mail/PaymentReceived.php": "<?php\nnamespace App\\Mail;\nclass PaymentReceived {}\n",
      "app/Observers/InvoiceObserver.php": `<?php
namespace App\\Observers;
use App\\Mail\\AuditMail;
use App\\Models\\Invoice;
use Illuminate\\Support\\Facades\\Mail;
class InvoiceObserver {
    public function creating(Invoice $invoice) { $invoice->status = 'draft'; }
    public function updated(Invoice $invoice) {
        Mail::to('audit@example.test')->send(new AuditMail);
        $invoice->status = 'audited';
    }
}
`,
      "app/Observers/PaymentObserver.php": `<?php
namespace App\\Observers;
use App\\Mail\\PaymentReceived;
use Illuminate\\Support\\Facades\\Mail;
class PaymentObserver {
    public function created($payment) { Mail::to('finance@example.test')->send(new PaymentReceived); }
}
`,
      "app/Events/InvoiceSent.php": `<?php
namespace App\\Events;
use App\\Models\\Invoice;
class InvoiceSent { public function __construct(public Invoice $invoice) {} }
`,
      "app/Events/InvoicePaid.php": `<?php
namespace App\\Events;
use Illuminate\\Foundation\\Events\\Dispatchable;
class InvoicePaid {
    use Dispatchable;
    public $invoice;
    public function __construct($invoice) { $this->invoice = $invoice; }
}
`,
      "app/Listeners/DeliverInvoice.php": `<?php
namespace App\\Listeners;
use App\\Events\\InvoiceSent;
use App\\Mail\\InvoiceMail;
use Illuminate\\Support\\Facades\\Mail;
class DeliverInvoice {
    public function handle(InvoiceSent $event): void {
        Mail::to('customer@example.test')->send(new InvoiceMail);
        $event->invoice->status = 'delivered';
        $event->invoice->save();
    }
}
`,
      "app/Billing/MarkPaid.php": `<?php
namespace App\\Billing;
class MarkPaid {
    public function onPaid($event) { $event->invoice->update(['status' => 'paid']); }
}
`,
      "app/Providers/AppServiceProvider.php": `<?php
namespace App\\Providers;
use App\\Billing\\MarkPaid;
use App\\Events\\InvoicePaid;
use App\\Models\\Payment;
use App\\Observers\\PaymentObserver;
use Illuminate\\Support\\Facades\\Event;
use Illuminate\\Support\\ServiceProvider;
class AppServiceProvider extends ServiceProvider {
    public function boot(): void {
        Event::listen(InvoicePaid::class, [MarkPaid::class, 'onPaid']);
        Payment::observe(PaymentObserver::class);
    }
}
`,
      "app/Http/Controllers/InvoiceController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Events\\InvoicePaid;
use App\\Events\\InvoiceSent;
use App\\Models\\Invoice;
use App\\Models\\Payment;
class InvoiceController extends Controller {
    public function store() {
        $invoice = new Invoice;
        $invoice->title = 'x';
        $invoice->save();
        return back();
    }
    public function send(Invoice $invoice) {
        $invoice->status = 'sent';
        $invoice->save();
        event(new InvoiceSent($invoice));
        return back();
    }
    public function pay(Invoice $invoice) {
        Payment::create(['invoice_id' => $invoice->id]);
        InvoicePaid::dispatch($invoice);
        return back();
    }
    public function archive($id) {
        Invoice::where('id', $id)->update(['status' => 'archived']);
        return back();
    }
}
`,
    });
  });
  const proc = () => map.processes!.find((p) => p.subject === "Invoice.status")!;
  const to = (route: string) => proc().steps.find((s) => s.node === `route:${route}`)!.to.map((id) => proc().states.find((s) => s.id === id)!.value).sort();
  const sentBy = (id: string) => map.integrations!.find((i) => i.id === id)!.usages.flatMap((u) => u.by).sort();

  it("takes the status a creating() observer sets into the step that creates the record", () => {
    assert.ok(proc(), `processes: ${map.processes?.map((p) => p.subject).join(", ")}`);
    assert.deepEqual(to("invoices.store"), ["draft"]);
  });

  it("follows an event to its discovered listener, with the model the event carries", () => {
    // sent, then the listener runs at event(): the step ends at delivered
    assert.deepEqual(to("invoices.send"), ["delivered"]);
    assert.deepEqual(sentBy("mail:App\\Mail\\InvoiceMail"), ["route:invoices.send"]);
  });

  it("follows X::dispatch() to a listener registered with Event::listen, through an untyped property", () => {
    assert.deepEqual(to("invoices.pay"), ["paid"]);
  });

  it("links mail sent by an observer to the steps that save the model, not to query-builder updates", () => {
    assert.deepEqual(sentBy("mail:App\\Mail\\PaymentReceived"), ["route:invoices.pay"]);
    assert.ok(!sentBy("mail:App\\Mail\\AuditMail").includes("route:invoices.archive"), "Model::where()->update() fires no model events");
    assert.ok(sentBy("mail:App\\Mail\\AuditMail").includes("route:invoices.send"));
  });

  it("reports a status set in an updated() observer instead of placing it", () => {
    assert.ok(!proc().states.some((s) => s.value === "audited"));
    assert.ok(map.skipped.some((s) => /observer InvoiceObserver::updated\(\)/.test(s.reason)), map.skipped.map((s) => s.reason).join("\n"));
  });
});

describe("who may act, read from policies and gates", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\InvoiceController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/invoices/{invoice}/approve', [InvoiceController::class, 'approve'])->name('invoices.approve');
Route::post('/invoices/{invoice}/void', [InvoiceController::class, 'void'])->name('invoices.void')->middleware('can:void,invoice');
Route::post('/reports/export', [InvoiceController::class, 'export'])->name('reports.export')->middleware('can:export-reports');
Route::post('/invoices/{invoice}/cancel', [InvoiceController::class, 'cancel'])->name('invoices.cancel');
`,
      "app/Models/User.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Foundation\\Auth\\User as Authenticatable;\nclass User extends Authenticatable {}\n",
      "app/Models/Invoice.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Invoice extends Model {}\n",
      "app/Policies/InvoicePolicy.php": `<?php
namespace App\\Policies;
use App\\Models\\Invoice;
use App\\Models\\User;
class InvoicePolicy {
    public function before(User $user) { if ($user->role === 'superadmin') { return true; } }
    public function approve(User $user, Invoice $invoice) { return $user->hasRole('finance'); }
    public function void(User $user, Invoice $invoice) { return $user->role == 'auditor'; }
    public function cancel(User $user, Invoice $invoice) { return $user->id === $invoice->created_by; }
}
`,
      "app/Providers/AppServiceProvider.php": `<?php
namespace App\\Providers;
use App\\Models\\User;
use Illuminate\\Support\\Facades\\Gate;
use Illuminate\\Support\\ServiceProvider;
class AppServiceProvider extends ServiceProvider {
    public function boot(): void {
        Gate::define('export-reports', fn (User $user) => $user->role === 'analyst');
    }
}
`,
      "app/Http/Controllers/InvoiceController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Invoice;
class InvoiceController extends Controller {
    public function approve(Invoice $invoice) { $this->authorize('approve', $invoice); return back(); }
    public function void(Invoice $invoice) { return back(); }
    public function export() { return back(); }
    public function cancel(Invoice $invoice) { $this->authorize('cancel', $invoice); return back(); }
}
`,
    });
  });
  const who = (id: string) => map.nodes.find((n) => n.id === `route:${id}`)?.who;

  it("reads $this->authorize('approve', $invoice) through InvoicePolicy::approve() and before()", () => {
    const w = who("invoices.approve")!;
    assert.ok(w, "approve has a who");
    assert.match(w.name, /finance/i);
    assert.ok(w.evidence.some((e) => /InvoicePolicy::approve\(\): hasRole\('finance'\)/.test(e)), w.evidence.join("\n"));
    assert.ok(w.evidence.some((e) => /InvoicePolicy::before\(\)/.test(e)), w.evidence.join("\n"));
  });

  it("reads can:void,invoice through the policy of the bound model", () => {
    assert.match(who("invoices.void")!.name, /auditor/i);
  });

  it("reads can:export-reports through its Gate::define body", () => {
    assert.match(who("reports.export")!.name, /analyst/i);
  });

  it("does not turn an ownership check into a role", () => {
    const w = who("invoices.cancel");
    assert.ok(!w || !/created|owner/i.test(w.name), w ? w.name : "no who");
  });
});

describe("status values built from limited input", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\TicketController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/tickets/{ticket}/close', [TicketController::class, 'close'])->name('tickets.close');
Route::post('/tickets/{ticket}/move', [TicketController::class, 'move'])->name('tickets.move');
Route::post('/tickets/{ticket}/rate', [TicketController::class, 'rate'])->name('tickets.rate');
Route::post('/tickets/{ticket}/free', [TicketController::class, 'free'])->name('tickets.free');
Route::post('/tickets/{ticket}/reopen', [TicketController::class, 'reopen'])->name('tickets.reopen');
`,
      "app/Models/Ticket.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Ticket extends Model {}\n",
      "app/Http/Requests/RateTicketRequest.php": `<?php
namespace App\\Http\\Requests;
use Illuminate\\Foundation\\Http\\FormRequest;
use Illuminate\\Validation\\Rule;
class RateTicketRequest extends FormRequest {
    public function rules(): array { return ['level' => ['required', Rule::in(['low', 'high'])]]; }
}
`,
      "app/Http/Controllers/TicketController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Http\\Requests\\RateTicketRequest;
use App\\Models\\Ticket;
use Illuminate\\Http\\Request;
class TicketController extends Controller {
    public function close(Request $request, Ticket $ticket) {
        $request->validate(['reason' => 'required|in:fixed,duplicate']);
        $ticket->status = 'closed_' . $request->reason;
        $ticket->save();
        return back();
    }
    public function move(Request $request, Ticket $ticket) {
        $stage = $request->input('stage');
        if (!in_array($stage, ['triage', 'doing'])) { abort(422); }
        $ticket->update(['status' => $stage]);
        return back();
    }
    public function rate(RateTicketRequest $request, Ticket $ticket) {
        $ticket->status = "level_{$request->level}";
        $ticket->save();
        return back();
    }
    public function free(Request $request, Ticket $ticket) {
        $ticket->status = $request->status;
        $ticket->save();
        return back();
    }
    public function reopen(Ticket $ticket) {
        $next = 'open';
        $ticket->update(['status' => $next, 'stage' => 'stage_' . $next]);
        return back();
    }
}
`,
    });
  });
  const proc = () => map.processes!.find((p) => p.subject === "Ticket.status")!;
  const to = (route: string) => proc().steps.find((s) => s.node === `route:${route}`)!.to.map((id) => proc().states.find((s) => s.id === id)!.value).sort();

  it("reads 'closed_' . $request->reason when validation limits reason (in:a,b)", () => {
    assert.ok(proc(), `processes: ${map.processes?.map((p) => p.subject).join(", ")}`);
    assert.deepEqual(to("tickets.close"), ["closed_duplicate", "closed_fixed"]);
  });

  it("reads a variable limited by an in_array guard", () => {
    assert.deepEqual(to("tickets.move"), ["doing", "triage"]);
  });

  it("reads \"level_{$request->level}\" limited by Rule::in in a FormRequest", () => {
    assert.deepEqual(to("tickets.rate"), ["level_high", "level_low"]);
  });

  it("does not make a second flow of a column that only spells out the status ('stage_' . $next)", () => {
    assert.deepEqual(to("tickets.reopen"), ["open"]);
    assert.ok(!map.processes!.some((p) => p.subject === "Ticket.stage"), map.processes!.map((p) => p.subject).join(", "));
  });

  it("still reports input that nothing limits, instead of guessing", () => {
    assert.ok(map.skipped.some((s) => /Ticket\.status = \$request->status/.test(s.reason)), map.skipped.map((s) => s.reason).join("\n"));
  });
});

describe("text to write", () => {
  it("lists what only people can write as YAML that can be pasted into builtlore.edits.yaml", async () => {
    const dir = project({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\OrderController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/orders/{order}/pay', [OrderController::class, 'pay'])->name('orders.pay');
`,
      "app/Models/Order.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model {}\n",
      "app/Http/Controllers/OrderController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Order;
class OrderController extends Controller {
    public function pay(Order $order) { if ($order->status != 1) abort(403); $order->status = 2; $order->save(); return back(); }
}
`,
    });
    const { renderDocs } = await import("../src/docs/index.js");
    const first = (await scanProject(dir, { mode: "static" }, { write: false })).map;
    const page = (await renderDocs(first)).markdown.get("to-write.md")!;
    const yaml = /```yaml\n([\s\S]*?)\n```/.exec(page)![1];
    assert.match(yaml, /^project:\n  summary: ""/m);
    assert.match(yaml, /^statuses:\n  Order\.status:.*\n    "1": ""/m);
    assert.match(yaml, /^steps:\n  "route:orders\.pay":\n    description: ""  # Pay: POST/m);

    // Pasted as is: nothing changes and nothing counts as an edit; filled in: applied
    writeFileSync(join(dir, "builtlore.edits.yaml"), yaml);
    const pasted = (await scanProject(dir, { mode: "static" }, { write: false })).map;
    assert.ok(!pasted.notes.some((n) => /^Applied/.test(n)), pasted.notes.join("\n"));
    assert.equal(pasted.project.summary, undefined);
    writeFileSync(join(dir, "builtlore.edits.yaml"), yaml.replace('summary: ""', 'summary: "Orders for the shop"').replace('"2": ""', '"2": "Paid"'));
    const filled = (await scanProject(dir, { mode: "static" }, { write: false })).map;
    assert.equal(filled.project.summary, "Orders for the shop");
    assert.equal(filled.processes![0].states.find((s) => s.value === "2")!.label, "Paid");
    assert.ok(!(await renderDocs(filled)).markdown.get("to-write.md")!.includes('"2": ""'));
  });
});

describe("apps that check access in the page and in helpers, with flows across features", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\AccessPageController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/access', [AccessPageController::class, 'index'])->name('access.index')->middleware('can:Access Read');
`,
      "routes/api.php": `<?php
use App\\Http\\Controllers\\API\\AccessController;
use App\\Http\\Controllers\\API\\InboxController;
use Illuminate\\Support\\Facades\\Route;
Route::post('device/access', [AccessController::class, 'store'])->name('device.store');
Route::post('inbox/access/{id}/approve', [InboxController::class, 'approve'])->name('inbox.approve');
Route::post('inbox/access/{id}/claim', [InboxController::class, 'claim'])->name('inbox.claim');
Route::post('inbox/access/{id}/set', [InboxController::class, 'set'])->name('inbox.set');
Route::post('external/check', [\\App\\Http\\Controllers\\API\\ExternalController::class, 'check'])->name('external.check');
Route::post('access/import', [AccessController::class, 'import'])->name('access.import');
Route::post('inbox/access/bulk-reject', [InboxController::class, 'bulkReject'])->name('inbox.bulk-reject');
`,
      "app/Http/Controllers/API/ExternalController.php": `<?php
namespace App\\Http\\Controllers\\API;
use App\\Http\\Controllers\\Controller;
use Illuminate\\Http\\Request;
class ExternalController extends Controller {
    public function check(Request $request) {
        $client = $this->authenticate($request);
        if ($client instanceof \\Illuminate\\Http\\JsonResponse) { return $client; }
        return response()->json(['ok' => true]);
    }
    private function authenticate(Request $request) {
        $unauthorized = response()->json(['error' => 'unauthorized'], 401);
        $key = $request->header('X-Partner-Key');
        if (!is_string($key) || $key === '') { return $unauthorized; }
        return true;
    }
}
`,
      "app/Models/AccessRequest.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass AccessRequest extends Model {}\n",
      "app/Mail/ReviewMail.php": "<?php\nnamespace App\\Mail;\nclass ReviewMail { public function __construct(public array $data) {} }\n",
      "app/Helpers/Helper.php": `<?php
namespace App\\Helpers;
use Illuminate\\Support\\Facades\\Session;
class Helper {
    public function canUseAPI() {
        $isLogin = Session::get('nik_real');
        if (!$isLogin) { \\abort(response()->json(['message' => 'not logged in'])); }
    }
}
`,
      "app/Http/Controllers/AccessPageController.php": `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Support\\Facades\\Gate;
class AccessPageController extends Controller {
    public function index() {
        $canInsert = Gate::allows('Access Insert');
        return view('access.index', compact('canInsert'));
    }
}
`,
      "resources/views/access/index.blade.php": `<div x-data="{ userPermissions: { canInsert: @json($canInsert) } }">
<script>
async function save() { await fetch("{{ route('device.store') }}", { method: 'POST' }); }
</script>
</div>
`,
      "app/Http/Controllers/API/AccessController.php": `<?php
namespace App\\Http\\Controllers\\API;
use App\\Helpers\\Helper;
use App\\Http\\Controllers\\Controller;
use App\\Models\\AccessRequest;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Validator;
class AccessController extends Controller {
    public function store(Helper $helper, Request $request) {
        $helper->canUseAPI();
        Validator::make($request->all(), ['status' => ['nullable', 'string']]);
        AccessRequest::create(['name' => $request->name, 'status' => 'waiting']);
        return response()->json(['message' => 'ok']);
    }
    public function import(Request $request) {
        $request->validate(['file' => 'required|file']);
        return response()->json(['message' => 'ok']);
    }
}
`,
      "app/Http/Controllers/API/InboxController.php": `<?php
namespace App\\Http\\Controllers\\API;
use App\\Http\\Controllers\\Controller;
use App\\Mail\\ReviewMail;
use App\\Models\\AccessRequest;
use Illuminate\\Http\\Request;
class InboxController extends Controller {
    public function approve($id) {
        $item = AccessRequest::findOrFail($id);
        if ($item->status != 'waiting') { abort(422); }
        $item->update(['status' => 'approved', 'status_by' => session('nik'), 'status_at' => now()]);
        return response()->json(['message' => 'ok']);
    }
    public function claim(Request $request, $id) {
        $next = null;
        $next = $request->boolean('urgent') ? 'pending_l2' : 'pending_l1';
        AccessRequest::findOrFail($id)->update(['status' => $next]);
        new ReviewMail(['final_status' => $next]);
        return response()->json(['message' => 'ok']);
    }
    public function bulkReject(Request $request) {
        AccessRequest::whereIn('id', $request->ids)->where('status', 'waiting')->update(['status' => 'rejected']);
        return response()->json(['message' => 'ok']);
    }
    public function set(Request $request, $id) {
        $request->validate(['status' => 'required|exists:general_codes,code']);
        AccessRequest::findOrFail($id)->update(['status' => $request->status]);
        return response()->json(['message' => 'ok']);
    }
}
`,
    });
  });
  const procs = () => map.processes!.filter((p) => p.subject.startsWith("AccessRequest."));
  const node = (id: string) => map.nodes.find((n) => n.id === `route:${id}`)!;

  it("makes one flow of a record created in one feature and approved in another", () => {
    const ps = procs();
    assert.deepEqual(ps.map((p) => p.subject), ["AccessRequest.status"], ps.map((p) => `${p.name} ${p.subject}`).join("\n"));
    const p = ps[0];
    assert.equal(p.name, "Access request");
    assert.equal(p.feature, node("device.store").feature, "owned by the feature that creates the record");
    assert.deepEqual([...(p.features ?? [])].sort(), [node("device.store").feature, node("inbox.approve").feature].sort());
    const values = p.states.map((s) => s.value).sort();
    assert.deepEqual(values, ["approved", "pending_l1", "pending_l2", "rejected", "waiting"]);
  });

  it("reads where('status', X)->update([...]) as starting from X", () => {
    const p = procs()[0];
    const s = p.steps.find((x) => x.node === "route:inbox.bulk-reject")!;
    assert.deepEqual(s.from.map((id) => id.split("=")[1]), ["waiting"]);
    assert.deepEqual(s.to.map((id) => id.split("=")[1]), ["rejected"]);
  });

  it("does not read status_by / status_at, Validator::make or a Mailable's data as statuses", () => {
    assert.ok(!map.processes!.some((p) => /status_(by|at)$|final_status/.test(p.subject)), map.processes!.map((p) => p.subject).join(", "));
    assert.ok(!map.skipped.some((s) => /status_(by|at)|final_status|= array/.test(s.reason)), map.skipped.map((s) => s.reason).join("\n"));
  });

  it("says where an unreadable value comes from (a lookup table)", () => {
    assert.ok(map.skipped.some((s) => /AccessRequest\.status = \$request->status \(values come from table general_codes/.test(s.reason)), map.skipped.map((s) => s.reason).join("\n"));
  });

  it("reads a login check inside a helper as Signed-in user", () => {
    const w = node("device.store").who!;
    assert.equal(w.name, "Signed-in user");
    assert.ok(w.evidence.some((e) => /Helper::canUseAPI\(\): Session::get\('nik_real'\)/.test(e)), w.evidence.join("\n"));
  });

  it("reports actions whose permission is checked only by the page that calls them", async () => {
    const n = node("device.store");
    assert.deepEqual(n.pageOnly?.abilities, ["Access Insert"]);
    assert.deepEqual(n.pageOnly?.pages, ["route:access.index"]);
    const { renderDocs } = await import("../src/docs/index.js");
    const findings = (await renderDocs(map)).markdown.get("findings.md")!;
    assert.match(findings, /Permission checked only in the page \(1\)/);
    assert.match(findings, /the page checks Access Insert/);
  });

  it("reads an API key checked in a helper method as API client", () => {
    const w = node("external.check").who!;
    assert.equal(w.name, "API client");
    assert.ok(w.evidence.some((e) => /header X-Partner-Key, ExternalController::authenticate\(\)/.test(e)), w.evidence.join("\n"));
  });

  it("lists writes with no check at all under Open to anyone", async () => {
    const { renderDocs } = await import("../src/docs/index.js");
    const findings = (await renderDocs(map)).markdown.get("findings.md")!;
    const section = findings.slice(findings.indexOf("Open to anyone"));
    assert.match(section, /access\/import/);
    assert.doesNotMatch(section.slice(0, section.indexOf("\n## ") > 0 ? section.indexOf("\n## ") : undefined), /external\/check|device\/access/);
  });
});

describe("many CRUD features", () => {
  it("sums up list-only features as data management, with one diagram each and one overview table", async () => {
    const crud = (name: string, cls: string) => ({
      [`app/Http/Controllers/${cls}Controller.php`]: `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Http\\Request;
class ${cls}Controller extends Controller {
    public function index() { return view('${name}.index'); }
    public function store(Request $request) { $request->validate(['name' => 'required|max:50']); return back(); }
    public function update(Request $request, $id) { return back(); }
    public function destroy($id) { return back(); }
    public function export() { return response()->download('x.xlsx'); }
}
`,
      [`resources/views/${name}/index.blade.php`]: `<form method="POST" action="{{ route('master.${name}.store') }}">@csrf</form>
<a href="{{ route('master.${name}.export') }}">Export</a>
`,
    });
    const map = await scan({
      "routes/web.php": `<?php
use Illuminate\\Support\\Facades\\Route;
foreach ([] as $x) {}
Route::prefix('master')->name('master.')->middleware('auth')->group(function () {
    Route::get('sites', [App\\Http\\Controllers\\SiteController::class, 'index'])->name('site.index');
    Route::post('sites', [App\\Http\\Controllers\\SiteController::class, 'store'])->name('site.store');
    Route::put('sites/{id}', [App\\Http\\Controllers\\SiteController::class, 'update'])->name('site.update');
    Route::delete('sites/{id}', [App\\Http\\Controllers\\SiteController::class, 'destroy'])->name('site.destroy');
    Route::get('sites/export', [App\\Http\\Controllers\\SiteController::class, 'export'])->name('site.export');
    Route::get('tags', [App\\Http\\Controllers\\TagController::class, 'index'])->name('tag.index');
    Route::post('tags', [App\\Http\\Controllers\\TagController::class, 'store'])->name('tag.store');
    Route::put('tags/{id}', [App\\Http\\Controllers\\TagController::class, 'update'])->name('tag.update');
    Route::delete('tags/{id}', [App\\Http\\Controllers\\TagController::class, 'destroy'])->name('tag.destroy');
    Route::get('tags/export', [App\\Http\\Controllers\\TagController::class, 'export'])->name('tag.export');
    Route::get('units', [App\\Http\\Controllers\\UnitController::class, 'index'])->name('unit.index');
    Route::post('units', [App\\Http\\Controllers\\UnitController::class, 'store'])->name('unit.store');
    Route::put('units/{id}', [App\\Http\\Controllers\\UnitController::class, 'update'])->name('unit.update');
    Route::delete('units/{id}', [App\\Http\\Controllers\\UnitController::class, 'destroy'])->name('unit.destroy');
    Route::get('units/export', [App\\Http\\Controllers\\UnitController::class, 'export'])->name('unit.export');
});
`,
      ...crud("site", "Site"),
      ...crud("tag", "Tag"),
      ...crud("unit", "Unit"),
    });
    const { renderDocs } = await import("../src/docs/index.js");
    const docs = await renderDocs(map);
    const dm = docs.markdown.get("data-management.md")!;
    assert.ok(dm, [...docs.markdown.keys()].join(", "));
    assert.match(dm, /\| Feature \| Add \| Edit \| Delete \| Import \| Export \| Who \|/);
    assert.match(dm, /\[Master › Site\]\([^)]*\) \| ✓ \| ✓ \| ✓ \|\s+\| ✓ \| Signed-in user \|/);
    const site = [...docs.markdown.entries()].find(([k]) => /site/.test(k) && k.startsWith("features/"))![1];
    assert.match(site, /## Data management/);
    assert.match(site, /\| Add \| Save site \| Signed-in user \| name \|/);
    assert.match(site, /## Screens and actions\n\n```mermaid\nflowchart LR/);
    // Sidebar: the data features sit under "Data management", grouped by area with short names
    const toc = docs.html.slice(docs.html.indexOf('<ul class="toc-list">'), docs.html.indexOf("</nav>"));
    assert.match(toc, /<summary>Data management <span class="count">3<\/span><\/summary><ul><li class="area"><details><summary>Master <span class="count">3<\/span><\/summary><ul><li><a href="#feature-[^"]+">Site<\/a>/);
  });
});

describe("optional database layer (--db)", () => {
  const files = {
    "routes/web.php": `<?php
use App\\Http\\Controllers\\RequestController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/requests/{id}/hold', [RequestController::class, 'hold'])->name('requests.hold');
`,
    "app/Models/TRequest.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass TRequest extends Model { protected $table = 'T_Request'; public function state() { return $this->belongsTo(MStatus::class, 'Status', 'status'); } }\n",
    "app/Models/MStatus.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass MStatus extends Model { protected $table = 'M_Status'; }\n",
    "app/Http/Controllers/RequestController.php": `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Support\\Facades\\DB;
class RequestController extends Controller {
    public function hold($id) { DB::table('T_Request')->where('id', $id)->update(['Status' => 'H']); return back(); }
}
`,
  };

  it("names statuses from the lookup table their column points at, and adds the database's tables and keys", async () => {
    const dir = project(files);
    const snap = join(dir, "snapshot.json");
    writeFileSync(snap, JSON.stringify({
      driver: "sqlsrv",
      tables: [
        { name: "T_Request", columns: [{ name: "id", type: "int", nullable: false }, { name: "Status", type: "varchar", nullable: true }, { name: "SiteId", type: "int", nullable: true }], foreignKeys: [{ columns: ["SiteId"], foreignTable: "M_Site", foreignColumns: ["id"] }] },
        { name: "M_Status", columns: [{ name: "status", type: "varchar", nullable: false }, { name: "Keterangan", type: "varchar", nullable: true }], foreignKeys: [] },
        { name: "M_Site", columns: [{ name: "id", type: "int", nullable: false }], foreignKeys: [] },
      ],
      lookups: [{ table: "M_Status", key: "status", labelColumn: "Keterangan", rows: [["H", "On hold"], ["A", "Approved"]] }],
    }));
    process.env.BUILTLORE_DB_SNAPSHOT = snap;
    try {
      const map = (await scanProject(dir, { mode: "static", database: true }, { write: false })).map;
      const p = map.processes!.find((x) => x.subject === "TRequest.Status")!;
      assert.equal(p.states.find((s) => s.value === "H")?.label, "On hold");
      assert.ok(map.data!.tables.some((t) => t.name === "M_Site" && /database/.test(t.comment ?? "")));
      assert.ok(map.data!.relations!.some((r) => r.from === "T_Request" && r.to === "M_Site" && r.found.includes("database")));
      assert.ok(map.notes.some((n) => /^Database \(sqlsrv, read-only\)/.test(n)), map.notes.join("\n"));
    } finally {
      delete process.env.BUILTLORE_DB_SNAPSHOT;
    }
  });

  it("says so and goes on from the code when it cannot read the database", async () => {
    const map = (await scanProject(project(files), { mode: "static", database: true }, { write: false })).map;
    assert.ok(map.notes.some((n) => /^Database: not read \(vendor\/ is missing/.test(n)), map.notes.join("\n"));
    assert.ok(map.processes!.some((x) => x.subject === "TRequest.Status"));
  });
});

describe("other ways to build a Laravel app", () => {
  it("reads routes, controllers, models and views of modules (Modules/<Name>)", async () => {
    const map = await scan({
      "Modules/Billing/Routes/web.php": `<?php
use Modules\\Billing\\Http\\Controllers\\InvoiceController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/invoices', [InvoiceController::class, 'index'])->name('billing.invoices.index');
Route::post('/invoices/{invoice}/pay', [InvoiceController::class, 'pay'])->name('billing.invoices.pay');
`,
      "Modules/Billing/Entities/Invoice.php": "<?php\nnamespace Modules\\Billing\\Entities;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Invoice extends Model {}\n",
      "Modules/Billing/Http/Controllers/InvoiceController.php": `<?php
namespace Modules\\Billing\\Http\\Controllers;
use Illuminate\\Routing\\Controller;
use Modules\\Billing\\Entities\\Invoice;
class InvoiceController extends Controller {
    public function index() { return view('billing::invoices.index'); }
    public function pay(Invoice $invoice) { $invoice->status = 'paid'; $invoice->save(); return back(); }
}
`,
      "Modules/Billing/Resources/views/invoices/index.blade.php": `<form method="POST" action="{{ route('billing.invoices.pay', 1) }}">@csrf<button>Mark paid</button></form>\n`,
    });
    assert.ok(map.nodes.some((n) => n.id === "route:billing.invoices.pay"));
    assert.ok(map.edges.some((e) => e.from === "route:billing.invoices.index" && e.to === "route:billing.invoices.pay"), "the module's view is read");
    assert.ok(map.processes!.some((p) => p.subject === "Invoice.status"), map.processes!.map((p) => p.subject).join(", "));
  });

  it("reads a Livewire page and the methods its view calls as actions", async () => {
    const map = await scan({
      "routes/web.php": `<?php
use App\\Livewire\\Orders\\Board;
use Illuminate\\Support\\Facades\\Route;
Route::get('/orders', Board::class)->name('orders.board')->middleware('auth');
`,
      "app/Models/Order.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Order extends Model {}\n",
      "app/Livewire/Orders/Board.php": `<?php
namespace App\\Livewire\\Orders;
use App\\Models\\Order;
use Livewire\\Component;
class Board extends Component {
    public Order $order;
    public function approve() { $this->order->status = 'approved'; $this->order->save(); }
    public function helper() {}
    public function render() { return view('livewire.orders.board'); }
}
`,
      "resources/views/livewire/orders/board.blade.php": `<div><button wire:click="approve">Approve</button><button wire:click="$refresh">Reload</button></div>\n`,
    });
    const page = map.nodes.find((n) => n.id === "route:orders.board")!;
    assert.equal(page.type, "page");
    assert.ok(!map.skipped.some((s) => /Controller not found/.test(s.reason)));
    const action = map.nodes.find((n) => n.id === "livewire:orders.board.approve")!;
    assert.ok(action, map.nodes.map((n) => n.id).join(", "));
    assert.ok(!map.nodes.some((n) => n.id === "livewire:orders.board.helper"), "only methods the view calls");
    assert.ok(map.edges.some((e) => e.from === page.id && e.to === action.id));
    assert.deepEqual(map.processes!.find((p) => p.subject === "Order.status")!.steps.find((s) => s.node === action.id)!.to.map((id) => id.split("=")[1]), ["approved"]);
  });

  it("reads where an Inertia page sends the user (router.post, form.put, Link)", async () => {
    const map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\PostController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/posts', [PostController::class, 'index'])->name('posts.index');
Route::get('/posts/{post}', [PostController::class, 'show'])->name('posts.show');
Route::post('/posts', [PostController::class, 'store'])->name('posts.store');
`,
      "app/Http/Controllers/PostController.php": `<?php
namespace App\\Http\\Controllers;
use Inertia\\Inertia;
class PostController extends Controller {
    public function index() { return Inertia::render('Posts/Index'); }
    public function show($id) { return Inertia::render('Posts/Show'); }
    public function store() { return redirect()->route('posts.index'); }
}
`,
      "resources/js/Pages/Posts/Index.vue": `<template><Link :href="route('posts.show', post.id)">Open</Link></template>
<script setup>
const form = useForm({ title: '' });
const save = () => form.post(route('posts.store'));
</script>
`,
    });
    const e = (to: string) => map.edges.find((x) => x.from === "route:posts.index" && x.to === `route:${to}`);
    assert.equal(e("posts.show")?.trigger, "link");
    assert.equal(e("posts.store")?.trigger, "submit");
  });
});

describe("names read from what people see", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\TicketController;
use Illuminate\\Support\\Facades\\Route;
Route::get('/tickets', [TicketController::class, 'index'])->name('tickets.index');
Route::get('/tickets/{ticket}', [TicketController::class, 'show'])->name('tickets.show');
Route::post('/tickets/{ticket}/park', [TicketController::class, 'park'])->name('tickets.park');
Route::post('/tickets/{ticket}/close', [TicketController::class, 'close'])->name('tickets.close');
`,
      "app/Models/Ticket.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Ticket extends Model {}\n",
      "app/Http/Controllers/TicketController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Models\\Ticket;
class TicketController extends Controller {
    public function index() { return view('tickets.index'); }
    public function show(Ticket $ticket) { return view('tickets.show', compact('ticket')); }
    public function park(Ticket $ticket) { $ticket->status = 'P'; $ticket->save(); return back(); }
    public function close(Ticket $ticket) { $ticket->status = 'C'; $ticket->save(); return back(); }
}
`,
      "resources/views/layouts/sidebar.blade.php": `<nav><a href="{{ route('tickets.index') }}"><i class="fa fa-ticket"></i> Support tickets</a></nav>\n`,
      "resources/views/tickets/index.blade.php": `@extends('layouts.app')
@section('title', 'All tickets')
<table><tr><td>
@if ($ticket->status == 'P')
  <span class="badge">Parked</span>
@elseif ($ticket->status == 'X')
  <button>Reopen</button>
@endif
</td></tr></table>
<script>
function badge(row) {
  switch (row.status) {
    case 'C': return '<span class="badge bg-dark">Closed by agent</span>';
  }
}
</script>
`,
      "resources/views/tickets/show.blade.php": `<h2>Ticket {{ $ticket->id }}</h2>
<form method="POST" action="{{ route('tickets.park', $ticket) }}">@csrf<button type="submit">Park ticket</button></form>
<form method="POST" action="{{ route('tickets.close', $ticket) }}">@csrf<button type="submit">Save</button></form>
`,
    });
  });
  const node = (id: string) => map.nodes.find((n) => n.id === `route:${id}`)!;
  const label = (v: string) => map.processes!.find((p) => p.subject === "Ticket.status")!.states.find((s) => s.value === v)?.label;

  it("names status codes the way the views show them (@if branches, script switch)", () => {
    assert.equal(label("P"), "Parked");
    assert.equal(label("C"), "Closed by agent");
  });

  it("names screens by their menu item and actions by their button, not generic words", () => {
    assert.equal(node("tickets.index").label, "Support tickets");
    assert.equal(node("tickets.index").labelFrom?.from, "menu");
    assert.equal(node("tickets.park").label, "Park ticket");
    assert.equal(node("tickets.close").labelFrom, undefined, "'Save' says nothing about the step");
    assert.equal(map.features.find((f) => f.nodes.includes("route:tickets.index"))!.name, "Support tickets");
  });
});

describe("how tables relate (ERD)", () => {
  it("joins migration foreign keys with model relations and draws one diagram per group", async () => {
    const model = (cls: string, body: string, table?: string) =>
      `<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass ${cls} extends Model {${table ? ` protected $table = '${table}';` : ""}\n${body}\n}\n`;
    const map = await scan({
      "database/migrations/2024_01_01_000000_create_orders.php": migration(`
        Schema::create('customers', function (Blueprint $table) { $table->id(); $table->string('name'); });
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('customer_id')->constrained();
            $table->string('status');
        });`),
      "app/Models/Customer.php": model("Customer", "public function orders() { return $this->hasMany(Order::class); }"),
      "app/Models/Order.php": model("Order", "public function customer() { return $this->belongsTo(Customer::class); }\npublic function items() { return $this->hasMany(OrderItem::class, 'order_no', 'no'); }\npublic function tags() { return $this->belongsToMany(Tag::class); }"),
      "app/Models/OrderItem.php": model("OrderItem", "", "T_OrderItem"),
      "app/Models/Tag.php": model("Tag", ""),
    });
    const rels = map.data!.relations!;
    const fk = rels.find((r) => r.from === "orders" && r.to === "customers")!;
    assert.deepEqual(fk.found.sort(), ["migration", "model"], "the migration's key and both model methods are one relation");
    assert.deepEqual(fk.methods!.sort(), ["Customer::orders()", "Order::customer()"]);
    const items = rels.find((r) => r.from === "T_OrderItem")!;
    assert.equal(items.column, "order_no");
    assert.equal(items.toColumn, "no");
    assert.deepEqual(items.found, ["model"]);
    const m2m = rels.find((r) => r.kind === "many-to-many")!;
    assert.equal(m2m.via, "order_tag", "pivot named by Laravel's rule");
    assert.equal(m2m.by, "convention");

    const { renderDocs } = await import("../src/docs/index.js");
    const docs = await renderDocs(map);
    const data = docs.markdown.get("data-dictionary.md")!;
    assert.match(data, /## How the tables relate/);
    assert.match(data, /```mermaid\nerDiagram[\s\S]*customers \|\|--o\{ orders : "customer_id"/);
    assert.match(data, /orders }o--o\{ tags : "via order_tag"/);
    assert.match(data, /\*\*Points to\*\*: customers by customer_id/);
    assert.match(docs.html, /<svg class="erd/);
  });

  it("lists lookup tables that many others point at instead of drawing every arrow", async () => {
    const files: Record<string, string> = {
      "app/Models/Employee.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Employee extends Model {}\n",
    };
    for (const n of ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]) {
      files[`app/Models/${n}.php`] = `<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass ${n} extends Model { public function owner() { return $this->belongsTo(Employee::class, 'owner_nik', 'nik'); } }\n`;
    }
    const map = await scan(files);
    const { erdModel } = await import("../src/docs/erd.js");
    const { groups, hubs } = erdModel(map);
    assert.equal(hubs[0].table, "employees");
    assert.equal(hubs[0].usedBy.length, 6);
    assert.equal(groups.length, 0, "with the lookup listed, nothing is left to draw");
  });
});

describe("branches decided by the values passed in", () => {
  let map: BuiltMap;
  before(async () => {
    map = await scan({
      "routes/web.php": `<?php
use App\\Http\\Controllers\\MemoController;
use Illuminate\\Support\\Facades\\Route;
Route::post('/memos/submit', [MemoController::class, 'submit'])->name('memos.submit');
Route::post('/memos/hold', [MemoController::class, 'hold'])->name('memos.hold');
Route::post('/memos/revise', [MemoController::class, 'revise'])->name('memos.revise');
`,
      "app/Models/Memo.php": "<?php\nnamespace App\\Models;\nuse Illuminate\\Database\\Eloquent\\Model;\nclass Memo extends Model { protected $table = 'memos'; }\n",
      "app/Support/Constant.php": "<?php\nnamespace App\\Support;\nclass Constant { const SUBMIT = 'S'; const APPROVE = 'A'; const HOLD = 'H'; const REVISE = 'REV'; const STATUS_CLOSED = 'C'; }\n",
      "app/Services/MemoFlow.php": `<?php
namespace App\\Services;
use Illuminate\\Support\\Facades\\DB;
class MemoFlow {
    public function approve($no, $role, $status) {
        if ($role == 'lead') { DB::table('memos')->where('no', $no)->update(['status' => 'C']); return 'True'; }
        if (!in_array($role, ['head', 'final', 'deputy'])) { return 'Not in the approval chain'; }
        if (in_array($role, ['head', 'deputy'])) { DB::table('memos')->where('no', $no)->update(['status' => $status]); }
        if ($role == 'final') { DB::table('memos')->where('no', $no)->update(['status' => 'C']); }
        return 'True';
    }
    public function hold($no, $status) {
        if (!in_array($status, ['H', 'REV'])) { return 'Unknown status'; }
        if ($status == 'H' || $status == 'O') { DB::table('memos')->where('no', $no)->update(['status' => $status]); }
        else { DB::table('memos')->where('no', $no)->update(['status' => 'S']); }
        return 'True';
    }
}
`,
      "app/Http/Controllers/MemoController.php": `<?php
namespace App\\Http\\Controllers;
use App\\Services\\MemoFlow;
use App\\Support\\Constant;
use Illuminate\\Http\\Request;
class MemoController extends Controller {
    public function submit(Request $request) { $this->run($request, Constant::SUBMIT); return back(); }
    public function hold(Request $request) { $this->run($request, Constant::HOLD); return back(); }
    public function revise(Request $request) { $this->run($request, Constant::REVISE); return back(); }
    private function run(Request $request, $status) {
        $flow = new MemoFlow;
        if (in_array($status, [Constant::APPROVE, Constant::SUBMIT])) { $flow->approve($request->no, session('role'), $status); }
        else { $flow->hold($request->no, $status); }
    }
}
`,
    });
  });
  const step = (id: string) => map.processes!.find((p) => p.subject === "Memo.status")!.steps.find((s) => s.node === `route:${id}`)!;
  const vals = (ids: string[]) => ids.map((x) => x.split("=")[1]).sort();

  it("follows only the branch in_array(...) and || pick for the value passed in", () => {
    assert.deepEqual(vals(step("memos.hold").to), ["H"]);
    assert.deepEqual(vals(step("memos.revise").to), ["S"]);
  });

  it("names a short literal ('C') after the one status constant with that value", () => {
    const p = map.processes!.find((x) => x.subject === "Memo.status")!;
    assert.equal(p.states.find((s) => s.value === "C")?.label, "Closed");
  });

  it("does not chain writes in branches on different values of the same variable", () => {
    const s = step("memos.submit");
    assert.deepEqual(vals(s.to), ["C", "S"]);
    assert.ok(!(s.paths ?? []).some((p) => p.length > 1), JSON.stringify(s.paths));
  });
});

describe("status sequences and branches", () => {
  it("skips a branch that cannot run with the values passed in (review($order, 'pass'))", async () => {
    const map = (await scanProject(dirs.find((d) => existsSync(join(d, "app/Services/OrderWorkflow.php")))!, { mode: "static" })).map;
    const p = map.processes!.find((x) => x.subject === "Order.status_id")!;
    const store = p.steps.find((s) => s.node === "route:orders.store")!;
    assert.ok(!store.paths!.flat().some((id) => id.endsWith("=2")), "Approved is not written when mode is pass");
  });

  it("reads if (…) { …; return; } as a branch: hold or reject, not hold then reject", async () => {
    const map = (await scanProject(dirs.find((d) => existsSync(join(d, "app/Services/OrderWorkflow.php")))!, { mode: "static" })).map;
    const p = map.processes!.find((x) => x.subject === "Order.status_id")!;
    const decide = p.steps.find((s) => s.node === "route:orders.decide")!;
    assert.deepEqual(decide.to.map((id) => id.split("=")[1]).sort(), ["3", "6"]);
    assert.equal(decide.paths, undefined, "each branch writes one status");
  });
});

describe("project and glossary edits", () => {
  it("saves the project summary and renames or removes glossary terms", async () => {
    const dir = project({});
    saveEdit(dir, { target: "project", id: "project", fields: { name: "Shop", summary: "Sells things." } });
    saveEdit(dir, { target: "glossary", id: "SKU", fields: { definition: "Stock keeping unit" } });
    saveEdit(dir, { target: "glossary", id: "Sku code", fields: { definition: "Stock keeping unit", from: "SKU" } });
    saveEdit(dir, { target: "glossary", id: "Tmp", fields: { definition: "x" } });
    saveEdit(dir, { target: "glossary", id: "Tmp", fields: { definition: "" } });
    const edits = loadEdits(dir);
    assert.deepEqual(edits.project, { name: "Shop", summary: "Sells things." });
    assert.deepEqual(edits.glossary, { "Sku code": "Stock keeping unit" });
    const { raw } = await scanProject(dir, { mode: "static" });
    const map = applyEdits(raw, edits);
    assert.equal(map.project.title, "Shop");
    assert.equal(map.project.summary, "Sells things.");
    saveEdit(dir, { target: "project", id: "project", fields: { summary: "" } });
    assert.deepEqual(loadEdits(dir).project, { name: "Shop" });
  });
});
