// Classification & routing workbench: an inbox of real-looking document thumbnails that travel through a
// classifier (animated per-class score bars with threshold and margin markers) into destination lanes,
// with splitting, decision stamps, misroute flags, downstream outages, retries and dead-lettering.
import { h, s, clear } from '../engine/dom.js';
import { drawPage, stageRail, tabs } from './page.js';

const STAGES = [['intake', 'Intake'], ['split', 'Split'], ['classify', 'Classify'], ['decide', 'Thresholds'], ['route', 'Route'], ['downstream', 'Deliver']];
const CLS = {
  invoice: ['Invoice', 'Inv'], receipt: ['Receipt', 'Rcpt'], contract: ['Contract', 'Ctr'], id_document: ['ID document', 'ID'],
  purchase_order: ['Purchase order', 'PO'], credit_note: ['Credit note', 'CN'], delivery_note: ['Delivery note', 'DN'], other: ['Other / unknown', 'Oth'],
};
const label = c => (c ? (CLS[c] || [c])[0] : 'no class');
const an = w => (/^Other/.test(w) ? 'a document of no known type' : `${/^[aeiouAEIOU]/.test(w) ? 'an' : 'a'} ${w.toLowerCase().replace(/^id /, 'ID ')}`);
const short = c => (c ? (CLS[c] || [c, c])[1] : '—');
const BAND = { blue: '#0b62c4', teal: '#0f8b8d', green: '#1d7a46', amber: '#c27c0e', red: '#b42318' };
const RANK = { error: 4, warn: 3, ok: 2, info: 1, skip: 0 };
const ICON = { ap: '€', expenses: '🧾', legal: '§', kyc: '🪪', purchasing: '📦', review: '👤', unknown: '?', dlq: '☠' };
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- thumbnails ----------
function pageSvg(doc, { stacked = 0, big = false } = {}) {
  const pg = doc.page, w = pg.w, hgt = pg.h, pad = 4, off = 7;
  const svg = s('svg', { viewBox: `${-pad} ${-pad} ${w + pad * 2 + stacked * off} ${hgt + pad * 2 + stacked * off}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', class: big ? 'cls-svg big' : 'cls-svg' });
  for (let i = stacked; i > 0; i--) svg.appendChild(s('rect', { x: i * off, y: i * off, width: w, height: hgt, class: 'paper cls-backpage' }));
  const g = drawPage(pg, { quality: doc.quality, seed: doc.id });
  const deco = s('g', { class: 'cls-deco' });
  const itemY = pg.items.filter(it => it.role !== 'table').map(it => it.y);
  for (const sh of pg.shapes || []) {
    if (sh.kind === 'band') deco.appendChild(s('rect', { x: sh.x, y: sh.y, width: sh.w, height: sh.h, fill: BAND[sh.tone] || BAND.blue }));
    else if (sh.kind === 'card') { deco.appendChild(s('rect', { x: 2, y: 2, width: w - 4, height: hgt - 4, rx: 9, class: 'cls-idcard' })); deco.appendChild(s('rect', { x: 2, y: 2, width: w - 4, height: 12, class: 'cls-idstripe' })); }
    else if (sh.kind === 'photo') { deco.appendChild(s('rect', { x: sh.x, y: sh.y, width: sh.w, height: sh.h, rx: 2, class: 'cls-photo' })); deco.appendChild(s('circle', { cx: sh.x + sh.w / 2, cy: sh.y + sh.h * 0.38, r: sh.w * 0.2, class: 'cls-person' })); deco.appendChild(s('path', { d: `M${sh.x + sh.w * 0.14},${sh.y + sh.h} Q${sh.x + sh.w / 2},${sh.y + sh.h * 0.5} ${sh.x + sh.w * 0.86},${sh.y + sh.h} Z`, class: 'cls-person' })); }
    else if (sh.kind === 'logo') deco.appendChild(s('circle', { cx: sh.x + 7, cy: sh.y + 7, r: 7, fill: BAND.teal }));
    else if (sh.kind === 'zigzag') { let d = `M0,${sh.y}`; for (let x = 0; x < w; x += 6) d += ` L${x + 3},${sh.y + 3} L${Math.min(w, x + 6)},${sh.y}`; deco.appendChild(s('path', { d: d + ' Z', class: 'paper cls-zig' })); }
    else if (sh.kind === 'paras') for (let i = 0; i < sh.lines; i++) {
      const y = sh.y + i * 6.2;
      if (itemY.some(iy => Math.abs(iy - y) < 7)) continue;
      deco.appendChild(s('rect', { x: sh.x, y: y - 2, width: sh.w * (i % 5 === 4 ? 0.55 : 0.82 + ((i * 37) % 17) / 100), height: 2.2, rx: 1, class: 'cls-para' }));
    }
  }
  g.insertBefore(deco, g.children[1] || null);
  if (doc.quality < 0.6) g.classList.add('cls-blurry');
  svg.appendChild(g);
  return svg;
}

export function createWorkbench(mod) {
  const rail = stageRail(STAGES);
  const inboxGrid = h('div.cls-inbox-grid');
  const inboxCount = h('span.cls-count', '0');
  const inbox = h('section.cls-inbox', { 'aria-label': 'Inbox' }, h('header.cls-head', h('span.cls-title', '📥 Inbox'), inboxCount), inboxGrid);
  const scanSlot = h('div.cls-scan', h('span.cls-scan-hint', 'document under the classifier'));
  const barsEl = h('div.cls-bars');
  const verdict = h('div.cls-verdict', { 'aria-live': 'polite' });
  const engineSub = h('span.cls-sub');
  const engine = h('section.cls-engine', { 'aria-label': 'Classifier' },
    h('header.cls-head', h('span.cls-title', '⚙ Classifier'), engineSub), h('div.cls-engine-body', scanSlot, barsEl), verdict);
  const lanesEl = h('div.cls-lanes', { 'aria-label': 'Destination queues' });
  const caption = h('p.wb-caption', { 'aria-live': 'polite' }, 'Press Run to watch the inbox get classified and routed. Click any document to inspect it.');
  const detail = h('div.wb-detail', h('p.small', 'Click a document card to inspect it.'));
  const tb = tabs([['matrix', 'Confusion matrix'], ['queues', 'Queues']]);
  const el = h('div.workbench.wb-cls',
    rail.el,
    h('div.wb-grid',
      h('div.wb-main', h('div.cls-floor', inbox, engine), lanesEl, caption),
      h('aside.wb-side', detail, tb.el)));

  let res = null, params = null, preview = true;
  let gen = 0, timers = [], pending = [], busy = false, incoming = [], flushT = null;
  const done = new Set(), worst = {}, cards = {}, slots = {}, lanes = {};
  let selected = null, scored = new Set(), decided = false;

  const V = () => res.view;
  const unit = id => V().units.find(u => u.id === id);
  const later = (ms, fn) => { const g = gen; timers.push(setTimeout(() => { if (g === gen) fn(); }, ms)); };
  const cancel = () => { gen++; timers.forEach(clearTimeout); timers = []; pending = []; busy = false; incoming = []; if (flushT) { clearTimeout(flushT); flushT = null; } };

  // ---------- building blocks ----------
  function makeCard(doc, stacked = 0) {
    const card = h('button.cls-card', { type: 'button', 'data-id': doc.id, title: doc.file, 'aria-label': `${doc.file}: inspect` },
      h('span.cls-thumb', pageSvg(doc, { stacked })),
      h('span.cls-name', doc.file.replace(/\.(pdf|jpg|png)$/, '').replace(' · ', ' ')),
      h('span.cls-tags'));
    if (doc.lang && doc.lang !== 'en') card.querySelector('.cls-tags').appendChild(h('span.cls-tag.lang', doc.lang.toUpperCase()));
    if (stacked) card.querySelector('.cls-tags').appendChild(h('span.cls-tag.pp', `${stacked + 1} pp`));
    card.addEventListener('click', () => select(doc.id));
    cards[doc.id] = card;
    return card;
  }
  function tag(card, kind, text, title) {
    if (!card) return null;
    let t = card.querySelector(`.cls-${kind}`);
    if (!t) { t = h(`span.cls-${kind}`); card.appendChild(t); }
    t.textContent = text; if (title) t.title = title;
    return t;
  }

  function fly(card, target, dur = 520, before = null) {
    const first = card.getBoundingClientRect();
    if (before) target.insertBefore(card, before); else target.appendChild(card);
    const last = card.getBoundingClientRect();
    if (!first.width || !last.width || reduceMotion()) return;
    card.style.transition = 'none';
    card.style.transform = `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width})`;
    card.classList.add('flying');
    card.getBoundingClientRect();
    card.style.transition = `transform ${dur}ms cubic-bezier(.3,.75,.25,1)`;
    card.style.transform = '';
    const g = gen;
    setTimeout(() => { if (g === gen) { card.classList.remove('flying'); card.style.transition = ''; } }, dur + 30);
  }

  function buildInbox() {
    clear(inboxGrid);
    Object.keys(cards).forEach(k => delete cards[k]);
    Object.keys(slots).forEach(k => delete slots[k]);
    const v = V();
    for (const f of v.files) {
      const slot = h('div.cls-slot', { 'data-file': f.id });
      slots[f.id] = slot;
      slot.appendChild(makeCard(f, f.multi ? 1 : 0)); // unsplit units share their file's id
      inboxGrid.appendChild(slot);
    }
    inboxCount.textContent = `${v.files.length} files`;
  }

  function buildLanes() {
    clear(lanesEl);
    for (const l of V().lanes) {
      const body = h('div.cls-lane-body');
      const count = h('span.cls-count', '0');
      const lane = h(`section.cls-lane.lane-${l.id}`, { 'data-lane': l.id },
        h('header.cls-lane-head', h('span.cls-lane-icon', { 'aria-hidden': 'true' }, ICON[l.id]), h('span.cls-lane-name', h('strong', { title: l.label }, l.short || l.label), h('small', { title: l.system }, l.system)), count),
        body);
      if (l.down) lane.classList.add('armed');
      lanes[l.id] = { el: lane, body, count };
      lanesEl.appendChild(lane);
    }
  }
  const recount = () => { for (const [, l] of Object.entries(lanes)) l.count.textContent = String(l.body.querySelectorAll('.cls-card').length); };

  // ---------- score bars ----------
  function showPreview(u) {
    scanSlot.querySelectorAll('.cls-scan-preview').forEach(x => x.remove());
    if (!u || scanSlot.querySelector('.cls-card')) return;
    const multi = u.hidden && u.hidden.length;
    scanSlot.appendChild(h('button.cls-scan-preview', { type: 'button', title: u.file, onclick: () => select(u.id) }, h('span.cls-thumb', pageSvg(u, { stacked: multi ? 1 : 0 })), h('span.cls-name', u.file)));
  }
  function renderBars(u, animate) {
    clear(barsEl);
    showPreview(u);
    const v = V(), th = v.threshold, mg = v.margin;
    engineSub.textContent = `${{ keywords: 'keyword rules', trained: 'trained classifier', zeroshot: 'zero-shot categories' }[v.approach]} · t ${th} · m ${mg}`;
    const rows = v.classes.map(c => {
      const sc = u && u.scores ? u.scores.find(x => x.cls === c) : null;
      const p = sc ? sc.p : 0;
      const isTop = u && u.top === c, isSecond = u && u.secondCls === c && u.second > 0;
      const fill = h(`span.cls-fill.c-${c}`, { style: { width: animate ? '0%' : `${p * 100}%` } });
      const track = h('span.cls-track', fill, h('i.cls-th', { style: { left: `${th * 100}%` }, title: `threshold ${th}` }));
      if (isTop && u.second != null) {
        track.appendChild(h(`span.cls-gap.${u.marginV >= mg ? 'ok' : 'bad'}`, { style: { left: `${u.second * 100}%`, width: `${Math.max(0, u.conf - u.second) * 100}%` }, title: `margin ${u.marginV.toFixed(2)}` }));
        if (u.second + mg <= 1) track.appendChild(h('i.cls-mg', { style: { left: `${(u.second + mg) * 100}%` }, title: `runner-up + min margin = ${(u.second + mg).toFixed(2)}` }));
      }
      if (animate) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${p * 100}%`; }));
      return h(`div.cls-bar${isTop ? '.top' : ''}${isSecond ? '.second' : ''}${u && u.truth === c ? '.truth' : ''}`,
        h('span.cls-bar-label', { title: label(c) }, label(c)), track, h('span.cls-bar-val', u && u.scores ? p.toFixed(2) : '—'));
    });
    barsEl.append(...rows,
      h('div.cls-legend', h('span', h('i.lg-th'), `threshold ${th}`), h('span', h('i.lg-gap'), 'margin top-1 − top-2'), h('span', h('i.lg-mg'), `min margin ${mg}`)));
    if (u && u.scores && u.hits) {
      const fired = Object.entries(u.hits).filter(([, k]) => k.length).map(([c, k]) => `${short(c)}: ${k.join(', ')}`);
      barsEl.appendChild(h('p.cls-hits', fired.length ? `Rules fired · ${fired.join(' · ')}` : 'No keyword rule fired.'));
    }
  }

  function setVerdict(u) {
    clear(verdict);
    verdict.className = 'cls-verdict';
    if (!u || !u.scores) return;
    if (!decided) { verdict.append(h('strong', `Top-1: ${label(u.top)} ${u.conf.toFixed(2)}`), ` · runner-up ${label(u.secondCls)} ${u.second.toFixed(2)}`); return; }
    const laneName = V().lanes.find(l => l.id === u.lane).label;
    verdict.classList.add(`v-${u.misroute ? 'mis' : u.decision}`);
    verdict.append(h('strong', u.decision === 'auto' ? `AUTO → ${laneName}` : u.decision === 'review' ? 'MANUAL REVIEW' : 'UNKNOWN → triage'), ' ', h('span', u.reason));
    if (u.misroute) verdict.append(h('span.cls-truthnote', ` Wrong: it is really ${an(label(u.truth))}.`));
  }

  // ---------- inspector ----------
  function select(id) {
    selected = id;
    el.querySelectorAll('.cls-card.sel').forEach(c => c.classList.remove('sel'));
    if (cards[id]) cards[id].classList.add('sel');
    const v = V();
    const u = v.units.find(x => x.id === id);
    const f = v.files.find(x => x.id === id);
    const doc = u || f;
    if (!doc) return;
    const multi = f && f.multi && (!u || (u.hidden && u.hidden.length));
    const known = u && scored.has(u.id) && !preview;
    clear(detail).append(...[
      h('h4', 'Document'),
      h('p.wb-quote', doc.file),
      h('div.cls-big', pageSvg(doc, { stacked: multi ? 1 : 0, big: true })),
      h('dl.kv',
        h('dt', 'Ground truth'), h('dd', label(doc.truth), multi ? ' + delivery note (page 2)' : '', h('span.small', ' (hidden from the classifier)')),
        known ? [h('dt', 'Top class'), h('dd', `${label(u.top)} · ${u.conf.toFixed(2)}`),
          h('dt', 'Runner-up'), h('dd', `${label(u.secondCls)} · ${u.second.toFixed(2)} (margin ${u.marginV.toFixed(2)})`)] : null,
        known && decided ? [h('dt', 'Decision'), h('dd', u.decision === 'auto' ? `auto-route → ${v.lanes.find(l => l.id === u.lane).label}` : u.decision), h('dt', 'Why'), h('dd', u.reason)] : null,
        known && done.has('downstream') ? [h('dt', 'Delivery'), h('dd', u.delivery.status + (u.delivery.attempts > 1 ? ` after ${u.delivery.attempts} attempts` : ''))] : null),
      !known ? h('p.small', preview ? 'Run the simulator to classify this document.' : 'Not classified yet.') : null,
      known && u.misroute ? h('p.alert.tone-error', `Misrouted: ${an(label(u.truth))} was handled as ${an(label(u.top))}.`) : null,
      known && u.wrongUnknown ? h('p.alert.tone-warn', `A real ${label(u.truth).toLowerCase()} was parked as unknown.`) : null,
      known && u.hidden && u.hidden.length ? h('p.alert.tone-error', 'This file also contains a delivery note that nobody will process.') : null,
      known && u.delivery.status === 'lost' && done.has('downstream') ? h('p.alert.tone-error', 'Lost: the destination failed and nothing retried or dead-lettered the message.') : null,
      known && u.delivery.status === 'dead-lettered' && done.has('downstream') ? h('p.alert.tone-warn', 'Waiting in the dead-letter queue: resubmit once the system is back.') : null].filter(Boolean));
    if (known) { renderBars(u, false); setVerdict(u); }
  }

  // ---------- side tabs ----------
  function fillMatrix() {
    const v = V(), p = clear(tb.panel('matrix'));
    const rows = v.labels.filter(t => v.units.some(u => u.truth === t));
    const max = Math.max(1, ...v.matrix.flat().map(c => c.length));
    p.append(h('p.small', 'Rows: ground truth. Columns: classifier top-1 before thresholds. Click a cell to find those documents.'),
      h('div.table-wrap', h('table.cls-matrix',
        h('thead', h('tr', h('th', { scope: 'col' }, 'truth ↓'), v.cols.map(c => h('th', { scope: 'col', title: label(c) }, short(c))))),
        h('tbody', rows.map(t => {
          const ri = v.labels.indexOf(t);
          return h('tr', h('th', { scope: 'row', title: label(t) }, short(t)), v.cols.map((c, ci) => {
            const ids = v.matrix[ri][ci];
            const td = h(`td.${!ids.length ? 'z' : c === t ? 'hit' : 'miss'}`, { style: ids.length ? { '--a': String(0.25 + 0.75 * ids.length / max) } : null, title: ids.length ? ids.map(id => unit(id).file).join('\n') : '' }, ids.length ? String(ids.length) : '');
            if (ids.length) td.addEventListener('click', () => { ids.forEach(id => { const c2 = cards[id]; if (c2) { c2.classList.remove('ping'); void c2.offsetWidth; c2.classList.add('ping'); } }); select(ids[0]); });
            return td;
          }));
        })))));
    const acc = v.units.filter(u => u.top === u.truth).length;
    p.append(h('p.small', `Top-1 correct: ${acc}/${v.units.length}. Diagonal = correct; red cells are confusions your thresholds must catch.`));
  }
  function fillQueues() {
    const v = V(), p = clear(tb.panel('queues'));
    const where = u => u.finalLane || u.lane;
    p.append(h('ul.cls-qlist', v.lanes.map(l => {
      const us = v.units.filter(u => where(u) === l.id);
      return h('li', h('span.cls-qdot.lane-' + l.id), h('strong', l.label), ` ${us.length}`, l.down ? h('span.chip.tone-error', 'down') : null,
        us.length ? h('div.small', us.map(u => [h('a', { href: '#', onclick: e => { e.preventDefault(); select(u.id); } }, u.file), u.misroute ? h('span.chip.tone-error', 'wrong') : null, u.delivery.status === 'lost' ? h('span.chip.tone-error', 'lost') : null, ' ']).flat()) : null);
    })));
  }

  // ---------- stages (each works animated or instant) ----------
  const STAGE = {
    intake(instant) {
      const cs = Object.values(slots).map(sl => sl.firstChild);
      cs.forEach((c, i) => { if (instant) c.classList.remove('pending'); else later(i * 70, () => { c.classList.remove('pending'); c.classList.add('drop'); }); });
      return instant ? 0 : cs.length * 70 + 350;
    },
    split(instant) {
      const v = V(), f = v.files.find(x => x.multi), slot = slots[f.id], old = slot.firstChild;
      if (!v.split) { old.classList.add('warned'); tag(old, 'flag', '2 docs in 1 file', 'Not split: page 2 is a separate document'); return instant ? 0 : 700; }
      const parts = v.units.filter(u => u.fileId === f.id);
      const go = () => {
        old.remove(); delete cards[f.id];
        slot.classList.add('pair');
        parts.forEach((u, i) => { const c = makeCard(u); c.classList.add(instant ? 'x' : i ? 'pop-r' : 'pop-l'); slot.appendChild(c); });
        if (selected === f.id) select(parts[0].id);
      };
      if (instant) { go(); return 0; }
      old.classList.add('tear');
      later(450, go);
      return 1100;
    },
    classify(instant) {
      const v = V();
      if (instant) { v.units.forEach(u => { scored.add(u.id); chip(u); }); return 0; }
      const per = 560;
      v.units.forEach((u, i) => {
        later(i * per, () => {
          const c = cards[u.id]; if (!c) return;
          c.classList.add('in-engine'); fly(c, scanSlot, 300); scanSlot.classList.add('scanning');
          renderBars(u, true); scored.add(u.id); setVerdict(u);
          caption.textContent = `Scoring ${u.file} (${i + 1}/${v.units.length}): ${label(u.top)} ${u.conf.toFixed(2)}, runner-up ${label(u.secondCls)} ${u.second.toFixed(2)}.`;
        });
        later(i * per + per - 40, () => {
          const c = cards[u.id]; if (!c) return;
          c.classList.remove('in-engine'); fly(c, slots[u.fileId], 300, u.part === 1 ? slots[u.fileId].firstChild : null);
          chip(u);
          if (i === v.units.length - 1) scanSlot.classList.remove('scanning');
        });
      });
      return v.units.length * per + 300;
    },
    decide(instant) {
      const v = V(); decided = true;
      const f = featured(); renderBars(f, false); setVerdict(f);
      v.units.forEach((u, i) => { const go = () => stamp(u); if (instant) go(); else later(150 + i * 75, go); });
      return instant ? 0 : 150 + v.units.length * 75 + 400;
    },
    route(instant) {
      const v = V();
      v.units.forEach((u, i) => {
        const go = () => {
          const c = cards[u.id]; if (!c) return;
          c.classList.add('in-lane');
          if (instant) lanes[u.lane].body.appendChild(c); else fly(c, lanes[u.lane].body, 620);
          recount();
          const land = () => {
            if (u.misroute) { c.classList.add('mis'); tag(c, 'flag', `✗ ${short(u.truth)}`, `Really a ${label(u.truth)}`); }
            else if (u.wrongUnknown) { c.classList.add('warned'); tag(c, 'flag', `real ${short(u.truth)}`, `Really a ${label(u.truth)}`); }
            if (u.hidden && u.hidden.length) { c.classList.add('mis'); tag(c, 'flag', '+DN', 'Unsplit file: the delivery note rides along'); }
          };
          if (instant) land(); else later(640, land);
        };
        if (instant) go(); else later(i * 140, go);
      });
      if (!instant) later(v.units.length * 140 + 200, () => Object.values(slots).forEach(sl => sl.classList.add('empty')));
      else Object.values(slots).forEach(sl => sl.classList.add('empty'));
      return instant ? 0 : v.units.length * 140 + 800;
    },
    downstream(instant) {
      const v = V();
      const down = v.lanes.find(l => l.down);
      if (down) lanes[down.id].el.classList.add('down');
      const auto = v.units.filter(u => u.decision === 'auto');
      let t = 0;
      auto.forEach((u, i) => {
        const c = cards[u.id]; if (!c) return;
        const st = u.delivery.status;
        const at = instant ? 0 : (st === 'delivered' ? i * 60 : 300);
        const finish = () => {
          if (st === 'delivered' || st === 'retried') tag(c, 'tick', st === 'retried' ? '✓×3' : '✓', st === 'retried' ? 'Delivered after retries' : 'Delivered');
          if (st === 'lost') { c.classList.add('lost'); tag(c, 'flag', 'lost', 'Never delivered'); }
          if (st === 'dead-lettered') { tag(c, 'flag', 'DLQ', 'Dead-lettered after max deliveries'); if (instant) lanes.dlq.body.appendChild(c); else fly(c, lanes.dlq.body, 650); recount(); }
          if (u.hidden && u.hidden.length) ghost();
        };
        if (st === 'delivered') { if (instant) finish(); else later(at, finish); t = Math.max(t, at + 200); }
        else {
          if (!instant && (st === 'retried' || u.delivery.attempts > 1 || st === 'dead-lettered')) later(at, () => c.classList.add('bounce'));
          if (!instant && st === 'lost' && u.delivery.attempts === 1) later(at, () => c.classList.add('shake'));
          const end = st === 'lost' && u.delivery.attempts === 1 ? 600 : 1500;
          if (instant) finish(); else later(at + end, () => { c.classList.remove('bounce', 'shake'); finish(); });
          t = Math.max(t, at + end + 700);
        }
      });
      if (auto.every(u => !(u.hidden && u.hidden.length)) && v.units.some(u => u.hidden && u.hidden.length)) ghost();
      if (down && v.transient) { const rec = () => { lanes[down.id].el.classList.remove('down'); lanes[down.id].el.classList.add('recovered'); }; if (instant) rec(); else later(Math.max(t, 600), rec); }
      return instant ? 0 : Math.max(t, 600);
    },
  };
  function ghost() {
    if (lanes.purchasing.body.querySelector('.cls-ghost')) return;
    lanes.purchasing.body.appendChild(h('span.cls-ghost', { title: 'The delivery note never arrived' }, 'DN-7781 missing'));
  }
  function chip(u) {
    const c = cards[u.id]; if (!c) return;
    const t = tag(c, 'chip', u.top ? `${short(u.top)} ${u.conf.toFixed(2).replace(/^0/, '')}` : 'no match', `${label(u.top)} ${u.conf.toFixed(2)}`);
    t.className = `cls-chip c-${u.top || 'none'}`;
  }
  function stamp(u) {
    const c = cards[u.id]; if (!c) return;
    const t = tag(c, 'stamp', u.decision === 'auto' ? '✓' : u.decision === 'review' ? '?' : '∅', u.reason);
    t.className = `cls-stamp s-${u.decision}`;
    c.classList.add('stamped');
  }
  function featured() {
    const us = V().units;
    return us.find(u => u.misroute) || us.find(u => u.hidden && u.hidden.length) || us.find(u => u.wrongUnknown) || us.find(u => u.truth === 'credit_note') || us[0];
  }

  const CAPTIONS = {
    intake: () => `${V().files.length} files arrive in the inbox. Each gets a correlation id.`,
    split: st => (V().split ? 'The 2-page scan is split: page 1 is an invoice, page 2 a delivery note. Each is classified on its own.' : st.title + ': the delivery note is hidden inside the invoice file.'),
    classify: () => 'Each document visits the classifier. Bars show its score per category; the dashed line is the threshold.',
    decide: () => `Thresholds stamp every document: ✓ auto-route (score ≥ ${V().threshold} and margin ≥ ${V().margin}), ? manual review, ∅ unknown.`,
    route: () => { const m = V().units.filter(u => u.misroute).length; return m ? `Documents fly to their queues. ${m} landed in the wrong system (red).` : 'Documents fly to their destination queues. Nothing auto-routed went to the wrong place.'; },
    downstream: () => { const v = V(), l = v.lanes.find(x => x.down); const lost = v.units.filter(u => u.delivery.status === 'lost').length, dl = v.units.filter(u => u.delivery.status === 'dead-lettered').length;
      return l ? `${l.system} is failing. ${v.transient && v.policy !== 'none' ? 'Retries bounce until it recovers.' : dl ? `${dl} message(s) dead-lettered: safe, waiting for resubmission.` : `${lost} document(s) lost.`}` : v.units.some(u => u.hidden && u.hidden.length) ? 'Delivered, but Purchasing never receives the delivery note.' : 'Every routed document is delivered and acknowledged.'; },
  };

  // ---------- step queue ----------
  function apply(st) {
    const prev = worst[st.node];
    if (!prev || RANK[st.status] > RANK[prev]) worst[st.node] = st.status;
    rail.set(st.node, worst[st.node]); rail.active(st.node);
  }
  function runStage(st, instant) {
    apply(st);
    if (done.has(st.node) || !STAGE[st.node]) return 0;
    done.add(st.node);
    if (!instant) caption.textContent = CAPTIONS[st.node](st);
    const d = STAGE[st.node](instant);
    if (st.node === 'classify') { if (instant) fillMatrix(); else later(d, fillMatrix); }
    if (st.node === 'route' || st.node === 'downstream') fillQueues();
    if (st.node === 'downstream' || st.node === 'decide') { const fin = () => { caption.textContent = CAPTIONS[st.node](st); if (selected && !preview) select(selected); }; if (instant) fin(); else later(d, () => { fin(); if (st.node === 'downstream' && (!selected || !cards[selected])) select(featured().id); }); }
    return d;
  }
  function next() {
    const st = pending.shift();
    if (!st) { busy = false; return; }
    busy = true;
    const d = runStage(st, reduceMotion());
    later(d, next);
  }
  function flush() {
    flushT = null;
    const batch = incoming; incoming = [];
    if (res && batch.length === res.steps.length && !busy && !done.size) {
      batch.forEach(st => runStage(st, true));
      const f = featured(); renderBars(f, false); setVerdict(f);
      caption.textContent = 'Finished instantly. Click any card to see its scores, decision and delivery. Switch to normal speed to watch it move.';
      if (!selected || !cards[selected]) select(f.id); else select(selected);
      return;
    }
    pending.push(...batch);
    if (!busy) next();
  }

  function base(isPreview) {
    cancel();
    preview = isPreview;
    done.clear(); scored = new Set(); decided = false;
    Object.keys(worst).forEach(k => delete worst[k]);
    rail.reset();
    if (!res) return;
    buildInbox();
    if (!isPreview) Object.values(slots).forEach(sl => sl.firstChild && sl.firstChild.classList.add('pending'));
    buildLanes();
    scanSlot.classList.remove('scanning');
    renderBars(null, false); setVerdict(null);
    ['matrix', 'queues'].forEach(t => clear(tb.panel(t)).appendChild(h('p.small', 'Run the simulator to fill this in.')));
    if (selected && (cards[selected])) select(selected); else { selected = null; clear(detail).append(h('p.small', 'Click a document card to inspect it.')); }
  }

  const api = {
    el,
    setParams(p) {
      params = p;
      try { res = mod.sim.run({ ...p }); } catch { res = null; }
      base(true);
      caption.textContent = 'This is the inbox. Press Run (or Step) to classify and route it; click any document to inspect it.';
    },
    setResult(r) { res = r; base(false); caption.textContent = 'Starting…'; },
    setStep(st) {
      if (!res || !st.node) return;
      incoming.push(st);
      if (!flushT) flushT = setTimeout(flush, 0);
    },
    // Resolves when every queued stage animation has played (used to keep the step log in sync).
    idle() {
      return new Promise(resolve => {
        const check = () => (!busy && !pending.length && !incoming.length && !flushT) ? resolve() : setTimeout(check, 100);
        setTimeout(check, 50);
      });
    },
    clearRun() { if (params) api.setParams(params); else { cancel(); res = null; rail.reset(); } },
    reset() { api.clearRun(); },
    flash(id) {
      rail.active(id);
      el.querySelector(`[data-stage="${id}"]`)?.classList.add('flash');
      const target = { split: inbox, intake: inbox, classify: engine, decide: engine, route: lanesEl, downstream: lanesEl }[id];
      if (target) { target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    select(id) { rail.active(id); },
  };
  return api;
}
