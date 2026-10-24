// 3.2.1 Build a solution that analyzes visual context by using multimodal models
// Lab: Visual context analyzer.
import { round, step, metric, estTokens, words } from '../src/engine/util.js';

// Synthetic scenes on a 100x70 canvas. Each object has an observable fact; `small` objects need enough
// pixels (upload resolution) AND high detail to be read. `hazard` marks safety-relevant ground truth.
const SCENES = {
  warehouse: {
    label: 'Warehouse aisle (CCTV still)',
    bg: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#cfd8dc' }, { kind: 'rect', x: 0, y: 52, w: 100, h: 18, fill: '#90a4ae' }],
    objects: [
      { id: 'forklift', label: 'forklift', x: 8, y: 28, w: 26, h: 26, tags: 'forklift vehicle machine moving traffic', fact: 'A yellow forklift is carrying a pallet in the aisle.', draw: [{ kind: 'rect', x: 8, y: 36, w: 20, h: 14, fill: '#fbc02d' }, { kind: 'rect', x: 28, y: 28, w: 2, h: 24, fill: '#424242' }, { kind: 'circle', x: 12, y: 52, r: 3, fill: '#212121' }, { kind: 'circle', x: 24, y: 52, r: 3, fill: '#212121' }] },
      { id: 'worker', label: 'worker', x: 44, y: 26, w: 9, h: 28, tags: 'worker person people pedestrian staff walking', fact: 'A worker in a hi-vis vest is walking about two metres from the forklift.', draw: [{ kind: 'rect', x: 45, y: 33, w: 7, h: 12, fill: '#ff9800' }, { kind: 'circle', x: 48.5, y: 30, r: 3, fill: '#f1c27d' }, { kind: 'rect', x: 45.5, y: 45, w: 6, h: 9, fill: '#37474f' }] },
      { id: 'helmet', label: 'no hard hat', x: 44, y: 25, w: 9, h: 6, small: true, hazard: true, tags: 'helmet hard hat ppe unsafe safety hazard head', fact: 'The worker is not wearing a hard hat.', draw: [] },
      { id: 'spill', label: 'spill', x: 58, y: 56, w: 16, h: 5, small: true, hazard: true, tags: 'spill floor liquid slip unsafe safety hazard', fact: 'There is a liquid spill on the floor in the aisle.', draw: [{ kind: 'rect', x: 58, y: 57, w: 16, h: 3, fill: '#4fc3f7' }] },
      { id: 'pallets', label: 'pallet stack', x: 76, y: 18, w: 20, h: 36, tags: 'pallets stack boxes storage height', fact: 'Pallets are stacked four high on the right.', draw: [0, 1, 2, 3].map(i => ({ kind: 'rect', x: 77, y: 45 - i * 9, w: 18, h: 8, fill: i % 2 ? '#a1887f' : '#8d6e63' })) },
      { id: 'sign', label: 'sign "MAX STACK 3"', x: 78, y: 4, w: 16, h: 9, small: true, tags: 'sign text limit stack rule max', fact: 'A sign reads "MAX STACK 3".', draw: [{ kind: 'rect', x: 78, y: 4, w: 16, h: 9, fill: '#ffffff' }, { kind: 'text', x: 79, y: 10, text: 'MAX 3', fill: '#c62828' }] },
    ],
    inferences: [
      { needs: ['pallets', 'sign'], text: 'The stack (4 high) likely exceeds the posted limit (3) — inferred by comparing two observations.', tags: 'stack limit unsafe safety rule violation' },
      { needs: ['forklift', 'worker'], text: 'The forklift appears to be moving towards the worker — a still image cannot confirm motion.', tags: 'unsafe safety moving risk forklift worker' },
    ],
  },
  street: {
    label: 'School crossing (dashcam frame)',
    bg: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#b0bec5' }, { kind: 'rect', x: 0, y: 45, w: 100, h: 25, fill: '#546e7a' }],
    objects: [
      { id: 'car', label: 'car', x: 10, y: 40, w: 28, h: 14, tags: 'car vehicle traffic driving', fact: 'A blue car is approaching the crossing.', draw: [{ kind: 'rect', x: 10, y: 44, w: 28, h: 8, fill: '#1565c0' }, { kind: 'rect', x: 16, y: 39, w: 15, h: 6, fill: '#64b5f6' }] },
      { id: 'pedestrian', label: 'child crossing', x: 55, y: 36, w: 7, h: 18, tags: 'pedestrian person child people crossing walking', fact: 'A child is on the zebra crossing.', draw: [{ kind: 'rect', x: 56, y: 42, w: 5, h: 8, fill: '#e53935' }, { kind: 'circle', x: 58.5, y: 39, r: 2.5, fill: '#f1c27d' }, { kind: 'rect', x: 50, y: 54, w: 25, h: 2, fill: '#ffffff' }, { kind: 'rect', x: 50, y: 58, w: 25, h: 2, fill: '#ffffff' }] },
      { id: 'light', label: 'red light', x: 82, y: 8, w: 6, h: 16, small: true, hazard: true, tags: 'traffic light signal red stop', fact: 'The traffic light facing the car is red.', draw: [{ kind: 'rect', x: 82, y: 8, w: 6, h: 16, fill: '#212121' }, { kind: 'circle', x: 85, y: 12, r: 2, fill: '#f44336' }] },
      { id: 'sign', label: 'sign "SCHOOL 20"', x: 66, y: 10, w: 12, h: 10, small: true, tags: 'sign text speed limit school', fact: 'A sign reads "SCHOOL ZONE 20".', draw: [{ kind: 'rect', x: 66, y: 10, w: 12, h: 10, fill: '#fdd835' }, { kind: 'text', x: 67, y: 17, text: '20', fill: '#212121' }] },
    ],
    inferences: [
      { needs: ['car', 'light'], text: 'The car should stop: its light is red — inferred, the car\'s speed is not observable.', tags: 'unsafe safety stop risk car' },
      { needs: ['car', 'pedestrian'], text: 'The child may be at risk if the car does not stop — an inference about intent, not an observation.', tags: 'unsafe safety risk child pedestrian' },
    ],
  },
  chart: {
    label: 'Dashboard screenshot (bar chart)',
    bg: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#ffffff' }, { kind: 'line', x: 10, y: 60, x2: 95, y2: 60, fill: '#757575' }],
    objects: [
      { id: 'title', label: 'title', x: 10, y: 2, w: 60, h: 8, small: true, tags: 'title chart revenue quarter q3', fact: 'Title: "Q3 revenue by region".', draw: [{ kind: 'text', x: 10, y: 8, text: 'Q3 revenue by region', fill: '#212121' }] },
      { id: 'bars', label: 'bars', x: 12, y: 15, w: 80, h: 45, tags: 'bars chart region revenue largest highest compare emea americas apac', fact: 'Three bars: EMEA is the tallest, then Americas, then APAC.', draw: [{ kind: 'rect', x: 15, y: 18, w: 18, h: 42, fill: '#1e88e5' }, { kind: 'rect', x: 43, y: 28, w: 18, h: 32, fill: '#43a047' }, { kind: 'rect', x: 71, y: 40, w: 18, h: 20, fill: '#fb8c00' }] },
      { id: 'labels', label: 'axis values', x: 12, y: 61, w: 80, h: 7, small: true, tags: 'values numbers amount million emea americas apac labels', fact: 'Bar labels read EMEA 4.2M, AMER 3.1M, APAC 1.9M.', draw: [{ kind: 'text', x: 15, y: 67, text: 'EMEA 4.2M', fill: '#212121' }, { kind: 'text', x: 43, y: 67, text: 'AMER 3.1M', fill: '#212121' }, { kind: 'text', x: 71, y: 67, text: 'APAC 1.9M', fill: '#212121' }] },
    ],
    inferences: [
      { needs: ['bars'], text: 'EMEA contributes the largest share of Q3 revenue (relative heights).', tags: 'largest share revenue compare' },
      { needs: ['title', 'bars'], text: 'Whether revenue is growing cannot be determined: only one quarter is shown.', tags: 'trend growing growth increase compare' },
    ],
  },
};

