// 5.2.1 Extract information by using multimodal pipelines that combine OCR, layout analysis, and field extraction
// Lab: Document processing workbench.
import { rng, clamp, round, step, metric, hasError } from '../src/engine/util.js';

// Sample documents. Coordinates are on a 100 x 130 "page" grid used by the doc renderer.
// conf = baseline OCR confidence for a clean, upright scan.
const DOCS = {
  invoice: {
    label: 'Invoice (clean PDF, 1 page)',
    quality: 1, rotated: 0,
    regions: [
      { id: 'r1', x: 6, y: 5, w: 40, h: 7, text: 'CONTOSO SUPPLIES LTD', role: 'title', conf: 0.99 },
      { id: 'r2', x: 64, y: 5, w: 30, h: 5, text: 'INVOICE INV-10442', role: 'line', conf: 0.98 },
      { id: 'r3', x: 64, y: 11, w: 30, h: 4, text: 'Date: 2026-09-14', role: 'line', conf: 0.97 },
      { id: 'r4', x: 6, y: 20, w: 40, h: 4, text: 'Bill to: Fabrikam Retail', role: 'line', conf: 0.97 },
      { id: 'r5', x: 6, y: 25, w: 40, h: 4, text: '12 Harbour Rd, Leeds', role: 'line', conf: 0.95 },
      { id: 't1', x: 6, y: 38, w: 88, h: 30, text: 'Item | Qty | Price\nPaper A4 | 10 | 45.00\nToner XL | 2 | 180.00', role: 'table', conf: 0.94,
        cells: [['Item', 'Qty', 'Price'], ['Paper A4', '10', '45.00'], ['Toner XL', '2', '180.00']] },
      { id: 'r6', x: 60, y: 74, w: 34, h: 4, text: 'Subtotal: 225.00', role: 'line', conf: 0.96 },
      { id: 'r7', x: 60, y: 79, w: 34, h: 4, text: 'VAT 20%: 45.00', role: 'line', conf: 0.95 },
      { id: 'r8', x: 60, y: 85, w: 34, h: 5, text: 'TOTAL DUE: GBP 270.00', role: 'line', conf: 0.97 },
      { id: 'r9', x: 6, y: 116, w: 60, h: 4, text: 'Payment within 30 days', role: 'footer', conf: 0.93 },
    ],
  },
  receipt: {
    label: 'Receipt photo (rotated ~90°)',
    quality: 0.85, rotated: 90,
    regions: [
      { id: 'r1', x: 20, y: 6, w: 60, h: 6, text: 'NORTHWIND CAFE', role: 'title', conf: 0.95 },
      { id: 'r2', x: 20, y: 14, w: 60, h: 4, text: '2026-10-02 08:41', role: 'line', conf: 0.9 },
      { id: 'r3', x: 20, y: 24, w: 60, h: 4, text: 'Flat white   3.40', role: 'line', conf: 0.9 },
      { id: 'r4', x: 20, y: 29, w: 60, h: 4, text: 'Croissant    2.60', role: 'line', conf: 0.88 },
      { id: 'r5', x: 20, y: 40, w: 60, h: 5, text: 'TOTAL        6.00', role: 'line', conf: 0.92 },
      { id: 'r6', x: 20, y: 48, w: 60, h: 4, text: 'VISA ****4417', role: 'line', conf: 0.87 },
    ],
  },
  fax: {
    label: 'Low-quality fax (noisy, 200 dpi)',
    quality: 0.55, rotated: 0,
    regions: [
      { id: 'r1', x: 6, y: 6, w: 50, h: 6, text: 'ADATUM LOGISTICS', role: 'title', conf: 0.9 },
      { id: 'r2', x: 60, y: 6, w: 34, h: 5, text: 'INVOICE A-7731', role: 'line', conf: 0.86 },
      { id: 'r3', x: 60, y: 12, w: 34, h: 4, text: 'Date: 2026-08-30', role: 'line', conf: 0.82, noisy: 'Date: 2O26-O8-3O' },
      { id: 'r4', x: 6, y: 22, w: 44, h: 4, text: 'Bill to: Litware Inc', role: 'line', conf: 0.84 },
      { id: 'r8', x: 56, y: 70, w: 38, h: 5, text: 'TOTAL DUE: USD 1,240.50', role: 'line', conf: 0.8, noisy: 'TOTAL DUE: USD 1,24O.5O' },
    ],
  },
  purchaseOrder: {
    label: 'Purchase order (multi-column table)',
    quality: 0.95, rotated: 0,
    regions: [
      { id: 'r1', x: 6, y: 5, w: 50, h: 6, text: 'PURCHASE ORDER PO-5521', role: 'title', conf: 0.98 },
      { id: 'r2', x: 6, y: 13, w: 40, h: 4, text: 'Vendor: Proseware', role: 'line', conf: 0.96 },
      { id: 't1', x: 6, y: 24, w: 88, h: 48, text: 'SKU | Description | Qty | Unit | Amount\nPS-01 | Router | 4 | 120.00 | 480.00\nPS-07 | Switch 24p | 2 | 310.00 | 620.00\nPS-11 | Patch cable | 50 | 2.10 | 105.00', role: 'table', conf: 0.93,
        cells: [['SKU', 'Description', 'Qty', 'Unit', 'Amount'], ['PS-01', 'Router', '4', '120.00', '480.00'], ['PS-07', 'Switch 24p', '2', '310.00', '620.00'], ['PS-11', 'Patch cable', '50', '2.10', '105.00']] },
      { id: 'r8', x: 56, y: 78, w: 38, h: 5, text: 'TOTAL: 1,205.00', role: 'line', conf: 0.96 },
    ],
  },
};

