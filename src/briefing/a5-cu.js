// Archetype — Content Understanding: analyzers, field methods, grounding, modalities, pro mode.
import { h, clear } from '../engine/dom.js';

// Inputs the learner can analyze. Fields: [name, type, method, categories?, value, confidence, source]
const INPUTS = {
  contract: {
    label: 'Multi-page service contract (PDF)', modality: 'document', base: 'prebuilt-document',
    fields: [
      ['PartyNames', 'array', 'extract', null, 'Contoso Ltd; Fabrikam Inc', 0.95, 'page 1, box (0.8,1.2)–(6.9,1.6)'],
      ['StartDate', 'date', 'extract', null, '2026-01-01', 0.93, 'page 1, box (1.1,2.4)–(3.0,2.6)'],
      ['EndDate', 'date', 'generate', null, '2028-12-31 (start + 36-month term)', 0.84, 'pages 1 and 4 (start date, term clause)'],
      ['ContractType', 'string', 'classify', ['services', 'licence', 'NDA'], 'services', 0.9, 'whole document'],
      ['RiskSummary', 'string', 'generate', null, 'Auto-renews unless cancelled 90 days before end; liability capped at 12 months of fees.', 0.78, 'pages 4, 7'],
    ],
    markdown: '# Master Services Agreement\n## 1. Parties\nContoso Ltd and Fabrikam Inc…\n## 4. Term\nThis agreement runs for 36 months from 1 January 2026…',
  },
  photo: {
    label: 'Photo of a damaged parcel (image)', modality: 'image', base: 'prebuilt-image',
    fields: [
      ['DamageType', 'string', 'classify', ['crushed', 'wet', 'torn', 'none'], 'crushed', 0.88, 'image region (412,180)–(760,520)'],
      ['TrackingNumber', 'string', 'extract', null, 'PX-48213', 0.91, 'image region (95,610)–(330,660) — label text'],
      ['Description', 'string', 'generate', null, 'Cardboard box with a crushed top-right corner; label intact.', 0.8, 'whole image'],
    ],
    markdown: '![image](parcel.jpg)\nA cardboard parcel with a crushed corner. Label text: "PX-48213".',
  },
  call: {
    label: 'Customer call recording (audio)', modality: 'audio', base: 'prebuilt-audio',
    fields: [
      ['RefundAmount', 'number', 'extract', null, '120', 0.94, 'time 00:59.2–01:11.5 (Speaker 1)'],
      ['RefundPromisedBy', 'string', 'generate', null, 'Speaker 1 (agent)', 0.9, 'time 00:59.2–01:11.5'],
      ['Sentiment', 'string', 'classify', ['positive', 'neutral', 'negative'], 'negative', 0.83, 'times 00:06–00:26'],
    ],
    markdown: 'WEBVTT\n00:00.4 --> 00:06.5\n<v Speaker 1>Thanks for calling Northwind Parcels…\n00:59.2 --> 01:11.5\n<v Speaker 1>I’ll refund £120 to your card today…',
  },
  video: {
    label: 'Warehouse safety video (video)', modality: 'video', base: 'prebuilt-video',
    fields: [
      ['IncidentTime', 'string', 'extract', null, '00:29–00:36', 0.86, 'segment 4, keyframe 00:32.5'],
      ['IncidentType', 'string', 'classify', ['fall', 'collision', 'spill', 'none'], 'fall', 0.87, 'segment 4'],
      ['SegmentSummary', 'string', 'generate', null, 'A stacked parcel topples off the belt and is crushed.', 0.82, 'segment 4'],
    ],
    markdown: '## Segment 4 · 00:29.0 – 00:36.0\n![keyframe](keyFrame.32500.jpg)\nDescription: A parcel stacked three high topples off the belt…',
  },
  reconcile: {
    label: 'Invoice + purchase order + contract (several files)', modality: 'document set', base: 'prebuilt-document',
    fields: [
      ['InvoiceQuantity', 'number', 'extract', null, '12', 0.95, 'invoice.pdf p.1'],
      ['POQuantity', 'number', 'extract', null, '10', 0.94, 'po.pdf p.1'],
      ['QuantityMatches', 'boolean', 'generate', null, 'false — invoice bills 12, PO approved 10', 0.86, 'invoice.pdf p.1 + po.pdf p.1'],
      ['PriceWithinContract', 'boolean', 'generate', null, 'true — unit price 95.00 ≤ contract cap 100.00', 0.85, 'invoice.pdf p.1 + contract.pdf p.3'],
    ],
    markdown: '# invoice.pdf\n…Toner XL | 12 | 95.00…\n# po.pdf\n…Toner XL | 10 | approved…',
  },
};

