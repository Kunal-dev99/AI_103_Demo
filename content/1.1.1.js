// 1.1.1 Choose an appropriate model for each task, including LLMs, small language models, multimodal models, and Foundry Tools
// Lab: Model selection advisor.
import { rng, round, step, metric } from '../src/engine/util.js';

// Task profiles: what the workload needs. out = the kind of output the task must produce.
const TASKS = {
  chat: { label: 'Customer-support chat (text in, text out)', input: 'text', out: 'text', reasoning: 1, volume: 2 },
  reasoning: { label: 'Multi-step planning / maths / root-cause analysis', input: 'text', out: 'text', reasoning: 3, volume: 1 },
  vision: { label: 'Answer questions about photos and charts', input: 'image', out: 'text', reasoning: 2, volume: 1 },
  docFields: { label: 'Extract fields from 50k invoices a month', input: 'document', out: 'fields', reasoning: 0, volume: 3 },
  translate: { label: 'Translate product catalogue (bulk, 30 languages)', input: 'text', out: 'translation', reasoning: 0, volume: 3 },
  search: { label: 'Semantic search over a knowledge base', input: 'text', out: 'vector', reasoning: 0, volume: 3 },
  transcribe: { label: 'Transcribe call-centre recordings', input: 'audio', out: 'transcript', reasoning: 0, volume: 3 },
  classify: { label: 'Classify short tickets into 8 categories', input: 'text', out: 'text', reasoning: 0, volume: 3 },
};

// Candidate families. Values are RELATIVE tiers (1 = low, 3 = high), not measured numbers.
// cost: relative cost per unit of work. latency: 1 = fastest. ctx: context tier.
const CANDIDATES = {
  frontier: { label: 'Frontier LLM (GPT-4.1 / GPT-5-class)', kind: 'LLM', inputs: ['text', 'image', 'document'], outs: ['text', 'fields', 'translation'], quality: 3, reasoning: 2, cost: 3, latency: 2, ctx: 3, offline: false,
    note: 'Strong general quality, accepts text and images, large context. Higher cost per token than smaller models.' },
  reasoning: { label: 'Reasoning model (o-series / GPT-5 with reasoning)', kind: 'LLM', inputs: ['text', 'image', 'document'], outs: ['text', 'fields', 'translation'], quality: 3, reasoning: 3, cost: 3, latency: 3, ctx: 3, offline: false,
    note: 'Spends extra (hidden) reasoning tokens before answering: best for hard multi-step problems, slowest and most expensive per request.' },
  mini: { label: 'Small/fast LLM (GPT-4.1-mini / nano-class)', kind: 'LLM', inputs: ['text', 'image', 'document'], outs: ['text', 'fields', 'translation'], quality: 2, reasoning: 1, cost: 1, latency: 1, ctx: 3, offline: false,
    note: 'Good enough for routine chat, classification and extraction at a fraction of the cost and latency.' },
  slm: { label: 'Small language model (Phi family)', kind: 'SLM', inputs: ['text'], outs: ['text', 'translation'], quality: 1, reasoning: 1, cost: 1, latency: 1, ctx: 2, offline: true,
    note: 'Open-weight SLM. Can run on-device or at the edge (for example with Foundry Local) or on managed compute. Narrower knowledge; text-only variant used here.' },
  multimodal: { label: 'Multimodal LLM (GPT-4o-class, image + audio in)', kind: 'LLM', inputs: ['text', 'image', 'audio'], outs: ['text', 'transcript', 'translation'], quality: 2, reasoning: 1, cost: 2, latency: 2, ctx: 3, offline: false,
    note: 'One model reasons over mixed modalities. For plain high-volume transcription a purpose-built speech service is usually cheaper and gives word timings.' },
  embedding: { label: 'Embedding model (text-embedding-3-small/large)', kind: 'Embedding', inputs: ['text'], outs: ['vector'], quality: 2, reasoning: 0, cost: 1, latency: 1, ctx: 1, offline: false,
    note: 'Turns text into vectors for similarity search. It does not generate text.' },
  docintel: { label: 'Foundry Tool: Document Intelligence / Content Understanding', kind: 'Foundry Tool', inputs: ['document', 'image'], outs: ['fields'], quality: 3, reasoning: 0, cost: 1, latency: 1, ctx: 2, offline: false,
    note: 'Purpose-built OCR + layout + field extraction with per-field confidence and bounding regions.' },
  translator: { label: 'Foundry Tool: Azure Translator', kind: 'Foundry Tool', inputs: ['text', 'document'], outs: ['translation'], quality: 3, reasoning: 0, cost: 1, latency: 1, ctx: 2, offline: false,
    note: 'Purpose-built machine translation with custom glossaries and document translation. Predictable per-character billing.' },
  speech: { label: 'Foundry Tool: Azure Speech (speech to text)', kind: 'Foundry Tool', inputs: ['audio'], outs: ['transcript'], quality: 3, reasoning: 0, cost: 1, latency: 1, ctx: 2, offline: false,
    note: 'Real-time and batch transcription, diarization, word timestamps, custom speech models.' },
};

