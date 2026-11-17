/**
 * Patterns for the documentation layer that the fixtures do not cover, each in
 * a tiny generated Laravel project.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
