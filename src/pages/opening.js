// Opening of the session: six questions asked to the room before any service is named.
// Each chapter is a question, a visual to drive, and an answer kept hidden until revealed.
import { h, s, clear } from '../engine/dom.js';

const pad = n => String(n).padStart(2, '0');
const C = { doc: '#2f5bd3', image: '#0f7a6c', audio: '#b45f06', video: '#a3324f' };

// Seeded random so the "pixels", waveform and film strip look the same on every visit.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---------------------------------------------------------------- shared invoice
// Regions in % of the page box: [x, y, w, h].
const R = {
  page: [0, 0, 100, 100], vendor: [5, 4, 44, 12], meta: [56, 4, 39, 15], billto: [5, 21, 44, 11],
  table: [5, 36, 90, 30], total: [52, 69, 43, 13], sign: [5, 85, 40, 11],
};
const pos = ([x, y, w, hh]) => `left:${x}%;top:${y}%;width:${w}%;height:${hh}%`;

function invoice() {
  const reg = (k, ...kids) => h(`div.op-reg.op-reg-${k}`, { style: pos(R[k]) }, ...kids);
  const rows = [['A4 copy paper', '40', '45.00', '1,800.00'], ['Toner cartridge', '12', '160.00', '1,920.00'], ['Delivery', '1', '430.00', '430.00']];
  const sig = s('svg', { viewBox: '0 0 120 30', class: 'op-sig', 'aria-hidden': 'true' },
    s('path', { d: 'M4 22 C 14 4, 22 30, 32 14 S 48 6, 56 20 S 74 26, 84 10 S 104 16, 116 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 }));
  return h('div.op-page', { role: 'img', 'aria-label': 'Sample invoice from Contoso Paper Co. to Northwind Traders, total £4,980.00' },
    reg('vendor', h('span.op-logo'), h('div', h('strong', 'Contoso Paper Co.'), h('span', '12 Harbour Road, Leeds'))),
    reg('meta', h('strong.op-inv-title', 'INVOICE'), h('span', 'No. INV-4471'), h('span', 'Date 12 Mar 2026')),
    reg('billto', h('span.op-label', 'Bill to'), h('strong', 'Northwind Traders'), h('span', '4 Mill Lane, York')),
    reg('table', h('table.op-tbl', h('thead', h('tr', ['Item', 'Qty', 'Price', 'Amount'].map(t => h('th', t)))),
      h('tbody', rows.map(r => h('tr', r.map(c => h('td', c))))))),
    reg('total', h('div', h('span', 'Subtotal'), h('span', '4,150.00')), h('div', h('span', 'Tax (20%)'), h('span', '830.00')), h('div.op-total', h('span', 'Total'), h('span', '£4,980.00'))),
    reg('sign', sig, h('span', 'Approved')));
}

// A dimming spotlight that glides between regions of a page.
function spotlight(page) {
  const el = h('div.op-spot', { hidden: true });
  page.appendChild(el);
  return k => { if (!k) { el.hidden = true; return; } el.hidden = false; el.setAttribute('style', pos(R[k])); };
}

// ---------------------------------------------------------------- 1. document vs content
const ITEMS = [
  { id: 'inv', icon: 'page', name: 'Scanned supplier invoice (PDF)', doc: 'yes', why: 'Pages, a fixed layout, made to be read by a person. A document.' },
  { id: 'contract', icon: 'pages', name: 'Signed 14-page rental contract', doc: 'yes', why: 'Long prose, clauses and a signature page. A document, mostly unstructured.' },
  { id: 'passport', icon: 'id', name: 'Passport photo page', doc: 'yes', why: 'A standard form with fixed fields. A document, highly structured.' },
  { id: 'call', icon: 'audio', name: 'Recorded customer support call', doc: 'no', why: 'No pages, no layout. The information is speech: who said what, and when.' },
  { id: 'video', icon: 'video', name: 'Product demo video', doc: 'no', why: 'Frames, scenes and a soundtrack. Information spread over time.' },
  { id: 'photo', icon: 'photo', name: 'Photo of a dented car bumper', doc: 'no', why: 'Pure image. The information is what it shows, not what it says.' },
  { id: 'board', icon: 'board', name: 'Phone photo of a meeting whiteboard', doc: 'both', why: 'An image that contains text. Not a document, but it still needs OCR to be read.' },
];

function icon(kind, color) {
  const st = { fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const g = s('svg', { viewBox: '0 0 32 32', class: 'op-icon', 'aria-hidden': 'true' });
  const add = (t, a) => g.appendChild(s(t, { ...st, ...a }));
  if (kind === 'page' || kind === 'pages') {
    if (kind === 'pages') add('path', { d: 'M10 5h13v20' });
    add('rect', { x: 6, y: 8, width: 14, height: 19, rx: 1.5 });
    [13, 17, 21].forEach(y => add('path', { d: `M9 ${y}h8` }));
  } else if (kind === 'id') {
    add('rect', { x: 4, y: 8, width: 24, height: 16, rx: 2 }); add('circle', { cx: 11, cy: 15, r: 3 }); add('path', { d: 'M17 13h7M17 17h7M8 21h16' });
  } else if (kind === 'audio') {
    [[6, 6], [10, 12], [14, 18], [18, 10], [22, 14], [26, 6]].forEach(([x, hh]) => add('path', { d: `M${x} ${16 - hh / 2}v${hh}` }));
  } else if (kind === 'video') {
    add('rect', { x: 4, y: 8, width: 24, height: 16, rx: 2 }); add('path', { d: 'M14 12.5v7l6-3.5z' });
  } else if (kind === 'photo') {
    add('rect', { x: 4, y: 7, width: 24, height: 18, rx: 2 }); add('path', { d: 'M4 21l7-6 5 4 4-3 8 6' }); add('circle', { cx: 22, cy: 12, r: 2 });
  } else if (kind === 'board') {
    add('rect', { x: 4, y: 6, width: 24, height: 16, rx: 1.5 }); add('path', { d: 'M8 11h9M8 15h14M12 26l4-4 4 4' });
  }
  return g;
}

function chDocContent() {
  const tiles = ITEMS.map(it => {
    const tile = h('button.op-tile', { type: 'button', 'aria-pressed': 'false' },
      icon(it.icon, 'currentColor'), h('span.op-tile-name', it.name),
      h('span.op-tile-verdict',
        h(`span.op-chip.${it.doc}`, it.doc === 'yes' ? 'Document' : it.doc === 'no' ? 'Not a document' : 'Image with text'),
        h('span.op-chip.content', 'Content'),
        h('span.op-tile-why', it.why)));
    tile.addEventListener('click', () => { tile.classList.toggle('open'); tile.setAttribute('aria-pressed', String(tile.classList.contains('open'))); update(); });
    return tile;
  });
  const venn = h('div.op-venn', { hidden: true },
    h('div.op-venn-outer', h('span.op-venn-label', 'Content: any information, in any form'),
      h('div.op-venn-mods', [['Speech', C.audio], ['Video', C.video], ['Images', C.image]].map(([t, c]) => h('span', { style: `--c:${c}` }, t))),
      h('div.op-venn-inner', h('span.op-venn-label', 'Documents'), h('span.small', 'pages · layout · forms · tables · signatures'))));
  const update = () => { venn.hidden = !tiles.some(t => t.classList.contains('open')) || tiles.filter(t => t.classList.contains('open')).length < 3; };
  const all = h('button.btn.small', { type: 'button', onclick: () => { tiles.forEach(t => { t.classList.add('open'); t.setAttribute('aria-pressed', 'true'); }); update(); } }, 'Reveal all');
  const reset = h('button.btn.small.ghost', { type: 'button', onclick: () => { tiles.forEach(t => { t.classList.remove('open'); t.setAttribute('aria-pressed', 'false'); }); update(); } }, 'Reset');
  return {
    q: 'What is the difference between a document and content?',
    prompt: 'Sort these seven things. Which ones are documents? Ask the room, then click each card.',
    viz: h('div.op-viz', h('div.op-tiles', tiles), h('div.op-row', all, reset), venn),
    answer: [
      h('p', h('strong', 'A document is a container. Content is what it carries.'), ' A document has pages and a layout designed for a human reader: an invoice, a contract, a passport. Content is any information in any form: the text and tables inside that document, but also speech in a call, scenes in a video, and what a photo shows.'),
      h('div.op-map',
        h('div', { style: `--c:${C.doc}` }, h('span.overline', 'Documents'), h('strong', 'Azure AI Document Intelligence'), h('span.small', 'Reads pages: text, layout, tables, key-value pairs and fields.')),
        h('div', { style: '--c:var(--text)' }, h('span.overline', 'All content'), h('strong', 'Azure AI Content Understanding'), h('span.small', 'One way to analyze documents, images, audio and video into the fields you define.'))),
    ],
  };
}

// ---------------------------------------------------------------- 2. how a human reads
const READ = [
  { k: 'page', human: 'Glance at the whole page. A logo, a table, a total at the bottom: it is an invoice. You knew before reading a single word.', machine: 'Classification', mnote: 'Decide the document type first, because the type decides what to look for.' },
  { k: 'vendor', human: 'Who sent it? Top left, next to the logo. You use position as a map.', machine: 'OCR + layout', mnote: 'Read the words and keep where they are on the page.' },
  { k: 'meta', human: 'Which invoice, and when? The label "No." tells you what the value beside it means.', machine: 'Key-value pairs', mnote: 'Link each label to its value.' },
  { k: 'table', human: 'Read the table row by row. The column heading tells you whether 40 is a quantity or a price.', machine: 'Table extraction', mnote: 'Rows, columns and headers, not just a stream of numbers.' },
  { k: 'total', human: 'Jump to the total. Does 4,150 plus 830 make 4,980? You check without being asked.', machine: 'Fields + validation', mnote: 'Pull the named values out and check them against rules.' },
  { k: 'sign', human: 'Is it approved? Then pay it, or pass it to someone else if anything looks odd.', machine: 'Routing + human review', mnote: 'Send it on automatically when confident, to a person when not.' },
];

function chHumanRead() {
  const page = invoice();
  const spot = spotlight(page);
  let i = -1, timer = null;
  const list = h('ol.op-steps', READ.map((st, n) => h('li', { 'data-n': n }, h('span.op-step-human', st.human), h('span.op-step-machine', h('strong', st.machine), ' ', st.mnote))));
  const machineTog = h('input', { type: 'checkbox' });
  machineTog.addEventListener('change', () => list.classList.toggle('show-machine', machineTog.checked));
  const go = n => {
    i = Math.max(-1, Math.min(READ.length - 1, n));
    spot(i < 0 ? null : READ[i].k);
    [...list.children].forEach((li, k) => { li.classList.toggle('now', k === i); li.classList.toggle('done', k < i); });
  };
  const stop = () => { clearInterval(timer); timer = null; play.textContent = 'Read it like a human'; };
  const play = h('button.btn.small.primary', { type: 'button', onclick: () => {
    if (timer) return stop();
    go(0); play.textContent = 'Pause';
    timer = setInterval(() => { if (i >= READ.length - 1) stop(); else go(i + 1); }, 2600);
  } }, 'Read it like a human');
  const back = h('button.btn.small', { type: 'button', onclick: () => { stop(); go(i - 1); } }, 'Back');
  const next = h('button.btn.small', { type: 'button', onclick: () => { stop(); go(i + 1); } }, 'Next');
  return {
    q: 'How do you read a document?',
    prompt: 'Nobody reads an invoice top to bottom, word by word. What do your eyes actually do?',
    viz: h('div.op-viz.op-split',
      h('div.op-page-wrap', page),
      h('div', h('div.op-row', play, back, next, h('label.bz-tog', machineTog, ' Show what a machine must do')), list)),
    answer: [h('p', h('strong', 'You never just read the words. '), 'You recognise the type, use the layout as a map, pair labels with values, read tables by their headings, check the sums and decide what happens next. A machine has to do every one of those steps explicitly, and each step is a stage you will see today.')],
    cleanup: stop,
  };
}

// ---------------------------------------------------------------- 3. what the computer sees
const OCR_LINES = ['Contoso Paper Co.', 'INVOICE', '12 Harbour Road, Leeds', 'No. INV-4471', 'Date 12 Mar 2026', 'Bill to', 'Northwind Traders', '4 Mill Lane, York',
  'Item Qty Price Amount', 'A4 copy paper 40 45.00 1,800.00', 'Toner cartridge 12 160.00 1,920.00', 'Delivery 1 430.00 430.00',
  'Subtotal 4,150.00', 'Tax (20%) 830.00', 'Total £4,980.00', ['~/\\_/~~\\', 'low'], 'Approved'];
const FIELDS = [
  ['VendorName', 'Contoso Paper Co.', 'vendor'], ['InvoiceId', 'INV-4471', 'meta'], ['InvoiceDate', '2026-03-12', 'meta'], ['CustomerName', 'Northwind Traders', 'billto'],
  ['Items', '3 rows: description, quantity, unit price, amount', 'table'], ['SubTotal', '4150.00', 'total'], ['TotalTax', '830.00', 'total'], ['InvoiceTotal', '4980.00 GBP', 'total'],
];
const LAYOUT = [['vendor', 'Text + logo', 1], ['meta', 'Title, key-value pairs', 2], ['billto', 'Key-value pair', 3], ['table', 'Table · 4 columns × 4 rows', 4], ['total', 'Key-value pairs', 5], ['sign', 'Signature', 6]];

function pixels() {
  const W = 52, H = 66, rand = rng(4471);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'op-pixels', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const inside = (x, y) => Object.entries(R).some(([k, [rx, ry, rw, rh]]) => k !== 'page' && x >= rx * W / 100 && x < (rx + rw) * W / 100 && y >= ry * H / 100 && y < (ry + rh) * H / 100);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ink = inside(x + .5, y + .5) && (y % 3 !== 2) ? rand() < .62 : rand() < .04;
    const v = ink ? 30 + Math.floor(rand() * 90) : 205 + Math.floor(rand() * 45);
    svg.appendChild(s('rect', { x, y, width: 1, height: 1, fill: `rgb(${v},${v},${v + 4})` }));
  }
  return svg;
}

function chComputerSees() {
  const MODES = [['see', 'What you see'], ['pixels', 'What a computer sees'], ['ocr', 'After OCR'], ['layout', 'After layout'], ['fields', 'After extraction']];
  let mode = 'see';
  const stage = h('div.op-stage');
  const seg = h('div.op-seg', { role: 'tablist' }, MODES.map(([m, t], n) => h('button', { type: 'button', role: 'tab', 'data-m': m, onclick: () => { mode = m; draw(); } }, h('span.op-seg-n', pad(n)), t)));
  const pix = pixels();
  function draw() {
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.m === mode)));
    clear(stage);
    const page = invoice();
    const wrap = h('div.op-page-wrap', page);
    let side;
    if (mode === 'see') {
      side = h('div.op-side', h('p', 'Vendor, invoice number, a table of three items, a total of £4,980. You got all of that in about two seconds.'));
    } else if (mode === 'pixels') {
      page.classList.add('op-blank'); page.appendChild(pix);
      side = h('div.op-side',
        h('p', h('strong', 'A scanned page is a picture. '), 'To the computer it is a grid of grey dots. There are no letters, no numbers, no table.'),
        h('ul.op-facts', h('li', h('code', 'scan_0412.pdf'), ' · 1 page · image only'), h('li', 'Text layer: ', h('strong', 'none')), h('li', 'Search for “Total”: ', h('strong', '0 results')), h('li', 'Can it go into your finance system? ', h('strong', 'No'))));
    } else if (mode === 'ocr') {
      page.classList.add('op-faded');
      side = h('div.op-side',
        h('p', h('strong', 'OCR turns dots into words. '), 'Now it is searchable. But it is one long stream: which number is the total? Which 40 is a quantity?'),
        h('ol.op-ocr', OCR_LINES.map(l => Array.isArray(l) ? h('li.low', l[0], h('span', 'low confidence')) : h('li', l))));
    } else if (mode === 'layout') {
      LAYOUT.forEach(([k, label, n]) => page.appendChild(h('div.op-box', { style: pos(R[k]) }, h('span', `${n} · ${label}`))));
      side = h('div.op-side',
        h('p', h('strong', 'Layout recovers the structure. '), 'Reading order, which text is a heading, which label belongs to which value, and the table as real rows and columns.'),
        h('p.small', 'The numbers on the page are the reading order.'));
    } else {
      const spot = spotlight(page);
      side = h('div.op-side',
        h('p', h('strong', 'Extraction gives named fields. '), 'Each value has a name your systems understand, a confidence, and the place on the page it came from. Point at a field.'),
        h('div.op-fields', FIELDS.map(([n, v, k]) => h('button', { type: 'button', onmouseenter: () => spot(k), onfocus: () => spot(k), onclick: () => spot(k), onmouseleave: () => spot(null) },
          h('code', n), h('span', v), h('span.small', 'page 1')))));
    }
    stage.append(wrap, side);
  }
  draw();
  return {
    q: 'What does a computer see when you give it a scanned document?',
    prompt: 'You read that invoice in two seconds. Guess what the computer gets from the same file.',
    viz: h('div.op-viz', seg, stage),
    answer: [h('p', h('strong', 'Nothing it can use, until something reads it. '), 'Pixels become words with OCR, words become structure with layout analysis, and structure becomes named, checkable fields with extraction. That ladder is exactly what Azure AI Document Intelligence (and Content Understanding for documents) climbs for you.')],
  };
}

