// Document ingestion workbench: the page itself, with rotation, noise, an OCR scan sweep,
// word/line boxes coloured by confidence, tables, roles, checkboxes and an animated reading-order path.
import { h, s, clear } from '../engine/dom.js';
import { drawPage, stageRail, layerToggles, tabs, confTone, PAGE_W, PAGE_H } from './page.js';

const STAGES = [['upload', 'Upload'], ['pre', 'Pre-process'], ['ocr', 'OCR'], ['layout', 'Layout'], ['output', 'Output']];

export function createWorkbench(mod) {
  const rail = stageRail(STAGES);
  const svg = s('svg', { viewBox: `-12 -12 ${PAGE_W + 24} ${PAGE_H + 24}`, class: 'wb-page', role: 'img', 'aria-label': 'Document page with OCR overlays' });
  const stage = h('div.wb-stage', svg);
  const caption = h('p.wb-caption', { 'aria-live': 'polite' }, 'Choose a document and press Run. Each stage animates on the page.');
  const toggles = layerToggles(stage, [['words', 'Words', true], ['lines', 'Lines', false], ['tables', 'Tables', true], ['roles', 'Roles', true], ['order', 'Reading order', true], ['heat', 'Confidence heatmap', false]]);
  const detail = h('div.wb-detail', h('p.small', 'Select a word or line on the page to inspect it.'));
  const tb = tabs([['text', 'Text'], ['tables', 'Tables'], ['output', 'Output']]);
  const el = h('div.workbench.wb-ingestion',
    rail.el,
    h('div.wb-grid',
      h('div.wb-main', toggles, stage, caption),
      h('aside.wb-side', detail, tb.el)));

  let res = null, params = null, pageG = null, rotG = null, overlay = null;

  function base() {
    clear(svg);
    if (!params) return;
    const doc = res && res.view;
    const page = doc ? doc.page : null;
    rotG = s('g', { class: 'rot' });
    svg.appendChild(rotG);
    if (!page) {
      rotG.appendChild(s('rect', { x: 0, y: 0, width: PAGE_W, height: PAGE_H, class: 'paper' }));
      rotG.appendChild(s('text', { x: PAGE_W / 2, y: PAGE_H / 2, 'text-anchor': 'middle', class: 'p-muted', 'font-size': 7 }, 'Run to load the page'));
      return;
    }
    pageG = drawPage(page, { quality: doc.quality, seed: params.document });
    if (doc.quality < 0.7) pageG.classList.add('blurry');
    rotG.appendChild(pageG);
    rotG.style.transform = `rotate(${doc.angle}deg)`;
    overlay = s('g', { class: 'overlay' });
    rotG.appendChild(overlay);
  }

  const lineById = id => res.view.lines.find(l => l.id === id);

  function select(item, kind) {
    svg.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
    svg.querySelectorAll(`[data-id="${CSS.escape(item.id)}"]`).forEach(x => x.classList.add('hl'));
    tb.panel('text').querySelectorAll('[data-id]').forEach(x => x.classList.toggle('hl', x.dataset.id === (item.lineId || item.id)));
    const th = res.view.threshold;
    clear(detail).append(
      h('h4', kind === 'word' ? 'Word' : 'Line'),
      h('p.wb-quote', `“${item.text}”`),
      h('div.conf-meter', h('span', { class: `tone-${confTone(item.conf, th)}`, style: { width: item.conf * 100 + '%' } }), h('i', { style: { left: th * 100 + '%' }, title: 'threshold' })),
      h('p.small', `Confidence ${item.conf.toFixed(2)} (threshold ${th})`),
      kind === 'line' && item.role ? h('p.small', `Role: ${item.role}`) : null,
      item.truth && item.truth !== item.text ? h('p.alert.tone-error', `Misread. The page says “${item.truth}”.`) : null,
      h('p.small.mono', `polygon ≈ [${[item.x, item.y, item.x + item.w, item.y, item.x + item.w, item.y + item.h, item.x, item.y + item.h].map(v => v.toFixed(1)).join(', ')}]`));
  }

  function drawOCR() {
    const v = res.view, th = v.threshold;
    const scan = s('rect', { x: -4, y: 0, width: PAGE_W + 8, height: 6, class: 'scan-beam' });
    overlay.appendChild(scan);
    const lines = s('g', { class: 'ly-lines' }), words = s('g', { class: 'ly-words' }), heat = s('g', { class: 'ly-heat' });
    for (const l of v.lines) {
      const rect = s('rect', { x: l.x, y: l.y, width: l.w, height: l.h, class: `ocr-line tone-${confTone(l.conf, th)}`, 'data-id': l.id, style: `animation-delay:${(l.y / PAGE_H) * 1.1}s` });
      rect.addEventListener('click', () => select(l, 'line'));
      lines.appendChild(rect);
    }
    for (const w of v.words) {
      const rect = s('rect', { x: w.x, y: w.y, width: w.w, height: w.h, rx: 0.6, class: `ocr-word tone-${confTone(w.conf, th)}`, 'data-id': w.id, style: `animation-delay:${(w.y / PAGE_H) * 1.1}s` });
      rect.appendChild(s('title', {}, `${w.text} · ${w.conf.toFixed(2)}`));
      rect.addEventListener('click', () => select({ ...w, truth: (lineById(w.lineId).text !== lineById(w.lineId).truth) ? lineById(w.lineId).truth : null }, 'word'));
      words.appendChild(rect);
      heat.appendChild(s('rect', { x: w.x, y: w.y, width: w.w, height: w.h, class: 'heat', style: `fill-opacity:${(1 - w.conf) * 0.9}` }));
    }
    overlay.append(heat, lines, words);
  }

  function drawLayout() {
    const v = res.view;
    const tables = s('g', { class: 'ly-tables' }), roles = s('g', { class: 'ly-roles' }), order = s('g', { class: 'ly-order' });
    for (const t of v.tables) {
      tables.appendChild(s('rect', { x: t.x - 1, y: t.y - 1, width: t.w + 2, height: t.h + 2, class: 'tbl-outline', pathLength: 100 }));
      for (const c of t.cells) tables.appendChild(s('rect', { x: c.x, y: c.y, width: c.w, height: c.h, class: c.header ? 'tbl-cell head' : 'tbl-cell', style: `animation-delay:${0.3 + (c.r * 0.12)}s` }));
      tables.appendChild(s('text', { x: t.x + t.w - 1, y: t.y - 2.5, 'text-anchor': 'end', class: 'role-tag', 'font-size': 3.6 }, `table ${t.rows}×${t.cols}`));
    }
    for (const m of v.marks) {
      roles.appendChild(s('rect', { x: m.x - 1, y: m.y - 1, width: 6.2, height: 6.2, class: `mark-box ${m.state}` }));
      roles.appendChild(s('text', { x: m.x - 1, y: m.y - 2, class: 'role-tag', 'font-size': 3.2 }, m.state));
    }
    for (const l of v.lines) {
      if (!l.role || l.role === 'text' || l.role === 'tableCell') continue;
      roles.appendChild(s('text', { x: l.x, y: l.y - 0.9, class: 'role-tag', 'font-size': 3 }, l.role));
    }
    // reading order path through line centres (skip table cells after the first of each table)
    const seen = new Set();
    const pts = [];
    for (const id of v.order) {
      const l = lineById(id);
      if (!l) continue;
      if (l.table) { if (seen.has(l.table)) continue; seen.add(l.table); }
      pts.push({ x: l.x - 4.2, y: l.y + l.h / 2, ok: v.orderTruth[v.order.indexOf(id)] === id });
    }
    if (pts.length > 1) order.appendChild(s('path', { d: 'M' + pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L'), class: 'order-path', pathLength: 100 }));
    pts.forEach((p, i) => {
      const gg = s('g', { class: `order-dot ${p.ok ? 'ok' : 'bad'}`, style: `animation-delay:${0.6 + i * 0.05}s` });
      gg.appendChild(s('circle', { cx: p.x, cy: p.y, r: 2.6 }));
      gg.appendChild(s('text', { x: p.x, y: p.y + 1.1, 'text-anchor': 'middle', 'font-size': 3 }, String(i + 1)));
      order.appendChild(gg);
    });
    overlay.append(tables, roles, order);
  }

  function fillSide() {
    const v = res.view, th = v.threshold;
    const tp = clear(tb.panel('text'));
    const list = h('ol.wb-lines');
    for (const id of v.order) {
      const l = lineById(id);
      if (!l) continue;
      const li = h('li', { 'data-id': l.id, tabindex: 0 },
        h('span.wb-line-text', l.text),
        h(`span.chip.tone-${confTone(l.conf, th)}`, l.conf.toFixed(2)),
        l.role && l.role !== 'text' ? h('span.chip.muted', l.role) : null,
        l.text !== l.truth ? h('span.chip.tone-error', 'misread') : null);
      const hl = () => { select(l, 'line'); };
      li.addEventListener('click', hl); li.addEventListener('focus', hl);
      li.addEventListener('mouseenter', () => svg.querySelectorAll(`[data-id="${CSS.escape(l.id)}"]`).forEach(x => x.classList.add('hover')));
      li.addEventListener('mouseleave', () => svg.querySelectorAll('.hover').forEach(x => x.classList.remove('hover')));
      list.appendChild(li);
    }
    tp.append(h('p.small', `${v.lines.length} lines in output order. Hover to locate, click to inspect.`), list);
    const tt = clear(tb.panel('tables'));
    if (!v.tables.length) tt.append(h('p.small', params.model === 'read' ? 'No tables: prebuilt-read does not return table structure. Table text arrives as loose lines.' : 'No tables detected.'));
    for (const t of v.tables) {
      const rows = [...Array(t.rows)].map((_, r) => t.cells.filter(c => c.r === r));
      tt.append(h('div.table-wrap', h('table', h('tbody', rows.map(r => h('tr', r.map(c => h(c.header ? 'th' : 'td', c.text))))))), h('p.small', `rowCount ${t.rows} · columnCount ${t.cols}`));
    }
    const op = clear(tb.panel('output'));
    op.append(v.output && v.output.format !== 'error' ? h('pre.code', v.output.text) : h('p.alert.tone-error', 'No output: see the failed stage.'));
  }

  const CAPTIONS = {
    upload: st => st.status === 'error' ? `Upload stopped: ${st.title}.` : 'File accepted. The analyze request starts a long-running operation.',
    pre: st => st.status === 'warn' && /left/.test(st.title) ? 'The page stays sideways: everything downstream suffers.' : res.view.angle ? 'Rotation detected; the page turns upright.' : res.view.enhance ? 'Noise reduction cleans the scan.' : 'Page is upright.',
    ocr: () => 'OCR sweeps the page. Each word gets a box and a confidence score: green above threshold, amber close, red far below.',
    layout: () => res.view.tables.length || res.view.marks.length ? 'Layout finds tables, checkboxes and roles, then numbers lines in human reading order.' : 'No structure recovered: numbers show the order text comes out in (red = wrong position).',
    output: st => st.status === 'error' ? 'Output failed.' : `Result ready as ${res.view.output.format.toUpperCase()}. See the Output tab.`,
  };

  const api = {
    el,
    setParams(p) {
      // Preview: show the chosen document (no overlays) as soon as settings change.
      params = p;
      try { res = mod.sim.run({ ...p }); } catch { res = null; }
      base(); rail.reset();
      caption.textContent = 'Press Run (or Step) to process this page stage by stage.';
    },
    setResult(r) { res = r; base(); rail.reset(); clear(detail).append(h('p.small', 'Select a word or line on the page to inspect it.')); ['text', 'tables', 'output'].forEach(t => clear(tb.panel(t))); },
    setStep(st) {
      if (!res || !st.node) return;
      rail.set(st.node, st.status); rail.active(st.node);
      caption.textContent = (CAPTIONS[st.node] || (() => st.title))(st);
      if (st.node === 'pre' && res.view.corrected) {
        requestAnimationFrame(() => { rotG.style.transform = 'rotate(0deg)'; });
        if (res.view.enhance && pageG) pageG.classList.add('cleaned');
      }
      if (st.node === 'ocr') drawOCR();
      if (st.node === 'layout') drawLayout();
      if (st.node === 'output') { fillSide(); tb.show(st.status === 'error' ? 'text' : 'output'); }
      if (st.node === 'layout' || st.node === 'ocr') fillSide();
    },
    clearRun() { if (params) api.setParams(params); else { res = null; rail.reset(); base(); } },
    reset() { api.clearRun(); },
    flash(id) { rail.active(id); el.querySelector(`[data-stage="${id}"]`)?.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    select(id) { rail.active(id); },
  };
  return api;
}
