// 1.2.2 Choose appropriate deployment options
// Lab: Deployment type chooser.
import { step, metric } from '../src/engine/util.js';

// scope: where inference may be processed. billing: token | ptu | batch | vm.
// Values are qualitative. Exact prices, PTU minimums and quotas change: check the docs.
const OPTIONS = {
  globalStandard: { label: 'Global Standard', scope: 'global', billing: 'token', sources: ['aoai'], sku: 'GlobalStandard' },
  dataZoneStandard: { label: 'Data Zone Standard', scope: 'zone', billing: 'token', sources: ['aoai'], sku: 'DataZoneStandard' },
  standard: { label: 'Standard (regional)', scope: 'region', billing: 'token', sources: ['aoai'], sku: 'Standard' },
  globalProvisioned: { label: 'Global Provisioned (PTU)', scope: 'global', billing: 'ptu', sources: ['aoai'], sku: 'GlobalProvisionedManaged' },
  dataZoneProvisioned: { label: 'Data Zone Provisioned (PTU)', scope: 'zone', billing: 'ptu', sources: ['aoai'], sku: 'DataZoneProvisionedManaged' },
  provisioned: { label: 'Provisioned (regional PTU)', scope: 'region', billing: 'ptu', sources: ['aoai'], sku: 'ProvisionedManaged' },
  globalBatch: { label: 'Global Batch', scope: 'global', billing: 'batch', sources: ['aoai'], sku: 'GlobalBatch' },
  dataZoneBatch: { label: 'Data Zone Batch', scope: 'zone', billing: 'batch', sources: ['aoai'], sku: 'DataZoneBatch' },
  serverless: { label: 'Serverless API (pay-as-you-go)', scope: 'region', billing: 'token', sources: ['partner'], sku: 'serverless endpoint' },
  managedCompute: { label: 'Managed compute (dedicated VMs)', scope: 'region', billing: 'vm', sources: ['partner', 'custom'], sku: 'managed online endpoint' },
};

const SOURCES = {
  aoai: 'Azure OpenAI model (sold directly by Azure)',
  partner: 'Partner / open model from the catalog (e.g. Llama, Mistral)',
  custom: 'Your own fine-tuned open-weight model',
};

const SCOPE_TEXT = { global: 'any Azure region worldwide', zone: 'regions inside one data zone (e.g. EU or US)', region: 'the deployment region only' };

function assess(id, p) {
  const o = OPTIONS[id];
  const hard = [];
  const soft = [];
  if (!o.sources.includes(p.source)) hard.push(p.source === 'custom' ? 'custom weights need managed compute' : p.source === 'partner' ? 'not how this partner model is offered (in this simulation: serverless API or managed compute)' : 'Azure OpenAI models are not deployed this way');
  if (p.residency === 'zone' && o.scope === 'global') hard.push('may process outside the data zone');
  if (p.residency === 'region' && o.scope !== 'region') hard.push(`may process in ${SCOPE_TEXT[o.scope]}`);
  if (o.billing === 'batch' && p.traffic !== 'bulk') hard.push('asynchronous (target turnaround up to 24h): cannot serve interactive users');
  let score = 70;
  if (o.billing !== 'batch' && p.traffic === 'bulk') { score -= 25; soft.push('interactive pricing for work that can wait: batch is cheaper'); }
  if (p.latency === 'predictable' && (o.billing === 'token')) { score -= 25; soft.push('shared capacity: no latency guarantee and 429s at peaks'); }
  if (p.traffic === 'spiky' && o.billing === 'ptu') { score -= 25; soft.push('reserved capacity sits idle between spikes'); }
  if (p.traffic === 'spiky' && o.billing === 'vm') { score -= 20; soft.push('VMs bill while idle; you manage scale-out'); }
  if (p.volume <= 3 && o.billing === 'ptu') { score -= 20; soft.push('volume too low to justify a PTU commitment'); }
  if (p.volume >= 7 && p.traffic === 'steady' && o.billing === 'token') { score -= 12; soft.push('sustained high volume: likely to hit TPM quota; PTU can cost less at high utilisation'); }
  if (o.scope === 'region' && o.billing === 'token' && id === 'standard') { score -= 6; soft.push('regional Standard: narrower model availability and lower default quota than Global/Data Zone'); }
  if (o.scope === 'global' && p.residency === 'none') score += 6; // largest capacity pool
  if (o.scope === 'zone' && p.residency === 'zone') score += 6;
  if (id === 'managedCompute' && p.source === 'partner') { score -= 8; soft.push('you manage VM SKU, scaling and patching versus a serverless API'); }
  if (o.billing === 'batch' && p.traffic === 'bulk') score += 10;
  if (o.billing === 'ptu' && p.traffic === 'steady' && p.latency === 'predictable' && p.volume >= 5) score += 10;
  return { id, label: o.label, hard, soft, score: hard.length ? 0 : Math.max(1, score) };
}

