/**
 * Automation: what runs without a user clicking anything.
 *   Scheduler  routes/console.php (Schedule::…), app/Console/Kernel.php and
 *              bootstrap/app.php withSchedule() ($schedule->…)
 *   Commands   classes with a $signature, and Artisan::command() closures
 *   Jobs       app/Jobs/*, where they are dispatched, and the statuses they change
 * Frequencies are kept as written; a plain-English reading is added only when
 * every call in the chain is known.
 */
import type { BackgroundWrite, ConsoleCommand, QueuedJob, ScheduledTask, SkippedFact, SourceRef, StatusValue } from "../../core/types.js";
import { phpFiles, type PhpCache } from "./files.js";
import { flattenChain, lineOf, phpText, resolveClass, resolveName, stringValue, walk, type ChainStep, type NameContext, type PhpNode } from "./php.js";
import { STATUS_COLUMN, type ProcessReader } from "./process.js";

export interface AutomationResult {
  schedule: ScheduledTask[];
  commands: ConsoleCommand[];
  jobs: QueuedJob[];
  skipped: SkippedFact[];
}

const SCHEDULE_FILES = ["routes/console.php", "app/Console/Kernel.php", "bootstrap/app.php"];

export function readAutomation(root: string, php: PhpCache, reader: ProcessReader): AutomationResult {
  const skipped: SkippedFact[] = [];
  const commands = readCommands(root, php, reader, skipped);
  const jobs = readJobs(root, php, reader);
  const byClass = new Map(commands.filter((c) => c.class).map((c) => [c.class!, c]));
  const schedule: ScheduledTask[] = [];

  for (const file of SCHEDULE_FILES) {
    const parsed = php.get(file);
    if (!parsed) continue;
    const { ast, names } = parsed;
    const scheduleVars = new Set<string>(["schedule"]);
    walk(ast, (n) => {
      // function (Schedule $s) { ... }
      for (const p of n.arguments ?? []) {
        if (n.kind !== "method" && n.kind !== "closure" && n.kind !== "arrowfunc") break;
        if (/(^|\\)Schedule$/.test(p.type?.name ?? "")) scheduleVars.add(p.name?.name ?? p.name);
      }
    });
    const consumed = new WeakSet<object>();
    walk(ast, (n) => {
      if (n.kind !== "call" || consumed.has(n)) return;
      const chain = flattenChain(n);
      if (!chain) return;
      let inner = n.what?.what;
      while (inner?.kind === "call") {
        consumed.add(inner);
        inner = inner.what?.what;
      }
      const src: SourceRef = { file, line: lineOf(n) };
      const rootClass = chain.root.type === "static" ? resolveClass(chain.root.class, names) ?? "" : "";
      const onScheduleVar = chain.root.type === "other" && baseVar(n) !== null && scheduleVars.has(baseVar(n)!);

      // Artisan::command('sig', fn)->purpose('…')[->schedule()->daily()]
      if (/(^|\\)Artisan$/.test(rootClass) && chain.steps[0].name === "command") {
        const sig = stringValue(chain.steps[0].args[0]);
        if (!sig) {
          skipped.push({ kind: "skipped", reason: `Command signature not readable: ${phpText(chain.steps[0].args[0])}`, source: src });
          return;
        }
        const purpose = chain.steps.find((s) => s.name === "purpose" || s.name === "describe");
        const closure = chain.steps[0].args[1];
        const writes = closure ? backgroundWrites(closure, names, file, reader) : [];
        const cmd: ConsoleCommand = { name: commandName(sig), signature: sig, description: purpose ? stringValue(purpose.args[0]) ?? undefined : undefined, writes, source: src };
        // The sample command every new Laravel app ships with
        if (cmd.name === "inspire" && /inspiring quote/i.test(cmd.description ?? "")) return false;
        commands.push(cmd);
        const schedIdx = chain.steps.findIndex((s) => s.name === "schedule");
        if (schedIdx >= 0) schedule.push(task({ kind: "command", name: cmd.name }, chain.steps.slice(schedIdx + 1), src));
        return false;
      }

      if (!/(^|\\)Schedule$/.test(rootClass) && !onScheduleVar) return;
      const [first, ...rest] = chain.steps;
      let runs: ScheduledTask["runs"] | null = null;
      if (first.name === "command") {
        const arg = first.args[0];
        const s = stringValue(arg);
        if (s) runs = { kind: "command", name: commandName(s) };
        else if (arg?.kind === "staticlookup" && (arg.offset?.name ?? "") === "class") {
          const cls = resolveClass(arg, names);
          const cmd = cls ? byClass.get(cls) : undefined;
          runs = { kind: "command", name: cmd?.name ?? cls?.split("\\").pop() ?? phpText(arg) };
        }
      } else if (first.name === "job") {
        const arg = first.args[0];
        const cls =
          arg?.kind === "new" && arg.what?.kind === "name"
            ? resolveName(arg.what.name, arg.what.resolution, names)
            : arg?.kind === "staticlookup"
              ? resolveClass(arg, names)
              : null;
        if (cls) {
          runs = { kind: "job", name: cls };
          const job = jobs.find((j) => j.class === cls);
          job?.dispatchedFrom.push(src);
        }
      } else if (first.name === "call") {
        runs = { kind: "closure", name: "code in the scheduler" };
      } else if (first.name === "exec") {
        const s = stringValue(first.args[0]);
        runs = { kind: "exec", name: s ?? phpText(first.args[0]) };
      } else {
        return; // Schedule::useCache(), timezone() … are not tasks
      }
      if (!runs) {
        skipped.push({ kind: "skipped", reason: `Scheduled task not readable: ${phpText(n).slice(0, 120)}`, source: src });
        return false;
      }
      schedule.push(task(runs, rest, src));
      return false;
    });
  }

  // Where jobs are dispatched
  const jobByClass = new Map(jobs.map((j) => [j.class, j]));
  for (const file of [...phpFiles(root, "app"), ...phpFiles(root, "routes")]) {
    const parsed = php.get(file);
    if (!parsed) continue;
    walk(parsed.ast, (n) => {
      const cls = dispatchedClass(n, parsed.names);
      const job = cls ? jobByClass.get(cls) : undefined;
      if (job && !job.dispatchedFrom.some((s) => s.file === file && s.line === lineOf(n))) job.dispatchedFrom.push({ file, line: lineOf(n) });
    });
  }

  return { schedule, commands: commands.sort((a, b) => a.name.localeCompare(b.name)), jobs, skipped };
}