// Field schema per extraction approach. pattern -> regex over region text; group 1 is the value.
const FIELDS = {
  InvoiceId: { type: 'string', pattern: /(?:INVOICE|ORDER)\s+([A-Z]+-?[0-9O]+)/ },
  InvoiceDate: { type: 'date', pattern: /(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?|[0-9O]{4}-[0-9O]{2}-[0-9O]{2})/ },
  VendorName: { type: 'string', fromRole: 'title' },
  CustomerName: { type: 'string', pattern: /Bill to:\s*(.+)/ },
  InvoiceTotal: { type: 'number', pattern: /TOTAL(?: DUE)?:?\s*(?:[A-Z]{3}\s*)?([0-9O,]+\.[0-9O]{2})/ },
  Items: { type: 'array', fromRole: 'table' },
};

const MODELS = {
  read: { label: 'prebuilt-read (OCR only)', layout: false, fields: false },
  layout: { label: 'prebuilt-layout (OCR + tables + structure)', layout: true, fields: false },
  invoice: { label: 'prebuilt-invoice (OCR + layout + fields)', layout: true, fields: true },
};

function analyze(p) {
  const doc = DOCS[p.document];
  const model = MODELS[p.model];
  const r = rng(`${p.document}|${p.model}|${p.deskew}|${p.enhance}`);
  const steps = [];
  const required = p.required.split(',').map(s => s.trim()).filter(Boolean);

  // 1. Upload / request validation
  if (p.format === 'heic') {
    steps.push(step('upload', 'Upload rejected', 'HEIC is not a supported input format for this analyzer. Supported: PDF, JPEG/JPG, PNG, BMP, TIFF, HEIF (service-dependent; check the docs for your API version).', { format: p.format, httpStatus: 400, code: 'InvalidRequest / UnsupportedMediaType' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'The request never reached OCR. Convert the file or choose a supported format.' }], metrics: [], summary: 'Rejected at upload (unsupported format)' };
  }
  steps.push(step('upload', 'Document received', `${doc.label} • ${p.format.toUpperCase()}`, { pages: 1, format: p.format, apiVersion: '(illustrative)' }));

  // 2. Pre-processing
  let rotationPenalty = 0;
  let readingOrderBroken = false;
  if (doc.rotated && !p.deskew) {
    rotationPenalty = 0.25; readingOrderBroken = true;
    steps.push(step('pre', 'Page orientation not corrected', `Page is rotated ${doc.rotated}°. In this simulation, with orientation correction off, lines are read in the wrong order and confidence drops.`, { rotation: doc.rotated, deskew: false }, 'warn'));
  } else {
    steps.push(step('pre', 'Pre-processing', doc.rotated ? `Detected ${doc.rotated}° rotation and normalised it.` : 'Page is upright; no correction needed.', { rotation: doc.rotated, deskew: p.deskew, enhance: p.enhance }));
  }

  // 3. OCR
  const qualityPenalty = (1 - doc.quality) * (p.enhance ? 0.25 : 0.6);
  const lines = doc.regions.map((reg, i) => {
    const noise = (r() - 0.5) * 0.04;
    const conf = clamp(round(reg.conf - qualityPenalty - rotationPenalty + noise, 2), 0.05, 0.99);
    const text = reg.noisy && !p.enhance ? reg.noisy : reg.text;
    return { ...reg, text, conf, order: readingOrderBroken ? doc.regions.length - i : i + 1 };
  });
  const lowConf = lines.filter(l => l.conf < p.threshold);
  steps.push(step('ocr', 'OCR complete', `${lines.length} text regions recognised. ${lowConf.length} below the ${p.threshold} confidence threshold.`,
    { lines: lines.map(l => ({ text: l.text.split('\n')[0], confidence: l.conf })) }, lowConf.length > lines.length / 2 ? 'warn' : 'ok'));

  // 4. Layout
  let tables = [];
  if (model.layout) {
    tables = lines.filter(l => l.role === 'table');
    steps.push(step('layout', 'Layout analysis', `Detected ${tables.length} table(s), title/footer roles and reading order${readingOrderBroken ? ' (order is unreliable: page was not deskewed)' : ''}.`,
      { tables: tables.map(t => ({ rows: t.cells.length, columns: t.cells[0].length })), roles: [...new Set(lines.map(l => l.role))] }, readingOrderBroken ? 'warn' : 'ok'));
  } else {
    steps.push(step('layout', 'Layout skipped', `${model.label} returns lines and words only: no tables, no roles. Table text arrives as flat lines.`, { tables: 0 }, 'skip'));
  }

  // 5. Field extraction
  const fields = {};
  if (model.fields) {
    for (const [name, def] of Object.entries(FIELDS)) {
      let src = null, value = null;
      if (def.fromRole) {
        src = lines.find(l => l.role === def.fromRole);
        if (src) value = def.type === 'array' ? src.cells.slice(1).map(row => Object.fromEntries(src.cells[0].map((h, i) => [h, row[i]]))) : src.text;
      } else {
        for (const l of lines) { const m = l.text.match(def.pattern); if (m) { src = l; value = m[1]; break; } }
      }
      if (value && /O/.test(value) && def.type !== 'string') value = { raw: value, note: 'contains letter O where a digit is expected' };
      fields[name] = { value, confidence: src ? round(src.conf - 0.02, 2) : 0, source: src ? src.id : null, type: def.type };
    }
    steps.push(step('fields', 'Field extraction', `Mapped evidence to ${Object.values(fields).filter(f => f.value).length}/${Object.keys(FIELDS).length} schema fields.`, fields));
  } else {
    steps.push(step('fields', 'No field extraction', 'This model does not produce a field schema. You would need your own parsing, a prebuilt model, or a Content Understanding analyzer.', null, required.length ? 'warn' : 'skip'));
  }

  // 6. Validation
  const issues = [];
  for (const req of required) {
    const f = fields[req];
    if (!model.fields) { issues.push({ field: req, problem: 'not produced by this model' }); continue; }
    if (!f || !f.value) issues.push({ field: req, problem: 'missing' });
    else if (typeof f.value === 'object' && f.value.raw) issues.push({ field: req, problem: 'malformed value: ' + f.value.raw });
    else if (f.confidence < p.threshold) issues.push({ field: req, problem: `low confidence ${f.confidence}` });
  }
  const status = issues.length === 0 ? 'ok' : issues.some(i => /missing|not produced|malformed/.test(i.problem)) ? 'error' : 'warn';
  steps.push(step('validate', status === 'ok' ? 'Validation passed' : status === 'warn' ? 'Sent to human review queue' : 'Validation failed',
    issues.length ? issues.map(i => `${i.field}: ${i.problem}`).join('; ') : 'All required fields present, well-formed and above threshold.', { issues }, status));

  // Output
  const output = [
    { type: 'doc', title: `Page 1 – ${doc.label}`, width: 100, height: 130, rotated: doc.rotated && !p.deskew ? doc.rotated : 0, showBoxes: p.boxes, showOrder: true,
      regions: lines.map(l => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h, text: l.text, conf: l.conf, label: l.role, order: l.order, tone: l.conf < p.threshold ? 'warn' : 'ok' })) },
  ];
  if (model.fields) {
    output.push({ type: 'table', title: 'Extracted fields (click a row to see its evidence on the page)', columns: ['Field', 'Value', 'Confidence', 'Evidence'],
      rows: Object.entries(fields).map(([k, f]) => [k, f.value == null ? '—' : typeof f.value === 'object' ? JSON.stringify(f.value) : f.value, f.confidence ? f.confidence.toFixed(2) : '—', f.source || '—']),
      tones: Object.values(fields).map(f => !f.value ? 'error' : f.confidence < p.threshold || (typeof f.value === 'object' && f.value.raw) ? 'warn' : 'ok'),
      links: Object.values(fields).map(f => f.source) });
  }
  if (tables.length) output.push({ type: 'table', title: 'Detected table', columns: tables[0].cells[0], rows: tables[0].cells.slice(1) });
  output.push({ type: 'json', title: 'Analyze result (abridged, simulated shape)', data: {
    status: 'succeeded', modelId: `prebuilt-${p.model}`,
    pages: [{ pageNumber: 1, angle: doc.rotated && !p.deskew ? doc.rotated : 0, lines: lines.length }],
    tables: tables.length, documents: model.fields ? [{ docType: 'invoice', fields: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { value: f.value, confidence: f.confidence }])) }] : [],
  } });
  if (issues.length) output.push({ type: 'alert', tone: status === 'error' ? 'error' : 'warn', text: status === 'error' ? 'Document cannot be auto-approved. Fix the configuration or route to manual entry.' : 'Document goes to the human review queue: values exist but confidence is below your threshold.' });

  const avg = lines.reduce((a, l) => a + l.conf, 0) / lines.length;
  return {
    steps, output,
    metrics: [
      metric('Mean OCR confidence', avg.toFixed(2), 'computed', 'Average of simulated line confidences.'),
      metric('Required fields OK', `${required.length - issues.length}/${required.length}`, 'computed'),
      metric('Lines under threshold', String(lowConf.length), 'computed'),
      metric('Relative processing cost', model.fields ? 'highest' : model.layout ? 'medium' : 'lowest', 'estimate', 'Read < Layout < prebuilt models in list price per page. Check the current pricing page; prices are not reproduced here.'),
    ],
    summary: `${MODELS[p.model].label}: ${issues.length ? issues.length + ' issue(s)' : 'clean'} • mean conf ${avg.toFixed(2)}`,
  };
}

