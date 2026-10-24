// 2.3.1 Tune generation behavior, such as prompt engineering and adjusting model parameters
// Lab: Prompt and parameter tuning lab.
import { rng, clamp, step, metric, estTokens } from '../src/engine/util.js';

const TASKS = {
  classify: {
    label: 'Classify a support ticket (JSON: category, urgency)',
    input: 'I was charged twice for my March invoice and need one of the charges reversed before Friday.',
    role: 'You are a support triage assistant for Contoso.',
    constraints: 'Choose exactly one category from: billing, technical, account. Urgency: low, medium, high. No explanations.',
    format: 'Return JSON: {"category": string, "urgency": string}.',
    shots: ['Input: "App crashes on login" → {"category":"technical","urgency":"high"}', 'Input: "Change my email address" → {"category":"account","urgency":"low"}', 'Input: "Refund the duplicate fee" → {"category":"billing","urgency":"medium"}'],
    keys: ['category', 'urgency'],
    pool: [
      { category: 'billing', urgency: 'high' }, { category: 'billing', urgency: 'medium' }, { category: 'billing', urgency: 'high' },
      { category: 'account', urgency: 'medium' }, { category: 'billing', urgency: 'urgent' },
    ],
    prose: o => `Sure! This looks like a ${o.category} issue. The customer was charged twice, so I would rate the urgency as ${o.urgency} because of the Friday deadline. Let me know if you need anything else.`,
    expect: o => o.category === 'billing' && ['high', 'medium'].includes(o.urgency),
    baseTokens: 16,
  },
  summarize: {
    label: 'Summarise a product review (JSON: summary ≤ 30 words, sentiment)',
    input: 'Battery life is superb, easily two days. The noise cancelling is good on trains but weak with wind. The app keeps logging me out, which is annoying, and the case feels cheap. For the price, still a solid buy.',
    role: 'You are a product analyst who writes neutral summaries.',
    constraints: 'Summary must be at most 30 words. Mention one positive and one negative. Do not invent features.',
    format: 'Return JSON: {"summary": string, "sentiment": "positive"|"mixed"|"negative"}.',
    shots: ['Review: "Great screen, poor speakers" → {"summary":"Excellent display let down by weak speakers.","sentiment":"mixed"}'],
    keys: ['summary', 'sentiment'],
    pool: [
      { summary: 'Excellent two-day battery and decent noise cancelling, but the app logs users out and the case feels cheap. Good value overall.', sentiment: 'mixed' },
      { summary: 'Strong battery life; noise cancelling struggles in wind; app logouts and a cheap case annoy; still worth the price.', sentiment: 'mixed' },
      { summary: 'Great battery, good ANC on trains, flaky app, cheap case. Solid buy for the money.', sentiment: 'positive' },
      { summary: 'Battery lasts two days and ANC is fine, though the companion app is unreliable and the build quality of the case disappoints buyers looking for premium feel.', sentiment: 'mixed' },
    ],
    prose: o => `Here is a summary of the review: ${o.summary} Overall the reviewer seems ${o.sentiment} about the product, highlighting both strengths and some weaknesses that buyers should consider before purchasing.`,
    expect: o => o.sentiment === 'mixed' && String(o.summary).split(/\s+/).length <= 30,
    baseTokens: 45,
  },
  brainstorm: {
    label: 'Brainstorm taglines for a headset launch (JSON: 3 taglines)',
    input: 'Contoso H2 wireless headset: 30-hour battery, adaptive noise cancelling, recycled materials.',
    role: 'You are a creative copywriter.',
    constraints: 'Each tagline under 8 words. No superlatives you cannot prove ("best", "#1").',
    format: 'Return JSON: {"taglines": [string, string, string]}.',
    shots: ['Product: "Eco water bottle" → {"taglines":["Refill the planet","Hydration, minus the waste","Sip responsibly"]}'],
    keys: ['taglines'],
    pool: [
      { taglines: ['Thirty hours of quiet', 'Hear more, waste less', 'Silence, sustainably made'] },
      { taglines: ['Your day, uninterrupted', 'Quiet that lasts', 'Made from yesterday, built for today'] },
      { taglines: ['Noise off. Planet on.', 'All-day calm', 'Recycled. Refined. Ready.'] },
      { taglines: ['Sound that respects the planet', 'Tune out, charge less', 'Quiet, from Monday to Wednesday'] },
      { taglines: ['The best headset ever made', 'Unbeatable #1 sound', 'Quiet'] },
    ],
    prose: o => `Here are some ideas: 1) ${o.taglines[0]} 2) ${o.taglines[1]} 3) ${o.taglines[2]}. Let me know if you want more options in a different tone!`,
    expect: o => Array.isArray(o.taglines) && o.taglines.length === 3 && !o.taglines.some(t => /best|#1|unbeatable/i.test(t)),
    baseTokens: 30,
  },
};

const EFFORT_TOKENS = { low: 250, medium: 900, high: 2400 }; // illustrative hidden reasoning token use

function generate(p) {
  const task = TASKS[p.task] || TASKS.classify;
  const steps = [];
  const N = clamp(Math.round(Number(p.runs) || 1), 1, 5);
  const temp = Number(p.temperature), topP = Number(p.top_p), fp = Number(p.frequencyPenalty), pp = Number(p.presencePenalty);
  const maxTok = Math.max(1, Math.round(Number(p.maxTokens) || 1));
  const shots = clamp(Math.round(Number(p.fewShot) || 0), 0, task.shots.length);
  const reasoning = p.model === 'reasoning';

  // 1. Prompt assembly
  const sys = [p.role ? task.role : null, p.constraints ? task.constraints : null, p.outputFormat !== 'none' ? task.format : null].filter(Boolean).join('\n');
  const fewShotText = task.shots.slice(0, shots).join('\n');
  const promptTokens = estTokens(sys + fewShotText + task.input) + 8;
  steps.push(step('prompt', 'Prompt assembled', `${[p.role && 'role', p.constraints && 'constraints', shots && `${shots} example(s)`, p.outputFormat !== 'none' && 'output format'].filter(Boolean).join(' + ') || 'bare user message only'} • ~${promptTokens} prompt tokens`, { system: sys || '(none)', examples: shots, user: task.input }, sys ? 'ok' : 'warn'));

  // 2. Parameter validation
  const body = reasoning
    ? { model: 'reasoning-deployment', messages: '[…]', max_completion_tokens: maxTok, reasoning_effort: p.reasoningEffort, ...(temp !== 1 ? { temperature: temp } : {}), ...(topP !== 1 ? { top_p: topP } : {}), ...(fp !== 0 ? { frequency_penalty: fp } : {}), ...(pp !== 0 ? { presence_penalty: pp } : {}), ...(p.stop ? { stop: [p.stop] } : {}), ...(p.outputFormat === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: '{…}' } } } : {}) }
    : { model: 'chat-deployment', messages: '[…]', temperature: temp, top_p: topP, max_tokens: maxTok, frequency_penalty: fp, presence_penalty: pp, ...(p.stop ? { stop: [p.stop] } : {}), ...(p.outputFormat === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: '{…}' } } } : {}) };
  if (reasoning) {
    const bad = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'].filter(k => k in body);
    if (bad.length) {
      steps.push(step('params', `400 Bad Request: unsupported parameter ${bad.join(', ')}`, 'Reasoning models (o-series and similar) do not accept classic sampling parameters; they are steered with reasoning_effort and max_completion_tokens instead. In this simulation non-default values are rejected; some models silently ignore them. Check the model\'s documentation.', { error: { code: 'unsupported_parameter', param: bad[0] } }, 'error'));
      return finish(p, task, steps, [], body, promptTokens);
    }
  }
  steps.push(step('params', 'Request parameters accepted', reasoning ? `reasoning_effort=${p.reasoningEffort}, max_completion_tokens=${maxTok} (shared by hidden reasoning and visible output).` : `temperature=${temp}, top_p=${topP}, max_tokens=${maxTok}, penalties ${fp}/${pp}${p.stop ? `, stop=${JSON.stringify(p.stop)}` : ''}.`, body, 'ok'));

  // 3. Sampling (toy generator)
  const spread = reasoning ? 0.15 : clamp(temp * topP, 0, 2); // effective randomness in this toy
  const deterministic = spread < 0.05;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const r = rng(`${p.task}|${p.model}|${spread.toFixed(2)}|${p.outputFormat}|${shots}|${p.role}|${p.constraints}|${deterministic ? 0 : i}`);
    const usable = Math.max(1, Math.min(task.pool.length, 1 + Math.round(spread * (task.pool.length - 1) * 0.9 + (p.constraints ? -0.4 : 0.4))));
    const base = task.pool[Math.floor(r() * usable)];
    const obj = JSON.parse(JSON.stringify(base));
    // format compliance
    let pComply = { none: 0.1, json_instruction: 0.72, json_schema: 0.99 }[p.outputFormat] + shots * 0.07 + (p.constraints ? 0.06 : 0) - Math.max(0, temp - 0.8) * 0.4 * (reasoning ? 0 : 1);
    if (p.outputFormat === 'json_schema') pComply = 0.995;
    const comply = r() < pComply;
    let text = comply ? JSON.stringify(obj) : (r() < 0.4 && p.outputFormat !== 'none' ? '```json\n' + JSON.stringify(obj, null, 1) + '\n```' : task.prose(obj));
    const notes = [];
    if (!reasoning && temp > 1.4 && topP > 0.8 && r() < (temp - 1.2)) { text = text.replace(/"[a-z ]+"(?=[,}])/i, '"billng-ish quantumly"') + ' ~~ ok ok synergy'; notes.push('incoherent tokens (very high temperature)'); }
    if (!reasoning && fp > 1.2) { text = text.replace(/battery/gi, 'accumulator').replace(/quiet/gi, 'hush'); notes.push('odd word substitutions (high frequency penalty)'); }
    if (!reasoning && pp > 1.2 && p.task === 'summarize') { text = text.replace('Good value overall.', 'Also consider the brand\'s wider sustainability story.'); notes.push('topic drift (high presence penalty)'); }
    if (!reasoning && fp < -0.5) { text = text + text.slice(-40).repeat(3); notes.push('repetition loop (negative frequency penalty)'); }
    let tokens = estTokens(text) + (p.constraints ? 0 : Math.round(task.baseTokens * 0.3));
    let finish = 'stop';
    let reasoningTokens = 0;
    if (reasoning) {
      reasoningTokens = EFFORT_TOKENS[p.reasoningEffort] || 900;
      if (reasoningTokens >= maxTok) { text = ''; finish = 'length'; tokens = 0; reasoningTokens = maxTok; notes.push('all tokens spent on hidden reasoning'); }
    }
    const visibleBudget = maxTok - reasoningTokens;
    if (finish === 'stop' && p.stop && text.includes(p.stop)) { text = text.slice(0, text.indexOf(p.stop)); notes.push(`cut at stop sequence ${JSON.stringify(p.stop)}`); }
    if (finish === 'stop' && tokens > visibleBudget) { text = text.slice(0, Math.max(0, visibleBudget * 4)); finish = 'length'; tokens = visibleBudget; }
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/^```json\n|\n```$/g, '')); } catch (e) { parsed = null; }
    const strict = (() => { try { return JSON.parse(text); } catch (e) { return null; } })();
    const valid = !!strict && task.keys.every(k => k in strict);
    // Correctness judges the content (labels, length, claims), independently of the output format.
    const correct = !!text && finish === 'stop' && !notes.some(n => /incoherent|drift|repetition/.test(n)) && task.expect(parsed || obj);
    samples.push({ text, tokens, finish, valid, correct, notes, reasoningTokens });
  }

  const validN = samples.filter(s => s.valid).length;
  const correctN = samples.filter(s => s.correct).length;
  const distinct = new Set(samples.map(s => s.text)).size;
  const truncated = samples.filter(s => s.finish === 'length').length;
  const stopCut = samples.filter(s => s.notes.some(n => n.startsWith('cut at stop'))).length;
  const weird = samples.filter(s => s.notes.some(n => !n.startsWith('cut at stop') && !n.startsWith('all tokens'))).length;

  steps.push(step('sampling', `${N} completion(s) sampled`, deterministic ? 'Near-greedy decoding: every sample identical in this toy. (Real deployments can still vary slightly at temperature 0.)' : `Effective randomness ≈ temperature × top_p = ${spread.toFixed(2)} in this toy model. ${distinct}/${N} distinct outputs.`, { distinct, samples: N }, weird ? 'warn' : 'info'));
  if (truncated) steps.push(step('sampling', `${truncated} completion(s) hit the token limit`, reasoning ? 'finish_reason = "length". For reasoning models max_completion_tokens covers hidden reasoning tokens too: raise it or lower reasoning_effort.' : 'finish_reason = "length": output cut mid-way. Raise max_tokens or shorten the expected output.', { finish_reason: 'length', count: truncated }, 'error'));
  if (stopCut) steps.push(step('sampling', `Stop sequence truncated ${stopCut} output(s)`, `The stop sequence ${JSON.stringify(p.stop)} occurs inside valid output, so generation ended early.`, { stop: p.stop }, validN ? 'warn' : 'error'));

  // 4. Format validation
  const fmtStatus = validN === N ? 'ok' : validN === 0 && p.outputFormat !== 'none' ? 'error' : 'warn';
  steps.push(step('validate', `Format check: ${validN}/${N} parse as JSON with required keys`, p.outputFormat === 'none' ? 'No output format was requested, so the model answers in prose.' : p.outputFormat === 'json_instruction' ? 'Instructions alone are a request, not a guarantee: watch for markdown fences and chatty preambles.' : 'Structured outputs (json_schema, strict) constrain decoding to the schema.', { valid: validN, of: N }, fmtStatus));

  // 5. Task quality
  const variabilityBad = (p.task === 'classify' && distinct > 1) || (p.task === 'brainstorm' && N > 1 && distinct === 1);
  steps.push(step('quality', `Task check: ${correctN}/${N} correct${p.task === 'brainstorm' ? ' (no unprovable superlatives)' : p.task === 'summarize' ? ' (≤30 words, mixed sentiment)' : ' (billing, sensible urgency)'}`, variabilityBad ? (p.task === 'classify' ? 'Classification should be repeatable; different answers for the same input are a defect. Lower temperature and constrain the output.' : 'Brainstorming benefits from diversity; identical samples mean randomness is too low.') : 'Behaviour fits the task.', { correct: correctN, distinct }, variabilityBad || correctN < N ? 'warn' : 'ok'));

  return finish(p, task, steps, samples, body, promptTokens);
}

