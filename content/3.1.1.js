// 3.1.1 Implement a solution that generates images from text prompts and reference media
// Lab: Image generation studio.
import { rng, clamp, round, step, metric, estTokens, words } from '../src/engine/util.js';

// ---------------------------------------------------------------------------------------------
// Prompt vocabulary. The "generator" in this lab is a deterministic toy: it parses the prompt into
// subjects, colours, style, lighting and composition, then composes shapes on a canvas so the
// learner can SEE which prompt elements were honoured. It is not a real diffusion model.
// ---------------------------------------------------------------------------------------------
const SUBJECTS = {
  fox: { kind: 'animal', color: '#d9622b' }, cat: { kind: 'animal', color: '#8a8a8a' }, dog: { kind: 'animal', color: '#a0703c' },
  tree: { kind: 'tree', color: '#2e7d32' }, pine: { kind: 'pine', color: '#1b5e20' }, house: { kind: 'house', color: '#c9a27e' },
  mountain: { kind: 'mountain', color: '#6d7b8d' }, mountains: { kind: 'mountain', color: '#6d7b8d' }, sun: { kind: 'sun', color: '#ffd23f' },
  moon: { kind: 'moon', color: '#f1f1d0' }, boat: { kind: 'boat', color: '#8d5524' }, bottle: { kind: 'bottle', color: '#3a7bd5' },
  cup: { kind: 'cup', color: '#e0e0e0' }, mug: { kind: 'cup', color: '#e0e0e0' }, person: { kind: 'person', color: '#3f51b5' },
  woman: { kind: 'person', color: '#8e24aa' }, man: { kind: 'person', color: '#3f51b5' }, bicycle: { kind: 'bicycle', color: '#c62828' },
  car: { kind: 'car', color: '#1565c0' },
};
const COLORS = { red: '#d32f2f', blue: '#1e88e5', green: '#43a047', yellow: '#fdd835', purple: '#8e24aa', orange: '#fb8c00', black: '#212121', white: '#fafafa', pink: '#ec407a', teal: '#00897b' };
const STYLES = { watercolor: 'watercolor', watercolour: 'watercolor', photo: 'photo', photorealistic: 'photo', realistic: 'photo', pixel: 'pixel', sketch: 'sketch', pencil: 'sketch', flat: 'flat', vector: 'flat', oil: 'oil', cartoon: 'flat' };
const LIGHTING = { sunset: 'sunset', dusk: 'sunset', night: 'night', midnight: 'night', day: 'day', noon: 'day', morning: 'day', snow: 'snow', winter: 'snow' };
const BLOCKED = ['gore', 'blood', 'bloody', 'nude', 'naked', 'weapon', 'gun', 'bomb', 'violent', 'corpse'];

const MODELS = {
  'gpt-image-1': { label: 'gpt-image-1 family (Azure OpenAI in Foundry)', image: true, sizes: ['1024x1024', '1536x1024', '1024x1536', 'auto'], qualities: ['low', 'medium', 'high', 'auto'], maxN: 10, reference: true, revised: false, response: 'b64_json' },
  'dall-e-3': { label: 'DALL-E 3 (legacy, check retirement dates)', image: true, sizes: ['1024x1024', '1792x1024', '1024x1792'], qualities: ['standard', 'hd'], maxN: 1, reference: false, revised: true, response: 'url or b64_json' },
  flux: { label: 'FLUX (Black Forest Labs, Foundry partner model)', image: true, sizes: ['1024x1024', '1536x1024', '1024x1536'], qualities: [], maxN: 1, reference: true, revised: false, response: 'b64_json (check model card)' },
  'gpt-4o': { label: 'gpt-4o (chat model, not an image generator)', image: false, sizes: [], qualities: [], maxN: 0, reference: false, revised: false, response: 'n/a' },
};

const REFERENCES = {
  none: { label: 'No reference image' },
  product: { label: 'Product photo (teal Contoso bottle)', subject: 'bottle', color: '#0f8b8d', text: 'CONTOSO' },
  styleboard: { label: 'Brand style board (palette)', palette: ['#0f8b8d', '#f2c14e', '#f78154', '#4d9078'] },
};

const CANVAS = { '1024x1024': [70, 70], '1536x1024': [100, 66], '1024x1536': [66, 100], '1792x1024': [100, 57], '1024x1792': [57, 100], auto: [100, 66] };

// ---------------------------------------------------------------------------------------------
function parsePrompt(prompt) {
  const ws = words(prompt);
  const subjects = [];
  ws.forEach((w, i) => {
    if (SUBJECTS[w] && !subjects.some(s => s.word === w)) {
      const prev = ws[i - 1];
      subjects.push({ word: w, ...SUBJECTS[w], color: COLORS[prev] || SUBJECTS[w].color, colorWord: COLORS[prev] ? prev : null });
    }
  });
  const style = ws.map(w => STYLES[w]).find(Boolean) || null;
  const lighting = ws.map(w => LIGHTING[w]).find(Boolean) || null;
  const text = ' ' + ws.join(' ') + ' ';
  const composition = /close ?up|closeup/.test(text) ? 'close-up' : /wide|panorama|landscape shot/.test(text) ? 'wide' : / left /.test(text) ? 'left' : / right /.test(text) ? 'right' : null;
  const blocked = ws.filter(w => BLOCKED.includes(w));
  const beach = ws.some(w => ['beach', 'sea', 'ocean', 'coast'].includes(w));
  return { subjects, style, lighting, composition, blocked, beach };
}