function choose(p) {
  const steps = [];
  steps.push(step('workload', 'Workload profile', `${SOURCES[p.source]}; traffic ${p.traffic}; latency ${p.latency}; relative volume ${p.volume}/10; residency: ${p.residency === 'none' ? 'no constraint' : p.residency === 'zone' ? 'within one data zone' : 'single region'}.`,
    { source: p.source, traffic: p.traffic, latency: p.latency, volume: p.volume, residency: p.residency }, 'info'));
  const all = Object.keys(OPTIONS).map(id => assess(id, p));
  const viable = all.filter(a => !a.hard.length).sort((a, b) => b.score - a.score);
  const bySource = all.filter(a => OPTIONS[a.id].sources.includes(p.source));
  steps.push(step('source', 'Options for this model source', `${bySource.map(a => a.label).join(', ')}.`, { available: bySource.map(a => a.label) }));
  const resOut = bySource.filter(a => a.hard.some(h => /process/.test(h)));
  steps.push(step('residency', 'Data residency filter', resOut.length ? `Excluded: ${resOut.map(a => a.label).join(', ')} (inference could run outside the allowed boundary). Data at rest stays in the resource geography for all types; processing location is what differs.` : 'No option excluded by residency.', { excluded: resOut.map(a => a.label) }));
  steps.push(step('throughput', 'Throughput and billing fit', viable.length ? `Best fit: ${viable[0].label}. ${viable[0].soft.length ? 'Caveats: ' + viable[0].soft.join('; ') : 'No caveats.'}` : 'Nothing viable.', Object.fromEntries(viable.map(v => [v.label, { score: v.score, caveats: v.soft }])), viable.length ? 'ok' : 'error'));

  const mine = all.find(a => a.id === p.choice);
  const rank = viable.findIndex(v => v.id === p.choice) + 1;
  let status = 'ok';
  let text;
  if (mine.hard.length) { status = 'error'; text = `${mine.label} is not valid here: ${mine.hard.join('; ')}.`; }
  else if (rank > 1 && viable[0].score - mine.score >= 10) { status = 'warn'; text = `${mine.label} works but ranks #${rank}: ${mine.soft.join('; ') || 'lower fit'}. Consider ${viable[0].label}.`; }
  else text = rank === 1 ? `${mine.label} is the best fit.` : `${mine.label} is close to the best fit (#${rank}).`;
  steps.push(step('choice', status === 'error' ? 'Deployment type rejected' : status === 'warn' ? 'Better deployment type available' : rank === 1 ? 'Best-fit deployment type' : 'Acceptable deployment type', text,
    { chosen: mine.label, skuName: OPTIONS[p.choice].sku, rank: rank || 'invalid', processing: SCOPE_TEXT[OPTIONS[p.choice].scope], billing: OPTIONS[p.choice].billing }, status));

  const o = OPTIONS[p.choice];
  const tier = { predict: { token: 0.35, ptu: 0.95, batch: 0.2, vm: 0.8 }[o.billing], residency: { global: 0.2, zone: 0.6, region: 1 }[o.scope], elastic: { token: 0.95, ptu: 0.3, batch: 0.9, vm: 0.4 }[o.billing] };
  return {
    steps,
    output: [
      { type: 'table', title: 'Deployment options for this workload', columns: ['Option', 'Processing location', 'Billing', 'Verdict', 'Reason'],
        rows: all.slice().sort((a, b) => b.score - a.score).map(a => [a.label, SCOPE_TEXT[OPTIONS[a.id].scope], { token: 'per token', ptu: 'reserved PTU', batch: 'per token, discounted, async', vm: 'per VM hour' }[OPTIONS[a.id].billing], a.hard.length ? 'Invalid' : a.id === viable[0]?.id ? 'Best fit' : `Viable (${a.score})`, a.hard[0] || a.soft[0] || 'good fit']),
        tones: all.slice().sort((a, b) => b.score - a.score).map(a => (a.hard.length ? 'error' : a.id === viable[0]?.id ? 'ok' : a.id === p.choice ? 'warn' : undefined)) },
      { type: 'bars', title: `${o.label}: qualitative profile`, items: [
        { label: 'Latency predictability', value: tier.predict, note: o.billing === 'ptu' ? 'reserved capacity' : o.billing === 'batch' ? 'async, hours' : 'shared pool' },
        { label: 'Residency strictness', value: tier.residency, note: SCOPE_TEXT[o.scope] },
        { label: 'Cost elasticity (pay for what you use)', value: tier.elastic, note: o.billing === 'ptu' ? 'pay for reserved units even when idle' : o.billing === 'vm' ? 'pay while VMs run' : 'pay per token' },
      ] },
      { type: 'json', title: 'Deployment resource (illustrative ARM shape)', data: o.billing === 'vm' || p.choice === 'serverless' ? { kind: o.sku, model: p.source === 'custom' ? 'your-registered-model:1' : 'partner-model-id', instanceType: o.billing === 'vm' ? '<GPU VM SKU>' : undefined } : { sku: { name: o.sku, capacity: o.billing === 'ptu' ? '<PTUs>' : '<TPM units>' }, properties: { model: { format: 'OpenAI', name: '<model>', version: '<version>' } } } },
      ...(status !== 'ok' ? [{ type: 'alert', tone: status, text }] : []),
    ],
    metrics: [
      metric('Valid options', `${viable.length}/${all.length}`, 'computed'),
      metric('Your choice rank', rank ? `#${rank}` : 'invalid', 'computed'),
      metric('Cost model', { token: 'pay per token', ptu: 'reserved hourly / reservation', batch: 'discounted per token', vm: 'per VM hour' }[o.billing], 'estimate', 'Qualitative only. Batch is discounted relative to Global Standard and PTU reservations can lower cost at high utilisation; check current pricing.'),
    ],
    summary: `${o.label}: ${status === 'error' ? 'invalid' : `rank #${rank}`} (${p.traffic}, ${p.latency}, residency ${p.residency})`,
  };
}

