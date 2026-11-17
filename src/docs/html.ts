/**
 * One self-contained HTML file with the whole documentation: a table of
 * contents on screen, clean pages when printed (File → Print → Save as PDF).
 * No scripts are needed to read it; diagrams are static SVG laid out by ELK.
 */
import type { Block, Inline, Page } from "./content.js";
import { stateSvg } from "./diagram.js";
import type { DocModel } from "./model.js";

export async function renderDocsHtml(m: DocModel, pages: Page[]): Promise<string> {
  const body: string[] = [];
  const toc: string[] = [];
  let openGroup: string | null = null;
  let svgCount = 0;

  for (const page of pages) {
    const grouped = Boolean(page.group);
    if (page.group && openGroup !== page.group.id) {
      openGroup = page.group.id;
      body.push(`<section class="page group-head" id="${page.group.id}"><h2>${esc(page.group.title)}</h2>`);
      for (const b of page.group.intro) body.push(await block(b, 2, () => ++svgCount));
      body.push("</section>");
      toc.push(`<li><a href="#${page.group.id}">${esc(page.group.title)}</a><ul>`);
    } else if (!page.group && openGroup) {
      openGroup = null;
      toc.push("</ul></li>");
    }
    toc.push(`<li><a href="#${page.id}">${esc(page.title)}</a></li>`);

    if (page.file === "README.md") {
      body.push(`<header class="cover" id="${page.id}"><div class="kicker">System documentation</div><h1>${esc(page.title)}</h1>`);
      for (const b of page.blocks) body.push(await block(b, 1, () => ++svgCount));
      body.push("</header>");
      continue;
    }
    const shift = grouped ? 2 : 1;
    body.push(`<section class="page${grouped ? " sub" : ""}" id="${page.id}"><h${1 + shift}>${esc(page.title)}</h${1 + shift}>`);
    for (const b of page.blocks) body.push(await block(b, shift, () => ++svgCount));
    body.push("</section>");
  }
  if (openGroup) toc.push("</ul></li>");

  const map = m.map;
  const meta = [`Generated ${map.generatedAt.slice(0, 10)}`, map.project.commit ? `commit ${map.project.commit}` : "", map.generator].filter(Boolean).join(" · ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${esc(map.generator)}">
<title>${esc(m.title)} · Documentation</title>
<style>${CSS}</style>
</head>
<body>
<nav class="toc" aria-label="Contents">
  <div class="toc-title">${esc(m.title)}</div>
  <div class="toc-meta">${esc(meta)}</div>
  <ul>${toc.join("")}</ul>
  <button type="button" class="print" onclick="window.print()">Print or save as PDF</button>
</nav>
<main>
${body.join("\n")}
<footer>${esc(meta)}. Generated from the code and builtlore.edits.yaml; rerun <code>builtlore docs</code> to update.</footer>
</main>
</body>
</html>
`;
}

async function block(b: Block, shift: number, nextId: () => number): Promise<string> {
  switch (b.t) {
    case "h": {
      const level = Math.min(6, b.level + shift);
      return `<h${level}${b.id ? ` id="${b.id}"` : ""}>${esc(b.text)}</h${level}>`;
    }
    case "p":
      return `<p>${inline(b.c)}</p>`;
    case "note":
      return `<p class="note ${b.kind}">${inline(b.c)}</p>`;
    case "list":
      return `<ul>${b.items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`;
    case "table": {
      if (!b.rows.length) return "";
      const head = b.head.some(Boolean) ? `<thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : "";
      const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      return `<div class="table${b.compact ? " compact" : ""}"><table>${head}<tbody>${rows}</tbody></table></div>`;
    }
    case "diagram": {
      const svg = await stateSvg(b.graph, b.title, `d${nextId()}`);
      return `<figure class="diagram">${svg}<figcaption>${esc(b.title)}. Arrows are steps found in the code; red dashed: hold, reject or cancel; purple dotted: done automatically by a job or command.</figcaption></figure>`;
    }
    case "mermaid":
      return ""; // Markdown only (the HTML shows the same information as a table)
  }
}

