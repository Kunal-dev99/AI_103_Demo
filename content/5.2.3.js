// 5.2.3 Implement analyzers for generating structured or markdown outputs for downstream reasoning by using Content Understanding
// Lab: Custom analyzer designer.
import { step, metric, words } from '../src/engine/util.js';

// Sample inputs. Candidate values per type carry "kw" hint words; the simulated extractor picks the
// candidate whose hints best match the field name + description. `signals` drive classification.
const SAMPLES = {
  invoicePdf: {
    label: 'Supplier invoice (PDF)', kind: 'document',
    markdown: '# INVOICE INV-2291\n\nFrom: **Northwind Traders**  \nBill to: **Contoso Ltd**\n\nInvoice date: 2026-10-01  \nPayment due: 2026-11-30\n\n| Item | Amount |\n| --- | --- |\n| Managed backup, October | 1,840.00 GBP |\n\nTotal due: 1,840.00 GBP',
    strings: [{ v: 'Contoso Ltd', kw: ['customer', 'bill', 'billed', 'buyer', 'recipient', 'client'] }, { v: 'Northwind Traders', kw: ['vendor', 'supplier', 'seller', 'sender', 'from', 'issuer'] }, { v: 'INV-2291', kw: ['invoice', 'id', 'number', 'reference'] }],
    dates: [{ v: '2026-10-01', kw: ['invoice', 'issue', 'issued', 'created'] }, { v: '2026-11-30', kw: ['due', 'payment', 'pay', 'deadline', 'paid'] }],
    numbers: [{ v: 1840, kw: ['total', 'amount', 'due', 'value', 'sum'] }],
    signals: ['billing', 'finance', 'low', 'invoice'],
    summary: 'Northwind Traders invoices Contoso Ltd 1,840.00 GBP for October managed backup, due 2026-11-30.',
    truth: { due: '2026-11-30', category: 'billing' },
  },
  emailBilling: {
    label: 'Customer email: double charge', kind: 'document',
    markdown: 'Subject: Charged twice for October\n\nHi, our card was charged twice for invoice INV-2291. Please refund the duplicate payment before 2026-11-05 or we will open a dispute.\n\nDana, Contoso Ltd',
    strings: [{ v: 'Contoso Ltd', kw: ['customer', 'sender', 'client', 'company', 'from'] }, { v: 'INV-2291', kw: ['invoice', 'id', 'number', 'reference'] }],
    dates: [{ v: '2026-11-05', kw: ['due', 'deadline', 'before', 'by', 'refund'] }],
    numbers: [],
    signals: ['billing', 'finance', 'medium', 'refund'],
    summary: 'Contoso Ltd was charged twice for INV-2291 and wants a refund before 2026-11-05.',
    truth: { category: 'billing' },
  },
  emailOutage: {
    label: 'Customer email: portal outage', kind: 'document',
    markdown: 'Subject: URGENT - portal down\n\nSince 08:00 today none of our 300 staff can sign in to the portal. This is blocking payroll.\n\nSam, Fabrikam Inc',
    strings: [{ v: 'Fabrikam Inc', kw: ['customer', 'sender', 'client', 'company', 'from'] }],
    dates: [],
    numbers: [{ v: 300, kw: ['users', 'staff', 'affected', 'people', 'count'] }],
    signals: ['technical', 'it', 'high', 'outage'],
    summary: 'Fabrikam Inc reports a portal sign-in outage affecting 300 staff and blocking payroll.',
    truth: { category: 'technical' },
  },
};

const TYPES = ['string', 'number', 'integer', 'date', 'time', 'boolean', 'array', 'object'];
const METHODS = ['extract', 'generate', 'classify'];
const EXISTING = ['invoice-triage', 'claims-v1'];
const BASES = {
  'prebuilt-document': { label: 'prebuilt-document', accepts: 'document' },
  'prebuilt-audio': { label: 'prebuilt-audio', accepts: 'audio' },
  'prebuilt-image': { label: 'prebuilt-image', accepts: 'image' },
};

const DEFAULT_SCHEMA = [
  'Customer: string extract | Customer company being billed or writing in',
  'KeyDate: date extract | The date',
  'Amount: number extract | Total amount',
  'Category: string classify [billing, technical, account] | Main topic of the request',
  'Summary: string generate | One-sentence summary of what the sender needs',
].join('\n');

