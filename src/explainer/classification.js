// Concept explainer: Document classification and routing.
// Scores, thresholds and margins below are illustrative, not output from a real model.

const INK = '#1b1d3a'; // text drawn on paper (paper stays light in dark mode)

// A small document with its name under it.
function doc(k, x, y, w, h, label, { size = 15, lines } = {}) {
  const g = k.s('g');
  g.appendChild(k.page(x, y, w, h, { lines: lines ?? Math.max(1, Math.floor((h - 58) / 15)) }));
  if (label) g.appendChild(k.text(x + w / 2, y + h + 22, label, { size, weight: 700, anchor: 'middle' }));
  return g;
}
// A plain page with a big word printed on it (for "what kind of document is this?").
function titled(k, x, y, w, h, word, { size = 18, lines = 6 } = {}) {
  const g = k.s('g');
  g.appendChild(k.page(x, y, w, h, { title: false, lines: 0 }));
  const t = k.text(x + 16, y + 34, word, { size, weight: 800 });
  t.style.fill = INK; // CSS .ex-text would otherwise recolour it in dark mode
  g.appendChild(t);
  for (let i = 0; i < lines; i++) g.appendChild(k.s('rect', { x: x + 16, y: y + 52 + i * 15, width: (w - 32) * (0.55 + ((i * 37) % 40) / 100), height: 7, rx: 3, class: 'ex-ink' }));
  return g;
}
// A destination: rounded box with an icon + name.
function lane(k, x, y, w, h, label, { cls = 'ex-card', size = 17 } = {}) {
  const g = k.s('g');
  g.appendChild(k.box(x, y, w, h, { cls, r: 12 }));
  g.appendChild(k.text(x + 16, y + h / 2 + 6, label, { size, weight: 700 }));
  return g;
}
// Grey out a losing score bar.
function dim(bar) { const f = bar.querySelector('.ex-fill'); if (f) f.style.fill = '#a3a9b6'; return bar; }

