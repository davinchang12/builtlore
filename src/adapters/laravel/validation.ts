/**
 * Business rules from request validation: $request->validate([...]),
 * Validator::make($data, [...]), $this->validate($request, [...]) and the
 * rules() of FormRequest classes. Each rule is kept as written, with a plain
 * English reading when builtlore knows the rule. Rules it cannot read (built at
 * runtime) are reported, never guessed.
 */
import type { FieldRules, SkippedFact, Validation, ValidationRule } from "../../core/types.js";
import type { ClassLocator } from "./controllers.js";
import { lineOf, phpText, resolveClass, resolveName, stringValue, walk, type NameContext, type PhpNode } from "./php.js";

export interface RequestReading {
  validation: Validation[];
  /** Request fields read by the handler. "*" when it reads everything ($request->all()). */
  inputs: string[];
  skipped: SkippedFact[];
}

const INPUT_METHODS = /^(input|get|post|query|string|integer|float|boolean|date|enum|file|hasFile|has|filled|missing|exists|json)$/;
const MANY_METHODS = /^(only|except|safe)$/;

/** Read validation and request inputs from a controller method or route closure. */
export function readRequest(body: PhpNode, names: NameContext, file: string, locator: ClassLocator): RequestReading {
  const out: RequestReading = { validation: [], inputs: [], skipped: [] };
  const requestVars = new Set<string>(["request"]);
  const formRequests: Array<{ cls: string; line?: number }> = [];

  for (const p of body.arguments ?? []) {
    const typeName: string | undefined = p.type?.name;
    const varName: string | undefined = p.name?.name ?? p.name;
    if (!typeName || !varName) continue;
    const fq = resolveName(typeName, p.type.resolution, names);
    const kind = requestKind(fq, locator);
    if (!kind) continue;
    requestVars.add(varName);
    if (kind === "form") formRequests.push({ cls: fq, line: lineOf(p) });
  }

  for (const fr of formRequests) {
    const v = readFormRequest(fr.cls, locator, out.skipped);
    if (v) out.validation.push(v);
  }

  const locals = localArrays(body);
  const inputs = new Set<string>();
  walk(body, (n, parent) => {
    if (n.kind === "call") {
      const method: string | undefined = n.what?.offset?.name;
      const onRequest = isRequest(n.what?.what, requestVars);
      const fn: string | undefined = n.what?.kind === "name" ? n.what.name.replace(/^\\/, "") : undefined;
      const staticClass = n.what?.kind === "staticlookup" ? resolveClass(n.what.what, names) ?? "" : "";

      // $request->validate([...]) / request()->validate([...]) / validateWithBag('bag', [...])
      if (onRequest && (method === "validate" || method === "validateWithBag")) {
        const arg = method === "validate" ? n.arguments?.[0] : n.arguments?.[1];
        addInline(out, arg, locals, file, lineOf(n));
      }
      // $this->validate($request, [...])
      if (method === "validate" && n.what?.what?.kind === "variable" && n.what.what.name === "this") {
        addInline(out, n.arguments?.[1], locals, file, lineOf(n));
      }
      // Validator::make($data, [...]) / validator($data, [...])
      if ((/(^|\\)Validator$/.test(staticClass) && method === "make") || fn === "validator") {
        if (n.arguments?.[1]) addInline(out, n.arguments[1], locals, file, lineOf(n));
      }
      // Inputs
      if (onRequest && method && INPUT_METHODS.test(method)) {
        for (const s of argStrings(n.arguments?.[0])) inputs.add(s);
      }
      if (onRequest && method && MANY_METHODS.test(method) && method !== "safe") {
        for (const a of n.arguments ?? []) for (const s of argStrings(a)) inputs.add(method === "except" ? `* except ${s}` : s);
      }
      if (onRequest && method === "all") inputs.add("*");
      if (fn === "request" && n.arguments?.[0]) for (const s of argStrings(n.arguments[0])) inputs.add(s);
    }
    // $request->title
    const isMethodCall = parent?.kind === "call" && parent.what === n;
    if (!isMethodCall && n.kind === "propertylookup" && n.what?.kind === "variable" && requestVars.has(n.what.name)) {
      const prop = n.offset?.name;
      if (typeof prop === "string" && !/^(attributes|request|query|files|cookies|headers|server|json)$/.test(prop)) inputs.add(prop);
    }
  });
  out.inputs = [...inputs].filter((i) => !i.startsWith("* except") || !inputs.has("*")).sort();
  return out;
}

/**
 * "plain" for Illuminate\Http\Request, "form" for a class that extends
 * FormRequest (directly or through the app's own base request), null otherwise
 * (a model named PurchaseRequest is not a request).
 */