function rewritePrompt(prompt, parsed) {
  const add = [];
  if (!parsed.style) add.push('soft photorealistic style');
  if (!parsed.lighting) add.push('natural daylight');
  if (!parsed.composition) add.push('centered composition, subject fully in frame');
  return add.length ? `${prompt.trim().replace(/\.$/, '')}, ${add.join(', ')}.` : prompt;
}

const lighten = (hex, k) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
};
const grey = hex => {
  const n = parseInt(hex.slice(1), 16);
  const g = Math.round(((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11));
  return '#' + g.toString(16).padStart(2, '0').repeat(3);
};

// Draw one subject. (x, gy) = horizontal centre and ground line. s = scale unit.
function drawSubject(sub, x, gy, s, detail, label) {
  const c = sub.color, out = [];
  switch (sub.kind) {
    case 'animal':
      out.push({ kind: 'rect', x: x - s * 1.2, y: gy - s * 1.1, w: s * 2.2, h: s * 1.1, fill: c });
      out.push({ kind: 'circle', x: x + s * 1.2, y: gy - s * 1.4, r: s * 0.6, fill: c });
      if (detail) out.push({ kind: 'circle', x: x + s * 1.4, y: gy - s * 1.5, r: s * 0.12, fill: '#111111' }, { kind: 'line', x: x - s * 1.2, y: gy - s * 0.9, x2: x - s * 2, y2: gy - s * 1.5, fill: c });
      break;
    case 'tree': case 'pine':
      out.push({ kind: 'rect', x: x - s * 0.25, y: gy - s * 1.6, w: s * 0.5, h: s * 1.6, fill: '#6d4c41' });
      if (sub.kind === 'pine') for (let i = 0; i < 3; i++) out.push({ kind: 'rect', x: x - s * (1.4 - i * 0.4), y: gy - s * (2.2 + i * 1.1), w: s * (2.8 - i * 0.8), h: s * 1.1, fill: c });
      else out.push({ kind: 'circle', x, y: gy - s * 2.6, r: s * 1.4, fill: c });
      break;
    case 'house':
      out.push({ kind: 'rect', x: x - s * 1.6, y: gy - s * 2, w: s * 3.2, h: s * 2, fill: c }, { kind: 'rect', x: x - s * 1.9, y: gy - s * 2.7, w: s * 3.8, h: s * 0.7, fill: '#8d3b2f' });
      if (detail) out.push({ kind: 'rect', x: x - s * 0.3, y: gy - s * 1.1, w: s * 0.6, h: s * 1.1, fill: '#4e342e' }, { kind: 'rect', x: x + s * 0.6, y: gy - s * 1.6, w: s * 0.6, h: s * 0.5, fill: '#bbdefb' });
      break;
    case 'mountain':
      out.push({ kind: 'circle', x, y: gy + s * 1.5, r: s * 4.5, fill: c });
      if (detail) out.push({ kind: 'circle', x, y: gy - s * 2.5, r: s * 0.9, fill: '#ffffff' });
      break;
    case 'sun': case 'moon':
      out.push({ kind: 'circle', x, y: s * 2.2, r: s * 1.1, fill: c });
      break;
    case 'boat':
      out.push({ kind: 'rect', x: x - s * 1.6, y: gy - s * 0.7, w: s * 3.2, h: s * 0.7, fill: c }, { kind: 'line', x, y: gy - s * 0.7, x2: x, y2: gy - s * 3, fill: '#5d4037' }, { kind: 'rect', x: x + s * 0.1, y: gy - s * 2.9, w: s * 1.1, h: s * 1.9, fill: '#fafafa' });
      break;
    case 'bottle':
      out.push({ kind: 'rect', x: x - s * 0.6, y: gy - s * 2.6, w: s * 1.2, h: s * 2.6, fill: c }, { kind: 'rect', x: x - s * 0.25, y: gy - s * 3.3, w: s * 0.5, h: s * 0.7, fill: c });
      if (detail || sub.text) out.push({ kind: 'rect', x: x - s * 0.6, y: gy - s * 1.8, w: s * 1.2, h: s * 0.7, fill: '#ffffff' });
      if (sub.text) out.push({ kind: 'text', x: x - s * 0.55, y: gy - s * 1.3, text: sub.text, fill: '#0b3c3d' });
      break;
    case 'cup':
      out.push({ kind: 'rect', x: x - s * 0.7, y: gy - s * 1.3, w: s * 1.4, h: s * 1.3, fill: c }, { kind: 'circle', x: x + s * 0.9, y: gy - s * 0.7, r: s * 0.35, fill: c });
      break;
    case 'person':
      out.push({ kind: 'rect', x: x - s * 0.5, y: gy - s * 2.4, w: s, h: s * 1.6, fill: c }, { kind: 'circle', x, y: gy - s * 2.8, r: s * 0.45, fill: '#f1c27d' }, { kind: 'rect', x: x - s * 0.45, y: gy - s * 0.8, w: s * 0.9, h: s * 0.8, fill: '#37474f' });
      break;
    case 'bicycle':
      out.push({ kind: 'circle', x: x - s, y: gy - s * 0.6, r: s * 0.6, fill: '#263238' }, { kind: 'circle', x: x + s, y: gy - s * 0.6, r: s * 0.6, fill: '#263238' }, { kind: 'line', x: x - s, y: gy - s * 0.6, x2: x + s, y2: gy - s * 0.6, fill: c }, { kind: 'line', x: x - s * 0.2, y: gy - s * 1.5, x2: x + s, y2: gy - s * 0.6, fill: c });
      break;
    case 'car':
      out.push({ kind: 'rect', x: x - s * 1.8, y: gy - s * 1.3, w: s * 3.6, h: s * 0.9, fill: c }, { kind: 'rect', x: x - s, y: gy - s * 2, w: s * 2, h: s * 0.7, fill: lighten(c, 0.3) }, { kind: 'circle', x: x - s * 1.1, y: gy - s * 0.4, r: s * 0.4, fill: '#212121' }, { kind: 'circle', x: x + s * 1.1, y: gy - s * 0.4, r: s * 0.4, fill: '#212121' });
      break;
    default: break;
  }
  if (label) out.push({ kind: 'text', x: x - s, y: gy + s * 0.9, text: label, fill: '#333333' });
  return out;
}

// Compose a full synthetic image from parsed prompt elements.
function composeScene(parsed, opts) {
  const { W, H, seed, quality, palette, refSubject } = opts;
  const r = rng(seed);
  const detail = quality === 'high' || quality === 'hd' || quality === 'medium';
  const light = parsed.lighting || 'day';
  const sky = { day: '#a8d8f0', sunset: '#f4a261', night: '#1d2340', snow: '#cfd8dc' }[light];
  const ground = light === 'snow' ? '#f5f5f5' : parsed.beach ? '#e9d8a6' : light === 'night' ? '#2e3b2c' : '#7cb26a';
  const gy = H * 0.78;
  let shapes = [{ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: sky }];
  if (light === 'sunset') shapes.push({ kind: 'rect', x: 0, y: gy - H * 0.12, w: W, h: H * 0.12, fill: '#e76f51' });
  if (light === 'night' && detail) for (let i = 0; i < 6; i++) shapes.push({ kind: 'circle', x: r() * W, y: r() * H * 0.4, r: 0.6, fill: '#ffffff' });
  let subs = parsed.subjects.slice();
  if (refSubject && !subs.some(s => s.kind === refSubject.kind)) subs.push(refSubject);
  else if (refSubject) subs = subs.map(s => (s.kind === refSubject.kind ? { ...s, color: refSubject.color, text: refSubject.text } : s));
  const back = subs.filter(s => s.kind === 'mountain'), sky2 = subs.filter(s => s.kind === 'sun' || s.kind === 'moon');
  const front = subs.filter(s => !back.includes(s) && !sky2.includes(s));
  const base = Math.min(W, H) / 14;
  const scale = parsed.composition === 'close-up' ? base * 1.7 : parsed.composition === 'wide' ? base * 0.75 : base;
  back.forEach((s, i) => shapes.push(...drawSubject(s, W * (0.3 + 0.4 * i) + (r() - 0.5) * 6, gy, base * 1.1, detail)));
  shapes.push({ kind: 'rect', x: 0, y: gy, w: W, h: H - gy, fill: ground });
  if (parsed.beach) shapes.push({ kind: 'rect', x: 0, y: gy - H * 0.06, w: W, h: H * 0.06, fill: '#4fa3d1' });
  sky2.forEach(s => shapes.push(...drawSubject(s, W * 0.82, gy, base, detail)));
  const shift = parsed.composition === 'left' ? -0.22 : parsed.composition === 'right' ? 0.22 : 0;
  front.forEach((s, i) => {
    const slot = front.length === 1 ? 0.5 : 0.18 + (0.64 * i) / (front.length - 1);
    const x = clamp(W * (slot + (i === 0 ? shift : 0)) + (r() - 0.5) * 5, base * 2, W - base * 2);
    shapes.push(...drawSubject(s, x, gy + (r() - 0.5) * 2, scale * (0.85 + r() * 0.3), detail));
  });
  const style = parsed.style || 'photo';
  shapes = shapes.map(sh => {
    let fill = sh.fill;
    if (palette && fill && sh.kind !== 'text' && sh !== shapes[0]) fill = palette[Math.floor(r() * palette.length)];
    if (fill && style === 'watercolor') fill = lighten(fill, 0.35);
    if (fill && style === 'sketch') fill = lighten(grey(fill), 0.4);
    if (style === 'pixel' && sh.kind === 'circle') return { kind: 'rect', x: Math.round(sh.x - sh.r), y: Math.round(sh.y - sh.r), w: Math.round(sh.r * 2), h: Math.round(sh.r * 2), fill };
    return { ...sh, fill };
  });
  if (!detail) shapes = shapes.filter(sh => sh.kind !== 'line' || r() > 0.5);
  return shapes;
}

// ---------------------------------------------------------------------------------------------
function run(p) {
  const steps = [];
  const model = MODELS[p.model];
  const ref = REFERENCES[p.reference];
  const prompt = String(p.prompt || '');
  const parsed = parsePrompt(prompt);
  const fail = (node, title, detail, data, summary, extra = []) => {
    steps.push(step(node, title, detail, data, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: title + ': ' + detail }, ...extra], metrics: [metric('Images returned', '0', 'computed')], summary };
  };

  // 1. Auth
  if (p.auth === 'entra-norole') return fail('client', 'HTTP 401/403 PermissionDenied', 'The managed identity authenticated with Microsoft Entra ID but has no data-plane role on the Foundry resource. Assign "Cognitive Services OpenAI User" (or "Azure AI User" at project scope) and retry.', { auth: 'DefaultAzureCredential', scope: 'https://cognitiveservices.azure.com/.default', role: null }, 'Blocked: identity lacks data-plane role');
  if (p.auth === 'key-disabled') return fail('client', 'HTTP 403 key auth disabled', 'The request used an API key but local (key) authentication is disabled on the resource (disableLocalAuth). Switch to Microsoft Entra ID with DefaultAzureCredential.', { auth: 'api-key', disableLocalAuth: true }, 'Blocked: key auth disabled');
  steps.push(step('client', 'Client authenticated', 'Keyless auth: DefaultAzureCredential gets a token for the Cognitive Services scope; the identity holds "Cognitive Services OpenAI User".', { auth: 'Microsoft Entra ID', deployment: p.model }));

  // 2. Prompt parsing
  if (!prompt.trim()) return fail('prompt', 'Empty prompt', 'The prompt is required. Describe subject, style, lighting and composition.', { prompt }, 'Rejected: empty prompt');
  steps.push(step('prompt', 'Prompt analysed', `${parsed.subjects.length} subject(s) recognised; style: ${parsed.style || '—'}; lighting: ${parsed.lighting || '—'}; composition: ${parsed.composition || '—'}. (This lab parses a small vocabulary so you can see which elements land in the image.)`,
    { subjects: parsed.subjects.map(s => (s.colorWord ? s.colorWord + ' ' : '') + s.word), style: parsed.style, lighting: parsed.lighting, composition: parsed.composition, promptTokens: estTokens(prompt) },
    parsed.subjects.length ? 'ok' : 'warn'));

  // 3. Prompt rewriting
  let finalPrompt = prompt;
  if (p.rewrite) {
    finalPrompt = rewritePrompt(prompt, parsed);
    steps.push(step('rewrite', 'App-side prompt rewrite', finalPrompt === prompt ? 'Prompt already specifies style, lighting and composition; unchanged.' : 'A chat model expanded missing elements (style, lighting, composition). Log both versions so results stay explainable.', { original: prompt, rewritten: finalPrompt }, 'info'));
  } else {
    steps.push(step('rewrite', 'No app-side rewrite', model.revised ? 'DALL-E 3 still rewrites prompts service-side and returns revised_prompt in the response.' : 'Prompt sent as written.', null, 'skip'));
  }
  const usedParsed = parsePrompt(finalPrompt);

  // 4. Parameter validation
  if (!model.image) return fail('params', 'Unsuitable model', `${model.label} cannot produce images through the Images API. Deploy an image model (for example a gpt-image-1 family model) and call images.generate.`, { model: p.model, operation: 'images.generate', error: 'OperationNotSupported (illustrative)' }, 'Rejected: chat model used for image generation');
  if (!model.sizes.includes(p.size)) return fail('params', 'HTTP 400 invalid size', `size=${p.size} is not supported by ${model.label}. Supported in this lab: ${model.sizes.join(', ')}.`, { size: p.size, allowed: model.sizes }, 'Rejected: invalid size');
  if (model.qualities.length && !model.qualities.includes(p.quality)) return fail('params', 'HTTP 400 invalid quality', `quality=${p.quality} is not valid for ${model.label}. Valid: ${model.qualities.join(', ')}.`, { quality: p.quality, allowed: model.qualities }, 'Rejected: invalid quality');
  if (p.n > model.maxN) return fail('params', 'HTTP 400 invalid n', `${model.label} returns at most ${model.maxN} image(s) per request in this lab. Lower n or issue parallel requests.`, { n: p.n, max: model.maxN }, 'Rejected: n too large');
  if (p.reference !== 'none' && !model.reference) return fail('params', 'Reference image not supported', `${model.label} only accepts text. Use a model that accepts input images (gpt-image-1 family via images.edit, or an image-conditioned FLUX variant).`, { reference: p.reference, model: p.model }, 'Rejected: model takes no reference media');
  const paramWarn = [];
  if (p.reference !== 'none' && p.api === 'generate') paramWarn.push('Reference image is not sent: images.generate is text-only. Use images.edit (image=[...]) to condition on reference media.');
  if (!model.qualities.length && p.quality !== 'medium') paramWarn.push(`quality is not a parameter for ${model.label}; it is ignored.`);
  steps.push(step('params', paramWarn.length ? 'Parameters accepted with warnings' : 'Parameters valid', paramWarn.length ? paramWarn.join(' ') : `size=${p.size}, quality=${model.qualities.length ? p.quality : 'n/a'}, n=${p.n}, output_format=${p.format}, endpoint=images.${p.api}.`,
    { model: p.model, size: p.size, quality: p.quality, n: p.n, output_format: p.format, endpoint: p.api, reference: p.reference }, paramWarn.length ? 'warn' : 'ok'));
  const refUsed = p.reference !== 'none' && p.api === 'edit';

  // 5. Input content filter
  if (usedParsed.blocked.length) return fail('safety', 'HTTP 400 content filtered', `The prompt was blocked by the deployment's content filter (terms such as "${usedParsed.blocked.join('", "')}"). Error codes vary by model and API version (for example content_policy_violation / moderation_blocked); always handle them explicitly.`, { innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: { violence: { filtered: true, severity: 'medium' } } } }, 'Blocked by input content filter');
  steps.push(step('safety', 'Prompt passed content filter', 'Azure content filtering ran on the prompt (and on any reference image) before generation.', { filtered: false }));

  // 6. Generation
  const [W, H] = CANVAS[p.size];
  const n = Math.max(1, Math.round(p.n));
  const images = [];
  const refSubject = refUsed && ref.subject ? { word: ref.subject, ...SUBJECTS[ref.subject], color: ref.color, text: ref.text } : null;
  const palette = refUsed && ref.palette ? ref.palette : null;
  for (let i = 0; i < n; i++) images.push(composeScene(usedParsed, { W, H, seed: `${finalPrompt}|${p.model}|${p.size}|${i}|${p.reference}|${p.api}`, quality: p.quality, palette, refSubject }));
  steps.push(step('model', `Generated ${n} image(s)`, `${model.label} returned ${n} image(s) as ${model.response}. Each variation differs because sampling is random${p.model === 'gpt-image-1' ? '; this API exposes no seed, so you cannot reproduce an exact image' : ''}.`,
    { created: 1761300000, data: images.map((_, i) => ({ index: i, [model.response.startsWith('url') ? 'url' : 'b64_json']: '<…>', ...(model.revised ? { revised_prompt: finalPrompt } : {}) })) }));

  // 7. Persist
  if (p.storage === 'blob-norole') {
    steps.push(step('store', 'Blob upload failed (403 AuthorizationPermissionMismatch)', 'Images were generated but the app identity lacks "Storage Blob Data Contributor" on the output container, so nothing was saved. You paid for the generation and lost the result.', { container: 'generated-images', role: null }, 'error'));
  } else {
    steps.push(step('store', 'Saved to Blob Storage', `Decoded ${n} image(s) and wrote ${p.format.toUpperCase()} files with prompt, model and parameters as metadata for traceability.`, { container: 'generated-images', files: images.map((_, i) => `img-${i}.${p.format}`), metadata: { prompt: finalPrompt, model: p.model } }));
  }

  // Coverage check: which recognised subjects actually appear?
  const wanted = parsed.subjects.map(s => s.word);
  const output = images.slice(0, 4).map((shapes, i) => ({ type: 'image', title: `Variation ${i + 1} — ${p.size}${refUsed ? ' • conditioned on ' + ref.label.toLowerCase() : ''}`, width: W, height: H, shapes }));
  output.push({ type: 'table', title: 'Prompt elements → image', columns: ['Element', 'Value', 'Rendered?'],
    rows: [
      ...parsed.subjects.map(s => ['Subject', (s.colorWord ? s.colorWord + ' ' : '') + s.word, 'yes']),
      ['Style', usedParsed.style || '(default)', usedParsed.style ? 'yes' : 'model default'],
      ['Lighting', usedParsed.lighting || '(default)', usedParsed.lighting ? 'yes' : 'model default'],
      ['Composition', usedParsed.composition || '(default)', usedParsed.composition ? 'yes' : 'model default'],
      ['Reference', ref.label, refUsed ? 'yes' : p.reference === 'none' ? '—' : 'NO (wrong endpoint)'],
    ],
    tones: [...parsed.subjects.map(() => 'ok'), usedParsed.style ? 'ok' : 'info', usedParsed.lighting ? 'ok' : 'info', usedParsed.composition ? 'ok' : 'info', refUsed || p.reference === 'none' ? 'ok' : 'warn'] });
  if (p.rewrite && finalPrompt !== prompt) output.push({ type: 'diff', title: 'Prompt rewrite', before: prompt, after: finalPrompt });
  output.push({ type: 'code', lang: 'python', title: 'Equivalent call (illustrative; check the current API version)', text: p.api === 'edit'
    ? `result = client.images.edit(\n    model="${p.model}",            # your deployment name\n    image=[open("reference.png", "rb")],\n    prompt=${JSON.stringify(finalPrompt)},\n    size="${p.size}", n=${n})\npng = base64.b64decode(result.data[0].b64_json)`
    : `result = client.images.generate(\n    model="${p.model}",            # your deployment name\n    prompt=${JSON.stringify(finalPrompt)},\n    size="${p.size}",${model.qualities.length ? ` quality="${p.quality}",` : ''} n=${n}${p.model === 'gpt-image-1' ? `, output_format="${p.format}"` : ''})\nimg = result.data[0]` });
  if (hasStoreError(steps)) output.unshift({ type: 'alert', tone: 'error', text: 'Generation succeeded but the downstream save failed. Fix storage RBAC before retrying to avoid paying twice.' });

  const area = { '1024x1024': 1, '1536x1024': 1.5, '1024x1536': 1.5, '1792x1024': 1.75, '1024x1792': 1.75, auto: 1.5 }[p.size];
  const qf = { low: 0.4, medium: 1, high: 2.5, standard: 1, hd: 2, auto: 1 }[p.quality] || 1;
  return {
    steps, output,
    metrics: [
      metric('Prompt specificity', `${[wanted.length > 0, usedParsed.style, usedParsed.lighting, usedParsed.composition].filter(Boolean).length}/4 element types`, 'computed', 'Subject, style, lighting and composition explicitly specified (after any rewrite). Unspecified ones fall back to model defaults.'),
      metric('Images returned', String(n), 'computed'),
      metric('Prompt tokens', `~${estTokens(finalPrompt)}`, 'estimate', '4-characters-per-token heuristic, not a tokenizer.'),
      metric('Relative generation cost', `${round(area * (model.qualities.length ? qf : 1) * n, 1)}× baseline`, 'estimate', 'Baseline = one 1024x1024 medium image. Image models bill by quality/size (often as image output tokens); see the pricing page for real numbers.'),
    ],
    summary: `${p.model} • ${p.size} • n=${n} • ${parsed.subjects.length} subjects${refUsed ? ' • ref used' : ''}${steps.some(s => s.status === 'warn') ? ' • warnings' : ''}`,
  };
}
const hasStoreError = steps => steps.some(s => s.node === 'store' && s.status === 'error');