// Parse the compact schema notation: Name: type method [cat, cat] | description
function parseSchema(text) {
  const fields = [];
  const errors = [];
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_]\w*)\s*:\s*(\w+)\s+(\w+)\s*(\[[^\]]*\])?\s*(?:\|\s*(.*))?$/);
    if (!m) { errors.push(`Cannot parse "${line}". Use: Name: type method [categories] | description`); continue; }
    const [, name, type, method, cats, desc] = m;
    const f = { name, type, method, enum: cats ? cats.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : null, description: (desc || '').trim() };
    if (!TYPES.includes(type)) errors.push(`fieldSchema.fields.${name}.type "${type}" is not a valid type (${TYPES.join(', ')}).`);
    if (!METHODS.includes(method)) errors.push(`fieldSchema.fields.${name}.method "${method}" is not valid (extract, generate, classify).`);
    if (method === 'classify' && (!f.enum || !f.enum.length)) errors.push(`fieldSchema.fields.${name}: method classify requires an enum of categories.`);
    if (fields.some(x => x.name === name)) errors.push(`Duplicate field name "${name}".`);
    fields.push(f);
  }
  if (!lines.length) errors.push('fieldSchema.fields is empty.');
  return { fields, errors };
}

function hintWords(f) {
  return [...words(f.name.replace(/([a-z])([A-Z])/g, '$1 $2')), ...words(f.description)];
}

function extractField(f, s) {
  const pool = f.type === 'date' ? s.dates : f.type === 'number' || f.type === 'integer' ? s.numbers : f.type === 'string' ? s.strings : [];
  if (!pool.length) return { value: null, note: 'no candidate of this type in the input', state: 'missing' };
  const hints = new Set(hintWords(f));
  const scored = pool.map(c => ({ c, s: c.kw.filter(k => hints.has(k)).length })).sort((a, b) => b.s - a.s);
  if (pool.length > 1 && (scored[0].s === 0 || scored[0].s === scored[1].s)) {
    return { value: pool[0].v, note: `ambiguous: ${pool.length} ${f.type} candidates match the description equally (${pool.map(c => c.v).join(' / ')}); first one taken`, state: 'ambiguous' };
  }
  return { value: scored[0].c.v, note: scored[0].s ? `matched on "${scored[0].c.kw.filter(k => hints.has(k)).join(', ')}"` : 'only candidate', state: 'ok' };
}

function classifyField(f, s) {
  const hit = f.enum.find(c => s.signals.includes(c.toLowerCase()));
  if (hit) return { value: hit, note: 'category matched the content', state: 'ok' };
  return { value: f.enum[0], note: `no category fits this input well (${f.enum.join(', ')}); low confidence`, state: 'ambiguous' };
}