const MODELS = {
  'gpt-4.1': { label: 'gpt-4.1 (multimodal)', vision: true },
  'gpt-4o': { label: 'gpt-4o (multimodal)', vision: true },
  'gpt-4o-mini': { label: 'gpt-4o-mini (multimodal, cheaper)', vision: true, weaker: true },
  'gpt-35-turbo': { label: 'gpt-35-turbo (text only)', vision: false },
};
const FORMATS = { jpeg: true, png: true, webp: true, gif: true, tiff: false, heic: false };
const MAX_IMAGES = 10;

// Documented tile formula for GPT-4o/GPT-4 Turbo-class vision (low = flat 85; high = 85 + 170 per 512px tile
// after scaling). Newer models may count differently: treat as an estimate.
function imageTokens(res, detail) {
  let [w, h] = res.split('x').map(Number);
  if (detail === 'low') return { tokens: 85, tiles: 0, scaled: '512x512 (low)' };
  const f1 = Math.min(1, 2048 / Math.max(w, h)); w *= f1; h *= f1;
  const f2 = Math.min(1, 768 / Math.min(w, h)); w *= f2; h *= f2;
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return { tokens: 85 + 170 * tiles, tiles, scaled: `${Math.round(w)}x${Math.round(h)}` };
}

function run(p) {
  const steps = [];
  const sc = SCENES[p.scene];
  const m = MODELS[p.model];
  const q = String(p.question || '');
  const count = Math.max(1, Math.round(p.imageCount));
  const sceneImg = extra => ({ type: 'image', title: sc.label, width: 100, height: 70, shapes: [...sc.bg, ...sc.objects.flatMap(o => o.draw), ...extra] });
  const fail = (node, title, detail, data, summary) => { steps.push(step(node, title, detail, data, 'error')); return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, sceneImg([])], metrics: [metric('Image tokens', '—', 'computed')], summary }; };

  // 1. Build request
  if (!q.trim()) return fail('client', 'Question missing', 'Send a text part with the question alongside the image parts.', {}, 'Rejected: no question');
  steps.push(step('client', 'Chat request built', `messages = [${p.separate ? 'system (grounding rules), ' : ''}user: [text, ${count} × image_url (detail="${p.detail}")]]`, { model: p.model, images: count, detail: p.detail, source: p.source }));

  // 2. Model capability
  if (!m.vision) return fail('model', 'HTTP 400: model does not accept images', `${m.label} has no vision input. Deploy a multimodal model (for example gpt-4.1 or gpt-4o).`, { model: p.model }, 'Rejected: text-only model');

  // 3. Fetch image
  if (p.source === 'blob-private') return fail('fetch', 'HTTP 400: image URL not accessible', 'The model service downloads image URLs itself. A private Blob URL without a SAS token is not reachable from the service. Use a short-lived read-only SAS URL, or send the bytes as a base64 data URL.', { url: 'https://contoso.blob.core.windows.net/cctv/cam3.jpg', sas: false }, 'Failed: private image URL');
  if (!FORMATS[p.format]) return fail('fetch', `HTTP 400: unsupported image format (${p.format})`, 'Supported inputs are common web formats such as PNG, JPEG, WebP and non-animated GIF (check the docs for your model). Convert TIFF/HEIC before sending.', { format: p.format }, 'Rejected: unsupported format');
  if (count > MAX_IMAGES) return fail('fetch', 'HTTP 400: too many images', `${count} images exceed the per-request limit configured in this simulation (${MAX_IMAGES}). Real limits vary by model — check the docs. Batch over several requests or sample fewer frames.`, { images: count, max: MAX_IMAGES }, 'Rejected: too many images');
  steps.push(step('fetch', 'Image(s) retrieved', p.source === 'base64' ? 'Inline base64 data URL: no network fetch, but the request body grows (~33% over raw bytes).' : p.source === 'blob-sas' ? 'Blob URL with short-lived read-only SAS fetched by the service.' : 'Public URL fetched by the service.', { format: p.format, uploadResolution: p.uploadRes }));

  // 4. Detail / tokens
  const [uw, uh] = p.uploadRes.split('x').map(Number);
  const eff = p.detail === 'auto' ? (Math.max(uw, uh) > 512 ? 'high' : 'low') : p.detail;
  const tk = imageTokens(p.uploadRes, eff);
  const imgTokens = tk.tokens * count;
  steps.push(step('tokens', `Detail: ${p.detail}${p.detail === 'auto' ? ` → ${eff}` : ''}`, eff === 'low' ? 'Low detail: the model sees a 512x512 overview at a flat token cost. Small text and small objects are not legible.' : `High detail: scaled to ${tk.scaled}, ${tk.tiles} tile(s) of 512 px. More tokens, fine detail available.`, { perImageTokens: tk.tokens, images: count, totalImageTokens: imgTokens }, 'info'));

  // 5. Model reasoning (simulated)
  const qwords = new Set(words(q));
  const generic = ['describe', 'what', 'anything', 'everything', 'scene', 'list', 'summarize', 'summarise'].some(w => qwords.has(w));
  const relevance = o => words(o.tags + ' ' + o.label).filter(w => qwords.has(w)).length;
  const legible = o => !o.small || (eff === 'high' && Math.max(uw, uh) >= 1024 && !(m.weaker && o.id === 'labels'));
  const relevant = sc.objects.filter(o => relevance(o) > 0 || generic);
  const seen = relevant.filter(legible);
  const missed = relevant.filter(o => !legible(o));
  const seenIds = new Set(sc.objects.filter(legible).map(o => o.id));
  const infer = sc.inferences.filter(i => i.needs.every(id => seenIds.has(id)) && (generic || words(i.tags).some(w => qwords.has(w))));
  const missedHazards = sc.objects.filter(o => o.hazard && !legible(o) && (generic || relevance(o) > 0));
  steps.push(step('model', 'Model response', `${seen.length} relevant observation(s), ${infer.length} inference(s); ${missed.length} relevant detail(s) not legible at this resolution/detail.`, { observed: seen.map(o => o.id), inferred: infer.length, notLegible: missed.map(o => o.id) }, 'ok'));

  // 6. Answer review
  const lines = [];
  if (p.separate) {
    lines.push('Observed:', ...seen.map(o => `- ${o.fact}`));
    if (infer.length) lines.push('Inferred (not directly visible):', ...infer.map(i => `- ${i.text}`));
    if (missed.length) lines.push(`Not legible at this resolution: ${missed.map(o => o.label.replace(/".*"/, 'text')).join(', ')}. Send a higher-resolution image or detail="high" to check.`);
  } else {
    lines.push([...seen.map(o => o.fact), ...infer.map(i => i.text.replace(/ — .*$/, '.').replace(/likely /, '').replace(/appears to be /, 'is '))].join(' ') || 'Nothing notable.');
    if (missedHazards.length) lines.push('Everything else looks fine.');
  }
  const answer = lines.join('\n');
  const issues = [];
  if (missedHazards.length) issues.push(`${missedHazards.length} safety-relevant detail(s) missed (${missedHazards.map(o => o.label).join(', ')})`);
  if (!p.separate && infer.length) issues.push('inferences presented as facts (no observed/inferred separation)');
  if (!p.separate && missedHazards.length) issues.push('answer claims "everything else looks fine" without evidence');
  steps.push(step('answer', issues.length ? 'Answer needs review' : 'Answer grounded and complete', issues.length ? issues.join('; ') + '.' : 'Observations and inferences are separated; every relevant detail was legible.', { missedHazards: missedHazards.length, inferencesAsFacts: !p.separate && infer.length > 0 }, issues.length ? 'warn' : 'ok'));

  const boxes = [
    ...seen.map(o => ({ kind: 'box', x: o.x, y: o.y, w: o.w, h: o.h, label: o.label, tone: 'ok' })),
    ...missed.map(o => ({ kind: 'box', x: o.x, y: o.y, w: o.w, h: o.h, label: `${o.label} (missed)`, tone: o.hazard ? 'error' : 'warn', dashed: true })),
  ];
  return {
    steps,
    output: [
      sceneImg(boxes),
      { type: 'chat', title: 'Conversation', turns: [
        ...(p.separate ? [{ role: 'system', text: 'Describe only what is visible. Label each statement as Observed or Inferred. If a detail is too small or unclear, say so instead of guessing.' }] : []),
        { role: 'user', text: `${q}\n[${count} image(s): ${p.format.toUpperCase()} ${p.uploadRes}, detail=${p.detail}]` },
        { role: 'assistant', text: answer, meta: `~${estTokens(answer)} output tokens (est.)` },
      ] },
      { type: 'table', title: 'Statement audit (ground truth overlay for learning)', columns: ['Statement', 'Type', 'Evidence region'],
        rows: [...seen.map(o => [o.fact, 'observed', o.id]), ...infer.map(i => [i.text, 'inferred', i.needs.join(' + ')]), ...missed.map(o => [o.fact, 'MISSED', o.id])],
        tones: [...seen.map(() => 'ok'), ...infer.map(() => (p.separate ? 'info' : 'warn')), ...missed.map(o => (o.hazard ? 'error' : 'warn'))] },
      { type: 'code', lang: 'python', title: 'Request (illustrative)', text: `resp = client.chat.completions.create(\n    model="${p.model}",  # deployment name\n    messages=[${p.separate ? '\n        {"role": "system", "content": GROUNDING_RULES},' : ''}\n        {"role": "user", "content": [\n            {"type": "text", "text": ${JSON.stringify(q.slice(0, 60))}},\n            {"type": "image_url", "image_url": {"url": ${p.source === 'base64' ? '"data:image/' + p.format + ';base64,..."' : 'sas_url'}, "detail": "${p.detail}"}},\n        ]},\n    ])` },
    ],
    metrics: [
      metric('Image tokens', `~${imgTokens}`, 'estimate', 'Tile formula documented for GPT-4o-class vision (85 base + 170 per 512-px tile at high detail). Other models may count differently.'),
      metric('Relevant details missed', String(missed.length), 'computed'),
      metric('Hazards missed', String(missedHazards.length), 'computed'),
      metric('Inferences', `${infer.length}${p.separate ? ' (labelled)' : ' (unlabelled)'}`, 'computed'),
    ],
    summary: `${p.model} • ${p.uploadRes} detail=${p.detail}→${eff} • ~${imgTokens} img tokens • missed ${missed.length}`,
  };
}

