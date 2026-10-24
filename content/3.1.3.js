// 3.1.3 Configure image-editing workflows, including inpainting, mask-based edits, and prompt-driven modifications
// Lab: Inpainting mask editor.
import { rng, round, step, metric, words } from '../src/engine/util.js';

// The source image is a 1024x1024 kitchen scene drawn on an 80x80 canvas, split into an 8x8 mask grid
// (each grid cell = 128x128 source pixels = 10x10 canvas units).
const G = 8, C = 10;
const OBJECTS = {
  window: { label: 'window', cells: [1, 0, 3, 3], draw: (x, y, w, h) => [{ kind: 'rect', x, y, w, h, fill: '#8d6e63' }, { kind: 'rect', x: x + 1.5, y: y + 1.5, w: w - 3, h: h - 3, fill: '#a8d8f0' }, { kind: 'circle', x: x + w * 0.7, y: y + h * 0.35, r: 3, fill: '#ffd23f' }, { kind: 'line', x: x + w / 2, y: y + 1.5, x2: x + w / 2, y2: y + h - 1.5, fill: '#8d6e63' }] },
  clock: { label: 'clock', cells: [6, 1, 1, 1], draw: (x, y, w) => [{ kind: 'circle', x: x + w / 2, y: y + w / 2, r: w * 0.4, fill: '#fafafa' }, { kind: 'line', x: x + w / 2, y: y + w / 2, x2: x + w / 2, y2: y + 2, fill: '#212121' }] },
  plant: { label: 'plant', cells: [0, 4, 2, 3], draw: (x, y, w, h) => [{ kind: 'rect', x: x + w * 0.3, y: y + h * 0.6, w: w * 0.4, h: h * 0.4, fill: '#bf6f3a' }, { kind: 'circle', x: x + w / 2, y: y + h * 0.35, r: w * 0.38, fill: '#2e7d32' }] },
  mug: { label: 'mug', cells: [4, 5, 2, 2], draw: (x, y, w, h) => [{ kind: 'rect', x: x + 4, y: y + 5, w: w - 9, h: h - 5, fill: '#e0e0e0' }, { kind: 'circle', x: x + w - 4, y: y + h * 0.6, r: 2.5, fill: '#e0e0e0' }] },
};
const COUNTER_ROW = 7;