function design(p) {
  const steps = [];
  const s = SAMPLES[p.sample] || SAMPLES.invoicePdf;
  const id = String(p.analyzerId || '').trim();
  const callId = String(p.callId || '').trim();
  const { fields, errors } = parseSchema(p.schema);
  const ctx = { s, fields, values: {}, id, callId };

  // 1. Schema validation
  if (errors.length) {
    steps.push(step('schema', 'Analyzer definition rejected (400)', errors.join(' '), { httpStatus: 400, code: 'InvalidRequest', errors }, 'error'));
    return finish(p, steps, ctx);
  }
  const base = BASES[p.base] || BASES['prebuilt-document'];
  if (base.accepts !== 'document' && fields.some(f => f.method === 'extract')) {
    steps.push(step('schema', 'extract not supported for this base analyzer', `In this simulation (and in the docs at the time of writing) the extract method applies to documents; ${base.label} fields should use generate or classify.`, { baseAnalyzerId: base.label, extractFields: fields.filter(f => f.method === 'extract').map(f => f.name) }, 'error'));
    return finish(p, steps, ctx);
  }
  steps.push(step('schema', 'Field schema valid', `${fields.length} fields: ${fields.map(f => `${f.name} (${f.type}, ${f.method})`).join(', ')}.`, { fieldSchema: { fields: Object.fromEntries(fields.map(f => [f.name, { type: f.type, method: f.method, description: f.description, ...(f.enum ? { enum: f.enum } : {}) }])) } }));
  const vague = fields.filter(f => f.method !== 'classify' && f.description.split(/\s+/).filter(Boolean).length < 3);
  if (vague.length) steps.push(step('schema', 'Vague field descriptions', `${vague.map(f => f.name).join(', ')}: descriptions under three words give the model little to disambiguate with.`, { fields: vague.map(f => ({ name: f.name, description: f.description })) }, 'info'));

  // 2. Create analyzer
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || /^prebuilt-/i.test(id)) {
    steps.push(step('create', 'Invalid analyzer ID (400)', `"${id}" must be 1–64 letters, digits, ".", "_" or "-" and must not use the reserved "prebuilt-" prefix (rules simplified here; check the docs).`, { analyzerId: id, httpStatus: 400 }, 'error'));
    return finish(p, steps, ctx);
  }
  if (EXISTING.includes(id) && p.createMode === 'create') {
    steps.push(step('create', 'Analyzer ID already exists (409)', `"${id}" is already defined on this resource. A plain create does not overwrite it.`, { analyzerId: id, existing: EXISTING, httpStatus: 409 }, 'error'));
    return finish(p, steps, ctx);
  }
  steps.push(step('create', EXISTING.includes(id) ? 'Analyzer replaced' : 'Analyzer created', `PUT /analyzers/${id} with baseAnalyzerId ${base.label}${EXISTING.includes(id) ? ' (replace allowed)' : ''}. Long-running operation completed.`, { analyzerId: id, baseAnalyzerId: base.label, config: { returnDetails: true }, mode: p.createMode }));

  // 3. Analyze call
  if (callId !== id && !EXISTING.includes(callId)) {
    steps.push(step('analyze', 'Analyzer not found (404)', `The client calls "${callId}", but the analyzer you created is "${id}".`, { calledId: callId, available: [...EXISTING, id], httpStatus: 404 }, 'error'));
    return finish(p, steps, ctx);
  }
  if (callId !== id) {
    steps.push(step('analyze', 'Calling a different analyzer', `"${callId}" exists, but it is not the analyzer you just defined. Your new fields are not used.`, { calledId: callId, definedId: id }, 'warn'));
    ctx.stale = true;
    return finish(p, steps, ctx);
  }
  if (base.accepts !== s.kind) {
    steps.push(step('analyze', 'Input not supported by the base analyzer', `${s.label} is a ${s.kind}; ${base.label} expects ${base.accepts} input.`, { contentKind: s.kind, baseAnalyzerId: base.label, httpStatus: 400 }, 'error'));
    return finish(p, steps, ctx);
  }
  steps.push(step('analyze', 'Analyze', `POST /analyzers/${id}:analyze on "${s.label}" (OCR + layout from the base, then field generation).`, { analyzerId: id, input: s.label }, 'info'));

  // 4. Fields
  const rows = [];
  for (const f of fields) {
    let r;
    if (f.method === 'extract') r = extractField(f, s);
    else if (f.method === 'classify') r = classifyField(f, s);
    else r = f.type === 'string' ? { value: s.summary, note: 'generated from the whole input', state: 'ok' } : extractField(f, s);
    ctx.values[f.name] = r;
    rows.push([f, r]);
  }
  const amb = rows.filter(([, r]) => r.state === 'ambiguous');
  const miss = rows.filter(([, r]) => r.state === 'missing');
  steps.push(step('fields', amb.length ? 'Fields produced, some ambiguous' : 'Fields produced', rows.map(([f, r]) => `${f.name} = ${r.value === null ? 'null' : JSON.stringify(r.value)}`).join('; ') + (amb.length ? `. Ambiguous: ${amb.map(([f, r]) => `${f.name} (${r.note})`).join('; ')}.` : '') + (miss.length ? ` Missing: ${miss.map(([f]) => f.name).join(', ')}.` : ''),
    Object.fromEntries(rows.map(([f, r]) => [f.name, { value: r.value, note: r.note }])), amb.length ? 'warn' : 'ok'));

  // 5. Output shape
  steps.push(step('output', p.output === 'markdown' ? 'Output: markdown + fields' : 'Output: fields only', p.output === 'markdown' ? 'contents[0].markdown carries the full text with structure; fields carry the typed values.' : 'Only the typed fields are passed on. Smaller, but the source text is not available downstream.', { includesMarkdown: p.output === 'markdown' }));

  // 6. Downstream consumer
  if (p.downstream === 'router') {
    const cat = fields.find(f => f.name === 'Category' && f.method === 'classify');
    if (!cat) {
      steps.push(step('downstream', 'Router failed: no Category field', 'The routing function reads result.fields["Category"], which this analyzer does not produce. KeyError → message goes to the dead-letter queue.', { expectedField: 'Category', produced: fields.map(f => f.name) }, 'error'));
    } else {
      const v = ctx.values.Category;
      const queue = { billing: 'finance-queue', technical: 'it-queue', account: 'accounts-queue' }[String(v.value).toLowerCase()] || 'triage-queue';
      steps.push(step('downstream', `Routed to ${queue}`, `Deterministic code uses Category = "${v.value}".${v.state === 'ambiguous' ? ' Low-confidence category: consider a human check.' : ''}`, { Category: v.value, queue }, v.state === 'ambiguous' ? 'warn' : 'ok'));
    }
  } else {
    if (p.output !== 'markdown') {
      steps.push(step('downstream', 'Agent lacks source text', 'The reasoning agent only receives the field values, so it cannot quote the document or answer follow-up questions beyond those fields.', { agentContext: 'fields only' }, 'warn'));
    } else {
      steps.push(step('downstream', 'Agent reasons over markdown + fields', 'The agent uses typed fields for decisions and the markdown for evidence and quotes.', { agentContext: 'markdown + fields' }));
    }
  }
  return finish(p, steps, ctx);
}

