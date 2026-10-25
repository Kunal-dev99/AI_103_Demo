// Agenda topic: Document ingestion, OCR and layout analysis.
// Lab: Document ingestion workbench. The workbench (src/workbenches/ingestion.js) draws result.view.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

// ---------- sample documents (page units: 210 x 297, like A4 in mm) ----------
// Text items: { id, role, x, y (baseline), size, text, col? }. Tables: { id, role:'table', x, y, colW, rowH, rows }.
// Marks: { id, role:'mark', x, y, label, checked }. hand: true = handwritten.
const DOCS = {
  invoice: {
    label: 'Supplier invoice (clean PDF)', angle: 0, quality: 1,
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 9, text: 'CONTOSO SUPPLIES LTD' },
      { id: 'h2', role: 'pageHeader', x: 14, y: 32, size: 4.2, text: '14 Mill Lane, Leeds LS1 4AB · VAT GB 123 4567 89' },
      { id: 'h3', role: 'sectionHeading', x: 140, y: 24, size: 8, text: 'INVOICE' },
      { id: 'l1', role: 'text', x: 140, y: 34, size: 4.6, text: 'Invoice no: INV-10442' },
      { id: 'l2', role: 'text', x: 140, y: 41, size: 4.6, text: 'Date: 2026-09-14' },
      { id: 'l3', role: 'text', x: 140, y: 48, size: 4.6, text: 'Due: 2026-10-14' },
      { id: 'b1', role: 'sectionHeading', x: 14, y: 60, size: 5, text: 'Bill to' },
      { id: 'b2', role: 'text', x: 14, y: 68, size: 4.6, text: 'Fabrikam Retail plc' },
      { id: 'b3', role: 'text', x: 14, y: 75, size: 4.6, text: '12 Harbour Road, Hull HU1 2AA' },
      { id: 't1', role: 'table', x: 14, y: 92, colW: [86, 26, 32, 38], rowH: 11,
        rows: [['Description', 'Qty', 'Unit price', 'Amount'], ['Copy paper A4, 5 reams', '10', '4.50', '45.00'], ['Toner cartridge XL', '2', '90.00', '180.00'], ['Delivery', '1', '15.00', '15.00']] },
      { id: 's1', role: 'text', x: 128, y: 154, size: 4.6, text: 'Subtotal: 240.00' },
      { id: 's2', role: 'text', x: 128, y: 162, size: 4.6, text: 'VAT 20%: 48.00' },
      { id: 's3', role: 'text', x: 128, y: 172, size: 5.6, text: 'TOTAL DUE: GBP 288.00' },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Payment within 30 days · Page 1 of 1' },
    ],
  },
  receipt: {
    label: 'Receipt photo (phone, rotated 90°)', angle: 90, quality: 0.85,
    items: [
      { id: 'h1', role: 'title', x: 62, y: 40, size: 8, text: 'NORTHWIND CAFE' },
      { id: 'l1', role: 'text', x: 62, y: 52, size: 4.6, text: '2026-10-02  08:41  Till 3' },
      { id: 'l2', role: 'text', x: 62, y: 70, size: 5, text: 'Flat white          3.40' },
      { id: 'l3', role: 'text', x: 62, y: 80, size: 5, text: 'Croissant           2.60' },
      { id: 'l4', role: 'text', x: 62, y: 90, size: 5, text: 'Orange juice        2.95' },
      { id: 's3', role: 'text', x: 62, y: 108, size: 6, text: 'TOTAL               8.95' },
      { id: 'l5', role: 'text', x: 62, y: 120, size: 4.6, text: 'VISA ****4417  APPROVED' },
      { id: 'f1', role: 'pageFooter', x: 62, y: 140, size: 4.2, text: 'Thank you! VAT reg 998 1122 33' },
    ],
  },
  fax: {
    label: 'Faxed invoice (noisy, 200 dpi)', angle: 2, quality: 0.5,
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 8.5, text: 'ADATUM LOGISTICS' },
      { id: 'h3', role: 'sectionHeading', x: 140, y: 24, size: 7.5, text: 'INVOICE' },
      { id: 'l1', role: 'text', x: 140, y: 34, size: 4.6, text: 'Invoice no: A-7731', noisy: 'Invoice no: A-773l' },
      { id: 'l2', role: 'text', x: 140, y: 41, size: 4.6, text: 'Date: 2026-08-30', noisy: 'Date: 2O26-O8-3O' },
      { id: 'b2', role: 'text', x: 14, y: 60, size: 4.6, text: 'Bill to: Litware Inc' },
      { id: 't1', role: 'table', x: 14, y: 76, colW: [100, 30, 52], rowH: 11,
        rows: [['Service', 'Qty', 'Amount'], ['Pallet freight Leeds-Hull', '4', '960.00'], ['Fuel surcharge', '1', '280.50']] },
      { id: 's3', role: 'text', x: 118, y: 132, size: 5.6, text: 'TOTAL DUE: USD 1,240.50', noisy: 'TOTAL DUE: USD 1,24O.5O' },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'FAX FROM +44 113 496 0000  P.01' },
    ],
  },
  report: {
    label: 'Two-column report page', angle: 0, quality: 1,
    items: [
      { id: 'h1', role: 'title', x: 14, y: 26, size: 8, text: 'Quarterly Operations Review' },
      { id: 'h2', role: 'pageHeader', x: 150, y: 12, size: 3.8, text: 'Internal · Q3 2026' },
      { id: 'a1', role: 'sectionHeading', x: 14, y: 44, size: 5.2, text: '1. Warehouse throughput', col: 0 },
      { id: 'a2', role: 'text', x: 14, y: 54, size: 4.2, text: 'Throughput rose 12% after', col: 0 },
      { id: 'a3', role: 'text', x: 14, y: 61, size: 4.2, text: 'the new sorter went live in', col: 0 },
      { id: 'a4', role: 'text', x: 14, y: 68, size: 4.2, text: 'July. Peak days still queue.', col: 0 },
      { id: 'c1', role: 'sectionHeading', x: 112, y: 44, size: 5.2, text: '2. Returns processing', col: 1 },
      { id: 'c2', role: 'text', x: 112, y: 54, size: 4.2, text: 'Returns fell to 3.1% of', col: 1 },
      { id: 'c3', role: 'text', x: 112, y: 61, size: 4.2, text: 'orders. Most returns are', col: 1 },
      { id: 'c4', role: 'text', x: 112, y: 68, size: 4.2, text: 'sizing issues in apparel.', col: 1 },
      { id: 't1', role: 'table', x: 14, y: 90, colW: [70, 50, 50], rowH: 11,
        rows: [['Site', 'Orders', 'Returns'], ['Leeds', '41,200', '1,180'], ['Hull', '18,900', '702']] },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Page 7' },
    ],
  },
  form: {
    label: 'Application form (handwriting + checkboxes)', angle: 0, quality: 0.9,
    items: [
      { id: 'h1', role: 'title', x: 14, y: 26, size: 7.5, text: 'Account Application' },
      { id: 'q1', role: 'text', x: 14, y: 46, size: 4.6, text: 'Full name:' },
      { id: 'a1', role: 'text', x: 48, y: 46, size: 6, text: 'Ana Ruiz Delgado', hand: true },
      { id: 'q2', role: 'text', x: 14, y: 60, size: 4.6, text: 'Date of birth:' },
      { id: 'a2', role: 'text', x: 52, y: 60, size: 6, text: '07/03/1991', hand: true },
      { id: 'q3', role: 'text', x: 14, y: 74, size: 4.6, text: 'Customer type:' },
      { id: 'm1', role: 'mark', x: 54, y: 70.5, label: 'New', checked: true },
      { id: 'm2', role: 'mark', x: 84, y: 70.5, label: 'Existing', checked: false },
      { id: 'q4', role: 'text', x: 14, y: 90, size: 4.6, text: 'Signature:' },
      { id: 'a4', role: 'signature', x: 48, y: 90, size: 7, text: 'A. Ruiz', hand: true },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Form AP-2 rev 4' },
    ],
  },
};

