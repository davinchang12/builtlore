/**
 * Names for status values, read from how the views show them:
 *   @if ($pr->status == 'H') <span class="badge">On hold</span> @elseif (...) ... @endif
 *   @switch($pr->status) @case('A') Approved @break ... @endswitch
 *   {{ $pr->status == 'A' ? 'Approved' : 'Waiting' }}
 *   switch (row.status) { case 'A': return '<span>Approved</span>'; }   (scripts in views, resources/js)
 *   if (row.status == 'A') return 'Approved';
 * Only short plain text counts as a name; a value shown two different ways is left unnamed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceRef } from "../../core/types.js";

export interface ViewLabel {
  /** Status column as written in the view (case kept). */
  column: string;
  value: string;
  label: string;
  source: SourceRef;
}

const COL = String.raw`(?:\$\w+(?:->|\[['"])|\b(?:row|data|item|full|record|r|d|x|value|val|obj)(?:\.|\[['"]))([A-Za-z_][\w]*)['"]?\]?`;
const VAL = String.raw`(['"])([^'"\n]{1,30})\2`;

function files(root: string, dir: string, ext: RegExp, depth = 8): string[] {
  const out: string[] = [];
  const visit = (rel: string, d: number) => {
    const abs = join(root, rel);
    if (d > depth || !existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === "node_modules" || name === "vendor" || name.startsWith(".")) continue;
      const childRel = `${rel}/${name}`;
      if (statSync(join(abs, name)).isDirectory()) visit(childRel, d + 1);
      else if (ext.test(name)) out.push(childRel);
    }
  };
  visit(dir, 0);
  return out;
}

/** Plain text of a branch: tags, Blade echoes and directives removed. Null unless it reads as a short name. */
function plain(html: string): string | null {
  // A branch with buttons, links or forms shows what can be done, not what the status is called
  if (/<(button|a|form|input|select)\b/i.test(html)) return null;
  const t = html
    .replace(/\{\{--[\s\S]*?--\}\}/g, " ")
    .replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g, " ")
    .replace(/@\w+(\s*\([^)]*\))?/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 40 || !/[A-Za-z]/.test(t) || t.split(" ").length > 6 || /[{}();=$]/.test(t)) return null;
  return t;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function readViewLabels(root: string): ViewLabel[] {
  const found: ViewLabel[] = [];
  const add = (column: string, value: string, label: string | null, file: string, text: string, index: number) => {
    if (!label || label.toLowerCase() === value.toLowerCase()) return;
    found.push({ column, value, label, source: { file, line: lineAt(text, index) } });
  };
  const all = [...files(root, "resources/views", /\.blade\.php$/), ...files(root, "resources/js", /\.(js|vue|jsx|tsx)$/)];
  for (const file of all) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (text.length > 600_000) continue;

    // Blade if/elseif chains: the text right inside each branch
    const ifRe = new RegExp(String.raw`@(?:else)?if\s*\(\s*${COL}\s*===?\s*${VAL}\s*\)`, "g");
    for (const m of text.matchAll(ifRe)) {
      const start = m.index! + m[0].length;
      const next = /@(elseif|else|endif)\b/.exec(text.slice(start));
      if (next) add(m[1], m[3], plain(text.slice(start, start + next.index)), file, text, m.index!);
    }
    // @switch($x->status) @case('A') ... @break
    for (const sw of text.matchAll(new RegExp(String.raw`@switch\s*\(\s*${COL}\s*\)`, "g"))) {
      const end = text.indexOf("@endswitch", sw.index!);
      const body = text.slice(sw.index!, end > 0 ? end : sw.index! + 3000);
      for (const c of body.matchAll(/@case\s*\(\s*(['"])([^'"\n]{1,30})\1\s*\)([\s\S]*?)@break/g)) add(sw[1], c[2], plain(c[3]), file, text, sw.index! + c.index!);
    }
    // $x->status == 'A' ? 'Approved' : …  (Blade echoes and scripts)
    for (const m of text.matchAll(new RegExp(String.raw`${COL}\s*===?\s*${VAL}\s*\?\s*(['"\`])((?:(?!\4)[^\n]){1,80})\4`, "g"))) add(m[1], m[3], plain(m[5]), file, text, m.index!);
    // Scripts: switch (row.status) { case 'A': return '…'; }
    for (const sw of text.matchAll(new RegExp(String.raw`switch\s*\(\s*${COL}\s*\)\s*\{`, "g"))) {
      const body = text.slice(sw.index!, sw.index! + 4000);
      for (const c of body.matchAll(/case\s+(['"])([^'"\n]{1,30})\1\s*:\s*(?:return\s+|\w+\s*=\s*)(['"`])((?:(?!\3)[^\n]){1,160})\3/g)) add(sw[1], c[2], plain(c[4]), file, text, sw.index! + c.index!);
    }
    // Scripts: if (row.status == 'A') return '…' / { badge = '…' }
    for (const m of text.matchAll(new RegExp(String.raw`if\s*\(\s*${COL}\s*===?\s*${VAL}\s*\)\s*\{?\s*(?:return\s+|\w+\s*=\s*)(['"\`])((?:(?!\4)[^\n]){1,160})\4`, "g"))) add(m[1], m[3], plain(m[5]), file, text, m.index!);
  }
  // A value shown with two different names is not named
  const out: ViewLabel[] = [];
  for (const l of found) {
    const same = found.filter((x) => x.column.toLowerCase() === l.column.toLowerCase() && x.value === l.value);
    if (new Set(same.map((x) => x.label.toLowerCase())).size > 1) continue;
    if (!out.some((x) => x.column.toLowerCase() === l.column.toLowerCase() && x.value === l.value)) out.push(l);
  }
  return out;
}
