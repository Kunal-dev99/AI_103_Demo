// 4.1.4 Customize language model outputs for domain tasks, such as compliance summarization and domain extraction
// Lab: Domain output rubric bench.
import { rng, round, step, metric, estTokens } from '../src/engine/util.js';

// Each document is a set of clauses. Facts carry a type and the clause that supports them.
const DOCS = {
  dpa: {
    label: 'Data processing agreement (excerpt)',
    clauses: [
      ['3.1', 'Fabrikam Health (the controller) appoints Contoso Cloud Ltd (the processor) to process patient contact data.'],
      ['5.2', 'The processor shall notify the controller of a personal data breach without undue delay and no later than 48 hours after becoming aware of it.'],
      ['7.1', 'Sub-processors may be engaged only with the controller\'s prior written authorisation.'],
      ['9.4', 'On termination, the processor shall delete all personal data within 30 days, unless retention is required by law.'],
      ['11', 'This agreement takes effect on 1 January 2027.'],
    ],
    facts: [
      { type: 'party', text: 'Fabrikam Health — controller', clause: '3.1' },
      { type: 'party', text: 'Contoso Cloud Ltd — processor', clause: '3.1' },
      { type: 'obligation', text: 'Processor notifies the controller of any personal data breach', clause: '5.2' },
      { type: 'obligation', text: 'Sub-processors require the controller\'s prior written authorisation', clause: '7.1' },
      { type: 'obligation', text: 'Processor deletes all personal data after termination', clause: '9.4' },
      { type: 'date', text: 'Breach notice: no later than 48 hours after awareness', clause: '5.2' },
      { type: 'date', text: 'Deletion: within 30 days of termination', clause: '9.4' },
      { type: 'date', text: 'Effective date: 1 January 2027', clause: '11' },
    ],
    terms: { 'personal data breach': 'data leak', controller: 'data owner', processor: 'vendor' },
    fabricated: 'Processor must encrypt all data with AES-256',
  },
  clinical: {
    label: 'Hospital discharge note',
    clauses: [
      ['A', 'Patient J. Smith, 67, admitted with new-onset atrial fibrillation; attending physician Dr A. Rahman.'],
      ['B', 'Started anticoagulation with apixaban 5 mg twice daily; aspirin discontinued.'],
      ['C', 'Repeat renal function test in 1 week before the next dose review.'],
      ['D', 'Discharged 2026-10-12; cardiology clinic follow-up booked for 2026-10-26.'],
    ],
    facts: [
      { type: 'party', text: 'Patient J. Smith (67)', clause: 'A' },
      { type: 'party', text: 'Attending: Dr A. Rahman', clause: 'A' },
      { type: 'obligation', text: 'Continue apixaban 5 mg twice daily (anticoagulation)', clause: 'B' },
      { type: 'obligation', text: 'Aspirin stopped — do not restart', clause: 'B' },
      { type: 'obligation', text: 'Repeat renal function test', clause: 'C' },
      { type: 'date', text: 'Renal test due within 1 week', clause: 'C' },
      { type: 'date', text: 'Discharged 2026-10-12', clause: 'D' },
      { type: 'date', text: 'Cardiology follow-up 2026-10-26', clause: 'D' },
    ],
    terms: { 'atrial fibrillation': 'irregular heartbeat', anticoagulation: 'blood thinning' },
    fabricated: 'Start warfarin 5 mg daily',
  },
  aml: {
    label: 'Regulatory notice (anti-money laundering)',
    clauses: [
      ['1', 'Notice from the Financial Conduct Authority to Woodgrove Bank regarding updated sanctions screening.'],
      ['2', 'The firm must screen all new customers against the updated consolidated sanctions list as part of customer due diligence.'],
      ['3', 'Any suspicious activity report must be filed within 7 days of detection.'],
      ['4', 'Due-diligence records, including checks on politically exposed persons, must be retained for 5 years.'],
      ['5', 'These requirements apply from 2027-03-01.'],
    ],
    facts: [
      { type: 'party', text: 'Financial Conduct Authority — regulator', clause: '1' },
      { type: 'party', text: 'Woodgrove Bank — regulated firm', clause: '1' },
      { type: 'obligation', text: 'Screen all new customers against the consolidated sanctions list', clause: '2' },
      { type: 'obligation', text: 'File suspicious activity reports', clause: '3' },
      { type: 'obligation', text: 'Retain customer due diligence records (incl. politically exposed persons)', clause: '4' },
      { type: 'date', text: 'SAR filing: within 7 days of detection', clause: '3' },
      { type: 'date', text: 'Record retention: 5 years', clause: '4' },
      { type: 'date', text: 'Applies from 2027-03-01', clause: '5' },
    ],
    terms: { 'customer due diligence': 'background checks', 'suspicious activity report': 'fraud report', 'politically exposed persons': 'important people' },
    fabricated: 'Fines of up to £10 million apply for late filing',
  },
};