function finish(p, steps, ctx) {
  const { s, fields, values } = ctx;
  const output = [];
  output.push({ type: 'json', title: 'Analyzer definition (illustrative shape)', data: {
    analyzerId: ctx.id, description: 'Triage of supplier invoices and customer emails', baseAnalyzerId: p.base,
    config: { returnDetails: true, enableOcr: true, enableLayout: true },
    fieldSchema: { fields: Object.fromEntries(fields.map(f => [f.name, { type: f.type, method: f.method, description: f.description, ...(f.enum ? { enum: f.enum } : {}) }])) },
  } });
  const ran = Object.keys(values).length > 0;
  if (ran) {
    output.push({ type: 'table', title: `Field results for "${s.label}"`, columns: ['Field', 'Method', 'Value', 'Why'],
      rows: fields.map(f => [f.name, f.method, values[f.name].value === null ? '—' : String(values[f.name].value), values[f.name].note]),
      tones: fields.map(f => values[f.name].state === 'ok' ? 'ok' : values[f.name].state === 'missing' ? 'muted' : 'warn') });
    const typed = Object.fromEntries(fields.map(f => {
      const v = values[f.name].value;
      const key = f.type === 'date' ? 'valueDate' : f.type === 'number' ? 'valueNumber' : f.type === 'integer' ? 'valueInteger' : 'valueString';
      return [f.name, v === null ? { type: f.type } : { type: f.type, [key]: v }];
    }));
    output.push({ type: 'json', title: 'Analyzer result (abridged, simulated shape)', data: { result: { analyzerId: ctx.id, contents: [{ kind: 'document', ...(p.output === 'markdown' ? { markdown: s.markdown } : {}), fields: typed }] } } });
    if (p.output === 'markdown') output.push({ type: 'code', title: 'contents[0].markdown', lang: 'markdown', text: s.markdown });
    const last = steps.at(-1);
    output.push({ type: 'chat', title: 'Downstream consumer (simulated)', turns: p.downstream === 'router'
      ? [{ role: 'system', text: 'route(result.fields["Category"])' }, { role: 'tool', text: last.title }]
      : [{ role: 'user', text: 'Should we pay this or escalate it? Explain briefly.' },
        { role: 'agent:triage', text: p.output === 'markdown' ? `${values.Summary ? values.Summary.value + ' ' : ''}Evidence from the document: "${s.markdown.split('\n').filter(l => /due|refund|down|blocking/i.test(l))[0] || s.markdown.split('\n')[0]}".` : `Based on the fields only: ${fields.map(f => `${f.name}=${values[f.name].value}`).join(', ')}. I cannot quote the source.` }] });
  } else if (ctx.stale) {
    output.push({ type: 'alert', tone: 'warn', text: `Results come from "${ctx.callId}", an older analyzer, so they ignore your schema. Call "${ctx.id}".` });
  } else {
    output.push({ type: 'alert', tone: 'error', text: 'No analysis ran. Fix the definition or the call shown in the failing step.' });
  }
  const okCount = fields.filter(f => values[f.name] && values[f.name].state === 'ok').length;
  return {
    steps, output,
    metrics: [
      metric('Fields resolved confidently', ran ? `${okCount}/${fields.length}` : '0', 'computed', 'Fields whose value matched the description without ambiguity in this simulation.'),
      metric('Methods used', [...new Set(fields.map(f => f.method))].join(', ') || 'none', 'computed'),
      metric('Output size', p.output === 'markdown' ? 'larger (markdown + fields)' : 'smaller (fields only)', 'estimate', 'Markdown adds tokens to every downstream prompt; fields alone lose evidence.'),
      metric('Relative analysis cost', fields.some(f => f.method !== 'extract') ? 'higher (generative fields)' : 'lower', 'estimate', 'generate/classify fields use a generative model in addition to content extraction. Check current pricing; no prices are reproduced here.'),
    ],
    summary: steps.some(x => x.status === 'error') ? `Failed: ${steps.find(x => x.status === 'error').title}` : `${ctx.id} on ${s.label}: ${okCount}/${fields.length} confident`,
  };
}

