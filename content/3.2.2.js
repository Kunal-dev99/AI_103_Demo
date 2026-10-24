// 3.2.2 Configure apps to produce concise or detailed captions for single or multiple images
// Lab: Caption configurator.
import { round, step, metric, estTokens, coverage } from '../src/engine/util.js';

const IMAGES = [
  { id: 'beach', name: 'IMG_0412.jpg', tags: 'dog beach ball sand sea waves running',
    concise: 'A brown dog runs along a sandy beach with a red ball.',
    detailed: 'A brown dog sprints along wet sand at the water\'s edge with a red ball in its mouth. Small waves break behind it under a clear blue sky, and a trail of paw prints leads back toward the dunes.',
    dense: ['brown dog running', 'red ball in a dog\'s mouth', 'small waves on the sea', 'sandy beach', 'clear blue sky'],
    shapes: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#81d4fa' }, { kind: 'rect', x: 0, y: 34, w: 100, h: 10, fill: '#4fa3d1' }, { kind: 'rect', x: 0, y: 44, w: 100, h: 26, fill: '#e9d8a6' }, { kind: 'rect', x: 35, y: 46, w: 20, h: 9, fill: '#a0703c' }, { kind: 'circle', x: 57, y: 46, r: 4, fill: '#a0703c' }, { kind: 'circle', x: 61, y: 49, r: 2, fill: '#e53935' }] },
  { id: 'office', name: 'IMG_0413.jpg', tags: 'people meeting table laptops office whiteboard three',
    concise: 'Three people meet around a table with laptops.',
    detailed: 'Three colleagues sit around a light wooden table, two with open laptops, while one points at a whiteboard covered in a hand-drawn diagram. Coffee cups and sticky notes are scattered across the table.',
    dense: ['person pointing at a whiteboard', 'open laptop on a table', 'whiteboard with a diagram', 'coffee cup', 'wooden meeting table'],
    shapes: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#eceff1' }, { kind: 'rect', x: 60, y: 6, w: 34, h: 22, fill: '#ffffff' }, { kind: 'line', x: 64, y: 12, x2: 88, y2: 22, fill: '#1e88e5' }, { kind: 'rect', x: 15, y: 42, w: 60, h: 8, fill: '#bcaaa4' }, ...[22, 42, 62].map(x => ({ kind: 'circle', x, y: 32, r: 5, fill: '#f1c27d' })), { kind: 'rect', x: 20, y: 38, w: 10, h: 4, fill: '#455a64' }, { kind: 'rect', x: 40, y: 38, w: 10, h: 4, fill: '#455a64' }] },
  { id: 'cyclist', name: 'IMG_0414.jpg', tags: 'cyclist bicycle rain street raincoat wet yellow',
    concise: 'A cyclist in a yellow raincoat rides down a wet street.',
    detailed: 'A cyclist in a bright yellow raincoat rides through heavy rain on a narrow city street. Headlights reflect off the wet asphalt, and blurred shop signs glow in the background.',
    dense: ['cyclist in a yellow raincoat', 'bicycle wheel', 'wet street with reflections', 'rain streaks', 'lit shop sign'],
    shapes: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#78909c' }, { kind: 'rect', x: 0, y: 48, w: 100, h: 22, fill: '#455a64' }, { kind: 'rect', x: 44, y: 24, w: 10, h: 14, fill: '#fdd835' }, { kind: 'circle', x: 49, y: 21, r: 3, fill: '#f1c27d' }, { kind: 'circle', x: 42, y: 50, r: 6, fill: '#212121' }, { kind: 'circle', x: 58, y: 50, r: 6, fill: '#212121' }, ...[10, 30, 70, 85].map(x => ({ kind: 'line', x, y: 5, x2: x - 3, y2: 15, fill: '#cfd8dc' }))] },
  { id: 'pasta', name: 'IMG_0415.jpg', tags: 'plate pasta food tomato sauce basil table',
    concise: 'A plate of pasta with tomato sauce and basil.',
    detailed: 'A white plate of spaghetti in a bright tomato sauce, topped with fresh basil leaves and grated parmesan, sits on a rustic wooden table next to a fork and a glass of water.',
    dense: ['plate of spaghetti', 'basil leaves', 'tomato sauce', 'fork on a table', 'glass of water'],
    shapes: [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#8d6e63' }, { kind: 'circle', x: 50, y: 35, r: 24, fill: '#fafafa' }, { kind: 'circle', x: 50, y: 35, r: 15, fill: '#e64a19' }, { kind: 'circle', x: 46, y: 31, r: 3, fill: '#43a047' }, { kind: 'circle', x: 54, y: 36, r: 3, fill: '#43a047' }, { kind: 'rect', x: 80, y: 15, w: 3, h: 40, fill: '#bdbdbd' }] },
];
const MODELS = { 'gpt-4.1': { label: 'gpt-4.1', vision: true }, 'gpt-4o-mini': { label: 'gpt-4o-mini (cheaper)', vision: true }, 'gpt-35-turbo': { label: 'gpt-35-turbo (text only)', vision: false } };
const PER_ITEM_OVERHEAD = 12; // JSON keys/punctuation per caption (estimate)

function run(p) {
  const steps = [];
  const count = Math.max(1, Math.min(4, Math.round(p.count)));
  const imgs = IMAGES.slice(0, count);
  const tmpl = String(p.template || '');
  const maxTok = Math.max(1, Math.round(p.maxTokens));
  const gallery = (caps, tones) => imgs.map((im, i) => ({ type: 'image', title: `Image ${i + 1} (${im.name})${caps ? ' — ' + (caps[i] || '(no caption)').slice(0, 90) : ''}`, width: 100, height: 70, shapes: [...im.shapes, ...(tones && tones[i] === 'error' ? [{ kind: 'box', x: 2, y: 2, w: 96, h: 66, label: 'caption mismatch', tone: 'error', dashed: true }] : [])] }));
  const fail = (node, title, detail, data, summary) => { steps.push(step(node, title, detail, data, 'error')); return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, ...gallery(null)], metrics: [metric('Captions usable', '0/' + count, 'computed')], summary }; };

  steps.push(step('input', `${count} image(s) selected`, imgs.map(i => i.name).join(', '), { images: imgs.map(i => i.name) }));

  // ---------------- Azure AI Vision Image Analysis backend ----------------
  if (p.backend === 'vision') {
    if (p.visionRegion === 'unsupported') return fail('service', 'Feature not available in this region', 'Image Analysis caption / dense caption features are only offered in some Azure regions. Create the Vision resource in a supported region (see the region table in the docs).', { features: ['caption', 'denseCaptions'], region: 'unsupported' }, 'Vision: caption not available in region');
    const feature = p.length === 'detailed' ? 'denseCaptions' : 'caption';
    steps.push(step('prompt', 'No prompt template', 'Image Analysis is not prompt-driven: you choose features (caption / denseCaptions) and options such as gender-neutral captions. The template is ignored.', { features: [feature], genderNeutralCaption: p.genderNeutral }, 'skip'));
    steps.push(step('service', `${count} analyze call(s), feature=${feature}`, `One request per image (no multi-image request). ${feature === 'denseCaptions' ? 'Dense captions describe up to ~10 regions with short phrases and boxes — detailed, but not paragraph prose.' : 'One short caption per image with a confidence score.'}`, { calls: count, feature }, 'ok'));
    const caps = imgs.map(im => (feature === 'caption' ? im.concise.replace(/\.$/, '').replace(/^A /, 'a ').toLowerCase() : im.dense.join('; ')));
    const cons = imgs.map((im, i) => coverage(im.tags, caps[i]));
    steps.push(step('check', 'Consistency check', `Each caption shares ${round(Math.min(...cons) * 100, 0)}–${round(Math.max(...cons) * 100, 0)}% of the image's reference tags.`, { consistency: cons.map(c => round(c, 2)) }, 'ok'));
    return {
      steps,
      output: [
        ...gallery(caps),
        { type: 'table', title: `Image Analysis results (${feature})`, columns: ['Image', 'Caption', 'Confidence', 'Tag overlap'], rows: imgs.map((im, i) => [im.name, caps[i], feature === 'caption' ? (0.82 + i * 0.03).toFixed(2) : 'per region', `${round(cons[i] * 100, 0)}%`]) },
        { type: 'code', lang: 'python', title: 'Image Analysis 4.0 (illustrative)', text: `client = ImageAnalysisClient(endpoint, credential=DefaultAzureCredential())\nresult = client.analyze_from_url(image_url=sas_url,\n    visual_features=[VisualFeatures.${feature === 'caption' ? 'CAPTION' : 'DENSE_CAPTIONS'}],\n    gender_neutral_caption=${p.genderNeutral ? 'True' : 'False'})` },
      ],
      metrics: [metric('Requests', String(count), 'computed'), metric('Captions usable', `${count}/${count}`, 'computed'), metric('Mean tag overlap', `${round((cons.reduce((a, b) => a + b, 0) / count) * 100, 0)}%`, 'computed', 'Coverage of each image\'s reference tags by its caption (toy relevance check).')],
      summary: `Vision ${feature} • ${count} call(s)`,
    };
  }

  // ---------------- Multimodal chat backend ----------------
  if (!MODELS[p.model].vision) return fail('service', 'HTTP 400: model does not accept images', `${MODELS[p.model].label} is text-only. Use a vision-capable deployment.`, { model: p.model }, 'Rejected: text-only model');
  const lengthWired = /\{length\}/.test(tmpl);
  const asksJson = /json/i.test(tmpl);
  const renderedPrompt = tmpl.replace(/\{length\}/g, p.length === 'detailed' ? 'detailed (2–3 sentence)' : 'concise (one sentence, under 15 words)');
  const pIssues = [];
  if (!lengthWired) pIssues.push('template has no {length} placeholder, so the concise/detailed setting has no effect (the template wording decides)');
  if (p.format === 'json' && !asksJson) pIssues.push('app expects JSON but the template never asks for it');
  steps.push(step('prompt', pIssues.length ? 'Prompt template issues' : 'Prompt rendered', pIssues.length ? pIssues.join('; ') + '.' : renderedPrompt, { prompt: renderedPrompt, response_format: p.format === 'json' ? 'json (recommended: structured outputs / JSON schema)' : 'text' }, pIssues.length ? 'warn' : 'ok'));
  const effLength = lengthWired ? p.length : /detail|paragraph|sentences/i.test(tmpl) ? 'detailed' : 'concise';

  // Requests
  const multi = p.batching === 'multi' && count > 1;
  const groups = multi ? [imgs.map((_, i) => i)] : imgs.map((_, i) => [i]);
  steps.push(step('service', `${groups.length} request(s) to ${p.model}`, multi ? `All ${count} images in one request${p.labelImages ? ', each preceded by a text part "Image n:"' : ' with no per-image labels'}.` : 'One request per image: simpler mapping, more calls and repeated instructions.', { requests: groups.length, imagesPerRequest: groups[0].length, labelled: multi ? p.labelImages : 'n/a' }));

  // Generate captions (simulated)
  let caps = imgs.map(im => (effLength === 'detailed' ? im.detailed : im.concise));
  let swapped = false;
  if (multi && !p.labelImages && count >= 3) { [caps[1], caps[2]] = [caps[2], caps[1]]; swapped = true; }
  // Token budget and truncation, per request
  let truncated = 0, outTokens = 0;
  const finalCaps = caps.slice();
  groups.forEach(g => {
    let budget = maxTok;
    g.forEach(i => {
      const need = estTokens(caps[i]) + (p.format === 'json' ? PER_ITEM_OVERHEAD : 3);
      if (budget >= need) { budget -= need; outTokens += need; }
      else if (budget > 0) { const keep = Math.max(0, (budget - (p.format === 'json' ? PER_ITEM_OVERHEAD : 3)) * 4); finalCaps[i] = caps[i].slice(0, keep) + '…'; truncated++; outTokens += budget; budget = 0; }
      else { finalCaps[i] = ''; truncated++; }
    });
  });
  const jsonBroken = p.format === 'json' && (truncated > 0 || !asksJson);
  if (truncated) steps.push(step('service', 'finish_reason = "length"', `max_tokens=${maxTok} was too small: ${truncated} caption(s) cut off${p.format === 'json' ? ', leaving unterminated JSON' : ''}. Detailed captions for ${count} image(s) need roughly ${groups.length > 1 ? 'per request ' : ''}${Math.max(...groups.map(g => g.reduce((a, i) => a + estTokens(caps[i]) + (p.format === 'json' ? PER_ITEM_OVERHEAD : 3), 0)))} tokens (estimate).`, { max_tokens: maxTok, truncated }, p.format === 'json' ? 'error' : 'warn'));
  if (p.format === 'json' && !asksJson && !truncated) steps.push(step('parse', 'JSON parse failed', 'The model answered in prose because the template never asked for JSON. Ask for JSON explicitly (better: use structured outputs with a schema).', { raw: finalCaps[0].slice(0, 60) + '…' }, 'error'));
  else if (!jsonBroken) steps.push(step('parse', p.format === 'json' ? 'JSON parsed' : 'Text split per image', `${count - truncated} complete caption(s).`, { items: count - truncated }));

  // Consistency: caption ↔ image tags
  const cons = imgs.map((im, i) => coverage(im.tags, finalCaps[i]));
  const tones = cons.map((c, i) => (finalCaps[i] === '' ? 'error' : c < 0.25 ? 'error' : truncated && finalCaps[i].endsWith('…') ? 'warn' : 'ok'));
  const mismatches = tones.filter(t => t === 'error').length;
  steps.push(step('check', mismatches ? `${mismatches} caption(s) do not match their image` : 'Captions consistent with images', mismatches ? (swapped ? 'Captions for images 2 and 3 are swapped: with several unlabelled images in one request the model cannot reliably keep the order. Label each image (text part "Image n:") or caption one image per request.' : 'Some captions are empty or unrelated to their image.') : `Every caption shares ≥25% of its image's reference tags (toy check).`, { consistency: cons.map(c => round(c, 2)) }, mismatches ? 'warn' : 'ok'));

  const imgTok = count * 85;
  return {
    steps,
    output: [
      ...gallery(finalCaps, tones),
      { type: 'table', title: 'Captions per image', columns: ['Image', 'Caption', 'Words', 'Tag overlap'], rows: imgs.map((im, i) => [im.name, finalCaps[i] || '(missing)', String(finalCaps[i] ? finalCaps[i].split(/\s+/).length : 0), `${round(cons[i] * 100, 0)}%`]), tones },
      { type: 'chat', title: multi ? 'Single multi-image request' : 'First request (one per image)', turns: [
        { role: 'user', text: `${renderedPrompt}\n${(multi ? imgs : imgs.slice(0, 1)).map((im, i) => `${multi && p.labelImages ? `Image ${i + 1}: ` : ''}[image ${im.name}]`).join('\n')}` },
        { role: 'assistant', text: p.format === 'json' && asksJson ? JSON.stringify((multi ? finalCaps : finalCaps.slice(0, 1)).map((c, i) => ({ image: i + 1, caption: c }))).slice(0, truncated ? -6 : undefined) : (multi ? finalCaps : finalCaps.slice(0, 1)).join('\n'), meta: truncated ? 'finish_reason: length' : 'finish_reason: stop' },
      ] },
    ],
    metrics: [
      metric('Requests', String(groups.length), 'computed'),
      metric('Captions usable', `${count - truncated - (jsonBroken ? count - truncated : 0) - (mismatches && !truncated ? mismatches : 0)}/${count}`, 'computed', 'Complete, parseable and matched to the right image.'),
      metric('Output tokens', `~${outTokens}`, 'estimate', '4-characters-per-token heuristic plus ~12 tokens JSON overhead per item.'),
      metric('Image input tokens', `~${imgTok}${multi ? '' : ' (spread over requests)'}`, 'estimate', 'Assumes detail=low (85 tokens/image on GPT-4o-class models); captions rarely need high detail.'),
      metric('Instruction tokens', `~${estTokens(renderedPrompt) * groups.length}`, 'estimate', 'Prompt repeated once per request.'),
    ],
    summary: `${p.model} ${effLength} • ${count} img • ${groups.length} req • ${truncated ? truncated + ' truncated' : 'complete'}${mismatches ? ' • mismatched' : ''}`,
  };
}

export default {
  id: '3.2.2',
  lab: 'Caption configurator',
  services: [
    { name: 'Use vision-enabled chat models', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/gpt-with-vision' },
    { name: 'Image Analysis 4.0: captions and dense captions', url: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/concept-describe-images-40' },
    { name: 'Structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
  ],
  prereqs: ['3.2.1'],
  next: ['3.2.4', '3.2.3'],

  concept: {
    plain: 'A caption is a sentence that says what a picture shows. Sometimes you want a short one ("A dog on a beach"), sometimes a richer description. You can caption pictures one at a time, or send several together to save effort — but then you must tell the model which picture is which, leave enough room in the answer for all of them, and ask for a format your app can read back.',
    technical: 'Two options in Foundry: Azure AI Vision Image Analysis 4.0 (Foundry Tools) returns a caption or denseCaptions (region phrases with boxes) per image via visual features, with options such as gender-neutral captions and region-restricted availability; or a multimodal chat model (gpt-4.1, gpt-4o-mini) driven by a prompt template that sets length and output format. Multi-image chat requests should label each image with a text part and request JSON (ideally via structured outputs). max_tokens must cover all captions or the response ends with finish_reason "length" and broken JSON.',
    useCase: 'A photo-library app captions uploads in batches of four: concise captions for thumbnails come from one multi-image request with labelled images and a JSON schema; editors can request a detailed caption for a single image on demand.',
    terms: [
      ['caption / denseCaptions', 'Image Analysis features: one sentence per image vs short phrases per detected region.'],
      ['Prompt template', 'Reusable instruction with placeholders (for example {length}) filled by app settings.'],
      ['finish_reason "length"', 'The response hit max_tokens and was cut off.'],
      ['Image labelling', 'A text part such as "Image 2:" before each image so outputs map back reliably.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: p ? `${p.count} image(s)` : 'Images', col: 0, row: 1, kind: 'data', detail: 'Single image or a batch.' },
          { id: 'prompt', label: p && p.backend === 'vision' ? 'Features (no prompt)' : 'Prompt template', col: 1, row: 0, kind: 'policy', detail: 'Length, format and labelling rules.', badge: p ? p.length : undefined },
          { id: 'service', label: p && p.backend === 'vision' ? 'Image Analysis' : 'Multimodal model', col: 2, row: 1, kind: 'ai', detail: 'Generates captions.' },
          { id: 'parse', label: 'Parse output', col: 3, row: 0, kind: 'code', detail: 'JSON or text per image.', disabled: p && p.backend === 'vision' },
          { id: 'check', label: 'Consistency check', col: 3, row: 2, kind: 'policy', detail: 'Is each caption about the right image?' },
        ],
        edges: [['input', 'prompt'], ['input', 'service'], ['prompt', 'service'], ['service', 'parse'], ['parse', 'check'], ['service', 'check']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'Blob uploads + Event Grid', col: 0, row: 1, kind: 'store', detail: 'New images trigger captioning.' },
          { id: 'prompt', label: 'Function (batcher)', col: 1, row: 1, kind: 'compute', detail: 'Groups images, renders template, sets max_tokens.' },
          { id: 'service', label: p && p.backend === 'vision' ? 'Azure AI Vision (Image Analysis 4.0)' : `Foundry deployment: ${p ? p.model : 'gpt-4.1'}`, col: 2, row: 1, kind: 'ai', detail: 'Managed identity; region matters for Vision caption features.', badge: p && p.backend === 'vision' && p.visionRegion === 'unsupported' ? 'region!' : undefined },
          { id: 'parse', label: 'Validator', col: 3, row: 0, kind: 'compute', detail: 'JSON schema validation.' },
          { id: 'check', label: 'Cosmos DB (captions)', col: 3, row: 2, kind: 'store', detail: 'Stores captions keyed by image id.' },
        ],
        edges: [['input', 'prompt'], ['prompt', 'service'], ['service', 'parse'], ['parse', 'check']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'input', label: 'images = batch(blobs, size=4)', col: 0, row: 0, kind: 'code', detail: 'Choose batch size against token budget.' },
          { id: 'prompt', label: 'content = [text(TEMPLATE.format(length=...))] + [text(f"Image {i}:"), image_url(u)] ...', col: 0, row: 1, kind: 'code', detail: 'Label each image.' },
          { id: 'service', label: p && p.backend === 'vision' ? 'ImageAnalysisClient.analyze_from_url(url, [CAPTION])' : `chat.completions.create(model, messages, max_tokens=${p ? p.maxTokens : 300}, response_format=schema)`, col: 0, row: 2, kind: 'code', detail: 'Illustrative.' },
          { id: 'parse', label: 'if choice.finish_reason == "length": retry with more tokens/smaller batch', col: 0, row: 3, kind: 'code', detail: 'Never store truncated JSON.' },
          { id: 'check', label: 'assert len(items) == len(images); map by "image" index', col: 0, row: 4, kind: 'code', detail: 'Guard against mix-ups.' },
        ],
        edges: [['input', 'prompt'], ['prompt', 'service'], ['service', 'parse'], ['parse', 'check']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'backend', label: 'Captioning service', type: 'select', options: [['chat', 'Multimodal chat model'], ['vision', 'Azure AI Vision Image Analysis 4.0']], default: 'chat' },
      { id: 'model', label: 'Chat model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-4.1' },
      { id: 'length', label: 'Caption length', type: 'select', options: [['concise', 'Concise'], ['detailed', 'Detailed']], default: 'concise' },
      { id: 'count', label: 'Number of images', type: 'range', min: 1, max: 4, step: 1, default: 2 },
      { id: 'batching', label: 'Batching', type: 'select', options: [['per-image', 'One request per image'], ['multi', 'All images in one request']], default: 'multi' },
      { id: 'labelImages', label: 'Label each image ("Image n:")', type: 'toggle', default: false },
      { id: 'format', label: 'Expected output', type: 'select', options: [['json', 'JSON array'], ['text', 'Plain text']], default: 'json' },
      { id: 'template', label: 'Prompt template', type: 'textarea', default: 'Write a {length} caption for each image. Return JSON: [{"image": n, "caption": "..."}]' },
      { id: 'maxTokens', label: 'max_tokens', type: 'number', min: 20, max: 1000, step: 10, default: 200 },
      { id: 'genderNeutral', label: 'Gender-neutral caption (Vision)', type: 'toggle', default: true },
      { id: 'visionRegion', label: 'Vision resource region', type: 'select', options: [['supported', 'Region with caption features'], ['unsupported', 'Region without caption features']], default: 'supported' },
    ],
    samples: [
      { label: 'Two concise captions, one request', values: {} },
      { label: 'Four detailed, labelled, enough tokens', values: { count: 4, length: 'detailed', labelImages: true, maxTokens: 400 } },
      { label: 'One detailed caption per request', values: { count: 3, length: 'detailed', batching: 'per-image' } },
      { label: 'Vision dense captions', values: { backend: 'vision', length: 'detailed', count: 3 } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Caption 4 images concise vs detailed in one request and compare output tokens and truncation.',
      'Run 4 images in one request vs one per image: compare requests and instruction tokens.',
      'Compare Image Analysis caption with the chat model concise caption for the same images.',
    ],
  },

  debug: [
    { id: 'trunc', title: 'Last captions missing, JSON fails to parse', values: { count: 4, length: 'detailed', labelImages: true, maxTokens: 120 }, node: 'service',
      symptom: 'finish_reason "length"; JSON is unterminated.', cause: 'max_tokens too small for four detailed captions.', fix: 'Raise max_tokens (≈400) or caption in smaller batches.' },
    { id: 'swap', title: 'Captions attached to the wrong photos', values: { count: 4, labelImages: false, batching: 'multi' }, node: 'check',
      symptom: 'Image 2 shows a cyclist but its caption describes an office meeting.', cause: 'Unlabelled images in one multi-image request; order is not reliably preserved.', fix: 'Turn on "Image n:" labels (or caption one image per request).' },
    { id: 'nojson', title: 'App cannot parse the reply', values: { template: 'Describe each image in a {length} way.' }, node: 'parse',
      symptom: 'JSON parse error; reply is prose.', cause: 'Malformed data: the template never asks for JSON.', fix: 'Ask for JSON in the template (better: structured outputs with a schema).' },
    { id: 'nolength', title: 'Detailed setting does nothing', values: { length: 'detailed', template: 'Write a one-sentence caption for each image. Return JSON: [{"image": n, "caption": "..."}]' }, node: 'prompt',
      symptom: 'Captions stay one sentence.', cause: 'Template has no {length} placeholder, so the setting is never applied.', fix: 'Put {length} back into the template.' },
    { id: 'region', title: 'Vision caption call fails', values: { backend: 'vision', visionRegion: 'unsupported' }, node: 'service',
      symptom: 'Feature not supported in this region.', cause: 'Wrong configuration: caption features are region-restricted.', fix: 'Use a Vision resource in a supported region, or the chat model.' },
    { id: 'textonly', title: 'Text-only model', values: { model: 'gpt-35-turbo' }, node: 'service',
      symptom: 'HTTP 400: image input not supported.', cause: 'Unsuitable model.', fix: 'Pick gpt-4.1 or gpt-4o-mini.' },
  ],

  challenge: {
    task: 'Produce detailed captions for all four images in a single request, as valid JSON, with every caption matched to the right image and no warnings.',
    condition: 'Chat backend, 4 images, detailed, multi-image batching, JSON, no warn/error step.',
    hint: 'Three things break multi-image batches: order, budget and format.',
    check: (p, res) => p.backend === 'chat' && Math.round(p.count) === 4 && p.length === 'detailed' && p.batching === 'multi' && p.format === 'json' && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Count 4, length detailed, batching: all images in one request.', 'Turn on "Image n:" labels.', 'Raise max_tokens to about 400.', 'Keep the template with {length} and an explicit JSON instruction.'],
    solutionValues: { backend: 'chat', model: 'gpt-4.1', count: 4, length: 'detailed', batching: 'multi', labelImages: true, format: 'json', maxTokens: 400, template: 'Write a {length} caption for each image. Return JSON: [{"image": n, "caption": "..."}]' },
  },

  quiz: [
    { q: 'Captioning 8 photos per request sometimes returns captions under the wrong file names. Which change fixes it most directly?', options: ['Lower temperature', 'Add a text part "Image n:" before each image and return the index in the JSON', 'Use detail high', 'Increase max_tokens'], answer: 1, why: 'Explicit labels let the model and your parser map outputs to inputs.' },
    { q: 'Detailed captions for a batch stop mid-sentence and JSON parsing fails. finish_reason is "length". What do you do?', options: ['Retry the same request', 'Raise max_tokens or reduce batch size, and treat "length" as a failure', 'Switch to plain text', 'Remove the system prompt'], answer: 1, why: 'The output budget was exhausted; give it room or split the work.' },
    { q: 'You need short captions with a confidence score and no prompt engineering, and region restrictions are acceptable. Which option fits?', options: ['Image Analysis 4.0 caption feature', 'A text-only chat model', 'Content Safety', 'Document Intelligence'], answer: 0, why: 'Image Analysis returns a caption with confidence via a visual feature; no prompt needed.' },
  ],

  recap: 'Choose Image Analysis (caption/denseCaptions, feature-driven, region-restricted) or a multimodal chat model (template-driven). For chat: wire length into the template, ask for JSON (ideally a schema), label each image in multi-image requests, budget max_tokens for all captions, and verify each caption maps to its image.',
};
