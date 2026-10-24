// 3.2.7 Configure single-task and pro-mode Content Understanding pipelines
// Lab: Standard vs pro mode reconciliation bench.
import { step, metric } from '../src/engine/util.js';

// Sample inputs. Each case plants (at most) one issue that a reviewer would reject.
const CASES = {
  clean: { label: 'Clean invoice (everything matches)', issue: null, vendor: 'Proseware Ltd.', lines: [['Router', 4, 120], ['Switch 24p', 10, 310]] },
  qty: { label: 'Invoice bills 12 switches, PO ordered 10', issue: 'C1', vendor: 'Proseware Ltd.', lines: [['Router', 4, 120], ['Switch 24p', 12, 310]] },
  price: { label: 'Router billed above contract rate', issue: 'C2', vendor: 'Proseware Ltd.', lines: [['Router', 4, 135], ['Switch 24p', 10, 310]] },
  vendor: { label: 'Vendor not on approved list', issue: 'C3', vendor: 'Proseware Trading LLC', lines: [['Router', 4, 120], ['Switch 24p', 10, 310]] },
};
const PO = { id: 'PO-5521', vendor: 'Proseware Limited', lines: [['PS-01 Wireless router', 4, 120], ['PS-07 24-port network switch', 10, 310]] };
const CONTRACT_TEXT = 'Clause 4.2: Supplier shall invoice routers at USD 120 per unit and 24-port switches at USD 310 per unit. Payment terms net 30.';
const APPROVED = ['Proseware Limited', 'Adatum Logistics', 'Northwind Traders'];

const INPUTS = {
  inv: { label: 'Invoice only', docs: ['invoice'] },
  inv_po: { label: 'Invoice + purchase order', docs: ['invoice', 'po'] },
  inv_contract: { label: 'Invoice + contract', docs: ['invoice', 'contract'] },
  inv_po_contract: { label: 'Invoice + PO + contract', docs: ['invoice', 'po', 'contract'] },
};

const CHECKS = {
  C1: { label: 'Invoice quantities ≤ PO quantities', needs: d => d.docs.includes('po'), needText: 'purchase order', cross: true },
  C2: { label: 'Unit prices match contracted rates', needs: (d, ref) => d.docs.includes('contract') || ref, needText: 'contract or rate card in reference data', cross: true },
  C3: { label: 'Vendor is on the approved vendor list', needs: (d, ref) => ref, needText: 'approved vendor list in reference data', cross: true },
  C4: { label: 'Invoice total equals sum of lines', needs: () => true, needText: '', cross: false },
};
const TASKS = {
  extract: { label: 'Extract invoice fields only', checks: [] },
  reconcile: { label: 'Reconcile invoice against PO', checks: ['C1', 'C4'] },
  compliance: { label: 'Check contract & vendor compliance', checks: ['C2', 'C3', 'C4'] },
  full: { label: 'Full three-way validation', checks: ['C1', 'C2', 'C3', 'C4'] },
};