const NEW = {
  teapot: (x, y, w, h, c) => [{ kind: 'circle', x: x + w / 2, y: y + h * 0.62, r: Math.min(w, h) * 0.32, fill: c || '#1e88e5' }, { kind: 'rect', x: x + w * 0.42, y: y + h * 0.18, w: w * 0.16, h: h * 0.14, fill: c || '#1e88e5' }, { kind: 'line', x: x + w * 0.8, y: y + h * 0.55, x2: x + w * 0.95, y2: y + h * 0.4, fill: c || '#1e88e5' }],
  vase: (x, y, w, h, c) => [{ kind: 'rect', x: x + w * 0.35, y: y + h * 0.3, w: w * 0.3, h: h * 0.7, fill: c || '#8e24aa' }, { kind: 'circle', x: x + w / 2, y: y + h * 0.22, r: w * 0.2, fill: '#ec407a' }],
  cat: (x, y, w, h, c) => [{ kind: 'rect', x: x + w * 0.15, y: y + h * 0.5, w: w * 0.6, h: h * 0.5, fill: c || '#8a8a8a' }, { kind: 'circle', x: x + w * 0.75, y: y + h * 0.45, r: w * 0.18, fill: c || '#8a8a8a' }],
  lamp: (x, y, w, h, c) => [{ kind: 'rect', x: x + w * 0.45, y: y + h * 0.4, w: w * 0.1, h: h * 0.6, fill: '#424242' }, { kind: 'rect', x: x + w * 0.25, y: y + h * 0.15, w: w * 0.5, h: h * 0.3, fill: c || '#fdd835' }],
  night: (x, y, w, h) => [{ kind: 'rect', x: x + 1.5, y: y + 1.5, w: w - 3, h: h - 3, fill: '#1d2340' }, { kind: 'circle', x: x + w * 0.3, y: y + h * 0.3, r: 2.5, fill: '#f1f1d0' }, { kind: 'circle', x: x + w * 0.7, y: y + h * 0.6, r: 0.6, fill: '#ffffff' }],
  snow: (x, y, w, h) => [{ kind: 'rect', x: x + 1.5, y: y + 1.5, w: w - 3, h: h - 3, fill: '#cfd8dc' }, { kind: 'rect', x: x + 1.5, y: y + h * 0.7, w: w - 3, h: h * 0.3 - 1.5, fill: '#fafafa' }],
  sunset: (x, y, w, h) => [{ kind: 'rect', x: x + 1.5, y: y + 1.5, w: w - 3, h: h - 3, fill: '#f4a261' }, { kind: 'circle', x: x + w / 2, y: y + h * 0.7, r: 3, fill: '#e76f51' }],
  flowers: (x, y, w, h, c) => [{ kind: 'rect', x: x + w * 0.3, y: y + h * 0.6, w: w * 0.4, h: h * 0.4, fill: '#bf6f3a' }, { kind: 'circle', x: x + w * 0.35, y: y + h * 0.35, r: w * 0.14, fill: c || '#ec407a' }, { kind: 'circle', x: x + w * 0.62, y: y + h * 0.3, r: w * 0.14, fill: c || '#fdd835' }],
};
const COLORS = { red: '#d32f2f', blue: '#1e88e5', green: '#43a047', yellow: '#fdd835', purple: '#8e24aa', orange: '#fb8c00', black: '#212121', white: '#fafafa', pink: '#ec407a' };
const SYN = { teapot: 'teapot', kettle: 'teapot', vase: 'vase', cat: 'cat', kitten: 'cat', lamp: 'lamp', night: 'night', stars: 'night', snow: 'snow', snowy: 'snow', sunset: 'sunset', flowers: 'flowers', flower: 'flowers', tulips: 'flowers' };

const MODELS = {
  'gpt-image-1': { label: 'gpt-image-1 family (images.edit, mask optional)', edit: true, mask: true },
  'flux-kontext': { label: 'FLUX Kontext-style instruction editing (no mask)', edit: true, mask: false },
  'dall-e-3': { label: 'DALL-E 3 (generation only)', edit: false, mask: false },
};

const cellsOf = ([cx, cy, cw, ch]) => { const s = []; for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) s.push(y * G + x); return s; };
const objAt = idx => Object.keys(OBJECTS).find(k => cellsOf(OBJECTS[k].cells).includes(idx)) || (Math.floor(idx / G) === COUNTER_ROW ? 'counter' : 'wall');

function maskCells(p) {
  let base;
  if (p.region === 'none') base = [];
  else if (p.region === 'all') base = Array.from({ length: G * G }, (_, i) => i);
  else if (p.region === 'custom') base = cellsOf([Math.min(p.mx, G - 1), Math.min(p.my, G - 1), Math.max(0, Math.min(p.mw, G - p.mx)), Math.max(0, Math.min(p.mh, G - p.my))]);
  else base = cellsOf(OBJECTS[p.region].cells);
  const set = new Set(base);
  for (let g = 0; g < p.grow; g++) for (const i of [...set]) { const x = i % G, y = Math.floor(i / G); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < G && ny < G) set.add(ny * G + nx); } }
  return set;
}

function baseScene() {
  const s = [{ kind: 'rect', x: 0, y: 0, w: 80, h: 80, fill: '#f3e9d2' }, { kind: 'rect', x: 0, y: COUNTER_ROW * C - 2, w: 80, h: 12, fill: '#795548' }];
  for (const o of Object.values(OBJECTS)) { const [cx, cy, cw, ch] = o.cells; s.push(...o.draw(cx * C, cy * C, cw * C, ch * C)); }
  return s;
}
function bbox(cells) {
  const xs = cells.map(i => i % G), ys = cells.map(i => Math.floor(i / G));
  return [Math.min(...xs) * C, Math.min(...ys) * C, (Math.max(...xs) - Math.min(...xs) + 1) * C, (Math.max(...ys) - Math.min(...ys) + 1) * C];
}

