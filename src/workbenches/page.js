// Shared drawing helpers for document-centred workbenches.
// Draws a realistic page (text, tables, checkboxes, handwriting, signature) into an SVG group.
import { s, h, clear } from '../engine/dom.js';
import { rng } from '../engine/util.js';

export const PAGE_W = 210, PAGE_H = 297;
const charW = size => size * 0.52;

// Draw page content. Returns the <g> holding it.
export function drawPage(page, { quality = 1, seed = 'page' } = {}) {
  const g = s('g', { class: 'paper-content' });
  g.appendChild(s('rect', { x: 0, y: 0, width: page.w || PAGE_W, height: page.h || PAGE_H, class: 'paper' }));
  for (const it of page.items) {
    if (it.role === 'table') {
      const w = it.colW.reduce((a, b) => a + b, 0);
      const tg = s('g', { class: 'p-table' });
      tg.appendChild(s('rect', { x: it.x, y: it.y, width: w, height: it.rowH, class: 'p-thead' }));
      it.rows.forEach((row, r) => {
        let x = it.x;
        row.forEach((cell, c) => {
          tg.appendChild(s('text', { x: x + 2, y: it.y + r * it.rowH + it.rowH * 0.68, 'font-size': 4.2, class: r === 0 ? 'p-text p-bold' : 'p-text', textLength: cell.length * charW(4.2), lengthAdjust: 'spacingAndGlyphs' }, cell));
          x += it.colW[c];
        });
        tg.appendChild(s('line', { x1: it.x, x2: it.x + w, y1: it.y + (r + 1) * it.rowH, y2: it.y + (r + 1) * it.rowH, class: 'p-rule' }));
      });
      tg.appendChild(s('rect', { x: it.x, y: it.y, width: w, height: it.rowH * it.rows.length, class: 'p-border' }));
      let x = it.x;
      for (const cw of it.colW.slice(0, -1)) { x += cw; tg.appendChild(s('line', { x1: x, x2: x, y1: it.y, y2: it.y + it.rowH * it.rows.length, class: 'p-rule' })); }
      g.appendChild(tg);
    } else if (it.role === 'mark') {
      g.appendChild(s('rect', { x: it.x, y: it.y, width: 4.2, height: 4.2, class: 'p-check' }));
      if (it.checked) g.appendChild(s('path', { d: `M${it.x + 0.6},${it.y + 2.2} L${it.x + 1.8},${it.y + 3.6} L${it.x + 4.6},${it.y - 0.6}`, class: 'p-tick' }));
      g.appendChild(s('text', { x: it.x + 6, y: it.y + 3.6, 'font-size': 4.4, class: 'p-text' }, it.label));
    } else {
      const cls = ['p-text'];
      if (it.role === 'title' || it.role === 'sectionHeading') cls.push('p-bold');
      if (it.hand) cls.push('p-hand');
      if (it.role === 'pageHeader' || it.role === 'pageFooter') cls.push('p-muted');
      g.appendChild(s('text', { x: it.x, y: it.y, 'font-size': it.size, class: cls.join(' '), textLength: it.text.length * charW(it.size), lengthAdjust: 'spacingAndGlyphs' }, it.text));
      if (it.role === 'title' && !it.hand) g.appendChild(s('rect', { x: it.x, y: it.y + 2, width: 22, height: 0.8, class: 'p-accent' }));
    }
  }
  // Scan noise: deterministic speckles + optional fax streaks.
  if (quality < 0.95) {
    const r = rng(seed);
    const noise = s('g', { class: 'p-noise' });
    const n = Math.round((1 - quality) * 900);
    for (let i = 0; i < n; i++) noise.appendChild(s('circle', { cx: r() * PAGE_W, cy: r() * PAGE_H, r: 0.15 + r() * 0.45 }));
    if (quality < 0.7) for (let i = 0; i < 6; i++) { const y = r() * PAGE_H; noise.appendChild(s('rect', { x: 0, y, width: PAGE_W, height: 0.4 + r() * 0.6, opacity: 0.25 })); }
    g.appendChild(noise);
  }
  return g;
}

// A stage rail: ordered stages with status classes, used at the top of every workbench.
export function stageRail(stages) {
  const el = h('ol.stage-rail', { 'aria-label': 'Pipeline stages' });
  const items = {};
  stages.forEach(([id, label], i) => {
    const li = h('li.stage', { 'data-stage': id }, h('span.stage-dot', String(i + 1)), h('span.stage-label', label));
    items[id] = li;
    el.appendChild(li);
  });
  return {
    el,
    set(id, status) { const li = items[id]; if (!li) return; li.className = `stage st-${status}`; },
    active(id) { Object.values(items).forEach(li => li.classList.remove('active')); if (items[id]) items[id].classList.add('active'); },
    reset() { Object.values(items).forEach(li => { li.className = 'stage'; }); },
  };
}

// Toggle chips that show/hide overlay layers (by adding classes on a root element).
export function layerToggles(root, layers) {
  const el = h('div.layer-toggles', { role: 'group', 'aria-label': 'Overlay layers' });
  for (const [id, label, on] of layers) {
    if (on) root.classList.add(`show-${id}`);
    const btn = h('button.chip-btn', { type: 'button', 'aria-pressed': String(!!on), onclick: () => {
      const now = !root.classList.contains(`show-${id}`);
      root.classList.toggle(`show-${id}`, now);
      btn.setAttribute('aria-pressed', String(now));
    } }, label);
    el.appendChild(btn);
  }
  return el;
}

// Simple tab strip.
export function tabs(defs) {
  const bar = h('div.wb-tabs', { role: 'tablist' });
  const panels = {};
  const body = h('div.wb-tab-body');
  const api = {
    el: h('div.wb-tabset', bar, body),
    panel: id => panels[id],
    show(id) {
      for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
      bar.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    },
  };
  for (const [id, label] of defs) {
    panels[id] = h('div.wb-panel', { role: 'tabpanel' });
    body.appendChild(panels[id]);
    bar.appendChild(h('button.wb-tab', { type: 'button', role: 'tab', 'data-tab': id, onclick: () => api.show(id) }, label));
  }
  api.show(defs[0][0]);
  return api;
}

export const confTone = (c, threshold) => (c >= threshold ? 'ok' : c >= threshold - 0.2 ? 'warn' : 'error');
export { clear };
