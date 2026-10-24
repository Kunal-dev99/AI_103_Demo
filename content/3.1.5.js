// 3.1.5 Select and apply appropriate generation and editing controls provided by the platform
// Lab: Generation controls bench.
import { rng, round, step, metric } from '../src/engine/util.js';

// Support matrix used by this lab. 'yes' = documented parameter, 'no' = not a parameter (sending it is
// rejected or ignored), 'varies' = depends on the specific model version / provider: check the model card.
// This is a teaching summary at the time of writing, not an authoritative API reference.
const SUPPORT = {
  quality: { 'gpt-image-1': 'yes', 'dall-e-3': 'yes', flux: 'no' },
  size: { 'gpt-image-1': 'yes', 'dall-e-3': 'yes', flux: 'varies' },
  n: { 'gpt-image-1': 'yes', 'dall-e-3': 'no', flux: 'varies' },
  background: { 'gpt-image-1': 'yes', 'dall-e-3': 'no', flux: 'no' },
  output_format: { 'gpt-image-1': 'yes', 'dall-e-3': 'no', flux: 'varies' },
  output_compression: { 'gpt-image-1': 'yes', 'dall-e-3': 'no', flux: 'no' },
  style: { 'gpt-image-1': 'no', 'dall-e-3': 'yes', flux: 'no' },
  seed: { 'gpt-image-1': 'no', 'dall-e-3': 'no', flux: 'varies' },
  moderation: { 'gpt-image-1': 'varies', 'dall-e-3': 'no', flux: 'varies' },
};
const VALUES = {
  'gpt-image-1': { quality: ['auto', 'low', 'medium', 'high'], size: ['1024x1024', '1536x1024', '1024x1536', 'auto'], maxN: 10 },
  'dall-e-3': { quality: ['standard', 'hd'], size: ['1024x1024', '1792x1024', '1024x1792'], maxN: 1 },
  flux: { quality: [], size: ['1024x1024', '1536x1024', '1024x1536'], maxN: 1 },
};
const MODEL_LABEL = { 'gpt-image-1': 'gpt-image-1 family', 'dall-e-3': 'DALL-E 3 (legacy)', flux: 'FLUX (partner model)' };

const GOALS = {
  sticker: { label: 'Transparent product sticker for the web shop', subject: 'bottle',
    req: [['Transparent background', p => p.background === 'transparent'], ['PNG or WebP (alpha-capable)', p => ['png', 'webp'].includes(p.format)]] },
  hero: { label: 'Wide website hero image', subject: 'landscape',
    req: [['Landscape size', p => ['1536x1024', '1792x1024'].includes(p.size)], ['High quality', p => ['high', 'hd'].includes(p.quality)]] },
  thumbs: { label: 'Many cheap draft thumbnails', subject: 'cup',
    req: [['Low quality (fast/cheap)', p => p.quality === 'low'], ['n ≥ 4 in one call', p => p.n >= 4], ['JPEG/WebP compressed ≤ 80', p => ['jpeg', 'webp'].includes(p.format) && p.compression <= 80]] },
  print: { label: 'Print-ready poster', subject: 'tree',
    req: [['High quality', p => ['high', 'hd'].includes(p.quality)], ['Lossless PNG', p => p.format === 'png'], ['No compression', p => p.compression === 100]] },
};