function finish(p, task, steps, samples, body, promptTokens) {
  const N = samples.length;
  const sys = [p.role ? task.role : null, p.constraints ? task.constraints : null, p.outputFormat !== 'none' ? task.format : null].filter(Boolean).join('\n');
  const output = [
    { type: 'code', title: 'Messages sent (system + few-shot + user)', lang: 'text', text: `[system]\n${sys || '(empty)'}\n${task.shots.slice(0, Math.round(Number(p.fewShot) || 0)).map(s => `[example] ${s}`).join('\n')}\n[user]\n${task.input}` },
    { type: 'json', title: 'Request body (illustrative chat completions shape)', data: body },
  ];
  if (N) {
    output.push({ type: 'table', title: 'Sampled completions (toy generator, deterministic)', columns: ['#', 'Output', 'Valid JSON', 'Correct', '~Tokens', 'finish_reason', 'Notes'],
      rows: samples.map((s, i) => [String(i + 1), s.text || '(empty)', s.valid ? 'yes' : 'no', s.correct ? 'yes' : 'no', String(s.tokens + (s.reasoningTokens ? ` (+${s.reasoningTokens} reasoning)` : '')), s.finish, s.notes.join('; ') || '—']),
      tones: samples.map(s => s.finish === 'length' || !s.text ? 'error' : !s.valid || !s.correct || s.notes.length ? 'warn' : 'ok') });
    output.push({ type: 'bars', title: 'Outcome rates', items: [
      { label: 'Format compliance', value: samples.filter(s => s.valid).length / N, tone: 'info' },
      { label: 'Task correctness', value: samples.filter(s => s.correct).length / N, tone: 'ok' },
      { label: 'Distinct outputs', value: new Set(samples.map(s => s.text)).size / N, tone: p.task === 'brainstorm' ? 'ok' : 'warn' },
    ] });
  } else output.push({ type: 'alert', tone: 'error', text: 'The request was rejected before any tokens were generated.' });
  const err = steps.some(s => s.status === 'error');
  return {
    steps, output,
    metrics: [
      metric('Format compliance', N ? `${samples.filter(s => s.valid).length}/${N}` : '—', 'computed'),
      metric('Correct', N ? `${samples.filter(s => s.correct).length}/${N}` : '—', 'computed'),
      metric('Distinct outputs', N ? `${new Set(samples.map(s => s.text)).size}/${N}` : '—', 'computed'),
      metric('Prompt size', `~${promptTokens} tokens`, 'estimate', '4-characters-per-token heuristic; few-shot examples add prompt cost on every call.'),
    ],
    summary: err ? `${p.model}/${p.task}: failed` : `${p.task} • T=${p.temperature} p=${p.top_p} • fmt ${samples.filter(s => s.valid).length}/${N} • distinct ${new Set(samples.map(s => s.text)).size}/${N}`,
  };
}