const CTX_TIER = pages => (pages <= 20 ? 1 : pages <= 150 ? 2 : 3);
const TIER = ['none', 'low', 'medium', 'high'];

function evaluate(id, p) {
  const c = CANDIDATES[id];
  const t = TASKS[p.task];
  const hard = [];
  const soft = [];
  if (!c.inputs.includes(t.input)) hard.push(`cannot accept ${t.input} input`);
  if (!c.outs.includes(t.out)) hard.push(`does not produce ${t.out === 'vector' ? 'embeddings' : t.out} output`);
  if (p.offline && !c.offline) hard.push('cloud-only: cannot run disconnected');
  let score = 50;
  // Fit to reasoning depth
  const gap = t.reasoning - c.reasoning;
  if (gap > 0) { score -= gap * 14; soft.push(`reasoning depth below need (${TIER[c.reasoning]} vs ${TIER[t.reasoning]})`); }
  else if (gap < -1) { score -= 6; soft.push('more reasoning power than the task needs (paying for unused capability)'); }
  // Latency
  const latWant = { low: 1, medium: 2, relaxed: 3 }[p.latency];
  if (c.latency > latWant) { score -= (c.latency - latWant) * 12; soft.push(`slower than the ${p.latency}-latency target`); }
  // Budget × volume
  const budgetW = { tight: 3, moderate: 2, flexible: 1 }[p.budget];
  score -= (c.cost - 1) * budgetW * (t.volume >= 3 ? 4 : 2.5);
  if (c.cost === 3 && budgetW >= 2) soft.push('high relative cost for this budget');
  // Context length
  const need = CTX_TIER(p.contextPages);
  if (c.ctx < need) { score -= (need - c.ctx) * 10; soft.push('context tier below input size: you would need chunking or RAG'); }
  // Quality and specialisation
  score += c.quality * 6;
  if (c.kind === 'Foundry Tool' && c.outs.includes(t.out)) { score += 14; soft.push('purpose-built for this task (confidence scores / glossaries / timings)'); }
  if (p.offline && c.offline) score += 10;
  const r = rng(`${id}|${p.task}`);
  score = round(score + (r() - 0.5) * 2, 0);
  return { id, label: c.label, kind: c.kind, hard, soft, score: hard.length ? 0 : Math.max(1, score) };
}