// Content Understanding is the service the AI-103 objectives name; Document Intelligence models are the alternative.
// Analyzer/model IDs are illustrative: check the docs for the API version you target.
const MODELS = {
  cu: { label: 'Content Understanding · document analyzer (OCR + layout + markdown)', short: 'Content Understanding', layout: true, service: 'cu', modelId: 'prebuilt-document' },
  layout: { label: 'Document Intelligence · prebuilt-layout (OCR + structure)', short: 'prebuilt-layout', layout: true, service: 'di', modelId: 'prebuilt-layout' },
  read: { label: 'Document Intelligence · prebuilt-read (OCR only)', short: 'prebuilt-read', layout: false, service: 'di', modelId: 'prebuilt-read' },
};

const charW = size => size * 0.52;
// Paragraph roles Document Intelligence layout can return (others are plain text). tableCell is internal to this lab.
const DI_ROLES = new Set(['title', 'sectionHeading', 'pageHeader', 'pageFooter', 'pageNumber', 'footnote', 'tableCell']);

// Expand document items into OCR lines (table cells become one line each).
function linesOf(doc) {
  const out = [];
  for (const it of doc.items) {
    if (it.role === 'table') {
      let y = it.y;
      it.rows.forEach((row, r) => {
        let x = it.x;
        row.forEach((cell, c) => {
          out.push({ id: `${it.id}-r${r}c${c}`, role: 'tableCell', table: it.id, r, c, x: x + 2, y: y + it.rowH * 0.68, size: 4.2, text: cell, header: r === 0 });
          x += it.colW[c];
        });
        y += it.rowH;
      });
    } else if (it.role !== 'mark') out.push({ ...it });
  }
  return out;
}