function scene(goal, p, seedKey) {
  const r = rng(seedKey);
  const [w, h] = (p.size === 'auto' ? '1536x1024' : p.size).split('x').map(Number);
  const W = w >= h ? 100 : round((70 * w) / h, 0), H = w >= h ? round((100 * h) / w, 0) : 70;
  const vivid = p.style === 'vivid', natural = p.style === 'natural';
  const detail = ['high', 'hd', 'medium', 'auto', 'standard'].includes(p.quality) ? (['high', 'hd'].includes(p.quality) ? 2 : 1) : 0;
  const sat = c => (natural ? c.muted : vivid ? c.vivid : c.base);
  const shapes = [];
  const transparent = p.background === 'transparent' && p.model === 'gpt-image-1' && ['png', 'webp'].includes(p.format);
  if (transparent) for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 7) shapes.push({ kind: 'rect', x, y, w: 7, h: 7, fill: ((x + y) / 7) % 2 ? '#e0e0e0' : '#ffffff' });
  else shapes.push({ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: GOALS[goal].subject === 'landscape' ? '#a8d8f0' : '#f3e9d2' });
  const jx = (r() - 0.5) * W * 0.3, jy = (r() - 0.5) * H * 0.1;
  const cx = W / 2 + jx, cy = H / 2 + jy;
  const s = Math.min(W, H) / 10;
  const subj = GOALS[goal].subject;
  if (subj === 'bottle') {
    const c = sat({ base: '#0f8b8d', vivid: '#00c2c7', muted: '#4a7f80' });
    shapes.push({ kind: 'rect', x: cx - s, y: cy - s * 2.5, w: s * 2, h: s * 5, fill: c }, { kind: 'rect', x: cx - s * 0.4, y: cy - s * 3.4, w: s * 0.8, h: s, fill: c });
    if (detail) shapes.push({ kind: 'rect', x: cx - s, y: cy - s * 0.5, w: s * 2, h: s * 1.4, fill: '#ffffff' }, { kind: 'text', x: cx - s * 0.9, y: cy + s * 0.4, text: 'CONTOSO', fill: '#0b3c3d' });
    if (detail > 1) shapes.push({ kind: 'rect', x: cx - s * 0.8, y: cy - s * 2.3, w: s * 0.3, h: s * 3.5, fill: '#ffffff' });
  } else if (subj === 'landscape') {
    shapes.push({ kind: 'circle', x: cx - s * 2, y: H * 0.85, r: s * 4.5, fill: sat({ base: '#6d7b8d', vivid: '#5c6bc0', muted: '#8a9099' }) });
    shapes.push({ kind: 'rect', x: 0, y: H * 0.75, w: W, h: H * 0.25, fill: sat({ base: '#7cb26a', vivid: '#4caf50', muted: '#9bab8f' }) });
    shapes.push({ kind: 'rect', x: cx + s, y: H * 0.75 - s * 2, w: s * 3, h: s * 2, fill: '#c9a27e' }, { kind: 'rect', x: cx + s * 0.7, y: H * 0.75 - s * 2.6, w: s * 3.6, h: s * 0.6, fill: '#8d3b2f' });
    if (detail) shapes.push({ kind: 'circle', x: W * 0.85, y: H * 0.18, r: s * 0.9, fill: '#ffd23f' });
    if (detail > 1) shapes.push({ kind: 'circle', x: cx - s * 2, y: H * 0.85 - s * 3.6, r: s, fill: '#ffffff' });
  } else if (subj === 'cup') {
    const c = sat({ base: '#d32f2f', vivid: '#ff1744', muted: '#a35b5b' });
    shapes.push({ kind: 'rect', x: cx - s * 1.5, y: cy - s * 1.5, w: s * 3, h: s * 3, fill: c }, { kind: 'circle', x: cx + s * 2, y: cy, r: s * 0.8, fill: c });
    if (detail) shapes.push({ kind: 'rect', x: cx - s * 1.5, y: cy - s * 1.5, w: s * 3, h: s * 0.4, fill: '#5d4037' });
  } else {
    shapes.push({ kind: 'rect', x: cx - s * 0.4, y: cy, w: s * 0.8, h: s * 3, fill: '#6d4c41' }, { kind: 'circle', x: cx, y: cy - s, r: s * 2.4, fill: sat({ base: '#2e7d32', vivid: '#00c853', muted: '#5f7f60' }) });
    if (detail) for (let i = 0; i < 3 * detail; i++) shapes.push({ kind: 'circle', x: cx + (r() - 0.5) * s * 3, y: cy - s + (r() - 0.5) * s * 3, r: s * 0.3, fill: '#e53935' });
  }
  // Lossy compression artefacts (simulation): blocky patches when JPEG/WebP compression is aggressive.
  const lossy = p.model === 'gpt-image-1' && ['jpeg', 'webp'].includes(p.format) && p.compression < 60;
  if (lossy) for (let i = 0; i < Math.round((60 - p.compression) / 8); i++) shapes.push({ kind: 'rect', x: cx + (r() - 0.5) * s * 4, y: cy + (r() - 0.5) * s * 4, w: s * 0.8, h: s * 0.8, fill: '#9e9e9e' });
  return { shapes, W, H };
}