function baseVar(n: PhpNode): string | null {
  let cur = n;
  while (cur) {
    if (cur.kind === "call" || cur.kind === "propertylookup") cur = cur.what;
    else if (cur.kind === "variable") return typeof cur.name === "string" ? cur.name : null;
    else return null;
  }
  return null;
}

/** X::dispatch(…), dispatch(new X), Bus::dispatch(new X), X::dispatchSync/dispatchIf/… */
function dispatchedClass(n: PhpNode, names: NameContext): string | null {
  if (n.kind !== "call") return null;
  if (n.what?.kind === "staticlookup" && /^dispatch/.test(n.what.offset?.name ?? "") && n.what.what?.kind === "name") {
    const short = n.what.what.name;
    if (short === "Bus" || /\\Bus$/.test(short)) {
      const a = n.arguments?.[0];
      return a?.kind === "new" && a.what?.kind === "name" ? resolveName(a.what.name, a.what.resolution, names) : null;
    }
    return resolveName(short, n.what.what.resolution, names);
  }
  if (n.what?.kind === "name" && /^\\?dispatch(_sync)?$/.test(n.what.name)) {
    const a = n.arguments?.[0];
    return a?.kind === "new" && a.what?.kind === "name" ? resolveName(a.what.name, a.what.resolution, names) : null;
  }
  return null;
}