const box = l => ({ x: l.x - 0.6, y: l.y - l.size * 0.85, w: l.text.length * charW(l.size) + 1.2, h: l.size * 1.15 });

function readingOrderTruth(doc, lines) {
  // Human reading order: header first, then title, column 0 top-to-bottom, column 1, then the rest by y, footer last.
  const rank = l => (l.role === 'pageHeader' ? 0 : l.role === 'pageFooter' ? 9 : 1);
  return [...lines].sort((a, b) => rank(a) - rank(b) || (a.col ?? -1) - (b.col ?? -1) || a.y - b.y || a.x - b.x).map(l => l.id);
}

function analyze(p) {
  const doc = DOCS[p.document];
  const model = MODELS[p.model];
  const r = rng(`${p.document}|${p.model}|${p.deskew}|${p.enhance}`);
  const steps = [];
  const truthLines = linesOf(doc);
  const view = { page: { w: 210, h: 297, items: doc.items }, angle: doc.angle, corrected: false, quality: doc.quality, enhance: p.enhance, threshold: p.threshold,
    lines: [], words: [], tables: [], marks: [], order: [], orderTruth: [], output: null, stage: null };

  // 1. Upload
  if (p.format === 'heic') {
    steps.push(step('upload', 'Upload rejected (HTTP 400)', 'HEIC is not an accepted input type for this analyzer. Accepted in this lab: PDF, JPEG, PNG, TIFF. Check the service docs for the full list for your API version.', { format: 'heic', error: { code: 'InvalidRequest', innererror: { code: 'UnsupportedMediaType' } } }, 'error'));
    return { steps, view, output: [{ type: 'alert', tone: 'error', text: 'Nothing was analyzed. Convert the photo to JPEG/PNG or PDF and resubmit.' }], metrics: [], summary: 'Rejected at upload (HEIC)' };
  }
  if (p.format === 'pdf-locked') {
    steps.push(step('upload', 'Upload rejected (password-protected PDF)', 'The service cannot open encrypted PDFs. Remove the password before submitting.', { format: 'pdf', encrypted: true, error: { code: 'InvalidContent' } }, 'error'));
    return { steps, view, output: [{ type: 'alert', tone: 'error', text: 'Encrypted PDF: unlock it upstream (e.g. in the intake system) before analysis.' }], metrics: [], summary: 'Rejected at upload (encrypted PDF)' };
  }
  steps.push(step('upload', 'Document accepted', `${doc.label} as ${p.format.toUpperCase()}. The analyze call is a long-running operation: POST, then poll the Operation-Location URL.`, { format: p.format, pages: 1, [model.service === 'cu' ? 'analyzerId' : 'modelId']: model.modelId }));

  // 2. Pre-processing
  const rotated = doc.angle >= 45 && !p.deskew;
  view.corrected = !rotated;
  if (rotated) steps.push(step('pre', `Page left at ${doc.angle}°`, 'Orientation correction is off in this simulation, so text is read sideways: confidence collapses and reading order breaks. (The real service detects page angle; skipping correction stands in for a badly captured image.)', { angle: doc.angle, corrected: false }, 'warn'));
  else steps.push(step('pre', doc.angle ? `Rotation ${doc.angle}° detected and corrected` : 'Page upright', `${p.enhance ? 'Noise reduction and contrast enhancement applied before upload.' : 'No image enhancement.'}${doc.quality < 0.7 && !p.enhance ? ' This scan is noisy: expect misread characters.' : ''}`, { angle: doc.angle, corrected: true, enhance: p.enhance, quality: doc.quality }, doc.quality < 0.7 && !p.enhance ? 'warn' : 'ok'));

  // 3. OCR
  const qPenalty = (1 - doc.quality) * (p.enhance ? 0.3 : 0.65);
  const rPenalty = rotated ? 0.42 : 0;
  for (const l of truthLines) {
    const noisyText = l.noisy && !p.enhance ? l.noisy : l.text;
    const b = box(l);
    const ws = noisyText.split(/(\s+)/);
    const truthWords = l.text.split(/\s+/);
    let cx = l.x;
    const words = [];
    for (const w of ws) {
      if (!w.trim()) { cx += w.length * charW(l.size); continue; }
      const base = l.hand ? 0.74 : 0.985;
      const misread = noisyText !== l.text && truthWords[words.length] !== w;
      const conf = clamp(round(base - qPenalty - rPenalty - (misread ? 0.18 : 0) + (r() - 0.5) * 0.04, 2), 0.08, 0.99);
      words.push({ id: `${l.id}-w${words.length}`, lineId: l.id, text: w, conf, x: cx - 0.3, y: b.y, w: w.length * charW(l.size) + 0.6, h: b.h });
      cx += w.length * charW(l.size);
    }
    const conf = round(words.reduce((a, w) => a + w.conf, 0) / Math.max(1, words.length), 2);
    view.lines.push({ id: l.id, text: noisyText, truth: l.text, conf, ...b, role: model.layout ? (DI_ROLES.has(l.role) ? l.role : 'text') : null, table: l.table, r: l.r, c: l.c, col: l.col, hand: !!l.hand });
    view.words.push(...words);
  }
  const low = view.words.filter(w => w.conf < p.threshold);
  const misreads = view.lines.filter(l => l.text !== l.truth).length;
  steps.push(step('ocr', 'OCR complete', `${view.lines.length} lines, ${view.words.length} words. ${low.length} word(s) below the ${p.threshold} threshold${misreads ? `; ${misreads} line(s) contain misread characters (letter O for zero, l for one)` : ''}${view.lines.some(l => l.hand) ? '; handwriting is recognised with lower confidence' : ''}.`,
    { lines: view.lines.slice(0, 8).map(l => ({ content: l.text, confidence: l.conf })), truncated: view.lines.length > 8 }, rotated || low.length > view.words.length / 3 || misreads ? 'warn' : 'ok'));

  // 4. Layout
  const truth = readingOrderTruth(doc, truthLines);
  view.orderTruth = truth;
  const naive = [...view.lines].sort((a, b) => (Math.round(a.y / 3) - Math.round(b.y / 3)) || a.x - b.x).map(l => l.id);
  if (model.layout && !rotated) {
    view.tables = doc.items.filter(i => i.role === 'table').map(t => ({ id: t.id, x: t.x, y: t.y, w: t.colW.reduce((a, b) => a + b, 0), h: t.rowH * t.rows.length, rows: t.rows.length, cols: t.colW.length,
      cells: t.rows.flatMap((row, ri) => row.map((cell, ci) => ({ r: ri, c: ci, text: (view.lines.find(l => l.id === `${t.id}-r${ri}c${ci}`) || {}).text || cell, header: ri === 0, x: t.x + t.colW.slice(0, ci).reduce((a, b) => a + b, 0), y: t.y + ri * t.rowH, w: t.colW[ci], h: t.rowH }))) }));
    view.marks = doc.items.filter(i => i.role === 'mark').map(m => ({ ...m, state: m.checked ? 'selected' : 'unselected' }));
    view.order = truth;
    steps.push(step('layout', 'Layout analysis', `${view.tables.length} table(s), ${view.marks.length} selection mark(s), roles for title, headings, page header and footer. Reading order follows columns.`,
      { tables: view.tables.map(t => ({ rowCount: t.rows, columnCount: t.cols })), selectionMarks: view.marks.map(m => ({ label: m.label, state: m.state })), roles: [...new Set(view.lines.map(l => l.role))] }));
  } else if (model.layout && rotated) {
    view.order = [...naive].reverse();
    steps.push(step('layout', 'Layout unreliable', 'With the page sideways, table borders and columns are not recognised in this simulation. No tables returned; reading order is scrambled.', { tables: 0 }, 'warn'));
  } else {
    view.order = naive;
    const hasStructure = doc.items.some(i => i.role === 'table' || i.role === 'mark' || i.col != null);
    steps.push(step('layout', 'No layout analysis', `prebuilt-read returns text lines and words only: no tables, no selection marks, no roles.${doc.items.some(i => i.col != null) ? ' In this simulation its lines come out top-to-bottom across the page, which interleaves the two columns.' : ''}${doc.items.some(i => i.role === 'mark') ? ' Checkbox states are lost.' : ''}`, { tables: 0, selectionMarks: 0 }, hasStructure ? 'warn' : 'skip'));
  }
  const orderErrors = view.order.reduce((a, id, i) => a + (truth[i] !== id ? 1 : 0), 0);

  // 5. Output
  // Markdown rendering of the layout result (used for markdown output and inside the Content Understanding JSON).
  const toMarkdown = () => {
    const md = [];
    const doneTables = new Set();
    for (const id of view.order) {
      const l = byId[id];
      if (l.table) {
        if (doneTables.has(l.table)) continue;
        doneTables.add(l.table);
        const t = view.tables.find(x => x.id === l.table);
        if (!t) { md.push(l.text); continue; }
        const rows = [...Array(t.rows)].map((_, ri) => t.cells.filter(c => c.r === ri).map(c => c.text));
        md.push('| ' + rows[0].join(' | ') + ' |', '|' + rows[0].map(() => ' --- ').join('|') + '|', ...rows.slice(1).map(rw => '| ' + rw.join(' | ') + ' |'));
      } else if (l.role === 'pageHeader' || l.role === 'pageFooter') md.push(`<!-- ${l.role}="${l.text}" -->`);
      else if (l.role === 'title') md.push(`# ${l.text}`);
      else if (l.role === 'sectionHeading') md.push(`## ${l.text}`);
      else md.push(l.text);
    }
    for (const m of view.marks) md.push(`${m.state === 'selected' ? '☒' : '☐'} ${m.label}`);
    return md.join('\n');
  };
  const byId = Object.fromEntries(view.lines.map(l => [l.id, l]));
  if (p.output === 'markdown' && !model.layout) {
    steps.push(step('output', 'Markdown output not available', 'Markdown comes from layout analysis: Content Understanding returns it by default and Document Intelligence prebuilt-layout returns it with outputContentFormat=markdown. prebuilt-read only gives plain text.', { outputContentFormat: 'markdown', model: 'prebuilt-read' }, 'error'));
    view.output = { format: 'error', text: '' };
  } else if (p.output === 'markdown') {
    const mdText = toMarkdown();
    view.output = { format: 'markdown', text: mdText };
    steps.push(step('output', 'Markdown produced', 'Headings, tables and selection marks are preserved as markdown, ready for chunking in a RAG pipeline or for an agent to read.', { contentFormat: 'markdown', length: view.output.text.length }, orderErrors ? 'warn' : 'ok'));
  } else {
    const content = view.order.map(id => byId[id].text).join('\n').slice(0, 160) + '…';
    const pages = [{ pageNumber: 1, angle: rotated ? doc.angle : 0, width: 8.27, height: 11.69, unit: 'inch', lines: view.lines.length, words: view.words.length, selectionMarks: view.marks.length || undefined }];
    const tables = view.tables.map(t => ({ rowCount: t.rows, columnCount: t.cols, cells: t.cells.length }));
    const json = model.service === 'cu'
      // Content Understanding result shape (abridged, illustrative): contents[] with markdown plus pages/tables.
      ? { status: 'Succeeded', result: { analyzerId: model.modelId, contents: [{ kind: 'document', markdown: toMarkdown().slice(0, 200) + '…', pages, tables }] } }
      : { status: 'succeeded', analyzeResult: { modelId: model.modelId, content, pages, tables,
        paragraphs: model.layout ? view.lines.filter(l => !l.table).slice(0, 4).map(l => ({ role: l.role === 'text' ? undefined : l.role, content: l.text })) : undefined } };
    view.output = { format: 'json', text: JSON.stringify(json, null, 2) };
    steps.push(step('output', 'JSON result returned', model.service === 'cu' ? 'Content Understanding returns contents[] with the document as markdown plus pages, words with polygons and confidence, and tables.' : 'AnalyzeResult with pages → lines → words (each with polygon and confidence), plus tables, paragraphs and selection marks when layout ran.', { contentFormat: 'text' }, orderErrors && model.layout ? 'warn' : 'ok'));
  }

  const meanConf = view.words.reduce((a, w) => a + w.conf, 0) / view.words.length;
  return {
    steps, view,
    output: [
      { type: 'table', title: 'Recognised lines in output order', columns: ['#', 'Text', 'Role', 'Confidence', 'Correct position?'],
        rows: view.order.map((id, i) => [String(i + 1), byId[id].text, byId[id].role || '—', byId[id].conf.toFixed(2), truth[i] === id ? 'yes' : `no (should be #${truth.indexOf(id) + 1})`]),
        tones: view.order.map((id, i) => (byId[id].text !== byId[id].truth ? 'error' : byId[id].conf < p.threshold ? 'warn' : truth[i] !== id ? 'warn' : 'ok')) },
      view.output.format === 'error' ? { type: 'alert', tone: 'error', text: 'Use a layout-capable analyzer (Content Understanding or prebuilt-layout), or ask for plain text output.' } : { type: 'code', title: view.output.format === 'markdown' ? 'Markdown output' : model.service === 'cu' ? 'Analyzer result (abridged, simulated shape)' : 'AnalyzeResult (abridged, simulated)', lang: view.output.format, text: view.output.text },
    ],
    metrics: [
      metric('Mean word confidence', meanConf.toFixed(2), 'computed', 'Average of simulated word confidences.'),
      metric('Words under threshold', `${low.length}/${view.words.length}`, 'computed'),
      metric('Misread lines', String(misreads), 'computed', 'Lines whose text differs from the ground truth.'),
      metric('Reading-order errors', String(orderErrors), 'computed', 'Lines not in the position a human reader would put them.'),
      metric('Tables recovered', `${view.tables.length}/${doc.items.filter(i => i.role === 'table').length}`, 'computed'),
      metric('Relative cost', model.layout ? 'higher' : 'lower', 'estimate', 'Layout is priced above Read per page; check the current pricing page.'),
    ],
    summary: `${doc.label} · ${model.label} · conf ${meanConf.toFixed(2)} · ${orderErrors} order errors · ${view.tables.length} tables`,
  };
}

