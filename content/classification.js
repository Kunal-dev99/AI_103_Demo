// Agenda topic: Document classification and routing.
// Lab: Classification & routing simulator. The workbench (src/workbenches/classification.js) draws result.view:
// an inbox of synthetic documents, per-class scores, threshold decisions, routing lanes and downstream delivery.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

// ---------- classes and destinations ----------
export const CLASSES = {
  invoice: { label: 'Invoice', lane: 'ap' },
  receipt: { label: 'Receipt', lane: 'expenses' },
  contract: { label: 'Contract', lane: 'legal' },
  id_document: { label: 'ID document', lane: 'kyc' },
  purchase_order: { label: 'Purchase order', lane: 'purchasing' },
  credit_note: { label: 'Credit note', lane: 'ap' },
  delivery_note: { label: 'Delivery note', lane: 'purchasing' },
  other: { label: 'Other / unknown', lane: 'unknown' },
};
const CORE = ['invoice', 'receipt', 'contract', 'id_document', 'purchase_order'];
const FULL = [...CORE, 'credit_note', 'delivery_note'];

const LANES = [
  { id: 'ap', short: 'Payables', label: 'Accounts payable', system: 'ERP · AP module', classes: ['invoice', 'credit_note'] },
  { id: 'expenses', label: 'Expenses', system: 'Expense app', classes: ['receipt'] },
  { id: 'legal', label: 'Legal', system: 'Contract management', classes: ['contract'] },
  { id: 'kyc', label: 'KYC', system: 'Identity checks', classes: ['id_document'] },
  { id: 'purchasing', label: 'Purchasing', system: 'Procurement', classes: ['purchase_order', 'delivery_note'] },
  { id: 'review', short: 'Review', label: 'Manual review', system: 'Human review queue', internal: true },
  { id: 'unknown', label: 'Unknown', system: 'Triage queue', internal: true },
  { id: 'dlq', short: 'Dead-letter', label: 'Dead-letter', system: 'Service Bus DLQ', internal: true },
];

// Keyword rules for the "keyword rules" approach (deliberately naive, English only).
const KEYWORDS = {
  invoice: ['invoice', 'amount due', 'due date', 'bill to', 'vat'],
  receipt: ['receipt', 'total', 'thank you', 'visa', 'tip'],
  contract: ['agreement', 'parties', 'term', 'governing law', 'hereby'],
  id_document: ['licence', 'passport', 'date of birth', 'expiry', 'nationality'],
  purchase_order: ['purchase order', 'po number', 'ship to', 'authorised by'],
  credit_note: ['credit note', 'credit', 'refund'],
  delivery_note: ['delivery note', 'received by', 'delivered', 'packages'],
};

// ---------- synthetic inbox (page units like A4 in mm; receipts and the ID card are smaller) ----------
// aff: how strongly the document resembles each class (stands in for learned visual + text features).
// fewShot: confusion a classifier trained on few samples shows (shrinks as samples grow).
const T = (x, y, size, text, role = 'text', extra = {}) => ({ id: `${x}-${y}`, role, x, y, size, text, ...extra });

const invoicePage = (co, addr, kind, no, ref, rows, total, foot, accent, de = false) => ({
  w: 210, h: 297, shapes: [{ kind: 'band', x: 0, y: 0, w: 210, h: 8, tone: accent }],
  items: [
    T(14, 26, 9, co, 'title'), T(14, 34, 4.2, addr, 'pageHeader'),
    T(128, 28, 12, kind, 'sectionHeading'),
    T(128, 40, 4.6, no), T(128, 47, 4.6, ref), T(128, 54, 4.6, de ? 'Datum: 12.09.2026' : 'Date: 2026-09-14'),
    T(14, 62, 5, de ? 'Rechnung an' : 'Bill to', 'sectionHeading'), T(14, 70, 4.6, de ? 'Fabrikam GmbH' : 'Fabrikam Retail plc'), T(14, 77, 4.6, de ? 'Am Hafen 12, 20457 Hamburg' : '12 Harbour Road, Hull HU1 2AA'),
    { id: 'tbl', role: 'table', x: 14, y: 92, colW: [86, 26, 32, 38], rowH: 11, rows },
    T(118, 92 + rows.length * 11 + 16, 6, total, 'sectionHeading'),
    T(14, 284, 4, foot, 'pageFooter'),
  ],
});

