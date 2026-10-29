// Archetype 1 — Model selection: prebuilt vs custom (template / neural) vs generative.
import { h, s, clear } from '../engine/dom.js';

const DOCS = {
  invoice: { label: 'Supplier invoices', structure: 'semi', standard: true },
  receipt: { label: 'Store receipts', structure: 'semi', standard: true },
  id: { label: 'Passports & driving licences', structure: 'structured', standard: true },
  form: { label: 'Your own intake form (fixed layout)', structure: 'structured', standard: false },
  shipping: { label: 'Shipping manifests from 40 carriers (layouts vary)', structure: 'semi', standard: false },
  contract: { label: 'Multi-page legal contracts', structure: 'unstructured', standard: false },
};

// Decision tree, evaluated in order. Each node: question, test, yes/no target.
function decide(p) {
  const d = DOCS[p.doc];
  const path = [];
  path.push({ q: 'Is it a common document type a prebuilt model already covers?', a: d.standard && !p.custom ? 'yes' : 'no' });
  if (d.standard && !p.custom) return { path, pick: 'prebuilt', why: `${d.label} are covered by a prebuilt model with a fixed field schema — no training needed.` };
  path.push({ q: 'Do you need values that are implied rather than printed (inferred, calculated, summarised)?', a: p.inferred ? 'yes' : 'no' });
  if (p.inferred) return { path, pick: 'generative', why: 'Implied values (e.g. end date = start date + term) need generative extraction: describe the field and let the model reason. No labelled data needed.' };
  path.push({ q: 'Is the content mostly free text rather than forms or tables?', a: d.structure === 'unstructured' ? 'yes' : 'no' });
  if (d.structure === 'unstructured') return { path, pick: 'generative', why: 'Unstructured, multi-page prose has no fixed positions to learn: generative / Content Understanding extraction with field descriptions works zero-shot.' };
  path.push({ q: 'Do you have labelled samples (a handful per layout)?', a: p.labels ? 'yes' : 'no' });
  if (!p.labels) return { path, pick: 'generative', why: 'Without labelled data you cannot train a custom model this sprint; start with generative extraction and field descriptions, label later if needed.' };
  path.push({ q: 'Is the layout fixed (same template every time)?', a: d.structure === 'structured' ? 'yes' : 'no' });
  if (d.structure === 'structured') return { path, pick: 'template', why: 'A fixed layout with labelled samples is the custom template model sweet spot: fast to train, precise positions.' };
  return { path, pick: 'neural', why: 'Labelled samples but layouts that vary between senders: a custom neural model generalises across variations.' };
}

const PICKS = {
  prebuilt: ['Prebuilt model', 'e.g. prebuilt-invoice, prebuilt-receipt, prebuilt-idDocument, W-2'],
  template: ['Custom template model', 'labelled samples, fixed layout'],
  neural: ['Custom neural model', 'labelled samples, varied layouts'],
  generative: ['Generative / Content Understanding', 'field descriptions, zero-shot, inferred values'],
};

function viz() {
  const p = { doc: 'contract', inferred: true, labels: false, custom: false };
  const controls = h('div.bz-controls');
  const sel = h('select', { 'aria-label': 'Document type' }, Object.entries(DOCS).map(([v, d]) => h('option', { value: v, selected: v === p.doc }, d.label)));
  sel.addEventListener('change', () => { p.doc = sel.value; draw(); });
  const tog = (key, label) => { const i = h('input', { type: 'checkbox', checked: p[key] }); i.addEventListener('change', () => { p[key] = i.checked; draw(); }); return h('label.bz-tog', i, ' ', label); };
  controls.append(h('label.bz-field', h('span', 'Documents'), sel),
    tog('inferred', 'Need implied / calculated values'), tog('labels', 'Labelled samples available'), tog('custom', 'Need fields the prebuilt model does not have'));
  const pathEl = h('ol.bz-path');
  const result = h('div.bz-result');
  const picks = h('div.bz-picks');
  function draw() {
    const r = decide(p);
    clear(pathEl);
    r.path.forEach((st, i) => pathEl.appendChild(h(`li.bz-q.${st.a}`, { style: `animation-delay:${i * 0.12}s` }, h('span', st.q), h('strong', st.a.toUpperCase()))));
    clear(picks);
    Object.entries(PICKS).forEach(([k, [name, sub]]) => picks.appendChild(h(`div.bz-pick${k === r.pick ? '.on' : ''}`, h('strong', name), h('span', sub))));
    clear(result).append(h('p', h('strong', `Choose: ${PICKS[r.pick][0]}. `), r.why));
  }
  draw();
  return h('div.bz-viz.bz-model', controls, h('div.bz-model-grid', h('div', h('p.overline', 'Decision path'), pathEl), h('div', h('p.overline', 'Options'), picks)), result);
}