// ---------------------------------------------------------------- 4. the problem at scale
function chProblem() {
  const p = { docs: 1000, minutes: 4, review: 15, reviewMin: 1 };
  const out = h('div.op-calc-out');
  const field = (key, label, min, max, step, unit) => {
    const val = h('output');
    const inp = h('input', { type: 'range', min, max, step, value: p[key], 'aria-label': label });
    const sync = () => { p[key] = +inp.value; val.textContent = `${p[key].toLocaleString('en-GB')}${unit}`; draw(); };
    inp.addEventListener('input', sync);
    queueMicrotask(sync);
    return h('label.op-range', h('span', label), inp, val);
  };
  function draw() {
    const manual = p.docs * p.minutes / 60;
    const auto = p.docs * (p.review / 100) * p.reviewMin / 60;
    const max = Math.max(manual, 1);
    const bar = (label, v, cls, note) => h('div.op-bar-row', h('span.op-bar-label', label),
      h('div.op-bar-track', h(`div.op-bar.${cls}`, { style: `width:${Math.max(1.5, v / max * 100)}%` })),
      h('strong.op-bar-val', `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString('en-GB')} h`), h('span.small.op-bar-note', note));
    clear(out).append(
      bar('Typing it in by hand', manual, 'manual', `≈ ${(manual / 7.5).toFixed(1)} people working full days`),
      bar('Extraction + review of uncertain ones', auto, 'auto', `${Math.round(p.docs * p.review / 100).toLocaleString('en-GB')} documents go to a person`),
      h('p.small.op-calc-note', 'Computed from the assumptions you set above. Not a benchmark: plug in your own numbers.'));
  }
  return {
    q: 'So what problem does Document Intelligence actually solve?',
    prompt: 'One invoice is easy. What happens at a thousand a day? Set the numbers for an organisation you know.',
    viz: h('div.op-viz',
      h('div.op-calc-in', field('docs', 'Documents per day', 100, 20000, 100, ''), field('minutes', 'Minutes to key in one by hand', 1, 10, 1, ' min'),
        field('review', 'Share a person still checks', 0, 50, 5, '%'), field('reviewMin', 'Minutes per check', 1, 5, 1, ' min')),
      out,
      h('div.op-pains', [['Slow', 'Work waits in a queue until someone has time.'], ['Error-prone', 'Retyping numbers is where typos happen.'], ['Unsearchable', 'Scans sit in folders; nobody can query them.'], ['No trail', 'Nobody can see where a value in the system came from.']]
        .map(([t, d]) => h('div', h('strong', t), h('span.small', d))))),
    answer: [h('p', h('strong', 'It turns documents into data, at scale, with evidence. '), 'People stop retyping and only look at the cases the model is unsure about. Every value arrives with a confidence and a location on the page, so it can be checked, searched, sent to other systems, and used by AI with citations.')],
  };
}