const TECH = {
  prompt: { label: 'Prompt engineering (instructions only)', q: 0.5, terms: false },
  fewshot: { label: 'Few-shot (instructions + 2 worked examples)', q: 0.75, terms: true },
  rag: { label: 'RAG (retrieve glossary + policy guidance)', q: 0.7, terms: true },
  finetuned: { label: 'Fine-tuned model deployment', q: 0.85, terms: true },
};
const SECTIONS = [['party', 'Parties'], ['obligation', 'Obligations'], ['date', 'Deadlines & dates']];

function generate(p, doc) {
  const t = TECH[p.technique];
  const r = rng(`${p.document}|${p.technique}|${p.temperature}|${p.rubricPrompt}|${p.template}`);
  let q = t.q + (p.rubricPrompt ? 0.25 : 0) + (p.template ? 0.1 : 0) - (p.temperature > 0.8 ? 0.1 : 0);
  if (p.technique === 'finetuned' && p.ftStatus === 'old-format') q -= 0.1;
  const kept = doc.facts.filter(() => r() < q);
  const termsOk = p.glossary || t.terms;
  const lay = s => (termsOk ? s : Object.entries(doc.terms).reduce((acc, [k, v]) => acc.replace(new RegExp(k, 'gi'), v), s));
  const fabricated = p.temperature >= (p.technique === 'rag' ? 1.3 : 1.0);
  const cites = p.cite || (p.technique === 'finetuned' && p.ftStatus === 'deployed');
  const formatted = p.template && !(p.technique === 'finetuned' && p.ftStatus === 'old-format');
  const items = kept.map(f => ({ ...f, out: lay(f.text) + (cites ? ` [§${f.clause}]` : '') }));
  if (fabricated) items.push({ type: 'obligation', text: doc.fabricated, out: doc.fabricated + (cites ? ' [§?]' : ''), clause: null, fabricated: true });
  let rendered;
  if (p.task === 'extraction') {
    const obj = Object.fromEntries(SECTIONS.map(([k, h]) => [formatted ? h.toLowerCase().replace(/[^a-z]+/g, '_') : h, items.filter(i => i.type === k).map(i => i.out)]));
    rendered = formatted ? JSON.stringify(obj, null, 2) : 'Here are the details I found:\n' + items.map(i => '- ' + i.out).join('\n');
  } else {
    rendered = formatted ? SECTIONS.map(([k, h]) => `## ${h}\n` + (items.filter(i => i.type === k).map(i => `- ${i.out}`).join('\n') || '- (none stated)')).join('\n\n')
      : 'Summary: ' + items.map(i => i.out).join('. ') + '.';
  }
  return { items, rendered, termsOk, fabricated, cites, formatted, q };
}