export function requestKind(fqcn: string, locator: ClassLocator, depth = 0): "plain" | "form" | null {
  const fq = fqcn.replace(/^\\/, "");
  if (fq === "Illuminate\\Http\\Request" || fq === "Request") return "plain";
  if (/(^|\\)FormRequest$/.test(fq)) return "form";
  if (depth > 4) return null;
  const loaded = locator.load(fq);
  if (!loaded) {
    // Not in the app (a package request class): trust only the conventional namespace.
    return /\\Http\\Requests\\/.test(fq) ? "form" : null;
  }
  let parent: string | null = null;
  walk(loaded.ast, (n) => {
    if (parent !== null) return false;
    if (n.kind === "class") {
      parent = n.extends?.name ? resolveName(n.extends.name, n.extends.resolution, loaded.names) : "";
      return false;
    }
  });
  if (!parent) return null;
  const kind = requestKind(parent, locator, depth + 1);
  return kind ? "form" : null;
}

/** rules() of a FormRequest class. */
export function readFormRequest(fqcn: string, locator: ClassLocator, skipped: SkippedFact[]): Validation | null {
  const loaded = locator.load(fqcn);
  if (!loaded) return null;
  let rules: PhpNode | null = null;
  walk(loaded.ast, (n) => {
    if (rules) return false;
    if (n.kind === "method" && (n.name?.name ?? n.name) === "rules") {
      rules = n;
      return false;
    }
  });
  if (!rules) return null;
  const method: PhpNode = rules;
  const locals = localArrays(method);
  let returned: PhpNode | null = null;
  walk(method, (n) => {
    if (n.kind === "return" && !returned) returned = n.expr;
  });
  const fields = readRulesArray(returned, locals, loaded.file, lineOf(method), skipped);
  if (!fields) return null;
  return { via: "form-request", class: fqcn, fields, source: { file: loaded.file, line: lineOf(method) } };
}

function addInline(out: RequestReading, arg: PhpNode, locals: Map<string, PhpNode>, file: string, line?: number): void {
  const fields = readRulesArray(arg, locals, file, line, out.skipped);
  if (fields) out.validation.push({ via: "inline", fields, source: { file, line } });
}

function readRulesArray(arg: PhpNode, locals: Map<string, PhpNode>, file: string, line: number | undefined, skipped: SkippedFact[]): FieldRules[] | null {
  let arr = arg;
  if (arr?.kind === "variable" && locals.has(arr.name)) arr = locals.get(arr.name);
  if (arr?.kind !== "array") {
    if (arg) skipped.push({ kind: "skipped", reason: `Validation rules not readable (built at runtime): ${phpText(arg)}`, source: { file, line } });
    return null;
  }
  const fields: FieldRules[] = [];
  for (const it of arr.items ?? []) {
    if (it?.kind !== "entry") continue;
    const field = it.key ? stringValue(it.key) : null;
    if (field === null) {
      skipped.push({ kind: "skipped", reason: `Validation field name not readable: ${it.key ? phpText(it.key) : phpText(it.value)}`, source: { file, line: lineOf(it) ?? line } });
      continue;
    }
    const raw = ruleList(it.value);
    if (!raw) {
      skipped.push({ kind: "skipped", reason: `Validation rules for '${field}' not readable: ${phpText(it.value)}`, source: { file, line: lineOf(it) ?? line } });
      continue;
    }
    fields.push({ field, rules: describeRules(field, raw), line: lineOf(it) });
  }
  return fields;
}

/** 'required|max:5' or ['required', Rule::in([...]), new Upper] -> rules as written. */
function ruleList(v: PhpNode): Array<{ rule: string; node?: PhpNode }> | null {
  const s = stringValue(v);
  if (s !== null) return s.split("|").map((r) => r.trim()).filter(Boolean).map((rule) => ({ rule }));
  if (v?.kind !== "array") return null;
  const out: Array<{ rule: string; node?: PhpNode }> = [];
  for (const it of v.items ?? []) {
    const node = it?.kind === "entry" ? it.value : it;
    const lit = stringValue(node);
    if (lit !== null) out.push(...lit.split("|").map((r) => r.trim()).filter(Boolean).map((rule) => ({ rule })));
    else out.push({ rule: phpText(node), node });
  }
  return out;
}

type FieldKind = "number" | "file" | "array" | "text";

function fieldKind(rules: string[]): FieldKind {
  const names = rules.map((r) => r.split(":")[0]);
  if (names.some((n) => /^(integer|numeric|decimal)$/.test(n))) return "number";
  if (names.some((n) => /^(file|image|mimes|mimetypes|extensions)$/.test(n))) return "file";
  if (names.includes("array")) return "array";
  return "text";
}

