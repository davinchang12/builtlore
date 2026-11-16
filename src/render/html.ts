/**
 * Render a BuiltMap as one self-contained HTML file: no server, no network.
 * The viewer script, styles, the ELK layout engine and the map data are all
 * inlined.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "../core/paths.js";
import type { BuiltMap } from "../core/types.js";

const require = createRequire(import.meta.url);

export interface RenderOptions {
  /** Set by builtlore serve: enables editing and saving back to builtlore.edits.yaml. */
  edit?: { token: string };
}

export function renderHtml(map: BuiltMap, options: RenderOptions = {}): string {
  const root = packageRoot();
  const css = readFileSync(join(root, "assets", "viewer.css"), "utf8");
  const js = readFileSync(join(root, "assets", "viewer.js"), "utf8");
  const elk = readFileSync(require.resolve("elkjs/lib/elk.bundled.js"), "utf8");
  const json = JSON.stringify(map).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${escapeHtml(map.generator)}">
<title>${escapeHtml(map.project.name)} · builtlore</title>
<style id="builtlore-style">${css}</style>
</head>
<body>
<div class="app">
  <header>
    <div class="logo">built<span>lore</span></div>
    <div class="project" id="project"></div>
    <div class="meta" id="meta"></div>
    <div class="spacer"></div>
    <button id="btn-direction" title="Switch layout direction">Layout: left → right</button>
    <button id="btn-svg" title="Download the current canvas as SVG">Download SVG</button>
  </header>
  <aside class="sidebar">
    <input id="search" class="search" type="search" placeholder="Search pages, routes, views…  ( / )" autocomplete="off">
    <div class="stats">
      <div class="stat"><b id="stat-features"></b><span>features</span></div>
      <div class="stat"><b id="stat-nodes"></b><span>steps</span></div>
      <div class="stat"><b id="stat-edges"></b><span>transitions</span></div>
    </div>
    <div class="edit-banner" id="edit-banner" style="display:none">Editing on. Changes save to <code>builtlore.edits.yaml</code>.</div>
    <label class="toggle-row" id="data-toggle-row" title="Endpoints that return JSON (AJAX, DataTables) or files (exports, downloads)">
      <input type="checkbox" id="show-data"> Show data &amp; file endpoints <span class="count" id="data-count"></span>
    </label>
    <label class="toggle-row" id="hidden-toggle-row" style="display:none">
      <input type="checkbox" id="show-hidden"> Show hidden steps <span class="count" id="hidden-count"></span>
    </label>
    <section>
      <h3>Features</h3>
      <div class="links"><a id="all-features">show all</a><a id="no-features">hide all</a></div>
      <ul class="features" id="features"></ul>
    </section>
    <section>
      <h3>Legend</h3>
      <div class="legend">
        <div><span class="sw" style="background:#2563eb"></span>Page (renders a screen)</div>
        <div><span class="sw" style="background:#d97706"></span>Action (form submit, save, delete)</div>
        <div><span class="sw" style="background:#7c3aed"></span>API endpoint (routes/api.php)</div>
        <div><span class="sw" style="background:#0d9488"></span>Data endpoint (returns JSON)</div>
        <div><span class="sw" style="background:#475569"></span>File (export, download)</div>
        <div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#94a3b8" stroke-width="2"/></svg>Link</div>
        <div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#2563eb" stroke-width="2"/></svg>Form submit</div>
        <div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#334155" stroke-width="2"/></svg>Redirect</div>
        <div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/></svg>Failure / back with errors</div>
        <div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#0d9488" stroke-width="2" stroke-dasharray="2 3"/></svg>AJAX call from a page</div>
      </div>
    </section>
    <section id="notes"></section>
  </aside>
  <main>
    <svg id="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
    <div class="empty" id="empty" style="display:none">No steps to show. Enable a feature on the left.</div>
    <div class="toolbar">
      <button id="btn-fit" title="Fit to screen (f)">Fit</button>
      <button id="btn-zoom-in" title="Zoom in">+</button>
      <button id="btn-zoom-out" title="Zoom out">−</button>
    </div>
    <div class="details" id="details">
      <button class="close" title="Close (Esc)">×</button>
      <div id="details-body"></div>
    </div>
  </main>
</div>
<script id="builtlore-data" type="application/json">${json}</script>
${options.edit ? `<script>window.BUILTLORE_EDIT = ${JSON.stringify(options.edit)};</script>` : ""}
<script>${elk}</script>
<script>${js}</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