export default {
  id: 'ingestion',
  lab: 'Document ingestion workbench',
  workbench: 'ingestion',
  services: [
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
    { name: 'Document Intelligence: Layout model (alternative)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout' },
    { name: 'Document Intelligence: Read model (alternative)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/read' },
  ],
  prereqs: [],
  next: ['fields', 'classification'],

  concept: {
    plain: 'A scanned or photographed document is only an image. Ingestion turns it into something software can use: first make sure the file is acceptable and the page is upright and readable, then read every character (OCR), then work out the structure a person sees at a glance — which text is the title, where the table is, which column to read first.',
    technical: 'In AI-103 terms this is Azure Content Understanding in Foundry Tools: a document analyzer runs OCR (words and lines, each with a polygon and confidence) and layout analysis (tables with cells, selection marks, paragraph roles such as title and sectionHeading, column-aware reading order) and returns the document as markdown plus structured content, ready for field extraction or RAG. Document Intelligence offers the same foundation as separate models: prebuilt-read for OCR only and prebuilt-layout for structure (markdown via outputContentFormat=markdown). Analysis is asynchronous: submit the file, then poll the operation until it succeeds.',
    useCase: 'An operations team ingests supplier invoices, scanned faxes, phone photos of receipts and multi-column reports into a search index. Clean PDFs go straight through; rotated photos and noisy faxes are caught by confidence checks before their text pollutes the index, and layout output keeps tables intact so totals stay next to their labels.',
    terms: [
      ['OCR', 'Converting pixels to characters. Every word and line gets a confidence score (0–1) and a polygon locating it on the page.'],
      ['Layout', 'Structure on top of OCR: tables and cells, selection marks (checkboxes), paragraph roles and reading order.'],
      ['Reading order', 'The sequence a human would read the text in. Multi-column pages are where naive top-to-bottom order goes wrong.'],
      ['Selection mark', 'A checkbox or radio button with state selected / unselected.'],
      ['Markdown output', 'Layout can return the document as markdown, keeping headings and tables for downstream chunking and LLMs.'],
    ],
  },

  visual: {
    views: {
      conceptual: () => ({
        nodes: [
          { id: 'upload', label: 'Upload & validate', col: 0, row: 1, detail: 'Checks file type, size, encryption and page count before any analysis.' },
          { id: 'pre', label: 'Pre-process', col: 1, row: 1, detail: 'Orientation, skew, noise and contrast. Problems here propagate to every later stage.', substeps: ['Detect angle', 'Rotate upright', 'Denoise / contrast'] },
          { id: 'ocr', label: 'OCR', col: 2, row: 1, detail: 'Detects text regions, recognises characters, scores confidence per word.', substeps: ['Text detection', 'Recognition', 'Confidence'] },
          { id: 'layout', label: 'Layout', col: 3, row: 1, detail: 'Tables, selection marks, roles, reading order.', substeps: ['Tables & cells', 'Selection marks', 'Roles', 'Reading order'] },
          { id: 'output', label: 'Structured output', col: 4, row: 1, detail: 'JSON AnalyzeResult, or markdown for RAG / agents.' },
        ],
        edges: [['upload', 'pre'], ['pre', 'ocr'], ['ocr', 'layout'], ['layout', 'output']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'upload', label: 'Blob Storage (inbox)', col: 0, row: 1, kind: 'store', detail: 'Documents land in a container; Event Grid raises BlobCreated.' },
          { id: 'pre', label: 'Azure Function', col: 1, row: 1, kind: 'compute', detail: 'Validates the file and calls the analyze API using its managed identity (role: Cognitive Services User).' },
          { id: 'ocr', label: p ? MODELS[p.model].label : 'Content Understanding analyzer', col: 2, row: 1, kind: 'ai', detail: 'One analyze call performs OCR, plus layout when the analyzer or model supports it. Content Understanding lives in a Microsoft Foundry resource (Foundry Tools).' },
          { id: 'layout', label: 'Layout result', col: 3, row: 0.4, kind: 'data', disabled: !!(p && !MODELS[p.model].layout), detail: 'Tables, marks, roles and markdown. Present with Content Understanding or prebuilt-layout, not prebuilt-read.' },
          { id: 'output', label: p && p.output === 'markdown' ? 'Markdown → chunker → AI Search' : 'JSON → database', col: 4, row: 1, kind: 'store', detail: 'Results are stored for search, extraction or review.' },
        ],
        edges: [['upload', 'pre', 'event'], ['pre', 'ocr', 'analyze'], ['ocr', 'layout'], ['layout', 'output'], ['ocr', 'output']],
      }),
      implementation: p => ({
        nodes: [
          ...(p && MODELS[p.model].service === 'di' ? [
            { id: 'upload', label: 'client = DocumentIntelligenceClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'azure-ai-documentintelligence, keyless auth with Microsoft Entra ID.' },
            { id: 'pre', label: 'body = AnalyzeDocumentRequest(bytes_source=data)', col: 0, row: 1, kind: 'code', detail: 'Or url_source for a blob URL the service can reach. (Illustrative; check SDK docs for your version.)' },
            { id: 'ocr', label: `poller = client.begin_analyze_document("${MODELS[p.model].modelId}", body${p.output === 'markdown' ? ', output_content_format="markdown"' : ''})`, col: 0, row: 2, kind: 'code', detail: 'Long-running operation.' },
            { id: 'layout', label: 'result = poller.result()  # pages, tables, paragraphs', col: 0, row: 3, kind: 'code', detail: 'AnalyzeResult.' },
            { id: 'output', label: 'for w in result.pages[0].words: w.content, w.confidence, w.polygon', col: 0, row: 4, kind: 'code', detail: 'Iterate words / lines / tables.' },
          ] : [
            { id: 'upload', label: 'token = DefaultAzureCredential().get_token("https://cognitiveservices.azure.com/.default")', col: 0, row: 0, kind: 'code', detail: 'Keyless auth with Microsoft Entra ID against the Foundry resource. Illustrative: use the SDK or REST shape for your API version.' },
            { id: 'pre', label: 'POST {endpoint}/contentunderstanding/analyzers/prebuilt-document:analyze', col: 0, row: 1, kind: 'code', detail: 'Body: the file URL or bytes. Analyzer ID and api-version are illustrative; check the Content Understanding docs.' },
            { id: 'ocr', label: 'GET Operation-Location  →  poll until status == "Succeeded"', col: 0, row: 2, kind: 'code', detail: 'Analysis is asynchronous.' },
            { id: 'layout', label: 'doc = result["contents"][0]  # markdown, pages, tables', col: 0, row: 3, kind: 'code', detail: 'The analyzer returns markdown plus structured content.' },
            { id: 'output', label: 'chunks = split_markdown(doc["markdown"])  # → index / fields / agent', col: 0, row: 4, kind: 'code', detail: 'Downstream use: RAG ingestion, field extraction, agents.' },
          ]),
        ],
        edges: [['upload', 'pre'], ['pre', 'ocr'], ['ocr', 'layout'], ['layout', 'output']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Sample document', type: 'select', options: Object.entries(DOCS).map(([v, d]) => [v, d.label]), default: 'invoice' },
      { id: 'format', label: 'File format', type: 'select', options: [['pdf', 'PDF'], ['jpeg', 'JPEG photo'], ['png', 'PNG'], ['tiff', 'TIFF scan'], ['heic', 'HEIC (iPhone)'], ['pdf-locked', 'Password-protected PDF']], default: 'pdf' },
      { id: 'model', label: 'Analyzer / model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'cu', help: 'Content Understanding is the service named in the AI-103 objectives; the Document Intelligence models are shown for comparison.' },
      { id: 'deskew', label: 'Orientation correction', type: 'toggle', default: true },
      { id: 'enhance', label: 'Denoise / enhance before upload', type: 'toggle', default: false },
      { id: 'threshold', label: 'Confidence threshold', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.8 },
      { id: 'output', label: 'Output format', type: 'select', options: [['json', 'JSON (AnalyzeResult)'], ['markdown', 'Markdown']], default: 'json' },
    ],
    samples: [
      { label: 'Clean invoice, layout, JSON', values: { document: 'invoice' } },
      { label: 'Receipt photo, no orientation correction', values: { document: 'receipt', format: 'jpeg', deskew: false } },
      { label: 'Noisy fax without enhancement', values: { document: 'fax', format: 'tiff' } },
      { label: 'Two-column report with Read only', values: { document: 'report', model: 'read' } },
      { label: 'Handwritten form, markdown', values: { document: 'form', output: 'markdown' } },
    ],
    run: analyze,
  },

  compare: {
    suggestions: [
      'Run the two-column report with prebuilt-read, then with Content Understanding. Compare reading-order errors and tables recovered.',
      'Run the noisy fax with enhancement off, then on. Watch the misread lines (O for 0) disappear and confidence rise.',
      'Run the receipt with orientation correction off, then on, and compare mean confidence.',
      'Run the form with Read, then Layout, and look at what happens to the checkboxes.',
    ],
  },

  debug: [
    { id: 'heic', title: 'Phone upload fails immediately', values: { format: 'heic', document: 'receipt' }, node: 'upload',
      symptom: 'HTTP 400 before any OCR runs.', cause: 'HEIC is not an accepted input type in this lab.', fix: 'Convert to JPEG/PNG/PDF at capture time (choose JPEG photo).' },
    { id: 'locked', title: 'Contract PDF is rejected', values: { format: 'pdf-locked' }, node: 'upload',
      symptom: 'The upload fails with an invalid-content error.', cause: 'The PDF is password-protected, so the service cannot read it.', fix: 'Remove the password upstream and submit a normal PDF.' },
    { id: 'rotated', title: 'Receipt text is garbage-confidence and out of order', values: { document: 'receipt', format: 'jpeg', deskew: false }, node: 'pre',
      symptom: 'Almost every word is below threshold; the order list is reversed.', cause: 'The photo is sideways and was not corrected.', fix: 'Turn orientation correction on.' },
    { id: 'fax', title: 'Fax total reads "1,24O.5O"', values: { document: 'fax', format: 'tiff', enhance: false }, node: 'ocr',
      symptom: 'Numbers contain the letter O; dates do too.', cause: 'A noisy 200 dpi fax makes O/0 and l/1 ambiguous.', fix: 'Enable denoise / enhancement (better: rescan at 300 dpi).' },
    { id: 'columns', title: 'Report paragraphs are interleaved', values: { document: 'report', model: 'read' }, node: 'layout',
      symptom: 'Sentences from column 1 and column 2 alternate; the table is flattened into loose lines.', cause: 'No layout analysis, so no column detection or tables.', fix: 'Use the Content Understanding analyzer (or Document Intelligence prebuilt-layout).' },
    { id: 'markdown', title: 'Markdown requested but the call fails', values: { model: 'read', output: 'markdown' }, node: 'output',
      symptom: 'Output step errors: markdown not available.', cause: 'Markdown output is a layout feature.', fix: 'Use the Content Understanding analyzer or prebuilt-layout (or request plain text).' },
  ],

  challenge: {
    task: 'Ingest the two-column report so it can go into a RAG index: markdown output, every line in human reading order, and the table recovered.',
    condition: 'Document = two-column report, output = markdown, 0 reading-order errors, 1/1 tables recovered, no error steps.',
    hint: 'Which model understands columns and tables, and which one can emit markdown?',
    check: (p, res) => p.document === 'report' && p.output === 'markdown' && !res.steps.some(s => s.status === 'error') && res.metrics.find(m => m.label === 'Reading-order errors').value === '0' && res.metrics.find(m => m.label === 'Tables recovered').value === '1/1',
    solution: ['Choose the two-column report.', 'Choose the Content Understanding analyzer (prebuilt-layout also works): it detects columns, tables and roles.', 'Set output format to Markdown.', 'Run. Headings become #/##, the table becomes a pipe table, and the order list shows "yes" on every row.'],
    solutionValues: { document: 'report', model: 'cu', output: 'markdown', format: 'pdf', deskew: true },
  },

  quiz: [
    { q: 'You index scanned two-column research reports for RAG. Retrieved chunks mix sentences from both columns. What should you change first?', options: ['Lower the confidence threshold', 'Use layout analysis (Content Understanding or prebuilt-layout) so reading order follows columns', 'Increase chunk overlap', 'Use a larger embedding model'], answer: 1, why: 'The text is already wrong before chunking: without layout, lines are not ordered by column.' },
    { q: 'A form has tick boxes for "New" and "Existing" customer. Which output tells you which one is ticked?', options: ['Word confidence', 'Selection marks from layout analysis', 'The page angle', 'The markdown heading level'], answer: 1, why: 'Layout returns selection marks with state selected / unselected.' },
    { q: 'Faxed invoices produce totals like "1,24O.5O". What is the most robust fix?', options: ['Post the value anyway', 'Improve capture (300 dpi, denoise) and validate numeric fields, sending failures to review', 'Switch to prebuilt-read', 'Disable orientation correction'], answer: 1, why: 'Fix the input where you can, and never trust a malformed number: validate and route to review.' },
    { q: 'Your pipeline needs headings and tables preserved as text for an LLM. Which request does that?', options: ['Document Intelligence prebuilt-read with default output', 'A Content Understanding document analyzer, using its markdown output', 'An embedding model on the raw PDF bytes', 'Any OCR call; markdown is always returned'], answer: 1, why: 'Content Understanding returns the document as markdown with headings and tables kept. (Document Intelligence prebuilt-layout can also do this with outputContentFormat=markdown; prebuilt-read cannot.)' },
  ],

  recap: 'Validate the file, fix orientation and noise early, use Read when you only need text and Layout when structure matters (tables, checkboxes, columns, markdown). Measure confidence and reading order before the text flows into extraction or search.',
};