function readCommands(root: string, php: PhpCache, reader: ProcessReader, skipped: SkippedFact[]): ConsoleCommand[] {
  const out: ConsoleCommand[] = [];
  for (const file of phpFiles(root, "app/Console")) {
    const parsed = php.get(file);
    if (!parsed) continue;
    walk(parsed.ast, (n) => {
      if (n.kind !== "class") return;
      const props = classProps(n);
      const sig = props.get("signature");
      const nameProp = props.get("name");
      const signature = sig ? stringValue(sig) : nameProp ? stringValue(nameProp) : null;
      if (!sig && !nameProp) return false;
      const short = n.name?.name ?? n.name;
      const fq = parsed.names.namespace ? `${parsed.names.namespace}\\${short}` : short;
      if (!signature) {
        skipped.push({ kind: "skipped", reason: `Command signature not readable in ${short}`, source: { file, line: lineOf(n) } });
        return false;
      }
      const desc = props.get("description");
      const handle = (n.body ?? []).find((m: PhpNode) => m.kind === "method" && (m.name?.name ?? m.name) === "handle");
      out.push({
        name: commandName(signature),
        signature,
        class: fq,
        description: desc ? stringValue(desc) ?? undefined : undefined,
        writes: handle ? backgroundWrites(handle, parsed.names, file, reader, fq) : [],
        source: { file, line: lineOf(n) },
      });
      return false;
    });
  }
  return out;
}

function readJobs(root: string, php: PhpCache, reader: ProcessReader): QueuedJob[] {
  const out: QueuedJob[] = [];
  for (const file of phpFiles(root, "app/Jobs")) {
    const parsed = php.get(file);
    if (!parsed) continue;
    walk(parsed.ast, (n) => {
      if (n.kind !== "class") return;
      const short = n.name?.name ?? n.name;
      const fq = parsed.names.namespace ? `${parsed.names.namespace}\\${short}` : short;
      const queued = (n.implements ?? []).some((i: PhpNode) => /(^|\\)ShouldQueue$/.test(i?.name ?? ""));
      const handle = (n.body ?? []).find((m: PhpNode) => m.kind === "method" && (m.name?.name ?? m.name) === "handle");
      out.push({
        class: fq,
        queued,
        writes: handle ? backgroundWrites(handle, parsed.names, file, reader, fq) : [],
        dispatchedFrom: [],
        source: { file, line: lineOf(n) },
      });
      return false;
    });
  }
  return out;
}

/** Status writes in a handle() or closure, plus where('status', X) on the same query. */
function backgroundWrites(body: PhpNode, names: NameContext, file: string, reader: ProcessReader, selfClass?: string): BackgroundWrite[] {
  const info = reader.analyzeHandler(body, names, file, selfClass);
  const conditions = new Map<number, StatusValue[]>();
  walk(body, (n) => {
    if (n.kind !== "call" || n.what?.offset?.name !== "update") return;
    const chain = flattenChain(n);
    if (!chain) return;
    const values: StatusValue[] = [];
    for (const s of chain.steps) values.push(...whereStatus(s, names, reader, selfClass));
    const line = lineOf(n);
    if (values.length && line !== undefined) conditions.set(line, values);
  });
  return info.writes.map((w) => {
    const when = w.source.line !== undefined ? conditions.get(w.source.line) : undefined;
    return when ? { ...w, when } : { ...w };
  });
}

function whereStatus(s: ChainStep, names: NameContext, reader: ProcessReader, selfClass?: string): StatusValue[] {
  const col = stringValue(s.args[0]);
  if (!col || !STATUS_COLUMN.test(col)) return [];
  if (s.name === "where" && s.args.length === 2) {
    const v = reader.value(s.args[1], names, selfClass);
    return v ? [v] : [];
  }
  if (s.name === "where" && s.args.length === 3 && stringValue(s.args[1]) === "=") {
    const v = reader.value(s.args[2], names, selfClass);
    return v ? [v] : [];
  }
  if (s.name === "whereIn" && s.args[1]?.kind === "array") {
    return s.args[1].items.map((i: PhpNode) => reader.value(i?.kind === "entry" ? i.value : i, names, selfClass)).filter((v: StatusValue | null): v is StatusValue => Boolean(v));
  }
  return [];
}