export default {
  id: 'model',
  n: 1,
  title: 'Model selection: prebuilt vs custom vs generative',
  minutes: 9,
  crux: 'Read the document type and the constraints (labelled data, fixed vs varied layout, implied values, deadline), then pick the least effort model that meets them.',
  rules: [
    ['Common document type (invoice, receipt, ID, W-2) and the standard fields are enough', 'Prebuilt model', 'Fixed schema, no training.'],
    ['Your own form, same layout every time, labelled samples available', 'Custom template model', 'Learns field positions from a few labelled samples.'],
    ['Same kind of document but layouts vary across senders, labelled samples available', 'Custom neural model', 'Generalises across layout variations.'],
    ['Unstructured text, implied/calculated values, or no labelled data', 'Generative extraction / Content Understanding', 'Describe the fields; works zero-shot.'],
  ],
  viz,
  questions: [
    { q: 'A legal team needs metadata from unstructured, multi-page contracts, including contract end dates calculated from a start date and a term length. They have no labelled data and must ship this sprint. What should you recommend?',
      options: ['Train a custom template model in Document Intelligence Studio', 'Use the prebuilt-invoice model', 'Use generative extraction / Content Understanding with field descriptions (zero-shot)', 'Train a custom text classification model'], answer: 2,
      why: 'Unstructured text, an inferred value and no labelled data all point to generative extraction. Template models need labelled, fixed layouts; prebuilt-invoice has the wrong schema; classification does not extract values.' },
    { q: 'A hospital scans its own patient intake form. The layout never changes and staff have labelled 10 completed forms. Which model fits best?',
      options: ['Custom template model', 'Custom neural model', 'prebuilt-read', 'prebuilt-invoice'], answer: 0,
      why: 'Fixed proprietary layout plus labelled samples is exactly what a template model is for. Neural is for varied layouts; read only returns text.' },
    { q: 'A logistics company receives shipping manifests from 40 carriers, each with a different layout. They have labelled samples from each carrier and need the same 12 fields from all of them. Which model?',
      options: ['Custom template model per carrier only', 'Custom neural model', 'prebuilt-receipt', 'prebuilt-layout'], answer: 1,
      why: 'Same fields across many varying layouts with labelled data: a neural model generalises. One template per layout would be brittle to maintain (and the classic answer is neural).' },
    { q: 'You need vendor name, totals and due dates from standard supplier invoices as quickly as possible. What is the least effort option?',
      options: ['prebuilt-invoice', 'Custom neural model', 'Generative extraction with a custom schema', 'prebuilt-read plus regular expressions'], answer: 0,
      why: 'A prebuilt model already covers standard invoice fields. Custom or generative options add work you do not need.' },
  ],
  live: [{ label: 'Field extraction lab: prebuilt vs custom analyzer vs LLM', href: '#/s/fields' }],
  takeaway: 'Prebuilt if it is a common document; template if your layout is fixed and labelled; neural if layouts vary and are labelled; generative when text is unstructured, values are implied, or you have no labels.',
};