function analyze(p) {
  const inp = INPUTS[p.input];
  const issues = [];
  let fields = inp.fields.map(([name, type, method, cats, value, conf, source]) => ({ name, type, method, cats, value, conf, source }));
  if (p.dropCategories) {
    const f = fields.find(x => x.method === 'classify');
    if (f) return { error: `Analyzer rejected: field "${f.name}" uses the classify method but defines no categories (enum).`, fix: 'Classify picks one of a fixed set of categories, so the field needs an enum, e.g. ' + JSON.stringify(f.cats) + '.' };
  }
  if (p.input === 'reconcile' && p.mode === 'single') {
    fields = fields.map(f => (f.method === 'generate' ? { ...f, value: null, conf: 0, source: null, note: 'needs reasoning across several files' } : f));
    issues.push(['warn', 'Single-task mode analyzes one input at a time, so the cross-document checks come back empty. The quantity mismatch is missed.']);
  }
  if (p.input !== 'reconcile' && p.mode === 'pro') issues.push(['info', 'Pro mode works, but it is slower and costs more. A single input like this does not need cross-document reasoning.']);
  if (!p.grounding) {
    fields = fields.map(f => ({ ...f, source: null, conf: null }));
    issues.push(['warn', 'No source or confidence returned: reviewers and agents cannot cite where a value came from.']);
  }
  return { fields, issues, markdown: inp.markdown };
}

function viz() {
  const p = { input: 'contract', grounding: true, mode: 'single', dropCategories: false };
  const sel = h('select', { 'aria-label': 'Input' }, Object.entries(INPUTS).map(([v, d]) => h('option', { value: v }, d.label)));
  sel.addEventListener('change', () => { p.input = sel.value; draw(); });
  const tog = (key, label) => { const i = h('input', { type: 'checkbox', checked: p[key] }); i.addEventListener('change', () => { p[key] = i.checked; draw(); }); return h('label.bz-tog', i, ' ', label); };
  const modeSel = h('select', { 'aria-label': 'Mode' }, h('option', { value: 'single' }, 'Single-task (one input)'), h('option', { value: 'pro' }, 'Pro mode (several inputs + reasoning)'));
  modeSel.addEventListener('change', () => { p.mode = modeSel.value; draw(); });
  const controls = h('div.bz-controls',
    h('label.bz-field', h('span', 'Input'), sel),
    h('label.bz-field', h('span', 'Mode'), modeSel),
    tog('grounding', 'Return source & confidence (grounding)'),
    tog('dropCategories', 'Remove the categories from the classify field'));
  const defEl = h('pre.code.bz5-def');
  const outEl = h('div.bz5-out');
  function draw() {
    const inp = INPUTS[p.input];
    const def = { baseAnalyzerId: inp.base, ...(p.mode === 'pro' ? { mode: 'pro' } : {}), config: { estimateFieldSourceAndConfidence: p.grounding, returnDetails: true },
      fieldSchema: { fields: Object.fromEntries(inp.fields.map(([n, t, m, cats]) => [n, { type: t, method: m, ...(m === 'classify' && !p.dropCategories ? { enum: cats } : {}) }])) } };
    defEl.textContent = 'PUT …/contentunderstanding/analyzers/my-analyzer  (illustrative)\n' + JSON.stringify(def, null, 2);
    const r = analyze(p);
    clear(outEl);
    if (r.error) { outEl.append(h('div.alert.tone-error', h('strong', 'HTTP 400. '), r.error), h('p.small', h('strong', 'Fix: '), r.fix)); return; }
    outEl.append(
      h('div.table-wrap', h('table.bz5-fields', h('thead', h('tr', h('th', 'Field'), h('th', 'Method'), h('th', 'Value'), h('th', 'Confidence'), h('th', 'Source'))),
        h('tbody', r.fields.map(f => h(`tr${f.value == null ? '.miss' : ''}`,
          h('td', h('strong', f.name)), h('td', h(`span.bz5-m.m-${f.method}`, f.method)),
          h('td', f.value == null ? h('span.small', f.note || '—') : f.value),
          h('td.mono', f.conf == null ? '—' : f.conf.toFixed(2)),
          h('td.small', f.source || '—')))))),
      ...r.issues.map(([tone, t]) => h(`div.alert.tone-${tone}`, t)),
      h('details.bz5-md', h('summary', 'Markdown output (for RAG and agents)'), h('pre.code', r.markdown)));
  }
  draw();
  return h('div.bz-viz.bz5', controls, h('div.bz5-grid', h('div', h('p.overline', 'Analyzer definition'), defEl), h('div', h('p.overline', 'Result'), outEl)));
}