export default {
  id: '5.2.1',
  lab: 'Document processing workbench',
  services: [
    { name: 'Azure Document Intelligence in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/' },
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
  ],
  prereqs: ['1.1.1'],
  next: ['5.2.2', '5.2.3', '5.1.4'],

  concept: {
    plain: 'A scanned invoice is just pixels. To use it in software you first read the characters (OCR), then work out how they are arranged on the page (layout: headings, tables, reading order), and finally pick out the specific values you care about (fields such as the total or the invoice number). Each stage builds on the one before, so a problem early on — a rotated photo, a noisy fax — shows up as wrong or missing values at the end.',
    technical: 'Azure Document Intelligence exposes this pipeline as models: prebuilt-read returns pages, lines, words and per-word confidence; prebuilt-layout adds tables, selection marks, paragraph roles and reading order; prebuilt domain models (invoice, receipt, ID…) and custom extraction models add a typed field schema where each field carries a value, a confidence and bounding regions linking back to the source text. Content Understanding analyzers offer the same OCR + layout foundation with a declarative field schema. Production pipelines validate required fields and route low-confidence results to human review instead of trusting them blindly.',
    useCase: 'An accounts-payable team receives 4,000 supplier invoices a month as PDFs, phone photos and faxes. Clean PDFs are auto-posted to the ERP; anything with a missing total or a low-confidence date goes to a review queue where a clerk sees the highlighted evidence and corrects it.',
    terms: [
      ['OCR', 'Optical character recognition: converting pixels to text with a confidence per word/line.'],
      ['Layout', 'Structure on top of OCR: tables, cells, paragraphs, roles (title, footer), selection marks, reading order.'],
      ['Field', 'A named, typed value from a schema (InvoiceTotal: number) with confidence and source bounding regions.'],
      ['Bounding region', 'Polygon on a page that locates the evidence for a line, word or field.'],
    ],
  },

  visual: {
    views: {
      conceptual: () => ({
        nodes: [
          { id: 'upload', label: 'Document', col: 0, row: 1, detail: 'Input file: PDF, image or TIFF. Format and size limits are enforced before any analysis.' },
          { id: 'pre', label: 'Pre-process', col: 1, row: 1, detail: 'Orientation detection, de-skew, noise handling.', substeps: ['Detect angle', 'Rotate to upright', 'Normalise contrast'] },
          { id: 'ocr', label: 'OCR', col: 2, row: 1, detail: 'Recognises lines and words; every item has a confidence score and a polygon.', substeps: ['Text detection', 'Character recognition', 'Confidence scoring'] },
          { id: 'layout', label: 'Layout', col: 3, row: 0, detail: 'Groups text into structure: tables, cells, paragraphs, roles, reading order.', substeps: ['Table detection', 'Cell assignment', 'Role tagging', 'Reading order'] },
          { id: 'fields', label: 'Field extraction', col: 3, row: 2, detail: 'Maps evidence to a typed schema (prebuilt, custom or analyzer-defined).', substeps: ['Schema match', 'Type normalisation', 'Field confidence'] },
          { id: 'validate', label: 'Validate & route', col: 4, row: 1, detail: 'Your code: required fields, types, thresholds. Decides auto-approve vs human review.' },
        ],
        edges: [['upload', 'pre'], ['pre', 'ocr'], ['ocr', 'layout'], ['ocr', 'fields'], ['layout', 'fields'], ['fields', 'validate']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'upload', label: 'Blob Storage', col: 0, row: 1, kind: 'store', detail: 'Incoming documents land in a container; an Event Grid event triggers processing.' },
          { id: 'pre', label: 'Function / Logic App', col: 1, row: 1, kind: 'compute', detail: 'Calls the analyze API with the blob URL (or bytes) using a managed identity.' },
          { id: 'ocr', label: `Document Intelligence: ${p ? MODELS[p.model].label : 'model'}`, col: 2, row: 1, kind: 'ai', detail: 'One analyze call runs OCR (+layout +fields depending on model). Long-running operation: POST then poll the Operation-Location.' },
          { id: 'layout', label: 'Layout output', col: 3, row: 0, kind: 'data', disabled: p && !MODELS[p.model].layout, detail: 'Tables/roles present only for layout-capable models.' },
          { id: 'fields', label: 'Field output', col: 3, row: 2, kind: 'data', disabled: p && !MODELS[p.model].fields, detail: 'Typed fields present only for prebuilt domain or custom models.' },
          { id: 'validate', label: 'Review queue / ERP', col: 4, row: 1, kind: 'app', detail: 'Validated results go to the ERP; low confidence to a human review app.' },
        ],
        edges: [['upload', 'pre', 'event'], ['pre', 'ocr', 'analyze'], ['ocr', 'layout'], ['ocr', 'fields'], ['layout', 'validate'], ['fields', 'validate']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'upload', label: 'client = DocumentIntelligenceClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'Keyless auth with Microsoft Entra ID.' },
          { id: 'ocr', label: `poller = client.begin_analyze_document("prebuilt-${p ? p.model : 'invoice'}", body)`, col: 0, row: 1, kind: 'code', detail: 'Long-running operation.' },
          { id: 'layout', label: 'result = poller.result()  # pages, tables, documents', col: 0, row: 2, kind: 'code', detail: 'AnalyzeResult object.' },
          { id: 'fields', label: 'f = result.documents[0].fields["InvoiceTotal"]', col: 0, row: 3, kind: 'code', detail: 'Each field has value_*, confidence, bounding_regions.' },
          { id: 'validate', label: 'if f.confidence < THRESHOLD: send_to_review(f)', col: 0, row: 4, kind: 'code', detail: 'Your business rule.' },
        ],
        edges: [['upload', 'ocr'], ['ocr', 'layout'], ['layout', 'fields'], ['fields', 'validate']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Sample document', type: 'select', options: Object.entries(DOCS).map(([v, d]) => [v, d.label]), default: 'invoice' },
      { id: 'format', label: 'File format', type: 'select', options: [['pdf', 'PDF'], ['jpeg', 'JPEG'], ['png', 'PNG'], ['heic', 'HEIC (unsupported)']], default: 'pdf' },
      { id: 'model', label: 'Analysis model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'invoice' },
      { id: 'deskew', label: 'Orientation correction', type: 'toggle', default: true, help: 'The real service detects page angle; this switch lets you see what happens without correction.' },
      { id: 'enhance', label: 'Image enhancement before upload', type: 'toggle', default: false },
      { id: 'threshold', label: 'Confidence threshold', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.8 },
      { id: 'required', label: 'Required fields (comma-separated)', type: 'text', default: 'InvoiceId,InvoiceTotal,InvoiceDate' },
      { id: 'boxes', label: 'Show bounding boxes', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Clean invoice, full pipeline', values: { document: 'invoice', model: 'invoice', deskew: true } },
      { label: 'Rotated receipt photo', values: { document: 'receipt', model: 'invoice', deskew: false, required: 'InvoiceTotal' } },
      { label: 'Noisy fax', values: { document: 'fax', model: 'invoice', enhance: false } },
      { label: 'Table-heavy purchase order with OCR only', values: { document: 'purchaseOrder', model: 'read', required: 'Items' } },
    ],
    run: analyze,
  },

  compare: {
    suggestions: [
      'Run the purchase order with prebuilt-read, then prebuilt-layout, then prebuilt-invoice and compare tables and fields.',
      'Run the noisy fax with enhancement off and on and compare mean OCR confidence.',
      'Move the threshold from 0.6 to 0.9 on the fax and watch the review-queue decision flip.',
    ],
  },

  debug: [
    { id: 'format', title: 'Upload fails immediately', values: { format: 'heic', document: 'invoice', model: 'invoice' }, node: 'upload',
      symptom: 'HTTP 400 before any analysis runs.', cause: 'The file type is not supported by the analyzer.', fix: 'Convert to PDF/JPEG/PNG/TIFF before calling the API (set File format to PDF).' },
    { id: 'rotate', title: 'Receipt total has low confidence and wrong reading order', values: { document: 'receipt', deskew: false, model: 'invoice', required: 'InvoiceTotal', threshold: 0.8 }, node: 'pre',
      symptom: 'Lines appear in reverse order; confidence well below threshold; result routed to review.', cause: 'The photo was taken sideways and orientation was not corrected.', fix: 'Enable orientation correction (the real service reports page angle; correct at capture or pre-processing time).' },
    { id: 'tables', title: 'Line items are missing', values: { document: 'purchaseOrder', model: 'read', required: 'Items' }, node: 'layout',
      symptom: 'Validation says Items is "not produced by this model".', cause: 'prebuilt-read is OCR only: no tables and no field schema.', fix: 'Use prebuilt-layout to get tables, or prebuilt-invoice / a custom model to get typed Items.' },
    { id: 'malformed', title: 'Total contains letters', values: { document: 'fax', model: 'invoice', enhance: false, required: 'InvoiceTotal,InvoiceDate' }, node: 'ocr',
      symptom: 'InvoiceTotal is "1,24O.5O" – letter O instead of zero.', cause: 'Low scan quality makes O/0 ambiguous. Downstream type parsing fails.', fix: 'Improve capture quality (try image enhancement) and add type validation that routes malformed numbers to review instead of posting them.' },
  ],

  challenge: {
    task: 'Configure the pipeline so the noisy fax passes validation for InvoiceId and InvoiceTotal with a confidence threshold of at least 0.6, without anything going to the review queue.',
    condition: 'Document = Noisy fax, threshold ≥ 0.6, required fields include InvoiceId and InvoiceTotal, final step status = passed.',
    hint: 'Look at what the noise does to the digits, and at which control reduces that effect.',
    check: (p, res) => p.document === 'fax' && p.threshold >= 0.6 && /InvoiceId/.test(p.required) && /InvoiceTotal/.test(p.required) && res.steps.at(-1).status === 'ok',
    solution: ['Select the Noisy fax and prebuilt-invoice.', 'Turn Image enhancement on: in this simulation it reduces the confidence penalty and restores O→0 in numbers.', 'Set the threshold to 0.6 or 0.65.', 'Required fields: InvoiceId,InvoiceTotal. Run. If a value is still malformed, that is the point: real pipelines must route it to review rather than lowering the bar further.'],
    solutionValues: { document: 'fax', model: 'invoice', enhance: true, threshold: 0.6, required: 'InvoiceId,InvoiceTotal', deskew: true, format: 'pdf' },
  },

  quiz: [
    { q: 'You need the rows of a purchase-order table as structured cells, but you do not need named fields. Which model is the most appropriate minimum?', options: ['prebuilt-read', 'prebuilt-layout', 'prebuilt-invoice', 'A custom classification model'], answer: 1, why: 'Layout adds tables and cells on top of OCR. Read has no tables; invoice adds a field schema you do not need.' },
    { q: 'An extracted InvoiceTotal has confidence 0.62 and your threshold is 0.8. What is the recommended handling?', options: ['Post it anyway; the value exists', 'Discard the document', 'Route it to human review with the bounding region highlighted', 'Re-run the same request until the confidence improves'], answer: 2, why: 'Low confidence means uncertain, not wrong. Human-in-the-loop review with the evidence location is the standard pattern. Re-running the same input returns the same result.' },
    { q: 'Which part of a field result lets a reviewer see where on the page a value came from?', options: ['confidence', 'bounding regions / spans', 'docType', 'modelId'], answer: 1, why: 'Bounding regions (polygons + page number) and spans link the field to its source evidence.' },
  ],

  recap: 'OCR gives text and confidence; layout gives structure; field extraction gives typed values with evidence. Choose the cheapest model that produces what you need, fix capture problems (rotation, noise) upstream, and never auto-approve values that are missing, malformed or below threshold.',
};
