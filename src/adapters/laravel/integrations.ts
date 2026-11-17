/**
 * Integrations: the outside systems the app talks to.
 *   HTTP      Http::get/post/… (base URL from a literal, config() or env())
 *   Mail      Mail::to()->send(new X), Mail::send/queue/raw
 *   Notify    $x->notify(new N), Notification::send(…, new N) + channels from N::via()
 *   Storage   Storage::disk('s3')->put(…), Storage::put(…), $request->file()->store(…, 's3')
 * Each call is recorded with the class and method that makes it. A URL or disk
 * that is built at runtime is recorded as such and reported, never guessed.
 */
import type { IntegrationUsage, SkippedFact } from "../../core/types.js";
import type { ClassLocator } from "./controllers.js";
import { phpFiles, type PhpCache } from "./files.js";
import { flattenChain, lineOf, phpText, resolveClass, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";

export interface IntegrationResult {
  usages: IntegrationUsage[];
  skipped: SkippedFact[];
}

const HTTP_VERBS = /^(get|post|put|patch|delete|head|send)$/;
const STORAGE_OPS = /^(put|putFile|putFileAs|get|delete|exists|missing|download|url|temporaryUrl|copy|move|append|prepend|writeStream|readStream|files|allFiles|makeDirectory|deleteDirectory|path|size|lastModified|response)$/;

export function readIntegrations(root: string, php: PhpCache, locator: ClassLocator, configEnv: Map<string, string[]>): IntegrationResult {
  const usages: IntegrationUsage[] = [];
  const skipped: SkippedFact[] = [];
  const channelsCache = new Map<string, string[] | null>();

  const files = [...phpFiles(root, "app"), ...phpFiles(root, "routes")];
  for (const file of files) {
    const parsed = php.get(file);
    if (!parsed) continue;
    const { ast, names } = parsed;
    visitScopes(ast, names, (scope, body, ownClosures) => {
      const consumed = new WeakSet<object>();
      walk(body, (n) => {
        // Outside classes, nested closures are their own scope (route closures inside a group).
        if (!ownClosures && (n.kind === "closure" || n.kind === "arrowfunc")) return false;
        if (n.kind !== "call" || consumed.has(n)) return;
        const chain = flattenChain(n);
        if (!chain) return;
        let inner = n.what?.what;
        while (inner?.kind === "call") {
          consumed.add(inner);
          inner = inner.what?.what;
        }
        const line = lineOf(n);
        const src = { file, line };
        const rootClass = chain.root.type === "static" ? resolveClass(chain.root.class, names) ?? "" : "";
        const steps = chain.steps;
        const last = steps[steps.length - 1];

        // ---- HTTP
        if (/(^|\\)Http$/.test(rootClass)) {
          const verb = steps.find((s) => HTTP_VERBS.test(s.name) && s !== steps[0]) ?? (HTTP_VERBS.test(steps[0].name) ? steps[0] : undefined);
          if (!verb) return;
          const urlArg = verb.name === "send" ? verb.args[1] : verb.args[0];
          const base = steps.find((s) => s.name === "baseUrl")?.args[0];
          const method = verb.name === "send" ? stringValue(verb.args[0])?.toUpperCase() ?? "?" : verb.name.toUpperCase();
          const target = urlTarget(urlArg, base, configEnv);
          if (target.dynamic) {
            skipped.push({ kind: "skipped", reason: `HTTP call with a URL built at runtime: ${phpText(urlArg)}`, source: src });
          }
          // Credentials and headers: withToken(config('services.erp.token')) -> ERP_TOKEN
          const env = [...(target.env ?? [])];
          for (const s of steps) {
            if (s === verb) continue;
            for (const a of s.args) {
              walk(a, (x) => {
                if (x.kind !== "call" || x.what?.kind !== "name") return;
                const fn = x.what.name.replace(/^\\/, "");
                const key = stringValue(x.arguments?.[0]);
                if (!key) return;
                const keys = fn === "config" ? configEnv.get(key) ?? [] : fn === "env" ? [key] : [];
                for (const k of keys) if (!env.includes(k)) env.push(k);
              });
            }
          }
          usages.push({ kind: "http", target: target.key, name: target.name, method, path: target.path, env: env.length ? env : undefined, in: scope, source: src });
          return;
        }

        // ---- Mail
        if (/(^|\\)Mail$/.test(rootClass)) {
          const send = steps.find((s) => /^(send|queue|later|sendNow|raw|html|plain)$/.test(s.name));
          if (!send) return;
          const arg = send.name === "later" ? send.args[1] : send.args[0];
          const cls = newClass(arg, names);
          const name = cls ? cls.split("\\").pop()! : send.name === "raw" ? "plain-text email" : stringValue(arg) ? `email view ${stringValue(arg)}` : `email (${phpText(arg) || "built at runtime"})`;
          usages.push({ kind: "mail", target: `mail:${cls ?? name}`, name, operation: send.name, in: scope, source: src });
          return;
        }

        // ---- Notifications
        const notifyStep = steps.find((s) => s.name === "notify" || s.name === "notifyNow");
        const notificationSend = /(^|\\)Notification$/.test(rootClass) && (last.name === "send" || last.name === "sendNow");
        if (notifyStep || notificationSend) {
          const arg = notificationSend ? last.args[1] : notifyStep!.args[0];
          const cls = newClass(arg, names);
          if (!cls) {
            skipped.push({ kind: "skipped", reason: `Notification class not readable: ${phpText(arg)}`, source: src });
            return;
          }
          let channels = channelsCache.get(cls);
          if (channels === undefined) {
            channels = notificationChannels(cls, locator, skipped);
            channelsCache.set(cls, channels);
          }
          const routed = steps.filter((s) => s.name === "route").map((s) => stringValue(s.args[0])).filter((x): x is string => Boolean(x));
          usages.push({
            kind: "notification",
            target: `notification:${cls}`,
            name: cls.split("\\").pop()!,
            channels: channels ?? undefined,
            operation: routed.length ? `on-demand via ${routed.join(", ")}` : undefined,
            in: scope,
            source: src,
          });
          return;
        }

        // ---- Storage
        if (/(^|\\)Storage$/.test(rootClass)) {
          const diskStep = steps.find((s) => s.name === "disk" || s.name === "cloud" || s.name === "build");
          const op = steps.find((s) => STORAGE_OPS.test(s.name) && s !== diskStep);
          if (!op) return;
          let disk = "default disk";
          if (diskStep?.name === "cloud") disk = "cloud disk";
          else if (diskStep?.name === "build") disk = "disk built at runtime";
          else if (diskStep) {
            const d = stringValue(diskStep.args[0]);
            if (d) disk = d;
            else {
              disk = `disk ${phpText(diskStep.args[0])}`;
              skipped.push({ kind: "skipped", reason: `Storage disk not readable: ${phpText(diskStep.args[0])}`, source: src });
            }
          }
          usages.push(storageUsage(disk, op.name, configEnv, scope, src));
          return;
        }
        // $request->file('x')->store('dir', 's3')
        const storeIdx = steps.findIndex((s) => /^(store|storeAs|storePublicly|storePubliclyAs)$/.test(s.name));
        if (storeIdx > 0 && steps.slice(0, storeIdx).some((s) => s.name === "file")) {
          const s = steps[storeIdx];
          const diskArg = /As$/.test(s.name) ? s.args[2] : s.args[1];
          let disk = "default disk";
          if (diskArg) {
            const d = stringValue(diskArg) ?? (diskArg.kind === "array" ? diskArrayValue(diskArg) : null);
            if (d) disk = d;
            else {
              disk = `disk ${phpText(diskArg)}`;
              skipped.push({ kind: "skipped", reason: `Storage disk not readable: ${phpText(diskArg)}`, source: src });
            }
          }
          usages.push(storageUsage(disk, s.name, configEnv, scope, src));
        }
      });
    });
  }
  return { usages, skipped };
}

function storageUsage(disk: string, op: string, configEnv: Map<string, string[]>, scope: IntegrationUsage["in"], source: IntegrationUsage["source"]): IntegrationUsage {
  const env = configEnv.get(`filesystems.disks.${disk}`);
  return { kind: "storage", target: `disk:${disk}`, name: disk, operation: op, env: env?.length ? [...env] : undefined, in: scope, source };
}

function diskArrayValue(arr: PhpNode): string | null {
  for (const it of arr.items ?? []) if (it?.kind === "entry" && stringValue(it.key) === "disk") return stringValue(it.value);
  return null;
}

interface UrlTarget {
  key: string;
  name: string;
  path?: string;
  env?: string[];
  dynamic?: boolean;
}

/**
 * config('services.erp.url') . '/purchase-requests'  -> services.erp (ERP_URL), path /purchase-requests
 * env('PORTAL_URL') . '/api/validate/' . $nik        -> PORTAL_URL, path /api/validate/{nik}
 * 'https://api.example.com/v1/items'                 -> api.example.com, path /v1/items
 */
export function urlTarget(url: PhpNode, base: PhpNode | undefined, configEnv: Map<string, string[]>): UrlTarget {
  const parts = concatParts(url);
  if (base && parts.length && parts[0].kind === "string" && !/^https?:\/\//i.test(parts[0].value)) parts.unshift(...concatParts(base));
  if (!parts.length) return { key: `dynamic:${phpText(url)}`, name: `URL built at runtime (${phpText(url)})`, dynamic: true };
  const head = parts[0];
  const rest = parts.slice(1);
  const pathOf = (nodes: PhpNode[]) => {
    const p = nodes.map((x) => (x.kind === "string" ? x.value : x.kind === "variable" ? `{${x.name}}` : x.kind === "propertylookup" ? `{${x.offset?.name ?? "…"}}` : "{…}")).join("");
    return p || undefined;
  };
  if (head.kind === "string") {
    const m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(head.value);
    if (m) {
      const host = m[1].replace(/^https?:\/\//i, "");
      return { key: `host:${host}`, name: host, path: pathOf([{ kind: "string", value: m[2] }, ...rest]) };
    }
    return { key: `dynamic:${phpText(url)}`, name: `URL built at runtime (${phpText(url)})`, dynamic: true };
  }
  if (head.kind === "call" && head.what?.kind === "name") {
    const fn = head.what.name.replace(/^\\/, "");
    const arg = stringValue(head.arguments?.[0]);
    if (fn === "config" && arg) {
      const env = configEnv.get(arg);
      const name = arg.split(".").length > 2 ? arg.split(".").slice(0, -1).join(".") : arg;
      return { key: `config:${name}`, name, path: pathOf(rest), env: env?.length ? [...env] : undefined };
    }
    if ((fn === "env" || fn === "getenv") && arg) return { key: `env:${arg}`, name: arg, path: pathOf(rest), env: [arg] };
  }
  return { key: `dynamic:${phpText(url)}`, name: `URL built at runtime (${phpText(url)})`, dynamic: true };
}

/** 'a' . $b . 'c' -> [a, $b, c] (encapsed strings too). */
function concatParts(n: PhpNode): PhpNode[] {
  if (!n) return [];
  if (n.kind === "bin" && n.type === ".") return [...concatParts(n.left), ...concatParts(n.right)];
  if (n.kind === "encapsed") {
    return (n.value ?? []).map((p: PhpNode) => (p?.expression?.kind === "string" ? { kind: "string", value: p.expression.value } : p?.expression)).filter(Boolean);
  }
  if (n.kind === "parenthesis") return concatParts(n.inner);
  return [n];
}

function newClass(arg: PhpNode, names: NameContext): string | null {
  if (arg?.kind === "new" && arg.what?.kind === "name") return resolveName(arg.what.name, arg.what.resolution, names);
  return null;
}

/** ['mail', 'database'] or [SlackChannel::class] returned by via(). */
function notificationChannels(fqcn: string, locator: ClassLocator, skipped: SkippedFact[]): string[] | null {
  const loaded = locator.load(fqcn);
  if (!loaded) return null;
  let via: PhpNode = null;
  walk(loaded.ast, (n) => {
    if (via) return false;
    if (n.kind === "method" && (n.name?.name ?? n.name) === "via") {
      via = n;
      return false;
    }
  });
  if (!via) return null;
  const out: string[] = [];
  let readable = true;
  walk(via, (n) => {
    if (n.kind !== "return") return;
    if (n.expr?.kind !== "array") {
      readable = false;
      return false;
    }
    for (const it of n.expr.items ?? []) {
      const v = it?.kind === "entry" ? it.value : it;
      const s = stringValue(v);
      if (s) out.push(s);
      else if (v?.kind === "staticlookup" && (v.offset?.name ?? "") === "class") out.push(resolveClass(v, loaded.names)?.split("\\").pop() ?? phpText(v));
      else readable = false;
    }
    return false;
  });
  if (!readable) {
    skipped.push({ kind: "skipped", reason: `Notification channels not readable in ${fqcn.split("\\").pop()}::via()`, source: { file: loaded.file, line: lineOf(via) } });
  }
  return out.length ? [...new Set(out)] : null;
}

/**
 * Call fn for every class method (scope = class + method) and for top-level
 * route closures (scope = file + "closure:<line>"), so each call is attributed
 * to the code that makes it.
 */
export function visitScopes(ast: PhpNode, names: NameContext, fn: (scope: NonNullable<IntegrationUsage["in"]>, body: PhpNode, ownClosures: boolean) => void): void {
  walk(ast, (n) => {
    if (n.kind === "class" || n.kind === "trait" || n.kind === "enum") {
      const short = n.name?.name ?? n.name;
      const fq = typeof short === "string" ? (names.namespace ? `${names.namespace}\\${short}` : short) : "anonymous class";
      for (const m of n.body ?? []) {
        if (m.kind === "method" && m.body) fn({ class: fq, method: m.name?.name ?? m.name }, m.body, true);
      }
      return false;
    }
    // Top-level closures (routes): each is its own scope; nested ones are visited on their own.
    if (n.kind === "closure" || n.kind === "arrowfunc") fn({ class: "closure", method: `closure:${lineOf(n)}` }, n.body ?? n, false);
  });
}
