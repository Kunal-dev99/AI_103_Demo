// 2.1.1 Deploy and consume LLMs, small models, code models, and multimodal models
// Lab: Model consumption console.
import { rng, round, step, metric, estTokens } from '../src/engine/util.js';

// Deployments that exist in the simulated Foundry project. ctx = context budget used by THIS simulation
// (illustrative; check each model card for the real window, which can change between versions).
const MODELS = {
  llm: { label: 'LLM: gpt-4o (Azure OpenAI)', deployment: 'gpt-4o', base: 'gpt-4o-2024-11-20', family: 'aoai', ctx: 128, image: true, audio: false,
    strengths: ['chat', 'analysis', 'image', 'code'], rel: 'highest', speed: 'moderate' },
  slm: { label: 'SLM: Phi-4-mini-instruct', deployment: 'phi-4-mini', base: 'Phi-4-mini-instruct', family: 'foundry', ctx: 128, image: false, audio: false,
    strengths: ['chat'], rel: 'lowest', speed: 'fastest' },
  code: { label: 'Code model: Codestral-2501', deployment: 'codestral', base: 'Codestral-2501', family: 'foundry', ctx: 256, image: false, audio: false,
    strengths: ['code'], rel: 'low', speed: 'fast' },
  mm: { label: 'Multimodal SLM: Phi-4-multimodal-instruct', deployment: 'phi-4-mm', base: 'Phi-4-multimodal-instruct', family: 'foundry', ctx: 128, image: true, audio: true,
    strengths: ['chat', 'image'], rel: 'low', speed: 'fast' },
};

const TASKS = {
  chat: { label: 'Customer-support answer', prompt: 'A customer asks how to reset their router password. Answer in 3 short steps.', needs: 'chat' },
  analysis: { label: 'Multi-step analysis (compare 3 contracts)', prompt: 'Compare the termination clauses in the three attached contracts and flag conflicts.', needs: 'analysis' },
  code: { label: 'Generate a Python function', prompt: 'Write a Python function that validates an IBAN and add unit tests.', needs: 'code' },
  image: { label: 'Describe a product photo', prompt: 'Describe the damage visible in this photo of a returned parcel.', needs: 'image' },
};

const ENDPOINTS = {
  responses: { label: 'OpenAI SDK, Responses API (/openai/v1)', sdk: 'openai', path: '/openai/v1/responses' },
  chat: { label: 'OpenAI SDK, Chat Completions (/openai/v1)', sdk: 'openai', path: '/openai/v1/chat/completions' },
  inference: { label: 'azure-ai-inference ChatCompletionsClient (/models)', sdk: 'azure-ai-inference', path: '/models/chat/completions' },
};

const fitScore = (m, task) => {
  if (task.needs === 'image') return m.image ? (m.family === 'aoai' ? 0.9 : 0.8) : 0;
  if (m.strengths.includes(task.needs)) return task.needs === 'analysis' ? 0.9 : 0.88;
  if (task.needs === 'analysis') return m === MODELS.slm || m === MODELS.mm ? 0.55 : 0.6;
  if (task.needs === 'code') return m === MODELS.llm ? 0.82 : 0.6;
  return 0.7;
};