const FILES = [
  { id: 'inv1', file: 'INV-10442_contoso.pdf', truth: 'invoice', label: 'Supplier invoice (Contoso)', quality: 1,
    aff: { invoice: 0.95, credit_note: 0.55, purchase_order: 0.45, receipt: 0.3, delivery_note: 0.25, other: 0.1 },
    page: invoicePage('CONTOSO SUPPLIES LTD', '14 Mill Lane, Leeds LS1 4AB · VAT GB 123 4567 89', 'INVOICE', 'Invoice no: INV-10442', 'Due date: 2026-10-14',
      [['Description', 'Qty', 'Unit price', 'Amount'], ['Copy paper A4, 5 reams', '10', '4.50', '45.00'], ['Toner cartridge XL', '2', '90.00', '180.00'], ['Delivery', '1', '15.00', '15.00']],
      'AMOUNT DUE: GBP 288.00', 'Payment within 30 days · VAT 20% included', 'blue') },
  { id: 'inv2', file: 'adatum_inv_A7731.pdf', truth: 'invoice', label: 'Freight invoice (Adatum)', quality: 1,
    aff: { invoice: 0.92, purchase_order: 0.5, credit_note: 0.5, receipt: 0.35, delivery_note: 0.3, other: 0.1 },
    page: invoicePage('ADATUM LOGISTICS', 'Unit 4, Docks Road, Hull HU9 1TS · VAT GB 998 1122 33', 'INVOICE', 'Invoice no: A-7731', 'Due date: 2026-09-30',
      [['Service', 'Qty', 'Rate', 'Amount'], ['Pallet freight Leeds-Hull', '4', '240.00', '960.00'], ['Fuel surcharge', '1', '280.50', '280.50']],
      'AMOUNT DUE: USD 1,240.50', 'Bank: Woodgrove Bank · Sort 20-00-00', 'teal') },
  { id: 'rcp1', file: 'IMG_2041.jpg', truth: 'receipt', label: 'Cafe receipt (phone photo)', quality: 0.9,
    aff: { receipt: 0.93, invoice: 0.45, other: 0.15 },
    page: { w: 90, h: 180, shapes: [{ kind: 'zigzag', y: 180 }], items: [
      T(14, 22, 8, 'NORTHWIND CAFE', 'title'), T(22, 32, 4.6, 'RECEIPT  #0441'), T(14, 40, 4.2, '2026-10-02 08:41 Till 3', 'pageHeader'),
      T(10, 58, 5, 'Flat white      3.40'), T(10, 67, 5, 'Croissant       2.60'), T(10, 76, 5, 'Orange juice    2.95'),
      T(10, 94, 6.5, 'TOTAL   8.95', 'sectionHeading'), T(10, 106, 4.6, 'VISA ****4417 APPROVED'), T(22, 128, 4.6, 'Thank you!', 'pageFooter')] } },
  { id: 'rcp2', file: 'taxi_blurry.jpg', truth: 'receipt', label: 'Taxi receipt (blurry, dark photo)', quality: 0.4,
    aff: { receipt: 0.82, invoice: 0.55, other: 0.35 },
    page: { w: 90, h: 160, shapes: [{ kind: 'zigzag', y: 160 }], items: [
      T(16, 24, 8, 'CITY CABS', 'title'), T(16, 36, 4.6, 'Receipt no 5521'), T(10, 52, 5, 'Fare           23.40'), T(10, 62, 5, 'Tip             3.00'),
      T(10, 80, 6.5, 'TOTAL 26.40', 'sectionHeading'), T(10, 96, 4.4, 'Card ****0912'), T(18, 118, 4.4, 'Thank you', 'pageFooter')] } },
  { id: 'ctr1', file: 'MSA_Contoso_Fabrikam_signed.pdf', truth: 'contract', label: 'Master services agreement', quality: 1,
    aff: { contract: 0.95, other: 0.3, purchase_order: 0.15 },
    page: { w: 210, h: 297, shapes: [{ kind: 'paras', x: 14, y: 70, w: 182, lines: 22 }], items: [
      T(36, 28, 9, 'MASTER SERVICES AGREEMENT', 'title'),
      T(14, 44, 4.6, 'This Agreement is made between Contoso Ltd and Fabrikam'), T(14, 51, 4.6, 'Retail plc (together the Parties) on 1 September 2026.'),
      T(14, 62, 5, '1. Term', 'sectionHeading'), T(14, 168, 5, '12. Governing law', 'sectionHeading'), T(14, 176, 4.6, 'This Agreement is governed by the laws of England.'),
      T(14, 236, 4.6, 'Signed for Contoso'), T(112, 236, 4.6, 'Signed for Fabrikam'),
      T(16, 250, 8, 'J. Okafor', 'signature', { hand: true }), T(114, 250, 8, 'M. Lindqvist', 'signature', { hand: true })] } },
  { id: 'ctr2', file: 'NDA_Litware_2026.pdf', truth: 'contract', label: 'Mutual NDA', quality: 1,
    aff: { contract: 0.88, other: 0.42, id_document: 0.05 }, fewShot: { other: 0.1 },
    page: { w: 210, h: 297, shapes: [{ kind: 'paras', x: 14, y: 64, w: 182, lines: 26 }], items: [
      T(22, 28, 8.5, 'MUTUAL NON-DISCLOSURE AGREEMENT', 'title'),
      T(14, 44, 4.6, 'The parties hereby agree to keep Confidential Information'), T(14, 51, 4.6, 'secret for a term of three years.'),
      T(14, 214, 4.6, 'Signature'), T(14, 228, 8, 'R. Haddad', 'signature', { hand: true })] } },
  { id: 'id1', file: 'licence_scan.png', truth: 'id_document', label: 'Driving licence (scan)', quality: 0.95,
    aff: { id_document: 0.97, other: 0.2 },
    page: { w: 210, h: 132, shapes: [{ kind: 'card' }, { kind: 'photo', x: 12, y: 30, w: 52, h: 66 }], items: [
      T(72, 22, 9, 'DRIVING LICENCE', 'title'),
      T(72, 38, 5, '1. RUIZ DELGADO'), T(72, 48, 5, '2. ANA'), T(72, 58, 4.6, '3. Date of birth 07.03.1991'),
      T(72, 68, 4.6, '4b. Expiry 06.03.2031'), T(72, 78, 4.6, 'Nationality ESP'), T(72, 100, 7, 'A. Ruiz', 'signature', { hand: true })] } },
  { id: 'po1', file: 'PO-55810.pdf', truth: 'purchase_order', label: 'Purchase order', quality: 1,
    aff: { purchase_order: 0.92, invoice: 0.55, delivery_note: 0.45, credit_note: 0.2, other: 0.1 },
    page: { w: 210, h: 297, shapes: [{ kind: 'band', x: 0, y: 0, w: 210, h: 8, tone: 'green' }], items: [
      T(14, 26, 9, 'FABRIKAM RETAIL PLC', 'title'), T(110, 28, 10, 'PURCHASE ORDER', 'sectionHeading'),
      T(110, 40, 4.6, 'PO number: PO-55810'), T(110, 47, 4.6, 'Order date: 2026-09-01'),
      T(14, 62, 5, 'Ship to', 'sectionHeading'), T(14, 70, 4.6, 'Fabrikam DC, Leeds LS9 0AA'),
      { id: 'tbl', role: 'table', x: 14, y: 90, colW: [96, 26, 30, 30], rowH: 11, rows: [['Item', 'Qty', 'Price', 'Line'], ['Shelf unit 180cm', '12', '64.00', '768.00'], ['Wall brackets', '48', '2.10', '100.80']] },
      T(14, 250, 4.6, 'Authorised by: P. Nowak, Procurement')] } },
  { id: 'cn1', file: 'CN-2207_contoso.pdf', truth: 'credit_note', label: 'Credit note (looks like an invoice)', quality: 1,
    aff: { credit_note: 0.86, invoice: 0.76, purchase_order: 0.3, receipt: 0.2, other: 0.1 }, fewShot: { invoice: 0.06 },
    page: invoicePage('CONTOSO SUPPLIES LTD', '14 Mill Lane, Leeds LS1 4AB · VAT GB 123 4567 89', 'CREDIT NOTE', 'Credit note no: CN-2207', 'Against invoice: INV-10442',
      [['Description', 'Qty', 'Unit price', 'Amount'], ['Returned toner (damaged)', '-1', '90.00', '-90.00']],
      'TOTAL: GBP -108.00', 'Will be offset against your account · VAT 20% included', 'blue') },
  { id: 'cmb1', file: 'scan_0931.pdf', truth: 'invoice', label: 'Combined scan: invoice + delivery note (2 pages)', quality: 0.95,
    aff: { invoice: 0.8, delivery_note: 0.7, purchase_order: 0.45, credit_note: 0.35, other: 0.1 },
    parts: [
      { id: 'cmb1-p1', pageNo: 1, truth: 'invoice', aff: { invoice: 0.93, credit_note: 0.45, purchase_order: 0.45, delivery_note: 0.35, other: 0.1 },
        page: invoicePage('LITWARE FURNITURE', '8 Canal St, Manchester M1 3HE · VAT GB 556 7781 02', 'INVOICE', 'Invoice no: LW-3310', 'PO number: PO-55810',
          [['Item', 'Qty', 'Unit price', 'Amount'], ['Shelf unit 180cm', '12', '64.00', '768.00'], ['Wall brackets', '48', '2.10', '100.80']],
          'AMOUNT DUE: GBP 1,042.56', 'Payment within 14 days', 'amber') },
      { id: 'cmb1-p2', pageNo: 2, truth: 'delivery_note', aff: { delivery_note: 0.9, purchase_order: 0.6, invoice: 0.3, receipt: 0.15, other: 0.1 },
        page: { w: 210, h: 297, shapes: [{ kind: 'band', x: 0, y: 0, w: 210, h: 8, tone: 'amber' }], items: [
          T(14, 26, 9, 'LITWARE FURNITURE', 'title'), T(120, 28, 10, 'DELIVERY NOTE', 'sectionHeading'),
          T(120, 40, 4.6, 'Delivery note no: DN-7781'), T(120, 47, 4.6, 'PO number: PO-55810'),
          { id: 'tbl', role: 'table', x: 14, y: 70, colW: [110, 36, 36], rowH: 11, rows: [['Item', 'Ordered', 'Delivered'], ['Shelf unit 180cm', '12', '12'], ['Wall brackets', '48', '40']] },
          T(14, 130, 4.6, '2 packages · 8 brackets back-ordered'),
          T(14, 240, 4.6, 'Received by:'), T(48, 240, 8, 'K. Bell', 'signature', { hand: true })] } },
    ] },
  { id: 'ltr1', file: 'letter_carpark.pdf', truth: 'other', label: 'Letter from the landlord (no matching class)', quality: 1,
    aff: { other: 0.85, contract: 0.45, invoice: 0.1, id_document: 0.05 },
    page: { w: 210, h: 297, shapes: [{ kind: 'logo', x: 14, y: 14 }, { kind: 'paras', x: 14, y: 96, w: 182, lines: 9 }], items: [
      T(34, 24, 7, 'Woodgrove Property Management', 'title'), T(14, 50, 4.6, '3 October 2026'),
      T(14, 66, 5, 'Dear tenant,'), T(14, 78, 4.6, 'We hereby let you know the car park will be resurfaced'), T(14, 85, 4.6, 'from 3 November. During this term please use Bay C.'),
      T(14, 170, 4.6, 'Yours faithfully,'), T(14, 184, 8, 'L. Grant', 'signature', { hand: true })] } },
  { id: 'inv3', file: 'Rechnung_R-2291.pdf', truth: 'invoice', label: 'German-language invoice', quality: 1, lang: 'de',
    aff: { invoice: 0.9, credit_note: 0.45, purchase_order: 0.4, receipt: 0.3, other: 0.2 },
    page: invoicePage('MÜLLER BÜROBEDARF GMBH', 'Hauptstr. 7, 10115 Berlin · USt-IdNr. DE 123456789', 'RECHNUNG', 'Rechnungsnr.: R-2291', 'Fällig: 12.10.2026',
      [['Beschreibung', 'Menge', 'Preis', 'Betrag'], ['Ordner A4, breit', '40', '2,90', '116,00'], ['Druckerpapier', '50', '5,10', '255,00']],
      'GESAMTBETRAG: EUR 441,49', 'Zahlbar innerhalb von 30 Tagen ohne Abzug', 'red', true) },
];

