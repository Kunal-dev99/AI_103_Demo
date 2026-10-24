// Renderers for simulator output blocks (see BLOCK_SCHEMAS in contract.js).
import { h, s, fmtValue } from './dom.js';

const TONES = ['ok', 'warn', 'error', 'info', 'muted'];
const tone = t => (TONES.includes(t) ? t : 'info');

function titled(b, body, cls = '') {
  return h(`figure.block.block-${b.type}${cls}`, b.title ? h('figcaption', b.title) : null, body);
}

const R = {
  text: b => titled(b, h('p', b.text)),

  alert: b => h(`div.block.alert.tone-${tone(b.tone)}`, { role: b.tone === 'error' ? 'alert' : 'status' }, b.text),

  kv: b => titled(b, h('dl.kv', b.items.map(([k, v]) => [h('dt', k), h('dd', fmtValue(v))]))),

  json: b => titled(b, h('pre.json', { tabindex: 0 }, JSON.stringify(b.data, null, 2))),

  code: b => titled(b, h('pre.code', { tabindex: 0, 'data-lang': b.lang || '' }, b.text)),

  table: (b, root) => titled(b, h('div.table-wrap', h('table',
    h('thead', h('tr', b.columns.map(c => h('th', { scope: 'col' }, c)))),
    h('tbody', b.rows.map((row, i) => {
      const link = b.links && b.links[i];
      const tr = h(`tr${b.tones && b.tones[i] ? '.tone-' + tone(b.tones[i]) : ''}${link ? '.linked' : ''}`,
        link ? { tabindex: 0, title: 'Highlight evidence on the page', onclick: () => highlightRegion(root, link), onkeydown: e => e.key === 'Enter' && highlightRegion(root, link) } : null,
        row.map(c => h('td', fmtValue(c))));
      return tr;
    }))))),

  bars: b => titled(b, h('div.bars', b.items.map(it => {
    const max = it.max || (it.value <= 1 ? 1 : Math.max(...b.items.map(x => x.value)) || 1);
    const w = Math.max(0, Math.min(100, (it.value / max) * 100));
    return h('div.bar-row',
      h('span.bar-label', it.label),
      h('span.bar-track',
        h(`span.bar-fill.tone-${tone(it.tone || 'info')}`, { style: { width: w + '%' } }),
        b.threshold != null ? h('span.bar-threshold', { style: { left: (b.threshold / (b.items[0].max || 1)) * 100 + '%' }, title: 'threshold' }) : null),
      h('span.bar-value', it.value <= 1 && !it.max ? it.value.toFixed(2) : String(it.value)),
      it.note ? h('span.bar-note', it.note) : null);
  }))),

  doc: b => {
    const W = b.width, H = b.height;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'doc-page', role: 'img', 'aria-label': b.title || 'Document page' });
    const g = s('g', b.rotated ? { transform: `rotate(${b.rotated} ${W / 2} ${H / 2})` } : {});
    g.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, class: 'doc-paper' }));
    const list = h('ol.doc-lines');
    for (const r of b.regions) {
      const lines = String(r.text).split('\n');
      const fs = Math.min(2.6, r.h / Math.max(1, lines.length) * 0.7);
      const grp = s('g', { class: `doc-region tone-${tone(r.tone || 'ok')}`, 'data-region': r.id, tabindex: 0 });
      lines.forEach((ln, i) => grp.appendChild(s('text', { x: r.x + 1, y: r.y + fs + i * (r.h / lines.length), 'font-size': fs, class: 'doc-text' }, ln.length > 60 ? ln.slice(0, 60) + '…' : ln)));
      if (b.showBoxes !== false) grp.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 'doc-box' }));
      if (b.showOrder && r.order != null) grp.appendChild(s('text', { x: r.x - 0.5, y: r.y + 2.5, 'font-size': 2.6, class: 'doc-order', 'text-anchor': 'end' }, r.order));
      grp.appendChild(s('title', {}, `${r.label || ''} ${r.conf != null ? '• confidence ' + r.conf : ''}\n${r.text}`));
      g.appendChild(grp);
      const li = h('li', { 'data-region': r.id, tabindex: 0 },
        h('span.doc-line-text', lines[0] + (lines.length > 1 ? ` (+${lines.length - 1} rows)` : '')),
        r.conf != null ? h(`span.chip.tone-${tone(r.tone || 'ok')}`, r.conf.toFixed(2)) : null,
        r.label ? h('span.chip.muted', r.label) : null);
      list.appendChild(li);
    }
    svg.appendChild(g);
    const wrap = h('div.doc-wrap', h('div.doc-canvas', svg), h('div.doc-side', h('p.small', 'Recognised text (select a line to locate it):'), list));
    const link = e => {
      const el = e.target.closest('[data-region]');
      if (el) highlightRegion(wrap, el.getAttribute('data-region'));
    };
    wrap.addEventListener('click', link);
    wrap.addEventListener('focusin', link);
    return titled(b, wrap);
  },

  chat: b => titled(b, h('div.chat', b.turns.map(t => {
    const role = String(t.role);
    const kind = role.startsWith('agent:') ? 'agent' : role;
    return h(`div.turn.turn-${kind}`,
      h('div.turn-role', role.startsWith('agent:') ? role.slice(6) : role),
      h('div.turn-text', t.text),
      t.meta ? h('div.turn-meta', typeof t.meta === 'string' ? t.meta : JSON.stringify(t.meta)) : null);
  }))),

  timeline: b => {
    const max = Math.max(...b.items.map(i => i.end), 1);
    const lanes = [...new Set(b.items.map(i => i.lane || ''))];
    return titled(b, h('div.timeline',
      b.items.map(it => h('div.tl-row',
        h('span.tl-label', { title: it.label }, it.label),
        h('span.tl-track', h(`span.tl-bar.tone-${tone(it.tone || 'info')}`, {
          style: { left: (it.start / max) * 100 + '%', width: Math.max(0.8, ((it.end - it.start) / max) * 100) + '%' },
          title: `${it.start}–${it.end} ${b.unit || ''}`,
        })),
        h('span.tl-val', `${+(it.end - it.start).toFixed(2)} ${b.unit || ''}`))),
      h('div.tl-axis', h('span', `0 ${b.unit || ''}`), h('span', `${max} ${b.unit || ''}`)),
      lanes.length > 1 ? h('p.small', 'Lanes: ' + lanes.join(', ')) : null));
  },

  grid: b => titled(b, h('div', h('div.grid', { style: { gridTemplateColumns: `repeat(${b.cols}, minmax(0, 1fr))` } },
    b.cells.map(c => h(`div.cell${c.tone ? '.tone-' + tone(c.tone) : ''}`, { title: c.label || '' }, c.v != null ? String(c.v) : ''))),
    b.caption ? h('p.small', b.caption) : null)),

  flow: b => titled(b, h('ol.flow', b.items.map(it => h(`li.tone-${tone(it.tone || 'info')}`, h('strong', it.label), it.note ? h('span.small', it.note) : null)))),

  diff: b => titled(b, h('div.diff', h('div', h('p.small', 'Before'), h('pre', b.before)), h('div', h('p.small', 'After'), h('pre', b.after)))),

  image: b => {
    const W = b.width || 100, H = b.height || 70;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'synth-image', role: 'img', 'aria-label': b.title || 'Synthetic image' });
    svg.appendChild(s('rect', { x: 0, y: 0, width: W, height: H, fill: b.background || 'var(--img-bg)' }));
    for (const sh of b.shapes) {
      const cls = sh.tone ? `tone-${tone(sh.tone)}` : '';
      const dash = sh.dashed ? '2 1.5' : null;
      if (sh.kind === 'rect') svg.appendChild(s('rect', { x: sh.x, y: sh.y, width: sh.w, height: sh.h, fill: sh.fill || 'currentColor', class: cls, 'stroke-dasharray': dash, rx: sh.r || 0 }));
      else if (sh.kind === 'circle') svg.appendChild(s('circle', { cx: sh.x, cy: sh.y, r: sh.r || 5, fill: sh.fill || 'currentColor', class: cls }));
      else if (sh.kind === 'line') svg.appendChild(s('line', { x1: sh.x, y1: sh.y, x2: sh.x2, y2: sh.y2, class: `img-line ${cls}`, 'stroke-dasharray': dash }));
      else if (sh.kind === 'text') svg.appendChild(s('text', { x: sh.x, y: sh.y, 'font-size': sh.size || 4, fill: sh.fill || 'var(--text)', class: cls }, sh.text || sh.label || ''));
      else if (sh.kind === 'box') {
        svg.appendChild(s('rect', { x: sh.x, y: sh.y, width: sh.w, height: sh.h, class: `img-box ${cls || 'tone-info'}`, 'stroke-dasharray': dash }));
        if (sh.label) svg.appendChild(s('text', { x: sh.x + 0.5, y: Math.max(3, sh.y - 1), 'font-size': 3, class: `img-box-label ${cls || 'tone-info'}` }, sh.label));
      }
    }
    return titled(b, h('div.image-wrap', svg));
  },
};

function highlightRegion(root, id) {
  const scope = root.closest('.output') || root;
  scope.querySelectorAll('[data-region].hl').forEach(el => el.classList.remove('hl'));
  scope.querySelectorAll(`[data-region="${CSS.escape(id)}"]`).forEach(el => el.classList.add('hl'));
}

export function renderBlocks(blocks) {
  const root = h('div.output');
  for (const b of blocks || []) {
    const r = R[b.type];
    root.appendChild(r ? r(b, root) : h('pre', JSON.stringify(b, null, 2)));
  }
  return root;
}