export default {
  id: '5.2.3',
  lab: 'Custom analyzer designer',
  services: [
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
    { name: 'Content Understanding analyzers and field schemas', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/analyzer-templates' },
    { name: 'Create a custom analyzer (REST)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/tutorial/create-custom-analyzer' },
  ],
  prereqs: ['5.2.2', '5.2.1'],
  next: ['4.1.1', '2.2.3'],

  concept: {
    plain: 'A custom analyzer is a reusable recipe: "for this kind of input, give me these fields." You list the fields you want, say what type each is, and how to get it: copy it from the text (extract), write it (generate, e.g. a summary), or pick from a list (classify). Good descriptions matter: "the date" is ambiguous on an invoice with two dates; "the date payment is due" is not.',
    technical: 'A Content Understanding analyzer has an analyzerId, a baseAnalyzerId (e.g. prebuilt-document, or audio/video/image bases), config options (OCR, layout, returnDetails, markdown output) and a fieldSchema whose fields declare type (string, number, integer, date, time, boolean, array, object), method (extract, generate, classify), a description, and an enum for classify. You create it with PUT /analyzers/{analyzerId} (long-running) and call POST /analyzers/{analyzerId}:analyze. Results contain contents[] with markdown and typed field values, which downstream code can route on and agents can reason over. Exact names and supported method/base combinations depend on API version; check the docs.',
    useCase: 'A shared-services inbox receives supplier invoices and customer emails. One analyzer extracts customer, due date and amount, classifies the topic (billing / technical / account) and generates a one-line summary. A router sends billing items to finance automatically, while an agent reads the markdown plus fields to draft replies with quotes from the original message.',
    terms: [
      ['Analyzer', 'Named, reusable configuration: base analyzer + config + field schema.'],
      ['extract', 'Copy a value that appears in the content (documents).'],
      ['generate', 'Produce a value with a generative model, e.g. a summary or inferred value.'],
      ['classify', 'Choose one value from an enum of categories.'],
      ['Field description', 'Natural-language guidance that steers which value the model picks; the main lever for accuracy.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'schema', label: 'Field schema', col: 0, row: 1, detail: 'Names, types, methods, descriptions, categories.', substeps: ['type', 'method: extract / generate / classify', 'description', 'enum for classify'] },
          { id: 'create', label: p ? `Analyzer "${p.analyzerId}"` : 'Analyzer', col: 1, row: 1, detail: 'Schema + base analyzer + config, stored under an ID.', badge: p ? p.base : undefined },
          { id: 'sample', label: p ? `Input: ${SAMPLES[p.sample].label}` : 'Input', col: 1, row: 3, kind: 'data', detail: 'Test with real samples before wiring downstream.' },
          { id: 'analyze', label: 'Analyze', col: 2, row: 1, kind: 'ai', detail: 'Content extraction, then field generation.' },
          { id: 'fields', label: 'Typed fields', col: 3, row: 0, detail: 'Values per field, each traceable to the content.' },
          { id: 'output', label: p && p.output === 'markdown' ? 'Markdown + fields' : 'Fields only', col: 3, row: 2, detail: 'What downstream receives.' },
          { id: 'downstream', label: p ? (p.downstream === 'router' ? 'Router (code)' : 'Reasoning agent') : 'Downstream', col: 4, row: 1, kind: 'app', detail: 'Code routes on fields; agents reason over markdown + fields.' },
        ],
        edges: [['schema', 'create'], ['create', 'analyze'], ['sample', 'analyze'], ['analyze', 'fields'], ['analyze', 'output'], ['fields', 'downstream'], ['output', 'downstream']],
      }),
      architectural: () => ({
        nodes: [
          { id: 'sample', label: 'Shared mailbox → Logic App', col: 0, row: 1, kind: 'app', detail: 'Saves attachments and email bodies to Blob Storage.' },
          { id: 'create', label: 'Content Understanding (Foundry resource)', col: 1, row: 0, kind: 'ai', detail: 'Hosts custom analyzers. Manage with a role that permits analyzer management; call with managed identity.' },
          { id: 'schema', label: 'Analyzer definition in source control', col: 0, row: 0, kind: 'code', detail: 'JSON definition deployed by CI/CD (create or replace), versioned IDs (e.g. support-triage-v2).' },
          { id: 'analyze', label: 'Azure Function: analyze', col: 2, row: 1, kind: 'compute', detail: 'Calls :analyze, polls the operation, stores JSON.' },
          { id: 'fields', label: 'Service Bus queues (finance / IT / accounts)', col: 3, row: 0, kind: 'store', detail: 'Routing on Category.' },
          { id: 'output', label: 'Cosmos DB / Blob: results', col: 3, row: 2, kind: 'store', detail: 'Markdown + fields kept for audit and agents.' },
          { id: 'downstream', label: 'Foundry agent (reply drafting)', col: 4, row: 1, kind: 'ai', detail: 'Reads markdown + fields as context.' },
        ],
        edges: [['schema', 'create', 'deploy'], ['sample', 'analyze'], ['analyze', 'create', 'analyze'], ['analyze', 'fields'], ['analyze', 'output'], ['output', 'downstream']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'schema', label: '{"fieldSchema": {"fields": {"DueDate": {"type": "date", "method": "extract", "description": "…"}}}}', col: 0, row: 0, kind: 'code', detail: 'Analyzer JSON. Shape illustrative; check your API version.' },
          { id: 'create', label: `PUT {endpoint}/contentunderstanding/analyzers/${p ? p.analyzerId : 'support-triage-v2'}?api-version=…`, col: 0, row: 1, kind: 'code', detail: 'Long-running; poll Operation-Location. Replace requires an explicit allow/replace option.' },
          { id: 'analyze', label: `POST …/analyzers/${p ? p.callId : 'support-triage-v2'}:analyze  {"url": blob_sas_or_mi_url}`, col: 0, row: 2, kind: 'code', detail: 'The ID here must match the one you created.' },
          { id: 'fields', label: 'fields = result["contents"][0]["fields"]; fields["Category"]["valueString"]', col: 0, row: 3, kind: 'code', detail: 'Typed value keys by type.' },
          { id: 'output', label: 'md = result["contents"][0]["markdown"]', col: 0, row: 4, kind: 'code', detail: 'Present when markdown output is requested/returned.' },
          { id: 'downstream', label: p && p.downstream === 'router' ? 'queue = ROUTES[fields["Category"]["valueString"]]' : 'agent.run(context=md, facts=fields)', col: 0, row: 5, kind: 'code', detail: 'Downstream consumer.' },
          { id: 'sample', label: 'Test set: invoicePdf, emailBilling, emailOutage', col: 1, row: 2, kind: 'data', detail: 'Run every schema change against the test set.' },
        ],
        edges: [['schema', 'create'], ['create', 'analyze'], ['sample', 'analyze'], ['analyze', 'fields'], ['fields', 'output'], ['output', 'downstream']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'schema', label: 'Field schema (Name: type method [categories] | description)', type: 'textarea', default: DEFAULT_SCHEMA },
      { id: 'sample', label: 'Test input', type: 'select', options: Object.entries(SAMPLES).map(([v, x]) => [v, x.label]), default: 'invoicePdf' },
      { id: 'base', label: 'baseAnalyzerId', type: 'select', options: Object.keys(BASES).map(k => [k, k]), default: 'prebuilt-document' },
      { id: 'analyzerId', label: 'Analyzer ID to create', type: 'text', default: 'support-triage-v2', help: `Already on this simulated resource: ${EXISTING.join(', ')}` },
      { id: 'createMode', label: 'Create mode', type: 'select', options: [['create', 'Create (fail if exists)'], ['replace', 'Create or replace']], default: 'create' },
      { id: 'callId', label: 'Analyzer ID your client calls', type: 'text', default: 'support-triage-v2' },
      { id: 'output', label: 'Output passed downstream', type: 'select', options: [['fields', 'Fields only (structured JSON)'], ['markdown', 'Markdown + fields']], default: 'fields' },
      { id: 'downstream', label: 'Downstream consumer', type: 'select', options: [['router', 'Deterministic router (code)'], ['agent', 'Reasoning agent']], default: 'router' },
    ],
    samples: [
      { label: 'Default schema on the invoice', values: { sample: 'invoicePdf' } },
      { label: 'Outage email to the router', values: { sample: 'emailOutage' } },
      { label: 'Billing email to a reasoning agent with markdown', values: { sample: 'emailBilling', downstream: 'agent', output: 'markdown' } },
      { label: 'Fixed DueDate description', values: { sample: 'invoicePdf', schema: DEFAULT_SCHEMA.replace('KeyDate: date extract | The date', 'DueDate: date extract | Date by which payment is due') } },
    ],
    run: design,
  },

  compare: {
    suggestions: [
      'Run the invoice with "KeyDate | The date", then "DueDate | Date by which payment is due". Compare the date value and the warning.',
      'Run the outage email with output Fields only vs Markdown + fields for the reasoning agent.',
      'Run all three samples with the same schema and compare Category and routing.',
    ],
  },

  debug: [
    { id: 'badtype', title: 'Analyzer creation fails with 400', values: { schema: DEFAULT_SCHEMA.replace('Amount: number extract', 'Amount: currency extract') }, node: 'schema',
      symptom: 'InvalidRequest: type "currency" is not valid.', cause: 'Field types must be one of the supported types.', fix: 'Use number (and describe the currency in the description or add a separate Currency string field).' },
    { id: 'noenum', title: 'Classify field rejected', values: { schema: DEFAULT_SCHEMA.replace(' [billing, technical, account]', '') }, node: 'schema',
      symptom: '400: classify requires categories.', cause: 'A classify field without an enum has nothing to choose from.', fix: 'Add the categories: Category: string classify [billing, technical, account] | …' },
    { id: 'conflict', title: 'Deploy pipeline fails: 409', values: { analyzerId: 'invoice-triage', callId: 'invoice-triage', createMode: 'create' }, node: 'create',
      symptom: 'Conflict: analyzer ID already exists.', cause: 'The ID is taken and the request does not allow replacing.', fix: 'Use Create or replace, or deploy under a new versioned ID (e.g. invoice-triage-v2) and update the caller.' },
    { id: 'notfound', title: 'Client gets 404', values: { callId: 'support-triage-v3' }, node: 'analyze',
      symptom: 'Analyzer not found.', cause: 'The client calls an ID that was never created (version mismatch).', fix: 'Make the client call the created ID (support-triage-v2).' },
    { id: 'ambiguous', title: 'Due date is actually the invoice date', values: { sample: 'invoicePdf' }, node: 'fields',
      symptom: 'KeyDate = 2026-10-01 with an ambiguity warning; payment reminders go out a month early.', cause: '"The date" matches both the invoice date and the due date.', fix: 'Rename and describe precisely: "DueDate: date extract | Date by which payment is due".' },
    { id: 'base', title: 'Document sent to an audio analyzer', values: { base: 'prebuilt-audio', schema: 'Category: string classify [billing, technical, account] | Main topic of the request\nSummary: string generate | One-sentence summary of what the sender needs' }, node: 'analyze',
      symptom: 'Input not supported by the base analyzer.', cause: 'baseAnalyzerId does not match the content type.', fix: 'Use prebuilt-document for PDFs and emails.' },
    { id: 'router', title: 'Router dead-letters every message', values: { schema: 'Customer: string extract | Customer company being billed or writing in\nTopic: string classify [billing, technical, account] | Main topic of the request', downstream: 'router' }, node: 'downstream',
      symptom: 'KeyError Category.', cause: 'The schema renamed the field the downstream code depends on (contract break).', fix: 'Keep the Category field name (or update the router in the same release).' },
    { id: 'agentctx', title: 'Agent cannot quote the email', values: { sample: 'emailBilling', downstream: 'agent', output: 'fields' }, node: 'output',
      symptom: 'Agent replies with field values only.', cause: 'Only structured fields were passed on.', fix: 'Pass markdown + fields to reasoning agents.' },
  ],

  challenge: {
    task: 'Make the invoice analyzer extract the payment due date correctly as a field named DueDate and route the invoice to finance, with no warnings.',
    condition: 'Sample = invoice, DueDate = 2026-11-30, Category = billing, downstream = router, no warn/error steps.',
    hint: 'The invoice has two dates. The field name and description are what the model uses to choose.',
    check: (p, res) => {
      if (p.sample !== 'invoicePdf' || p.downstream !== 'router' || res.steps.some(s => s.status === 'warn' || s.status === 'error')) return false;
      const blk = res.output.find(b => b.type === 'json' && /Analyzer result/.test(b.title || ''));
      const f = blk && blk.data.result.contents[0].fields;
      return !!(f && f.DueDate && f.DueDate.valueDate === '2026-11-30' && f.Category && f.Category.valueString === 'billing');
    },
    solution: ['Replace "KeyDate: date extract | The date" with "DueDate: date extract | Date by which payment is due".', 'Keep Category as classify [billing, technical, account].', 'Keep analyzer ID and called ID identical (support-triage-v2), base prebuilt-document, downstream router.'],
    solutionValues: { sample: 'invoicePdf', downstream: 'router', base: 'prebuilt-document', analyzerId: 'support-triage-v2', callId: 'support-triage-v2', createMode: 'create', output: 'fields',
      schema: DEFAULT_SCHEMA.replace('KeyDate: date extract | The date', 'DueDate: date extract | Date by which payment is due') },
  },

  quiz: [
    { q: 'Your analyzer returns the invoice issue date when you wanted the payment due date. The field is defined as "Date: date extract | The date". What is the best first fix?', options: ['Switch the method to generate', 'Rename and describe the field precisely (e.g. "DueDate: Date by which payment is due")', 'Use a larger base analyzer', 'Post-process with a regex'], answer: 1, why: 'Field descriptions guide extraction. Ambiguous descriptions on inputs with several candidate values lead to wrong picks.' },
    { q: 'You need each email labelled billing, technical or account so code can route it. Which field definition fits?', options: ['Topic: string extract', 'Topic: string generate | "the topic"', 'Category: string classify with enum [billing, technical, account]', 'Category: object extract'], answer: 2, why: 'classify with a fixed enum gives a predictable value set for deterministic routing.' },
    { q: 'A CI/CD pipeline re-deploys an analyzer with the same ID and fails with 409. Which approach is sound?', options: ['Delete the resource', 'Use an explicit create-or-replace option, or version the ID (…-v3) and update callers together', 'Retry until it succeeds', 'Call a prebuilt analyzer instead'], answer: 1, why: 'Existing IDs are not silently overwritten. Replace deliberately, or version IDs so callers and schema change together.' },
    { q: 'An agent must explain its triage decision and quote the customer. What should the analyzer output include?', options: ['Only the classify field', 'Markdown content plus the typed fields', 'Only a generated summary', 'Only page numbers'], answer: 1, why: 'Fields drive decisions; markdown supplies the evidence the agent can quote and reason over.' },
  ],

  recap: 'A custom analyzer = base analyzer + config + field schema (type, method extract/generate/classify, precise description, enum for classify) under a stable, versioned ID. Validate the schema, keep create/call IDs in sync, test on real samples, and pass fields to code and markdown + fields to reasoning agents.',
};