export function describeRules(field: string, raw: Array<{ rule: string; node?: PhpNode }>): ValidationRule[] {
  const kind = fieldKind(raw.filter((r) => !r.node).map((r) => r.rule));
  return raw.map((r) => {
    const text = r.node ? objectRuleText(r.node) : ruleText(field, r.rule, kind);
    return text ? { rule: r.rule, text } : { rule: r.rule };
  });
}

const SIMPLE: Record<string, string> = {
  required: "required",
  nullable: "optional (may be empty)",
  sometimes: "checked only when sent",
  filled: "must not be empty when sent",
  present: "must be sent (may be empty)",
  string: "text",
  integer: "whole number",
  numeric: "number",
  boolean: "yes/no",
  array: "list",
  list: "list",
  date: "date",
  email: "email address",
  url: "URL",
  active_url: "URL that resolves",
  uuid: "UUID",
  ulid: "ULID",
  ip: "IP address",
  ipv4: "IPv4 address",
  ipv6: "IPv6 address",
  json: "JSON text",
  file: "file",
  image: "image file",
  alpha: "letters only",
  alpha_num: "letters and digits only",
  alpha_dash: "letters, digits, dashes and underscores only",
  lowercase: "lowercase",
  uppercase: "uppercase",
  timezone: "time zone",
  accepted: "must be accepted (yes, on, 1, true)",
  declined: "must be declined (no, off, 0, false)",
  distinct: "no duplicates",
  confirmed: "", // filled in below with the field name
  current_password: "the user's current password",
  prohibited: "must not be sent",
  bail: "stop at the first failing rule",
  ascii: "ASCII characters only",
  hex_color: "hex color",
  mac_address: "MAC address",
};

function list(s: string): string {
  return s.split(",").map((x) => x.trim()).filter(Boolean).join(", ");
}

function sizeText(n: string, kind: FieldKind): string {
  if (kind === "number") return n;
  if (kind === "file") return `${n} KB`;
  if (kind === "array") return `${n} items`;
  return `${n} characters`;
}

export function ruleText(field: string, rule: string, kind: FieldKind): string | undefined {
  const idx = rule.indexOf(":");
  const name = (idx < 0 ? rule : rule.slice(0, idx)).trim();
  const arg = idx < 0 ? "" : rule.slice(idx + 1).trim();
  const args = arg.split(",").map((x) => x.trim());
  if (!arg) {
    if (name === "confirmed") return `must match ${field}_confirmation`;
    return SIMPLE[name] || undefined;
  }
  switch (name) {
    case "max":
      return `at most ${sizeText(arg, kind)}`;
    case "min":
      return `at least ${sizeText(arg, kind)}`;
    case "size":
      return `exactly ${sizeText(arg, kind)}`;
    case "between":
      return args.length === 2 ? `between ${args[0]} and ${sizeText(args[1], kind)}` : undefined;
    case "digits":
      return `exactly ${arg} digits`;
    case "digits_between":
      return args.length === 2 ? `${args[0]} to ${args[1]} digits` : undefined;
    case "max_digits":
      return `at most ${arg} digits`;
    case "min_digits":
      return `at least ${arg} digits`;
    case "decimal":
      return args.length === 2 ? `number with ${args[0]} to ${args[1]} decimals` : `number with ${arg} decimals`;
    case "in":
      return `one of: ${list(arg)}`;
    case "not_in":
      return `not one of: ${list(arg)}`;
    case "mimes":
    case "extensions":
      return `file type: ${list(arg)}`;
    case "mimetypes":
      return `file type: ${list(arg)}`;
    case "exists": {
      const table = args[0];
      const column = args[1] && args[1] !== "NULL" ? args[1] : field.split(".").pop();
      return `must exist in ${table}.${column}`;
    }
    case "unique": {
      const table = args[0];
      const column = args[1] && args[1] !== "NULL" ? args[1] : field.split(".").pop();
      return `must not already exist in ${table}.${column}`;
    }
    case "date_format":
      return `date in the format ${arg}`;
    case "after":
      return `after ${arg}`;
    case "after_or_equal":
      return `on or after ${arg}`;
    case "before":
      return `before ${arg}`;
    case "before_or_equal":
      return `on or before ${arg}`;
    case "date_equals":
      return `on ${arg}`;
    case "same":
      return `must match ${arg}`;
    case "different":
      return `must differ from ${arg}`;
    case "gt":
      return `greater than ${arg}`;
    case "gte":
      return `at least ${arg}`;
    case "lt":
      return `less than ${arg}`;
    case "lte":
      return `at most ${arg}`;
    case "multiple_of":
      return `multiple of ${arg}`;
    case "starts_with":
      return `starts with ${list(arg).replace(/, /g, " or ")}`;
    case "ends_with":
      return `ends with ${list(arg).replace(/, /g, " or ")}`;
    case "doesnt_start_with":
      return `does not start with ${list(arg).replace(/, /g, " or ")}`;
    case "doesnt_end_with":
      return `does not end with ${list(arg).replace(/, /g, " or ")}`;
    case "required_if":
      return args.length >= 2 ? `required when ${args[0]} is ${args.slice(1).join(" or ")}` : undefined;
    case "required_unless":
      return args.length >= 2 ? `required unless ${args[0]} is ${args.slice(1).join(" or ")}` : undefined;
    case "required_with":
      return `required when ${args.join(" or ")} is sent`;
    case "required_with_all":
      return `required when ${args.join(" and ")} are sent`;
    case "required_without":
      return `required when ${args.join(" or ")} is missing`;
    case "required_without_all":
      return `required when ${args.join(" and ")} are all missing`;
    case "prohibited_if":
      return args.length >= 2 ? `must not be sent when ${args[0]} is ${args.slice(1).join(" or ")}` : undefined;
    case "regex":
      return `must match the pattern ${arg}`;
    case "not_regex":
      return `must not match the pattern ${arg}`;
    case "dimensions":
      return `image dimensions: ${list(arg)}`;
    case "enum":
      return `one of the values of ${arg}`;
    case "bail":
      return SIMPLE.bail;
    default:
      return undefined;
  }
}