export default {
  id: 'cu',
  n: 5,
  title: 'Content Understanding: analyzers, field methods and grounding',
  minutes: 11,
  crux: 'Content Understanding is the generative, multimodal option: you define an analyzer (base analyzer + field schema), choose a method per field, turn on grounding for citations, and use pro mode only when the answer needs reasoning across several inputs.',
  rules: [
    ['Values must be inferred or written (end date from term, a summary), no labelled data', 'Content Understanding analyzer, generate method', 'Generative extraction from field descriptions, zero-shot.'],
    ['Pick one label from a fixed list (contract type, damage type)', 'classify method with categories (enum)', 'A classify field without categories is rejected.'],
    ['Copy a value exactly as written (invoice number, amount)', 'extract method', 'Returns the literal value, with its location when grounding is on.'],
    ['Images, audio or video as well as documents', 'Content Understanding analyzer for that modality', 'Prebuilt base analyzers per modality; one schema style across them.'],
    ['Users or agents must cite where a value came from', 'Grounding: source and confidence on', 'Each field returns a page box, image region or time range.'],
    ['Check facts across several files (invoice vs PO vs contract)', 'Pro mode', 'Reasons over multiple inputs and reference data; slower and costlier than single-task.'],
  ],
  viz,
  questions: [
    { q: 'An insurer needs the damage type of each claim photo as one of crushed, wet, torn or none, plus a one-sentence description. No labelled images exist. What should you configure?',
      options: ['A custom neural model trained in Document Intelligence', 'A Content Understanding image analyzer: DamageType with classify and categories, Description with generate', 'prebuilt-read on the photos', 'An Azure AI Search skillset with OCR only'], answer: 1,
      why: 'Content Understanding handles images and generates values without labelled data; classify needs the category list, generate writes the description.' },
    { q: 'Your analyzer fails to create with a 400 error on the field "ContractType: string, method classify". What is the most likely cause?',
      options: ['The base analyzer is wrong', 'The classify field has no categories (enum) defined', 'Grounding is turned off', 'The field should use the extract method instead'], answer: 1,
      why: 'Classify chooses from a fixed set, so the field must list its categories.' },
    { q: 'An accounts team must confirm that each invoice matches its purchase order and stays within contract prices before payment. Which Content Understanding setup fits?',
      options: ['Single-task analyzer on the invoice only', 'Pro mode with the invoice, PO and contract as inputs and fields that check consistency', 'prebuilt-invoice with a higher confidence threshold', 'A classification analyzer with an "other" category'], answer: 1,
      why: 'Cross-document validation needs reasoning over several inputs; that is what pro mode is for. Single-task analyzes one input at a time.' },
    { q: 'A RAG agent built on Content Understanding output gives correct answers but compliance rejects them because nobody can see where each value came from. What should you change?',
      options: ['Lower the temperature of the chat model', 'Turn on source and confidence estimation (grounding) in the analyzer and pass the sources to the agent', 'Switch the analyzer to prebuilt-read', 'Add more fields to the schema'], answer: 1,
      why: 'Grounding returns the page box, image region or time range for each field, so answers can cite their evidence.' },
  ],
  live: [{ label: 'Field extraction lab (custom analyzer)', href: '#/s/fields' }, { label: 'Multimodal lab (image, audio, video)', href: '#/s/multimodal' }],
  takeaway: 'Content Understanding = one analyzer per input type with a field schema: extract what is written, classify into a fixed list, generate what must be inferred; switch grounding on for citations and use pro mode only for cross-document checks.',
};
