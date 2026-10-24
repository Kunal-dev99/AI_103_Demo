// Interactive concept visualizer: HTML nodes on a grid with SVG edges.
// Supports three views, node inspection, stage expansion, data-flow animation and reset.
import { h, s, clear, fmtValue } from './dom.js';

const VIEW_LABELS = { conceptual: 'Conceptual', architectural: 'Architecture', implementation: 'Implementation' };
const ROW_H = 96;
const COL_MIN = 150;

export function createVisualizer(mod) {
  const state = { view: 'conceptual', expanded: false, selected: null, active: null, statuses: {}, stepData: {}, params: null };
  const views = mod.visual.views;

  const tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Diagram view' });
  const canvas = h('div.viz-canvas');
  const scroller = h('div.viz-scroll', canvas);
  const inspector = h('aside.inspector', { 'aria-live': 'polite' });
  const legend = h('div.viz-legend.small',
    h('span.chip.tone-ok', 'ok'), h('span.chip.tone-warn', 'warning'), h('span.chip.tone-error', 'error'), h('span.chip.tone-muted', 'skipped / disabled'),
    h('span', ' Select a node to inspect it. Run the simulator to watch data move.'));
  const expandBtn = h('button.btn.ghost', { type: 'button', 'aria-pressed': 'false', onclick: () => { state.expanded = !state.expanded; expandBtn.setAttribute('aria-pressed', String(state.expanded)); expandBtn.textContent = state.expanded ? 'Collapse stages' : 'Expand stages'; draw(); } }, 'Expand stages');
  const resetBtn = h('button.btn.ghost', { type: 'button', onclick: () => api.reset() }, 'Reset view');
  for (const v of Object.keys(VIEW_LABELS)) {
    tabs.appendChild(h('button.tab', { type: 'button', role: 'tab', 'data-view': v, 'aria-selected': String(v === state.view), onclick: () => { state.view = v; draw(); } }, VIEW_LABELS[v]));
  }
  const el = h('div.visualizer',
    h('div.viz-toolbar', tabs, h('div.viz-actions', expandBtn, resetBtn)),
    h('div.viz-body', scroller, inspector),
    legend);

  let nodesById = {};
  let edges = [];
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawEdges()) : null;
  if (ro) ro.observe(canvas);

  function current() {
    try { return views[state.view](state.params) || { nodes: [], edges: [] }; }
    catch (e) { return { nodes: [{ id: 'err', label: 'Diagram error', col: 0, row: 0, detail: e.message }], edges: [] }; }
  }

  function draw() {
    tabs.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
    const g = current();
    clear(canvas);
    nodesById = {};
    edges = g.edges;
    const cols = Math.max(...g.nodes.map(n => n.col)) + 1;
    const rows = Math.max(...g.nodes.map(n => n.row)) + 1;
    const rowH = ROW_H + (state.expanded ? 40 : 0);
    canvas.style.minWidth = cols * COL_MIN + 'px';
    canvas.style.height = rows * rowH + 'px';
    const svg = s('svg', { class: 'viz-edges', 'aria-hidden': 'true' });
    canvas.appendChild(svg);
    for (const n of g.nodes) {
      const st = state.statuses[n.id];
      const cls = ['viz-node', `kind-${n.kind || 'step'}`];
      if (n.disabled) cls.push('disabled');
      if (st) cls.push(`st-${st}`);
      if (state.active === n.id) cls.push('active');
      if (state.selected === n.id) cls.push('selected');
      const node = h('button', {
        type: 'button', class: cls.join(' '), 'data-node': n.id,
        'aria-label': `${n.label}${st ? ', status ' + st : ''}${n.disabled ? ', not used in this configuration' : ''}`,
        style: { left: `calc(${(n.col / cols) * 100}% + 8px)`, width: `calc(${100 / cols}% - 16px)`, top: n.row * rowH + 8 + 'px' },
        onclick: () => { state.selected = n.id; draw(); },
      },
      h('span.node-label', n.label),
      n.badge ? h('span.node-badge', n.badge) : null,
      state.expanded && n.substeps ? h('ol.node-sub', n.substeps.map(x => h('li', x))) : null);
      canvas.appendChild(node);
      nodesById[n.id] = { def: n, el: node };
    }
    requestAnimationFrame(drawEdges);
    drawInspector();
  }

  function center(id, side) {
    const n = nodesById[id];
    if (!n) return null;
    const r = n.el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const x = r.left - c.left, y = r.top - c.top;
    if (side === 'out') return [x + r.width, y + r.height / 2];
    if (side === 'in') return [x, y + r.height / 2];
    return [x + r.width / 2, y + r.height / 2];
  }

  function path(a, b) {
    const A = nodesById[a], B = nodesById[b];
    if (!A || !B) return null;
    let p1, p2;
    if (A.def.col < B.def.col) { p1 = center(a, 'out'); p2 = center(b, 'in'); }
    else if (A.def.col > B.def.col) { p1 = center(a, 'in'); p2 = center(b, 'out'); }
    else {
      const ra = A.el.getBoundingClientRect(), rb = B.el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
      const down = A.def.row < B.def.row;
      p1 = [ra.left - c.left + ra.width / 2, (down ? ra.bottom : ra.top) - c.top];
      p2 = [rb.left - c.left + rb.width / 2, (down ? rb.top : rb.bottom) - c.top];
      return `M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`;
    }
    const mx = (p1[0] + p2[0]) / 2;
    return `M${p1[0]},${p1[1]} C${mx},${p1[1]} ${mx},${p2[1]} ${p2[0]},${p2[1]}`;
  }

  function drawEdges() {
    const svg = canvas.querySelector('svg.viz-edges');
    if (!svg) return;
    clear(svg);
    const c = canvas.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${c.width} ${c.height}`);
    svg.appendChild(s('defs', {}, s('marker', { id: `arrow-${mod.id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrow' }))));
    for (const [a, b, label] of edges) {
      const d = path(a, b);
      if (!d) continue;
      const hot = state.active === b && state.statuses[a];
      const p = s('path', { d, class: `edge${hot ? ' hot' : ''}${nodesById[a].def.disabled || nodesById[b].def.disabled ? ' off' : ''}`, 'marker-end': `url(#arrow-${mod.id})` });
      svg.appendChild(p);
      if (label) {
        const len = p.getTotalLength ? p.getTotalLength() : 0;
        const pt = len ? p.getPointAtLength(len / 2) : { x: 0, y: 0 };
        svg.appendChild(s('text', { x: pt.x, y: pt.y - 4, class: 'edge-label', 'text-anchor': 'middle' }, label));
      }
      if (hot && p.getTotalLength) {
        const dot = s('circle', { r: 5, class: 'packet' });
        dot.appendChild(s('animateMotion', { dur: '0.7s', repeatCount: '1', fill: 'freeze', path: d }));
        svg.appendChild(dot);
      }
    }
  }

  function drawInspector() {
    clear(inspector);
    const n = state.selected && nodesById[state.selected];
    if (!n) {
      inspector.appendChild(h('div', h('h4', 'Inspector'), h('p.small', 'Select any node in the diagram to see what it does, its properties, its internal stages and, after a run, the data it produced.')));
      return;
    }
    const d = n.def;
    const data = state.stepData[d.id];
    inspector.appendChild(h('div',
      h('h4', d.label),
      d.disabled ? h('p.chip.tone-muted', 'Not used with the current configuration') : null,
      h('p', d.detail),
      d.substeps ? [h('p.small', 'Internal stages'), h('ol.small', d.substeps.map(x => h('li', x)))] : null,
      d.props ? h('dl.kv', Object.entries(d.props).map(([k, v]) => [h('dt', k), h('dd', fmtValue(v))])) : null,
      data ? [h('p.small', `Last run: ${data.title} (${data.status})`), data.detail ? h('p.small', data.detail) : null, data.data != null ? h('pre.json', JSON.stringify(data.data, null, 2)) : null] : null));
  }

  const api = {
    el,
    setParams(p) { state.params = p; draw(); },
    setStep(st) {
      if (!st) return;
      if (st.node) { state.active = st.node; state.statuses[st.node] = worst(state.statuses[st.node], st.status); state.stepData[st.node] = st; }
      draw();
    },
    select(id) { state.selected = id; draw(); const n = nodesById[id]; if (n) n.el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); },
    clearRun() { state.active = null; state.statuses = {}; state.stepData = {}; draw(); },
    reset() { state.view = 'conceptual'; state.expanded = false; expandBtn.textContent = 'Expand stages'; expandBtn.setAttribute('aria-pressed', 'false'); state.selected = null; api.clearRun(); },
    flash(id) { state.selected = id; draw(); const n = nodesById[id]; if (n) { n.el.classList.add('flash'); n.el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } },
  };
  return api;
}

const RANK = { skip: 0, info: 1, ok: 2, warn: 3, error: 4 };
const worst = (a, b) => (!a ? b : RANK[b] > RANK[a] ? b : a);