function classProps(cls: PhpNode): Map<string, PhpNode> {
  const out = new Map<string, PhpNode>();
  for (const m of cls.body ?? []) {
    if (m.kind !== "propertystatement") continue;
    for (const p of m.properties ?? []) out.set(p.name?.name ?? p.name, p.value);
  }
  return out;
}

/** "purchase-requests:remind {--days=2}" -> "purchase-requests:remind" */
export function commandName(signature: string): string {
  return signature.trim().split(/\s+/)[0];
}

function task(runs: ScheduledTask["runs"], steps: ChainStep[], source: SourceRef): ScheduledTask {
  const freq: ChainStep[] = [];
  const options: string[] = [];
  let description: string | undefined;
  for (const s of steps) {
    if (s.name === "description" || s.name === "name") description = stringValue(s.args[0]) ?? description;
    else if (OPTIONS[s.name]) options.push(OPTIONS[s.name]);
    else freq.push(s);
  }
  const when = freq.map((s) => `${s.name}(${s.args.map((a) => phpText(a)).join(", ")})`).join("->");
  const t: ScheduledTask = { runs, when: when || "(no frequency set)", options, source };
  const text = frequencyText(freq);
  if (text) t.whenText = text;
  if (description) t.description = description;
  return t;
}

const OPTIONS: Record<string, string> = {
  withoutOverlapping: "never runs twice at the same time",
  onOneServer: "runs on one server only",
  runInBackground: "runs in the background",
  evenInMaintenanceMode: "runs even in maintenance mode",
  onSuccess: "has a success hook",
  onFailure: "has a failure hook",
  emailOutputTo: "emails its output",
  emailOutputOnFailure: "emails its output on failure",
  sendOutputTo: "writes its output to a file",
  appendOutputTo: "appends its output to a file",
  pingBefore: "pings a URL before running",
  thenPing: "pings a URL after running",
  before: "runs code before",
  after: "runs code after",
  then: "runs code after",
};

