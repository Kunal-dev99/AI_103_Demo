// Field extraction workbench: the page on the left, one card per schema field on the right.
// Locate: each field searches the page (amber dashed candidates), locks onto its evidence region
// and a connector links the card to it. Extract: values are typed in and confidence bars fill
// against the threshold. Validate: a rule checklist ticks or fails, with the arithmetic drawn on
// the page. Route: flagged fields drop into a review queue the learner can approve or correct.
import { h, s, clear } from '../engine/dom.js';
import { drawPage, stageRail, confTone, PAGE_W, PAGE_H } from './page.js';

const STAGES = [['schema', 'Schema'], ['locate', 'Evidence'], ['extract', 'Extract'], ['validate', 'Validate'], ['route', 'Review & route']];
const STATUS_TEXT = { pending: 'waiting', ok: 'ok', low: 'low confidence', missing: 'missing', empty: 'not on page', malformed: 'malformed', unsupported: 'no evidence', rule: 'failed rule', generated: 'generated', reviewed: 'reviewed' };
const RULE_NAMES = { types: 'types', required: 'required', arith: 'arithmetic', dates: 'dates' };
const PAD = 5;

export function createWorkbench(mod) {
  const rail = stageRail(STAGES);
  const svg = s('svg', { viewBox: `${-PAD} ${-PAD} ${PAGE_W + PAD * 2} ${PAGE_H + PAD * 2}`, class: 'wb-page wbf-page', role: 'img', 'aria-label': 'Document page with field evidence overlays' });
  const links = s('svg', { class: 'wbf-links', 'aria-hidden': 'true' });
  const cardsHead = h('div.wbf-cards-head');
  const cardList = h('div.wbf-cardlist', { role: 'list', 'aria-label': 'Schema fields' });
  const pageCol = h('div.wbf-pagecol', h('div.wbf-doclabel'), svg);
  const board = h('div.wbf-board', pageCol, h('div.wbf-cards', cardsHead, cardList), links);
  const caption = h('p.wb-caption', { 'aria-live': 'polite' }, 'Choose a document and a schema, then press Run. Each field searches the page for its evidence.');
  const inspect = h('section.wbf-panel.wbf-inspect', { 'aria-label': 'Field inspector' });
  const rulesEl = h('section.wbf-panel.wbf-rules', { 'aria-label': 'Validation rules' });
  const queueEl = h('section.wbf-panel.wbf-queue', { 'aria-label': 'Review queue' });
  const el = h('div.workbench.wb-fields', rail.el, board, caption, h('div.wbf-lower', inspect, rulesEl, queueEl));

  let res = null, params = null, layers = null, cards = {}, selected = null, played = new Set(), review = {};
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawLinks(false)) : null;
  if (ro) ro.observe(board);

  const V = () => res && res.view;
  const fieldsOf = () => (V() ? (V().fields.length ? V().fields : (V().schema.fields || []).map(f => ({ ...f, status: 'pending', status0: 'pending', candidates: [], notes: [] }))) : []);
  const fieldBy = name => fieldsOf().find(f => f.name === name);
  const idxOf = name => fieldsOf().findIndex(f => f.name === name);
  const slot = () => Math.min(0.42, 1.2 / Math.max(1, fieldsOf().length));
  const toneOf = f => {
    const st = currentStatus(f);
    if (st === 'reviewed') return 'info';
    if (st === 'ok') return f.conf == null ? 'info' : confTone(f.conf, V().threshold);
    if (st === 'generated') return 'info';
    if (st === 'low') return confTone(f.conf, V().threshold);
    if (st === 'rule') return 'warn';
    if (st === 'empty' || st === 'pending') return 'muted';
    return 'error';
  };
  // status shown now: before validate, the extract-time status; after review, 'reviewed'
  const currentStatus = f => (review[f.name] && review[f.name].done ? 'reviewed' : played.has('validate') ? f.status : played.has('extract') ? f.status0 : 'pending');

  // ---------- page ----------
  function base() {
    clear(svg);
    const v = V();
    if (!v) {
      svg.appendChild(s('rect', { x: 0, y: 0, width: PAGE_W, height: PAGE_H, class: 'paper' }));
      svg.appendChild(s('text', { x: PAGE_W / 2, y: PAGE_H / 2, 'text-anchor': 'middle', class: 'p-muted', 'font-size': 7 }, 'Choose a document'));
      return;
    }
    const pg = drawPage(v.page, { quality: v.quality, seed: params ? params.document : 'p' });
    if (v.quality < 0.7) pg.classList.add('blurry');
    svg.appendChild(pg);
    layers = { cands: s('g', { class: 'ev-cands' }), arith: s('g', { class: 'ev-arith' }), locks: s('g', { class: 'ev-locks' }), pins: s('g', { class: 'ev-pins' }), focus: s('g', { class: 'ev-focus' }) };
    svg.append(layers.cands, layers.locks, layers.arith, layers.pins, layers.focus);
    pageCol.querySelector('.wbf-doclabel').replaceChildren(h('span.wbf-docname', v.docLabel), h('span.chip.tone-info', approachShort(v.approach)));
  }
  const approachShort = a => ({ prebuilt: 'prebuilt-invoice', cu: 'Content Understanding', llm: 'LLM + json_schema' }[a] || a);

  // ---------- cards ----------
  function renderCards() {
    clear(cardList); cards = {};
    const v = V();
    clear(cardsHead);
    if (!v) return;
    if (!v.schema.ok) {
      cardsHead.append(h('h4', 'Schema'), h('span.chip.tone-error', 'syntax error'));
      cardList.append(h('div.wbf-schema-err',
        h('ol.wbf-schema-lines', v.schema.lines.map(l => h(`li${l.ok ? '' : '.bad'}`, { value: l.n }, h('code', l.text || ' '), !l.ok ? h('span.wbf-err-msg', l.msg) : null))),
        v.schema.error && !v.schema.lines.some(l => !l.ok) ? h('p.alert.tone-error', v.schema.error.msg) : null,
        h('p.small', 'Format: Name: type [required] [extract|generate|classify] [# description]. Types: string, number, integer, date, enum(a|b).')));
      return;
    }
    cardsHead.append(h('h4', `Schema fields (${fieldsOf().length})`),
      h('span.wbf-legend', h('i.lg.ok'), '≥ threshold ', h('i.lg.warn'), 'close ', h('i.lg.error'), 'far below', h('span.wbf-th', `threshold ${v.threshold.toFixed(2)}`)));
    fieldsOf().forEach((f, i) => {
      const card = h('article.wbf-card', { role: 'listitem', tabindex: 0, 'data-field': f.name, 'data-status': 'pending', style: `--i:${i}` },
        h('div.wbf-card-top',
          h('span.wbf-idx', String(i + 1)),
          h('strong.wbf-name', f.name),
          h('span.wbf-type', f.type === 'enum' ? `enum(${f.options.length})` : f.type),
          f.required ? h('span.wbf-req', { title: 'required' }, 'required') : null,
          f.method && f.method !== 'extract' ? h('span.wbf-method', f.method) : null,
          h('span.wbf-status')),
        h('div.wbf-val', h('span.wbf-value', '…'), h('span.wbf-raw')),
        h('div.wbf-confrow', h('div.conf-meter', h('span', { style: 'width:0%' }), h('i', { style: `left:${v.threshold * 100}%`, title: `threshold ${v.threshold}` })), h('span.wbf-confnum', '')),
        h('div.wbf-where'));
      card.addEventListener('click', () => selectField(f.name));
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectField(f.name); } });
      card.addEventListener('mouseenter', () => hover(f.name, true));
      card.addEventListener('mouseleave', () => hover(f.name, false));
      cards[f.name] = card;
      cardList.appendChild(card);
    });
  }

  function setCardStatus(f) {
    const card = cards[f.name];
    if (!card) return;
    const st = currentStatus(f);
    card.dataset.status = st;
    card.dataset.tone = toneOf(f);
    const chip = card.querySelector('.wbf-status');
    chip.className = `wbf-status chip tone-${st === 'pending' ? 'muted' : toneOf(f) === 'muted' ? 'muted' : toneOf(f)}`;
    chip.textContent = st === 'rule' ? `failed ${f.ruleFails.filter(x => x !== 'types' && x !== 'required').map(x => RULE_NAMES[x]).join(', ')}` : STATUS_TEXT[st] || st;
  }

  function fillValue(f, delay) {
    const card = cards[f.name];
    if (!card) return;
    const rv = review[f.name];
    const val = card.querySelector('.wbf-value'), raw = card.querySelector('.wbf-raw');
    const shown = rv && rv.done ? rv.value : f.value;
    val.textContent = shown != null ? shown : f.raw != null ? f.raw : '—';
    val.classList.toggle('bad', shown == null && f.raw != null);
    val.classList.toggle('none', shown == null && f.raw == null);
    val.style.setProperty('--d', `${delay}s`);
    val.classList.remove('typed'); void val.offsetWidth; val.classList.add('typed');
    raw.textContent = rv && rv.done ? (rv.changed ? `was ${f.value ?? (f.raw != null ? `“${f.raw}”` : 'empty')}` : 'approved') : f.corrected ? `read “${f.raw}”` : f.value != null && f.raw != null && f.value !== f.raw && f.type === 'date' ? `read “${f.raw}”` : f.fabricated ? 'not on the page' : '';
    raw.classList.toggle('fixed', !!(f.corrected || (rv && rv.done)));
    const meter = card.querySelector('.conf-meter span'), num = card.querySelector('.wbf-confnum');
    const tone = f.conf == null ? 'muted' : confTone(f.conf, V().threshold);
    meter.className = `tone-${tone}`;
    meter.parentElement.classList.toggle('unscored', f.conf == null);
    requestAnimationFrame(() => { meter.style.transitionDelay = `${delay}s`; meter.style.width = f.conf == null ? (f.raw != null ? '100%' : '0%') : `${f.conf * 100}%`; });
    num.textContent = f.conf == null ? (f.raw == null ? '' : f.generated ? 'no score' : 'unscored') : f.conf.toFixed(2);
  }

  // ---------- locate: candidates flash, chosen evidence locks, connectors draw ----------
  function drawLocate() {
    const v = V(), T = slot();
    clear(layers.cands); clear(layers.locks); clear(layers.pins);
    fieldsOf().forEach((f, i) => {
      const start = i * T;
      const card = cards[f.name];
      if (card) { card.style.setProperty('--d', `${start}s`); card.style.setProperty('--dur', `${T * 1.6}s`); card.classList.add('searching'); }
      const cands = f.candidates || [];
      cands.forEach((c, k) => {
        const r = s('rect', { x: c.box.x, y: c.box.y, width: c.box.w, height: c.box.h, rx: 0.8, class: `ev-cand${c.match ? ' match' : ''}`, 'data-field': f.name, style: `animation-delay:${(start + k * Math.min(0.09, T / (cands.length + 1))).toFixed(3)}s;animation-duration:${(T * 1.7).toFixed(2)}s` });
        layers.cands.appendChild(r);
      });
      if (f.evidence) {
        const b = f.evidence;
        const g = s('g', { class: `ev-lock grounding-${f.grounding}`, 'data-field': f.name, style: `animation-delay:${(start + T * 0.8).toFixed(3)}s` });
        g.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 0.8, class: 'ev-box' }));
        g.appendChild(s('title', {}, `${f.name}: “${f.candidates.find(c => c.chosen).text}”`));
        g.addEventListener('click', () => selectField(f.name));
        layers.locks.appendChild(g);
        const pin = s('g', { class: 'ev-pin', 'data-field': f.name, style: `animation-delay:${(start + T).toFixed(3)}s` });
        const px = Math.min(PAGE_W + PAD - 2.4, b.x + b.w), py = b.y - 0.2;
        pin.appendChild(s('circle', { cx: px, cy: py, r: 2.3, class: 'ev-pin-dot' }));
        pin.appendChild(s('text', { x: px, y: py + 0.95, 'text-anchor': 'middle', 'font-size': 2.7 }, String(i + 1)));
        pin.addEventListener('click', () => selectField(f.name));
        layers.pins.appendChild(pin);
      } else if (f.type === 'enum' && f.raw != null) {
        // classification: the whole page is the evidence
        layers.locks.appendChild(s('rect', { x: -2, y: -2, width: PAGE_W + 4, height: PAGE_H + 4, rx: 2, class: 'ev-doc', 'data-field': f.name, style: `animation-delay:${(start + T * 0.8).toFixed(3)}s` }));
      }
      if (card) card.querySelector('.wbf-where').replaceChildren(whereText(f));
    });
    toneLocks();
    requestAnimationFrame(() => drawLinks(true));
  }

  function whereText(f) {
    const c = (f.candidates || []).find(x => x.chosen);
    const n = (f.candidates || []).filter(x => x.match).length;
    if (c) return h('span', { class: f.grounding === 'posthoc' ? 'posthoc' : '' }, f.grounding === 'posthoc' ? '≈ text match ' : '⌖ region ', h('q', c.text), n > 1 ? h('span.wbf-amb', ` · ${n} matches`) : null);
    if (f.generated) return h('span.gen', '✦ generated · no source region');
    if (f.type === 'enum' && f.raw != null) return h('span', '▣ whole document');
    if (f.fabricated) return h('span.nofind', '∅ nothing on the page');
    return h('span.nofind', `∅ ${f.notes && f.notes[0] ? f.notes[0].replace(/\.$/, '') : 'not found'}`);
  }

  function toneLocks() {
    if (!layers) return;
    layers.locks.querySelectorAll('.ev-lock').forEach(g => {
      const f = fieldBy(g.dataset.field);
      g.setAttribute('class', `ev-lock grounding-${f.grounding} tone-${played.has('extract') ? toneOf(f) : 'info'}${selected === f.name ? ' hl' : ''}`);
    });
  }

  function drawLinks(animate) {
    clear(links);
    const v = V();
    if (!v || !v.fields.length || !played.has('locate')) return;
    const B = board.getBoundingClientRect();
    const P = svg.getBoundingClientRect();
    const firstCard = Object.values(cards)[0];
    if (!firstCard) return;
    if (firstCard.offsetLeft < P.right - B.left - 4) return; // stacked layout: pins + numbers do the linking
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    links.setAttribute('viewBox', `0 0 ${B.width} ${B.height}`);
    links.setAttribute('width', B.width); links.setAttribute('height', B.height);
    const T = slot();
    fieldsOf().forEach((f, i) => {
      if (!f.evidence) return;
      const pin = layers.pins.querySelector(`.ev-pin[data-field="${CSS.escape(f.name)}"] circle`);
      const card = cards[f.name];
      if (!pin || !card) return;
      // geometry, not getBoundingClientRect: pins and cards may still be mid-animation
      const cx = +pin.getAttribute('cx'), cy = +pin.getAttribute('cy'), cr = +pin.getAttribute('r');
      const x1 = ctm.a * (cx + cr) + ctm.e - B.left, y1 = ctm.d * cy + ctm.f - B.top;
      const x2 = card.offsetLeft - 1, y2 = card.offsetTop + Math.min(22, card.offsetHeight / 2);
      const mx = Math.max(x1 + 18, (P.right - B.left) + 4);
      const d = `M${x1.toFixed(1)},${y1.toFixed(1)} C${(mx + 10).toFixed(1)},${y1.toFixed(1)} ${(x2 - 28).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
      const tone = played.has('extract') ? toneOf(f) : 'info';
      const p = s('path', { d, pathLength: 100, class: `wbf-link tone-${tone} grounding-${f.grounding}${animate ? ' anim' : ''}${selected === f.name ? ' hl' : ''}${selected && selected !== f.name ? ' dim' : ''}`, 'data-field': f.name, style: animate ? `animation-delay:${(i * T + T * 0.85).toFixed(3)}s` : '' });
      if (animate) p.addEventListener('animationend', () => p.classList.remove('anim'), { once: true });
      links.appendChild(p);
      links.appendChild(s('circle', { cx: x2 - 1, cy: y2, r: 3, class: `wbf-link-dot tone-${tone}${animate ? ' anim' : ''}`, style: animate ? `animation-delay:${(i * T + T * 1.3).toFixed(3)}s` : '' }));
    });
  }

  // ---------- extract ----------
  function drawExtract() {
    fieldsOf().forEach((f, i) => {
      const card = cards[f.name];
      if (!card) return;
      card.classList.remove('searching');
      fillValue(f, i * 0.06);
      setCardStatus(f);
      card.classList.add('extracted');
      if (f.status0 === 'malformed' || f.status0 === 'unsupported' || f.status0 === 'missing') { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
    });
    toneLocks(); drawLinks(false);
  }

  // ---------- validate ----------
  function drawRules(animate) {
    const v = V();
    clear(rulesEl);
    rulesEl.append(h('h4', 'Validation rules'));
    if (!v || !v.rules.length || !played.has('validate')) { rulesEl.append(h('p.small', v && !v.schema.ok ? 'Fix the schema first.' : 'Rules run after extraction: types, required fields, subtotal + tax = total, date sanity.')); return; }
    const ICON = { pass: '✓', fail: '✗', skip: '–', off: '○' };
    const list = h('ul.wbf-rulelist');
    v.rules.forEach((R, i) => {
      const li = h(`li.wbf-rule.r-${R.status}${animate ? '.anim' : ''}`, { style: `--d:${(i * 0.28).toFixed(2)}s` },
        h('span.wbf-rule-icon', h('span.r-spin', { 'aria-hidden': 'true' }), h('b', ICON[R.status])),
        h('div.wbf-rule-body', h('strong', R.label), R.calc ? arithmetic(R) : h('span.small', R.detail),
          R.fields.length ? h('span.wbf-rule-fields', R.fields.map(n => h('button.chip-btn', { type: 'button', onclick: () => selectField(n) }, n))) : null));
      list.appendChild(li);
    });
    rulesEl.append(list);
  }
  function arithmetic(R) {
    const c = R.calc, ok = R.status === 'pass';
    return h('span.wbf-sum', h('span', c.a.toFixed(2)), ' + ', h('span', c.b.toFixed(2)), ' = ', h('b', c.sum.toFixed(2)), h(`span.wbf-eq.${ok ? 'ok' : 'bad'}`, ok ? ' = ' : ' ≠ '), h('span', c.total.toFixed(2)), h('span.wbf-sum-names', `${c.names[0]} + ${c.names[1]} vs ${c.names[2]}`));
  }
  function drawArithOnPage() {
    clear(layers.arith);
    const R = V().rules.find(x => x.id === 'arith' && x.calc);
    if (!R) return;
    const boxes = R.calc.names.map(n => fieldBy(n)).map(f => f && f.evidence).filter(Boolean);
    if (boxes.length < 3) return;
    const ok = R.status === 'pass';
    const x = Math.min(PAGE_W + 2, Math.max(...boxes.map(b => b.x + b.w)) + 5);
    const ys = boxes.map(b => b.y + b.h / 2);
    const top = Math.min(...ys), bot = Math.max(...ys);
    const g = s('g', { class: `arith ${ok ? 'ok' : 'bad'}` });
    g.appendChild(s('path', { d: boxes.map(b => `M${b.x + b.w + 1.2},${b.y + b.h / 2} H${x}`).join(' ') + ` M${x},${top} V${bot}`, class: 'arith-br', pathLength: 100 }));
    const label = ok ? `${R.calc.a.toFixed(2)} + ${R.calc.b.toFixed(2)} = ${R.calc.sum.toFixed(2)} ✓` : `${R.calc.a.toFixed(2)} + ${R.calc.b.toFixed(2)} = ${R.calc.sum.toFixed(2)} ≠ ${R.calc.total.toFixed(2)}`;
    const fs = 3.3, lw = label.length * fs * 0.62 + 3;
    let lx, ly;
    if (x + 2 + lw <= PAGE_W + PAD - 0.5) { lx = x + 2; ly = (top + bot) / 2 - 2.9; }
    else { lx = Math.max(-PAD + 0.5, Math.min(PAGE_W + PAD - lw - 0.5, x - lw)); ly = Math.max(...boxes.map(b => b.y + b.h)) + 3; }
    g.appendChild(s('rect', { x: lx, y: ly, width: lw, height: 5.8, rx: 1.4, class: 'arith-tag-bg' }));
    g.appendChild(s('text', { x: lx + 1.5, y: ly + 4.05, 'font-size': fs, class: 'arith-tag' }, label));
    layers.arith.appendChild(g);
  }
  function drawValidate() {
    drawRules(true);
    fieldsOf().forEach(f => { setCardStatus(f); if (f.status === 'rule' && cards[f.name]) { const c = cards[f.name]; c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); } });
    drawArithOnPage(); toneLocks(); drawLinks(false);
  }

  // ---------- route + review queue ----------
  function validCorrection(f, text) {
    const t = String(text || '').trim();
    if (!t) return 'Type a value.';
    if (f.type === 'number' || f.type === 'integer') {
      const n = t.replace(/[£$€,\s]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(n)) return 'Not a number.';
      if (f.type === 'integer' && n.includes('.')) return 'Whole number expected.';
      return null;
    }
    if (f.type === 'date') {
      const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return 'Use YYYY-MM-DD.';
      const d = new Date(`${t}T00:00:00Z`);
      if (isNaN(d) || d.toISOString().slice(0, 10) !== t) return 'Not a real date.';
      return null;
    }
    if (f.type === 'enum' && !f.options.includes(t)) return `One of: ${f.options.join(', ')}.`;
    return null;
  }
  const normValue = (f, t) => (f.type === 'number' ? Number(String(t).replace(/[£$€,\s]/g, '')).toFixed(2) : f.type === 'integer' ? String(Number(t)) : String(t).trim());

  function snippet(f) {
    const v = V();
    const b = f.evidence;
    const vb = b ? [b.x - 10, b.y - 2.2, b.w + 20, b.h + 4.4] : null;
    if (!vb) return h('div.wbf-snip.none', f.generated ? '✦ generated from the whole document' : f.fabricated ? '∅ nothing on the page supports this value' : '∅ no region on the page');
    const sv = s('svg', { viewBox: vb.map(x => x.toFixed(1)).join(' '), class: 'wbf-snip-svg', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' });
    sv.appendChild(drawPage(v.page, { quality: v.quality, seed: params ? params.document : 'p' }));
    sv.appendChild(s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 0.8, class: `snip-box tone-${toneOf(f)}` }));
    return h('div.wbf-snip', sv);
  }

  function drawQueue(animate) {
    const v = V();
    clear(queueEl);
    queueEl.append(h('h4', 'Review queue'));
    if (!v || !v.route || !played.has('route')) { queueEl.append(h('p.small', 'Flagged fields land here after routing. You can approve or correct them.')); return; }
    const rt = v.route;
    const lastErr = res.steps[res.steps.length - 1].status === 'error';
    const fields = fieldsOf();
    const verified = fields.filter(f => (review[f.name] && review[f.name].done) || (rt.decision !== 'review' ? false : !rt.queue.includes(f.name) && ['ok', 'generated', 'empty'].includes(f.status)));
    if (rt.decision === 'approved') {
      queueEl.append(h(`div.wbf-banner.tone-${lastErr ? 'error' : 'ok'}${animate ? '.anim' : ''}`,
        h('strong', lastErr ? '⚠ Posted without review' : '✓ Auto-approved'),
        h('span', lastErr ? `Policy let unverified values through: ${rt.posted.join(', ')}.` : 'Straight-through: posted to the ERP with no human touch.')));
      if (lastErr) queueEl.append(h('ul.wbf-slipped', rt.posted.map((n, i) => { const f = fieldBy(n); return h(`li${animate ? '.drop' : ''}`, { style: `--d:${(0.15 + i * 0.12).toFixed(2)}s` }, h('button.chip-btn', { type: 'button', onclick: () => selectField(n) }, n), ' ', h('span.chip.tone-error', STATUS_TEXT[f.status] || f.status), ' ', h('code', f.value ?? (f.raw != null ? `“${f.raw}”` : 'null'))); })));
      else queueEl.append(h('p.small.wbf-empty', 'Nothing to review.'));
      return;
    }
    if (rt.decision === 'rejected') {
      queueEl.append(h(`div.wbf-banner.tone-warn${animate ? '.anim' : ''}`, h('strong', '↩ Rejected'), h('span', 'Most required fields are missing: this document does not fit the schema. Send it back to classification.')),
        h('p.small', `Missing: ${fields.filter(f => f.status === 'missing').map(f => f.name).join(', ')}`));
      return;
    }
    const done = rt.queue.filter(n => review[n] && review[n].done).length;
    const complete = done === rt.queue.length;
    queueEl.append(h(`div.wbf-banner.tone-${complete ? 'ok' : 'info'}${animate ? '.anim' : ''}`,
      h('strong', complete ? '✓ Record complete' : `⧗ ${rt.queue.length - done} waiting for review`),
      h('span', complete ? 'Every flagged value was checked by a person. Ready to post (local UI only).' : v.policy === 'doc' ? 'Policy: the whole document is reviewed.' : 'Only flagged fields need a person; clean fields are already accepted.')),
    h('div.wbf-progress', { title: 'fields verified' }, h('span', { style: `width:${(verified.length / Math.max(1, fields.length)) * 100}%` }), h('em', `${verified.length}/${fields.length} fields verified`)));
    const list = h('ul.wbf-qlist');
    rt.queue.forEach((n, i) => {
      const f = fieldBy(n);
      const rv = review[n] || {};
      const flagged = ['low', 'malformed', 'missing', 'unsupported', 'rule'].includes(f.status);
      const input = h('input', { type: 'text', value: rv.done ? rv.value : f.value ?? (f.raw != null ? f.raw : ''), 'aria-label': `Value for ${n}`, placeholder: f.type === 'date' ? 'YYYY-MM-DD' : 'value from the document', spellcheck: 'false', disabled: rv.done ? true : null });
      const err = h('span.wbf-qerr', { 'aria-live': 'polite' });
      const accept = () => {
        const val = input.value;
        const bad = validCorrection(f, val);
        if (bad) { err.textContent = bad; input.classList.add('invalid'); return; }
        review[n] = { done: true, value: normValue(f, val), changed: normValue(f, val) !== (f.value ?? '') };
        fillValue(f, 0); setCardStatus(f); toneLocks(); drawLinks(false); drawQueue(false);
        if (selected === n) showInspector(f);
      };
      const reason = f.status === 'rule' ? `failed ${f.ruleFails.filter(x => x !== 'types' && x !== 'required').map(x => RULE_NAMES[x]).join(', ')}` : STATUS_TEXT[f.status] || f.status;
      const li = h(`li.wbf-qitem${rv.done ? '.done' : ''}${animate ? '.drop' : ''}`, { style: `--d:${(0.2 + i * 0.16).toFixed(2)}s`, 'data-field': n },
        h('div.wbf-qtop', h('button.wbf-qname', { type: 'button', onclick: () => selectField(n) }, h('span.wbf-idx', String(idxOf(n) + 1)), n),
          rv.done ? h('span.chip.tone-ok', rv.changed ? 'corrected' : 'approved') : h(`span.chip.tone-${flagged ? toneOf(f) : 'muted'}`, flagged ? reason : 'confirm'),
          f.conf != null && !rv.done ? h('span.wbf-qconf', f.conf.toFixed(2)) : null),
        snippet(f),
        rv.done ? h('div.wbf-qdone', '✓ ', h('code', rv.value))
          : h('div.wbf-qedit', input,
            h('button.btn.small', { type: 'button', disabled: validCorrection(f, input.value) ? true : null, title: 'Value is right as extracted', onclick: () => accept(false) }, 'Approve'),
            h('button.btn.small.primary', { type: 'button', onclick: () => accept(true) }, 'Correct'), err));
      input.addEventListener('input', () => { err.textContent = ''; input.classList.remove('invalid'); li.querySelector('.wbf-qedit .btn').disabled = !!validCorrection(f, input.value); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') accept(true); });
      list.appendChild(li);
    });
    queueEl.append(list);
    if (complete) {
      const rec = Object.fromEntries(fields.map(f => [f.name, review[f.name] && review[f.name].done ? review[f.name].value : f.value ?? null]));
      queueEl.append(h('pre.code.wbf-record', JSON.stringify(rec, null, 2)));
    }
  }

  // ---------- selection + inspector ----------
  function hover(name, on) {
    if (!layers) return;
    svg.querySelectorAll(`[data-field="${CSS.escape(name)}"]`).forEach(x => x.classList.toggle('hover', on));
    links.querySelectorAll(`[data-field="${CSS.escape(name)}"]`).forEach(x => x.classList.toggle('hover', on));
  }
  function selectField(name) {
    const f = fieldBy(name);
    if (!f) return;
    selected = name;
    Object.entries(cards).forEach(([n, c]) => c.classList.toggle('sel', n === name));
    toneLocks();
    links.querySelectorAll('.wbf-link').forEach(p => { p.classList.toggle('hl', p.dataset.field === name); p.classList.toggle('dim', p.dataset.field !== name); });
    // show all candidates for the selected field as dashed outlines
    if (layers) {
      clear(layers.focus);
      if (played.has('locate')) for (const c of f.candidates || []) {
        if (c.chosen) continue;
        layers.focus.appendChild(s('rect', { x: c.box.x, y: c.box.y, width: c.box.w, height: c.box.h, rx: 0.8, class: `ev-alt${c.match ? ' match' : ''}`, 'data-cand': c.item + c.text }));
      }
    }
    showInspector(f);
    if (cards[name] && document.activeElement !== cards[name]) cards[name].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function showInspector(f) {
    const v = V();
    clear(inspect);
    const rv = review[f.name];
    const st = currentStatus(f);
    inspect.append(...[
      h('h4', 'Field inspector'),
      h('div.wbf-ins-head', h('span.wbf-idx', String(idxOf(f.name) + 1)), h('strong', f.name), h('span.chip.muted', f.type), f.required ? h('span.chip.muted', 'required') : null, f.method && f.method !== 'extract' ? h('span.chip.tone-info', f.method) : null, st !== 'pending' ? h(`span.chip.tone-${toneOf(f) === 'muted' ? 'muted' : toneOf(f)}`, STATUS_TEXT[st] || st) : null),
      f.desc ? h('p.small', 'Description: ', h('em', f.desc)) : null,
      f.resolvedBy ? h('p.small', 'Matched by: ', f.resolvedBy) : null].filter(Boolean));
    if (!played.has('locate')) { inspect.append(h('p.small', 'Run the lab to see where this field finds its value.')); return; }
    inspect.append(h('p.wb-quote', rv && rv.done ? rv.value : f.value ?? (f.raw != null ? `“${f.raw}”` : '—')));
    if (f.raw != null && played.has('extract')) inspect.append(h('p.small', 'Content read: ', h('code', f.raw)));
    if (played.has('extract') && f.conf != null) inspect.append(h('div.conf-meter', h('span', { class: `tone-${confTone(f.conf, v.threshold)}`, style: { width: f.conf * 100 + '%' } }), h('i', { style: { left: v.threshold * 100 + '%' } })), h('p.small', `Confidence ${f.conf.toFixed(2)} · threshold ${v.threshold.toFixed(2)}`));
    else if (played.has('extract') && f.raw != null) inspect.append(h('p.small', v.approach === 'llm' ? 'No confidence: structured outputs do not score fields.' : 'No confidence score for this field.'));
    if (f.evidence) inspect.append(h('p.small.mono', `${f.grounding === 'posthoc' ? 'matched text at' : 'boundingRegions[0].polygon'} ≈ [${[f.evidence.x, f.evidence.y, f.evidence.x + f.evidence.w, f.evidence.y + f.evidence.h].map(n => n.toFixed(1)).join(', ')}]`));
    const cands = (f.candidates || []);
    if (cands.length) {
      inspect.append(h('p.small', h('strong', 'Regions considered')));
      inspect.append(h('ul.wbf-cands', cands.map(c => {
        const li = h(`li${c.chosen ? '.chosen' : ''}`, h('span.wbf-cand-mark', c.chosen ? '●' : c.match ? '◐' : '○'), h('code', c.text), h('span.small', ` ${c.conceptLabel}`),
          h('span.small.wbf-why', c.chosen ? ' chosen' : c.match ? ' also matches; later in reading order' : ' different meaning'));
        li.addEventListener('mouseenter', () => layers.focus.querySelector(`[data-cand="${CSS.escape(c.item + c.text)}"]`)?.classList.add('hover'));
        li.addEventListener('mouseleave', () => layers.focus.querySelectorAll('.hover').forEach(x => x.classList.remove('hover')));
        return li;
      })));
    }
    for (const n of f.notes || []) inspect.append(h('p.small.wbf-note', n));
  }

  // ---------- captions ----------
  const CAPTIONS = {
    schema: st => (st.status === 'error' ? 'The schema did not parse. Fix the highlighted line in the Field schema box: nothing can be extracted until it does.' : `The schema defines ${fieldsOf().length} field card(s). ${V().approach === 'prebuilt' ? 'prebuilt-invoice has fixed fields; names that are not part of it stay empty.' : V().approach === 'cu' ? 'Each field becomes part of the analyzer\'s fieldSchema.' : 'The fields become a strict JSON schema for the model.'}`),
    locate: () => `Each field searches the page: amber dashed boxes are candidates, the solid box is the region it locks onto${V().approach === 'llm' ? ' (found afterwards by text matching, so the link is dashed)' : ''}. Click a card or a box to inspect.`,
    extract: () => (V().approach === 'llm' ? 'Values are converted to their types. The LLM gives no confidence, so bars show "unscored".' : 'Values are converted to their types and scored. The bar is confidence; the black tick is your threshold.'),
    validate: st => (st.status === 'ok' ? 'All enabled rules pass.' : 'Rules check the record as a whole. Failed rules flag the fields involved.'),
    route: st => (st.status === 'error' ? 'Auto-approve let bad values through to the ERP.' : st.status === 'ok' ? 'Straight-through: the record is approved with no human touch.' : st.status === 'warn' ? 'Rejected: the document does not fit this schema.' : 'Flagged fields dropped into the review queue below. Approve or correct each one to complete the record.'),
  };

  function applyStage(id, st, animate) {
    played.add(id);
    if (id === 'schema' && st.status !== 'error') fieldsOf().forEach(f => setCardStatus(f));
    if (id === 'locate') drawLocate();
    if (id === 'extract') drawExtract();
    if (id === 'validate') drawValidate();
    if (id === 'route') { drawQueue(animate); fieldsOf().forEach(f => setCardStatus(f)); }
    if (selected && fieldBy(selected)) showInspector(fieldBy(selected));
  }

  function resetPanels() {
    clear(inspect).append(h('h4', 'Field inspector'), h('p.small', 'Click a field card or an evidence box on the page to see the value, its confidence, the regions considered and why one was chosen.'));
    drawRules(false); drawQueue(false);
  }

  function fresh(r) {
    res = r; played = new Set(); review = {}; selected = null;
    base(); renderCards(); clear(links); rail.reset(); resetPanels();
  }

  const api = {
    el,
    setParams(p) {
      params = p;
      let r = null;
      try { r = mod.sim.run({ ...p }); } catch { r = null; }
      if (r) { r.view.fields = []; r.view.rules = []; r.view.route = null; }
      fresh(r);
      caption.textContent = r && !r.view.schema.ok ? `Schema error on line ${r.view.schema.error.n}: ${r.view.schema.error.msg}` : 'Press Run (or Step) to watch each field find its evidence, get typed, validated and routed.';
    },
    setResult(r) { fresh(r); },
    setStep(st) {
      if (!res || !st.node) return;
      rail.set(st.node, st.status); rail.active(st.node);
      caption.textContent = (CAPTIONS[st.node] || (() => st.title))(st);
      applyStage(st.node, st, true);
    },
    clearRun() { if (params) api.setParams(params); else fresh(null); },
    reset() { api.clearRun(); },
    flash(id) {
      rail.active(id);
      el.querySelector(`[data-stage="${id}"]`)?.classList.add('flash');
      const panel = id === 'validate' ? rulesEl : id === 'route' ? queueEl : null;
      if (panel) { panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash'); }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    select(id) {
      rail.active(id);
      const panel = id === 'validate' ? rulesEl : id === 'route' ? queueEl : id === 'schema' || id === 'extract' || id === 'locate' ? cardList : null;
      if (panel) { panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash'); }
    },
  };
  return api;
}