const NN = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.3.1',
  lab: 'Prompt and parameter tuning lab',
  services: [
    { name: 'Prompt engineering techniques (Azure OpenAI in Foundry Models)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/prompt-engineering' },
    { name: 'Reasoning models: supported parameters', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/reasoning' },
    { name: 'Structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
  ],
  prereqs: ['2.1.1'],
  next: ['2.3.2', '4.1.4', '2.1.4'],

  concept: {
    plain: 'The same model behaves very differently depending on what you tell it and how you let it sample words. A clear role, explicit rules, a couple of examples and a required output format make answers consistent. Sampling settings decide how adventurous it is: low randomness for classification and extraction, more for brainstorming. Length limits and stop sequences can quietly cut answers short.',
    technical: 'Prompt engineering combines a system message (role, constraints, output contract), few-shot examples and the user input. Chat models expose temperature and top_p (sampling randomness), max_tokens, frequency_penalty and presence_penalty (discourage repetition / encourage new topics) and stop sequences; structured outputs (response_format json_schema, strict) constrain decoding to a schema. Reasoning models (o-series and similar) instead take reasoning_effort and max_completion_tokens, which also covers hidden reasoning tokens, and reject or ignore classic sampling parameters. Tune against a fixed test set, changing one thing at a time.',
    useCase: 'A helpdesk routes 20,000 tickets a day with a classification prompt: temperature 0, a strict JSON schema and three examples give repeatable labels, while the marketing team uses the same model at higher temperature to brainstorm taglines with a "no unprovable claims" constraint.',
    terms: [
      ['Temperature', 'Scales randomness of token sampling; 0 ≈ most likely tokens, higher = more varied.'],
      ['top_p', 'Nucleus sampling: sample only from the smallest set of tokens whose probability adds up to p. Usually tune this or temperature, not both.'],
      ['Frequency / presence penalty', 'Reduce repetition (frequency) or push toward new topics (presence). Extreme values degrade output.'],
      ['Stop sequence', 'String that ends generation when produced. Dangerous if it can appear inside valid output.'],
      ['Few-shot examples', 'Input/output pairs in the prompt that demonstrate the expected format and judgement.'],
      ['max_completion_tokens', 'Reasoning-model limit that includes hidden reasoning tokens plus visible output.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          NN('prompt', 'Prompt design', 0, 1, 'Role, constraints, examples and output format.', { substeps: ['Role', 'Constraints', 'Few-shot examples', 'Output contract'], badge: p ? `${Number(p.fewShot) || 0} shots` : undefined }),
          NN('params', 'Decoding parameters', 1, 1, 'How tokens are chosen and when generation stops.', { kind: 'policy', badge: p ? (p.model === 'reasoning' ? `effort ${p.reasoningEffort}` : `T ${p.temperature} • p ${p.top_p}`) : undefined }),
          NN('model', p && p.model === 'reasoning' ? 'Reasoning model' : 'Chat model', 2, 1, 'Generates tokens; reasoning models spend hidden reasoning tokens first.', { kind: 'ai' }),
          NN('sampling', 'Sampled outputs', 3, 1, 'Run several samples to see variability.', { badge: p ? `${p.runs}×` : undefined }),
          NN('validate', 'Format check', 4, 0.4, 'Does the output parse and contain required keys?'),
          NN('quality', 'Task check', 4, 1.6, 'Is it right, consistent (or diverse when that is the goal)?'),
        ],
        edges: [['prompt', 'model'], ['params', 'model'], ['model', 'sampling'], ['sampling', 'validate'], ['sampling', 'quality']],
      }),
      architectural: p => ({
        nodes: [
          NN('prompt', 'Prompt template (versioned in repo / prompty)', 0, 1, 'Prompts are code: version them and test them.', { kind: 'code' }),
          NN('params', 'App config (parameters per task)', 1, 1, 'Keep parameters next to the prompt version.', { kind: 'policy' }),
          NN('model', 'Foundry model deployment', 2, 1, p && p.model === 'reasoning' ? 'Reasoning model deployment.' : 'Chat model deployment.', { kind: 'ai' }),
          NN('sampling', 'Test set runner', 3, 1, 'Run the same inputs N times; store outputs.', { kind: 'compute' }),
          NN('validate', 'JSON schema validator', 4, 0.4, 'Reject or repair invalid outputs.', { kind: 'code' }),
          NN('quality', 'Evaluation (Foundry evaluators)', 4, 1.6, 'Score correctness and consistency across prompt versions.', { kind: 'data' }),
        ],
        edges: [['prompt', 'model'], ['params', 'model'], ['model', 'sampling'], ['sampling', 'validate'], ['sampling', 'quality']],
      }),
      implementation: p => ({
        nodes: [
          NN('prompt', 'messages = [{"role":"system","content":SYSTEM}, *EXAMPLES, {"role":"user","content":ticket}]', 0, 0, 'Few-shot examples as prior user/assistant turns or inline in the system message.', { kind: 'code' }),
          NN('params', p && p.model === 'reasoning' ? `client.chat.completions.create(model=dep, messages=messages, reasoning_effort="${p.reasoningEffort}", max_completion_tokens=${p.maxTokens})` : `client.chat.completions.create(model=dep, messages=messages, temperature=${p ? p.temperature : 1}, top_p=${p ? p.top_p : 1}, max_tokens=${p ? p.maxTokens : 400}${p && p.stop ? `, stop=[${JSON.stringify(p.stop)}]` : ''})`, 0, 1, 'openai SDK against the Foundry / Azure OpenAI endpoint. Parameter support differs by model; check the model docs.', { kind: 'code' }),
          NN('model', p && p.outputFormat === 'json_schema' ? 'response_format={"type":"json_schema","json_schema":{"name":"ticket","strict":True,"schema":SCHEMA}}' : 'response_format: (none)', 0, 2, 'Structured outputs constrain the model to a JSON schema.', { kind: 'code' }),
          NN('sampling', 'choice = resp.choices[0]; choice.finish_reason  # "stop" | "length" | "content_filter"', 1, 0.5, 'Always check finish_reason.', { kind: 'code' }),
          NN('validate', 'Ticket.model_validate_json(choice.message.content)', 1, 1.5, 'Validate with pydantic or jsonschema.', { kind: 'code' }),
          NN('quality', 'usage = resp.usage  # prompt_tokens, completion_tokens (+ reasoning_tokens)', 1, 2.5, 'Track tokens per prompt version.', { kind: 'code' }),
        ],
        edges: [['prompt', 'params'], ['model', 'params'], ['params', 'sampling'], ['sampling', 'validate'], ['sampling', 'quality']],
      }),
    },
  },

  sim: {
    mode: 'conceptual',
    controls: [
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([k, t]) => [k, t.label]), default: 'classify' },
      { id: 'model', label: 'Model type', type: 'select', options: [['chat', 'Chat model (e.g., GPT-4.1 family)'], ['reasoning', 'Reasoning model (e.g., o-series)']], default: 'chat' },
      { id: 'role', label: 'System: role', type: 'toggle', default: true },
      { id: 'constraints', label: 'System: constraints', type: 'toggle', default: false },
      { id: 'fewShot', label: 'Few-shot examples', type: 'number', min: 0, max: 3, step: 1, default: 0 },
      { id: 'outputFormat', label: 'Output format', type: 'select', options: [['none', 'None'], ['json_instruction', 'JSON requested in instructions'], ['json_schema', 'Structured outputs (json_schema, strict)']], default: 'none' },
      { id: 'temperature', label: 'temperature', type: 'range', min: 0, max: 2, step: 0.1, default: 1 },
      { id: 'top_p', label: 'top_p', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
      { id: 'maxTokens', label: 'max_tokens / max_completion_tokens', type: 'number', min: 1, max: 8000, step: 10, default: 400 },
      { id: 'frequencyPenalty', label: 'frequency_penalty', type: 'range', min: -2, max: 2, step: 0.1, default: 0 },
      { id: 'presencePenalty', label: 'presence_penalty', type: 'range', min: -2, max: 2, step: 0.1, default: 0 },
      { id: 'stop', label: 'Stop sequence', type: 'text', default: '' },
      { id: 'reasoningEffort', label: 'reasoning_effort (reasoning models)', type: 'select', options: [['low', 'low'], ['medium', 'medium'], ['high', 'high']], default: 'medium' },
      { id: 'runs', label: 'Samples per run', type: 'number', min: 1, max: 5, step: 1, default: 3 },
    ],
    samples: [
      { label: 'Classification, tuned for consistency', values: { task: 'classify', constraints: true, fewShot: 2, outputFormat: 'json_schema', temperature: 0, runs: 5 } },
      { label: 'Classification, bare prompt at T=1', values: { task: 'classify', runs: 5 } },
      { label: 'Brainstorm with higher temperature', values: { task: 'brainstorm', constraints: true, outputFormat: 'json_schema', temperature: 1.1, runs: 4 } },
      { label: 'Reasoning model, defaults only', values: { model: 'reasoning', task: 'summarize', outputFormat: 'json_schema', constraints: true, maxTokens: 4000 } },
    ],
    run: generate,
  },

  compare: {
    suggestions: [
      'Classify 5 samples with output format None, JSON in instructions, and Structured outputs; compare format compliance.',
      'Run the classifier at temperature 0, 0.7 and 1.5 and compare distinct outputs.',
      'Run the reasoning model with reasoning_effort low vs high at max_completion_tokens 1000 and compare finish_reason.',
    ],
  },

  debug: [
    { id: 'unsupported', title: 'Reasoning model rejects the request', values: { model: 'reasoning', temperature: 0.2, maxTokens: 4000 }, node: 'params',
      symptom: '400 unsupported_parameter: temperature.', cause: 'Reasoning models do not accept classic sampling parameters.', fix: 'Reset temperature and top_p to 1 and penalties to 0 (omit them); steer with reasoning_effort instead.' },
    { id: 'reasoningbudget', title: 'Empty answer from the reasoning model', values: { model: 'reasoning', reasoningEffort: 'high', maxTokens: 1000, temperature: 1, top_p: 1 }, node: 'sampling',
      symptom: 'finish_reason "length" and an empty message.', cause: 'max_completion_tokens is used up by hidden reasoning tokens before any visible output.', fix: 'Raise max_completion_tokens (e.g., 4000) or lower reasoning_effort.' },
    { id: 'stop', title: 'JSON always cut off', values: { outputFormat: 'json_schema', stop: '}', temperature: 0 }, node: 'sampling',
      symptom: 'Every output ends before the closing brace and fails to parse.', cause: 'The stop sequence "}" appears in valid JSON output.', fix: 'Clear the stop sequence (rely on the schema to end output).' },
    { id: 'truncate', title: 'Summaries truncated', values: { task: 'summarize', outputFormat: 'json_instruction', maxTokens: 20 }, node: 'params',
      symptom: 'finish_reason "length" and invalid JSON.', cause: 'max_tokens is smaller than the expected output.', fix: 'Raise max_tokens (e.g., 200) and add a length constraint in the prompt.' },
    { id: 'chaos', title: 'Labels change on every call', values: { task: 'classify', temperature: 1.8, outputFormat: 'json_instruction', runs: 5 }, node: 'params',
      symptom: 'Different categories and broken JSON for the same ticket.', cause: 'Temperature far too high for a deterministic classification task.', fix: 'Set temperature to 0–0.2 and use structured outputs.' },
    { id: 'prose', title: 'Parser fails on chatty answers', values: { task: 'classify', outputFormat: 'none', temperature: 0.2 }, node: 'validate',
      symptom: '"Sure! This looks like a billing issue…" instead of JSON.', cause: 'No output format was specified.', fix: 'Specify the format: JSON schema via structured outputs (best) or JSON in instructions with examples.' },
    { id: 'drift', title: 'Summaries mention things not in the review', values: { task: 'summarize', presencePenalty: 2, outputFormat: 'json_schema', constraints: true, temperature: 0.3 }, node: 'params',
      symptom: 'Summaries drift to unrelated topics.', cause: 'Presence penalty pushes the model to introduce new topics.', fix: 'Set presence_penalty back to 0 for faithful summarisation.' },
  ],

  challenge: {
    task: 'Make the ticket classifier production-ready: 5 samples that are all valid JSON, all correct and identical.',
    condition: 'Task = classify, at least 3 samples, format compliance N/N, correct N/N, distinct outputs 1, no warn or error steps.',
    hint: 'Constrain the output shape and remove randomness.',
    check: (p, res) => p.task === 'classify' && Number(p.runs) >= 3 && res.metrics[0].value === `${p.runs}/${p.runs}` && res.metrics[1].value === `${p.runs}/${p.runs}` && res.metrics[2].value === `1/${p.runs}` && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Keep the role and turn on constraints.', 'Add 1–2 few-shot examples.', 'Choose Structured outputs (json_schema, strict).', 'Set temperature to 0 (top_p can stay 1) and run 5 samples.'],
    solutionValues: { task: 'classify', model: 'chat', role: true, constraints: true, fewShot: 2, outputFormat: 'json_schema', temperature: 0, top_p: 1, maxTokens: 400, frequencyPenalty: 0, presencePenalty: 0, stop: '', runs: 5 },
  },

  quiz: [
    { q: 'An extraction endpoint must return the same JSON for the same document every time. Which configuration is most appropriate?', options: ['temperature 1.2 with JSON in instructions', 'temperature 0 with structured outputs (json_schema, strict)', 'High presence penalty', 'top_p 1 and temperature 2 with retries'], answer: 1, why: 'Low randomness gives repeatable answers; strict structured outputs guarantee schema-valid JSON.' },
    { q: 'You switch from a chat model to an o-series reasoning model and requests fail with "unsupported parameter: temperature". What should you do?', options: ['Lower temperature to 0', 'Remove sampling parameters and use reasoning_effort and max_completion_tokens', 'Switch to the completions API', 'Add a stop sequence'], answer: 1, why: 'Reasoning models are steered with reasoning_effort; classic sampling parameters are not supported.' },
    { q: 'A reasoning model returns empty content with finish_reason "length". What is the most likely cause?', options: ['Content filter', 'max_completion_tokens was consumed by hidden reasoning tokens', 'Wrong API key', 'Too many few-shot examples'], answer: 1, why: 'max_completion_tokens covers reasoning and visible tokens; raise it or reduce reasoning_effort.' },
    { q: 'A tagline generator returns the same three taglines on every call. Which change increases diversity most directly?', options: ['Raise temperature (e.g., 0.9–1.1)', 'Add a stop sequence', 'Lower max_tokens', 'Remove the system message'], answer: 0, why: 'Low temperature makes sampling near-greedy; creative tasks benefit from more randomness, while constraints keep quality.' },
  ],

  recap: 'Prompt first (role, constraints, examples, output contract), then parameters: low temperature and strict schemas for deterministic tasks, more randomness for creative ones, sane max tokens, careful stop sequences, moderate penalties. Reasoning models use reasoning_effort and max_completion_tokens instead of sampling knobs. Always check finish_reason and validate output.',
};
