// Concept explainer: Structured field extraction.
// Same invoice as the lab's "Supplier invoice" sample (Contoso Supplies, INV-10442, total 288.00).

const INK = '#1b1d3a'; // text printed on the (always light) paper
const onPaper = el => { el.style.fill = INK; return el; };

// A readable invoice page, 300 × 420. Returns the group; key spans sit at fixed offsets
// so scenes can point at them (see REG below).
function invoice(k, x, y) {
  const g = k.s('g', { class: 'ex-page' });
  const t = (dx, dy, str, o = {}) => g.appendChild(onPaper(k.text(x + dx, y + dy, str, { size: 11, ...o })));
  const bar = (dx, dy, w) => g.appendChild(k.s('rect', { x: x + dx, y: y + dy, width: w, height: 6, rx: 3, class: 'ex-ink' }));
  g.appendChild(k.s('rect', { x, y, width: 300, height: 420, rx: 6, class: 'ex-paper' }));
  t(18, 36, 'CONTOSO SUPPLIES LTD', { size: 15, weight: 800 });
  t(282, 36, 'INVOICE', { size: 13, weight: 800, anchor: 'end' });
  bar(18, 46, 150);
  t(18, 76, 'Bill to', { weight: 700 }); bar(18, 84, 110); bar(18, 96, 130);
  t(160, 72, 'No: INV-10442'); t(160, 90, 'Date: 2026-09-14'); t(160, 108, 'Due: 2026-10-14');
  [0, 1, 2, 3].forEach(i => bar(18, 132 + i * 13, 264 * (0.62 + ((i * 37) % 40) / 100)));
  const tx = x + 18, ty = y + 192, tw = 264, rh = 20;
  g.appendChild(k.s('rect', { x: tx, y: ty, width: tw, height: rh * 5, class: 'ex-table' }));
  for (let r = 1; r < 5; r++) g.appendChild(k.s('line', { x1: tx, x2: tx + tw, y1: ty + r * rh, y2: ty + r * rh, class: 'ex-rule' }));
  for (const f of [0.55, 0.72, 0.86]) g.appendChild(k.s('line', { x1: tx + tw * f, x2: tx + tw * f, y1: ty, y2: ty + rh * 5, class: 'ex-rule' }));
  for (let r = 1; r < 5; r++) g.appendChild(k.s('rect', { x: tx + 8, y: ty + r * rh + 7, width: 70 + ((r * 31) % 50), height: 6, rx: 3, class: 'ex-ink' }));
  t(160, 322, 'Subtotal'); t(282, 322, '240.00', { anchor: 'end' });
  t(160, 340, 'VAT 20%'); t(282, 340, '48.00', { anchor: 'end' });
  t(160, 366, 'TOTAL DUE', { size: 13, weight: 800 }); t(282, 366, '288.00', { size: 13, weight: 800, anchor: 'end' });
  bar(18, 398, 170);
  return g;
}
// Evidence regions on that page (relative x, y, w, h).
const REG = { vendor: [12, 20, 196, 24], date: [154, 77, 124, 18], total: [154, 351, 136, 22] };

