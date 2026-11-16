/* builtlore viewer: renders builtlore.json as an interactive canvas.
 * Plain JS on purpose: the whole viewer ships inside one offline HTML file. */
(function () {
  "use strict";
  var SVG = "http://www.w3.org/2000/svg";
  var data = JSON.parse(document.getElementById("builtlore-data").textContent);
  var elk = new ELK();

  var PALETTE = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#dc2626", "#4f46e5", "#ea580c", "#0d9488", "#9333ea"];
  var TYPE_COLOR = { page: "#2563eb", action: "#d97706", api: "#7c3aed", redirect: "#6b7280" };

  var nodesById = {};
  data.nodes.forEach(function (n) { nodesById[n.id] = n; });
  var featureColor = {};
  data.features.forEach(function (f, i) { featureColor[f.id] = PALETTE[i % PALETTE.length]; });

  var state = {
    hidden: {},
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

  renderFeatureList();
  renderNotes();

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
    if (e.target.tagName === "INPUT") { if (e.key === "Escape") e.target.blur(); return; }
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
  $("#details .close").onclick = function () { select(null); };
  $("#all-features").onclick = function () { state.hidden = {}; renderFeatureList(); layout(true); };
  $("#no-features").onclick = function () {
    data.features.forEach(function (f) { state.hidden[f.id] = true; });
    renderFeatureList(); layout(true);
  };

  setupPanZoom();
  layout(true);

  // --------------------------------------------------------------- layout
  function visibleNodes() {
    return data.nodes.filter(function (n) { return !state.hidden[n.feature]; });
  }

  function nodeSize(n) {
    var sub = subtitle(n);
    var chars = Math.max(n.label.length * 1.05, sub.length * 0.86);
    return { w: Math.round(Math.min(300, Math.max(150, chars * 7.4 + 34))), h: 52 };
  }

  function layout(refit) {
    var nodes = visibleNodes();
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var groups = {};
    nodes.forEach(function (n) { (groups[n.feature] = groups[n.feature] || []).push(n); });

    var graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": state.direction,
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.spacing.nodeNode": "22",
        "elk.spacing.edgeNode": "18",
        "elk.spacing.componentComponent": "48",
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      },
      children: data.features.filter(function (f) { return groups[f.id]; }).map(function (f) {
        return {
          id: "feature::" + f.id,
          layoutOptions: { "elk.padding": "[top=42,left=16,bottom=16,right=16]" },
          labels: [{ text: f.name, width: f.name.length * 8 + 20, height: 16 }],
          children: groups[f.id].map(function (n) {
            var s = nodeSize(n);
            return { id: n.id, width: s.w, height: s.h };
          }),
        };
      }),
      edges: data.edges.filter(function (e) { return ids[e.from] && ids[e.to]; }).map(function (e) {
        var lbl = e.label ? [{ text: e.label, width: e.label.length * 6.4 + 10, height: 16 }] : [];
        return { id: e.id, sources: [e.from], targets: [e.to], labels: lbl };
      }),
    };

    elk.layout(graph).then(function (res) {
      draw(res);
      if (refit) fit();
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
      groupLayer.appendChild(title);

      (g.children || []).forEach(function (c) {
        var n = nodesById[c.id];
        var x = g.x + c.x, y = g.y + c.y;
        var node = el("g", { "class": "node", transform: "translate(" + x + "," + y + ")" });
        node.appendChild(el("rect", { "class": "card", width: c.width, height: c.height, rx: 9 }));
        node.appendChild(el("rect", { width: 5, height: c.height - 12, x: 6, y: 6, rx: 2.5, fill: TYPE_COLOR[n.type] || "#94a3b8" }));
        var label = el("text", { x: 20, y: 22, "class": "label" });
        label.textContent = truncate(n.label, Math.floor((c.width - 30) / 7.2));
        node.appendChild(label);
        var sub = el("text", { x: 20, y: 39, "class": "sub mono" });
        sub.textContent = truncate(subtitle(n), Math.floor((c.width - 30) / 6.3));
        node.appendChild(sub);
        var tip = el("title", {});
        tip.textContent = n.label + "\n" + subtitle(n);
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
      var labelPos = null;
      if (crossFeature && a._box && b._box) {
        // Edges between features: a direct curve reads better than routing around groups.
        var curve = bezierBetween(a._box, b._box);
        g.appendChild(el("path", { d: curve.d, "marker-end": marker }));
        labelPos = curve.mid;
      } else {
        (e.sections || []).forEach(function (s) {
          var pts = [s.startPoint].concat(s.bendPoints || [], [s.endPoint]);
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

  // ------------------------------------------------------------ selection
  function select(id) {
    state.selected = id;
    applyHighlight();
    var panel = $("#details");
    if (!id) { panel.classList.remove("open"); return; }
    renderDetails(nodesById[id]);
    panel.classList.add("open");
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
      data.edges.forEach(function (e) {
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
    d.appendChild(badges);

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
      if (state.selected) select(null);
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