const APPROACHES = {
  keywords: { label: 'Keyword rules (hand-written demo)', short: 'keyword rules' },
  trained: { label: 'Custom classifier trained on labelled samples (simulated)', short: 'trained classifier' },
  zeroshot: { label: 'Zero-shot categories with descriptions (simulated)', short: 'zero-shot categories' },
};

const OUTAGES = {
  none: { label: 'None' },
  'legal-transient': { label: 'Legal system: brief outage (recovers)', lane: 'legal', transient: true },
  'legal-down': { label: 'Legal system down for hours', lane: 'legal' },
  'ap-down': { label: 'ERP (AP) down for hours', lane: 'ap' },
};
const POLICIES = {
  none: 'No retry (fire-and-forget HTTP call)',
  retry: 'Retry 3× with backoff, then drop',
  dlq: 'Peek-lock + retries, then dead-letter queue',
};

const textOf = page => page.items.flatMap(it => (it.role === 'table' ? it.rows.flat() : [it.text])).join(' \n ');
const nameOf = c => (c ? (CLASSES[c] || { label: c }).label : 'no class');

// ---------- scoring ----------
function keywordScores(page, quality, classes, otherOn) {
  // Low-quality photo: in this simulation only large text survives OCR.
  const visible = { ...page, items: page.items.filter(it => quality >= 0.6 || (it.size || 0) >= 7) };
  const text = textOf(visible).toLowerCase();
  const hits = {};
  for (const c of classes) hits[c] = (KEYWORDS[c] || []).filter(k => text.includes(k));
  const total = Object.values(hits).reduce((a, h) => a + h.length, 0);
  const scores = classes.map(c => ({ cls: c, p: total ? hits[c].length / total : 0, hits: hits[c] }));
  if (otherOn) scores.push({ cls: 'other', p: total ? 0 : 1, hits: [] });
  return { scores, hits, total };
}