export default {
  id: '3.2.1',
  lab: 'Visual context analyzer',
  services: [
    { name: 'Use vision-enabled chat models (Azure OpenAI)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/gpt-with-vision' },
    { name: 'Azure OpenAI quotas and limits', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits' },
  ],
  prereqs: ['1.1.1'],
  next: ['3.2.2', '3.2.3'],

  concept: {
    plain: 'A multimodal model can look at a picture and answer questions about it, like a colleague glancing at a photo. Two things decide how good the answer is: how much of the picture it really gets to see (a small, blurry copy hides small text and details) and whether it keeps "what I can see" apart from "what I am guessing". A good app sends a clear enough image and asks the model to say when it cannot tell.',
    technical: 'Vision-capable chat models in Foundry (for example gpt-4.1, gpt-4o) accept content arrays mixing text and image_url parts; the URL can be HTTPS (fetched by the service, so private Blob needs a SAS) or a base64 data URL. The detail setting (low/high/auto) controls how the image is processed: low uses a single low-resolution view at a flat token cost; high tiles a rescaled image into 512-px tiles, costing more tokens but resolving small text and objects. Supported formats and the number/size of images per request are limited per model. A system message should require separating observations from inferences and admitting uncertainty.',
    useCase: 'A logistics company posts CCTV stills from warehouse aisles to a Foundry deployment every minute and asks "Is anything unsafe?". Images are sent as SAS URLs at 1024 px with detail high so PPE and floor spills are legible; the answer lists Observed vs Inferred items and only Observed hazards raise an alert to supervisors.',
    terms: [
      ['image_url content part', 'Message part carrying an image as an HTTPS URL or base64 data URL, with an optional detail setting.'],
      ['detail', 'low / high / auto: trades image tokens for fidelity.'],
      ['Tile', '512x512 crop of the rescaled image processed at high detail; each adds a fixed token cost on GPT-4o-class models.'],
      ['Observed vs inferred', 'Directly visible facts vs conclusions drawn from them; keep them labelled.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'client', label: 'Question + image(s)', col: 0, row: 1, kind: 'user', detail: 'Text part plus one or more image parts.' },
          { id: 'fetch', label: 'Image access', col: 1, row: 0, kind: 'data', detail: 'URL fetched by the service or inline base64.', badge: p ? p.source : undefined },
          { id: 'tokens', label: p ? `Detail: ${p.detail}` : 'Detail level', col: 1, row: 2, kind: 'policy', detail: 'Decides resolution seen by the model and token cost.' },
          { id: 'model', label: 'Multimodal model', col: 2, row: 1, kind: 'ai', detail: 'Reads image + text together.', badge: p ? p.model : undefined },
          { id: 'answer', label: 'Observed / inferred', col: 3, row: 1, kind: 'data', detail: 'Answer separated into what is visible and what is concluded.' },
        ],
        edges: [['client', 'fetch'], ['client', 'tokens'], ['fetch', 'model'], ['tokens', 'model'], ['model', 'answer']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'client', label: 'Function (timer) + managed identity', col: 0, row: 1, kind: 'compute', detail: 'Creates SAS URLs and calls the chat deployment.' },
          { id: 'fetch', label: 'Blob Storage (CCTV stills)', col: 1, row: 0, kind: 'store', detail: 'Service must be able to read the URL (SAS) or receive base64.', badge: p && p.source === 'blob-private' ? 'no SAS' : undefined },
          { id: 'tokens', label: 'Image pre-processing', col: 1, row: 2, kind: 'compute', detail: 'Resize/convert format before sending.' },
          { id: 'model', label: `Foundry deployment: ${p ? p.model : 'gpt-4.1'}`, col: 2, row: 1, kind: 'ai', detail: 'Vision-capable chat model.' },
          { id: 'answer', label: 'Alerts (Service Bus → Teams)', col: 3, row: 1, kind: 'app', detail: 'Only observed hazards alert.' },
        ],
        edges: [['fetch', 'tokens'], ['tokens', 'client'], ['client', 'model', 'chat.completions'], ['model', 'answer']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'tokens', label: `img = resize(img, ${p ? p.uploadRes : '1024x768'}); convert to JPEG/PNG`, col: 0, row: 0, kind: 'code', detail: 'Do not downscale below the detail you need.' },
          { id: 'fetch', label: 'url = blob_sas_url(name, expiry=10min)  # or data:image/jpeg;base64,...', col: 0, row: 1, kind: 'code', detail: 'Private URLs are not fetchable by the service.' },
          { id: 'client', label: '{"type":"image_url","image_url":{"url":url,"detail":"high"}}', col: 0, row: 2, kind: 'code', detail: 'One part per image; respect per-request limits.' },
          { id: 'model', label: 'client.chat.completions.create(model=dep, messages=[system, user])', col: 0, row: 3, kind: 'code', detail: 'openai SDK against the Foundry endpoint (illustrative).' },
          { id: 'answer', label: 'parse Observed/Inferred; alert on Observed hazards only', col: 0, row: 4, kind: 'code', detail: 'Business rule.' },
        ],
        edges: [['tokens', 'fetch'], ['fetch', 'client'], ['client', 'model'], ['model', 'answer']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'scene', label: 'Image', type: 'select', options: Object.entries(SCENES).map(([v, s]) => [v, s.label]), default: 'warehouse' },
      { id: 'question', label: 'Question', type: 'textarea', default: 'Is anything in this scene unsafe? List what you see.' },
      { id: 'model', label: 'Model deployment', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-4.1' },
      { id: 'detail', label: 'detail', type: 'select', options: [['auto', 'auto'], ['low', 'low'], ['high', 'high']], default: 'auto' },
      { id: 'uploadRes', label: 'Resolution sent', type: 'select', options: [['512x384', '512x384 (downscaled by app)'], ['1024x768', '1024x768'], ['2048x1536', '2048x1536'], ['4000x3000', '4000x3000 (original)']], default: '512x384' },
      { id: 'source', label: 'Image source', type: 'select', options: [['blob-sas', 'Blob URL + read SAS'], ['blob-private', 'Private Blob URL (no SAS)'], ['public', 'Public HTTPS URL'], ['base64', 'Base64 data URL']], default: 'blob-sas' },
      { id: 'format', label: 'Format', type: 'select', options: Object.keys(FORMATS).map(f => [f, f.toUpperCase()]), default: 'jpeg' },
      { id: 'imageCount', label: 'Images in request', type: 'number', min: 1, max: 20, step: 1, default: 1 },
      { id: 'separate', label: 'System prompt: separate observed vs inferred', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Warehouse, downscaled (default)', values: {} },
      { label: 'Warehouse, 1024 px, high detail, grounded', values: { uploadRes: '1024x768', detail: 'high', separate: true } },
      { label: 'Dashcam crossing, low detail', values: { scene: 'street', detail: 'low', uploadRes: '2048x1536', question: 'Should the car stop? Describe the scene.' } },
      { label: 'Chart values', values: { scene: 'chart', question: 'What are the revenue values per region and is revenue growing?', uploadRes: '2048x1536', detail: 'high', separate: true } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the warehouse at 512x384 / auto and at 1024x768 / high: compare missed hazards and image tokens.',
      'Compare 2048x1536 vs 4000x3000 at high detail: tokens are the same because the service rescales anyway.',
      'Toggle observed/inferred separation on the dashcam frame and compare how inferences are worded.',
    ],
  },

  debug: [
    { id: 'private', title: 'Image URL rejected', values: { source: 'blob-private' }, node: 'fetch',
      symptom: 'HTTP 400 saying the image could not be downloaded.', cause: 'Permissions: the service cannot read a private Blob URL.', fix: 'Send a short-lived read-only SAS URL or a base64 data URL.' },
    { id: 'tiff', title: 'Scanner TIFFs fail', values: { format: 'tiff' }, node: 'fetch',
      symptom: 'HTTP 400 invalid image format.', cause: 'Invalid input: TIFF is not an accepted vision input.', fix: 'Convert to JPEG or PNG before sending.' },
    { id: 'count', title: 'Batch of camera frames rejected', values: { imageCount: 15 }, node: 'fetch',
      symptom: 'HTTP 400 too many images.', cause: 'The request exceeds the per-request image limit.', fix: 'Send ≤ 10 images per request (this simulation\'s limit; check your model\'s docs).' },
    { id: 'textmodel', title: 'Model ignores images', values: { model: 'gpt-35-turbo' }, node: 'model',
      symptom: 'HTTP 400: image content not supported.', cause: 'Unsuitable model: text-only deployment.', fix: 'Use a vision-capable deployment such as gpt-4.1 or gpt-4o.' },
    { id: 'missed', title: 'Hazards not reported', values: { uploadRes: '512x384', detail: 'auto' }, node: 'tokens',
      symptom: 'Answer misses the missing hard hat and the spill, and says everything else is fine.', cause: 'The app downscales to 512 px, so auto resolves to low detail and small details are not legible.', fix: 'Send ≥1024 px with detail high, and require the model to say when details are not legible.' },
  ],

  challenge: {
    task: 'Make the warehouse safety check report both small hazards (no hard hat, floor spill) with inferences clearly labelled, without errors or warnings.',
    condition: 'Scene = warehouse, 0 hazards missed, observed/inferred separation on, no warn/error step.',
    hint: 'Look at what auto detail resolves to for the resolution the app sends.',
    check: (p, res) => p.scene === 'warehouse' && p.separate && res.steps.some(s => s.node === 'answer' && s.status === 'ok' && s.data && s.data.missedHazards === 0) && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Resolution sent: 1024x768 (or larger).', 'detail: high (or auto, which now resolves to high).', 'Turn on the observed/inferred system prompt.', 'Keep a vision-capable model, a SAS URL and JPEG.'],
    solutionValues: { scene: 'warehouse', uploadRes: '1024x768', detail: 'high', separate: true, model: 'gpt-4.1', source: 'blob-sas', format: 'jpeg', imageCount: 1, question: 'Is anything in this scene unsafe? List what you see.' },
  },

  quiz: [
    { q: 'Your app sends private Blob URLs to a vision model and gets "image could not be retrieved". What is the fix?', options: ['Grant the model Storage Blob Data Reader', 'Send a short-lived SAS URL or a base64 data URL', 'Switch detail to low', 'Use a larger model'], answer: 1, why: 'The service fetches the URL itself; it needs a URL it can read (SAS) or inline bytes.' },
    { q: 'Small warning labels in photos are being missed. Images are resized to 512 px before sending with detail=auto. What should you change first?', options: ['Add more images per request', 'Send higher resolution (≥1024 px) with detail high', 'Lower temperature', 'Use gpt-35-turbo'], answer: 1, why: 'At 512 px auto resolves to low detail; small text needs more pixels and high detail.' },
    { q: 'A supervisor complains the model said "the forklift is speeding" from a single still image. Which mitigation is most appropriate?', options: ['Increase max_tokens', 'Instruct the model to separate observed facts from inferences and to state uncertainty', 'Use detail low', 'Send the image twice'], answer: 1, why: 'Motion and speed cannot be observed in a still; label inferences explicitly.' },
  ],

  recap: 'Send images as content parts the service can reach (SAS or base64) in a supported format and within per-request limits; choose detail and resolution for the smallest detail you must see (high = more tiles/tokens); and instruct the model to separate observations from inferences and to admit when details are not legible.',
};