function evaluate(id, p, c, inp) {
  const ch = CHECKS[id];
  const pro = p.mode === 'pro';
  if (!pro && ch.cross && !p.appCode) return { result: 'not evaluated', why: 'Standard mode analyzes one document per call and returns fields only. Cross-document logic must live in your code.' };
  if (!ch.needs(inp, p.reference)) return { result: 'not evaluated', why: `Missing input: ${ch.needText}.` };
  if (id === 'C4') {
    if (!pro && !p.appCode) return { result: 'not evaluated', why: 'Fields returned; nobody summed them.' };
    return { result: 'pass', why: 'Lines sum to the stated total.' };
  }
  if (!pro) {
    // Standard mode + your own code: exact matching only.
    if (id === 'C1') return { result: 'not evaluated', why: 'Your code could not align "Switch 24p" with "PS-07 24-port network switch" by exact description.' };
    if (id === 'C2') return inp.docs.includes('contract') && !p.reference ? { result: 'not evaluated', why: 'The contract states rates in prose (clause 4.2); a fixed field schema per document does not tie them to invoice lines.' } : { result: c.issue === 'C2' ? 'fail' : 'pass', why: 'Rate card lookup by exact item name in your code.' };
    if (id === 'C3') return APPROVED.includes(c.vendor) ? { result: 'pass', why: 'Exact match.' } : { result: 'fail', why: `"${c.vendor}" not found by exact string match.` };
  }
  // Pro mode: multi-step reasoning across documents + reference data.
  if (id === 'C1') return c.issue === 'C1' ? { result: 'fail', why: 'Aligned "Switch 24p" ↔ "PS-07 24-port network switch": invoiced 12, ordered 10.' } : { result: 'pass', why: 'All lines aligned; quantities within PO.' };
  if (id === 'C2') return c.issue === 'C2' ? { result: 'fail', why: `Router invoiced at 135; ${inp.docs.includes('contract') ? 'contract clause 4.2' : 'reference rate card'} says 120.` } : { result: 'pass', why: 'Unit prices match contracted rates.' };
  if (id === 'C3') return c.issue === 'C3' ? { result: 'fail', why: `"${c.vendor}" is a different legal entity from "Proseware Limited".` } : { result: 'pass', why: `"${c.vendor}" resolved to approved vendor "Proseware Limited".` };
  return { result: 'pass', why: '' };
}