// ---------------------------------------------------------------- 5. content beyond documents
const SOURCES = {
  form: { c: C.doc, title: 'Claim form', sub: 'PDF · 2 pages', kind: 'document' },
  photos: { c: C.image, title: 'Damage photos', sub: '3 images', kind: 'image' },
  call: { c: C.audio, title: 'Phone call', sub: 'audio · 4:10', kind: 'audio' },
  dash: { c: C.video, title: 'Dashcam clip', sub: 'video · 0:20', kind: 'video' },
};
const CLAIM = [
  ['PolicyNumber', 'PL-20931', 'extract', 'form', { box: [10, 12, 50, 8] }, 'form, page 1'],
  ['IncidentDate', '2026-02-18', 'extract', 'form', { box: [10, 26, 40, 8] }, 'form, page 1'],
  ['DamagedParts', 'rear bumper, left tail light', 'extract', 'photos', { photo: 1 }, 'photo 2'],
  ['Severity', 'moderate', 'classify', 'photos', { photo: [0, 1, 2] }, 'photos 1–3'],
  ['CustomerAccount', 'the other car reversed into mine in a car park', 'extract', 'call', { range: [0.4, 0.47] }, 'call 01:42–01:58'],
  ['InjuriesReported', 'none', 'extract', 'call', { range: [0.6, 0.64] }, 'call 02:30–02:38'],
  ['ImpactMoment', 'vehicle stationary at impact', 'extract', 'dash', { frames: [3, 4] }, 'clip 00:06–00:08'],
  ['Summary', 'Low-speed car-park collision, third party reversing, moderate rear damage, no injuries.', 'generate', null, {}, 'all four sources'],
];