function advise(p) {
  const t = TASKS[p.task];
  const steps = [];
  steps.push(step('req', 'Requirements captured', `${t.label}. Input: ${t.input}; required output: ${t.out}; reasoning depth: ${TIER[t.reasoning]}; latency target: ${p.latency}; budget: ${p.budget}; input size ≈ ${p.contextPages} page(s)${p.offline ? '; must run offline' : ''}.`,
    { input: t.input, output: t.out, reasoningDepth: TIER[t.reasoning], latency: p.latency, budget: p.budget, contextPages: p.contextPages, offline: p.offline, volume: TIER[t.volume] }, 'info'));

  const all = Object.keys(CANDIDATES).map(id => evaluate(id, p));
  const viable = all.filter(e => !e.hard.length).sort((a, b) => b.score - a.score);
  const rejected = all.filter(e => e.hard.length);
  steps.push(step('filter', 'Hard constraints applied', `${viable.length} of ${all.length} families can do the task at all. Rejected: ${rejected.map(e => `${e.label.split(' (')[0]} (${e.hard[0]})`).join('; ') || 'none'}.`,
    { viable: viable.map(e => e.label), rejected: Object.fromEntries(rejected.map(e => [e.label, e.hard])) }, viable.length ? 'ok' : 'error'));
  if (!viable.length) {
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'No model family satisfies every hard constraint. Relax one (for example allow cloud processing) or split the task.' }], metrics: [metric('Viable families', '0', 'computed')], summary: `${t.label}: no viable model` };
  }
  steps.push(step('score', 'Trade-offs scored', `Ranked viable families on reasoning fit, latency, relative cost × volume, context size and specialisation. Leader: ${viable[0].label}.`,
    Object.fromEntries(viable.map(e => [e.label, { score: e.score, tradeOffs: e.soft }]))));

  const chosen = all.find(e => e.id === p.candidate);
  const rank = viable.findIndex(e => e.id === p.candidate) + 1;
  let choiceStatus = 'ok';
  let choiceText;
  if (chosen.hard.length) {
    choiceStatus = 'error';
    choiceText = `Your choice "${chosen.label}" fails a hard constraint: ${chosen.hard.join('; ')}. It cannot do this task, whatever the prompt.`;
  } else if (rank > 1 && viable[0].score - chosen.score >= 8) {
    choiceStatus = 'warn';
    choiceText = `Your choice works but ranks #${rank} of ${viable.length} (score ${chosen.score} vs ${viable[0].score}). Trade-offs: ${chosen.soft.join('; ') || 'none listed'}. Consider ${viable[0].label}.`;
  } else {
    choiceText = rank === 1 ? `Your choice is the top-ranked fit (score ${chosen.score}).` : `Your choice ranks #${rank} but is within a few points of the leader: a defensible pick; confirm with an evaluation on your own data.`;
  }
  steps.push(step('choice', rank === 1 ? 'Choice is the top fit' : choiceStatus === 'error' ? 'Choice is unsuitable' : choiceStatus === 'warn' ? 'Better option available' : 'Choice is acceptable', choiceText,
    { chosen: chosen.label, rank: rank || 'rejected', score: chosen.score, hardFailures: chosen.hard, tradeOffs: chosen.soft }, choiceStatus));
  if (choiceStatus !== 'error') {
    steps.push(step('deploy', 'Validate before committing', `Next: deploy ${chosen.kind === 'Foundry Tool' ? 'the Foundry Tool in your Foundry resource' : 'the model in your Foundry project'} and run an evaluation on 50–200 real examples. Model benchmarks and leaderboards in the Foundry model catalog are a starting point, not proof for your data.`,
      { next: ['Compare in the model catalog / leaderboards', 'Deploy candidate(s)', 'Evaluate on your dataset', 'Decide'] }, 'info'));
  }

  const output = [
    { type: 'table', title: 'Candidate families for this task', columns: ['Family', 'Type', 'Verdict', 'Score', 'Key trade-off'],
      rows: all.sort((a, b) => b.score - a.score).map(e => [e.label, e.kind, e.hard.length ? 'Rejected' : e.id === viable[0].id ? 'Recommended' : 'Viable', e.hard.length ? '—' : String(e.score), e.hard[0] || e.soft[0] || 'good fit']),
      tones: all.map(e => (e.hard.length ? 'error' : e.id === viable[0].id ? 'ok' : e.id === p.candidate ? 'warn' : undefined)) },
    { type: 'bars', title: 'Relative fit score (viable families)', items: viable.map(e => ({ label: e.label.split(' (')[0], value: e.score, max: 100, tone: e.id === p.candidate ? 'info' : e.id === viable[0].id ? 'ok' : undefined, note: e.soft.slice(0, 2).join('; ') })) },
    { type: 'kv', title: `About your choice: ${chosen.label}`, items: [['Type', chosen.kind], ['What it is for', CANDIDATES[p.candidate].note], ['Relative cost', TIER[CANDIDATES[p.candidate].cost]], ['Relative latency', TIER[CANDIDATES[p.candidate].latency]], ['Runs offline', CANDIDATES[p.candidate].offline ? 'yes (edge/on-device)' : 'no']] },
  ];
  if (choiceStatus !== 'ok') output.push({ type: 'alert', tone: choiceStatus, text: choiceText });

  return {
    steps, output,
    metrics: [
      metric('Viable families', `${viable.length}/${all.length}`, 'computed'),
      metric('Your choice rank', rank ? `#${rank}` : 'rejected', 'computed', 'Rank among families that pass hard constraints.'),
      metric('Relative cost tier', TIER[CANDIDATES[p.candidate].cost], 'estimate', 'Relative tier only (low/medium/high). Check the Foundry pricing pages; prices change and are not reproduced here.'),
    ],
    summary: `${t.label.split(' (')[0]} → ${chosen.label.split(' (')[0]}: ${chosen.hard.length ? 'unsuitable' : `rank #${rank}`}`,
  };
}