export default {
  id: '3.1.1',
  lab: 'Image generation studio',
  services: [
    { name: 'Azure OpenAI image generation (how-to)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e' },
    { name: 'Foundry Models: models sold directly by Azure', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-sold-directly-by-azure' },
    { name: 'Content filtering in Azure OpenAI', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter' },
  ],
  prereqs: ['1.1.1'],
  next: ['3.1.3', '3.1.5', '3.1.2'],

  concept: {
    plain: 'An image model turns a written description into a picture. The more clearly the prompt names the subject, its colour, the style, the lighting and the framing, the more predictable the picture. You can also hand the model a reference picture, such as a product photo or a brand palette, so the result keeps that look. Every request is checked for unsafe content before anything is drawn.',
    technical: 'In Microsoft Foundry you deploy an image model (gpt-image-1 family via Azure OpenAI, DALL-E 3 as legacy, or partner models such as FLUX) and call the Images API: images.generate for text-to-image, images.edit when you pass input images as reference media. Key parameters are size, quality, n and (model-dependent) output_format. gpt-image-1 returns base64 image data; DALL-E 3 returns a URL or base64 plus a service-side revised_prompt. Requests pass through the deployment\'s content filter and fail with an HTTP 400 when blocked. Authenticate with Microsoft Entra ID (Cognitive Services OpenAI User role) and persist results with prompt metadata.',
    useCase: 'A retailer\'s marketing app lets designers type a scene ("teal Contoso bottle on a beach at sunset, flat vector style") and uploads the packshot as a reference so the generated banners keep the real product colours. Outputs are stored in Blob Storage with the prompt and parameters for audit, and filtered prompts are surfaced to the user with a clear message.',
    terms: [
      ['images.generate', 'Text-to-image call: prompt plus size, quality, n. No input images.'],
      ['images.edit / reference media', 'Call that accepts one or more input images that condition the result (style, product, layout); with a mask it becomes inpainting (3.1.3).'],
      ['revised_prompt', 'The rewritten prompt DALL-E 3 actually used; returned in the response.'],
      ['Content filter', 'Azure safety classifiers applied to prompt and output; a blocked request returns HTTP 400 with filter details.'],
      ['b64_json', 'Base64-encoded image bytes in the response; decode and store them yourself.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'client', label: 'Designer app', col: 0, row: 1, kind: 'user', detail: 'Collects the prompt, optional reference image and options.' },
          { id: 'prompt', label: 'Prompt elements', col: 1, row: 0, kind: 'data', detail: 'Subject, colour, style, lighting, composition. Missing elements fall back to model defaults.', substeps: ['Subjects', 'Attributes', 'Style', 'Lighting', 'Framing'] },
          { id: 'rewrite', label: 'Prompt rewrite', col: 1, row: 2, kind: 'ai', disabled: p && !p.rewrite, detail: 'Optional chat-model step that fills gaps in short prompts.' },
          { id: 'params', label: `Options: ${p ? `${p.size} • n=${p.n}` : 'size/quality/n'}`, col: 2, row: 0, kind: 'policy', detail: 'Validated against what the chosen model supports.' },
          { id: 'safety', label: 'Content filter', col: 2, row: 2, kind: 'policy', detail: 'Blocks disallowed prompts and outputs.' },
          { id: 'model', label: p && p.reference !== 'none' ? 'Image model + reference' : 'Image model', col: 3, row: 1, kind: 'ai', detail: 'Generates n variations.', badge: p ? p.model : undefined },
          { id: 'store', label: 'Saved images', col: 4, row: 1, kind: 'store', detail: 'Decoded files plus metadata.' },
        ],
        edges: [['client', 'prompt'], ['prompt', 'rewrite'], ['rewrite', 'params'], ['prompt', 'params'], ['params', 'safety'], ['safety', 'model'], ['model', 'store']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'client', label: 'App (Container Apps) + managed identity', col: 0, row: 1, kind: 'app', detail: 'Uses DefaultAzureCredential; identity needs Cognitive Services OpenAI User on the Foundry resource.', props: { auth: p ? p.auth : 'entra-ok' } },
          { id: 'prompt', label: 'Reference upload (Blob)', col: 1, row: 0, kind: 'store', disabled: p && p.reference === 'none', detail: 'Reference images read by the app and sent as multipart input to images.edit.' },
          { id: 'rewrite', label: 'Chat deployment (rewrite)', col: 1, row: 2, kind: 'ai', disabled: p && !p.rewrite, detail: 'Optional second deployment used to expand prompts.' },
          { id: 'params', label: `Foundry resource: deployment ${p ? p.model : ''}`, col: 2, row: 1, kind: 'ai', detail: 'Images API endpoint on the Foundry (Azure OpenAI) resource.' },
          { id: 'safety', label: 'Content filter config', col: 2, row: 2.5, kind: 'policy', detail: 'Configured per deployment in Foundry (Guardrails + controls).' },
          { id: 'model', label: 'Image model', col: 3, row: 1, kind: 'ai', detail: 'gpt-image-1 family / DALL-E 3 / FLUX (partner).' },
          { id: 'store', label: 'Blob Storage (generated-images)', col: 4, row: 1, kind: 'store', detail: 'Identity needs Storage Blob Data Contributor.', badge: p && p.storage === 'blob-norole' ? 'no RBAC' : undefined },
        ],
        edges: [['client', 'prompt'], ['client', 'rewrite'], ['client', 'params', 'images API'], ['params', 'safety'], ['params', 'model'], ['client', 'store', 'upload']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'client', label: 'client = AzureOpenAI(azure_endpoint, azure_ad_token_provider=tp, api_version)', col: 0, row: 0, kind: 'code', detail: 'tp = get_bearer_token_provider(DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default").' },
          { id: 'prompt', label: 'prompt = build_prompt(subject, style, lighting, framing)', col: 0, row: 1, kind: 'code', detail: 'Template the elements so prompts are consistent.' },
          { id: 'rewrite', label: 'prompt = rewrite(prompt)  # optional chat call', col: 0, row: 2, kind: 'code', disabled: p && !p.rewrite, detail: 'Log original and rewritten prompt.' },
          { id: 'params', label: p && p.api === 'edit' ? 'client.images.edit(model=dep, image=[ref], prompt=..., size, n)' : 'client.images.generate(model=dep, prompt=..., size, quality, n)', col: 0, row: 3, kind: 'code', detail: 'Exact parameters depend on model and API version (illustrative).' },
          { id: 'safety', label: 'except BadRequestError as e: if content filter → tell user', col: 0, row: 4, kind: 'code', detail: 'Inspect the error body for content_filter_result.' },
          { id: 'model', label: 'data = result.data  # b64_json / url', col: 0, row: 5, kind: 'code', detail: 'One entry per image.' },
          { id: 'store', label: 'blob.upload_blob(base64.b64decode(d.b64_json), metadata=...)', col: 0, row: 6, kind: 'code', detail: 'Persist with prompt + params.' },
        ],
        edges: [['client', 'prompt'], ['prompt', 'rewrite'], ['rewrite', 'params'], ['params', 'safety'], ['safety', 'model'], ['model', 'store']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'prompt', label: 'Prompt', type: 'textarea', default: 'A red fox sitting under a tall pine tree at sunset, watercolor style, wide shot', help: 'Try subjects: fox, cat, dog, tree, pine, house, mountain, sun, moon, boat, bottle, cup, person, bicycle, car. Styles: watercolor, photo, pixel, sketch, flat. Lighting: sunset, night, day, snow. Framing: close-up, wide, left, right.' },
      { id: 'model', label: 'Deployment model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-image-1' },
      { id: 'api', label: 'Endpoint', type: 'select', options: [['generate', 'images.generate (text only)'], ['edit', 'images.edit (with reference images)']], default: 'generate' },
      { id: 'reference', label: 'Reference media', type: 'select', options: Object.entries(REFERENCES).map(([v, r]) => [v, r.label]), default: 'none' },
      { id: 'size', label: 'Size', type: 'select', options: [['1024x1024', '1024x1024 (square)'], ['1536x1024', '1536x1024 (landscape)'], ['1024x1536', '1024x1536 (portrait)'], ['1792x1024', '1792x1024 (DALL-E 3 wide)'], ['1024x1792', '1024x1792 (DALL-E 3 tall)'], ['auto', 'auto']], default: '1536x1024' },
      { id: 'quality', label: 'Quality', type: 'select', options: [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['standard', 'standard (DALL-E 3)'], ['hd', 'hd (DALL-E 3)']], default: 'medium' },
      { id: 'n', label: 'Number of images (n)', type: 'range', min: 1, max: 4, step: 1, default: 1 },
      { id: 'format', label: 'Output format', type: 'select', options: [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']], default: 'png' },
      { id: 'rewrite', label: 'App-side prompt rewrite', type: 'toggle', default: false },
      { id: 'auth', label: 'Identity / auth', type: 'select', options: [['entra-ok', 'Entra ID + Cognitive Services OpenAI User'], ['entra-norole', 'Entra ID, no data-plane role'], ['key-disabled', 'API key (local auth disabled)']], default: 'entra-ok' },
      { id: 'storage', label: 'Output storage', type: 'select', options: [['blob-ok', 'Blob (Storage Blob Data Contributor)'], ['blob-norole', 'Blob (role missing)']], default: 'blob-ok' },
    ],
    samples: [
      { label: 'Fox at sunset, watercolor', values: { prompt: 'A red fox sitting under a tall pine tree at sunset, watercolor style, wide shot' } },
      { label: 'Product banner with reference', values: { prompt: 'A bottle on a beach next to a boat at sunset, flat vector style', api: 'edit', reference: 'product', size: '1536x1024', n: 2 } },
      { label: 'Short prompt + rewrite', values: { prompt: 'a cat and a house', rewrite: true, n: 2 } },
      { label: 'DALL-E 3 wide', values: { model: 'dall-e-3', size: '1792x1024', quality: 'hd', prompt: 'A blue car near a house and mountains at night, photo' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the product banner sample with endpoint images.generate, then images.edit, and compare whether the teal CONTOSO bottle appears.',
      'Run "a cat and a house" with rewrite off and on: compare the elements table and how much of the look is left to model defaults.',
      'Compare quality low vs high at n=4 and read the relative cost estimate.',
    ],
  },

  debug: [
    { id: 'filter', title: 'Prompt rejected with HTTP 400', values: { prompt: 'A violent scene with blood and a weapon at night' }, node: 'safety',
      symptom: 'No images; error mentions content filtering.', cause: 'The prompt triggered the deployment\'s content filter.', fix: 'Rewrite the prompt without disallowed content (for example "A fox in a pine forest at night") and show users a clear message when a filter fires.' },
    { id: 'role', title: '403 on the first call', values: { auth: 'entra-norole' }, node: 'client',
      symptom: 'PermissionDenied before any generation.', cause: 'The identity authenticates but holds no data-plane role on the Foundry resource.', fix: 'Assign Cognitive Services OpenAI User (set Identity to the role-assigned option).' },
    { id: 'chatmodel', title: 'Deployment cannot generate images', values: { model: 'gpt-4o' }, node: 'params',
      symptom: 'Operation not supported on this deployment.', cause: 'A chat model was deployed instead of an image model.', fix: 'Deploy and target a gpt-image-1 family (or other image) model.' },
    { id: 'dalle-n', title: 'DALL-E 3 rejects the request', values: { model: 'dall-e-3', size: '1536x1024', quality: 'high', n: 3 }, node: 'params',
      symptom: 'HTTP 400 invalid size.', cause: 'DALL-E 3 has different size and quality values than gpt-image-1 and returns one image per request.', fix: 'Use 1024x1024/1792x1024/1024x1792, quality standard/hd, n=1 — or switch the model to gpt-image-1.' },
    { id: 'ref-ignored', title: 'Product colours ignored', values: { prompt: 'A bottle on a beach at sunset, flat vector style', reference: 'product', api: 'generate' }, node: 'params',
      symptom: 'Generic blue bottle instead of the teal CONTOSO product.', cause: 'images.generate is text-only; the reference image was never sent.', fix: 'Use the images.edit endpoint and pass the reference image.' },
    { id: 'storage', title: 'Images generated but missing in storage', values: { storage: 'blob-norole' }, node: 'store',
      symptom: 'Generation step succeeds, upload fails with 403.', cause: 'Downstream integration: the app identity lacks Storage Blob Data Contributor.', fix: 'Grant the role on the container (set Output storage to the role-assigned option).' },
  ],

  challenge: {
    task: 'Produce two landscape marketing images that keep the real product (the teal CONTOSO bottle from the reference photo) on a beach at sunset, with no warnings or errors.',
    condition: 'Reference = product photo and actually used, n ≥ 2, a landscape size, prompt mentions bottle and sunset, run has no warn/error step.',
    hint: 'Which endpoint actually sends reference media? Which models accept it?',
    check: (p, res) => p.reference === 'product' && p.api === 'edit' && p.n >= 2 && ['1536x1024', '1792x1024'].includes(p.size) && /bottle/i.test(p.prompt) && /sunset/i.test(p.prompt) && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Model: gpt-image-1 family (DALL-E 3 cannot take reference images).', 'Endpoint: images.edit, Reference: product photo.', 'Size 1536x1024, n = 2.', 'Prompt: "A bottle on a beach next to a boat at sunset, flat vector style".'],
    solutionValues: { model: 'gpt-image-1', api: 'edit', reference: 'product', size: '1536x1024', n: 2, quality: 'medium', prompt: 'A bottle on a beach next to a boat at sunset, flat vector style', auth: 'entra-ok', storage: 'blob-ok' },
  },

  quiz: [
    { q: 'Your app must generate banners that keep the exact colours of an uploaded product photo. Which call fits best?', options: ['images.generate with the product described in words', 'images.edit (or another image-conditioned call) passing the product photo as input image', 'A chat completion with the photo attached', 'DALL-E 3 with quality hd'], answer: 1, why: 'Reference media must be sent as input images; generate is text-only and DALL-E 3 does not accept input images.' },
    { q: 'A user\'s prompt returns HTTP 400 with content_filter_result details. What should the app do?', options: ['Retry the same prompt until it passes', 'Disable the content filter for the deployment', 'Show a clear message and let the user rephrase; log the filter category', 'Switch to a different region'], answer: 2, why: 'Filtered requests are deterministic policy decisions. Surface them and allow rephrasing; do not retry blindly or remove safety controls.' },
    { q: 'Short user prompts produce inconsistent images. Which change gives the most control while staying auditable?', options: ['Raise n to 10', 'Add an app-side rewrite step that fills in style, lighting and framing, and log both prompts', 'Use quality low', 'Lower the content filter severity'], answer: 1, why: 'Structured prompt templating/rewriting fills missing elements; logging keeps results explainable.' },
    { q: 'Your container app calls the image deployment with DefaultAzureCredential and gets 403 PermissionDenied. What is missing?', options: ['An API key in the header', 'A data-plane role such as Cognitive Services OpenAI User for the managed identity', 'A larger quota', 'Storage Blob Data Reader'], answer: 1, why: 'Entra ID authentication succeeded, but authorisation needs a data-plane role on the resource.' },
  ],

  recap: 'Name subject, attributes, style, lighting and framing in the prompt; send reference media through an image-conditioned call (images.edit) on a model that supports it; validate size/quality/n per model; handle content-filter 400s explicitly; authenticate with Entra ID and persist outputs with their prompts.',
};