function run(p) {
  const steps = [];
  const m = p.model;
  const vals = VALUES[m];
  const n = Math.round(p.n);
  const rows = [], tones = [];
  let applied = 0, ignored = 0, rejected = 0;
  const judge = (ctl, yourValue, isDefault, check) => {
    let res = 'applied', tone = 'ok', note = '';
    if (isDefault) { res = 'not set (default)'; tone = 'muted'; }
    else {
      const out = check();
      res = out[0]; note = out[1] || '';
      tone = res === 'applied' ? 'ok' : res === 'rejected' ? 'error' : res === 'ignored' ? 'warn' : 'info';
    }
    if (res === 'applied') applied++; else if (res === 'ignored') ignored++; else if (res === 'rejected') rejected++;
    rows.push([ctl, String(yourValue), SUPPORT[ctl]['gpt-image-1'], SUPPORT[ctl]['dall-e-3'], SUPPORT[ctl].flux, res + (note ? ` — ${note}` : '')]);
    tones.push(tone);
    return res;
  };

  judge('quality', p.quality, false, () => (!vals.quality.length ? ['ignored', 'no quality knob; describe detail in the prompt'] : vals.quality.includes(p.quality) ? ['applied'] : ['rejected', `valid: ${vals.quality.join('/')}`]));
  judge('size', p.size, false, () => (vals.size.includes(p.size) ? ['applied'] : ['rejected', `valid here: ${vals.size.join(', ')}`]));
  judge('n', n, n === 1, () => (n <= vals.maxN ? ['applied'] : m === 'flux' ? ['ignored', 'one image per call in this lab; issue parallel calls'] : ['rejected', `max ${vals.maxN}`]));
  judge('background', p.background, p.background === 'auto', () => (m !== 'gpt-image-1' ? (m === 'dall-e-3' ? ['rejected', 'unknown parameter'] : ['ignored', 'not a parameter']) : p.background === 'transparent' && p.format === 'jpeg' ? ['rejected', 'transparency needs png or webp'] : ['applied']));
  judge('output_format', p.format, p.format === 'png', () => (m === 'gpt-image-1' ? ['applied'] : m === 'flux' ? ['info', 'check model card'] : ['ignored', 'DALL-E 3 returns PNG (url or b64_json)']));
  judge('output_compression', p.compression, p.compression === 100, () => (m === 'dall-e-3' ? ['rejected', 'unknown parameter'] : m === 'flux' ? ['ignored', 'not a parameter'] : p.format === 'png' ? ['ignored', 'only applies to jpeg/webp'] : ['applied']));
  judge('style', p.style, p.style === 'none', () => (m === 'dall-e-3' ? ['applied'] : ['ignored', 'put style words in the prompt instead']));
  judge('seed', p.seed, Number(p.seed) === 0, () => (m === 'flux' ? ['applied', 'reproducible if the endpoint honours it — verify'] : ['ignored', 'no seed parameter; outputs are not reproducible']));
  judge('moderation', p.moderation, p.moderation === 'auto', () => (m === 'gpt-image-1' ? ['info', 'where supported; Azure content filters on the deployment still apply'] : ['ignored', 'not a parameter']));

  steps.push(step('model', `Target: ${MODEL_LABEL[m]}`, 'Each model exposes a different set of controls. The matrix shows support per model (yes / no / varies — check the model card).', { model: m, allowed: vals }));
  const rejectedRows = rows.filter((_, i) => tones[i] === 'error');
  const ignoredRows = rows.filter((_, i) => tones[i] === 'warn');
  if (rejectedRows.length) {
    steps.push(step('controls', `HTTP 400: ${rejectedRows.length} invalid control(s)`, rejectedRows.map(r => `${r[0]}=${r[1]}: ${r[5].replace(/^rejected — /, '')}`).join('; ') + '.', { rejected: rejectedRows.map(r => r[0]) }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'The request is rejected before generation. Remove or fix the listed controls.' }, { type: 'table', title: 'Control support and outcome', columns: ['Control', 'Your value', 'gpt-image-1', 'DALL-E 3', 'FLUX', 'Outcome on selected model'], rows, tones }], metrics: [metric('Controls rejected', String(rejected), 'computed')], summary: `${m}: rejected (${rejectedRows.map(r => r[0]).join(', ')})` };
  }
  steps.push(step('controls', ignoredRows.length ? `${ignoredRows.length} control(s) have no effect` : 'All set controls applied', ignoredRows.length ? ignoredRows.map(r => `${r[0]}: ${r[5].replace(/^ignored — /, '')}`).join('; ') + '. Silent no-ops are a common source of "why didn\'t my setting work?" bugs.' : `${applied} control(s) applied.`, { applied, ignored }, ignoredRows.length ? 'warn' : 'ok'));

  // Generate baseline vs configured
  const base = { model: m, quality: vals.quality.includes('medium') ? 'medium' : vals.quality[0] || 'medium', size: '1024x1024', background: 'auto', format: 'png', compression: 100, style: 'none' };
  const seedApplied = m === 'flux' && Number(p.seed) !== 0;
  const imgs = [scene(p.goal, base, `${p.goal}|base`)];
  for (let i = 0; i < Math.min(2, m === 'flux' ? 1 : n); i++) imgs.push(scene(p.goal, p, seedApplied ? `${p.goal}|seed${p.seed}` : `${p.goal}|${m}|${p.quality}|${p.size}|${i}`));
  if (seedApplied && n === 1) imgs.push(scene(p.goal, p, `${p.goal}|seed${p.seed}`));
  steps.push(step('generate', 'Generated baseline and configured outputs', seedApplied ? 'Seed applied: repeated runs reproduce the same composition (shown twice).' : 'Without a seed, each variation differs (compare composition across variations).', { baseline: base, configured: { quality: p.quality, size: p.size, n, background: p.background, format: p.format, compression: p.compression, style: p.style } }, 'ok'));

  // Goal fit
  const goal = GOALS[p.goal];
  const effective = { ...p, quality: vals.quality.length ? p.quality : 'n/a', n: m === 'gpt-image-1' ? n : 1, background: m === 'gpt-image-1' ? p.background : 'auto', format: m === 'gpt-image-1' ? p.format : 'png', compression: m === 'gpt-image-1' ? p.compression : 100 };
  const fit = goal.req.map(([label, fn]) => [label, fn(effective)]);
  const met = fit.filter(f => f[1]).length;
  steps.push(step('review', met === fit.length ? 'Goal requirements met' : 'Goal not fully met', `${goal.label}: ${met}/${fit.length} requirements met with the controls the model actually honoured.`, Object.fromEntries(fit), met === fit.length ? 'ok' : 'warn'));

  const [sw, sh] = (p.size === 'auto' ? '1536x1024' : p.size).split('x').map(Number);
  const px = (sw * sh) / (1024 * 1024);
  const fmtF = effective.format === 'png' ? 1 : 0.15 + 0.5 * (effective.compression / 100);
  const qF = { low: 0.4, medium: 1, high: 2.5, standard: 1, hd: 2, auto: 1 }[p.quality] || 1;
  return {
    steps,
    output: [
      { type: 'table', title: 'Control support and outcome (support summary is illustrative — check docs/model cards)', columns: ['Control', 'Your value', 'gpt-image-1', 'DALL-E 3', 'FLUX', 'Outcome on selected model'], rows, tones },
      ...imgs.map((im, i) => ({ type: 'image', title: i === 0 ? 'Baseline (defaults, 1024x1024)' : `Your configuration — output ${i}`, width: im.W, height: im.H, shapes: im.shapes })),
      { type: 'table', title: `Goal: ${goal.label}`, columns: ['Requirement', 'Met?'], rows: fit.map(([l, ok]) => [l, ok ? 'yes' : 'no']), tones: fit.map(f => (f[1] ? 'ok' : 'warn')) },
      { type: 'json', title: 'Request body actually sent (unsupported controls removed)', data: Object.fromEntries(Object.entries({ model: m, prompt: '…', size: p.size, quality: vals.quality.length ? p.quality : undefined, n: effective.n, background: m === 'gpt-image-1' && p.background !== 'auto' ? p.background : undefined, output_format: m === 'gpt-image-1' ? p.format : undefined, output_compression: m === 'gpt-image-1' && p.format !== 'png' ? p.compression : undefined, style: m === 'dall-e-3' && p.style !== 'none' ? p.style : undefined, seed: seedApplied ? Number(p.seed) : undefined }).filter(([, v]) => v !== undefined)) },
    ],
    metrics: [
      metric('Controls applied / no-op', `${applied} / ${ignored}`, 'computed'),
      metric('Goal requirements met', `${met}/${fit.length}`, 'computed'),
      metric('Relative cost', `${round(px * qF * effective.n, 1)}×`, 'estimate', 'Baseline = one 1024x1024 medium image; cost grows with quality, pixels and n. See the pricing page.'),
      metric('Relative file size', `${round(px * fmtF * (p.quality === 'low' ? 0.6 : 1), 2)}×`, 'estimate', 'Baseline = 1024x1024 PNG. Lossy formats shrink with lower output_compression.'),
      metric('Reproducible', seedApplied ? 'yes (seed)' : 'no', 'computed'),
    ],
    summary: `${m} • ${p.quality}/${p.size}/n=${effective.n}/${effective.format} • goal ${met}/${fit.length}${ignored ? ` • ${ignored} no-op` : ''}`,
  };
}