function consume(p) {
  const m = MODELS[p.model] || MODELS.llm;
  const task = TASKS[p.task] || TASKS.chat;
  const ep = ENDPOINTS[p.endpoint] || ENDPOINTS.chat;
  const r = rng(`${p.model}|${p.task}|${p.endpoint}|${p.docK}|${p.maxTokens}`);
  const steps = [];
  const host = 'https://contoso-ai.services.ai.azure.com';
  const sentName = p.nameStyle === 'match' ? m.deployment : p.nameStyle === 'base' ? m.base : 'gpt4-prod';
  const promptTokens = estTokens(task.prompt) + 40 + Math.round(p.docK * 1000) + (p.image ? 850 : 0);
  const maxOut = Number(p.maxTokens) || 0;

  // Request shape
  const userContent = p.image
    ? (p.endpoint === 'responses'
      ? [{ type: 'input_text', text: task.prompt }, { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ…' }]
      : [{ type: 'text', text: task.prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ…' } }])
    : task.prompt + (p.docK ? ` [+ ~${p.docK}k tokens of pasted documents]` : '');
  const body = p.endpoint === 'responses'
    ? { model: sentName, instructions: 'You are a concise assistant.', input: [{ role: 'user', content: userContent }], max_output_tokens: maxOut, stream: p.stream }
    : { model: sentName, messages: [{ role: 'system', content: 'You are a concise assistant.' }, { role: 'user', content: userContent }], max_tokens: maxOut, stream: p.stream };

  steps.push(step('app', 'Request built', `${ep.label} • task "${task.label}" • ${p.image ? 'text + image part' : 'text only'}`, { method: 'POST', url: host + ep.path, body }, 'info'));

  // 1. Auth
  if (p.auth === 'entraNoRole') {
    steps.push(step('auth', 'Token accepted, call forbidden', 'DefaultAzureCredential got a Microsoft Entra token, but the identity has no data-plane role on the Foundry resource. Owner/Contributor are control-plane roles and do not grant inference.',
      { httpStatus: 401, code: 'PermissionDenied', message: 'The principal lacks the required data action Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action (illustrative wording).', fix: 'Assign "Cognitive Services OpenAI User" or "Azure AI User" on the resource' }, 'error'));
    return finish(p, m, task, ep, steps, null, promptTokens, 0, 'Blocked: missing data-plane role');
  }
  steps.push(step('auth', p.auth === 'key' ? 'API key accepted' : 'Entra token accepted', p.auth === 'key'
    ? 'Key auth works, but keys are long-lived secrets. Prefer Microsoft Entra ID (keyless) in production; many orgs disable local auth entirely.'
    : 'Bearer token for scope https://cognitiveservices.azure.com/.default; the identity holds a data-plane role.', { auth: p.auth }, p.auth === 'key' ? 'warn' : 'ok'));

  // 2. Endpoint / deployment routing
  if (p.nameStyle !== 'match') {
    steps.push(step('deployment', 'Deployment not found', p.nameStyle === 'base'
      ? `The request used the base model name "${m.base}". The "model" parameter must be the DEPLOYMENT name you chose ("${m.deployment}").`
      : 'The name "gpt4-prod" comes from an old environment file; no deployment with that name exists in this resource.',
    { httpStatus: 404, error: { code: 'DeploymentNotFound', message: `The API deployment for this resource does not exist (requested "${sentName}").` }, deploymentsInProject: Object.values(MODELS).map(x => x.deployment) }, 'error'));
    return finish(p, m, task, ep, steps, null, promptTokens, 0, `404 DeploymentNotFound ("${sentName}")`);
  }
  const respWarn = p.endpoint === 'responses' && m.family !== 'aoai';
  steps.push(step('endpoint', `Routed to deployment "${m.deployment}"`, respWarn
    ? 'Responses API support for non-OpenAI models varies by model and region. In this simulation the call is accepted, but check the docs; Chat Completions is the widest-supported surface for Foundry Models.'
    : `${ep.path} on the Foundry resource. Same resource serves Azure OpenAI and Foundry Models deployments.`, { endpoint: host + ep.path, model: m.base, family: m.family === 'aoai' ? 'Azure OpenAI' : 'Foundry Models (sold directly by Azure / partner)' }, respWarn ? 'warn' : 'ok'));

  // 3. Input validation by the model
  if (p.image && !m.image) {
    steps.push(step('model', 'Image part rejected', `${m.base} is text-only. Content parts of type image are not accepted.`,
      { httpStatus: 400, error: { code: 'BadRequest', message: 'Image input is not supported by this model (illustrative wording).' }, modalities: { text: true, image: m.image, audio: m.audio } }, 'error'));
    return finish(p, m, task, ep, steps, null, promptTokens, 0, 'Rejected: image sent to text-only model');
  }
  if (promptTokens + maxOut > m.ctx * 1000) {
    steps.push(step('model', 'Context length exceeded', `Prompt (~${promptTokens.toLocaleString()} est. tokens) + max output (${maxOut}) exceeds this simulation's ${m.ctx}k budget for ${m.base}.`,
      { httpStatus: 400, error: { code: 'context_length_exceeded', message: `This model's maximum context length is ${m.ctx}k tokens (sim value).` } }, 'error'));
    return finish(p, m, task, ep, steps, null, promptTokens, 0, 'Rejected: context length exceeded');
  }
  if (task.needs === 'image' && !p.image) {
    steps.push(step('model', 'No image attached', 'The prompt refers to a photo but no image part was sent. The model can only guess.', { contentParts: 1 }, 'warn'));
  }

  // 4. Generation
  const fit = fitScore(m, task) * (task.needs === 'image' && !p.image ? 0.3 : 1);
  const wanted = task.needs === 'code' ? 420 : task.needs === 'analysis' ? 600 : 180;
  const completion = Math.min(maxOut, Math.round(wanted * (0.85 + r() * 0.3)));
  const truncated = completion >= maxOut && wanted > maxOut;
  const quality = round(fit * (truncated ? 0.7 : 1), 2);
  steps.push(step('model', 'Generation', `${m.base} produced ${completion} output tokens${truncated ? ' and stopped at max tokens' : ''}. Task fit (sim): ${quality}.`,
    { finish_reason: truncated ? 'length' : 'stop', fit: quality }, truncated || quality < 0.65 ? 'warn' : 'ok'));

  // 5. Response
  const text = sampleText(task, m, p, quality);
  const response = p.endpoint === 'responses'
    ? { id: 'resp_…', object: 'response', model: m.base, status: truncated ? 'incomplete' : 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: promptTokens, output_tokens: completion, total_tokens: promptTokens + completion } }
    : { id: 'chatcmpl-…', object: 'chat.completion', model: m.base, choices: [{ index: 0, finish_reason: truncated ? 'length' : 'stop', message: { role: 'assistant', content: text } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion } };
  steps.push(step('response', p.stream ? 'Streamed response assembled' : 'Response received', p.stream
    ? 'Tokens arrived as server-sent-event chunks (delta.content / response.output_text.delta). Usage is only reported at the end of the stream (Chat Completions needs stream_options.include_usage).'
    : 'Single JSON body with the message and token usage.', response, 'ok'));

  return finish(p, m, task, ep, steps, response, promptTokens, completion, `${m.deployment}: fit ${quality} • ~${promptTokens + completion} tokens`, text, quality, truncated);
}

function sampleText(task, m, p, q) {
  if (task.needs === 'code') return m === MODELS.slm || m === MODELS.mm ? 'def validate_iban(s):\n    return len(s) > 15  # incomplete check' : 'def validate_iban(iban: str) -> bool:\n    s = iban.replace(" ", "").upper()\n    s = s[4:] + s[:4]\n    return int("".join(str(int(c, 36)) for c in s)) % 97 == 1';
  if (task.needs === 'image') return p.image ? 'The parcel has a crushed top-left corner and a 5 cm tear along one edge; the tape is intact.' : 'I cannot see an image. Please attach the photo.';
  if (task.needs === 'analysis') return q < 0.7 ? 'Contract A allows termination. Contract B also allows termination. (No conflicts listed.)' : 'Conflict: A requires 90 days notice, B allows 30; C is silent on cause. Flag A vs B for legal review.';
  return '1. Open the router admin page. 2. Choose Wireless > Security. 3. Set a new password and save.';
}

function finish(p, m, task, ep, steps, response, promptTokens, completion, summary, text, quality, truncated) {
  const output = [];
  const req = steps[0].data;
  output.push({ type: 'json', title: `Request (${ep.sdk}, simulated)`, data: req });
  if (response) {
    output.push({ type: 'chat', title: 'Conversation', turns: [{ role: 'user', text: task.prompt + (p.image ? ' [image attached]' : '') }, { role: 'assistant', text, meta: `${m.base} • ${completion} tokens` }] });
    output.push({ type: 'json', title: 'Response (abridged, simulated shape)', data: response });
    output.push({ type: 'bars', title: 'Token usage (estimated)', items: [
      { label: 'Input', value: promptTokens, max: m.ctx * 1000, note: `of ${m.ctx}k sim budget` },
      { label: 'Output', value: completion, max: Math.max(1, Number(p.maxTokens) || 1), note: `max_tokens ${p.maxTokens}`, tone: truncated ? 'warn' : 'ok' },
    ] });
  } else {
    const err = steps[steps.length - 1];
    output.push({ type: 'alert', tone: 'error', text: `${err.title}: ${err.detail}` });
    output.push({ type: 'json', title: 'Error body (simulated shape)', data: err.data });
  }
  output.push({ type: 'table', title: 'Deployments in this project (sim)', columns: ['Deployment name', 'Model', 'Image input', 'Relative cost'],
    rows: Object.values(MODELS).map(x => [x.deployment, x.base, x.image ? 'yes' : 'no', x.rel]), tones: Object.values(MODELS).map(x => (x === m ? 'ok' : '')) });
  return {
    steps, output,
    metrics: [
      metric('Prompt tokens', `~${promptTokens.toLocaleString()}`, 'estimate', '~4 characters per token heuristic plus a flat image allowance; real tokenizers differ per model.'),
      metric('Output tokens', String(completion), 'computed', 'Simulated completion length, capped by max tokens.'),
      metric('Task fit', quality == null ? '—' : String(quality), 'computed', 'Simulator score from the model/task capability table.'),
      metric('Relative cost per token', m.rel, 'estimate', 'SLMs and partner code models are usually cheaper per token than frontier LLMs. Check the Foundry pricing page; no prices are reproduced here.'),
    ],
    summary,
  };
}

const NODES = (p, labels) => {
  const m = p ? MODELS[p.model] : null;
  return [
    { id: 'app', label: labels.app, col: 0, row: 1, kind: 'app', detail: 'Your code builds the request: deployment name, messages/input, content parts, max tokens, streaming.' },
    { id: 'auth', label: labels.auth, col: 1, row: 0, kind: 'policy', badge: p ? p.auth : undefined, detail: 'Microsoft Entra ID token (DefaultAzureCredential) with a data-plane role, or an API key if local auth is enabled.' },
    { id: 'endpoint', label: labels.endpoint, col: 1, row: 2, kind: 'compute', detail: 'One Foundry resource exposes /openai/v1 (OpenAI-compatible) and /models (Foundry Models inference) routes.' },
    { id: 'deployment', label: labels.deployment, col: 2, row: 1, kind: 'data', badge: p ? (p.nameStyle === 'match' ? 'name ok' : 'wrong name') : undefined, detail: 'A deployment binds a name you choose to a model version, SKU and capacity. Requests address the deployment name, not the model name.' },
    { id: 'model', label: labels.model || (m ? m.base : 'Model'), col: 3, row: 1, kind: 'ai', detail: 'Checks modalities and context length, then generates.', substeps: ['Validate content parts', 'Check context budget', 'Generate tokens', 'Apply content filters'] },
    { id: 'response', label: labels.response, col: 4, row: 1, kind: 'data', detail: 'Message/output text, finish reason and token usage. Streaming delivers deltas first and usage last.' },
  ];
};

export default {
  id: '2.1.1',
  lab: 'Model consumption console',
  services: [
    { name: 'Foundry Models overview', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/foundry-models-overview' },
    { name: 'Azure OpenAI in Foundry Models: Responses API', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses' },
    { name: 'Deploy models in Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/create-model-deployments' },
  ],
  prereqs: ['1.1.1', '1.2.3'],
  next: ['2.1.2', '2.3.1', '1.3.1'],

  concept: {
    plain: 'Before your app can use a model you deploy it: you pick a model (a big general model, a small cheap one, a code specialist or one that can see images) and give the deployment a name. Your code then sends requests to that name. The request must fit what the model accepts — a text-only model cannot read a photo, and every model has a limit on how much text it can take in one go.',
    technical: 'In Microsoft Foundry a deployment binds a deployment name to a model version and a deployment type (for example Global Standard or Provisioned). Azure OpenAI models and Foundry Models (Phi, Mistral, Llama, DeepSeek…) are called through the same Foundry resource: the OpenAI SDK against /openai/v1 (Responses API or Chat Completions) or azure-ai-inference ChatCompletionsClient against /models. The request\'s "model" field is the deployment name. Multimodal input is sent as typed content parts; output length is capped by max_tokens / max_output_tokens and the response reports finish_reason and token usage.',
    useCase: 'A retailer routes support answers to a Phi-4-mini deployment (cheap, fast), code generation in its internal dev portal to Codestral, damaged-parcel photos to gpt-4o, and only escalated multi-document analyses to the larger model. All four are deployments in one Foundry project, called with Entra ID from an App Service managed identity.',
    terms: [
      ['Deployment', 'Named, versioned instance of a model with a deployment type and capacity. Requests address it by name.'],
      ['SLM', 'Small language model (e.g. Phi family): lower cost and latency, good for focused tasks, weaker on complex reasoning.'],
      ['Content part', 'Typed piece of a message: text, image_url / input_image, audio. Only accepted if the model supports that modality.'],
      ['finish_reason', '"stop" when the model finished, "length" when it hit the max token cap, "content_filter" when filtered.'],
      ['Context window', 'Maximum input + output tokens per request. Check the model card; the values in this lab are illustrative.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: NODES(p, { app: 'Your prompt', auth: 'Who is calling?', endpoint: 'Which API surface?', deployment: 'Which deployment name?', model: p ? MODELS[p.model].label : 'Model', response: 'Answer + usage' }),
        edges: [['app', 'auth'], ['app', 'endpoint'], ['auth', 'deployment'], ['endpoint', 'deployment'], ['deployment', 'model'], ['model', 'response']],
      }),
      architectural: p => ({
        nodes: NODES(p, { app: 'App Service (managed identity)', auth: 'Microsoft Entra ID + RBAC', endpoint: 'Foundry resource endpoint', deployment: `Deployment "${p ? MODELS[p.model].deployment : 'name'}"`, model: p ? `${MODELS[p.model].base}${MODELS[p.model].family === 'aoai' ? ' (Azure OpenAI)' : ' (Foundry Models)'}` : 'Model', response: 'App response / logs' }),
        edges: [['app', 'auth', 'token'], ['app', 'endpoint', 'HTTPS'], ['endpoint', 'deployment'], ['deployment', 'model'], ['model', 'response', 'JSON / SSE']],
      }),
      implementation: p => {
        const ep = p ? p.endpoint : 'chat';
        const client = ep === 'inference' ? 'ChatCompletionsClient(endpoint=".../models", credential=DefaultAzureCredential())' : 'OpenAI(base_url=".../openai/v1/", api_key=get_bearer_token_provider(...))';
        const call = ep === 'responses' ? 'client.responses.create(model=DEPLOYMENT, input=[...], max_output_tokens=N)' : ep === 'inference' ? 'client.complete(model=DEPLOYMENT, messages=[...], max_tokens=N)' : 'client.chat.completions.create(model=DEPLOYMENT, messages=[...], max_tokens=N)';
        return {
          nodes: [
            { id: 'auth', label: 'cred = DefaultAzureCredential()', col: 0, row: 0, kind: 'code', detail: 'Keyless auth. Token scope https://cognitiveservices.azure.com/.default. Code is illustrative; check the SDK docs for exact helpers.' },
            { id: 'endpoint', label: `client = ${client}`, col: 0, row: 1, kind: 'code', detail: 'Same Foundry resource, different SDK surface.' },
            { id: 'deployment', label: 'DEPLOYMENT = os.environ["MODEL_DEPLOYMENT_NAME"]', col: 0, row: 2, kind: 'code', detail: 'Read the deployment name from config so it matches the environment.' },
            { id: 'app', label: `content = [{"type":"text",...}${p && p.image ? ', {"type":"image_url",...}' : ''}]`, col: 0, row: 3, kind: 'code', detail: 'Content parts. Images as URL or base64 data URI.' },
            { id: 'model', label: `resp = ${call}`, col: 0, row: 4, kind: 'code', detail: 'Errors surface as openai.NotFoundError / BadRequestError / PermissionDeniedError (or HttpResponseError in azure-ai-inference).' },
            { id: 'response', label: ep === 'responses' ? 'print(resp.output_text, resp.usage)' : 'print(resp.choices[0].message.content, resp.usage)', col: 0, row: 5, kind: 'code', detail: 'Always log usage and finish_reason.' },
          ],
          edges: [['auth', 'endpoint'], ['endpoint', 'deployment'], ['deployment', 'app'], ['app', 'model'], ['model', 'response']],
        };
      },
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'model', label: 'Deployed model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'llm' },
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([v, t]) => [v, t.label]), default: 'chat' },
      { id: 'endpoint', label: 'API surface', type: 'select', options: Object.entries(ENDPOINTS).map(([v, e]) => [v, e.label]), default: 'chat' },
      { id: 'nameStyle', label: '"model" value in the request', type: 'select', options: [['match', 'Deployment name from config'], ['base', 'Base model name (e.g. gpt-4o-2024-11-20)'], ['stale', 'Stale name from old .env ("gpt4-prod")']], default: 'match' },
      { id: 'auth', label: 'Credential', type: 'select', options: [['entra', 'Entra ID, identity has Azure AI User'], ['entraNoRole', 'Entra ID, identity has Contributor only'], ['key', 'API key']], default: 'entra' },
      { id: 'image', label: 'Attach image content part', type: 'toggle', default: false },
      { id: 'docK', label: 'Pasted document context (thousand tokens)', type: 'range', min: 0, max: 200, step: 10, default: 0, help: 'Simulates stuffing long documents into the prompt.' },
      { id: 'maxTokens', label: 'Max output tokens', type: 'number', min: 50, max: 4000, step: 50, default: 800 },
      { id: 'stream', label: 'Stream response', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'SLM answering a support question', values: { model: 'slm', task: 'chat' } },
      { label: 'Code model via azure-ai-inference', values: { model: 'code', task: 'code', endpoint: 'inference' } },
      { label: 'Photo to gpt-4o via Responses API', values: { model: 'llm', task: 'image', endpoint: 'responses', image: true } },
      { label: 'SLM on a hard analysis task', values: { model: 'slm', task: 'analysis', docK: 30 } },
    ],
    run: consume,
  },

  compare: {
    suggestions: [
      'Run "Multi-step analysis" on the SLM and then on gpt-4o; compare task fit and relative cost.',
      'Run the code task on Codestral, gpt-4o and Phi-4-mini and compare the generated function.',
      'Send the same image prompt via Chat Completions and via the Responses API and compare request shapes (image_url vs input_image).',
    ],
  },

  debug: [
    { id: 'deployname', title: '404 on every call after deploying to a new environment', values: { nameStyle: 'stale' }, node: 'deployment',
      symptom: 'HTTP 404 DeploymentNotFound.', cause: 'The code sends a deployment name that does not exist in this resource (copied from an old .env, or the base model name was used).', fix: 'Set the "model" value to the deployment name from config (MODEL_DEPLOYMENT_NAME) for this environment.' },
    { id: 'basename', title: 'Using the model name instead of the deployment name', values: { nameStyle: 'base', model: 'llm' }, node: 'deployment',
      symptom: '404 even though gpt-4o is clearly deployed.', cause: 'Requests address the deployment name ("gpt-4o" here), not the versioned model name.', fix: 'Use the deployment name from config.' },
    { id: 'image', title: 'Photo upload fails on the cheap model', values: { model: 'slm', task: 'image', image: true }, node: 'model',
      symptom: 'HTTP 400 when the image content part is included.', cause: 'Phi-4-mini-instruct is text-only. Unsuitable model for the modality.', fix: 'Route image tasks to a multimodal deployment (gpt-4o or Phi-4-multimodal-instruct).' },
    { id: 'ctx', title: 'Long-document requests fail', values: { model: 'llm', task: 'analysis', docK: 140, maxTokens: 2000 }, node: 'model',
      symptom: 'HTTP 400 context_length_exceeded.', cause: 'The whole document set was pasted into the prompt; input + max output exceeds the context window.', fix: 'Send less context (use retrieval, see 2.1.2) or choose a model with a larger window; reduce max output tokens.' },
    { id: 'rbac', title: 'Works for the developer, 401 in production', values: { auth: 'entraNoRole' }, node: 'auth',
      symptom: 'PermissionDenied: principal lacks the chat/completions data action.', cause: 'The managed identity has Contributor (control plane) but no data-plane role.', fix: 'Grant "Azure AI User" (or "Cognitive Services OpenAI User") on the Foundry resource and use Entra auth.' },
    { id: 'trunc', title: 'Generated code stops mid-function', values: { model: 'code', task: 'code', maxTokens: 150 }, node: 'response',
      symptom: 'finish_reason "length"; output cut off.', cause: 'max_tokens is lower than the answer needs.', fix: 'Raise max output tokens (e.g. 800).' },
  ],

  challenge: {
    task: 'Get a correct, untruncated answer to the damaged-parcel photo task at the lowest relative cost, using keyless auth.',
    condition: 'Task = Describe a product photo, image attached, no error/warn in the run, credential is Entra with a role, and the model\'s relative cost is not "highest".',
    hint: 'Only two deployments accept images. One of them is a small model.',
    check: (p, res) => p.task === 'image' && p.image && p.auth === 'entra' && MODELS[p.model].rel !== 'highest' && !res.steps.some(s => s.status === 'error' || s.status === 'warn'),
    solution: ['Task: Describe a product photo; turn on "Attach image content part".', 'Model: Phi-4-multimodal-instruct (image input, lower cost than gpt-4o).', 'API surface: Chat Completions (Responses API on a non-OpenAI model raises a warning here).', 'Credential: Entra ID with Azure AI User. Run.'],
    solutionValues: { task: 'image', image: true, model: 'mm', endpoint: 'chat', auth: 'entra', nameStyle: 'match', docK: 0, maxTokens: 800 },
  },

  quiz: [
    { q: 'Your code calls client.chat.completions.create(model="gpt-4o-2024-11-20", …) and gets 404 DeploymentNotFound. The deployment is called "support-gpt4o". What should you change?', options: ['Request more quota', 'Set model="support-gpt4o"', 'Switch to the azure-ai-inference SDK', 'Use an API key instead of Entra ID'], answer: 1, why: 'The model parameter is the deployment name. Quota, SDK and auth do not cause a 404 for an unknown deployment.' },
    { q: 'You must classify 2 million short support tickets per day into 8 categories with low latency and cost. Which deployment is the best first choice to evaluate?', options: ['A frontier multimodal LLM', 'A small language model such as Phi-4-mini', 'A code model', 'An image generation model'], answer: 1, why: 'Narrow, high-volume text tasks are a typical SLM fit. Evaluate it first and escalate only if quality is insufficient.' },
    { q: 'An app sends a photo plus a question to a Phi-4-mini-instruct deployment and receives HTTP 400. What is the most likely cause?', options: ['Missing RBAC role', 'The model does not accept image content parts', 'max_tokens is too high', 'Streaming is enabled'], answer: 1, why: 'Phi-4-mini-instruct is text-only. A missing role returns 401/403, not 400.' },
    { q: 'A response comes back with finish_reason "length". What happened?', options: ['The content filter blocked it', 'The output hit the max token limit', 'The deployment was throttled', 'The input exceeded the context window'], answer: 1, why: '"length" means generation stopped at the output cap. Input overflow fails the request instead.' },
  ],

  recap: 'Deploy each model under a name, call that name, and match the model to the task: SLMs for cheap focused work, code models for code, multimodal models for images, large models for hard reasoning. Send only modalities the model accepts, keep input + output inside the context window, authenticate with Entra ID plus a data-plane role, and always check finish_reason and usage.',
};
