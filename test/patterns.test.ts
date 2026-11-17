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