export default {
  id: '3.1.5',
  lab: 'Generation controls bench',
  services: [
    { name: 'Azure OpenAI image generation (parameters)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e' },
    { name: 'Foundry Models sold directly by Azure (model cards)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/concepts/models-sold-directly-by-azure' },
    { name: 'Content filtering', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter' },
  ],
  prereqs: ['3.1.1'],
  next: ['3.1.3', '3.2.1'],

  concept: {
    plain: 'Image models come with knobs: how detailed (quality), what shape (size), how many pictures at once, whether the background is see-through, what file type and how much to compress it, and on some models a style or a seed that lets you get the same picture again. Not every model has every knob, and a knob a model does not have either breaks the request or quietly does nothing. Choosing well means knowing what you need the picture for and which model actually offers those knobs.',
    technical: 'Controls differ per model in Foundry. gpt-image-1-family models accept quality (low/medium/high/auto), size (1024x1024, 1536x1024, 1024x1536, auto), n, background (transparent/opaque/auto), output_format (png/jpeg/webp) and output_compression (jpeg/webp only); transparency requires png or webp. DALL-E 3 accepts quality standard/hd, its own sizes, style vivid/natural and n=1, and returns a revised_prompt. Partner models such as FLUX expose different parameters (for example seed or aspect ratio) documented on their model cards. Unsupported parameters are rejected with HTTP 400 or ignored; content filtering configured on the deployment applies regardless of any model-level moderation option. Verify against the current API reference.',
    useCase: 'A commerce platform has three image jobs: transparent product stickers (gpt-image-1, background=transparent, WebP), wide hero banners (high quality, landscape), and cheap draft thumbnails for A/B ideas (quality low, n=4, compressed JPEG). A config layer strips controls the chosen deployment does not support and logs what was actually sent.',
    terms: [
      ['quality', 'Detail/compute level; values differ by model (low/medium/high vs standard/hd).'],
      ['background', 'transparent/opaque/auto on gpt-image-1; transparency requires an alpha-capable format.'],
      ['output_compression', '0–100 compression level for jpeg/webp outputs.'],
      ['seed', 'Fixes randomness for reproducible outputs on models that support it; not available on every model.'],
      ['No-op control', 'A parameter that is accepted or stripped but has no effect on the chosen model.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'goal', label: p ? `Goal: ${GOALS[p.goal].label}` : 'Goal', col: 0, row: 1, kind: 'user', detail: 'What the image is for decides which controls matter.' },
          { id: 'model', label: p ? MODEL_LABEL[p.model] : 'Model', col: 1, row: 1, kind: 'ai', detail: 'Determines which controls exist.' },
          { id: 'controls', label: 'Controls', col: 2, row: 1, kind: 'policy', detail: 'quality, size, n, background, format, compression, style, seed, moderation.', substeps: ['Validate values', 'Strip unsupported', 'Log what was sent'] },
          { id: 'generate', label: 'Generate', col: 3, row: 1, kind: 'ai', detail: 'Baseline vs configured.' },
          { id: 'review', label: 'Goal check', col: 4, row: 1, kind: 'policy', detail: 'Were the requirements actually met by honoured controls?' },
        ],
        edges: [['goal', 'model'], ['model', 'controls'], ['controls', 'generate'], ['generate', 'review']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'goal', label: 'Config store (per use case presets)', col: 0, row: 1, kind: 'store', detail: 'Presets: sticker, hero, thumbs, print.' },
          { id: 'controls', label: 'Image service (capability map)', col: 1, row: 1, kind: 'compute', detail: 'Maps presets to the parameters the target deployment supports.' },
          { id: 'model', label: `Foundry deployment: ${p ? p.model : 'gpt-image-1'}`, col: 2, row: 0, kind: 'ai', detail: 'Model card lists supported parameters.' },
          { id: 'generate', label: 'Content filters (deployment)', col: 2, row: 2, kind: 'policy', detail: 'Apply regardless of request options.' },
          { id: 'review', label: 'Blob + metrics', col: 3, row: 1, kind: 'store', detail: 'Store outputs and the exact request sent.' },
        ],
        edges: [['goal', 'controls'], ['controls', 'model', 'images API'], ['model', 'generate'], ['model', 'review']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'goal', label: `preset = PRESETS["${p ? p.goal : 'hero'}"]`, col: 0, row: 0, kind: 'code', detail: 'Use-case driven defaults.' },
          { id: 'model', label: `caps = CAPABILITIES["${p ? p.model : 'gpt-image-1'}"]`, col: 0, row: 1, kind: 'code', detail: 'Your own table, maintained from docs/model cards.' },
          { id: 'controls', label: 'params = {k: v for k, v in preset.items() if k in caps}', col: 0, row: 2, kind: 'code', detail: 'Strip unsupported params; validate values.' },
          { id: 'generate', label: 'client.images.generate(model=dep, prompt=..., **params)', col: 0, row: 3, kind: 'code', detail: 'Illustrative.' },
          { id: 'review', label: 'log(params, dropped=set(preset)-set(params))', col: 0, row: 4, kind: 'code', detail: 'Make no-ops visible.' },
        ],
        edges: [['goal', 'model'], ['model', 'controls'], ['controls', 'generate'], ['generate', 'review']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'goal', label: 'Use case', type: 'select', options: Object.entries(GOALS).map(([v, g]) => [v, g.label]), default: 'hero' },
      { id: 'model', label: 'Model', type: 'select', options: Object.entries(MODEL_LABEL), default: 'gpt-image-1' },
      { id: 'quality', label: 'quality', type: 'select', options: ['auto', 'low', 'medium', 'high', 'standard', 'hd'].map(v => [v, v]), default: 'medium' },
      { id: 'size', label: 'size', type: 'select', options: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', 'auto'].map(v => [v, v]), default: '1024x1024' },
      { id: 'n', label: 'n', type: 'range', min: 1, max: 4, step: 1, default: 1 },
      { id: 'background', label: 'background', type: 'select', options: [['auto', 'auto'], ['opaque', 'opaque'], ['transparent', 'transparent']], default: 'auto' },
      { id: 'format', label: 'output_format', type: 'select', options: [['png', 'png'], ['jpeg', 'jpeg'], ['webp', 'webp']], default: 'png' },
      { id: 'compression', label: 'output_compression', type: 'range', min: 0, max: 100, step: 5, default: 100 },
      { id: 'style', label: 'style (DALL-E 3)', type: 'select', options: [['none', 'not set'], ['vivid', 'vivid'], ['natural', 'natural']], default: 'none' },
      { id: 'seed', label: 'seed (0 = not set)', type: 'number', min: 0, max: 99999, step: 1, default: 0 },
      { id: 'moderation', label: 'moderation', type: 'select', options: [['auto', 'auto'], ['low', 'low']], default: 'auto', help: 'Model-level option where supported. It never bypasses the content filters configured on the Azure deployment.' },
    ],
    samples: [
      { label: 'Hero banner, gpt-image-1 high', values: { goal: 'hero', size: '1536x1024', quality: 'high' } },
      { label: 'Hero banner, DALL-E 3 hd vivid', values: { goal: 'hero', model: 'dall-e-3', size: '1792x1024', quality: 'hd', style: 'vivid' } },
      { label: 'Draft thumbnails', values: { goal: 'thumbs', quality: 'low', n: 4, format: 'jpeg', compression: 60 } },
      { label: 'FLUX with a seed', values: { goal: 'print', model: 'flux', seed: 42, quality: 'high' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the hero banner on gpt-image-1 (high, 1536x1024) and on DALL-E 3 (hd, 1792x1024, vivid) and compare outputs and cost.',
      'Compare output_compression 100 vs 40 with format webp: file size estimate and artefacts.',
      'Compare FLUX with seed 42 vs gpt-image-1 with seed 42: which one is reproducible?',
    ],
  },

  debug: [
    { id: 'jpeg-transparent', title: 'Transparent sticker comes back rejected', values: { goal: 'sticker', background: 'transparent', format: 'jpeg' }, node: 'controls',
      symptom: 'HTTP 400 on background.', cause: 'JPEG has no alpha channel; transparency needs png or webp.', fix: 'Set output_format to png or webp.' },
    { id: 'dalle-n', title: 'DALL-E 3 rejects batch', values: { model: 'dall-e-3', quality: 'hd', n: 4 }, node: 'controls',
      symptom: 'HTTP 400: n not allowed.', cause: 'DALL-E 3 returns one image per request.', fix: 'Set n=1 and make parallel calls, or use gpt-image-1.' },
    { id: 'quality-value', title: 'Invalid quality value', values: { model: 'gpt-image-1', quality: 'hd' }, node: 'controls',
      symptom: 'HTTP 400 on quality.', cause: '"hd" is a DALL-E 3 value; gpt-image-1 uses low/medium/high/auto.', fix: 'Use high.' },
    { id: 'seed-noop', title: 'Same seed, different images', values: { seed: 1234, n: 2 }, node: 'controls',
      symptom: 'Variations differ even with a seed set.', cause: 'gpt-image-1 has no seed parameter; it was stripped (no-op).', fix: 'Remove the seed and store outputs you want to keep, or use a model whose card documents seed support.' },
    { id: 'compress-png', title: 'Compression has no effect', values: { compression: 40, format: 'png' }, node: 'controls',
      symptom: 'File size unchanged.', cause: 'output_compression only applies to jpeg/webp.', fix: 'Switch output_format to webp or jpeg, or leave compression at 100.' },
    { id: 'dalle-bg', title: 'Background parameter rejected on DALL-E 3', values: { model: 'dall-e-3', quality: 'standard', background: 'transparent' }, node: 'controls',
      symptom: 'HTTP 400 unknown parameter.', cause: 'Unsuitable model for transparent output.', fix: 'Use gpt-image-1 with background=transparent and png/webp.' },
  ],

  challenge: {
    task: 'Configure the "Transparent product sticker" use case so every requirement is met with a WebP file compressed to 80 or less, and with no rejected or no-op controls.',
    condition: 'Goal = sticker, all requirements met, format webp, compression ≤ 80, no warn/error step.',
    hint: 'Only one model honours both background and output_compression.',
    check: (p, res) => p.goal === 'sticker' && p.format === 'webp' && p.compression <= 80 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Use case: sticker; model: gpt-image-1.', 'background: transparent; output_format: webp; output_compression: 80.', 'Keep style and seed unset (they are no-ops on gpt-image-1).'],
    solutionValues: { goal: 'sticker', model: 'gpt-image-1', quality: 'medium', size: '1024x1024', n: 1, background: 'transparent', format: 'webp', compression: 80, style: 'none', seed: 0, moderation: 'auto' },
  },

  quiz: [
    { q: 'You need product images with a transparent background for a web shop. Which configuration is valid?', options: ['DALL-E 3, style=natural', 'gpt-image-1, background=transparent, output_format=png or webp', 'gpt-image-1, background=transparent, output_format=jpeg', 'Any model with quality=hd'], answer: 1, why: 'Transparency is a gpt-image-1 background option and requires an alpha-capable format.' },
    { q: 'Designers want to regenerate exactly the same image later. The deployment is gpt-image-1. What is the most reliable approach?', options: ['Pass seed=42', 'Store the generated image (and prompt/params) when it is approved', 'Use quality=high', 'Set moderation=low'], answer: 1, why: 'gpt-image-1 offers no seed; persist outputs you need. Use a model whose card documents seed support if reproducibility is required.' },
    { q: 'Your team sets moderation=low to allow edgier artwork, but some prompts are still blocked. Why?', options: ['The parameter name is wrong', 'Content filters configured on the Azure deployment still apply', 'Quality must be high', 'n must be 1'], answer: 1, why: 'Model-level options never bypass the deployment\'s content filtering configuration.' },
    { q: 'You want many cheap concept thumbnails per click. Which controls fit?', options: ['quality=high, n=1, png', 'quality=low, n=4, jpeg/webp with compression', 'DALL-E 3 hd with n=4', 'size=1792x1024'], answer: 1, why: 'Low quality, batching and lossy compression minimise cost and size.' },
  ],

  recap: 'Pick controls from the use case, then check the target model really supports them: quality/size values differ by model, transparency needs gpt-image-1 with png/webp, compression only affects jpeg/webp, style is DALL-E 3 only, seed is model-card dependent, and deployment content filters always apply. Strip and log unsupported parameters.',
};