function parseEdit(prompt) {
  const ws = words(prompt);
  const refers = Object.keys(OBJECTS).filter(k => ws.includes(k) || (k === 'plant' && ws.includes('pot')) || (k === 'window' && ws.some(w => ['view', 'sky', 'outside'].includes(w))));
  const remove = ws[0] === 'remove' || ws.includes('erase');
  const iw = ws.findIndex(w => ['with', 'into', 'add', 'to'].includes(w));
  const tail = iw >= 0 ? ws.slice(iw + 1) : ws;
  const newKey = tail.map(w => SYN[w]).find(Boolean) || ws.map(w => SYN[w]).find(Boolean) || null;
  const color = tail.map(w => COLORS[w]).find(Boolean) || null;
  return { refers, remove, newKey, color };
}

function run(p) {
  const steps = [];
  const m = MODELS[p.model];
  const prompt = String(p.prompt || '');
  const ed = parseEdit(prompt);
  const useMask = p.mode === 'mask' && m.mask;
  const before = baseScene();
  const out = (extra = []) => [{ type: 'image', title: 'Source image (1024x1024 PNG)', width: 80, height: 80, shapes: before }, ...extra];
  const err = (node, title, detail, data, summary, extra = []) => { steps.push(step(node, title, detail, data, 'error')); return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, ...out(extra)], metrics: [metric('Cells preserved', '—', 'computed')], summary }; };

  // 1. model / endpoint
  if (!m.edit) return err('model', 'Model has no edit operation', `${m.label} only generates new images. Use an editing-capable deployment (gpt-image-1 family images.edit, or an instruction-editing model).`, { model: p.model, operation: 'images.edit' }, 'Rejected: model cannot edit');
  steps.push(step('source', 'Source image loaded', 'PNG, 1024x1024, sent as the image input of images.edit.', { width: 1024, height: 1024, format: 'png' }));

  // 2. mask validation
  const mask = maskCells(p);
  const maskGrid = { type: 'grid', title: `Mask (${p.maskSize}) — T = transparent (editable), letters = opaque/kept`, cols: G, caption: 'Each cell = 128x128 px of the source.',
    cells: Array.from({ length: G * G }, (_, i) => (mask.has(i) ? { v: 1, tone: 'warn', label: 'T' } : { v: 0, tone: 'muted', label: objAt(i)[0].toUpperCase() })) };
  if (p.mode === 'mask' && !m.mask) {
    steps.push(step('mask', 'Mask ignored by this model', `${m.label} edits from the instruction alone; the mask is not sent. Anything in the image may change.`, { maskSent: false }, 'warn'));
  } else if (useMask) {
    if (p.maskFormat !== 'png-alpha') return err('mask', 'HTTP 400 invalid mask', p.maskFormat === 'jpeg' ? 'JPEG has no alpha channel. The mask must be a PNG whose fully transparent pixels mark the area to edit.' : 'The PNG has no alpha channel (black/white only). Transparent pixels, not black pixels, mark the editable area.', { maskFormat: p.maskFormat, required: 'PNG with alpha' }, 'Rejected: mask has no alpha', [maskGrid]);
    if (p.maskSize !== '1024x1024') return err('mask', 'HTTP 400 mask size mismatch', `Mask is ${p.maskSize} but the image is 1024x1024. Image and mask must have identical dimensions.`, { image: '1024x1024', mask: p.maskSize }, 'Rejected: mask/image size mismatch', [maskGrid]);
    if (mask.size === 0) return err('mask', 'Empty mask', 'The mask has no transparent pixels, so there is nothing to edit. Depending on model/API the call is rejected or returns an unchanged image; treat it as a client-side validation error.', { transparentCells: 0 }, 'Rejected: empty mask', [maskGrid]);
    if (mask.size === G * G) steps.push(step('mask', 'Mask covers the whole image', 'Every pixel is editable: this is regeneration, not inpainting. Original content will not be preserved.', { transparentCells: 64 }, 'warn'));
    else steps.push(step('mask', 'Mask valid', `${mask.size}/64 cells transparent (${round((mask.size / 64) * 100, 0)}% of the image editable). Same size as the image, PNG with alpha.`, { transparentCells: mask.size, grow: p.grow }));
  } else {
    steps.push(step('mask', 'No mask (prompt-driven edit)', 'The instruction alone decides what changes. Good for global changes (style, lighting); risky for local ones.', null, 'info'));
  }

  // 3. prompt vs mask alignment
  if (!prompt.trim()) return err('prompt', 'Edit prompt required', 'Describe the change to make inside the mask (and the full desired scene for best results).', {}, 'Rejected: empty prompt', [maskGrid]);
  const target = ed.refers[0] || null;
  const targetCells = target ? cellsOf(OBJECTS[target].cells) : [];
  let editCells;
  if (useMask) {
    editCells = [...mask];
    const cov = targetCells.length ? targetCells.filter(i => mask.has(i)).length / targetCells.length : 1;
    const spill = [...new Set([...mask].map(objAt).filter(o => OBJECTS[o] && o !== target))];
    const issues = [];
    if (target && cov < 0.6) issues.push(`the prompt refers to the ${target} but the mask covers only ${round(cov * 100, 0)}% of it`);
    if (spill.length && mask.size < 64) issues.push(`the mask also uncovers ${spill.join(', ')}, which may be altered`);
    if (!ed.newKey && !ed.remove) issues.push('the prompt does not name what to put in the masked area');
    steps.push(step('prompt', issues.length ? 'Prompt and mask disagree' : 'Prompt matches mask', issues.length ? issues.join('; ') + '.' : `Edit "${prompt}" targets the ${target || 'masked area'}, fully covered by the mask.`, { target, coverage: round(cov, 2), spill, newContent: ed.newKey || (ed.remove ? 'background' : null) }, issues.length ? 'warn' : 'ok'));
  } else {
    editCells = target ? targetCells : Array.from({ length: 64 }, (_, i) => i);
    steps.push(step('prompt', 'Instruction parsed', `Change: ${ed.remove ? 'remove' : 'replace/add'} ${target || '(whole image)'} → ${ed.newKey || 'background'}.`, ed, ed.newKey || ed.remove ? 'ok' : 'warn'));
  }

  // 4. edit
  const r = rng(`${prompt}|${p.model}|${p.mode}|${[...mask].join(',')}|${p.fidelity}`);
  const changed = new Set(editCells);
  // Drift: masks are guidance for GPT image models; unmasked areas can shift. Instruction-only edits drift more.
  const driftRate = useMask ? (p.fidelity === 'high' ? 0 : 0.35) : (p.fidelity === 'high' ? 0.12 : 0.3);
  const border = new Set();
  for (const i of changed) { const x = i % G, y = Math.floor(i / G); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < G && ny < G && !changed.has(ny * G + nx)) border.add(ny * G + nx); } }
  const drift = new Set();
  if (useMask) { for (const i of border) if (r() < driftRate) drift.add(i); }
  else for (let i = 0; i < 64; i++) if (!changed.has(i) && r() < driftRate) drift.add(i);
  const after = baseScene();
  const [bx, by, bw, bh] = editCells.length ? bbox(editCells) : [0, 0, 0, 0];
  if (editCells.length) {
    for (const i of editCells) { const x = (i % G) * C, y = Math.floor(i / G) * C; after.push({ kind: 'rect', x, y, w: C, h: C, fill: Math.floor(i / G) === COUNTER_ROW ? '#795548' : '#f3e9d2' }); }
    if (target === 'window' && !ed.remove && ['night', 'snow', 'sunset'].includes(ed.newKey)) after.push({ kind: 'rect', x: bx, y: by, w: bw, h: bh, fill: '#8d6e63' });
    if (ed.newKey && !ed.remove) after.push(...NEW[ed.newKey](bx, by, bw, bh, ed.color));
  }
  for (const i of drift) { const x = (i % G) * C, y = Math.floor(i / G) * C; after.push({ kind: 'rect', x: x + 1, y: y + 1, w: C - 2, h: C - 2, fill: r() > 0.5 ? '#e8dcc0' : '#d7ccc8' }); }
  if (useMask) after.push({ kind: 'box', x: bx, y: by, w: bw, h: bh, label: 'mask', tone: 'warn', dashed: true });
  const preserved = (64 - changed.size - drift.size) / 64;
  steps.push(step('model', 'Edited image returned', `${changed.size} cell(s) edited${drift.size ? `, ${drift.size} unmasked cell(s) drifted (${useMask ? 'GPT image masks guide the edit but are not a hard boundary' : 'no mask: the model re-renders freely'}; input_fidelity=${p.fidelity}).` : '.'}`,
    { data: [{ b64_json: '<…>' }], editedCells: changed.size, driftCells: drift.size }, drift.size > 4 ? 'warn' : 'ok'));
  steps.push(step('review', preserved >= 0.85 ? 'Preservation check passed' : 'Preservation check: large change', `Pixel-diff review: ${round(preserved * 100, 0)}% of the image unchanged (threshold 85% in this lab).`, { preserved: round(preserved, 2) }, preserved >= 0.85 || mask.size === 64 ? 'ok' : 'warn'));

  const diffGrid = { type: 'grid', title: 'Change map (red = edited, amber = unintended drift)', cols: G, cells: Array.from({ length: 64 }, (_, i) => (changed.has(i) ? { v: 1, tone: 'error', label: '■' } : drift.has(i) ? { v: 0.5, tone: 'warn', label: '~' } : { v: 0, tone: 'ok', label: '' })) };
  return {
    steps,
    output: [
      ...out(),
      { type: 'image', title: `Edited: "${prompt.slice(0, 50)}"`, width: 80, height: 80, shapes: after },
      ...(useMask ? [maskGrid] : []),
      diffGrid,
      { type: 'kv', title: 'Request (multipart/form-data)', items: [['model', p.model], ['image', 'kitchen.png (1024x1024)'], ['mask', useMask ? `mask.png (${p.maskSize}, ${p.maskFormat})` : '— (not sent)'], ['prompt', prompt], ['input_fidelity', `${p.fidelity} (model/API-version dependent)`]] },
      { type: 'code', lang: 'python', title: 'Equivalent call (illustrative)', text: `result = client.images.edit(\n    model="${p.model}",\n    image=open("kitchen.png", "rb"),${useMask ? '\n    mask=open("mask.png", "rb"),        # same size, PNG with alpha; transparent = edit' : ''}\n    prompt=${JSON.stringify(prompt)},\n    size="1024x1024")\nedited = base64.b64decode(result.data[0].b64_json)` },
    ],
    metrics: [
      metric('Cells preserved', `${round(preserved * 100, 0)}%`, 'computed', 'Share of 8x8 grid cells not edited and not drifted.'),
      metric('Mask coverage of image', useMask ? `${round((mask.size / 64) * 100, 0)}%` : 'n/a', 'computed'),
      metric('Unintended drift cells', String(drift.size), 'computed', 'Simulation rule: high input fidelity and a tight mask reduce drift.'),
    ],
    summary: `${p.model} ${useMask ? 'mask ' + mask.size + ' cells' : 'no mask'} • preserved ${round(preserved * 100, 0)}%${steps.some(s => s.status === 'warn') ? ' • warnings' : ''}`,
  };
}