function run(p) {
  const doc = DOCS[p.document] || DOCS.dpa;
  const t = TECH[p.technique] || TECH.prompt;
  const steps = [];
  const source = doc.clauses.map(([c, s]) => `§${c} ${s}`).join('\n');
  steps.push(step('doc', 'Source document', `${doc.label}: ${doc.clauses.length} clauses, ~${estTokens(source)} tokens.`, { clauses: doc.clauses.length }));

  // Prompt assembly
  const parts = ['system: role = compliance analyst'];
  if (p.rubricPrompt) parts.push('rubric: list every party, obligation and deadline');
  if (p.template) parts.push(p.task === 'extraction' ? 'output: JSON {parties, obligations, deadlines_dates}' : 'output: headings Parties / Obligations / Deadlines & dates');
  if (p.glossary) parts.push(`glossary: use ${Object.keys(doc.terms).join(', ')} verbatim`);
  if (p.cite) parts.push('cite the clause for every statement as [§n]');
  if (p.technique === 'fewshot') parts.push('2 example input → output pairs');
  steps.push(step('prompt', 'Prompt assembled', parts.join(' • '), { components: parts, approxPromptTokens: estTokens(source) + parts.length * 40 + (p.technique === 'fewshot' ? 600 : 0) }));

  if (p.technique === 'rag') {
    if (!p.searchAccess) {
      steps.push(step('retrieve', '403 from Azure AI Search', 'The app identity lacks "Search Index Data Reader" on the policy-guidance index. No grounding context retrieved.', { httpStatus: 403, role: 'Search Index Data Reader (missing)' }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: 'Retrieval failed; the pipeline stops rather than summarising without the policy context.' }], metrics: [], summary: 'RAG: 403 on retrieval', meta: {} };
    }
    steps.push(step('retrieve', 'Retrieved glossary + guidance', 'Top chunks from the compliance-guidance index: approved terminology and what reviewers expect in a summary.', { chunks: [`glossary: ${Object.keys(doc.terms).join('; ')}`, 'guidance: every obligation needs its deadline'] }));
  } else steps.push(step('retrieve', 'No retrieval', 'Only what is in the prompt.', null, 'skip'));

  if (p.technique === 'finetuned' && p.ftStatus === 'not-deployed') {
    steps.push(step('model', '404: deployment not found', 'The fine-tuning job succeeded, but the fine-tuned model was never deployed. Inference calls address a deployment name, not the model ID.', { httpStatus: 404, code: 'DeploymentNotFound' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Deploy the fine-tuned model (and remember deployed fine-tuned models typically incur hosting charges even when idle; check pricing).' }], metrics: [], summary: 'Fine-tuned: not deployed', meta: {} };
  }

  const g = generate(p, doc);
  const outTokens = estTokens(g.rendered);
  let rendered = g.rendered, truncated = false;
  if (outTokens > p.maxTokens) { truncated = true; rendered = g.rendered.slice(0, p.maxTokens * 4) + '…'; }
  const visible = it => rendered.includes(it.out.slice(0, 25));
  steps.push(step('model', `Generated with ${t.label}`, `Temperature ${p.temperature}. ~${outTokens} output tokens${truncated ? `, cut at max_tokens=${p.maxTokens}` : ''}.`, { finish_reason: truncated ? 'length' : 'stop', technique: p.technique }, truncated ? 'warn' : 'ok'));
  if (p.technique === 'finetuned' && p.ftStatus === 'old-format') steps.push(step('model', 'Fine-tuned model follows its training format', 'The model was trained on an older output format (flat bullets). The template instruction is mostly ignored: the training data, not the prompt, now defines the format.', null, 'warn'));

  // Rubric
  const crit = [];
  for (const [k, h] of SECTIONS) {
    const all = doc.facts.filter(f => f.type === k);
    const got = all.filter(f => g.items.some(i => i.text === f.text && visible(i)));
    crit.push({ name: h, pass: got.length === all.length, detail: `${got.length}/${all.length}`, missing: all.filter(f => !got.includes(f)).map(f => f.text) });
  }
  crit.push({ name: 'Domain terminology', pass: g.termsOk, detail: g.termsOk ? 'approved terms used' : `lay terms used (${Object.values(doc.terms).join(', ')})` });
  crit.push({ name: 'Traceable to clauses', pass: g.cites && !g.fabricated, detail: g.cites ? (g.fabricated ? 'one statement cites no clause [§?]' : 'every item cites a clause') : 'no citations' });
  crit.push({ name: p.task === 'extraction' ? 'Valid JSON with expected keys' : 'Required headings', pass: g.formatted && !truncated, detail: g.formatted ? (truncated ? 'truncated' : 'present') : 'free text' });
  crit.push({ name: 'No unsupported claims', pass: !g.fabricated, detail: g.fabricated ? `"${doc.fabricated}" is not in the source` : 'all statements supported' });
  const score = crit.filter(c => c.pass).length / crit.length;
  const pass = score >= p.passMark && !g.fabricated;
  steps.push(step('rubric', `Rubric score ${Math.round(score * 100)}%`, crit.filter(c => !c.pass).map(c => `${c.name}: ${c.detail}`).join('; ') || 'All criteria met.', { criteria: crit }, g.fabricated ? 'error' : score < p.passMark ? 'warn' : 'ok'));
  steps.push(step('review', pass ? 'Auto-published to compliance portal' : g.fabricated ? 'Blocked: unsupported claim' : 'Sent to reviewer', pass ? `Score ≥ pass mark ${p.passMark}.` : g.fabricated ? 'A compliance summary that invents obligations must never be published.' : `Score below pass mark ${p.passMark}.`, null, pass ? 'ok' : g.fabricated ? 'error' : 'warn'));

  // Recommendations derived from failures
  const recs = [];
  if (crit.slice(0, 3).some(c => !c.pass)) recs.push(['Facts missing', p.rubricPrompt ? 'Add few-shot examples or RAG guidance' : 'Put the rubric in the system prompt']);
  if (!g.termsOk) recs.push(['Lay terminology', 'Glossary in prompt, RAG over a glossary, or few-shot examples']);
  if (!g.cites) recs.push(['No traceability', 'Require clause citations [§n]']);
  if (!g.formatted) recs.push(['Format drift', p.technique === 'finetuned' ? 'Retrain on the current format, or go back to prompting' : 'Output template / structured outputs']);
  if (truncated) recs.push(['Truncated', 'Raise max_tokens or shorten the template']);
  if (g.fabricated) recs.push(['Invented content', 'Lower temperature; ground with RAG; check citations exist in the source']);
  if (!recs.length) recs.push(['Nothing to fix', p.technique === 'finetuned' ? 'Consider whether prompting/RAG would reach the same score at lower cost and effort' : 'Fine-tuning only if you need the same at very high volume with shorter prompts']);

  const output = [
    { type: 'code', title: p.task === 'extraction' ? 'Model output (domain extraction)' : 'Model output (compliance summary)', lang: p.task === 'extraction' && g.formatted ? 'json' : 'markdown', text: rendered },
    { type: 'bars', title: 'Rubric', threshold: p.passMark, items: crit.map(c => ({ label: c.name, value: c.pass ? 1 : 0, max: 1, tone: c.pass ? 'ok' : c.name === 'No unsupported claims' ? 'error' : 'warn', note: c.detail })) },
    { type: 'table', title: 'What to change next', columns: ['Observed problem', 'Customisation lever'], rows: recs },
    { type: 'text', title: 'Source clauses', text: source },
  ];
  return {
    steps, output,
    metrics: [
      metric('Rubric score', `${Math.round(score * 100)}%`, 'computed', `${crit.filter(c => c.pass).length}/${crit.length} criteria`),
      metric('Facts recalled', `${crit.slice(0, 3).reduce((a, c) => a + Number(c.detail.split('/')[0]), 0)}/${doc.facts.length}`, 'computed'),
      metric('Prompt tokens', `~${estTokens(source) + parts.length * 40 + (p.technique === 'fewshot' ? 600 : 0)}`, 'estimate', '4-chars-per-token heuristic; few-shot examples assumed ~600 tokens. Fine-tuning shortens prompts but adds training and hosting cost.'),
      metric('Effort to change', p.technique === 'finetuned' ? 'high (new training run)' : p.technique === 'rag' ? 'medium (update index)' : 'low (edit prompt)', 'estimate', 'Relative effort to update behaviour when rules change.'),
    ],
    summary: `${doc.label} • ${t.label} • rubric ${Math.round(score * 100)}%${g.fabricated ? ' • invented claim' : ''}`,
    meta: { score, fabricated: g.fabricated },
  };
}

export default {
  id: '4.1.4',
  lab: 'Domain output rubric bench',
  services: [
    { name: 'Prompt engineering techniques (Azure OpenAI)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/prompt-engineering' },
    { name: 'Fine-tuning models in Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/fine-tuning' },
    { name: 'Retrieval-augmented generation in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview' },
  ],
  prereqs: ['4.1.1', '2.3.1'],
  next: ['2.1.4', '1.4.2'],

  concept: {
    plain: 'A general model writes general summaries. A compliance officer needs something stricter: every party, every obligation and every deadline, in the right legal words, pointing to the clause it came from, and nothing made up. You get there step by step: clear instructions, examples, reference material, and only if needed a specially trained model. A checklist (rubric) tells you whether each change helped.',
    technical: 'Customisation levers, in increasing cost: system prompt with an explicit rubric and output template (or structured outputs), few-shot examples, a glossary, grounding with RAG over policy/glossary content (Azure AI Search, "Search Index Data Reader" role), and fine-tuning (supervised fine-tuning on input→output pairs, then a separate deployment). Evaluate each variant against a rubric (coverage of parties/obligations/dates, terminology, citation traceability, format, groundedness), e.g. with azure-ai-evaluation custom evaluators, and keep temperature low for compliance tasks. Fine-tuning fixes format and style; it does not keep knowledge current.',
    useCase: 'A bank\'s compliance team receives 300 regulatory notices a month. A summarisation flow uses a system prompt with a rubric, few-shot examples and a glossary retrieved from Azure AI Search; each summary is scored by an evaluator, and anything under 85% or with an uncited statement goes to a human reviewer.',
    terms: [
      ['Rubric', 'Explicit checklist of what a good output must contain; usable both in the prompt and as an evaluator.'],
      ['Few-shot', 'Worked input→output examples in the prompt that show format and terminology.'],
      ['Fine-tuning', 'Training a model on your examples; produces a new model that must be deployed before use.'],
      ['Groundedness', 'Every statement is supported by the source; invented obligations are the worst failure in compliance.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'doc', label: 'Domain document', col: 0, row: 1, kind: 'data', detail: 'Contract, clinical note or regulatory notice.' },
          { id: 'prompt', label: 'Prompt design', col: 1, row: 0, detail: 'Role, rubric, template, glossary, citation rule, few-shot.', substeps: ['Role', 'Rubric', 'Template', 'Glossary', 'Examples'] },
          { id: 'retrieve', label: 'Grounding (RAG)', col: 1, row: 2, kind: 'store', disabled: p && p.technique !== 'rag', detail: 'Retrieve glossary and policy guidance.' },
          { id: 'model', label: p && p.technique === 'finetuned' ? 'Fine-tuned model' : 'Base model', col: 2, row: 1, kind: 'ai', badge: p ? `t=${p.temperature}` : undefined, detail: 'Generates summary or extraction.' },
          { id: 'rubric', label: 'Rubric evaluator', col: 3, row: 1, kind: 'policy', detail: 'Coverage, terminology, citations, format, groundedness.' },
          { id: 'review', label: 'Publish / human review', col: 4, row: 1, kind: 'user', detail: 'Pass mark decides routing.' },
        ],
        edges: [['doc', 'prompt'], ['doc', 'retrieve'], ['prompt', 'model'], ['retrieve', 'model'], ['model', 'rubric'], ['rubric', 'review']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'doc', label: 'Blob Storage (notices)', col: 0, row: 1, kind: 'store', detail: 'Incoming documents.' },
          { id: 'prompt', label: 'Prompt flow / app code', col: 1, row: 1, kind: 'compute', detail: 'Prompt templates versioned in source control.' },
          { id: 'retrieve', label: 'Azure AI Search (glossary index)', col: 2, row: 0, kind: 'store', disabled: p && p.technique !== 'rag', badge: p && p.technique === 'rag' && !p.searchAccess ? 'no role' : undefined, detail: 'Needs Search Index Data Reader for the app identity.' },
          { id: 'model', label: p && p.technique === 'finetuned' ? 'Fine-tuned deployment' : 'Foundry model deployment', col: 2, row: 2, kind: 'ai', badge: p && p.technique === 'finetuned' ? p.ftStatus : undefined, detail: 'Fine-tuned models are trained in Foundry, then deployed under their own deployment name.' },
          { id: 'rubric', label: 'Evaluation (azure-ai-evaluation)', col: 3, row: 1, kind: 'policy', detail: 'Custom rubric evaluator + groundedness.' },
          { id: 'review', label: 'Compliance portal / review queue', col: 4, row: 1, kind: 'app', detail: 'Routing by score.' },
        ],
        edges: [['doc', 'prompt'], ['prompt', 'retrieve'], ['prompt', 'model'], ['model', 'rubric'], ['rubric', 'review']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'prompt', label: `messages = [system(ROLE + ${p && p.rubricPrompt ? 'RUBRIC + ' : ''}${p && p.template ? 'TEMPLATE + ' : ''}${p && p.glossary ? 'GLOSSARY' : '...'})${p && p.technique === 'fewshot' ? ', *EXAMPLES' : ''}, user(doc)]`, col: 0, row: 0, kind: 'code', detail: 'Prompt template.' },
          { id: 'retrieve', label: 'ctx = search_client.search(query, top=3)', col: 0, row: 1, kind: 'code', disabled: p && p.technique !== 'rag', detail: 'azure-search-documents.' },
          { id: 'model', label: `client.chat.completions.create(model="${p && p.technique === 'finetuned' ? 'ft-compliance-v2' : 'gpt-4.1'}", temperature=${p ? p.temperature : 0.2}, max_tokens=${p ? p.maxTokens : 400})`, col: 0, row: 2, kind: 'code', detail: 'Deployment name, not base model ID. Illustrative.' },
          { id: 'rubric', label: 'score = rubric_evaluator(response=out, context=doc)', col: 0, row: 3, kind: 'code', detail: 'Custom evaluator (code or LLM-judge).' },
          { id: 'review', label: 'publish(out) if score >= PASS else queue_for_review(out)', col: 0, row: 4, kind: 'code', detail: 'Routing.' },
        ],
        edges: [['prompt', 'retrieve'], ['retrieve', 'model'], ['model', 'rubric'], ['rubric', 'review']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Domain document', type: 'select', options: Object.entries(DOCS).map(([k, d]) => [k, d.label]), default: 'dpa' },
      { id: 'task', label: 'Task', type: 'select', options: [['summary', 'Compliance summary'], ['extraction', 'Domain extraction (JSON)']], default: 'summary' },
      { id: 'technique', label: 'Customisation technique', type: 'select', options: Object.entries(TECH).map(([k, t]) => [k, t.label]), default: 'prompt' },
      { id: 'rubricPrompt', label: 'Rubric in system prompt', type: 'toggle', default: false },
      { id: 'template', label: 'Output template / schema', type: 'toggle', default: false },
      { id: 'glossary', label: 'Domain glossary in prompt', type: 'toggle', default: false },
      { id: 'cite', label: 'Require clause citations', type: 'toggle', default: false },
      { id: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 1.5, step: 0.1, default: 0.7 },
      { id: 'maxTokens', label: 'max_tokens', type: 'number', min: 40, max: 1000, step: 20, default: 400 },
      { id: 'passMark', label: 'Pass mark', type: 'range', min: 0.5, max: 1, step: 0.05, default: 0.85 },
      { id: 'ftStatus', label: 'Fine-tuned model status', type: 'select', options: [['deployed', 'Deployed (current format)'], ['old-format', 'Deployed, trained on old format'], ['not-deployed', 'Trained, not deployed']], default: 'deployed' },
      { id: 'searchAccess', label: 'App identity can read the search index', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'DPA, bare prompt', values: { document: 'dpa', technique: 'prompt' } },
      { label: 'DPA, full prompt design', values: { document: 'dpa', technique: 'prompt', rubricPrompt: true, template: true, glossary: true, cite: true, temperature: 0.2 } },
      { label: 'Clinical note, few-shot extraction', values: { document: 'clinical', task: 'extraction', technique: 'fewshot', template: true, rubricPrompt: true, temperature: 0.2 } },
      { label: 'AML notice, RAG', values: { document: 'aml', technique: 'rag', rubricPrompt: true, template: true, cite: true, temperature: 0.2 } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the DPA with the bare prompt, then add rubric, template, glossary and citations one at a time and compare rubric scores.',
      'Run the AML notice with few-shot vs RAG vs fine-tuned (all with rubric + template) and compare score vs effort-to-change.',
      'Run the clinical note at temperature 0.2 and 1.2 and compare the "No unsupported claims" criterion.',
    ],
  },

  debug: [
    { id: 'truncated', title: 'Summaries stop halfway', values: { rubricPrompt: true, template: true, cite: true, glossary: true, temperature: 0.2, maxTokens: 60 }, node: 'model',
      symptom: 'finish_reason = "length"; the Deadlines section is cut off.', cause: 'max_tokens is too small for the template.', fix: 'Raise max_tokens (e.g. 400) or shorten the template.' },
    { id: 'ftnotdeployed', title: '404 after a successful fine-tuning job', values: { technique: 'finetuned', ftStatus: 'not-deployed' }, node: 'model',
      symptom: 'DeploymentNotFound when calling the fine-tuned model.', cause: 'A fine-tuned model must be deployed before inference.', fix: 'Deploy it (select "Deployed") and call the deployment name.' },
    { id: 'invented', title: 'Summary lists an obligation that is not in the contract', values: { document: 'dpa', technique: 'prompt', rubricPrompt: true, template: true, temperature: 1.2 }, node: 'rubric',
      symptom: '"Processor must encrypt all data with AES-256" appears; groundedness fails.', cause: 'High temperature without grounding or citation checks.', fix: 'Lower temperature (≤0.3) and require clause citations so unsupported items are visible.' },
    { id: 'oldformat', title: 'Fine-tuned model ignores the new template', values: { technique: 'finetuned', ftStatus: 'old-format', template: true, temperature: 0.2 }, node: 'model',
      symptom: 'Output is flat bullets without the required headings.', cause: 'Training data used an older format; the fine-tuned behaviour overrides the prompt.', fix: 'Retrain on the current format, or switch back to prompting/few-shot with the template.' },
    { id: 'searchrole', title: 'RAG variant fails with 403', values: { technique: 'rag', searchAccess: false }, node: 'retrieve',
      symptom: 'Retrieval returns 403.', cause: 'The app identity has no "Search Index Data Reader" role on the index.', fix: 'Assign the role (toggle access on).' },
    { id: 'lay', title: 'Reviewers reject wording', values: { document: 'aml', technique: 'prompt', rubricPrompt: true, template: true, cite: true, temperature: 0.2 }, node: 'prompt',
      symptom: '"background checks" and "fraud report" instead of the regulatory terms.', cause: 'No glossary or examples: the model uses everyday language.', fix: 'Add the domain glossary (or few-shot / RAG).' },
  ],

  challenge: {
    task: 'Get the clinical discharge note to a 100% rubric score without fine-tuning.',
    condition: 'Document = discharge note, technique ≠ fine-tuned, rubric score = 100%, no errors.',
    hint: 'Coverage, terminology, citations and format each have their own lever. Keep temperature low.',
    check: (p, res) => p.document === 'clinical' && p.technique !== 'finetuned' && !!res.meta && res.meta.score === 1 && !res.steps.some(s => s.status === 'error'),
    solution: ['Technique: RAG (or few-shot).', 'Turn on rubric in prompt, output template, glossary and clause citations.', 'Temperature 0.2, max_tokens 400.', 'Run: all seven criteria pass.'],
    solutionValues: { document: 'clinical', task: 'summary', technique: 'rag', rubricPrompt: true, template: true, glossary: true, cite: true, temperature: 0.2, maxTokens: 400, searchAccess: true },
  },

  quiz: [
    { q: 'Compliance summaries often miss deadlines and use lay terms. Regulations change monthly. What should you try first?', options: ['Fine-tune on last year\'s summaries', 'System prompt with an explicit rubric and template, plus a glossary retrieved via RAG', 'Raise temperature for more detail', 'Switch to a smaller model'], answer: 1, why: 'Start with cheap, easily updated levers. RAG keeps changing knowledge current; fine-tuning would freeze last year\'s rules.' },
    { q: 'After weeks of prompt work, outputs are correct but formats vary across 2 million monthly calls, and long prompts drive cost. Which lever now makes sense?', options: ['Fine-tuning on high-quality input→output pairs', 'Higher temperature', 'Removing the rubric', 'Adding more retrieved chunks'], answer: 0, why: 'Fine-tuning is suited to consistent format/style at scale with shorter prompts, once you have good training examples.' },
    { q: 'A summary contains an obligation that no clause supports. Which combination best prevents publication?', options: ['Longer max_tokens', 'Low temperature, mandatory clause citations, and a groundedness criterion that blocks publication', 'Character masking', 'Few-shot examples only'], answer: 1, why: 'Citations make support checkable and a blocking groundedness check stops invented content.' },
  ],

  recap: 'Customise domain outputs with the cheapest lever that works: rubric and template in the system prompt, glossary, few-shot examples, RAG for changing knowledge, and fine-tuning only for consistent format at scale. Measure every change against a rubric, require citations, keep temperature low, and block anything ungrounded.',
};