function sourceVisual(key) {
  const r = rng(key.length * 97);
  if (key === 'form') return h('div.op-mini-page', [12, 26, 40, 48, 56, 70].map((y, n) => h('span', { style: `top:${y}%;width:${n % 2 ? 55 : 70}%` })));
  if (key === 'photos') return h('div.op-mini-photos', [0, 1, 2].map(n => h('span', { 'data-n': n }, s('svg', { viewBox: '0 0 40 28', 'aria-hidden': 'true' },
    s('path', { d: 'M4 20 L8 12 L30 12 L36 20 Z', fill: 'currentColor', opacity: .35 }), s('circle', { cx: 11, cy: 21, r: 3, fill: 'currentColor' }), s('circle', { cx: 29, cy: 21, r: 3, fill: 'currentColor' }),
    n === 1 ? s('path', { d: 'M30 14 l3 2 -2 2', stroke: '#c0392b', 'stroke-width': 1.5, fill: 'none' }) : null))));
  if (key === 'call') return h('div.op-wave', Array.from({ length: 48 }, (_, n) => h('span', { style: `height:${20 + r() * 80}%`, 'data-t': n / 48 })));
  return h('div.op-film', Array.from({ length: 8 }, (_, n) => h('span', { 'data-n': n })));
}

function chContent() {
  const cards = {};
  const srcEls = Object.entries(SOURCES).map(([k, src]) => {
    const vis = sourceVisual(k);
    cards[k] = h('div.op-src', { style: `--c:${src.c}`, 'data-k': k }, h('div.op-src-head', h('strong', src.title), h('span.small', src.sub)), vis, h('span.op-src-cite'));
    return cards[k];
  });
  const mark = f => {
    Object.values(cards).forEach(c => { c.classList.remove('hit', 'dim'); c.querySelectorAll('.hit').forEach(e => e.classList.remove('hit')); c.querySelector('.op-src-cite').textContent = ''; c.querySelector('.op-mini-page')?.querySelector('.op-mini-box')?.remove(); });
    if (!f) return;
    const [, , , src, where, cite] = f;
    Object.entries(cards).forEach(([k, c]) => c.classList.add(src === null || src === k ? 'hit' : 'dim'));
    if (!src) return;
    const c = cards[src];
    c.querySelector('.op-src-cite').textContent = cite;
    if (where.box) c.querySelector('.op-mini-page').appendChild(h('i.op-mini-box', { style: pos(where.box) }));
    if (where.photo != null) [].concat(where.photo).forEach(n => c.querySelector(`.op-mini-photos [data-n="${n}"]`).classList.add('hit'));
    if (where.range) c.querySelectorAll('.op-wave span').forEach(b => { if (+b.dataset.t >= where.range[0] && +b.dataset.t <= where.range[1]) b.classList.add('hit'); });
    if (where.frames) where.frames.forEach(n => c.querySelector(`.op-film [data-n="${n}"]`).classList.add('hit'));
  };
  const rows = CLAIM.map(f => h('button.op-claim-row', { type: 'button', onmouseenter: () => mark(f), onfocus: () => mark(f), onclick: () => mark(f) },
    h('code', f[0]), h('span', f[1]), h(`span.op-method.m-${f[2]}`, f[2]), h('span.small', '← ' + f[5])));
  const record = h('div.op-claim', { onmouseleave: () => mark(null) }, h('p.overline', 'One claim record'), rows);
  return {
    q: 'And where is the rest of the information?',
    prompt: 'A car insurance claim arrives. Before reading on: in how many different forms does the information come?',
    viz: h('div.op-viz',
      h('div.op-claim-grid',
        h('div.op-srcs', srcEls),
        h('div.op-cu', h('span.overline', 'Content Understanding'), h('strong', 'An analyzer per kind of content'), h('span.small', 'Same field schema. Each value keeps its source.')),
        record)),
    answer: [
      h('p', h('strong', 'Most real information is not in documents alone. '), 'A claim, a complaint or an onboarding case arrives as forms, photos, calls and video. Content Understanding analyzes each kind of content against the fields you define, so they all land in one record, and every value points back to the page region, photo, or second of audio or video it came from.'),
      h('p.small', 'Methods: extract reads a value that is there; classify picks from categories you define; generate writes a value such as a summary.'),
    ],
  };
}