function run(p) {
  const c = CASES[p.case] || CASES.qty;
  const inp = INPUTS[p.inputs] || INPUTS.inv_po;
  const task = TASKS[p.task] || TASKS.reconcile;
  const pro = p.mode === 'pro';
  const steps = [];

  if (pro && p.modality !== 'document') {
    steps.push(step('analyzer', 'Pro mode not available for this modality', 'In this simulation (mirroring the preview where pro mode was introduced) pro mode accepts document inputs only. Availability and naming may have changed: check the current Content Understanding docs.', { mode: 'pro', modality: p.modality }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Use standard mode for video/audio/image analyzers, or convert the evidence into documents.' }], metrics: [], summary: 'Pro mode: unsupported modality' };
  }
  steps.push(step('analyzer', `${pro ? 'Pro' : 'Standard'} analyzer configured`, pro ? 'Pro mode: multiple input files, optional reference data, multi-step reasoning with explanations.' : 'Standard (single-task) mode: one input → one set of fields per call.', { mode: pro ? 'pro' : 'standard', modality: p.modality, task: task.label }));

  if (!pro && inp.docs.length > 1) steps.push(step('inputs', `${inp.docs.length} separate analyze calls`, 'Standard mode handles each document on its own; results are joined by your code.', { calls: inp.docs }, 'info'));
  else steps.push(step('inputs', pro ? `${inp.docs.length} document(s) in one request` : 'Single document', inp.label, { docs: inp.docs }));

  if (p.reference) {
    if (p.refAccess === 'denied') {
      steps.push(step('reference', 'Reference data unreadable (403)', 'The knowledge source container cannot be read by the service identity.', { container: 'reference-data', needs: 'Storage Blob Data Reader for the service identity' }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: 'Grant the Content Understanding resource’s managed identity Storage Blob Data Reader on the reference-data container (or turn reference data off).' }], metrics: [], summary: 'Reference data access denied' };
    }
    steps.push(step('reference', pro ? 'Reference data loaded' : 'Reference data available to your code', pro ? 'Approved vendor list and rate card attached as knowledge for reasoning.' : 'Standard mode does not reason over it; only your code can use it.', { files: ['approved_vendors.csv', 'rate_card.xlsx'] }, 'ok'));
  } else {
    steps.push(step('reference', 'No reference data', 'Checks that need the vendor list or rate card cannot run.', null, task.checks.includes('C3') ? 'warn' : 'skip'));
  }

  steps.push(step('extract', 'Per-document fields extracted', `Invoice: vendor "${c.vendor}", ${c.lines.length} lines.${inp.docs.includes('po') ? ` PO ${PO.id}: ${PO.lines.length} lines.` : ''}${inp.docs.includes('contract') ? ' Contract: clause text.' : ''}`,
    { invoice: { VendorName: c.vendor, Items: c.lines.map(([d, q, u]) => ({ Description: d, Quantity: q, UnitPrice: u })) }, ...(inp.docs.includes('po') ? { po: { PONumber: PO.id, Items: PO.lines.map(([d, q, u]) => ({ Description: d, Quantity: q, UnitPrice: u })) } } : {}) }));

  // Checks (all four are reported; only the task's checks are requested)
  const results = Object.keys(CHECKS).map(id => ({ id, requested: task.checks.includes(id), ...(task.checks.includes(id) ? evaluate(id, p, c, inp) : { result: 'not requested', why: 'Not part of this task.' }) }));
  const notEval = results.filter(r => r.requested && r.result === 'not evaluated');
  if (pro) steps.push(step('reason', 'Multi-step reasoning', 'Align line items across documents → look up rates and vendors → compare → explain each finding.', { checks: results.filter(r => r.requested).map(r => ({ check: CHECKS[r.id].label, result: r.result, explanation: r.why })) }, notEval.length ? 'warn' : 'ok'));
  else steps.push(step('reason', p.appCode ? 'Your reconciliation code' : 'No cross-document reasoning', p.appCode ? 'Exact-match rules written in the app.' : 'Fields returned; no comparison performed.', { checks: results.filter(r => r.requested).map(r => ({ check: CHECKS[r.id].label, result: r.result, note: r.why })) }, notEval.length ? 'warn' : 'ok'));

  const planted = c.issue;
  const caught = planted && results.some(r => r.id === planted && r.result === 'fail');
  const falsePos = results.filter(r => r.result === 'fail' && r.id !== planted);
  const missed = planted && !caught;
  const overkill = pro && task.checks.length === 0;
  let status = 'ok', title = 'Correct decision', text;
  if (missed) { status = 'error'; title = 'Bad invoice would be auto-approved'; text = `Planted issue "${CHECKS[planted].label}" was not detected.`; }
  else if (falsePos.length) { status = 'warn'; title = 'False alarm'; text = `${falsePos.map(r => CHECKS[r.id].label).join(', ')} failed on a valid invoice.`; }
  else if (notEval.length) { status = 'warn'; title = 'Incomplete validation'; text = `${notEval.length} requested check(s) could not run.`; }
  else if (overkill) { status = 'warn'; title = 'Pro mode is overkill here'; text = 'Field extraction from one document does not need multi-document reasoning; standard mode is cheaper and faster.'; }
  else text = planted ? `Issue caught: ${CHECKS[planted].label}.` : 'Invoice validated with no findings.';
  steps.push(step('decision', title, text, { planted: planted ? CHECKS[planted].label : null, caught: !!caught, falsePositives: falsePos.length }, status));

  // Relative cost/latency units (illustrative)
  const n = inp.docs.length;
  const cost = pro ? n * 2 + 2 + (p.reference ? 1 : 0) : n;
  const latency = pro ? 2 + n * 1.5 + 3 + (p.reference ? 1 : 0) : 2 + (n > 1 ? 0.5 : 0);
  const tl = pro
    ? [{ label: 'Upload inputs', start: 0, end: 1, lane: 'pro' }, { label: 'Extract each doc', start: 1, end: 1 + n * 1.5, lane: 'pro' }, ...(p.reference ? [{ label: 'Load reference', start: 1 + n * 1.5, end: 2 + n * 1.5, lane: 'pro' }] : []), { label: 'Reason & validate', start: latency - 3, end: latency - 0.5, lane: 'pro', tone: 'info' }, { label: 'Explain', start: latency - 0.5, end: latency, lane: 'pro' }]
    : inp.docs.map((d, i) => ({ label: `analyze(${d})`, start: i * 0.25, end: 2 + i * 0.25, lane: `call ${i + 1}` })).concat(p.appCode ? [{ label: 'your code', start: latency, end: latency + 0.3, lane: 'app' }] : []);

  return {
    steps,
    output: [
      { type: 'table', title: 'Validation checks', columns: ['Check', 'Requested', 'Result', 'Explanation'],
        rows: results.map(r => [CHECKS[r.id].label, r.requested ? 'yes' : 'no', r.result, r.why]),
        tones: results.map(r => !r.requested ? 'muted' : r.result === 'fail' ? (r.id === planted ? 'ok' : 'warn') : r.result === 'not evaluated' ? (r.id === planted ? 'error' : 'warn') : r.id === planted ? 'error' : 'ok') },
      { type: 'flow', title: pro ? 'Pro mode reasoning chain (simulated)' : 'Standard mode chain', items: pro
        ? [{ label: 'Inputs', note: inp.docs.join(' + ') }, { label: 'Extract per doc' }, { label: 'Align line items', note: 'semantic match', tone: inp.docs.includes('po') ? 'ok' : 'muted' }, { label: 'Ground in reference', tone: p.reference ? 'ok' : 'muted' }, { label: 'Validate & explain', tone: status === 'error' ? 'error' : 'ok' }]
        : [...inp.docs.map(d => ({ label: `analyze(${d})` })), { label: p.appCode ? 'Your exact-match code' : 'No reconciliation', tone: p.appCode ? 'info' : 'warn' }, { label: 'Decision', tone: status === 'error' ? 'error' : status === 'warn' ? 'warn' : 'ok' }] },
      { type: 'timeline', title: 'Relative latency (illustrative units, not seconds)', unit: 'u', items: tl },
      { type: 'bars', title: 'Relative cost per invoice (illustrative units)', items: [{ label: 'Standard (this input set)', value: n, max: 12 }, { label: 'Pro (this input set)', value: n * 2 + 2 + (p.reference ? 1 : 0), max: 12, tone: pro ? 'info' : 'muted' }] },
      { type: 'json', title: 'Analyzer sketch (illustrative; property names vary by API version)', data: pro
        ? { baseAnalyzerId: 'prebuilt-document', mode: 'pro', knowledgeSources: p.reference ? [{ kind: 'reference', containerUrl: 'https://<storage>.blob.core.windows.net/reference-data' }] : [], fieldSchema: { fields: { Findings: { type: 'array', method: 'generate', description: 'Each discrepancy between invoice, PO, contract and reference data, with explanation' } } } }
        : { baseAnalyzerId: 'prebuilt-document', mode: 'standard', fieldSchema: { fields: { VendorName: { type: 'string', method: 'extract' }, Items: { type: 'array', method: 'extract' }, Total: { type: 'number', method: 'extract' } } } } },
    ],
    metrics: [
      metric('Planted issue caught', planted ? (caught ? 'yes' : 'no') : 'n/a (clean)', 'computed'),
      metric('False positives', String(falsePos.length), 'computed'),
      metric('Relative cost', `${cost} units`, 'estimate', 'Illustrative: pro mode reasons over all inputs and reference data, so it consumes more model capacity per request. No real prices.'),
      metric('Relative latency', `${latency} units`, 'estimate', 'Illustrative: standard calls run in parallel; pro mode is multi-step.'),
    ],
    summary: `${pro ? 'Pro' : 'Standard'} • ${inp.label} • ${task.label}: ${title}`,
  };
}

export default {
  id: '3.2.7',
  lab: 'Standard vs pro mode reconciliation bench',
  services: [
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/overview' },
    { name: 'Content Understanding standard and pro modes', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/standard-pro-modes' },
  ],
  prereqs: ['3.2.5', '5.2.1'],
  next: ['5.2.2', '5.2.3'],

  concept: {
    plain: 'Some jobs only need facts read from one file: "what is the invoice total?". Others need judgement across several files: "does this invoice match what we ordered and what the contract allows?". Standard (single-task) mode does the first kind quickly and cheaply. Pro mode takes several files plus your reference data, reasons in steps, and explains its findings, at extra cost and latency. Choose pro only when the task genuinely needs cross-document reasoning.',
    technical: 'A standard Content Understanding analyzer takes one input and returns its field schema (extract/generate/classify). Pro mode, introduced in preview (2025-05-01-preview) for document analyzers, accepts multiple input files and reference data (a knowledge source in Blob Storage) and performs multi-step reasoning to produce validated, explained outputs such as discrepancies. Naming, modality support and API shape may have changed since; check the standard/pro modes page. Without pro mode, cross-document validation lives in your own code, which typically relies on exact matching.',
    useCase: 'An accounts-payable team does three-way matching (invoice, purchase order, contract rate card). Routine field extraction runs in standard mode for every invoice; invoices above a value threshold go through a pro-mode analyzer with the PO, contract and approved-vendor list attached, which returns explained findings for a reviewer.',
    terms: [
      ['Standard (single-task) mode', 'One input per call, field schema in, fields out. Lower cost and latency.'],
      ['Pro mode', 'Multiple inputs + reference data with multi-step reasoning and explanations (document-focused when introduced).'],
      ['Reference data', 'Your authoritative data (vendor list, rate card) used to validate extracted values.'],
      ['Three-way match', 'Checking invoice against purchase order and receipt/contract before payment.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'inputs', label: p ? INPUTS[p.inputs].label : 'Inputs', col: 0, row: 1, kind: 'data', detail: 'Documents sent for analysis.' },
          { id: 'analyzer', label: p && p.mode === 'pro' ? 'Pro analyzer' : 'Standard analyzer', col: 1, row: 1, kind: 'ai', detail: 'Mode decides whether documents are reasoned over together.' },
          { id: 'extract', label: 'Per-document fields', col: 2, row: 0, kind: 'data', detail: 'Both modes extract fields.' },
          { id: 'reference', label: 'Reference data', col: 1, row: 2.5, kind: 'store', detail: 'Vendor list, rate card.', disabled: p && !p.reference },
          { id: 'reason', label: p && p.mode === 'pro' ? 'Multi-step reasoning' : 'Your code (optional)', col: 3, row: 1, kind: p && p.mode === 'pro' ? 'ai' : 'code', detail: 'Cross-document checks.', substeps: ['Align items', 'Compare quantities/prices', 'Validate vendor', 'Explain'] },
          { id: 'decision', label: 'Approve / reject', col: 4, row: 1, kind: 'app', detail: 'Business decision.' },
        ],
        edges: [['inputs', 'analyzer'], ['analyzer', 'extract'], ['extract', 'reason'], ['reference', 'reason'], ['reason', 'decision']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'inputs', label: 'Blob: invoices / POs / contracts', col: 0, row: 1, kind: 'store', detail: 'Input documents.' },
          { id: 'analyzer', label: `Content Understanding (${p ? p.mode : 'standard'})`, col: 1, row: 1, kind: 'ai', detail: 'Foundry Tools resource with chat model deployment configured.' },
          { id: 'inputs2', label: p && p.mode === 'pro' ? '1 request, N files' : 'N requests', col: 1, row: 0, kind: 'data', detail: 'Request shape differs by mode.' },
          { id: 'reference', label: 'Blob: reference-data', col: 0, row: 2.5, kind: 'store', detail: 'Needs Storage Blob Data Reader for the service identity.', badge: p && p.refAccess === 'denied' ? '403' : undefined, disabled: p && !p.reference },
          { id: 'extract', label: 'Fields JSON', col: 2, row: 0, kind: 'data', detail: 'Per document.' },
          { id: 'reason', label: p && p.mode === 'pro' ? 'Findings + explanations' : 'Function: reconcile()', col: 3, row: 1, kind: p && p.mode === 'pro' ? 'data' : 'compute', detail: 'Where cross-document logic lives.' },
          { id: 'decision', label: 'AP workflow / ERP', col: 4, row: 1, kind: 'app', detail: 'Payment approval.' },
        ],
        edges: [['inputs', 'analyzer'], ['inputs2', 'analyzer'], ['reference', 'analyzer', 'knowledge'], ['analyzer', 'extract'], ['extract', 'reason'], ['reason', 'decision']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'analyzer', label: p && p.mode === 'pro' ? 'PUT analyzers/ap-pro  { "mode": "pro", "knowledgeSources": [...] }' : 'PUT analyzers/ap-invoice  { "mode": "standard", "fieldSchema": {...} }', col: 0, row: 0, kind: 'code', detail: 'Illustrative REST body; check the current API version for exact property names.' },
          { id: 'inputs', label: p && p.mode === 'pro' ? 'POST analyzers/ap-pro:analyze  { "inputs": [invoice, po, contract] }' : 'for doc in docs: POST analyzers/ap-invoice:analyze', col: 0, row: 1, kind: 'code', detail: 'Pro: one request with several inputs. Standard: one request per document.' },
          { id: 'reference', label: 'knowledge source → https://<storage>/reference-data', col: 0, row: 2, kind: 'code', detail: 'Reference files the analyzer reasons over.' },
          { id: 'extract', label: 'result = poll(operation_location)', col: 0, row: 3, kind: 'code', detail: 'Long-running operation in both modes.' },
          { id: 'reason', label: p && p.mode === 'pro' ? 'findings = result["contents"][0]["fields"]["Findings"]' : 'findings = reconcile(inv_fields, po_fields)  # your code', col: 0, row: 4, kind: 'code', detail: 'Who owns the logic.' },
          { id: 'decision', label: 'approve() if not findings else route_to_reviewer(findings)', col: 0, row: 5, kind: 'code', detail: 'Decision.' },
        ],
        edges: [['analyzer', 'inputs'], ['inputs', 'reference'], ['reference', 'extract'], ['extract', 'reason'], ['reason', 'decision']],
      }),
    },
  },

  sim: {
    mode: 'conceptual',
    controls: [
      { id: 'mode', label: 'Analyzer mode', type: 'select', options: [['standard', 'Standard (single-task)'], ['pro', 'Pro mode']], default: 'standard' },
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([v, t]) => [v, t.label]), default: 'reconcile' },
      { id: 'inputs', label: 'Input documents', type: 'select', options: Object.entries(INPUTS).map(([v, i]) => [v, i.label]), default: 'inv_po' },
      { id: 'case', label: 'Sample case', type: 'select', options: Object.entries(CASES).map(([v, c]) => [v, c.label]), default: 'qty' },
      { id: 'reference', label: 'Attach reference data (vendor list, rate card)', type: 'toggle', default: false },
      { id: 'refAccess', label: 'Reference container access', type: 'select', options: [['granted', 'Storage Blob Data Reader granted'], ['denied', 'No role assigned']], default: 'granted' },
      { id: 'appCode', label: 'Standard mode: my own reconciliation code', type: 'toggle', default: false, help: 'Exact-match rules written in your app.' },
      { id: 'modality', label: 'Input modality', type: 'select', options: [['document', 'Documents'], ['video', 'Video']], default: 'document' },
    ],
    samples: [
      { label: 'Standard mode, quantity mismatch', values: { mode: 'standard', case: 'qty' } },
      { label: 'Pro mode, quantity mismatch', values: { mode: 'pro', case: 'qty' } },
      { label: 'Standard + own code, clean invoice, vendor check', values: { mode: 'standard', appCode: true, task: 'compliance', inputs: 'inv', reference: true, case: 'clean' } },
      { label: 'Pro mode for simple extraction', values: { mode: 'pro', task: 'extract', inputs: 'inv', case: 'clean' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the quantity mismatch in standard mode, standard + own code, and pro mode; compare the decision and relative cost.',
      'Run the clean invoice with the compliance task in standard + own code, then in pro mode: which raises a false alarm on the vendor name?',
      'Run "extract fields only" in both modes and compare relative cost and latency.',
    ],
  },

  debug: [
    { id: 'standard', title: 'Over-billed quantity is auto-approved', values: { mode: 'standard', task: 'reconcile', inputs: 'inv_po', case: 'qty', appCode: false }, node: 'reason',
      symptom: 'Decision step: bad invoice would be auto-approved.', cause: 'Standard mode analyzes documents separately; nobody compares them (unsuitable mode for the task).', fix: 'Use pro mode with invoice + PO, or own the reconciliation logic in code.' },
    { id: 'missingPO', title: 'Pro mode cannot reconcile', values: { mode: 'pro', task: 'reconcile', inputs: 'inv', case: 'qty' }, node: 'inputs',
      symptom: 'Quantity check "not evaluated: missing input".', cause: 'The PO was not included in the request (missing input).', fix: 'Send invoice + purchase order together.' },
    { id: 'refDenied', title: 'Reference data 403', values: { mode: 'pro', task: 'compliance', inputs: 'inv_contract', reference: true, refAccess: 'denied', case: 'vendor' }, node: 'reference',
      symptom: 'Run fails reading the knowledge source.', cause: 'The service identity has no data role on the reference container (permission problem).', fix: 'Grant Storage Blob Data Reader (Reference container access = granted).' },
    { id: 'exact', title: 'Valid vendor flagged', values: { mode: 'standard', appCode: true, task: 'compliance', inputs: 'inv', reference: true, case: 'clean' }, node: 'reason',
      symptom: '"Proseware Ltd." fails the approved-vendor check.', cause: 'Exact string matching cannot tell "Ltd." from "Limited" (malformed / inconsistent data across sources).', fix: 'Use pro mode, which resolves entities with reasoning, or normalise names in your code.' },
    { id: 'video', title: 'Pro mode rejects a video analyzer', values: { mode: 'pro', modality: 'video' }, node: 'analyzer',
      symptom: 'Analyzer configuration rejected.', cause: 'Pro mode targets documents (in this simulation, as in the preview).', fix: 'Use standard mode for video, or set modality to documents.' },
  ],

  challenge: {
    task: 'Catch the router billed above contract rate with no warnings and without sending the purchase order (it is not needed for this check).',
    condition: 'Case = price, inputs do not include the PO, decision = issue caught, no warn/error steps.',
    hint: 'Which task checks prices and vendors, and which checks need reference data?',
    check: (p, res) => p.case === 'price' && !INPUTS[p.inputs].docs.includes('po') && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.metrics.some(m => m.label === 'Planted issue caught' && m.value === 'yes'),
    solution: ['Select the "Router billed above contract rate" case.', 'Choose pro mode and the compliance task.', 'Send invoice + contract (no PO).', 'Attach reference data so the vendor check can run, with access granted.'],
    solutionValues: { mode: 'pro', task: 'compliance', inputs: 'inv_contract', case: 'price', reference: true, refAccess: 'granted', modality: 'document' },
  },

  quiz: [
    { q: 'You only need VendorName, InvoiceTotal and DueDate from each invoice, at high volume. Which configuration fits?', options: ['Pro mode with reference data', 'Standard (single-task) analyzer with a field schema', 'Pro mode with one input', 'A video analyzer'], answer: 1, why: 'Single-document extraction does not need multi-step reasoning; standard mode is cheaper and faster.' },
    { q: 'You must flag invoices whose line quantities exceed the PO, where item descriptions differ between documents. Which approach is most appropriate?', options: ['Standard mode on the invoice only', 'Pro mode with invoice + PO as inputs', 'Standard mode with exact-match code only', 'Increase the confidence threshold'], answer: 1, why: 'Cross-document alignment with differing descriptions is what pro mode’s multi-step reasoning targets; exact matching fails.' },
    { q: 'A pro-mode analyzer with a knowledge source fails with 403 when reading reference files. What is the fix?', options: ['Switch to standard mode', 'Grant the service’s managed identity Storage Blob Data Reader on the reference container', 'Make the container public', 'Add the files as extra inputs'], answer: 1, why: 'The service reads reference data with its identity; it needs a data-plane storage role.' },
  ],

  recap: 'Use standard (single-task) analyzers for per-document extraction; use pro mode when the task needs several inputs, reference data and explained cross-document reasoning, and accept its higher cost and latency. Send every document the check needs, give the service read access to reference data, and confirm current pro-mode availability in the docs.',
};