export default {
  id: '1.1.1',
  lab: 'Model selection advisor',
  services: [
    { name: 'Foundry Models overview and model catalog', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/foundry-models-overview' },
    { name: 'Azure OpenAI in Foundry Models: models', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models' },
    { name: 'Foundry Tools (Azure AI services) overview', url: 'https://learn.microsoft.com/en-us/azure/ai-services/what-are-ai-services' },
  ],
  prereqs: [],
  next: ['1.1.2', '1.2.2', '2.1.1'],

  concept: {
    plain: 'Not every AI job needs the biggest model. A chat assistant, a hard planning problem, an invoice reader, a translator and a search index each need different things. Start with what the task must take in and produce, rule out anything that cannot do it, then weigh quality against speed, cost and where it has to run. Often the best answer is a small model or a purpose-built tool, not a frontier LLM.',
    technical: 'Microsoft Foundry offers Foundry Models (Azure OpenAI models sold directly by Azure plus partner and open models such as Phi, Llama, Mistral and DeepSeek) and Foundry Tools (Document Intelligence, Content Understanding, Translator, Speech, Vision, Language, Content Safety). Choose by modality (text, image, audio, document), output type (generation, embeddings, typed fields, transcripts), reasoning depth (reasoning models trade latency and tokens for multi-step accuracy), context window, latency, cost per token or per unit, and deployment constraints such as edge/offline (SLMs via Foundry Local) or data residency. Use model catalog benchmarks and leaderboards to shortlist, then evaluate on your own data.',
    useCase: 'A utility company builds four features: a chatbot (GPT-4.1-mini), an outage root-cause assistant for engineers (a reasoning model), meter-reading photo extraction (Document Intelligence / Content Understanding) and an offline troubleshooting helper on field laptops (Phi running locally). One model for everything would be either too expensive or not good enough.',
    terms: [
      ['LLM', 'Large language model: broad knowledge and strong generation; higher cost and latency.'],
      ['SLM', 'Small language model (for example Phi): cheaper, faster, can run on-device; narrower capability.'],
      ['Reasoning model', 'A model that generates internal reasoning tokens before answering; better at multi-step problems, slower and costlier per request.'],
      ['Embedding model', 'Maps text to vectors for similarity search; does not generate text.'],
      ['Foundry Tools', 'Purpose-built AI services (Speech, Translator, Document Intelligence, …) with task-specific outputs such as confidence scores and timings.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'req', label: p ? `Task: ${TASKS[p.task].label.split(' (')[0]}` : 'Task requirements', col: 0, row: 1, kind: 'user', detail: 'Modality in, output type, reasoning depth, latency, budget × volume, input size, offline/residency.', substeps: ['Input modality', 'Output type', 'Reasoning depth', 'Latency / budget', 'Where it must run'] },
          { id: 'filter', label: 'Hard constraints', col: 1, row: 1, kind: 'policy', detail: 'Anything that cannot accept the input, produce the output or run where required is out, regardless of quality.' },
          { id: 'score', label: 'Trade-off scoring', col: 2, row: 1, kind: 'compute', detail: 'Quality vs latency vs cost. Specialised Foundry Tools win on narrow tasks; reasoning models win on hard multi-step tasks.', substeps: ['Reasoning fit', 'Latency fit', 'Cost × volume', 'Context size', 'Specialisation'] },
          { id: 'choice', label: p ? `Choice: ${CANDIDATES[p.candidate].label.split(' (')[0]}` : 'Your choice', col: 3, row: 1, kind: 'ai', badge: p ? CANDIDATES[p.candidate].kind : undefined, detail: 'The family you picked, checked against the ranking.' },
          { id: 'deploy', label: 'Evaluate on your data', col: 4, row: 1, kind: 'app', detail: 'Benchmarks shortlist; your own evaluation decides.' },
        ],
        edges: [['req', 'filter'], ['filter', 'score'], ['score', 'choice'], ['choice', 'deploy']],
      }),
      architectural: p => {
        const c = p ? CANDIDATES[p.candidate] : null;
        return {
          nodes: [
            { id: 'req', label: 'Your app', col: 0, row: 1, kind: 'app', detail: 'Calls whichever endpoint fits the task.' },
            { id: 'filter', label: 'Foundry model catalog', col: 1, row: 0, kind: 'data', detail: 'Browse, filter by task/modality, compare benchmarks and leaderboards.' },
            { id: 'score', label: 'Foundry project: model deployments', col: 2, row: 0, kind: 'ai', disabled: c && (c.kind === 'Foundry Tool' || c.offline && p.offline), detail: 'LLMs, reasoning, embedding and many partner models are deployed in a Foundry resource/project and called through one endpoint.' },
            { id: 'choice', label: 'Foundry Tools endpoint', col: 2, row: 2, kind: 'ai', disabled: c && c.kind !== 'Foundry Tool', detail: 'Speech, Translator, Document Intelligence, Content Understanding on the same Foundry resource.' },
            { id: 'deploy', label: 'Foundry Local / edge device', col: 3, row: 1, kind: 'compute', disabled: !(p && p.offline), detail: 'Runs open-weight SLMs (for example Phi) on-device without connectivity.' },
          ],
          edges: [['req', 'score', 'chat / embeddings'], ['req', 'choice', 'task API'], ['filter', 'score', 'deploy'], ['req', 'deploy', 'local inference']],
        };
      },
      implementation: p => {
        const id = p ? p.candidate : 'mini';
        const code = {
          frontier: 'client.chat.completions.create(model="<deployment>", messages=[...])',
          reasoning: 'client.chat.completions.create(model="<reasoning-deployment>", reasoning_effort="medium", ...)',
          mini: 'client.chat.completions.create(model="<mini-deployment>", messages=[...])',
          slm: 'foundry local run phi-4-mini  # then call the local OpenAI-compatible endpoint',
          multimodal: 'messages=[{"role":"user","content":[{"type":"text",...},{"type":"image_url",...}]}]',
          embedding: 'client.embeddings.create(model="<embedding-deployment>", input=texts)',
          docintel: 'DocumentIntelligenceClient(...).begin_analyze_document("prebuilt-invoice", body)',
          translator: 'TextTranslationClient(...).translate(body=[text], to_language=["fr","de"])',
          speech: 'speechsdk.SpeechRecognizer(speech_config, audio_config).recognize_once()',
        }[id];
        return {
          nodes: [
            { id: 'req', label: 'credential = DefaultAzureCredential()', col: 0, row: 0, kind: 'code', detail: 'Keyless auth with Microsoft Entra ID, same for models and Foundry Tools.' },
            { id: 'filter', label: 'client = AIProjectClient(endpoint, credential).get_openai_client()', col: 0, row: 1, kind: 'code', detail: 'Illustrative: the azure-ai-projects SDK can hand you an OpenAI-compatible client for project deployments. Check the SDK reference for the current method name.' },
            { id: 'choice', label: code, col: 0, row: 2, kind: 'code', detail: 'The call shape changes with the family: chat, embeddings, or a task-specific Foundry Tool SDK. Signatures are illustrative.' },
            { id: 'deploy', label: 'evaluate(data=..., evaluators={...})  # azure-ai-evaluation', col: 0, row: 3, kind: 'code', detail: 'Compare candidates on your own dataset before committing.' },
          ],
          edges: [['req', 'filter'], ['filter', 'choice'], ['choice', 'deploy']],
        };
      },
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([v, t]) => [v, t.label]), default: 'chat' },
      { id: 'latency', label: 'Latency target', type: 'select', options: [['low', 'Low (interactive, sub-second feel)'], ['medium', 'Medium (a few seconds is fine)'], ['relaxed', 'Relaxed (batch / background)']], default: 'medium' },
      { id: 'budget', label: 'Budget pressure', type: 'select', options: [['tight', 'Tight'], ['moderate', 'Moderate'], ['flexible', 'Flexible']], default: 'moderate' },
      { id: 'contextPages', label: 'Input size per request (pages)', type: 'range', min: 1, max: 400, step: 1, default: 5, help: 'Mapped to a coarse context tier (small/medium/large). Real context windows vary by model and version; check the model card.' },
      { id: 'offline', label: 'Must run offline / on-device', type: 'toggle', default: false },
      { id: 'candidate', label: 'Your model choice', type: 'select', options: Object.entries(CANDIDATES).map(([v, c]) => [v, c.label]), default: 'frontier' },
    ],
    samples: [
      { label: 'Support chat on a tight budget', values: { task: 'chat', budget: 'tight', latency: 'low', candidate: 'mini' } },
      { label: 'Root-cause analysis', values: { task: 'reasoning', latency: 'relaxed', budget: 'flexible', contextPages: 60, candidate: 'reasoning' } },
      { label: 'Invoice extraction with an LLM', values: { task: 'docFields', budget: 'tight', candidate: 'frontier' } },
      { label: 'Offline field assistant', values: { task: 'chat', offline: true, budget: 'tight', candidate: 'slm' } },
      { label: 'Semantic search index', values: { task: 'search', candidate: 'embedding' } },
    ],
    run: advise,
  },

  compare: {
    suggestions: [
      'Task = invoice extraction: run with Frontier LLM, then Document Intelligence, and compare score and trade-offs.',
      'Task = support chat: switch budget from flexible to tight and watch the frontier model fall behind the mini model.',
      'Task = root-cause analysis: compare Reasoning model with latency relaxed vs low.',
    ],
  },

  debug: [
    { id: 'embed-chat', title: 'Chatbot returns no text at all', values: { task: 'chat', candidate: 'embedding' }, node: 'choice',
      symptom: 'The choice is rejected: "does not produce text output".', cause: 'An embedding model returns vectors for search, not generated replies.', fix: 'Choose a generative model (Small/fast LLM for routine chat).' },
    { id: 'slm-image', title: 'Photo questions fail', values: { task: 'vision', candidate: 'slm' }, node: 'filter',
      symptom: 'Rejected: "cannot accept image input".', cause: 'The text-only SLM variant cannot see images.', fix: 'Choose a model that accepts image input (Frontier LLM or Multimodal LLM).' },
    { id: 'offline-cloud', title: 'Field app breaks with no signal', values: { task: 'classify', offline: true, candidate: 'mini' }, node: 'choice',
      symptom: 'Rejected: "cloud-only: cannot run disconnected".', cause: 'Hosted model deployments need network access to the Foundry endpoint.', fix: 'Pick the Phi SLM, which can run locally (for example with Foundry Local).' },
    { id: 'llm-translate', title: 'Translation bill is far higher than expected', values: { task: 'translate', budget: 'tight', candidate: 'frontier' }, node: 'score',
      symptom: 'The choice works but is flagged as a worse fit than Azure Translator.', cause: 'Bulk translation at volume with a frontier LLM costs more per unit and lacks glossary/document-translation features.', fix: 'Choose Foundry Tool: Azure Translator; reserve LLM translation for tone-sensitive content.' },
    { id: 'reason-latency', title: 'Chat feels sluggish', values: { task: 'chat', latency: 'low', budget: 'tight', candidate: 'reasoning' }, node: 'choice',
      symptom: 'Flagged: slower than target and high relative cost.', cause: 'Reasoning models spend extra tokens thinking; routine chat does not need that.', fix: 'Use the Small/fast LLM for chat; keep the reasoning model for the hard cases.' },
  ],

  challenge: {
    task: 'Field technicians need a troubleshooting assistant that answers short text questions on laptops with no connectivity, on a tight budget. Pick a model that is the top-ranked fit.',
    condition: 'Task = support chat, offline on, budget tight, and the choice step reports "top fit" with no errors.',
    hint: 'Turn on the offline requirement first and see which families survive the hard-constraint filter.',
    check: (p, res) => p.task === 'chat' && p.offline === true && p.budget === 'tight' && res.steps.some(s => s.node === 'choice' && s.status === 'ok' && /top/.test(s.title)),
    solution: ['Task: Customer-support chat.', 'Turn on "Must run offline".', 'Budget: Tight.', 'Only the Phi SLM survives the filter; choose it and run.'],
    solutionValues: { task: 'chat', offline: true, budget: 'tight', candidate: 'slm' },
  },

  quiz: [
    { q: 'You must extract totals and dates from 50,000 scanned invoices a month with per-field confidence for a review queue. Which is the most appropriate choice?', options: ['A frontier LLM with a JSON prompt', 'Document Intelligence / Content Understanding in Foundry Tools', 'An embedding model', 'A reasoning model'], answer: 1, why: 'A purpose-built document service gives typed fields, confidence and bounding regions at predictable per-page cost. An LLM can extract fields but gives no calibrated confidence.' },
    { q: 'An app classifies short support tickets into 8 categories, millions per month, with tight latency. Which model family should you evaluate first?', options: ['Reasoning model', 'Small/fast LLM or an SLM', 'Frontier LLM with maximum context', 'Image generation model'], answer: 1, why: 'Simple classification does not need frontier or reasoning capability; smaller models cut cost and latency. Evaluate to confirm accuracy.' },
    { q: 'Your semantic search feature needs vectors for 2 million documents. What do you deploy?', options: ['A chat model and ask it to output numbers', 'An embedding model such as text-embedding-3-small', 'Azure Translator', 'A reasoning model'], answer: 1, why: 'Embedding models produce vectors for similarity search; generative models are the wrong tool.' },
    { q: 'Engineers ask for a root-cause analysis over long incident logs; answers can take a while but must be correct. Which choice fits best?', options: ['SLM on-device', 'Reasoning model', 'Speech to text', 'Embedding model'], answer: 1, why: 'Multi-step analysis benefits from a reasoning model; the relaxed latency target absorbs its extra thinking time.' },
  ],

  recap: 'Start from the task: input modality, output type, reasoning depth, latency, budget × volume and where it must run. Filter out anything that cannot do the job, prefer purpose-built Foundry Tools for narrow tasks and small models for routine ones, use reasoning models only where depth pays off, and confirm with an evaluation on your own data.',
};