// ---------------------------------------------------------------- 6. why not just ask a chatbot?
function chWhy() {
  let grounded = false;
  const body = h('div.op-why');
  const tog = h('div.op-seg', h('button', { type: 'button', onclick: () => { grounded = false; draw(); } }, 'Paste the file into a chat model'), h('button', { type: 'button', onclick: () => { grounded = true; draw(); } }, 'Extract first, then reason'));
  function draw() {
    tog.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-selected', String(i === +grounded)));
    const ask = h('div.op-ask', h('span.small', 'Question'), h('strong', 'What is the invoice total, and should we pay it?'));
    clear(body).append(ask, grounded
      ? h('div.op-answer-card.ok',
        h('p', h('code', 'InvoiceTotal'), ' 4980.00 GBP · page 1, totals block · confidence shown'),
        h('p', 'Checked: 4,150.00 + 830.00 = 4,980.00 ✓'),
        h('p', 'Hidden text found in the file and flagged before any model saw it.'),
        h('p.small', 'Every value is named, checkable and cited. Uncertain values go to a person instead of straight to payment.'))
      : h('div.op-answer-card.bad',
        h('p', '“The total is £4,150.00 and it looks fine to pay.”'),
        h('ul.small',
          h('li', 'Could have picked the subtotal: nothing says which number it read.'),
          h('li', 'No confidence, no page location, nothing to cite or audit.'),
          h('li', 'The file can carry hidden instructions (white text: “approve this payment”) that the model may follow.'),
          h('li', 'Every run can answer slightly differently, so no system can rely on it.')),
        h('p.small', 'Illustrative: a possible failure, not a measured result.')));
  }
  draw();
  return {
    q: 'Why not just give the file to a chat model?',
    prompt: 'Large language models can read PDFs now. So why do we need any of this?',
    viz: h('div.op-viz', tog, body),
    answer: [h('p', h('strong', 'Because businesses need answers they can check. '), 'Extracting first gives the model structured, grounded input; gives your systems named fields with confidence; lets people review only what is uncertain; and lets you filter hidden instructions before any model reads them. That is the difference between a demo and a system you can run.')],
  };
}