export default [
  {
    title: 'One inbox, many kinds of document',
    caption: 'Invoices, receipts, contracts, IDs, purchase orders and letters all land in the same place. Each one belongs in a different system, so something has to sort them first.',
    notes: ['Typical sources are a shared mailbox, a scanner drop folder or an upload portal. The sorting step is document classification; sending each document on to the right system is routing.'],
    dur: 7500,
    draw(g, k) {
      g.appendChild(k.a(k.box(50, 50, 380, 420, { cls: 'ex-card', r: 18 }), 0, 'pop'));
      g.appendChild(k.a(k.text(240, 90, 'Inbox', { size: 22, weight: 800, anchor: 'middle' }), 0.1));
      const docs = ['Invoice', 'Receipt', 'Contract', 'ID card', 'Purchase order', 'Letter'];
      docs.forEach((d, i) => {
        const c = i % 3, r = Math.floor(i / 3);
        g.appendChild(k.a(doc(k, 78 + c * 116, 118 + r * 170, 92, 112, d, { size: 14 }), 0.3 + i * 0.15, 'pop'));
      });
      g.appendChild(k.a(k.s('circle', { cx: 520, cy: 260, r: 42, class: 'ex-card' }), 1.3, 'pop'));
      g.appendChild(k.a(k.text(520, 276, '?', { size: 46, weight: 800, anchor: 'middle' }), 1.35, 'pop'));
      g.appendChild(k.a(k.arrow(436, 260, 470, 260), 1.2, 'draw'));
      const dest = ['Accounts payable', 'Expenses', 'Legal', 'Identity checks', 'Purchasing', 'Triage'];
      dest.forEach((d, i) => {
        const y = 62 + i * 68;
        g.appendChild(k.a(k.arrow(566, 260, 650, y + 24, { curve: 0 }), 1.6 + i * 0.1, 'draw'));
        g.appendChild(k.a(lane(k, 660, y, 250, 48, d), 1.7 + i * 0.1, 'pop'));
      });
    },
  },
  {
    title: 'The classifier scores every category',
    caption: 'The classifier looks at the whole document and gives a score for each category it knows. The highest score is its best guess.',
    notes: ['In Azure, this is a Document Intelligence custom classification model (trained on a few labelled samples per document type) or a Content Understanding analyzer that classifies against categories you describe. Always include an “other” category so unfamiliar documents have somewhere to go.', 'Scores here are illustrative.'],
    dur: 7500,
    draw(g, k) {
      g.appendChild(k.a(doc(k, 70, 100, 210, 290, 'new document', { lines: 12 }), 0, 'pop'));
      g.appendChild(k.a(k.arrow(300, 245, 380, 245), 0.4, 'draw'));
      g.appendChild(k.a(k.text(340, 225, 'classify', { size: 15, anchor: 'middle', cls: 'muted' }), 0.4));
      const rows = [['Invoice', 0.94], ['Purchase order', 0.41], ['Credit note', 0.33], ['Receipt', 0.18], ['Contract', 0.06], ['Other', 0.04]];
      rows.forEach(([c, v], i) => {
        const b = k.bar(560, 108 + i * 56, 290, v, { label: c, tone: 'ok', d: 0.6 + i * 0.18 });
        if (i) dim(b);
        g.appendChild(k.a(b, 0.5 + i * 0.18));
      });
      g.appendChild(k.a(k.box(392, 92, 520, 48, { cls: 'ex-region', r: 12 }), 2.0, 'pop'));
      g.appendChild(k.a(k.chip(700, 470, '✓ best guess: Invoice', { tone: 'ok', size: 18 }), 2.3, 'pop'));
    },
  },
  {
    title: 'Confident? Route it. Unsure? Ask a person.',
    caption: 'You choose a confidence threshold. Above the line, the document goes straight to its system. Below it, a person takes a look first.',
    notes: ['The threshold is a business choice: a higher line means fewer wrong routes but more manual work. Tune it on a labelled test set, not by guesswork. 0.80 is only an example.'],
    dur: 8000,
    draw(g, k) {
      const BX = 250, BW = 300, TX = BX + BW * 0.8;
      // threshold line spanning both rows
      g.appendChild(k.a(k.s('line', { x1: TX, x2: TX, y1: 70, y2: 450, class: 'ex-threshold', 'stroke-dasharray': '8 6' }), 0, 'in'));
      g.appendChild(k.a(k.chip(TX - 70, 60, 'threshold 0.80', { tone: 'info', size: 15 }), 0.1, 'pop'));
      // row 1: confident receipt
      g.appendChild(k.a(doc(k, 70, 105, 100, 120, 'Receipt', { size: 15 }), 0.4, 'pop'));
      g.appendChild(k.a(k.bar(BX, 160, BW, 0.93, { tone: 'ok', d: 0.7 }), 0.6));
      g.appendChild(k.a(k.arrow(620, 168, 680, 168), 1.5, 'draw'));
      g.appendChild(k.a(lane(k, 690, 140, 220, 56, '✓ Expenses', { cls: 'ex-word tone-ok' }), 1.7, 'pop'));
      // row 2: unsure contract
      g.appendChild(k.a(doc(k, 70, 285, 100, 120, 'Contract?', { size: 15 }), 1.0, 'pop'));
      g.appendChild(k.a(k.bar(BX, 340, BW, 0.58, { tone: 'warn', d: 1.3 }), 1.2));
      g.appendChild(k.a(k.arrow(620, 348, 680, 348), 2.1, 'draw'));
      g.appendChild(k.a(lane(k, 690, 320, 220, 56, 'Human review', { cls: 'ex-word tone-warn' }), 2.3, 'pop'));
    },
  },
  {
    title: 'Look-alikes need a clear winner',
    caption: 'A credit note looks almost exactly like an invoice. When the top two scores are close, a small margin sends it to review instead of risking a costly mistake.',
    notes: ['Besides the threshold, check the margin between the top score and the runner-up (here 0.81 − 0.76 = 0.05, below an example minimum of 0.15). A credit note routed as an invoice can mean paying a supplier instead of being refunded.'],
    dur: 8500,
    draw(g, k) {
      g.appendChild(k.a(titled(k, 60, 80, 200, 250, 'CREDIT NOTE', { lines: 9 }), 0, 'pop'));
      g.appendChild(k.a(k.text(160, 362, 'looks like an invoice', { size: 15, anchor: 'middle', cls: 'muted' }), 0.2));
      const BX = 470, BW = 380;
      g.appendChild(k.a(k.bar(BX, 125, BW, 0.81, { label: 'Invoice', tone: 'warn', d: 0.5 }), 0.4));
      g.appendChild(k.a(k.bar(BX, 190, BW, 0.76, { label: 'Credit note', tone: 'warn', d: 0.7 }), 0.6));
      // margin band between the two scores
      const x1 = BX + BW * 0.76, x2 = BX + BW * 0.81;
      g.appendChild(k.a(k.s('rect', { x: x1, y: 111, width: x2 - x1, height: 111, rx: 3, class: 'ex-region' }), 1.5, 'pop'));
      g.appendChild(k.a(k.chip(x1 - 48, 258, 'margin only 0.05', { tone: 'warn', size: 15 }), 1.7, 'pop'));
      // two outcomes
      const bad = k.s('g');
      bad.append(k.box(300, 320, 290, 130, { cls: 'ex-word tone-error', r: 14 }),
        k.text(445, 362, '✗ Guess “invoice”', { size: 19, weight: 800, anchor: 'middle' }),
        k.text(445, 392, 'AP pays it as a bill', { size: 16, anchor: 'middle' }),
        k.text(445, 420, '→ money paid twice', { size: 16, weight: 700, anchor: 'middle' }));
      g.appendChild(k.a(bad, 2.1, 'pop'));
      const good = k.s('g');
      good.append(k.box(620, 320, 290, 130, { cls: 'ex-word tone-ok', r: 14 }),
        k.text(765, 362, '✓ Too close to call', { size: 19, weight: 800, anchor: 'middle' }),
        k.text(765, 392, 'send to human review', { size: 16, anchor: 'middle' }),
        k.text(765, 420, '→ a person decides', { size: 16, weight: 700, anchor: 'middle' }));
      g.appendChild(k.a(good, 2.5, 'pop'));
    },
  },
  {
    title: 'One file can hold several documents',
    caption: 'A scanned PDF often contains more than one document. It is split first, so each part is classified and routed on its own.',
    notes: ['Document Intelligence custom classifiers can split a multi-page file and return each detected document with its page range (splitMode, approximate naming). Content Understanding offers a similar split-and-classify option. Without splitting, the delivery note on page 3 would travel with the invoice and never reach Purchasing.'],
    dur: 8000,
    draw(g, k) {
      // stacked 3-page PDF
      const pdf = k.s('g');
      pdf.append(k.page(108, 96, 180, 240, { lines: 0, title: false }), k.page(94, 110, 180, 240, { lines: 0, title: false }), k.page(80, 124, 180, 240, { lines: 9 }));
      g.appendChild(k.a(pdf, 0, 'pop'));
      g.appendChild(k.a(k.text(184, 400, 'scan_0912.pdf · 3 pages', { size: 16, weight: 700, anchor: 'middle' }), 0.2));
      g.appendChild(k.a(k.arrow(320, 240, 420, 240), 0.6, 'draw'));
      g.appendChild(k.a(k.text(370, 222, 'split', { size: 15, anchor: 'middle', cls: 'muted' }), 0.6));
      // part 1: invoice, pages 1–2
      const inv = k.s('g');
      inv.append(k.page(462, 60, 140, 170, { lines: 0, title: false }), titled(k, 450, 72, 140, 170, 'INVOICE', { size: 16, lines: 6 }));
      g.appendChild(k.a(inv, 1.0, 'slide'));
      g.appendChild(k.a(k.text(670, 140, 'pages 1–2', { size: 15, cls: 'muted' }), 1.2));
      g.appendChild(k.a(k.chip(670, 172, 'Invoice → Payables', { tone: 'ok', size: 16 }), 1.6, 'pop'));
      // part 2: delivery note, page 3
      g.appendChild(k.a(titled(k, 450, 290, 140, 170, 'DELIVERY NOTE', { size: 14, lines: 6 }), 1.3, 'slide'));
      g.appendChild(k.a(k.text(670, 362, 'page 3', { size: 15, cls: 'muted' }), 1.5));
      g.appendChild(k.a(k.chip(670, 394, 'Delivery note → Purchasing', { tone: 'ok', size: 16 }), 1.9, 'pop'));
      g.appendChild(k.a(k.s('line', { x1: 430, x2: 920, y1: 262, y2: 262, class: 'ex-leader', 'stroke-dasharray': '8 6' }), 0.9, 'in'));
    },
  },
  {
    title: 'Routing — and what happens when a system is down',
    caption: 'Each document goes into its lane. If a destination is down, the message is retried and then parked in a dead-letter queue, so it is never lost.',
    notes: ['A common pattern is one Azure Service Bus queue or topic subscription per destination. After the maximum delivery count (10 by default) a message moves to the dead-letter queue, where it waits until someone fixes the problem and resubmits it.'],
    dur: 9000,
    draw(g, k) {
      g.appendChild(k.a(lane(k, 40, 226, 150, 60, 'Classifier', { size: 18 }), 0, 'pop'));
      const lanes = ['Payables', 'Expenses', 'Legal', 'KYC', 'Review', 'Unknown'];
      lanes.forEach((l, i) => {
        const y = 52 + i * 70;
        g.appendChild(k.a(k.arrow(196, 256, 266, y + 24), 0.3 + i * 0.1, 'draw'));
        g.appendChild(k.a(lane(k, 276, y, 170, 48, l, { cls: i === 0 ? 'ex-card' : 'ex-box', size: 16 }), 0.4 + i * 0.1, 'pop'));
      });
      // Payables → ERP is down
      g.appendChild(k.a(k.arrow(452, 76, 600, 76), 1.3, 'draw'));
      g.appendChild(k.a(lane(k, 610, 50, 180, 52, 'ERP', { cls: 'ex-word tone-error' }), 1.4, 'pop'));
      g.appendChild(k.a(k.chip(712, 82, 'down', { tone: 'error', size: 14 }), 1.6, 'pop'));
      // retries: each delivery attempt fails
      [0, 1, 2].forEach(n => g.appendChild(k.a(k.chip(466 + n * 90, 140, `✗ try ${n + 1}`, { tone: 'error', size: 13 }), 1.7 + n * 0.25, 'pop')));
      g.appendChild(k.a(k.text(599, 186, 'retries fail', { size: 15, anchor: 'middle', cls: 'muted' }), 2.3));
      // dead-letter queue
      g.appendChild(k.a(k.arrow(770, 108, 770, 300), 2.3, 'draw'));
      g.appendChild(k.a(lane(k, 580, 310, 330, 64, 'Dead-letter queue', { cls: 'ex-word tone-warn', size: 19 }), 2.5, 'pop'));
      g.appendChild(k.a(k.chip(600, 420, 'kept safe · resubmit when ERP is back', { tone: 'ok', size: 15 }), 2.7, 'pop'));
    },
  },
];