export default [
  {
    title: 'From a page of text to a few answers',
    caption: 'A document holds hundreds of words, but the business only needs a few answers from it: who sent it, how much, and when it is due. Field extraction pulls out exactly those.',
    notes: ['OCR and layout give you all the text and its structure; extraction turns that into named, typed values a system can use, for example a row in an ERP or a JSON record.'],
    dur: 7000,
    draw(g, k) {
      g.appendChild(k.a(invoice(k, 70, 50), 0, 'pop'));
      g.appendChild(k.a(k.arrow(400, 260, 520, 260), 0.5, 'draw'));
      g.appendChild(k.a(k.text(460, 244, 'extract', { size: 15, anchor: 'middle', cls: 'muted' }), 0.5));
      [['Who sent it?', 'Contoso Supplies Ltd'], ['How much?', 'GBP 288.00'], ['When is it due?', '2026-10-14']].forEach(([q, a], i) => {
        const y = 70 + i * 128;
        g.appendChild(k.a(k.box(545, y, 340, 104, { cls: 'ex-card', r: 14 }), 0.7 + i * 0.25, 'pop'));
        g.appendChild(k.a(k.text(569, y + 36, q, { size: 17, cls: 'muted' }), 0.8 + i * 0.25));
        g.appendChild(k.a(k.text(569, y + 78, a, { size: 28, weight: 800 }), 1.6 + i * 0.3, 'slide'));
      });
    },
  },
  {
    title: 'A schema says what you want',
    caption: 'You describe the answers you want as a schema: a name, a type and whether the field is required. Each field also says how to get it: extract it, classify it, or generate it.',
    notes: ['In Content Understanding the schema is the analyzer’s field schema, with a method of extract, classify or generate per field. Document Intelligence prebuilt-invoice has a fixed field set (VendorName, InvoiceDate, InvoiceTotal, …), so you map to it rather than define it.', 'With an LLM, the same schema becomes a strict JSON schema response format (structured outputs).'],
    dur: 8000,
    draw(g, k) {
      g.appendChild(k.a(k.box(50, 40, 520, 400, { cls: 'ex-card', r: 16 }), 0, 'pop'));
      g.appendChild(k.a(k.text(76, 84, 'Invoice schema', { size: 22, weight: 800 }), 0.1));
      const rows = [['VendorName', 'string', true, 'extract'], ['InvoiceDate', 'date', true, 'extract'], ['InvoiceTotal', 'number', true, 'extract'], ['Category', 'enum', false, 'classify'], ['Summary', 'string', false, 'generate']];
      const toneOf = { string: 'info', number: 'info', date: 'info', enum: 'info' };
      rows.forEach(([name, type, req, method], i) => {
        const y = 140 + i * 66;
        const row = k.s('g');
        if (i) row.appendChild(k.s('line', { x1: 76, x2: 544, y1: y - 36, y2: y - 36, class: 'ex-rule' }));
        row.appendChild(k.text(76, y, name, { size: 18, weight: 700, cls: 'mono' }));
        row.appendChild(k.chip(250, y, type, { tone: toneOf[type], size: 14 }));
        if (req) row.appendChild(k.chip(340, y, 'required', { tone: 'warn', size: 14 }));
        row.appendChild(k.text(544, y, method, { size: 16, weight: 700, anchor: 'end', cls: 'muted' }));
        g.appendChild(k.a(row, 0.4 + i * 0.22, 'slide'));
      });
      [['extract', 'copy what is printed'], ['classify', 'pick one from a list'], ['generate', 'write it from the whole doc']].forEach(([m, d], i) => {
        const y = 80 + i * 130;
        g.appendChild(k.a(k.box(610, y, 300, 104, { r: 14 }), 1.7 + i * 0.25, 'pop'));
        g.appendChild(k.a(k.text(634, y + 42, m, { size: 22, weight: 800 }), 1.8 + i * 0.25));
        g.appendChild(k.a(k.text(634, y + 76, d, { size: 16, cls: 'muted' }), 1.8 + i * 0.25));
      });
    },
  },
  {
    title: 'Every value points to its evidence',
    caption: 'A good extraction does not just return “288.00” — it says where on the page that value was found. A reviewer can check it in one glance.',
    notes: ['Document Intelligence returns each field with its value, a confidence and boundingRegions (page number plus polygon), and spans into the extracted text. Content Understanding can return grounding for extracted fields too.', 'A plain LLM answer has no built-in grounding: you would have to ask for, and verify, the source yourself.'],
    dur: 7500,
    draw(g, k) {
      const px = 70, py = 50;
      g.appendChild(invoice(k, px, py));
      const cards = [['VendorName', 'Contoso Supplies Ltd', 'vendor', 56], ['InvoiceDate', '2026-09-14', 'date', 196], ['InvoiceTotal', '288.00', 'total', 336]];
      cards.forEach(([name, val, reg, cy], i) => {
        const [rx, ry, rw, rh] = REG[reg];
        const d = 0.3 + i * 0.6;
        g.appendChild(k.a(k.s('rect', { x: px + rx, y: py + ry, width: rw, height: rh, rx: 5, class: 'ex-region' }), d, 'pop'));
        const card = k.s('g');
        card.appendChild(k.box(560, cy, 330, 96, { cls: 'ex-card', r: 14 }));
        card.appendChild(k.text(584, cy + 34, name, { size: 15, cls: 'muted mono' }));
        card.appendChild(k.text(584, cy + 74, val, { size: 26, weight: 800 }));
        g.appendChild(k.a(card, d + 0.15, 'pop'));
        const arrow = reg === 'vendor' ? k.arrow(552, cy + 34, px + rx + rw - 40, py + ry - 6, { curve: 46 })
          : k.arrow(552, cy + 48, px + rx + rw + 8, py + ry + rh / 2, { curve: i === 1 ? 0 : -24 });
        g.appendChild(k.a(arrow, d + 0.35, 'draw'));
      });
      g.appendChild(k.a(k.chip(600, 476, 'page 1 · polygon on the page', { tone: 'info', size: 14 }), 2.4, 'pop'));
    },
  },
  {
    title: 'Confidence decides who checks it',
    caption: 'Each value comes with a confidence score. Above your threshold it is accepted automatically; below it, a person checks it.',
    notes: ['Document Intelligence and Content Understanding report a per-field confidence (0–1). LLM structured outputs do not give a per-field confidence, so you need other signals (rules, grounding checks) there.', 'You pick the threshold: higher means more human review but fewer wrong values getting through.'],
    dur: 7500,
    draw(g, k) {
      const rows = [['VendorName', 0.97], ['InvoiceDate', 0.95], ['InvoiceTotal', 0.93], ['DueDate', 0.62], ['PO number', 0.71]];
      rows.forEach(([name, c], i) => {
        const y = 124 + i * 72, ok = c >= 0.8, d = 0.2 + i * 0.3;
        const row = k.s('g');
        row.appendChild(k.text(250, y + 13, name, { size: 18, weight: 700, anchor: 'end', cls: 'mono' }));
        row.appendChild(k.bar(275, y, 360, c, { tone: ok ? 'ok' : 'warn', threshold: 0.8, d }));
        g.appendChild(k.a(row, d));
        g.appendChild(k.a(k.chip(730, y + 14, ok ? '✓ auto-accept' : '👤 human review', { tone: ok ? 'ok' : 'warn', size: 15 }), d + 0.8, 'pop'));
      });
      g.appendChild(k.a(k.text(275 + 360 * 0.8, 92, 'threshold 0.80', { size: 15, weight: 700, anchor: 'middle', cls: 'muted' }), 0.1));
    },
  },
  {
    title: 'Rules catch what confidence can’t',
    caption: 'Every value here is read confidently, yet together they are wrong: 240 + 48 is not 298. Simple business rules — sums and types — catch mistakes a confidence score never will.',
    notes: ['Typical checks: subtotal + tax = total (within rounding), dates parse and are plausible (due date after invoice date), required fields present, values match the declared type.', 'A failed rule sends the field to review even when its confidence is above the threshold.'],
    dur: 8000,
    draw(root, k) {
      const g = k.s('g', { transform: 'translate(0,22)' });
      root.appendChild(g);
      const cards = [['SubTotal', '240.00', 0.97, 80], ['TotalTax', '48.00', 0.96, 370], ['InvoiceTotal', '298.00', 0.98, 660]];
      cards.forEach(([name, val, c, x], i) => {
        const card = k.s('g');
        card.appendChild(k.box(x, 40, 220, 124, { cls: 'ex-card', r: 14 }));
        card.appendChild(k.text(x + 20, 72, name, { size: 15, cls: 'muted mono' }));
        card.appendChild(k.text(x + 20, 116, val, { size: 32, weight: 800 }));
        card.appendChild(k.chip(x + 20, 150, `conf ${c.toFixed(2)}`, { tone: 'ok', size: 12 }));
        g.appendChild(k.a(card, i * 0.2, 'pop'));
      });
      g.appendChild(k.a(k.text(335, 114, '+', { size: 38, weight: 800, anchor: 'middle' }), 0.3));
      g.appendChild(k.a(k.text(625, 114, '=', { size: 38, weight: 800, anchor: 'middle' }), 0.5));
      // the rule fails
      g.appendChild(k.a(k.s('line', { x1: 610, y1: 120, x2: 640, y2: 92, style: 'stroke:#ef4444;stroke-width:4;stroke-linecap:round' }), 1.2, 'pop'));
      g.appendChild(k.a(k.s('rect', { x: 656, y: 36, width: 228, height: 132, rx: 17, style: 'fill:none;stroke:#ef4444;stroke-width:3.5' }), 1.2, 'pop'));
      g.appendChild(k.a(k.chip(312, 222, '✗ 240.00 + 48.00 = 288.00, not 298.00', { tone: 'error', size: 17 }), 1.4, 'pop'));
      g.appendChild(k.a(k.s('line', { x1: 80, x2: 880, y1: 276, y2: 276, class: 'ex-rule' }), 1.8));
      // type check
      const due = k.s('g');
      due.appendChild(k.box(80, 316, 260, 124, { cls: 'ex-card', r: 14 }));
      due.appendChild(k.text(100, 348, 'DueDate · date', { size: 15, cls: 'muted mono' }));
      due.appendChild(k.text(100, 392, '“TBC”', { size: 32, weight: 800 }));
      due.appendChild(k.chip(100, 426, 'conf 0.91', { tone: 'ok', size: 12 }));
      g.appendChild(k.a(due, 2.0, 'pop'));
      g.appendChild(k.a(k.arrow(355, 378, 450, 378), 2.3, 'draw'));
      g.appendChild(k.a(k.chip(468, 384, '✗ “TBC” is not a date', { tone: 'error', size: 19 }), 2.5, 'pop'));
    },
  },
  {
    title: 'People close the loop',
    caption: 'Only the flagged fields go to a review queue. A person checks them against the page, fixes or approves them, and the complete record flows on to the ERP or database.',
    notes: ['Clean fields are kept as they are, so the reviewer only looks at what was flagged. Documents with no flags go straight through (straight-through processing).', 'Corrections are worth keeping: they show which fields, rules or thresholds need tuning (and can become labelled examples for a custom model).'],
    dur: 8000,
    draw(g, k) {
      // reviewer
      const person = k.s('g');
      person.append(k.s('circle', { cx: 80, cy: 200, r: 22, style: 'fill:var(--topic)' }),
        k.s('path', { d: 'M44,268 Q44,232 80,232 Q116,232 116,268 Z', style: 'fill:var(--topic)' }),
        k.text(80, 296, 'Reviewer', { size: 15, weight: 700, anchor: 'middle' }));
      g.appendChild(k.a(person, 0, 'pop'));
      // queue
      g.appendChild(k.a(k.box(140, 80, 330, 330, { cls: 'ex-card', r: 16 }), 0.2, 'pop'));
      g.appendChild(k.a(k.text(164, 120, 'Review queue', { size: 20, weight: 800 }), 0.3));
      [['DueDate', 'TBC', '2026-10-14'], ['InvoiceTotal', '298.00', '288.00']].forEach(([name, bad, good], i) => {
        const y = 146 + i * 100;
        const row = k.s('g');
        row.appendChild(k.text(164, y + 20, name, { size: 15, cls: 'muted mono' }));
        const old = k.text(164, y + 60, bad, { size: 22, weight: 700 });
        old.style.fill = '#ef4444'; old.style.textDecoration = 'line-through';
        row.appendChild(old);
        g.appendChild(k.a(row, 0.5 + i * 0.25));
        g.appendChild(k.a(k.text(280, y + 60, '→', { size: 22, weight: 700, anchor: 'middle', cls: 'muted' }), 1.0 + i * 0.3));
        const fixed = k.text(306, y + 60, good, { size: 22, weight: 800 });
        fixed.style.fill = '#10b981';
        g.appendChild(k.a(fixed, 1.1 + i * 0.3, 'slide'));
      });
      g.appendChild(k.a(k.chip(164, 386, '✓ approve', { tone: 'ok', size: 15 }), 1.8, 'pop'));
      // record
      g.appendChild(k.a(k.arrow(482, 245, 548, 245), 2.0, 'draw'));
      g.appendChild(k.a(k.box(560, 80, 200, 330, { cls: 'ex-card', r: 16 }), 2.1, 'pop'));
      g.appendChild(k.a(k.text(580, 120, 'Record', { size: 20, weight: 800 }), 2.15));
      ['Vendor', 'Date', 'Due date', 'Total'].forEach((f, i) => g.appendChild(k.a(k.text(580, 168 + i * 44, `✓ ${f}`, { size: 17, weight: 600 }), 2.2 + i * 0.08)));
      g.appendChild(k.a(k.chip(580, 386, 'complete', { tone: 'ok', size: 15 }), 2.5, 'pop'));
      // ERP / database
      g.appendChild(k.a(k.arrow(772, 245, 818, 245), 2.6, 'draw'));
      const db = k.s('g');
      db.append(k.s('path', { d: 'M830,200 L830,290 A45,14 0 0 0 920,290 L920,200', style: 'fill:color-mix(in srgb, var(--topic-2) 22%, var(--surface));stroke:var(--topic-2);stroke-width:2' }),
        k.s('ellipse', { cx: 875, cy: 200, rx: 45, ry: 14, style: 'fill:color-mix(in srgb, var(--topic-2) 35%, var(--surface));stroke:var(--topic-2);stroke-width:2' }),
        k.text(875, 258, 'ERP', { size: 20, weight: 800, anchor: 'middle' }),
        k.text(875, 326, 'database', { size: 14, anchor: 'middle', cls: 'muted' }));
      g.appendChild(k.a(db, 2.7, 'pop'));
    },
  },
];