const EVERY: Record<string, string> = {
  everySecond: "Every second",
  everyTwoSeconds: "Every 2 seconds",
  everyFiveSeconds: "Every 5 seconds",
  everyTenSeconds: "Every 10 seconds",
  everyFifteenSeconds: "Every 15 seconds",
  everyTwentySeconds: "Every 20 seconds",
  everyThirtySeconds: "Every 30 seconds",
  everyMinute: "Every minute",
  everyTwoMinutes: "Every 2 minutes",
  everyThreeMinutes: "Every 3 minutes",
  everyFourMinutes: "Every 4 minutes",
  everyFiveMinutes: "Every 5 minutes",
  everyTenMinutes: "Every 10 minutes",
  everyFifteenMinutes: "Every 15 minutes",
  everyThirtyMinutes: "Every 30 minutes",
  hourly: "Every hour",
  everyTwoHours: "Every 2 hours",
  everyThreeHours: "Every 3 hours",
  everyFourHours: "Every 4 hours",
  everySixHours: "Every 6 hours",
  daily: "Every day at 00:00",
  weekly: "Every Sunday at 00:00",
  monthly: "On the 1st of every month at 00:00",
  quarterly: "On the first day of every quarter at 00:00",
  yearly: "Every 1 January at 00:00",
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_FILTERS: Record<string, string> = {
  weekdays: "weekdays",
  weekends: "weekends",
  sundays: "Sundays",
  mondays: "Mondays",
  tuesdays: "Tuesdays",
  wednesdays: "Wednesdays",
  thursdays: "Thursdays",
  fridays: "Fridays",
  saturdays: "Saturdays",
};

/** Plain English for a frequency chain; undefined when any call is unknown or not literal. */
export function frequencyText(steps: ChainStep[]): string | undefined {
  if (!steps.length) return undefined;
  let base: string | undefined;
  let at: string | undefined;
  const filters: string[] = [];
  const lit = (s: ChainStep, i: number) => (s.args[i] ? stringValue(s.args[i]) ?? (s.args[i].kind === "number" ? String(s.args[i].value) : null) : null);
  for (const s of steps) {
    if (EVERY[s.name]) {
      base = EVERY[s.name];
      continue;
    }
    if (DAY_FILTERS[s.name]) {
      filters.push(DAY_FILTERS[s.name]);
      continue;
    }
    switch (s.name) {
      case "dailyAt":
      case "at": {
        const t = lit(s, 0);
        if (!t) return undefined;
        base = base && s.name === "at" ? base : "Every day";
        at = t;
        break;
      }
      case "hourlyAt": {
        const m = lit(s, 0);
        if (!m) return undefined;
        base = `Every hour at minute ${m}`;
        break;
      }
      case "twiceDaily": {
        const a = lit(s, 0) ?? "1";
        const b = lit(s, 1) ?? "13";
        base = `Every day at ${pad(a)}:00 and ${pad(b)}:00`;
        break;
      }
      case "weeklyOn": {
        const d = lit(s, 0);
        const t = lit(s, 1) ?? "0:00";
        if (d === null || !DAYS[Number(d)]) return undefined;
        base = `Every ${DAYS[Number(d)]}`;
        at = t;
        break;
      }
      case "monthlyOn": {
        const d = lit(s, 0) ?? "1";
        const t = lit(s, 1) ?? "0:00";
        base = `On day ${d} of every month`;
        at = t;
        break;
      }
      case "lastDayOfMonth": {
        base = "On the last day of every month";
        at = lit(s, 0) ?? "0:00";
        break;
      }
      case "between":
      case "unlessBetween": {
        const a = lit(s, 0);
        const b = lit(s, 1);
        if (!a || !b) return undefined;
        filters.push(`${s.name === "between" ? "only between" : "not between"} ${a} and ${b}`);
        break;
      }
      case "days": {
        const v = s.args[0]?.kind === "array" ? s.args[0].items.map((i: PhpNode) => lit({ name: "", args: [i?.kind === "entry" ? i.value : i] }, 0)) : [];
        if (!v.length || v.some((x: string | null) => x === null || !DAYS[Number(x)])) return undefined;
        filters.push(`on ${v.map((x: string) => DAYS[Number(x)]).join(", ")}`);
        break;
      }
      case "cron": {
        const c = lit(s, 0);
        if (!c) return undefined;
        base = `Cron "${c}"`;
        break;
      }
      case "timezone": {
        const tz = lit(s, 0);
        if (!tz) return undefined;
        filters.push(`(${tz} time)`);
        break;
      }
      case "environments": {
        const envs = s.args.map((a) => stringValue(a)).filter(Boolean);
        filters.push(`only in ${envs.join(", ")}`);
        break;
      }
      case "when":
      case "skip":
        filters.push(s.name === "when" ? "only when a condition in code is true" : "skipped when a condition in code is true");
        break;
      default:
        return undefined;
    }
  }
  if (!base) return undefined;
  if (at) base = base.replace(/ at 00:00$/, "") + ` at ${normalizeTime(at)}`;
  const dayFilter = filters.filter((f) => /^(weekdays|weekends|[A-Z][a-z]+days)$/.test(f));
  const others = filters.filter((f) => !dayFilter.includes(f));
  let text = base;
  if (dayFilter.length && /^Every (day|hour|minute|\d+ \w+)/.test(text)) {
    text = text.replace(/^Every day/, dayFilter.map(cap).join(", ")).replace(/^Every (hour|minute|\d+ \w+)/, `Every $1 on ${dayFilter.join(", ")}`);
  } else if (dayFilter.length) {
    text += `, ${dayFilter.join(", ")} only`;
  }
  if (others.length) text += `, ${others.join(", ")}`;
  return text;
}

function pad(h: string): string {
  return h.length === 1 ? `0${h}` : h;
}

function normalizeTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? `${pad(m[1])}:${m[2]}` : t;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