function inline(parts: Inline[]): string {
  return parts
    .map((p) => {
      if (typeof p === "string") return esc(p);
      if ("code" in p) return `<code>${esc(p.code)}</code>`;
      if ("b" in p) return `<strong>${esc(p.b)}</strong>`;
      if ("i" in p) return `<em>${esc(p.i)}</em>`;
      if ("link" in p) return `<a href="#${esc(p.to)}">${esc(p.link)}</a>`;
      if ("src" in p) return `<span class="src">${esc(p.src.line ? `${p.src.file}:${p.src.line}` : p.src.file)}</span>`;
      if (p.kind === "role") return `<span class="dot" title="can do this">●</span>`;
      return `<span class="badge ${p.kind}">${esc(p.badge)}</span>`;
    })
    .join("");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{
  --bg:#ffffff;--fg:#1f2937;--muted:#6b7280;--line:#e5e7eb;--soft:#f7f7f8;--accent:#2563eb;
  --code-bg:#f3f4f6;--human:#047857;--human-bg:#ecfdf5;--missing:#92400e;--missing-bg:#fffbeb;--warn:#b91c1c;--warn-bg:#fef2f2;
  --state:#ffffff;--state-line:#94a3b8;--edge:#475569;--neg:#dc2626;--auto:#7c3aed;--label-bg:#ffffff;
}
@media (prefers-color-scheme: dark){
  :root{--bg:#111318;--fg:#e5e7eb;--muted:#9ca3af;--line:#2b2f37;--soft:#181b21;--accent:#7aa2ff;--code-bg:#1f232b;
    --human:#6ee7b7;--human-bg:#0f2a22;--missing:#fcd34d;--missing-bg:#2a2210;--warn:#fca5a5;--warn-bg:#2d1515;
    --state:#181b21;--state-line:#64748b;--edge:#cbd5e1;--neg:#f87171;--auto:#c4b5fd;--label-bg:#111318;}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex}
.toc{position:sticky;top:0;align-self:flex-start;width:264px;height:100vh;overflow:auto;padding:28px 20px;border-right:1px solid var(--line);flex:none;font-size:13.5px}
.toc-title{font-weight:650;font-size:15px;line-height:1.3}
.toc-meta{color:var(--muted);font-size:12px;margin:4px 0 16px}
.toc ul{list-style:none;margin:0;padding:0}
.toc ul ul{padding-left:12px;margin:2px 0 6px;border-left:1px solid var(--line)}
.toc li{margin:1px 0}
.toc a{color:var(--fg);text-decoration:none;display:block;padding:3px 8px;border-radius:6px}
.toc a:hover{background:var(--soft);color:var(--accent)}
.print{margin-top:20px;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;cursor:pointer}
.print:hover{border-color:var(--accent);color:var(--accent)}
main{flex:1;min-width:0;max-width:960px;padding:40px 48px 80px}
.cover{padding-bottom:12px}
.kicker{text-transform:uppercase;letter-spacing:.08em;font-size:12px;color:var(--muted);font-weight:600}
h1{font-size:34px;line-height:1.15;margin:6px 0 18px;letter-spacing:-.01em}
h2{font-size:24px;line-height:1.25;margin:0 0 14px;letter-spacing:-.005em}
h3{font-size:18px;margin:30px 0 10px}
h4{font-size:15.5px;margin:22px 0 8px}
h5,h6{font-size:14.5px;margin:18px 0 6px}
.page{border-top:1px solid var(--line);padding-top:36px;margin-top:44px}
.page.sub{border-top:1px dashed var(--line);margin-top:36px}
.group-head + .page.sub{border-top:0;margin-top:8px;padding-top:12px}
p{margin:0 0 12px}
ul{margin:0 0 14px;padding-left:22px}
li{margin:3px 0}
a{color:var(--accent)}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code-bg);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.src{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);white-space:nowrap}
.table{overflow-x:auto;margin:6px 0 18px;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line)}
th{background:var(--soft);font-weight:600;font-size:12.5px;color:var(--muted);white-space:nowrap}
tr:last-child td{border-bottom:0}
.compact td,.compact th{padding:5px 10px}
.dot{color:var(--accent)}
.badge{display:inline-block;font-size:11px;line-height:1;padding:3px 7px;border-radius:999px;white-space:nowrap;vertical-align:1px}
.badge.code{background:var(--code-bg);color:var(--muted)}
.badge.human{background:var(--human-bg);color:var(--human)}
.badge.missing{background:var(--missing-bg);color:var(--missing)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.note{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--soft)}
.note.missing{background:var(--missing-bg);border-color:transparent}
.note.warn{background:var(--warn-bg);border-color:transparent}
figure.diagram{margin:10px 0 20px;padding:14px;border:1px solid var(--line);border-radius:10px;overflow-x:auto}
figure.diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}
figcaption{font-size:12px;color:var(--muted);margin-top:8px}
svg.lifecycle text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
svg .state{fill:var(--state);stroke:var(--state-line);stroke-width:1.3}
svg .state.final{stroke:var(--human);stroke-width:1.6}
svg .state.any{stroke-dasharray:4 3;fill:var(--soft)}
svg .state-text{font-size:12.5px;fill:var(--fg);font-weight:600}
svg .state-text.any{font-weight:400;fill:var(--muted);font-style:italic}
svg .start{fill:var(--fg)}
svg .edge{fill:none;stroke:var(--edge);stroke-width:1.4}
svg .edge.neg{stroke:var(--neg);stroke-dasharray:5 4}
svg .edge.bg{stroke:var(--auto);stroke-dasharray:2 3}
svg .arrow{fill:var(--edge)} svg .arrow.neg{fill:var(--neg)} svg .arrow.bg{fill:var(--auto)}
svg .edge-label-bg{fill:var(--label-bg);opacity:.92}
svg .edge-text{font-size:11px;fill:var(--fg)}
svg .edge-text.neg{fill:var(--neg)}
svg .edge-who{font-size:10px;fill:var(--muted)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:860px){
  body{display:block}
  .toc{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:16px}
  main{padding:24px 16px 60px}
  h1{font-size:28px}
}
@media print{
  :root{--bg:#fff;--fg:#111;--muted:#555;--line:#d4d4d8;--soft:#f4f4f5;--accent:#1d4ed8;--code-bg:#f4f4f5;
    --human:#047857;--human-bg:#ecfdf5;--missing:#92400e;--missing-bg:#fffbeb;--warn:#b91c1c;--warn-bg:#fef2f2;
    --state:#fff;--state-line:#71717a;--edge:#3f3f46;--neg:#dc2626;--auto:#7c3aed;--label-bg:#fff}
  @page{size:A4;margin:16mm 14mm}
  body{display:block;font-size:10.5pt;line-height:1.5}
  .toc{display:none}
  main{max-width:none;padding:0}
  .cover{min-height:40vh}
  .page{break-before:page;border-top:0;margin-top:0;padding-top:0}
  .page.sub{break-before:auto;border-top:1px solid var(--line);margin-top:18pt;padding-top:12pt}
  .group-head + .page.sub{border-top:0}
  h2,h3,h4{break-after:avoid}
  tr,figure,.note{break-inside:avoid}
  .table{overflow:visible;border-radius:0}
  table{font-size:9pt}
  th{white-space:normal}
  figure.diagram{overflow:visible}
  a{color:inherit;text-decoration:none}
  .src{white-space:normal}
  footer{break-before:avoid}
}
`;