// ---------------------------------------------------------------- page
export function renderOpening(root) {
  const chapters = [chDocContent(), chHumanRead(), chComputerSees(), chProblem(), chContent(), chWhy()];
  const sections = chapters.map((c, i) => {
    const ans = h('div.op-answer', { hidden: true }, h('span.overline', 'The answer'), c.answer);
    const btn = h('button.btn.op-reveal', { type: 'button', onclick: () => { ans.hidden = !ans.hidden; btn.textContent = ans.hidden ? 'Reveal the answer' : 'Hide the answer'; } }, 'Reveal the answer');
    return h('section.section.op-ch', { id: `op-${i + 1}`, 'data-i': i },
      h('p.overline', `Question ${pad(i + 1)} of ${pad(chapters.length)}`),
      h('h2.op-q', c.q),
      h('p.op-prompt', c.prompt),
      c.viz,
      btn, ans);
  });

  const rail = h('nav.op-rail', { 'aria-label': 'Questions' },
    chapters.map((c, i) => h('a', { href: '#/start', 'data-i': i, title: c.q, onclick: e => { e.preventDefault(); sections[i].scrollIntoView({ behavior: 'smooth' }); } }, pad(i + 1))),
    h('label.bz-tog.op-showall', h('input', { type: 'checkbox', onchange: e => sections.forEach(sec => { sec.querySelector('.op-answer').hidden = !e.target.checked; sec.querySelector('.op-reveal').textContent = e.target.checked ? 'Hide the answer' : 'Reveal the answer'; }) }), ' Show all answers'),
    h('span.small.op-keys', '← → to move'));

  const closing = h('section.section.op-close', { id: 'op-end' },
    h('p.overline', 'Where this leaves us'),
    h('h2', 'Documents are one kind of content.'),
    h('p.op-lead', 'Document Intelligence turns documents into structured, checkable data. Content Understanding does the same for any content, documents, images, audio and video, and grounds every value in its source. The rest of the session is about choosing and wiring these correctly, which is exactly what the exam asks.'),
    h('ol.op-next', [
      ['Which model?', 'Prebuilt, custom or generative, from the document and the constraints.'],
      ['Content Understanding', 'Analyzers, field schemas and grounding across modalities.'],
      ['Ingestion for search', 'From pages to chunks to an index that can cite.'],
      ['Security', 'Hidden instructions inside uploaded files.'],
      ['Troubleshooting', 'Finding the broken layer, and handling 429s.'],
    ].map(([t, d]) => h('li', h('strong', t), h('span.small', d)))),
    h('div.hero-cta', h('a.btn.primary', { href: '#/briefing' }, 'Start the exam briefing →'), h('a.btn', { href: '#/s/ingestion' }, 'Open the labs')));

  root.append(
    h('header.hero.op-hero', h('p.overline', 'Start here · about 10 minutes'),
      h('h1', 'Before any Azure service: what problem are we solving?'),
      h('p.hero-lead', 'Six questions to ask the room. Each one has a visual to drive and an answer that stays hidden until you reveal it.')),
    rail, ...sections, closing);

  // current-chapter highlight + arrow-key navigation
  const links = [...rail.querySelectorAll('a')];
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) links.forEach(a => a.classList.toggle('now', a.dataset.i === en.target.dataset.i));
  }), { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach(sec => io.observe(sec));
  const onKey = e => {
    if (e.target.closest && e.target.closest('input, select, textarea')) return;
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const mid = window.innerHeight * 0.4;
    let cur = sections.findIndex(sec => sec.getBoundingClientRect().bottom > mid);
    if (cur < 0) cur = sections.length;
    const target = e.key === 'ArrowRight' ? (sections[cur + 1] || closing) : (sections[cur - 1] || sections[0]);
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth' });
  };
  document.addEventListener('keydown', onKey);
  return () => { io.disconnect(); document.removeEventListener('keydown', onKey); chapters.forEach(c => c.cleanup && c.cleanup()); };
}