export default {
  id: '3.1.3',
  lab: 'Inpainting mask editor',
  services: [
    { name: 'Azure OpenAI image generation and editing (how-to)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e' },
    { name: 'Foundry Models catalog', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/foundry-models-overview' },
  ],
  prereqs: ['3.1.1'],
  next: ['3.1.5', '3.1.4'],

  concept: {
    plain: 'Editing part of a picture works like using a stencil. You give the model the original picture, a stencil (the mask) where the see-through parts mark what may change, and a sentence saying what should appear there. Everything under the solid part of the stencil should stay the same. Without a stencil, the model decides by itself what to change from your sentence, which is fine for "make it look like winter" but risky for "swap the mug".',
    technical: 'Inpainting uses the Images edit operation (images.edit) with an input image, an optional mask and a prompt. The mask must be a PNG with an alpha channel and exactly the same dimensions as the image; fully transparent pixels mark the editable area. With gpt-image-1-family models the mask guides the edit rather than acting as a hard pixel boundary, and options such as input_fidelity (model/API-version dependent) help preserve details. Instruction-based editing models (for example FLUX Kontext-style models in Foundry) take no mask and change the image from the prompt alone. Generation-only models such as DALL-E 3 cannot edit.',
    useCase: 'An e-commerce team swaps seasonal props in product lifestyle photos: a designer paints a mask over the mug, types "replace the mug with a blue teapot", and a review step diffs the result to make sure the product itself (outside the mask) stayed untouched before publishing.',
    terms: [
      ['Mask', 'PNG with alpha, same size as the image; transparent pixels = editable area.'],
      ['Inpainting', 'Regenerating only the masked region so it blends with the rest.'],
      ['Instruction (prompt-driven) edit', 'Editing from a text instruction without a mask; the model decides what to change.'],
      ['input_fidelity', 'Option on some GPT image models to preserve input details such as faces and logos more strongly (check availability).'],
      ['Drift', 'Unintended change outside the intended area; detect it with a pixel or perceptual diff.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'source', label: 'Original image', col: 0, row: 0, kind: 'data', detail: 'PNG input; defines the size the mask must match.' },
          { id: 'mask', label: p && p.mode === 'prompt' ? 'Mask (not used)' : 'Mask (alpha = edit)', col: 0, row: 2, kind: 'data', disabled: p && p.mode === 'prompt', detail: 'Transparent pixels mark where the model may paint.', badge: p && p.mode === 'mask' ? p.region : undefined },
          { id: 'prompt', label: 'Edit prompt', col: 1, row: 1, kind: 'data', detail: 'What should appear in the masked area (best: describe the full resulting scene).' },
          { id: 'model', label: 'Edit model', col: 2, row: 1, kind: 'ai', detail: 'Regenerates the editable area so it blends with the rest.', badge: p ? p.model : undefined },
          { id: 'review', label: 'Diff & review', col: 3, row: 1, kind: 'policy', detail: 'Compare before/after to catch drift outside the mask.' },
        ],
        edges: [['source', 'model'], ['mask', 'model'], ['prompt', 'model'], ['model', 'review']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'source', label: 'Blob: originals', col: 0, row: 0, kind: 'store', detail: 'Product photos.' },
          { id: 'mask', label: 'Web mask editor (canvas → PNG alpha)', col: 0, row: 2, kind: 'app', detail: 'Exports the mask at the same size as the image.', disabled: p && p.mode === 'prompt' },
          { id: 'prompt', label: 'API (Container App, managed identity)', col: 1, row: 1, kind: 'compute', detail: 'Validates mask size/alpha, calls images.edit with DefaultAzureCredential.' },
          { id: 'model', label: `Foundry deployment: ${p ? p.model : 'gpt-image-1'}`, col: 2, row: 1, kind: 'ai', detail: 'Editing-capable deployment; content filters apply to prompt and output.' },
          { id: 'review', label: 'Review queue + Blob: edited', col: 3, row: 1, kind: 'store', detail: 'Diff score + human approval before publishing.' },
        ],
        edges: [['source', 'prompt'], ['mask', 'prompt'], ['prompt', 'model', 'images.edit'], ['model', 'review']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'source', label: 'img = Image.open("kitchen.png")  # 1024x1024', col: 0, row: 0, kind: 'code', detail: 'Pillow.' },
          { id: 'mask', label: 'mask = Image.new("RGBA", img.size, (0,0,0,255)); paint alpha=0 where editable', col: 0, row: 1, kind: 'code', detail: 'Same size; transparent = edit. Validate size and mode == "RGBA".' },
          { id: 'prompt', label: 'prompt = "Replace the mug with a small blue teapot"', col: 0, row: 2, kind: 'code', detail: 'Name the target and the replacement.' },
          { id: 'model', label: `client.images.edit(model=dep, image=f, ${p && p.mode === 'prompt' ? '' : 'mask=m, '}prompt=prompt)`, col: 0, row: 3, kind: 'code', detail: 'Illustrative; parameters vary by model/API version.' },
          { id: 'review', label: 'score = diff(img, edited, outside=mask)', col: 0, row: 4, kind: 'code', detail: 'Reject if too much changed outside the mask.' },
        ],
        edges: [['source', 'mask'], ['mask', 'prompt'], ['prompt', 'model'], ['model', 'review']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'prompt', label: 'Edit prompt', type: 'text', default: 'Replace the mug with a small blue teapot', help: 'Targets: mug, plant, window (view/sky), clock. New content: teapot, vase, cat, lamp, flowers, night, snow, sunset. Start with "Remove" to erase.' },
      { id: 'mode', label: 'Edit mode', type: 'select', options: [['mask', 'Mask-based inpainting'], ['prompt', 'Prompt-only (instruction) edit']], default: 'mask' },
      { id: 'region', label: 'Mask region', type: 'select', options: [['mug', 'Mug'], ['plant', 'Plant'], ['window', 'Window'], ['clock', 'Clock'], ['custom', 'Custom rectangle'], ['none', 'Empty mask'], ['all', 'Whole image']], default: 'mug' },
      { id: 'mx', label: 'Custom mask x (cell)', type: 'range', min: 0, max: 7, step: 1, default: 4 },
      { id: 'my', label: 'Custom mask y (cell)', type: 'range', min: 0, max: 7, step: 1, default: 4 },
      { id: 'mw', label: 'Custom mask width (cells)', type: 'range', min: 0, max: 8, step: 1, default: 3 },
      { id: 'mh', label: 'Custom mask height (cells)', type: 'range', min: 0, max: 8, step: 1, default: 3 },
      { id: 'grow', label: 'Grow mask (cells)', type: 'range', min: 0, max: 2, step: 1, default: 0, help: 'Dilating the mask gives the model room to blend edges, at the cost of touching neighbours.' },
      { id: 'maskSize', label: 'Mask file size', type: 'select', options: [['1024x1024', '1024x1024 (matches image)'], ['512x512', '512x512'], ['1024x768', '1024x768']], default: '1024x1024' },
      { id: 'maskFormat', label: 'Mask file format', type: 'select', options: [['png-alpha', 'PNG with alpha channel'], ['png-opaque', 'PNG black/white, no alpha'], ['jpeg', 'JPEG']], default: 'png-alpha' },
      { id: 'model', label: 'Model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-image-1' },
      { id: 'fidelity', label: 'input_fidelity', type: 'select', options: [['low', 'low (default)'], ['high', 'high']], default: 'low', help: 'Available on some GPT image models/API versions; check the docs.' },
    ],
    samples: [
      { label: 'Mug → teapot (mask)', values: {} },
      { label: 'Mug → teapot, mask grown by 2', values: { grow: 2 } },
      { label: 'Night view through the window', values: { prompt: 'Change the window view to a night sky with stars', region: 'window', grow: 0, fidelity: 'high' } },
      { label: 'Remove the plant, prompt only', values: { prompt: 'Remove the plant', mode: 'prompt' } },
      { label: 'Custom rectangle: add a cat on the counter', values: { prompt: 'Add a black cat sitting on the counter', region: 'custom', mx: 2, my: 5, mw: 2, mh: 2, grow: 0 } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run mug → teapot with grow 0, 1 and 2: compare preserved cells and which neighbours are uncovered.',
      'Run the same edit in mask mode and prompt-only mode and compare the change maps.',
      'Toggle input_fidelity low vs high on the window edit and compare drift.',
    ],
  },

  debug: [
    { id: 'size', title: 'Edit rejected: mask size', values: { maskSize: '512x512' }, node: 'mask',
      symptom: 'HTTP 400 before any editing.', cause: 'Mask dimensions differ from the image.', fix: 'Export the mask at exactly the image size (1024x1024).' },
    { id: 'alpha', title: 'Edit rejected: black-and-white mask', values: { maskFormat: 'png-opaque' }, node: 'mask',
      symptom: 'HTTP 400 invalid mask.', cause: 'The mask has no alpha channel; the API uses transparency, not black/white, to mark the editable area.', fix: 'Save the mask as RGBA PNG with transparent pixels where edits are allowed.' },
    { id: 'empty', title: 'Nothing changes', values: { region: 'none' }, node: 'mask',
      symptom: 'Empty mask: request rejected or image unchanged.', cause: 'No transparent pixels.', fix: 'Paint the region to edit (select Mug).' },
    { id: 'all', title: 'Whole photo regenerated', values: { region: 'all' }, node: 'mask',
      symptom: 'Everything in the image changed; product details lost.', cause: 'A fully transparent mask makes every pixel editable.', fix: 'Mask only the object you want to change.' },
    { id: 'wrongregion', title: 'Teapot appears in the window', values: { region: 'window', prompt: 'Replace the mug with a small blue teapot' }, node: 'prompt',
      symptom: 'The teapot is painted in the wrong place and the mug is still there.', cause: 'The mask and the prompt target different objects.', fix: 'Mask the mug, or change the prompt to match the masked area.' },
    { id: 'dalle', title: 'Model cannot edit', values: { model: 'dall-e-3' }, node: 'model',
      symptom: 'Operation not supported.', cause: 'Generation-only model chosen for an edit workflow.', fix: 'Use a gpt-image-1 family deployment (images.edit).' },
    { id: 'kontext', title: 'Mask ignored', values: { model: 'flux-kontext' }, node: 'mask',
      symptom: 'Edits land outside the painted area.', cause: 'Instruction-editing models do not take a mask.', fix: 'Use a mask-capable model for local edits, or rely on a precise instruction with a review step.' },
  ],

  challenge: {
    task: 'Turn the view through the window into a night sky while keeping at least 85% of the photo unchanged and producing no warnings.',
    condition: 'Prompt mentions night; mask covers the window; preserved cells ≥ 85%; no warn/error step.',
    hint: 'Tight mask, no extra growth, and the option that reduces drift.',
    check: (p, res) => /night/i.test(p.prompt) && p.mode === 'mask' && ['window', 'custom'].includes(p.region) && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.steps.some(s => s.node === 'review' && s.status === 'ok' && s.data && s.data.preserved >= 0.85),
    solution: ['Prompt: "Change the window view to a night sky with stars".', 'Mask region: Window; Grow: 0.', 'input_fidelity: high.', 'Keep mask PNG with alpha at 1024x1024 and gpt-image-1.'],
    solutionValues: { prompt: 'Change the window view to a night sky with stars', mode: 'mask', region: 'window', grow: 0, fidelity: 'high', model: 'gpt-image-1', maskSize: '1024x1024', maskFormat: 'png-alpha' },
  },

  quiz: [
    { q: 'You need to swap a mug in a product photo without touching anything else. Which request is most appropriate?', options: ['images.generate with a detailed prompt', 'images.edit with the photo, a same-size PNG mask transparent over the mug, and a prompt naming the replacement', 'images.edit with a JPEG mask', 'A prompt-only edit on DALL-E 3'], answer: 1, why: 'Local edits need a mask: PNG with alpha, same dimensions, transparent where editing is allowed.' },
    { q: 'Your edit call fails with "mask and image must have the same dimensions". The mask was exported from a 512x512 preview canvas. Fix?', options: ['Resize the source image to 512x512 afterwards', 'Export the mask at the source image\'s exact size', 'Use JPEG for the mask', 'Remove the mask'], answer: 1, why: 'The mask must match the image size exactly; scale the mask to the original resolution.' },
    { q: 'After masking the mug, reviewers notice slight changes on the counter outside the mask. What is a sound mitigation?', options: ['Make the mask cover the whole image', 'Accept it: masks on GPT image models guide rather than strictly bound edits; add a diff check and use options such as higher input fidelity', 'Switch to a JPEG mask', 'Use a generation-only model'], answer: 1, why: 'Masks guide GPT image edits; detect drift with a diff and use preservation options where available.' },
  ],

  recap: 'Mask-based inpainting = image + same-size PNG mask with alpha (transparent = editable) + a prompt that names the target and replacement. Keep the mask tight, align it with the prompt, prefer instruction-only edits for global changes, and diff the result to catch drift outside the mask.',
};