/** Rule objects: Rule::in([...]), Rule::unique('t'), new SomeRule, closures. */
function objectRuleText(n: PhpNode): string | undefined {
  // Walk down a fluent chain to its root static call: Rule::unique('users')->ignore($id)
  let root = n;
  while (root?.kind === "call" && root.what?.kind === "propertylookup" && root.what.what?.kind === "call") root = root.what.what;
  if (root?.kind === "call" && root.what?.kind === "staticlookup") {
    const cls: string = root.what.what?.name ?? "";
    const method: string = root.what.offset?.name ?? "";
    const a = root.arguments ?? [];
    const strs = (x: PhpNode) => (x?.kind === "array" ? x.items.map((i: PhpNode) => stringValue(i?.kind === "entry" ? i.value : i)) : [stringValue(x)]);
    if (/(^|\\)Rule$/.test(cls)) {
      const values = a.flatMap(strs);
      const literalValues = values.every((x: string | null) => x !== null) ? (values as string[]) : null;
      switch (method) {
        case "in":
          return literalValues ? `one of: ${literalValues.join(", ")}` : "one of a list built in code";
        case "notIn":
          return literalValues ? `not one of: ${literalValues.join(", ")}` : "not one of a list built in code";
        case "unique": {
          const t = stringValue(a[0]);
          return t ? `must not already exist in ${t}${stringValue(a[1]) ? "." + stringValue(a[1]) : ""}` : undefined;
        }
        case "exists": {
          const t = stringValue(a[0]);
          return t ? `must exist in ${t}${stringValue(a[1]) ? "." + stringValue(a[1]) : ""}` : undefined;
        }
        case "requiredIf":
          return "required in some cases (condition in code)";
        case "prohibitedIf":
          return "must not be sent in some cases (condition in code)";
        case "enum":
          return a[0]?.kind === "staticlookup" ? `one of the values of ${a[0].what?.name}` : undefined;
        case "date":
          return "date";
        case "file":
          return "file";
        case "imageFile":
          return "image file";
      }
      return undefined;
    }
    if (/(^|\\)Password$/.test(cls)) return "password strength rule";
    if (/(^|\\)File$/.test(cls)) return "file rule";
  }
  if (n?.kind === "new" && n.what?.kind === "name") return `custom rule ${n.what.name.split("\\").pop()}`;
  if (n?.kind === "closure" || n?.kind === "arrowfunc") return "custom check written in code";
  return undefined;
}

function isRequest(n: PhpNode, vars: Set<string>): boolean {
  if (n?.kind === "variable") return vars.has(n.name);
  return n?.kind === "call" && n.what?.kind === "name" && n.what.name.replace(/^\\/, "") === "request" && !(n.arguments ?? []).length;
}

function argStrings(n: PhpNode): string[] {
  if (!n) return [];
  const s = stringValue(n);
  if (s !== null) return [s];
  if (n.kind === "array") return (n.items ?? []).map((i: PhpNode) => stringValue(i?.kind === "entry" ? i.value : i)).filter((x: string | null): x is string => Boolean(x));
  return [];
}

/** $rules = [...] assigned once in the body. */
function localArrays(body: PhpNode): Map<string, PhpNode> {
  const out = new Map<string, PhpNode>();
  const multi = new Set<string>();
  walk(body, (n) => {
    if (n.kind === "assign" && n.operator === "=" && n.left?.kind === "variable" && typeof n.left.name === "string" && n.right?.kind === "array") {
      if (out.has(n.left.name)) multi.add(n.left.name);
      out.set(n.left.name, n.right);
    }
  });
  for (const m of multi) out.delete(m);
  return out;
}