export default {
  id: '1.2.2',
  lab: 'Deployment type chooser',
  services: [
    { name: 'Deployment types for Foundry Models', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/deployment-types' },
    { name: 'Provisioned throughput (PTU) concepts', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/provisioned-throughput' },
    { name: 'Batch deployments', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/batch' },
    { name: 'Deployment options for models in the catalog', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/deployments-overview' },
  ],
  prereqs: ['1.1.1', '1.2.1'],
  next: ['1.2.3', '1.3.1'],

  concept: {
    plain: 'Deploying a model also means choosing how you pay and where the work happens. Pay-per-token shared capacity is flexible but can slow down or throttle at busy times. Reserved capacity gives steady speed but you pay for it even when idle. Batch is cheaper but answers can take hours. Global options use capacity anywhere in the world; data-zone and regional options keep processing inside a boundary.',
    technical: 'Azure OpenAI deployment types in Foundry: Standard (regional), Global Standard and Data Zone Standard (pay-per-token, shared capacity, TPM quota); Provisioned, Global Provisioned and Data Zone Provisioned (PTU-based reserved throughput with predictable latency, hourly or reservation billing); Global Batch and Data Zone Batch (asynchronous JSONL jobs with a target turnaround of up to 24 hours at a discount). Global types may process in any Azure region, Data Zone types within the US or EU data zone; data at rest stays in the resource geography. Other catalog models use serverless API deployments (pay-as-you-go) or managed compute (dedicated VMs, needed for custom weights).',
    useCase: 'A European insurer runs three workloads: an internal chat assistant (Data Zone Standard: EU processing, pay per token), a high-volume claims triage service with latency SLOs (Data Zone Provisioned), and a nightly re-summarisation of 2 million documents (Data Zone Batch).',
    terms: [
      ['TPM', 'Tokens-per-minute quota assigned to a pay-per-token deployment.'],
      ['PTU', 'Provisioned throughput unit: reserved model processing capacity.'],
      ['Data zone', 'A geographic boundary (e.g. EU, US) within which Data Zone deployments process requests.'],
      ['Batch', 'Asynchronous processing of a JSONL file of requests at lower cost, results within a target window.'],
      ['Managed compute', 'Dedicated VMs hosting a model endpoint; billed per VM hour.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'workload', label: 'Workload profile', col: 0, row: 1, kind: 'user', detail: 'Traffic shape, latency need, volume, residency.' },
          { id: 'source', label: p ? `Model source: ${p.source}` : 'Model source', col: 1, row: 0, kind: 'data', detail: 'Azure OpenAI, partner catalog model, or custom weights decide which deployment kinds exist.' },
          { id: 'residency', label: 'Residency filter', col: 1, row: 2, kind: 'policy', detail: 'Global → Data Zone → Regional: progressively narrower processing boundary.' },
          { id: 'throughput', label: 'Throughput & billing', col: 2, row: 1, kind: 'compute', detail: 'Shared (per token), reserved (PTU), async (batch) or VMs.', substeps: ['Spiky → pay per token', 'Steady + SLO → PTU', 'Can wait → batch', 'Custom weights → managed compute'] },
          { id: 'choice', label: p ? OPTIONS[p.choice].label : 'Deployment type', col: 3, row: 1, kind: 'ai', detail: 'The SKU you create the deployment with.' },
        ],
        edges: [['workload', 'source'], ['workload', 'residency'], ['source', 'throughput'], ['residency', 'throughput'], ['throughput', 'choice']],
      }),
      architectural: p => {
        const o = p ? OPTIONS[p.choice] : null;
        return {
          nodes: [
            { id: 'workload', label: 'Client app / batch job', col: 0, row: 1, kind: 'app', detail: 'Interactive calls or JSONL batch uploads.' },
            { id: 'choice', label: `Foundry resource: deployment${o ? ` (${o.sku})` : ''}`, col: 1, row: 1, kind: 'ai', detail: 'One endpoint per resource; the deployment SKU decides routing and billing.' },
            { id: 'residency', label: o ? `Processing: ${SCOPE_TEXT[o.scope]}` : 'Processing location', col: 2, row: 0, kind: 'policy', detail: 'Global types route to capacity anywhere; data zone within EU/US; regional stays local.' },
            { id: 'throughput', label: o ? (o.billing === 'ptu' ? 'Reserved PTU capacity' : o.billing === 'vm' ? 'Dedicated VMs' : o.billing === 'batch' ? 'Batch queue' : 'Shared capacity pool (TPM quota)') : 'Capacity', col: 2, row: 2, kind: 'compute', detail: 'Where your tokens are processed.' },
            { id: 'source', label: 'Model catalog', col: 0, row: 2.5, kind: 'data', detail: 'Lists deployment options per model.' },
          ],
          edges: [['workload', 'choice'], ['choice', 'residency'], ['choice', 'throughput'], ['source', 'choice', 'deploy']],
        };
      },
      implementation: p => ({
        nodes: [
          { id: 'source', label: 'az cognitiveservices account deployment create ...', col: 0, row: 0, kind: 'code', detail: 'Illustrative CLI; Bicep resource Microsoft.CognitiveServices/accounts/deployments works too.' },
          { id: 'choice', label: `--sku-name ${p ? OPTIONS[p.choice].sku : 'GlobalStandard'} --sku-capacity <units>`, col: 0, row: 1, kind: 'code', detail: 'Capacity means TPM units for standard types and PTUs for provisioned types.' },
          { id: 'throughput', label: p && OPTIONS[p.choice].billing === 'batch' ? 'client.batches.create(input_file_id=..., endpoint="/chat/completions", completion_window="24h")' : 'client.chat.completions.create(model="<deployment-name>", ...)', col: 0, row: 2, kind: 'code', detail: 'Batch uses a file + job; interactive types use normal calls.' },
          { id: 'residency', label: 'Check: Data Zone / Regional SKU for residency', col: 0, row: 3, kind: 'code', detail: 'Residency is a deployment-type choice, not a request parameter.' },
          { id: 'workload', label: 'Monitor 429s and utilisation → revisit choice', col: 0, row: 4, kind: 'code', detail: 'Throttling on standard or idle PTUs are signals to change type.' },
        ],
        edges: [['source', 'choice'], ['choice', 'throughput'], ['throughput', 'residency'], ['residency', 'workload']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'source', label: 'Model source', type: 'select', options: Object.entries(SOURCES), default: 'aoai' },
      { id: 'traffic', label: 'Traffic shape', type: 'select', options: [['spiky', 'Spiky / unpredictable interactive'], ['steady', 'Steady, sustained interactive'], ['bulk', 'Offline bulk (can wait hours)']], default: 'spiky' },
      { id: 'latency', label: 'Latency requirement', type: 'select', options: [['besteffort', 'Best effort'], ['predictable', 'Predictable (SLO)']], default: 'besteffort' },
      { id: 'volume', label: 'Relative volume (1–10)', type: 'range', min: 1, max: 10, step: 1, default: 4 },
      { id: 'residency', label: 'Processing residency', type: 'select', options: [['none', 'No constraint'], ['zone', 'Must stay in data zone (e.g. EU)'], ['region', 'Must stay in one region']], default: 'none' },
      { id: 'choice', label: 'Your deployment type', type: 'select', options: Object.entries(OPTIONS).map(([v, o]) => [v, o.label]), default: 'globalStandard' },
    ],
    samples: [
      { label: 'Startup chatbot, no residency', values: {} },
      { label: 'EU bank, steady with SLO', values: { residency: 'zone', traffic: 'steady', latency: 'predictable', volume: 8, choice: 'dataZoneProvisioned' } },
      { label: 'Nightly summarisation', values: { traffic: 'bulk', volume: 9, choice: 'globalBatch' } },
      { label: 'Fine-tuned Llama', values: { source: 'custom', choice: 'managedCompute', traffic: 'steady' } },
    ],
    run: choose,
  },

  compare: {
    suggestions: [
      'EU residency, steady traffic with SLO: compare Data Zone Standard vs Data Zone Provisioned.',
      'Bulk traffic: compare Global Standard vs Global Batch.',
      'Spiky low volume: compare Global Standard vs Global Provisioned and read the caveats.',
    ],
  },

  debug: [
    { id: 'batch-chat', title: 'Chat users wait hours for replies', values: { traffic: 'spiky', choice: 'globalBatch' }, node: 'choice',
      symptom: 'Rejected: asynchronous, cannot serve interactive users.', cause: 'Batch deployments process JSONL jobs with a turnaround window, not live requests.', fix: 'Use Global Standard (or a provisioned type) for interactive traffic.' },
    { id: 'residency', title: 'Compliance flags EU data processed elsewhere', values: { residency: 'zone', choice: 'globalStandard' }, node: 'residency',
      symptom: 'Rejected: may process outside the data zone.', cause: 'Global deployments can route inference to any region.', fix: 'Choose Data Zone Standard (or Data Zone Provisioned).' },
    { id: 'mc-aoai', title: 'Cannot put GPT model on managed compute', values: { source: 'aoai', choice: 'managedCompute' }, node: 'source',
      symptom: 'Rejected: Azure OpenAI models are not deployed this way.', cause: 'Azure OpenAI models use Standard/Global/Data Zone/Provisioned/Batch SKUs.', fix: 'Pick a Standard or Provisioned type.' },
    { id: 'custom-serverless', title: 'Fine-tuned open model has nowhere to run', values: { source: 'custom', choice: 'serverless' }, node: 'source',
      symptom: 'Rejected: custom weights need managed compute.', cause: 'Serverless APIs host catalog models, not your uploaded weights (in this simulation).', fix: 'Choose Managed compute.' },
    { id: 'ptu-idle', title: 'Paying for idle capacity', values: { traffic: 'spiky', volume: 2, choice: 'globalProvisioned' }, node: 'throughput',
      symptom: 'Warning: reserved capacity idle; volume too low.', cause: 'PTUs are billed whether used or not.', fix: 'Use Global Standard for spiky low-volume traffic.' },
    { id: 'slo-standard', title: 'Latency SLO missed at peak', values: { traffic: 'steady', latency: 'predictable', volume: 8, choice: 'standard' }, node: 'throughput',
      symptom: 'Warning: shared capacity, 429s at peaks.', cause: 'Pay-per-token deployments share capacity and have TPM limits.', fix: 'Choose a provisioned (PTU) type.' },
  ],

  challenge: {
    task: 'An EU bank runs a steady, high-volume claims assistant with a latency SLO; processing must stay in the EU data zone. Choose the best-fit deployment type.',
    condition: 'Residency = data zone, traffic steady, latency predictable, volume ≥ 7, and your choice is the #1 option.',
    hint: 'Residency removes the Global types; the SLO points away from pay-per-token.',
    check: (p, res) => p.residency === 'zone' && p.traffic === 'steady' && p.latency === 'predictable' && p.volume >= 7 && res.steps.some(s => s.node === 'choice' && s.status === 'ok' && /Best-fit/.test(s.title)),
    solution: ['Model source: Azure OpenAI.', 'Residency: data zone; traffic: steady; latency: predictable; volume 8.', 'Choice: Data Zone Provisioned (PTU).'],
    solutionValues: { source: 'aoai', residency: 'zone', traffic: 'steady', latency: 'predictable', volume: 8, choice: 'dataZoneProvisioned' },
  },

  quiz: [
    { q: 'A consumer chatbot has unpredictable spikes, no residency requirement, and should be cheap at low traffic. Which deployment type?', options: ['Global Provisioned', 'Global Standard', 'Global Batch', 'Managed compute'], answer: 1, why: 'Pay-per-token global capacity absorbs spikes without paying for idle reservations.' },
    { q: 'You must re-classify 5 million archived tickets; results are needed by tomorrow and cost matters most. Which option?', options: ['Standard', 'Global Batch (or Data Zone Batch)', 'Provisioned', 'Serverless API'], answer: 1, why: 'Batch processes JSONL jobs asynchronously at a discount within a target window.' },
    { q: 'Requests must be processed only within the EU, with pay-per-token billing. Which type?', options: ['Global Standard', 'Data Zone Standard', 'Global Provisioned', 'Global Batch'], answer: 1, why: 'Data Zone Standard keeps processing in the EU data zone while billing per token.' },
    { q: 'You fine-tuned an open-weight model outside Azure and want to host it in Foundry. Which deployment option?', options: ['Serverless API', 'Managed compute', 'Global Standard', 'Data Zone Batch'], answer: 1, why: 'Custom weights run on managed compute (dedicated VMs).' },
  ],

  recap: 'Choose the deployment type from the workload: pay-per-token (Global/Data Zone/Standard) for variable traffic, provisioned PTUs for steady volume with latency SLOs, batch for work that can wait, serverless API or managed compute for catalog and custom models. Residency narrows the choice from Global to Data Zone to Regional.',
};
