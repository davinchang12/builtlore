/* builtlore viewer: renders builtlore.json as an interactive canvas.
 * Plain JS on purpose: the whole viewer ships inside one offline HTML file. */
(function () {
  "use strict";
  var SVG = "http://www.w3.org/2000/svg";
  var data = JSON.parse(document.getElementById("builtlore-data").textContent);
  var elk = new ELK();

  var PALETTE = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#dc2626", "#4f46e5", "#ea580c", "#0d9488", "#9333ea"];
  var TYPE_COLOR = { page: "#2563eb", action: "#d97706", api: "#7c3aed", data: "#0d9488", download: "#475569", redirect: "#6b7280" };
  var HIDDEN_BY_DEFAULT = { data: true, download: true };
  var reversed = {};
  var TYPE_RANK = { page: 0, redirect: 1, action: 2, data: 3, download: 4, api: 5 };
  var FORWARD = { link: true, submit: true, ajax: true, redirect: true };
  var NEGATIVE = /reject|declin|\bhold|cancel|tolak|batal|\bvoid|fail|expire|ditolak|dibatalkan/i;
  var CARD_W = 190, CARD_H = 50, COL_W = 350, LANE_PAD = 16, LABEL_W = 200, STACK_GAP = 12;

  var nodesById = {};
  data.nodes.forEach(function (n) { nodesById[n.id] = n; });
  var featureColor = {};
  data.features.forEach(function (f, i) { featureColor[f.id] = PALETTE[i % PALETTE.length]; });

  var EDIT = window.BUILTLORE_EDIT || null;
  var PROCESSES = data.processes || [];
  var state = {
    mode: PROCESSES.length ? "process" : "screens",
    hiddenProc: {},
    procEdges: [],
    hidden: {},
    showData: false,
    showHidden: false,
    selected: null,
    query: "",
    direction: "RIGHT",
    view: { x: 0, y: 0, k: 1 },
    graphSize: { w: 1, h: 1 },
  };

  // ------------------------------------------------------------------ DOM
  var $ = function (sel) { return document.querySelector(sel); };
  var svg = $("#canvas");
  var viewport = document.createElementNS(SVG, "g");
  svg.appendChild(defs());
  svg.appendChild(viewport);

  $("#project").textContent = data.project.name;
  $("#meta").textContent = [
    data.stacks.join(", "),
    data.project.commit ? "@" + data.project.commit : null,
    "generated " + new Date(data.generatedAt).toLocaleString(),
  ].filter(Boolean).join(" · ");
  document.title = data.project.name + " · builtlore";

  $("#stat-features").textContent = data.features.length;
  $("#stat-nodes").textContent = data.nodes.length;
  $("#stat-edges").textContent = data.edges.length;

  var restored = restoreState();
  if (EDIT) $("#edit-banner").style.display = "block";

  renderFeatureList();
  renderProcessList();
  renderNotes();
  if (PROCESSES.length) {
    $("#tabs").style.display = "flex";
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) {
      b.onclick = function () { setMode(b.getAttribute("data-mode")); };
    });
  }
  applyModeChrome();

  var hiddenCount = data.nodes.filter(function (n) { return n.hidden; }).length;
  $("#hidden-count").textContent = String(hiddenCount);
  if (hiddenCount) $("#hidden-toggle-row").style.display = "flex";
  $("#show-hidden").checked = state.showHidden;
  $("#show-hidden").onchange = function (e) { state.showHidden = e.target.checked; layout(true); };

  var dataCount = data.nodes.filter(function (n) { return HIDDEN_BY_DEFAULT[n.type]; }).length;
  $("#data-count").textContent = String(dataCount);
  if (!dataCount) $("#data-toggle-row").style.display = "none";
  $("#show-data").checked = state.showData;
  $("#show-data").onchange = function (e) { state.showData = e.target.checked; layout(true); };

  $("#search").addEventListener("input", function (e) {
    state.query = e.target.value.trim().toLowerCase();
    applyHighlight();
  });
  $("#search").addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      var m = matches()[0];
      if (m) { select(m.id); centerOn(m.id); }
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    if (e.key === "f") fit();
    if (e.key === "Escape") select(null);
  });
  $("#btn-fit").onclick = fit;
  $("#btn-zoom-in").onclick = function () { zoomBy(1.25); };
  $("#btn-zoom-out").onclick = function () { zoomBy(0.8); };
  $("#btn-direction").onclick = function () {
    state.direction = state.direction === "RIGHT" ? "DOWN" : "RIGHT";
    $("#btn-direction").textContent = state.direction === "RIGHT" ? "Layout: left → right" : "Layout: top → bottom";
    layout(true);
  };
  $("#btn-svg").onclick = downloadSvg;
  $("#btn-project").onclick = selectProject;
  if (EDIT) $("#btn-docs").style.display = "inline-block";
  if (data.project.title) { $("#project").textContent = data.project.title; document.title = data.project.title + " · builtlore"; }
  $("#details .close").onclick = function () { select(null); };
  $("#all-features").onclick = function () { state.hidden = {}; renderFeatureList(); layout(true); };
  $("#no-features").onclick = function () {
    data.features.forEach(function (f) { state.hidden[f.id] = true; });
    renderFeatureList(); layout(true);
  };

  setupPanZoom();
  layout(!restored);

  // --------------------------------------------------------------- layout
  function visibleNodes() {
    return data.nodes.filter(function (n) {
      return !state.hidden[n.feature] && (state.showData || !HIDDEN_BY_DEFAULT[n.type]) && (state.showHidden || !n.hidden);
    });
  }

  function nodeSize(n) {
    var sub = subtitle(n);
    var chars = Math.max(n.label.length * 1.05, sub.length * 0.86);
    return { w: Math.round(Math.min(300, Math.max(150, chars * 7.4 + 34))), h: 52 };
  }


  /**
   * Order steps the way a user meets them: start from entry points (nothing leads
   * there), then breadth-first along links, submits and redirects. Back and error
   * edges never decide the order. Unreached steps go last, pages first.
   */
  function journeyRank(nodes, edges) {
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var fwd = edges.filter(function (e) {
      return ids[e.from] && ids[e.to] && e.from !== e.to && FORWARD[e.trigger] && e.outcome !== "error";
    });
    var incoming = {};
    fwd.forEach(function (e) { incoming[e.to] = (incoming[e.to] || 0) + 1; });
    // Reached only when something fails (payment failed page) is still "reached": not an entry point.
    var reachedSomehow = {};
    edges.forEach(function (e) { if (ids[e.from] && ids[e.to] && e.from !== e.to && e.trigger !== "back") reachedSomehow[e.to] = true; });
    var out = {};
    fwd.forEach(function (e) { (out[e.from] = out[e.from] || []).push(e); });
    // Entry points: nothing leads there, and the URL can be opened from a menu
    // (no {parameter}). /items/{id}/edit is never where a journey starts.
    var isEntry = function (n) {
      return (!reachedSomehow[n.id] || entryScore(n) === 0) && (n.type === "page" || n.type === "redirect") && n.uri.indexOf("{") < 0;
    };
    var roots = nodes.filter(isEntry);
    if (!roots.length) roots = nodes.filter(function (n) { return n.type === "page"; }).slice(0, 1);
    roots.sort(function (a, b) { return entryScore(a) - entryScore(b); });
    var dist = {};
    var queue = [];
    var bfs = function () {
      while (queue.length) {
        var id = queue.shift();
        (out[id] || []).sort(function (a, b) { return triggerRank(a) - triggerRank(b); }).forEach(function (e) {
          if (dist[e.to] === undefined) { dist[e.to] = dist[id] + 1; queue.push(e.to); }
        });
      }
    };
    roots.forEach(function (r) { dist[r.id] = 0; queue.push(r.id); });
    bfs();
    // Steps nobody links to in a way we can see (buttons built in JavaScript):
    // place them right after the steps they lead to, e.g. Edit after View.
    var changed = true;
    while (changed) {
      changed = false;
      nodes.forEach(function (n) {
        if (dist[n.id] !== undefined) return;
        var targets = (out[n.id] || []).map(function (e) { return dist[e.to]; }).filter(function (d) { return d !== undefined; });
        if (targets.length) {
          dist[n.id] = Math.min.apply(null, targets) + 1;
          queue.push(n.id);
          changed = true;
        }
      });
      bfs();
    }
    nodes.forEach(function (n) {
      if (dist[n.id] === undefined && !reachedSomehow[n.id]) { dist[n.id] = 0; queue.push(n.id); }
    });
    bfs();
    var order = nodes.slice().sort(function (a, b) {
      var da = dist[a.id] === undefined ? 1e6 : dist[a.id];
      var db = dist[b.id] === undefined ? 1e6 : dist[b.id];
      return da - db || entryScore(a) - entryScore(b) || TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.label.localeCompare(b.label);
    });
    var rank = {};
    order.forEach(function (n, i) { rank[n.id] = i; });
    return rank;
  }
  function entryScore(n) {
    var name = (n.name || "") + " " + n.uri;
    if (n.uri === "/" || /dashboard|home/i.test(name)) return 0;
    if (/\.index$|^List /.test(n.name || "") || /^List /.test(n.label)) return 1;
    return 2;
  }
  function triggerRank(e) { return { link: 0, submit: 1, redirect: 2, ajax: 3 }[e.trigger] || 4; }

  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    select(null);
    applyModeChrome();
    layout(true);
  }

  function applyModeChrome() {
    var proc = state.mode === "process";
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-mode") === state.mode);
    });
    $("#processes-section").style.display = proc ? "block" : "none";
    $("#legend-process").style.display = proc ? "block" : "none";
    $("#features-section").style.display = proc ? "none" : "block";
    $("#legend-screens").style.display = proc ? "none" : "block";
    $("#btn-direction").style.display = proc ? "none" : "";
    $("#data-toggle-row").style.visibility = proc ? "hidden" : "visible";
    $("#stat-features").textContent = proc ? PROCESSES.length : data.features.length;
    $("#stat-features").nextElementSibling.textContent = proc ? "processes" : "features";
  }

  function layout(refit) {
    if (state.mode === "process") { layoutProcesses(refit); return; }
    var nodes = visibleNodes();
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var edges = data.edges.filter(function (e) { return ids[e.from] && ids[e.to]; });
    var rank = journeyRank(nodes, edges);
    var groups = {};
    nodes.forEach(function (n) { (groups[n.feature] = groups[n.feature] || []).push(n); });
    var features = data.features.filter(function (f) { return groups[f.id]; });
    features.forEach(function (f) {
      groups[f.id].sort(function (a, b) { return rank[a.id] - rank[b.id]; });
      f._rank = rank[groups[f.id][0].id];
    });
    features.sort(function (a, b) { return a._rank - b._rank; });

    // One layout per feature: a feature reads left to right on its own.
    var jobs = features.map(function (f) {
      var inside = {};
      groups[f.id].forEach(function (n) { inside[n.id] = true; });
      var own = edges.filter(function (e) { return inside[e.from] && inside[e.to]; });
      own.sort(function (a, b) {
        var fa = FORWARD[a.trigger] && a.outcome !== "error" ? 0 : 1;
        var fb = FORWARD[b.trigger] && b.outcome !== "error" ? 0 : 1;
        return fa - fb || rank[a.from] - rank[b.from];
      });
      return elk.layout({
        id: "feature::" + f.id,
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": state.direction,
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
          "elk.layered.spacing.nodeNodeBetweenLayers": "56",
          "elk.spacing.nodeNode": "22",
          "elk.spacing.edgeNode": "18",
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.padding": "[top=42,left=16,bottom=16,right=16]",
        },
        labels: [{ text: f.name }],
        children: groups[f.id].map(function (n) {
          var sz = nodeSize(n);
          return { id: n.id, width: sz.w, height: sz.h };
        }),
        edges: own.map(function (e) {
          var lbl = e.label ? [{ text: e.label, width: e.label.length * 6.4 + 10, height: 16 }] : [];
          // Edges that go against the journey (back, retry, "return to list") are laid out
          // reversed so they never pull a later step to the left; drawn the right way round.
          var backwards = rank[e.from] > rank[e.to];
          reversed[e.id] = backwards;
          return backwards
            ? { id: e.id, sources: [e.to], targets: [e.from], labels: lbl }
            : { id: e.id, sources: [e.from], targets: [e.to], labels: lbl };
        }),
      });
    });

    Promise.all(jobs).then(function (results) {
      // Pack feature boxes into rows, in journey order.
      var gap = 48;
      var area = results.reduce(function (s, r) { return s + r.width * r.height; }, 0);
      var widest = results.reduce(function (m, r) { return Math.max(m, r.width); }, 0);
      var rowWidth = Math.max(widest, Math.sqrt(area) * 1.6);
      var x = 0, y = 0, rowH = 0;
      var children = [];
      var edgesOut = [];
      results.forEach(function (r) {
        if (x > 0 && x + r.width > rowWidth) { x = 0; y += rowH + gap; rowH = 0; }
        children.push({ id: r.id, x: x, y: y, width: r.width, height: r.height, labels: r.labels, children: r.children });
        (r.edges || []).forEach(function (e) { e.container = r.id; edgesOut.push(e); });
        x += r.width + gap;
        rowH = Math.max(rowH, r.height);
      });
      // Edges between features: drawn as faint curves, highlighted on selection.
      edges.forEach(function (e) {
        if (nodesById[e.from].feature !== nodesById[e.to].feature) {
          edgesOut.push({ id: e.id, container: "root", sections: [], labels: [] });
        }
      });
      draw({ children: children, edges: edgesOut, width: rowWidth, height: y + rowH });
      if (refit) fit();
      else applyTransform();
      if (state.pending) {
        var p = state.pending;
        state.pending = null;
        if (p.selected) select(p.selected);
        else if (p.feature) selectFeature(p.feature);
        else if (p.project) selectProject();
      }
    }).catch(function (err) {
      console.error(err);
      $("#empty").textContent = "Layout failed: " + err;
      $("#empty").style.display = "grid";
    });
  }

  // ----------------------------------------------------------------- draw
  var nodeEls = {};
  var edgeEls = {};

  function draw(res) {
    viewport.innerHTML = "";
    nodeEls = {};
    edgeEls = {};
    $("#empty").style.display = res.children && res.children.length ? "none" : "grid";
    state.graphSize = { w: res.width || 1, h: res.height || 1 };

    var offsets = { root: { x: 0, y: 0 } };
    var groupLayer = el("g", {});
    var edgeLayer = el("g", {});
    var nodeLayer = el("g", {});
    viewport.appendChild(groupLayer);
    viewport.appendChild(edgeLayer);
    viewport.appendChild(nodeLayer);

    (res.children || []).forEach(function (g) {
      offsets[g.id] = { x: g.x, y: g.y };
      var fid = g.id.slice("feature::".length);
      var color = featureColor[fid];
      groupLayer.appendChild(el("rect", {
        x: g.x, y: g.y, width: g.width, height: g.height, rx: 14,
        fill: tint(color, 0.06), stroke: tint(color, 0.35), "class": "feature-box",
      }));
        var title = el("text", { x: g.x + 16, y: g.y + 26, fill: color, "class": "feature-title" });
      title.textContent = g.labels && g.labels[0] ? g.labels[0].text : fid;
      title.addEventListener("click", function (ev) { ev.stopPropagation(); selectFeature(fid); });
      var ftip = el("title", {});
      ftip.textContent = (featureById(fid).description || "") + (EDIT ? "\nClick to edit this feature" : "");
      title.appendChild(ftip);
      groupLayer.appendChild(title);

      (g.children || []).forEach(function (c) {
        var n = nodesById[c.id];
        var x = g.x + c.x, y = g.y + c.y;
        var node = el("g", { "class": "node" + (n.hidden ? " is-hidden" : "") + (n.review ? " needs-review" : ""), transform: "translate(" + x + "," + y + ")" });
        node.appendChild(el("rect", { "class": "card", width: c.width, height: c.height, rx: 9 }));
        node.appendChild(el("rect", { width: 5, height: c.height - 12, x: 6, y: 6, rx: 2.5, fill: TYPE_COLOR[n.type] || "#94a3b8" }));
        var label = el("text", { x: 20, y: 22, "class": "label" });
        label.textContent = truncate(n.label, Math.floor((c.width - 30) / 7.2));
        node.appendChild(label);
        var sub = el("text", { x: 20, y: 39, "class": "sub mono" });
        sub.textContent = truncate(subtitle(n), Math.floor((c.width - 30) / 6.3));
        node.appendChild(sub);
        if (n.review) node.appendChild(el("circle", { cx: c.width - 10, cy: 10, r: 4.5, "class": "review-dot" }));
        else if (n.description) node.appendChild(el("circle", { cx: c.width - 10, cy: 10, r: 3.5, "class": "note-dot" }));
        var tip = el("title", {});
        tip.textContent = n.label + "\n" + subtitle(n) + (n.description ? "\n\n" + n.description : "");
        node.appendChild(tip);
        node.addEventListener("click", function (ev) { ev.stopPropagation(); select(n.id); });
        nodeLayer.appendChild(node);
        nodeEls[n.id] = node;
        n._box = { x: x, y: y, w: c.width, h: c.height };
      });
    });

    (res.edges || []).forEach(function (e) {
      var meta = data.edges.find(function (x) { return x.id === e.id; });
      var off = offsets[e.container] || { x: 0, y: 0 };
      var cls = ["edge", meta.trigger];
      if (meta.outcome === "error") cls.push("error");
      var g = el("g", { "class": cls.join(" ") });
      var marker = meta.outcome === "error" ? "url(#arrow-error)" : meta.trigger === "submit" ? "url(#arrow-submit)" : "url(#arrow)";
      var a = nodesById[meta.from], b = nodesById[meta.to];
      var crossFeature = a.feature !== b.feature;
      if (crossFeature) g.classList.add("cross");
      var labelPos = null;
      if (crossFeature && a._box && b._box) {
        // Edges between features: a direct curve reads better than routing around groups.
        var curve = bezierBetween(a._box, b._box);
        g.appendChild(el("path", { d: curve.d, "marker-end": marker }));
        labelPos = curve.mid;
      } else {
        (e.sections || []).forEach(function (s) {
          var pts = [s.startPoint].concat(s.bendPoints || [], [s.endPoint]);
          if (reversed[e.id]) pts.reverse();
          var d = pts.map(function (p, i) { return (i ? "L" : "M") + (p.x + off.x) + " " + (p.y + off.y); }).join(" ");
          g.appendChild(el("path", { d: d, "marker-end": marker }));
        });
      }
      (e.labels || []).forEach(function (l) {
        var x = labelPos ? labelPos.x - l.width / 2 : l.x + off.x;
        var y = labelPos ? labelPos.y - l.height / 2 : l.y + off.y;
        var lg = el("g", { "class": "edge-label" });
        lg.appendChild(el("rect", { x: x, y: y, width: l.width, height: l.height, rx: 3 }));
        var t = el("text", { x: x + 5, y: y + 12 });
        t.textContent = l.text;
        lg.appendChild(t);
        g.appendChild(lg);
      });
      edgeLayer.appendChild(g);
      edgeEls[e.id] = g;
    });

    // Fit to the drawn content, not to ELK's routing area.
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    (res.children || []).forEach(function (c) {
      minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width); maxY = Math.max(maxY, c.y + c.height);
    });
    if (isFinite(minX)) state.bounds = { x: minX - 30, y: minY - 30, w: maxX - minX + 60, h: maxY - minY + 60 };
    else state.bounds = { x: 0, y: 0, w: 1, h: 1 };

    applyTransform();
    applyHighlight();
  }


  // ------------------------------------------------------------ process view

  function processById(id) { return PROCESSES.find(function (p) { return p.id === id; }); }
  function stateOf(p, id) { return p.states.find(function (s) { return s.id === id; }) || { label: id, value: id, code: id }; }
  function laneById(p, id) { return p.lanes.find(function (l) { return l.id === id; }) || { name: id, evidence: [] }; }

  /** Columns: creation first, then each step after the step that produces the status it needs. */
  function processColumns(p) {
    var col = {}, level = {};
    var queue = [];
    p.steps.forEach(function (s) { if (s.creates) { col[s.node] = 0; queue.push(s); } });
    if (!queue.length && p.initial) level[p.initial] = 0;
    var changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      p.steps.forEach(function (s) {
        if (col[s.node] !== undefined) s.to.forEach(function (t) {
          if (level[t] === undefined || level[t] > col[s.node] + 1) { level[t] = col[s.node] + 1; changed = true; }
        });
      });
      p.steps.forEach(function (s) {
        var lv = s.from.map(function (f) { return level[f]; }).filter(function (x) { return x !== undefined; });
        if (lv.length) {
          var c = Math.min.apply(null, lv);
          if (col[s.node] === undefined || (col[s.node] > c && !s.creates)) { col[s.node] = c; changed = true; }
        }
      });
    }
    var base = p.steps.some(function (s) { return s.creates; }) ? 1 : 0;
    p.steps.forEach(function (s) { if (col[s.node] === undefined) col[s.node] = base; });
    return col;
  }

  function layoutProcesses(refit) {
    viewport.innerHTML = "";
    nodeEls = {}; edgeEls = {};
    state.procEdges = [];
    var groupLayer = el("g", {}), edgeLayer = el("g", {}), nodeLayer = el("g", {});
    viewport.appendChild(groupLayer); viewport.appendChild(edgeLayer); viewport.appendChild(nodeLayer);
    var y = 0, maxW = 0;
    var shown = PROCESSES.filter(function (p) { return !state.hiddenProc[p.id]; });
    $("#empty").style.display = shown.length ? "none" : "grid";
    shown.forEach(function (p) {
      var steps = p.steps.filter(function (s) { return nodesById[s.node] && (state.showHidden || !nodesById[s.node].hidden); });
      var col = processColumns(p);
      var maxCol = 0;
      steps.forEach(function (s) { maxCol = Math.max(maxCol, col[s.node]); });
      // Lane order: by the first column a lane works in
      var laneFirst = {};
      steps.forEach(function (s) { laneFirst[s.lane] = Math.min(laneFirst[s.lane] === undefined ? 99 : laneFirst[s.lane], col[s.node]); });
      var lanes = p.lanes.filter(function (l) { return laneFirst[l.id] !== undefined; })
        .sort(function (a, b) { return laneFirst[a.id] - laneFirst[b.id] || (a.provenance === "extracted" && /^(signed-in-user|anyone)$/.test(a.id) ? -1 : 0); });
      // Stack steps that share a lane and column
      var slot = {}, laneRows = {};
      steps.forEach(function (s) {
        var k = s.lane + "|" + col[s.node];
        slot[s.node] = slot[k] = (slot[k] === undefined ? 0 : slot[k] + 1);
        laneRows[s.lane] = Math.max(laneRows[s.lane] || 1, slot[s.node] + 1);
      });
      var endW = 0;
      steps.forEach(function (s) { if (s.to.some(function (t) { return !consumers(p, t).length; })) endW = 160; });
      var width = LABEL_W + (maxCol + 1) * COL_W + endW + 40;
      var top = y + 56;
      var laneY = {}, cy = top;
      lanes.forEach(function (l) {
        var h = laneRows[l.id] * (CARD_H + STACK_GAP) - STACK_GAP + LANE_PAD * 2;
        laneY[l.id] = { y: cy, h: h };
        cy += h;
      });
      var height = cy - y + 20;
      maxW = Math.max(maxW, width);

      groupLayer.appendChild(el("rect", { x: 0, y: y, width: width, height: height, rx: 14, "class": "proc-box" }));
      var title = el("text", { x: 18, y: y + 28, "class": "proc-title" });
      title.textContent = p.name;
      title.addEventListener("click", function (ev) { ev.stopPropagation(); selectProcess(p.id); });
      groupLayer.appendChild(title);
      var sub = el("text", { x: 18, y: y + 45, "class": "proc-sub" });
      sub.textContent = p.subject.replace(/^\./, "") + " · " + p.states.length + " statuses · " + lanes.length + " roles";
      groupLayer.appendChild(sub);

      lanes.forEach(function (l, i) {
        var ly = laneY[l.id];
        groupLayer.appendChild(el("rect", { x: 8, y: ly.y, width: width - 16, height: ly.h, "class": "lane-band" + (i % 2 ? " alt" : "") }));
        var lt = el("text", { x: 20, y: ly.y + ly.h / 2 + 4, "class": "lane-label" + (/^(signed-in-user|anyone)$/.test(l.id) && l.provenance !== "human" ? " fallback" : "") + (l.provenance === "inferred" ? " inferred" : "") });
        var lines = wrapWords(l.name, 22, 3);
        lines.forEach(function (line, li) {
          var ts = el("tspan", { x: 20, dy: li ? 15 : -(lines.length - 1) * 7.5 });
          ts.textContent = line;
          lt.appendChild(ts);
        });
        var tip = el("title", {});
        tip.textContent = l.name + "\n" + l.evidence.join("\n") + (EDIT ? "\nClick to rename" : "");
        lt.appendChild(tip);
        lt.addEventListener("click", function (ev) { ev.stopPropagation(); selectLane(p.id, l.id); });
        groupLayer.appendChild(lt);
      });

      var box = {};
      steps.forEach(function (s) {
        var ly = laneY[s.lane];
        var x = LABEL_W + col[s.node] * COL_W;
        var sy = ly.y + LANE_PAD + slot[s.node] * (CARD_H + STACK_GAP);
        box[s.node] = { x: x, y: sy, w: CARD_W, h: CARD_H };
        var n = nodesById[s.node];
        var g = el("g", { "class": "node" + (n.hidden ? " is-hidden" : "") + (n.review ? " needs-review" : ""), transform: "translate(" + x + "," + sy + ")" });
        g.appendChild(el("rect", { "class": "card", width: CARD_W, height: CARD_H, rx: 9 }));
        g.appendChild(el("rect", { width: 5, height: CARD_H - 12, x: 6, y: 6, rx: 2.5, fill: s.to.length ? "#d97706" : "#94a3b8" }));
        var lb = el("text", { x: 20, y: 21, "class": "label" });
        lb.textContent = truncate(n.label, 24);
        g.appendChild(lb);
        var tl = el("text", { x: 20, y: 38, "class": "to-line" + (s.to.length ? "" : " none") });
        tl.textContent = truncate(s.creates && !s.to.length ? "creates the record" : s.to.length ? "→ " + s.to.map(function (t) { return stateOf(p, t).label; }).join(" / ") : "status unchanged", 30);
        g.appendChild(tl);
        if (n.review) g.appendChild(el("circle", { cx: CARD_W - 10, cy: 10, r: 4.5, "class": "review-dot" }));
        else if (n.description) g.appendChild(el("circle", { cx: CARD_W - 10, cy: 10, r: 3.5, "class": "note-dot" }));
        var tip = el("title", {});
        tip.textContent = n.label + "\n" + laneById(p, s.lane).name + (s.from.length ? "\nwhen: " + s.from.map(function (f) { return stateOf(p, f).label; }).join(" or ") : "") + (n.description ? "\n\n" + n.description : "");
        g.appendChild(tip);
        g.addEventListener("click", function (ev) { ev.stopPropagation(); select(s.node); });
        nodeLayer.appendChild(g);
        nodeEls[s.node] = g;
        n._box = box[s.node];
      });

      // Start: a dot into the steps that create the record
      steps.filter(function (s) { return s.creates; }).forEach(function (s) {
        var b = box[s.node];
        groupLayer.appendChild(el("circle", { cx: b.x - 34, cy: b.y + b.h / 2, r: 6, "class": "start-dot" }));
        var e = el("g", { "class": "pedge start" });
        e.appendChild(el("path", { d: "M" + (b.x - 28) + " " + (b.y + b.h / 2) + " L" + (b.x - 2) + " " + (b.y + b.h / 2), "marker-end": "url(#arrow)" }));
        edgeLayer.appendChild(e);
      });

      // Transitions: producer -> consumer, labelled with the status in between
      var endCount = {};
      var inbound = {}, inboundLabelled = {};
      steps.forEach(function (s) {
        s.to.forEach(function (t) {
          consumers(p, t).forEach(function (c) { if (box[c.node]) inbound[c.node + "|" + t] = (inbound[c.node + "|" + t] || 0) + 1; });
        });
      });
      steps.forEach(function (s) {
        s.to.forEach(function (t) {
          var st = stateOf(p, t);
          var neg = NEGATIVE.test(st.label) || NEGATIVE.test(st.value);
          var cons = consumers(p, t).filter(function (c) { return box[c.node]; });
          if (!cons.length) {
            var b = box[s.node];
            var k = endCount[s.node] = (endCount[s.node] || 0) + 1;
            var pw = Math.min(150, 16 + st.label.length * 6.2);
            var px = b.x + b.w + 46, py = b.y + 4 + (k - 1) * 24;
            var e = el("g", { "class": "pedge" + (neg ? " negative" : "") });
            e.appendChild(el("path", { d: "M" + (b.x + b.w) + " " + (b.y + b.h / 2) + " C" + (b.x + b.w + 24) + " " + (b.y + b.h / 2) + " " + (px - 22) + " " + (py + 9) + " " + (px - 2) + " " + (py + 9), "marker-end": "url(#arrow)" }));
            edgeLayer.appendChild(e);
            var pill = el("g", { "class": "state-end" + (neg ? " negative" : "") });
            pill.appendChild(el("rect", { x: px, y: py, width: pw, height: 18, rx: 9 }));
            var tx = el("text", { x: px + 8, y: py + 13 });
            tx.textContent = truncate(st.label, 24);
            pill.appendChild(tx);
            pill.addEventListener("click", function (ev) { ev.stopPropagation(); selectState(p.id, t); });
            nodeLayer.appendChild(pill);
            var id0 = "p" + state.procEdges.length;
            state.procEdges.push({ id: id0, from: s.node, to: s.node });
            edgeEls[id0] = e;
            return;
          }
          var shared = cons.length > 1;
          cons.forEach(function (c, ci) {
            var a = box[s.node], b = box[c.node];
            var d, mid;
            if (b.x > a.x) {
              var x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, k = Math.max(40, (x2 - x1) / 2);
              d = "M" + x1 + " " + y1 + " C" + (x1 + k) + " " + y1 + " " + (x2 - k) + " " + y2 + " " + (x2 - 2) + " " + y2;
              mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
            } else {
              // Back to an earlier column: loop under the cards
              var bx1 = a.x + a.w / 2, by1 = a.y + a.h, bx2 = b.x + b.w / 2, by2 = b.y + b.h;
              var low = Math.max(by1, by2) + 34;
              d = "M" + bx1 + " " + by1 + " C" + bx1 + " " + low + " " + bx2 + " " + low + " " + bx2 + " " + (by2 + 2);
              mid = { x: (bx1 + bx2) / 2, y: low - 8 };
            }
            var e = el("g", { "class": "pedge" + (neg ? " negative" : "") });
            e.appendChild(el("path", { d: d, "marker-end": neg ? "url(#arrow-error)" : "url(#arrow)" }));
            edgeLayer.appendChild(e);
            var id = "p" + state.procEdges.length;
            state.procEdges.push({ id: id, from: s.node, to: c.node });
            edgeEls[id] = e;
            // One label per status: at the fork when one step fans out, at the target when
            // several steps lead into it with the same status, otherwise in the middle.
            var lw = Math.min(136, 14 + st.label.length * 5.9);
            var key = c.node + "|" + t;
            if (inbound[key] > 1) {
              if (inboundLabelled[key]) return;
              inboundLabelled[key] = true;
              mid = b.x > a.x ? { x: b.x - 10 - lw / 2, y: b.y + b.h / 2 - 16 } : { x: b.x + b.w / 2, y: b.y + b.h + 16 };
            } else if (shared) {
              if (ci > 0) return;
              mid = b.x > a.x ? { x: a.x + a.w + 12 + lw / 2, y: a.y + a.h / 2 - 16 } : { x: a.x + a.w / 2, y: a.y + a.h + 16 };
            }
            var lg = el("g", { "class": "plabel" });
            lg.appendChild(el("rect", { x: mid.x - lw / 2, y: mid.y - 9, width: lw, height: 17, rx: 8.5 }));
            var tx = el("text", { x: mid.x, y: mid.y + 3.5, "text-anchor": "middle" });
            tx.textContent = truncate(st.label, 21);
            lg.appendChild(tx);
            lg.addEventListener("click", function (ev) { ev.stopPropagation(); selectState(p.id, t); });
            e.appendChild(lg);
          });
        });
      });
      y += height + 36;
    });
    state.bounds = { x: -30, y: -30, w: maxW + 60, h: Math.max(y, 1) + 30 };
    if (refit) fit(); else applyTransform();
    applyHighlight();
    if (state.pending) {
      var pend = state.pending;
      state.pending = null;
      if (pend.selected) select(pend.selected);
      else if (pend.lane) selectLane(pend.lane[0], pend.lane[1]);
      else if (pend.stateSel) selectState(pend.stateSel[0], pend.stateSel[1]);
      else if (pend.process) selectProcess(pend.process);
      else if (pend.project) selectProject();
    }
  }

  function wrapWords(text, width, maxLines) {
    var words = String(text).split(/\s+/), lines = [], cur = "";
    words.forEach(function (w) {
      if ((cur + " " + w).trim().length > width && cur) { lines.push(cur); cur = w; }
      else cur = (cur + " " + w).trim();
    });
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = truncate(lines[maxLines - 1] + "…", width); }
    return lines;
  }

  function consumers(p, stateId) {
    return p.steps.filter(function (s) { return s.from.indexOf(stateId) >= 0; });
  }

  function renderProcessList() {
    var ul = $("#processes");
    ul.innerHTML = "";
    PROCESSES.forEach(function (p) {
      var li = h("li");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.hiddenProc[p.id];
      cb.onchange = function () { state.hiddenProc[p.id] = !cb.checked; layout(true); };
      var name = h("span", "name", p.name);
      name.onclick = function () { selectProcess(p.id); };
      var only = h("button", "only", "only");
      only.onclick = function () {
        PROCESSES.forEach(function (x) { state.hiddenProc[x.id] = x.id !== p.id; });
        renderProcessList(); layout(true);
      };
      li.appendChild(cb); li.appendChild(name); li.appendChild(only);
      li.appendChild(h("span", "count", String(p.steps.length)));
      ul.appendChild(li);
    });
  }

  function openPanel(render) {
    state.selected = null;
    applyHighlight();
    var d = $("#details-body");
    d.innerHTML = "";
    render(d);
    $("#details").classList.add("open");
  }

  function selectProcess(pid) {
    var p = processById(pid);
    if (!p) return;
    state.panel = { process: pid };
    openPanel(function (d) {
      d.appendChild(h("h2", null, p.name));
      var badges = h("div", "badges");
      badges.appendChild(h("span", "badge", "process"));
      badges.appendChild(h("span", "badge mono", p.subject.replace(/^\./, "")));
      d.appendChild(badges);
      var f = featureById(p.feature);
      if (f.description) d.appendChild(h("p", "description", f.description));
      d.appendChild(h("h4", null, "Statuses (" + p.states.length + ")"));
      d.appendChild(statesTable(p));
      d.appendChild(h("h4", null, "Roles (" + p.lanes.length + ")"));
      var ul = h("ul", "nav");
      p.lanes.forEach(function (l) {
        var li = h("li");
        li.appendChild(h("div", null, l.name));
        li.appendChild(h("div", "how", l.evidence.join(" · ")));
        li.onclick = function () { selectLane(p.id, l.id); };
        ul.appendChild(li);
      });
      d.appendChild(ul);
    });
  }

  function statesTable(p, only) {
    var t = h("table", "states-table");
    var inputs = [];
    p.states.filter(function (s) { return !only || s.id === only; }).forEach(function (s) {
      var tr = h("tr");
      var tdL = h("td");
      if (EDIT) {
        var inp = document.createElement("input");
        inp.value = s.named === "raw" ? "" : s.label;
        inp.placeholder = s.label;
        inp.setAttribute("data-value", s.value);
        inputs.push({ input: inp, state: s });
        tdL.appendChild(inp);
      } else tdL.textContent = s.label;
      tr.appendChild(tdL);
      tr.appendChild(h("td", "mono", s.code + (s.id === p.initial ? " · initial" : "")));
      t.appendChild(tr);
    });
    if (!EDIT) return t;
    var wrap = h("form", "edit-form");
    wrap.appendChild(t);
    wrap.appendChild(h("div", "hint", "Name statuses the way the business says them. Empty uses the name from the code."));
    formButtons(wrap, function () {
      var changed = inputs.filter(function (x) {
        var orig = x.state.named === "human" ? x.state.label : null;
        var v = x.input.value.trim();
        return x.state.named === "human" ? v !== orig : v && v !== x.state.label;
      });
      if (!changed.length) return Promise.resolve(location.reload());
      return changed.reduce(function (pr, x, i) {
        return pr.then(function () {
          return post({ target: "status", id: p.subject, fields: { value: x.state.value, label: x.input.value } }, i === changed.length - 1);
        });
      }, Promise.resolve());
    });
    return wrap;
  }

  function selectLane(pid, laneId) {
    var p = processById(pid);
    if (!p) return;
    var l = laneById(p, laneId);
    state.panel = { lane: [pid, laneId] };
    openPanel(function (d) {
      d.appendChild(h("h2", null, l.name));
      var badges = h("div", "badges");
      badges.appendChild(h("span", "badge", "role"));
      if (l.provenance === "human") badges.appendChild(h("span", "badge human", "named by a person"));
      if (l.provenance === "inferred") badges.appendChild(h("span", "badge", "from a route name"));
      d.appendChild(badges);
      d.appendChild(h("h4", null, "Found in"));
      var ev = h("ul", "evidence");
      l.evidence.forEach(function (x) { ev.appendChild(h("li", null, x)); });
      d.appendChild(ev);
      if (EDIT) {
        var form = h("form", "edit-form");
        var name = field(form, "Role name", "input", l.provenance === "human" ? l.name : "");
        name.placeholder = l.name;
        form.appendChild(h("div", "hint", "Renames this role in every process. Empty uses the name from the code."));
        formButtons(form, function () { return save({ target: "role", id: l.id, fields: { name: name.value } }); });
        d.appendChild(form);
      }
      d.appendChild(h("h4", null, "Steps"));
      var ul = h("ul", "nav");
      p.steps.filter(function (s) { return s.lane === l.id; }).forEach(function (s) {
        var li = h("li");
        li.appendChild(h("div", null, nodesById[s.node].label));
        li.onclick = function () { select(s.node); centerOn(s.node); };
        ul.appendChild(li);
      });
      d.appendChild(ul);
    });
  }

  function selectState(pid, stateId) {
    var p = processById(pid);
    if (!p) return;
    var st = stateOf(p, stateId);
    state.panel = { stateSel: [pid, stateId] };
    openPanel(function (d) {
      d.appendChild(h("h2", null, st.label));
      var badges = h("div", "badges");
      badges.appendChild(h("span", "badge", "status"));
      badges.appendChild(h("span", "badge mono", st.code));
      if (st.named === "human") badges.appendChild(h("span", "badge human", "named by a person"));
      if (st.named === "raw") badges.appendChild(h("span", "badge", "no name in the code"));
      d.appendChild(badges);
      d.appendChild(statesTable(p, stateId));
      var into = p.steps.filter(function (s) { return s.to.indexOf(stateId) >= 0; });
      var out = consumers(p, stateId);
      navSteps(d, "Set by", into);
      navSteps(d, "Next steps from here", out);
    });
  }

  function navSteps(d, title, steps) {
    d.appendChild(h("h4", null, title + " (" + steps.length + ")"));
    if (!steps.length) { d.appendChild(h("div", "how", "—")); return; }
    var ul = h("ul", "nav");
    steps.forEach(function (s) {
      var li = h("li");
      li.appendChild(h("div", null, nodesById[s.node].label));
      li.onclick = function () { select(s.node); centerOn(s.node); };
      ul.appendChild(li);
    });
    d.appendChild(ul);
  }

  /** Process facts about a step, shown in its details. */
  function processSection(d, n) {
    PROCESSES.forEach(function (p) {
      var s = p.steps.find(function (x) { return x.node === n.id; });
      if (!s) return;
      d.appendChild(h("h4", null, "In " + p.name));
      var dl = h("dl");
      var lane = laneById(p, s.lane);
      row(dl, "Who", lane.name);
      row(dl, "When", s.from.length ? s.from.map(function (f) { return stateOf(p, f).label; }).join(" or ") + " (" + { guard: "checked in code", view: "button shown only then", page: "page shown only then" }[s.fromVia] + ")" : "not restricted in code");
      row(dl, "Result", s.to.length ? s.to.map(function (t) { return stateOf(p, t).label; }).join(" or ") : s.creates ? "creates the record" : "status unchanged");
      d.appendChild(dl);
      var ev = h("ul", "evidence");
      lane.evidence.forEach(function (x) { ev.appendChild(h("li", null, x)); });
      d.appendChild(ev);
    });
  }

  // ------------------------------------------------------------ selection
  function select(id) {
    state.selected = id;
    state.selectedFeature = null;
    state.panel = null;
    applyHighlight();
    var panel = $("#details");
    if (!id || !nodesById[id]) { state.selected = null; panel.classList.remove("open"); return; }
    renderDetails(nodesById[id]);
    panel.classList.add("open");
  }

  function selectFeature(fid) {
    state.panel = null;
    state.selected = null;
    state.selectedFeature = fid;
    applyHighlight();
    renderFeatureDetails(featureById(fid));
    $("#details").classList.add("open");
  }

  function matches() {
    if (!state.query) return [];
    return visibleNodes().filter(function (n) {
      return [n.label, n.uri, n.name || "", n.feature, n.view && n.view.name || "", n.handler && n.handler.class || ""]
        .join(" ").toLowerCase().indexOf(state.query) >= 0;
    });
  }

  function applyHighlight() {
    var sel = state.selected;
    var related = {};
    var hlEdges = {};
    if (sel) {
      related[sel] = true;
      (state.mode === "process" ? state.procEdges : data.edges).forEach(function (e) {
        if (e.from === sel || e.to === sel) { related[e.from] = related[e.to] = true; hlEdges[e.id] = true; }
      });
    }
    var m = {};
    matches().forEach(function (n) { m[n.id] = true; });
    Object.keys(nodeEls).forEach(function (id) {
      var elx = nodeEls[id];
      elx.classList.toggle("selected", id === sel);
      elx.classList.toggle("match", !!m[id]);
      var dimmed = (sel && !related[id]) || (state.query && !m[id] && !sel);
      elx.classList.toggle("dim", !!dimmed);
    });
    Object.keys(edgeEls).forEach(function (id) {
      edgeEls[id].classList.toggle("hl", !!hlEdges[id]);
      edgeEls[id].classList.toggle("dim", !!(sel && !hlEdges[id]) || !!(state.query && !sel));
    });
  }

  function renderDetails(n) {
    var d = $("#details-body");
    d.innerHTML = "";
    d.appendChild(h("h2", null, n.label));
    var badges = h("div", "badges");
    badges.appendChild(h("span", "badge " + n.type, n.type));
    n.methods.forEach(function (m) { badges.appendChild(h("span", "badge mono", m)); });
    badges.appendChild(h("span", "badge", featureById(n.feature).name));
    if (n.provenance === "human") badges.appendChild(h("span", "badge human", "named by a person"));
    if (n.hidden) badges.appendChild(h("span", "badge", "hidden"));
    d.appendChild(badges);
    if (n.review) d.appendChild(h("div", "review", n.review));
    if (n.description) d.appendChild(h("p", "description", n.description));
    else if (!EDIT) d.appendChild(h("p", "description empty", "No description yet. Run builtlore serve to add one."));
    if (EDIT) d.appendChild(stepForm(n));
    processSection(d, n);
    d.appendChild(h("h4", null, "In the code"));

    var dl = h("dl");
    row(dl, "URI", "/" + (n.uri === "/" ? "" : n.uri), true);
    if (n.name) row(dl, "Route name", n.name, true);
    if (n.handler && n.handler.kind === "controller") row(dl, "Handler", shortClass(n.handler.class) + "@" + n.handler.method, true);
    else if (n.handler) row(dl, "Handler", n.handler.kind);
    if (n.handler && n.handler.file) row(dl, "Handler file", loc(n.handler.file, n.handler.line), true);
    if (n.view) row(dl, "View", n.view.engine + ": " + n.view.name, true);
    if (n.view && n.view.file) row(dl, "View file", n.view.file, true);
    row(dl, "Defined in", loc(n.source.file, n.source.line), true);
    if (n.middleware.length) {
      var dd = h("dd");
      n.middleware.forEach(function (m) { dd.appendChild(h("span", "chip mono", m)); });
      dl.appendChild(h("dt", null, "Middleware"));
      dl.appendChild(dd);
    }
    d.appendChild(dl);

    var out = data.edges.filter(function (e) { return e.from === n.id; });
    var inc = data.edges.filter(function (e) { return e.to === n.id; });
    navList(d, "Leads to", out, "to");
    navList(d, "Comes from", inc, "from");
  }

  function renderFeatureDetails(f) {
    var d = $("#details-body");
    d.innerHTML = "";
    d.appendChild(h("h2", null, f.name));
    var badges = h("div", "badges");
    badges.appendChild(h("span", "badge", "feature"));
    badges.appendChild(h("span", "badge", f.nodes.length + " steps"));
    if (f.provenance === "human") badges.appendChild(h("span", "badge human", "named by a person"));
    d.appendChild(badges);
    if (f.description) d.appendChild(h("p", "description", f.description));
    else if (!EDIT) d.appendChild(h("p", "description empty", "No description yet. Run builtlore serve to add one."));
    if (EDIT) {
      var form = h("form", "edit-form");
      var name = field(form, "Name", "input", f.name);
      var desc = field(form, "What this feature is for", "textarea", f.description || "");
      desc.placeholder = "e.g. Monthly target input by area managers; approved by the regional head before it counts.";
      form.appendChild(h("div", "hint", "Leave the name empty to go back to the name builtlore generates."));
      formButtons(form, function () {
        var fields = { description: desc.value };
        if (name.value !== f.name || f.provenance === "human") fields.name = name.value;
        return save({ target: "feature", id: f.id, fields: fields });
      });
      d.appendChild(form);
    }
    d.appendChild(h("h4", null, "Steps"));
    var ul = h("ul", "nav");
    f.nodes.forEach(function (id) {
      var n = nodesById[id];
      if (!n) return;
      var li = h("li");
      li.appendChild(h("div", null, n.label));
      li.appendChild(h("div", "how", subtitle(n)));
      li.onclick = function () { select(id); centerOn(id); };
      ul.appendChild(li);
    });
    d.appendChild(ul);
    if (f.files.length) {
      d.appendChild(h("h4", null, "Files (" + f.files.length + ")"));
      var fl = h("ul", "files");
      f.files.forEach(function (x) { fl.appendChild(h("li", "mono", x)); });
      d.appendChild(fl);
    }
  }

  // --------------------------------------------------------------- project
  /** What the system is for, and the glossary: the prose that opens the documentation. */
  function selectProject() {
    state.panel = { project: true };
    state.selectedFeature = null;
    openPanel(function (d) {
      var proj = data.project;
      d.appendChild(h("h2", null, proj.title || proj.name));
      var badges = h("div", "badges");
      badges.appendChild(h("span", "badge", "project"));
      if (proj.title) badges.appendChild(h("span", "badge mono", proj.name));
      d.appendChild(badges);
      if (proj.summary) d.appendChild(h("p", "description", proj.summary));
      else if (!EDIT) d.appendChild(h("p", "description empty", "No summary yet. Run builtlore serve to write one."));
      if (EDIT) {
        var form = h("form", "edit-form");
        var name = field(form, "Name", "input", proj.title || "");
        name.placeholder = proj.name;
        var sum = field(form, "What this system is for, and who uses it", "textarea", proj.summary || "");
        sum.rows = 6;
        sum.placeholder = "e.g. Staff request items, their manager approves, procurement orders them from the ERP.";
        form.appendChild(h("div", "hint", "Opens the documentation (builtlore docs). Leave the name empty to use " + proj.name + "."));
        formButtons(form, function () {
          return save({ target: "project", id: "project", fields: { name: name.value, summary: sum.value } });
        });
        d.appendChild(form);
      }

      var glossary = data.glossary || {};
      var terms = Object.keys(glossary).sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: "base" }); });
      d.appendChild(h("h4", null, "Glossary (" + terms.length + ")"));
      if (!terms.length && !EDIT) d.appendChild(h("div", "how", "No terms yet. Run builtlore serve to add them."));
      terms.forEach(function (t) {
        if (!EDIT) {
          var row = h("div", "glossary-row");
          row.appendChild(h("div", "term", t));
          row.appendChild(h("div", "def", glossary[t]));
          d.appendChild(row);
          return;
        }
        d.appendChild(glossaryForm(t, glossary[t]));
      });
      if (EDIT) {
        d.appendChild(h("div", "how", "Add a term"));
        d.appendChild(glossaryForm("", ""));
      }
    });
  }

  function glossaryForm(term, definition) {
    var form = h("form", "edit-form");
    var t = field(form, "Term", "input", term);
    t.placeholder = "e.g. PR";
    var def = field(form, "Meaning", "textarea", definition);
    def.rows = 2;
    def.placeholder = "e.g. Purchase request: a request to buy items, approved by the manager and then procurement.";
    formButtons(form, function () {
      var id = t.value.trim();
      if (!id) return Promise.reject(new Error("Write the term first."));
      return save({ target: "glossary", id: id, fields: { definition: def.value, from: term && term !== id ? term : undefined } });
    });
    if (term) {
      var remove = h("button", "link", "Remove");
      remove.type = "button";
      remove.onclick = function () {
        if (!confirm("Remove \"" + term + "\" from the glossary?")) return;
        save({ target: "glossary", id: term, fields: { definition: "" } }).catch(function (err) { alert("Not removed: " + err.message); });
      };
      form.querySelector(".form-buttons").appendChild(remove);
    }
    return form;
  }

  // --------------------------------------------------------------- editing
  function stepForm(n) {
    var form = h("form", "edit-form");
    var label = field(form, "Name", "input", n.label);
    var desc = field(form, "What happens here", "textarea", n.description || "");
    desc.placeholder = "e.g. Area manager reviews the request and approves it or sends it back with a reason.";
    var inProcess = PROCESSES.map(function (p) {
      var st = p.steps.find(function (x) { return x.node === n.id; });
      return st ? laneById(p, st.lane) : null;
    }).filter(Boolean)[0];
    var actor = null;
    if (inProcess) {
      actor = field(form, "Who does this", "input", inProcess.provenance === "human" ? inProcess.name : "");
      actor.placeholder = inProcess.name;
      actor.setAttribute("list", "lane-names");
      var ldl = document.createElement("datalist");
      ldl.id = "lane-names";
      var seen = {};
      PROCESSES.forEach(function (p) { p.lanes.forEach(function (l) { if (!seen[l.name]) { seen[l.name] = 1; var o = document.createElement("option"); o.value = l.name; ldl.appendChild(o); } }); });
      form.appendChild(ldl);
    }
    var feat = field(form, "Feature", "input", featureById(n.feature).name);
    feat.setAttribute("list", "feature-names");
    var dl = document.createElement("datalist");
    dl.id = "feature-names";
    data.features.forEach(function (f) { var o = document.createElement("option"); o.value = f.name; dl.appendChild(o); });
    form.appendChild(dl);
    form.appendChild(h("div", "hint", "Type an existing feature to move this step, or a new name to start a new feature."));
    var hideRow = h("label", "toggle-row");
    var hide = document.createElement("input");
    hide.type = "checkbox";
    hide.checked = !!n.hidden;
    hideRow.appendChild(hide);
    hideRow.appendChild(document.createTextNode(" Hide this step (internal or not worth documenting)"));
    form.appendChild(hideRow);
    var originalFeature = featureById(n.feature).name;
    formButtons(form, function () {
      var target = feat.value.trim();
      var match = data.features.find(function (f) { return f.name.toLowerCase() === target.toLowerCase(); });
      var fields = { description: desc.value, hidden: hide.checked };
      // An untouched generated name stays generated (it can still improve in later versions).
      if (label.value !== n.label || n.provenance === "human") fields.label = label.value;
      if (target && target !== originalFeature) fields.feature = match ? match.id : target;
      if (actor) fields.actor = actor.value;
      return save({ target: "step", id: n.id, fields: fields });
    });
    return form;
  }

  function field(form, labelText, tag, value) {
    var wrap = h("label", "field");
    wrap.appendChild(h("span", null, labelText));
    var input = document.createElement(tag);
    input.value = value;
    if (tag === "textarea") input.rows = 4;
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  }

  function formButtons(form, onSave) {
    var bar = h("div", "form-buttons");
    var btn = h("button", "primary", "Save");
    btn.type = "submit";
    var status = h("span", "status");
    bar.appendChild(btn);
    bar.appendChild(status);
    form.appendChild(bar);
    form.onsubmit = function (e) {
      e.preventDefault();
      btn.disabled = true;
      status.textContent = "Saving…";
      onSave().catch(function (err) {
        btn.disabled = false;
        status.textContent = "Not saved: " + err.message;
      });
    };
    form.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") form.requestSubmit();
    });
  }

  function save(patch) { return post(patch, true); }

  function post(patch, reload) {
    return fetch("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Builtlore-Token": EDIT.token },
      body: JSON.stringify(patch),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
      if (!reload) return;
      persistState();
      location.reload();
    });
  }

  function persistState() {
    try {
      sessionStorage.setItem("builtlore-state", JSON.stringify({
        hidden: state.hidden, showData: state.showData, showHidden: state.showHidden, direction: state.direction,
        view: state.view, selected: state.selected, selectedFeature: state.selectedFeature,
        mode: state.mode, hiddenProc: state.hiddenProc, panel: state.panel,
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function restoreState() {
    if (!EDIT) return false;
    try {
      var raw = sessionStorage.getItem("builtlore-state");
      if (!raw) return false;
      sessionStorage.removeItem("builtlore-state");
      var s = JSON.parse(raw);
      state.hidden = s.hidden || {};
      state.showData = !!s.showData;
      state.showHidden = !!s.showHidden;
      state.direction = s.direction || "RIGHT";
      state.view = s.view || state.view;
      state.mode = s.mode || state.mode;
      state.hiddenProc = s.hiddenProc || {};
      var pn = s.panel || {};
      state.pending = { selected: s.selected, feature: s.selectedFeature, lane: pn.lane, stateSel: pn.stateSel, process: pn.process, project: pn.project };
      $("#btn-direction").textContent = state.direction === "RIGHT" ? "Layout: left → right" : "Layout: top → bottom";
      return true;
    } catch (e) { return false; }
  }

  function navList(container, title, edges, key) {
    container.appendChild(h("h4", null, title + " (" + edges.length + ")"));
    if (!edges.length) { container.appendChild(h("div", "how", "—")); return; }
    var ul = h("ul", "nav");
    edges.forEach(function (e) {
      var target = nodesById[e[key]];
      var li = h("li");
      li.appendChild(h("div", null, target.label));
      var how = [e.trigger, e.label && e.label !== e.trigger ? e.label : null].filter(Boolean).join(" · ");
      li.appendChild(h("div", "how" + (e.outcome === "error" ? " error" : ""), how + " · " + loc(e.source.file, e.source.line)));
      li.onclick = function () { select(target.id); centerOn(target.id); };
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  // ------------------------------------------------------------- sidebar
  function renderFeatureList() {
    var ul = $("#features");
    ul.innerHTML = "";
    data.features.forEach(function (f) {
      var li = h("li");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.hidden[f.id];
      cb.onchange = function () { state.hidden[f.id] = !cb.checked; layout(true); };
      var dot = h("span", "dot");
      dot.style.background = featureColor[f.id];
      var name = h("span", "name", f.name);
      name.onclick = function () { cb.checked = !cb.checked; cb.onchange(); };
      var only = h("button", "only", "only");
      only.title = "Show only this feature";
      only.onclick = function () {
        data.features.forEach(function (x) { state.hidden[x.id] = x.id !== f.id; });
        renderFeatureList(); layout(true);
      };
      li.appendChild(cb); li.appendChild(dot); li.appendChild(name); li.appendChild(only);
      li.appendChild(h("span", "count", String(f.nodes.length)));
      ul.appendChild(li);
    });
  }

  function renderNotes() {
    var box = $("#notes");
    if (data.notes.length) {
      var det = h("details");
      det.appendChild(h("summary", null, "Scan notes (" + data.notes.length + ")"));
      var ul = h("ul");
      data.notes.forEach(function (n) { ul.appendChild(h("li", null, n)); });
      det.appendChild(ul);
      box.appendChild(det);
    }
    if (data.skipped.length) {
      var det2 = h("details");
      det2.appendChild(h("summary", null, "Skipped, not guessed (" + data.skipped.length + ")"));
      var ul2 = h("ul");
      data.skipped.slice(0, 200).forEach(function (s) {
        ul2.appendChild(h("li", null, s.reason + " — " + loc(s.source.file, s.source.line)));
      });
      det2.appendChild(ul2);
      box.appendChild(det2);
    }
  }

  // ------------------------------------------------------------ pan/zoom
  function setupPanZoom() {
    var dragging = null;
    var justDragged = false;
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      var r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });
    svg.addEventListener("mousedown", function (e) {
      dragging = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y, moved: false };
      svg.classList.add("panning");
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
      state.view.x = dragging.vx + dx;
      state.view.y = dragging.vy + dy;
      applyTransform();
    });
    window.addEventListener("mouseup", function () {
      svg.classList.remove("panning");
      justDragged = !!(dragging && dragging.moved);
      dragging = null;
    });
    svg.addEventListener("click", function () {
      if (justDragged) { justDragged = false; return; }
      if (state.selected || $("#details").classList.contains("open")) select(null);
    });
  }

  function zoomAt(px, py, factor) {
    var v = state.view;
    var k = clamp(v.k * factor, 0.1, 4);
    v.x = px - (px - v.x) * (k / v.k);
    v.y = py - (py - v.y) * (k / v.k);
    v.k = k;
    applyTransform();
  }

  function zoomBy(f) {
    var r = svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, f);
  }

  function fit() {
    var r = svg.getBoundingClientRect();
    var g = state.bounds || { x: 0, y: 0, w: 1, h: 1 };
    var k = clamp(Math.min(r.width / g.w, r.height / g.h), 0.1, 1.4);
    state.view = { k: k, x: (r.width - g.w * k) / 2 - g.x * k, y: (r.height - g.h * k) / 2 - g.y * k };
    applyTransform();
  }

  /** Cubic curve from box a to box b, leaving/entering through the facing sides. */
  function bezierBetween(a, b) {
    var ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    var pa = anchor(a, ca, cb), pb = anchor(b, cb, ca);
    var dist = Math.sqrt(Math.pow(pb.x - pa.x, 2) + Math.pow(pb.y - pa.y, 2));
    var k = clamp(dist / 3, 30, 180);
    var c1 = { x: pa.x + pa.dx * k, y: pa.y + pa.dy * k }, c2 = { x: pb.x + pb.dx * k, y: pb.y + pb.dy * k };
    var mid = {
      x: 0.125 * pa.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * pb.x,
      y: 0.125 * pa.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * pb.y,
    };
    return { d: "M" + pa.x + " " + pa.y + " C" + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + pb.x + " " + pb.y, mid: mid };
  }
  function anchor(box, from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    if (Math.abs(dx) * box.h >= Math.abs(dy) * box.w) {
      return dx >= 0 ? { x: box.x + box.w, y: from.y, dx: 1, dy: 0 } : { x: box.x, y: from.y, dx: -1, dy: 0 };
    }
    return dy >= 0 ? { x: from.x, y: box.y + box.h, dx: 0, dy: 1 } : { x: from.x, y: box.y, dx: 0, dy: -1 };
  }

  function centerOn(id) {
    var n = nodesById[id];
    if (!n || !n._box) return;
    var r = svg.getBoundingClientRect();
    var k = Math.max(state.view.k, 0.8);
    var panelW = $("#details").classList.contains("open") ? 380 : 0;
    state.view = { k: k, x: (r.width - panelW) / 2 - (n._box.x + n._box.w / 2) * k, y: r.height / 2 - (n._box.y + n._box.h / 2) * k };
    applyTransform();
  }

  function applyTransform() {
    var v = state.view;
    viewport.setAttribute("transform", "translate(" + v.x + "," + v.y + ") scale(" + v.k + ")");
  }

  // -------------------------------------------------------------- export
  function downloadSvg() {
    var clone = svg.cloneNode(true);
    var bd = state.bounds;
    clone.lastElementChild.setAttribute("transform", "translate(0,0)");
    clone.setAttribute("viewBox", bd.x + " " + bd.y + " " + bd.w + " " + bd.h);
    clone.setAttribute("width", bd.w);
    clone.setAttribute("height", bd.h);
    var style = document.createElementNS(SVG, "style");
    style.textContent = document.getElementById("builtlore-style").textContent;
    clone.insertBefore(style, clone.firstChild);
    var blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (data.project.name || "builtlore").replace(/[^\w.-]+/g, "-") + "-builtlore.svg";
    a.click();
  }

  // ------------------------------------------------------------- helpers
  function defs() {
    var d = document.createElementNS(SVG, "defs");
    [["arrow", "#94a3b8"], ["arrow-submit", "#2563eb"], ["arrow-error", "#dc2626"]].forEach(function (m) {
      var mk = el("marker", { id: m[0], viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
      mk.appendChild(el("path", { d: "M0 0 L10 5 L0 10 z", fill: m[1] }));
      d.appendChild(mk);
    });
    return d;
  }
  function el(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function row(dl, k, v, mono) {
    dl.appendChild(h("dt", null, k));
    dl.appendChild(h("dd", mono ? "mono" : null, v));
  }
  function subtitle(n) {
    return n.methods.join("|") + " /" + (n.uri === "/" ? "" : n.uri);
  }
  function featureById(id) {
    return data.features.find(function (f) { return f.id === id; }) || { name: id };
  }
  function loc(file, line) { return file ? file + (line ? ":" + line : "") : "unknown"; }
  function shortClass(c) { return (c || "").split("\\").pop(); }
  function truncate(s, n) { return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function tint(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }
})();
