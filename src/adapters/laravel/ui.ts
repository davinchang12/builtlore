/**
 * The words people see, read from the views, to name screens and actions:
 *   - menus: links in layouts, sidebars and navbars (<a href="{{ route('x') }}">Application list</a>),
 *     and menu arrays in PHP (['title' => 'Application list', 'route' => 'x'])
 *   - page titles: @section('title', 'Purchase requests'), <x-slot name="title">, the first heading
 *   - buttons: the submit button of a form that posts to an action (when it says more than "Save")
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceRef } from "../../core/types.js";
import { parseTarget } from "./blade.js";

export interface UiText {
  text: string;
  source: SourceRef;
}

/** Button words that say nothing about the step. */
const GENERIC = /^(save|simpan|submit|kirim|send|ok|okay|update|ubah|edit|delete|hapus|remove|yes|ya|no|tidak|cancel|batal|close|tutup|back|kembali|search|cari|filter|reset|next|lanjut|continue|proses|process|confirm|konfirmasi|apply|go|add|tambah|create|buat|new|baru)$/i;
/** Layout-like view paths, where links act as menus. */
const MENU_FILE = /(layout|partial|sidebar|side-bar|menu|nav|header|aside|topbar)/i;

function plainText(html: string): string | null {
  const t = html
    .replace(/\{\{--[\s\S]*?--\}\}/g, " ")
    .replace(/<(i|svg|span)\b[^>]*class=["'][^"']*(icon|fa-|bi-|ti-|feather|material)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/\{\{\s*__\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, "$1")
    .replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}/g, " ")
    .replace(/@\w+(\s*\([^)]*\))?/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&amp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 48 || !/[A-Za-z]/.test(t) || t.split(" ").length > 7 || /[{}();=$<>]/.test(t)) return null;
  return t;
}

function views(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string, d: number) => {
    const abs = join(root, rel);
    if (d > 8 || !existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue;
      const childRel = `${rel}/${name}`;
      if (statSync(join(abs, name)).isDirectory()) visit(childRel, d + 1);
      else if (name.endsWith(".blade.php")) out.push(childRel);
    }
  };
  visit("resources/views", 0);
  return out;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

export interface UiNames {
  /** Route name -> menu text. */
  menu: Map<string, UiText>;
  /** Route name -> submit button text of a form posting to it. */
  button: Map<string, UiText>;
  /** View file -> page title. */
  title(file: string): UiText | null;
}

export function readUiNames(root: string): UiNames {
  const menu = new Map<string, UiText>();
  const button = new Map<string, UiText>();
  const conflictsMenu = new Set<string>();
  const conflictsButton = new Set<string>();
  const put = (map: Map<string, UiText>, conflicts: Set<string>, route: string, text: string | null, source: SourceRef) => {
    if (!text) return;
    const seen = map.get(route);
    if (seen && seen.text.toLowerCase() !== text.toLowerCase()) conflicts.add(route);
    else if (!seen) map.set(route, { text, source });
  };
  for (const file of views(root)) {
    let src: string;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    // Menus: links in layouts, sidebars, navbars
    if (MENU_FILE.test(file)) {
      for (const m of src.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]{0,600}?)<\/a>/gi)) {
        const href = /\shref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[1]);
        const target = href ? parseTarget(href[2] ?? href[3] ?? "") : null;
        if (target?.kind === "name") put(menu, conflictsMenu, target.name, plainText(m[2]), { file, line: lineAt(src, m.index!) });
      }
    }
    // Buttons: the submit button of a form that posts to a route
    for (const m of src.matchAll(/<form\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/form>/gi)) {
      const action = /\saction\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[1]);
      const target = action ? parseTarget(action[2] ?? action[3] ?? "") : null;
      if (target?.kind !== "name") continue;
      const btn = /<button\b(?:(?!type\s*=\s*["']button)[^>])*>([\s\S]{0,300}?)<\/button>/i.exec(m[2]) ?? /<input\b[^>]*type\s*=\s*["']submit["'][^>]*value\s*=\s*["']([^"']+)["']/i.exec(m[2]);
      const text = btn ? plainText(btn[1]) : null;
      if (text && !GENERIC.test(text)) put(button, conflictsButton, target.name, text, { file, line: lineAt(src, m.index!) });
    }
  }
  for (const r of conflictsMenu) menu.delete(r);
  for (const r of conflictsButton) button.delete(r);
  // Menu arrays in PHP: ['title' => 'Application list', 'route' => 'application.list.index']
  for (const dir of ["config", "app"]) {
    const stack = [dir];
    while (stack.length) {
      const rel = stack.pop()!;
      const abs = join(root, rel);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        const childRel = `${rel}/${name}`;
        if (statSync(join(abs, name)).isDirectory()) {
          if (stack.length < 200) stack.push(childRel);
          continue;
        }
        if (!name.endsWith(".php") || !/menu|nav|sidebar/i.test(childRel)) continue;
        const src = readFileSync(join(root, childRel), "utf8");
        for (const m of src.matchAll(/\[[^[\]]*?['"](?:title|label|name|text)['"]\s*=>\s*['"]([^'"]{1,48})['"][^[\]]*?['"]route['"]\s*=>\s*['"]([\w.-]+)['"][^[\]]*?\]|\[[^[\]]*?['"]route['"]\s*=>\s*['"]([\w.-]+)['"][^[\]]*?['"](?:title|label|name|text)['"]\s*=>\s*['"]([^'"]{1,48})['"][^[\]]*?\]/g)) {
          const text = m[1] ?? m[4];
          const route = m[2] ?? m[3];
          if (text && route && !menu.has(route)) menu.set(route, { text, source: { file: childRel, line: lineAt(src, m.index!) } });
        }
      }
    }
  }
  const titles = new Map<string, UiText | null>();
  const title = (file: string): UiText | null => {
    if (titles.has(file)) return titles.get(file)!;
    let found: UiText | null = null;
    if (existsSync(join(root, file))) {
      const src = readFileSync(join(root, file), "utf8");
      const tries: Array<RegExpExecArray | null> = [
        /@section\s*\(\s*['"](?:title|page[_-]?title|header|heading)['"]\s*,\s*['"]([^'"]{1,60})['"]\s*\)/i.exec(src),
        /@section\s*\(\s*['"](?:title|page[_-]?title|header|heading)['"]\s*\)([\s\S]{0,200}?)@(?:endsection|stop)/i.exec(src),
        /<x-slot\s+name\s*=\s*["'](?:title|header|heading)["']\s*>([\s\S]{0,300}?)<\/x-slot>/i.exec(src),
        /<h[1-4]\b[^>]*>([\s\S]{0,200}?)<\/h[1-4]>/i.exec(src),
      ];
      for (const m of tries) {
        const text = m ? plainText(m[1]) : null;
        if (text) {
          found = { text, source: { file, line: lineAt(src, m!.index) } };
          break;
        }
      }
    }
    titles.set(file, found);
    return found;
  };
  return { menu, button, title };
}