function modelScores(unit, p, classes) {
  const k = p.samples;
  const r = rng(`${unit.id}|${p.approach}|${p.approach === 'trained' ? k : ''}`);
  const q = unit.quality;
  const sharp = (p.approach === 'trained' ? 3 + 1.1 * k : 11) * (q < 0.6 ? q * 0.9 : q);
  const noise = p.approach === 'trained' ? 0.08 * 3 / (k + 1) : 0.03;
  const ids = p.other ? [...classes, 'other'] : classes;
  const logits = ids.map(c => {
    let a = unit.aff[c] ?? 0.05;
    if (p.approach === 'trained') {
      a += ((unit.fewShot || {})[c] || 0) * (4 / k);
      if (unit.lang && unit.lang !== 'en') a = c === 'other' ? a + 0.25 : a * 0.7; // samples were all English
    }
    a += (r() - 0.5) * noise;
    return sharp * a;
  });
  const mx = Math.max(...logits);
  const ex = logits.map(l => Math.exp(l - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ids.map((c, i) => ({ cls: c, p: ex[i] / sum }));
}

// ---------- the simulator ----------
function simulate(p) {
  const steps = [];
  const classes = p.classes === 'core' ? CORE : FULL;
  const ap = APPROACHES[p.approach] || APPROACHES.trained;
  const outage = OUTAGES[p.outage] || OUTAGES.none;
  const th = p.threshold, mg = p.margin;

  // 1. Intake
  const files = FILES.map(f => ({ id: f.id, file: f.file, label: f.label, truth: f.truth, page: f.parts ? f.parts[0].page : f.page, pages: f.parts ? f.parts.length : 1, quality: f.quality, lang: f.lang || 'en', multi: !!f.parts }));
  steps.push(step('intake', `${files.length} files received`, 'Files land in a Blob Storage container; Event Grid raises BlobCreated and a Function picks each one up with a correlation id. One file can hold more than one document.',
    { files: files.map(f => ({ name: f.file, pages: f.pages })) }));

  // 2. Split
  const units = [];
  for (const f of FILES) {
    if (f.parts && p.split) f.parts.forEach(pt => units.push({ ...pt, fileId: f.id, file: `${f.file} · p${pt.pageNo}`, label: `${f.label.split(':')[0]}, page ${pt.pageNo}`, quality: f.quality, lang: 'en', part: pt.pageNo }));
    else units.push({ id: f.id, fileId: f.id, file: f.file, label: f.label, truth: f.truth, aff: f.aff, fewShot: f.fewShot, quality: f.quality, lang: f.lang || 'en',
      page: f.parts ? f.parts[0].page : f.page, hidden: f.parts ? f.parts.slice(1).map(x => x.truth) : [], pages: f.parts ? f.parts.length : 1 });
  }
  const combo = FILES.find(f => f.parts);
  if (p.split) steps.push(step('split', 'Multi-document file split', `${combo.file} (2 pages) was segmented into an invoice (page 1) and a delivery note (page 2). ${units.length} documents go to the classifier.`,
    { splitMode: 'auto', file: combo.file, segments: [{ pages: [1], kind: 'invoice' }, { pages: [2], kind: 'delivery note' }] }));
  else steps.push(step('split', 'Combined PDF not split', `${combo.file} holds two documents but is classified as one. The delivery note on page 2 travels hidden inside whatever class page 1 gets.`,
    { splitMode: 'none', file: combo.file, pages: 2, documentsInside: 2 }, 'warn'));

  // 3. Classify
  const noMatch = [];
  for (const u of units) {
    let scores;
    if (p.approach === 'keywords') {
      const k = keywordScores(u.page, u.quality, classes, p.other);
      scores = k.scores;
      u.hits = k.hits;
      if (!k.total) noMatch.push(u);
    } else scores = modelScores(u, p, classes);
    scores = scores.map(x => ({ ...x, p: round(x.p, 3) })).sort((a, b) => b.p - a.p || ([...classes, 'other'].indexOf(a.cls) - [...classes, 'other'].indexOf(b.cls)));
    u.scores = scores;
    u.top = scores[0].p > 0 ? scores[0].cls : null;
    u.conf = scores[0].p;
    u.second = scores[1] ? scores[1].p : 0;
    u.secondCls = scores[1] ? scores[1].cls : null;
    u.marginV = round(u.conf - u.second, 3);
  }
  const wrongTop = units.filter(u => u.top !== u.truth);
  steps.push(step('classify', `Scored ${units.length} documents with ${ap.short}`,
    `Top-1 class is right for ${units.length - wrongTop.length}/${units.length}.${wrongTop.length ? ` Wrong top-1: ${wrongTop.map(u => `${u.file} (${nameOf(u.truth)} → ${nameOf(u.top)})`).join('; ')}. Thresholds must catch these.` : ''}`,
    { approach: p.approach, samplesPerClass: p.approach === 'trained' ? p.samples : undefined, categories: [...classes, ...(p.other ? ['other'] : [])], results: units.slice(0, 6).map(u => ({ file: u.file, docType: u.top, confidence: u.conf })), truncated: true },
    wrongTop.length ? 'warn' : 'ok'));
  if (p.classes === 'core') steps.push(step('classify', 'No category for credit notes or delivery notes', 'The classifier can only answer with a category it knows. Credit notes and delivery notes are scored as the nearest known class (usually invoice or purchase order), often with high confidence.',
    { missingCategories: ['credit_note', 'delivery_note'] }, 'warn'));
  if (noMatch.length) steps.push(step('classify', `No rule matched ${noMatch.length} document(s)`, `${noMatch.map(u => u.file).join(', ')}: none of the English keywords appear${noMatch.some(u => u.quality < 0.6) ? ' (on the blurry photo only the large text survives OCR)' : ''}. ${p.other ? 'They fall through to "other".' : 'With no "other" category they have no score at all.'}`,
    { unmatched: noMatch.map(u => u.file) }, 'warn'));

  // 4. Decide
  for (const u of units) {
    if (!u.top) { u.decision = 'review'; u.reason = 'No class scored above zero.'; }
    else if (u.conf < th) { u.decision = 'review'; u.reason = `Confidence ${u.conf.toFixed(2)} is below the ${th} threshold.`; }
    else if (u.marginV < mg) { u.decision = 'review'; u.reason = `Ambiguous: ${nameOf(u.top)} ${u.conf.toFixed(2)} vs ${nameOf(u.secondCls)} ${u.second.toFixed(2)} (margin ${u.marginV.toFixed(2)} < ${mg}).`; }
    else if (u.top === 'other') { u.decision = 'unknown'; u.reason = `Best match is "other" (${u.conf.toFixed(2)}): no known document type fits.`; }
    else { u.decision = 'auto'; u.reason = `${nameOf(u.top)} ${u.conf.toFixed(2)} ≥ ${th} and margin ${u.marginV.toFixed(2)} ≥ ${mg}.`; }
    u.lane = u.decision === 'auto' ? CLASSES[u.top].lane : u.decision;
  }
  const count = d => units.filter(u => u.decision === d).length;
  const nAuto = count('auto'), nReview = count('review'), nUnknown = count('unknown');
  const flood = nReview > units.length / 2;
  steps.push(step('decide', `${nAuto} auto-route · ${nReview} to review · ${nUnknown} unknown`,
    `Rule: auto-route when confidence ≥ ${th} and (top-1 − top-2) ≥ ${mg}; "other" goes to the unknown queue; everything else waits for a person.${flood ? ` The review queue holds ${nReview} of ${units.length} documents: automation is barely doing anything.` : ''}`,
    { threshold: th, margin: mg, decisions: units.map(u => ({ file: u.file, decision: u.decision })) }, flood ? 'warn' : 'ok'));

  // 5. Route
  for (const u of units) {
    u.misroute = u.decision === 'auto' && u.top !== u.truth;
    u.wrongUnknown = u.decision === 'unknown' && u.truth !== 'other';
  }
  const mis = units.filter(u => u.misroute), wrongUnk = units.filter(u => u.wrongUnknown);
  const consequence = u => (u.truth === 'credit_note' && u.top === 'invoice' ? 'AP would pay it as a new invoice: the supplier gets paid twice'
    : u.truth === 'other' ? `a letter lands in ${LANES.find(l => l.id === u.lane).label}'s system as a ${nameOf(u.top).toLowerCase()}`
    : u.truth === 'delivery_note' ? 'it would be booked as a new purchase order'
    : `${nameOf(u.truth).toLowerCase()} handled as ${nameOf(u.top).toLowerCase()}`);
  if (mis.length) steps.push(step('route', `${mis.length} document(s) auto-routed to the wrong system`, mis.map(u => `${u.file} → ${LANES.find(l => l.id === u.lane).label}: ${consequence(u)}.`).join(' '),
    { misroutes: mis.map(u => ({ file: u.file, truth: u.truth, predicted: u.top, confidence: u.conf, queue: u.lane })) }, 'error'));
  else steps.push(step('route', 'Messages sent to destination queues', `${nAuto} message(s) published to Service Bus, one queue per destination; review and unknown items go to their own queues. No auto-routed document went to the wrong place.`,
    { queues: Object.fromEntries(LANES.filter(l => l.id !== 'dlq').map(l => [l.id, units.filter(u => u.lane === l.id).length])) }));
  if (wrongUnk.length) steps.push(step('route', `${wrongUnk.length} real document(s) parked as unknown`, `${wrongUnk.map(u => u.file).join(', ')} is a real ${nameOf(wrongUnk[0].truth).toLowerCase()} but scored best as "other". It waits in triage instead of being processed.`,
    { unknown: wrongUnk.map(u => u.file) }, 'warn'));

  // 6. Downstream
  const lostHidden = units.filter(u => u.hidden && u.hidden.length);
  let lost = 0, dead = 0, retried = 0;
  for (const u of units) {
    u.delivery = { status: u.decision === 'auto' ? 'delivered' : 'queued', attempts: u.decision === 'auto' ? 1 : 0 };
    if (u.decision !== 'auto' || outage.lane !== u.lane) continue;
    if (outage.transient) {
      if (p.policy === 'none') { u.delivery = { status: 'lost', attempts: 1 }; lost++; }
      else { u.delivery = { status: 'retried', attempts: 3 }; retried++; }
    } else if (p.policy === 'dlq') { u.delivery = { status: 'dead-lettered', attempts: 3 }; dead++; u.finalLane = 'dlq'; }
    else { u.delivery = { status: 'lost', attempts: p.policy === 'retry' ? 4 : 1 }; lost++; }
  }
  const downLane = outage.lane ? LANES.find(l => l.id === outage.lane) : null;
  const hit = units.filter(u => u.decision === 'auto' && downLane && u.lane === downLane.id);
  if (lostHidden.length) {
    lost += lostHidden.reduce((a, u) => a + u.hidden.length, 0);
    steps.push(step('downstream', 'Delivery note never reached Purchasing', `It is still inside ${lostHidden[0].file}, which went to ${LANES.find(l => l.id === lostHidden[0].lane).label} as one ${lostHidden[0].decision === 'auto' ? nameOf(lostHidden[0].top).toLowerCase() : 'item'}. Goods receipt for PO-55810 is never recorded, so the invoice fails its three-way match.`,
      { file: lostHidden[0].file, missing: lostHidden[0].hidden }, 'error'));
  }
  if (downLane && hit.length) {
    steps.push(step('downstream', `${downLane.system} unavailable`, `${hit.length} message(s) for ${downLane.label} hit HTTP 503 on the first delivery attempt (injected outage).`, { system: downLane.system, status: 503, affected: hit.map(u => u.file) }, 'warn'));
    if (outage.transient && p.policy !== 'none') steps.push(step('downstream', 'Recovered by retrying', `Each message was retried with backoff and delivered on attempt 3 when the system came back.`, { retried, attempts: 3 }, 'ok'));
    else if (p.policy === 'dlq') steps.push(step('downstream', `${dead} message(s) dead-lettered, none lost`, 'After the maximum delivery count Service Bus moved them to the queue\'s dead-letter sub-queue. Alert on DLQ depth and resubmit them once the system is back.', { deadLettered: dead, deadLetterReason: 'MaxDeliveryCountExceeded' }, 'info'));
    else steps.push(step('downstream', `${hit.length} document(s) lost`, p.policy === 'retry' ? 'Retries ran out while the system was still down, and the code then dropped the message. Nobody knows these documents exist.' : 'The call failed once and nothing tried again. The message was already removed from the queue.',
      { lost: hit.map(u => u.file), policy: p.policy }, 'error'));
  } else if (downLane) steps.push(step('downstream', `${downLane.system} down, but nothing was routed there`, 'No auto-routed document targeted the failing system in this run.', { system: downLane.system }, 'info'));
  if (!lostHidden.length && !(downLane && hit.length)) steps.push(step('downstream', 'All routed documents delivered', `Each destination system received and acknowledged its messages (complete after successful processing).`, { delivered: nAuto }));

  // ---------- confusion matrix (truth × top-1, before thresholds) ----------
  const labels = [...FULL, 'other'];
  const hasNone = units.some(u => !u.top);
  const cols = hasNone ? [...labels, null] : labels;
  const matrix = labels.map(t => cols.map(pc => units.filter(u => u.truth === t && u.top === pc).map(u => u.id)));

  const lanes = LANES.map(l => ({ ...l, down: !!(outage.lane === l.id) }));
  const straight = units.filter(u => u.decision === 'auto' && !u.misroute && u.delivery.status !== 'lost').length;
  const view = { files, units, lanes, classes: [...classes, ...(p.other ? ['other'] : [])], labels, cols, matrix, threshold: th, margin: mg, approach: p.approach, split: p.split, outage: p.outage, policy: p.policy, transient: !!outage.transient };

  const tone = u => (u.misroute || u.delivery.status === 'lost' || (u.hidden && u.hidden.length) ? 'error' : u.wrongUnknown || u.decision === 'review' || u.delivery.status === 'dead-lettered' ? 'warn' : 'ok');
  const outcome = u => (u.misroute ? `misrouted (is ${nameOf(u.truth).toLowerCase()})` : u.hidden && u.hidden.length ? 'delivery note lost inside' : u.decision === 'auto' ? u.delivery.status : u.wrongUnknown ? 'parked: real document' : u.decision === 'unknown' ? 'parked (correct)' : 'waits for a person');
  const top = units.find(u => u.decision === 'auto' && !u.misroute) || units[0];

  return {
    steps, view,
    output: [
      { type: 'table', title: 'Routing decisions', columns: ['File', 'Truth', 'Top class', 'Conf.', 'Margin', 'Decision', 'Queue', 'Outcome'],
        rows: units.map(u => [u.file, nameOf(u.truth), nameOf(u.top), u.conf.toFixed(2), u.marginV.toFixed(2), u.decision, LANES.find(l => l.id === (u.finalLane || u.lane)).label, outcome(u)]),
        tones: units.map(tone) },
      { type: 'alert', tone: 'info', text: 'Scores here come from a simplified, deterministic simulation, not a trained model. Real services differ: a Document Intelligence custom classifier returns the chosen docType with one confidence per document; generative classification may return only the category. Calibrate thresholds on your own labelled validation set.' },
      { type: 'code', title: 'Service Bus message for one auto-routed document (illustrative)', lang: 'json', text: JSON.stringify({ correlationId: `blob-${top.fileId}`, docType: top.top, confidence: top.conf, source: `https://<account>.blob.core.windows.net/inbox/${top.file.split(' · ')[0]}`, pages: top.part ? [top.part] : [1], classifier: p.approach, routedTo: top.lane }, null, 2) },
    ],
    metrics: [
      metric('Documents', String(units.length), 'computed', p.split ? 'After splitting multi-document files.' : 'Files classified as-is.'),
      metric('Top-1 accuracy', `${units.length - wrongTop.length}/${units.length}`, 'computed', 'Top-scoring class equals ground truth, before thresholds.'),
      metric('Auto-routed', String(nAuto), 'computed'),
      metric('Misroutes', String(mis.length), 'computed', 'Auto-routed to a destination for the wrong document type.'),
      metric('Review queue', String(nReview), 'computed', 'Documents waiting for a person.'),
      metric('Unknown queue', `${nUnknown}${wrongUnk.length ? ` (${wrongUnk.length} real)` : ''}`, 'computed'),
      metric('Lost documents', String(lost), 'computed', 'Never reach any system or queue.'),
      metric('Dead-lettered', String(dead), 'computed', 'Recoverable: waiting in a dead-letter queue.'),
      metric('Straight-through', `${Math.round((straight / units.length) * 100)}%`, 'computed', 'Auto-routed, correct and delivered without a person.'),
    ],
    summary: `${ap.short}${p.approach === 'trained' ? ` (${p.samples}/class)` : ''} · t=${th} m=${mg} · ${mis.length} misroutes · ${nReview} review · ${lost} lost`,
  };
}

const metricVal = (res, label) => (res.metrics.find(m => m.label === label) || {}).value;

export default {
  id: 'classification',
  lab: 'Classification & routing simulator',
  workbench: 'classification',
  services: [
    { name: 'Document Intelligence: custom classification models', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/train/custom-classifier' },
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
    { name: 'Service Bus dead-letter queues', url: 'https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues' },
    { name: 'Event Grid: Blob Storage events', url: 'https://learn.microsoft.com/en-us/azure/event-grid/event-schema-blob-storage' },
  ],
  prereqs: ['ingestion'],
  next: ['fields', 'multimodal'],

  concept: {
    plain: 'A shared inbox receives every kind of paperwork: invoices, receipts, contracts, ID scans, letters. Classification decides what each document is; routing sends it to the team or system that handles that kind. Because the classifier can be unsure or wrong, you only act automatically when it is clearly confident, and send the rest to a person. You also have to cope with files that hold several documents, documents that fit no category, and destination systems that are down.',
    technical: 'A classifier scores each document against a set of categories. Document Intelligence custom classification models are trained on labelled samples per class and return a docType with a confidence; they can split multi-page files into separate documents. Content Understanding analyzers can classify against categories you describe in words and segment a file into per-category parts. Your code applies a confidence threshold and, where a runner-up score is available, a margin (top-1 minus top-2). Results are published to Service Bus queues or topic subscriptions per destination; consumers use peek-lock, and messages that exceed the maximum delivery count are moved to the dead-letter queue for inspection and resubmission.',
    useCase: 'A retailer\'s finance mailbox gets about a dozen document types. Event Grid triggers a Function for each new blob; the Function classifies with splitting on, routes invoices to the ERP, receipts to the expense app and contracts to contract management via Service Bus, sends low-confidence or ambiguous items to a review app, and parks unrecognised letters in a triage queue. When the contract system is down for maintenance, contracts wait in the dead-letter queue instead of disappearing.',
    terms: [
      ['Category / class', 'One document type the classifier can answer with, e.g. invoice. A type with no category can only be mistaken for another.'],
      ['Confidence threshold', 'Minimum top-1 score for automatic routing. Too low: misroutes. Too high: everything goes to people.'],
      ['Margin', 'Top-1 score minus top-2 score. A small margin means two classes look alike (credit note vs invoice), even if top-1 is high.'],
      ['"Other" class', 'An explicit category for documents that fit none of the known types, so they are parked instead of forced into the nearest class.'],
      ['Splitting', 'Detecting that one file contains several documents and classifying each page range separately.'],
      ['Dead-letter queue', 'A Service Bus sub-queue holding messages that could not be delivered or processed, so they can be inspected and resubmitted.'],
    ],
  },

  visual: {
    views: {
      conceptual: () => ({
        nodes: [
          { id: 'intake', label: 'Intake', col: 0, row: 1, detail: 'Every file in the shared inbox gets an id. One file may contain several documents.' },
          { id: 'split', label: 'Split', col: 1, row: 1, detail: 'Find document boundaries inside multi-page files.', substeps: ['Detect boundaries', 'Page ranges per document'] },
          { id: 'classify', label: 'Classify', col: 2, row: 1, detail: 'Score each document against every category.', substeps: ['Score per class', 'Top-1 and top-2'] },
          { id: 'decide', label: 'Decide', col: 3, row: 1, detail: 'Confidence and margin thresholds choose: auto-route, review, or unknown.', substeps: ['conf ≥ threshold?', 'margin ≥ minimum?', '"other"?'] },
          { id: 'route', label: 'Route', col: 4, row: 1, detail: 'Send each document to the queue for its destination.' },
          { id: 'downstream', label: 'Destination systems', col: 5, row: 1, detail: 'ERP, expenses, contract management, KYC, procurement. They can fail.' },
          { id: 'review', short: 'Review', label: 'Manual review', col: 3, row: 2.4, kind: 'user', detail: 'A person confirms or corrects the class. Corrections become new training samples.' },
          { id: 'unknown', label: 'Unknown / triage', col: 4, row: 2.4, kind: 'user', detail: 'Documents that fit no category. A growing pile here suggests a new class.' },
          { id: 'dlq', short: 'Dead-letter', label: 'Dead-letter', col: 5, row: 2.4, kind: 'store', detail: 'Messages that could not be delivered, kept for resubmission.' },
        ],
        edges: [['intake', 'split'], ['split', 'classify'], ['classify', 'decide'], ['decide', 'route', 'auto'], ['decide', 'review', 'unsure'], ['decide', 'unknown', 'other'], ['route', 'downstream'], ['downstream', 'dlq', 'failed']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'intake', label: 'Blob Storage + Event Grid', col: 0, row: 1, kind: 'store', detail: 'Files land in an inbox container; BlobCreated events trigger processing.' },
          { id: 'split', label: 'Azure Function (orchestrator)', col: 1, row: 1, kind: 'compute', detail: 'Calls the classifier with its managed identity, with splitting enabled or not.', badge: p ? (p.split ? 'split: auto' : 'split: none') : null },
          { id: 'classify', label: p && p.approach === 'keywords' ? 'Function code: keyword rules' : p && p.approach === 'zeroshot' ? 'Content Understanding analyzer (categories)' : 'Document Intelligence custom classifier', col: 2, row: 1, kind: p && p.approach === 'keywords' ? 'code' : 'ai',
            detail: 'Returns a category (and confidence where the service provides one) per document or segment.', badge: p ? `${(p.classes === 'core' ? CORE.length : FULL.length) + (p.other ? 1 : 0)} categories` : null },
          { id: 'decide', label: 'Routing policy (Function code)', col: 3, row: 1, kind: 'policy', detail: 'Applies confidence and margin thresholds. Keep these in configuration, not code.', badge: p ? `t ${p.threshold} · m ${p.margin}` : null },
          { id: 'route', label: 'Service Bus: queue per destination', col: 4, row: 1, kind: 'data', detail: 'Decouples classification from destination systems; consumers use peek-lock.' },
          { id: 'downstream', label: 'ERP · CLM · KYC · Expenses · Procurement', col: 5, row: 1, kind: 'app', detail: 'Consumers process and complete messages. A failure abandons the message so it is redelivered.', badge: p && p.outage !== 'none' ? 'outage injected' : null },
          { id: 'review', label: 'Review app (e.g. Power Apps / web app)', col: 3, row: 2.4, kind: 'user', detail: 'Reads the review queue; corrected labels feed retraining.' },
          { id: 'unknown', label: 'Triage queue', col: 4, row: 2.4, kind: 'data', detail: 'Unknown documents. Monitor volume to spot new document types.' },
          { id: 'dlq', label: 'Dead-letter sub-queues', col: 5, row: 2.4, kind: 'store', disabled: !!(p && p.policy !== 'dlq'), detail: 'Messages exceeding the max delivery count land here. Alert on depth with Azure Monitor and resubmit.' },
        ],
        edges: [['intake', 'split', 'BlobCreated'], ['split', 'classify', 'classify'], ['classify', 'decide'], ['decide', 'route', 'send'], ['decide', 'review'], ['decide', 'unknown'], ['route', 'downstream', 'peek-lock'], ['downstream', 'dlq', 'max deliveries']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'intake', label: '@app.event_grid_trigger(arg_name="event")  # BlobCreated', col: 0, row: 0, kind: 'code', detail: 'Azure Functions Python v2 programming model. Illustrative.' },
          { id: 'split', label: `poller = di.begin_classify_document("inbox-classifier", body, split="${p && !p.split ? 'none' : 'auto'}")`, col: 0, row: 1, kind: 'code', detail: 'azure-ai-documentintelligence with DefaultAzureCredential. Parameter names are illustrative; check the SDK reference for your API version.' },
          { id: 'classify', label: 'for d in poller.result().documents: d.doc_type, d.confidence, d.bounding_regions', col: 0, row: 2, kind: 'code', detail: 'Each split document has a docType, a confidence and its page ranges.' },
          { id: 'decide', label: `route = d.doc_type if d.confidence >= ${p ? p.threshold : 0.7} else "review"`, col: 0, row: 3, kind: 'code', detail: 'A margin check needs the runner-up score; if your service returns only top-1, use other signals (field validation, sender rules).' },
          { id: 'route', label: 'sb.get_queue_sender(QUEUES[route]).send_messages(ServiceBusMessage(body, correlation_id=blob_id))', col: 0, row: 4, kind: 'code', detail: 'azure-servicebus. One queue (or topic subscription) per destination.' },
          { id: 'downstream', label: 'try: post(msg); receiver.complete_message(msg)  except: receiver.abandon_message(msg)', col: 0, row: 5, kind: 'code', detail: 'Peek-lock: abandon makes the message available again; repeated failures dead-letter it.' },
          { id: 'review', label: 'review_sender.send_messages(...)  # with scores + reason', col: 1, row: 3, kind: 'code', detail: 'Send the reason so reviewers see why a person is needed.' },
          { id: 'unknown', label: 'QUEUES["other"] = "triage"', col: 1, row: 4, kind: 'code', detail: 'An explicit route for documents that match no category.' },
          { id: 'dlq', label: 'sb.get_queue_receiver(q, sub_queue=ServiceBusSubQueue.DEAD_LETTER)', col: 1, row: 5, kind: 'code', detail: 'Read dead-lettered messages, inspect DeadLetterReason, resubmit.' },
        ],
        edges: [['intake', 'split'], ['split', 'classify'], ['classify', 'decide'], ['decide', 'route'], ['decide', 'review'], ['decide', 'unknown'], ['route', 'downstream'], ['downstream', 'dlq']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'approach', label: 'Classifier approach', type: 'select', options: Object.entries(APPROACHES).map(([v, a]) => [v, a.label]), default: 'trained',
        help: 'All three are simplified demonstrations with hand-set document features, not real trained models.' },
      { id: 'samples', label: 'Training samples per class', type: 'range', min: 1, max: 20, step: 1, default: 5, help: 'Only affects the trained classifier: more samples, sharper and less confused scores.' },
      { id: 'classes', label: 'Categories defined', type: 'select', options: [['full', 'Full set (incl. credit note, delivery note)'], ['core', 'Core 5 only (invoice, receipt, contract, ID, PO)']], default: 'full' },
      { id: 'other', label: 'Include an "other / unknown" category', type: 'toggle', default: true },
      { id: 'split', label: 'Split multi-document files', type: 'toggle', default: true },
      { id: 'threshold', label: 'Confidence threshold', type: 'range', min: 0.3, max: 0.95, step: 0.05, default: 0.7 },
      { id: 'margin', label: 'Minimum margin (top-1 − top-2)', type: 'range', min: 0, max: 0.5, step: 0.05, default: 0.15 },
      { id: 'outage', label: 'Inject downstream failure', type: 'select', options: Object.entries(OUTAGES).map(([v, o]) => [v, o.label]), default: 'none' },
      { id: 'policy', label: 'Delivery failure policy', type: 'select', options: Object.entries(POLICIES), default: 'dlq' },
    ],
    samples: [
      { label: 'Default trained classifier', values: {} },
      { label: 'Low threshold, no margin (credit note risk)', values: { threshold: 0.4, margin: 0, samples: 2 } },
      { label: 'Keyword rules on the whole inbox', values: { approach: 'keywords', threshold: 0.5, margin: 0 } },
      { label: 'Zero-shot categories, well tuned', values: { approach: 'zeroshot', threshold: 0.6, margin: 0.2 } },
      { label: 'Legal system down, dead-letter policy', values: { outage: 'legal-down', policy: 'dlq' } },
    ],
    run: simulate,
  },

  compare: {
    suggestions: [
      'Run with threshold 0.4 and margin 0, then margin 0.15. Watch the credit note move from AP (misrouted) to manual review.',
      'Run with splitting off, then on. Compare documents classified and lost documents.',
      'Turn the "other" category off and run: the landlord letter is forced into Legal. Raise the threshold to 0.9 and see that confidence alone does not catch it.',
      'Set samples per class to 2, then 15, with threshold 0.7. Compare top-1 accuracy and review queue size.',
      'Inject "Legal system down" and run each delivery policy. Compare lost and dead-lettered.',
    ],
  },

  debug: [
    { id: 'paid-twice', title: 'Supplier paid twice for the same goods', values: { samples: 2, threshold: 0.3, margin: 0 }, node: 'decide',
      symptom: 'The credit note CN-2207 was posted to AP as an invoice.', cause: 'With few training samples the credit note scores slightly higher as invoice than credit note; a low threshold and no margin auto-route it anyway.', fix: 'Raise the threshold to about 0.6 and require a margin (0.15–0.2); better still, train with more samples per class.' },
    { id: 'review-flood', title: 'Reviewers drown, automation idle', values: { threshold: 0.95 }, node: 'decide',
      symptom: 'Almost every document goes to manual review.', cause: 'A 0.95 threshold is above what the classifier reaches for most documents.', fix: 'Lower the threshold (around 0.6–0.7) and use a margin to catch look-alikes instead.' },
    { id: 'no-split', title: 'Delivery note vanished', values: { split: false }, node: 'split',
      symptom: 'The three-way match for PO-55810 fails: no delivery note was ever received.', cause: 'scan_0931.pdf holds an invoice and a delivery note. Without splitting, the whole file was classified once and sent to AP.', fix: 'Turn on splitting of multi-document files.' },
    { id: 'forced-letter', title: 'A landlord letter appears in the contract system', values: { other: false }, node: 'classify',
      symptom: 'letter_carpark.pdf was auto-routed to Legal as a contract with high confidence.', cause: 'With no "other" category the classifier must pick a known class; the nearest one wins confidently.', fix: 'Enable the "other / unknown" category so it is parked for triage.' },
    { id: 'missing-class', title: 'Credit notes and delivery notes misfiled', values: { classes: 'core' }, node: 'classify',
      symptom: 'The credit note is posted as an invoice and the delivery note is booked as a purchase order.', cause: 'Those document types have no category, so they can only be classified as something else.', fix: 'Define categories for every type you route (choose the full set).' },
    { id: 'legal-down', title: 'Contracts disappeared during maintenance', values: { outage: 'legal-down', policy: 'none' }, node: 'downstream',
      symptom: 'Two contracts were classified and routed, but never arrived in contract management.', cause: 'The consumer called the system once, failed, and the message was already gone.', fix: 'Use peek-lock with retries and a dead-letter queue (choose the dead-letter policy).' },
    { id: 'rules', title: 'Keyword rules misfile half the inbox', values: { approach: 'keywords', threshold: 0.5, margin: 0 }, node: 'classify',
      symptom: 'The German invoice matches no rule, the letter becomes a contract because it says "hereby" and "term".', cause: 'English keyword lists cannot cope with other languages, shared vocabulary or blurry text.', fix: 'Use a trained classifier or zero-shot categories, with a margin.' },
  ],

  challenge: {
    task: 'Tune the pipeline so the whole inbox flows safely: nothing misrouted, nothing lost, the German invoice not parked as unknown, and at most 2 documents waiting for a person.',
    condition: '0 misroutes, 0 lost documents, no real document in the unknown queue, review queue ≤ 2, no error steps.',
    hint: 'Defaults send too many documents to review. Which approach copes with another language, and how many samples does a trained classifier need for credit notes?',
    check: (p, res) => !res.steps.some(s => s.status === 'error') && metricVal(res, 'Misroutes') === '0' && metricVal(res, 'Lost documents') === '0' && !/real/.test(metricVal(res, 'Unknown queue')) && Number(metricVal(res, 'Review queue')) <= 2,
    solution: [
      'Keep splitting on, the full category set and the "other" category.',
      'Choose zero-shot categories (it reads the German invoice) or train with about 12+ samples per class.',
      'Threshold 0.6 with margin 0.15 keeps the credit note honest without flooding review.',
      'Run: only the blurry taxi receipt (and possibly one look-alike) waits for a person; everything else is routed correctly.',
    ],
    solutionValues: { approach: 'zeroshot', threshold: 0.6, margin: 0.15, split: true, other: true, classes: 'full' },
  },

  quiz: [
    { q: 'A credit note is auto-routed to accounts payable as an invoice with confidence 0.52; the credit-note score was 0.44. What change catches this class of error best?', options: ['Lower the threshold so more is automated', 'Require a minimum margin between top-1 and top-2 scores', 'Remove the credit note category', 'Retry the classification'], answer: 1, why: 'A small top-1/top-2 gap means two classes look alike. A margin rule sends such cases to review even when top-1 passes the threshold.' },
    { q: 'Scanned files sometimes contain an invoice followed by its delivery note. The delivery notes never reach procurement. What should you enable?', options: ['A higher confidence threshold', 'Splitting so each document in the file is classified separately', 'A dead-letter queue', 'Markdown output'], answer: 1, why: 'Without splitting the file gets one class; the second document travels hidden inside it.' },
    { q: 'Your contract management system is down for a two-hour maintenance window. How do you make sure routed contracts are not lost?', options: ['Classify contracts as "other" during the window', 'Consume with peek-lock, retry, and let Service Bus dead-letter messages after the max delivery count, then resubmit', 'Lower the confidence threshold', 'Call the API once and log failures'], answer: 1, why: 'Peek-lock keeps the message until it is completed; repeated failures move it to the dead-letter queue instead of dropping it.' },
    { q: 'A letter that is not any of your document types is routed to Legal with confidence 0.91. Why did the threshold not stop it?', options: ['The threshold was too low', 'There was no category for unknown documents, so the classifier had to choose a known one and was confident about the nearest', 'Splitting was on', 'The letter was blurry'], answer: 1, why: 'Scores are relative to the categories offered. Add an "other" category (and monitor its volume) so out-of-scope documents can be recognised.' },
    { q: 'You raise the threshold to 0.95 to stop misroutes. Misroutes drop to 0, but 11 of 13 documents now go to people. What is the better approach?', options: ['Keep 0.95; reviews are cheap', 'Choose a moderate threshold plus a margin, and improve the classifier (more samples, better category descriptions) using a labelled validation set', 'Turn off the review queue', 'Use keyword rules instead'], answer: 1, why: 'Thresholds trade misroutes against review load. Tune them on labelled validation data and fix the classifier rather than pushing everything to people.' },
  ],

  recap: 'Classify every document against well-defined categories (including "other"), split multi-document files first, auto-route only when confidence and margin are both high, send the rest to review or triage, and decouple delivery with queues so a failing destination dead-letters messages instead of losing them.',
};
