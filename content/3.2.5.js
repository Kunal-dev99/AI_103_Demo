// 3.2.5 Implement visual understanding by configuring Azure Content Understanding in Foundry Tools to extract visual characteristics
// Lab: Content Understanding field schema studio.
import { rng, clamp, round, step, metric, words } from '../src/engine/util.js';

// Synthetic product photos. Ground truth is what a human inspector would record.
const IMAGES = {
  mug_ok: {
    label: 'White mug, intact',
    truth: { color: 'white', damage: false, label: 'CONTOSO COFFEE', damageDesc: 'none' },
    quality: 1, damageSubtle: false,
    labelBox: { x: 36, y: 30, w: 22, h: 10 }, damageBox: null,
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#e9edf2' },
      { kind: 'rect', x: 30, y: 16, w: 34, h: 40, fill: '#fafafa' },
      { kind: 'circle', x: 70, y: 34, r: 7, fill: '#fafafa' },
      { kind: 'rect', x: 36, y: 30, w: 22, h: 10, fill: '#c0392b' },
      { kind: 'text', x: 37, y: 36, text: 'CONTOSO' },
    ],
  },
  mug_chipped: {
    label: 'Blue mug, small chip on rim',
    truth: { color: 'blue', damage: true, label: 'CONTOSO COFFEE', damageDesc: 'Small chip on the rim, top left' },
    quality: 1, damageSubtle: true,
    labelBox: { x: 36, y: 30, w: 22, h: 10 }, damageBox: { x: 29, y: 13, w: 8, h: 6 },
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#e9edf2' },
      { kind: 'rect', x: 30, y: 16, w: 34, h: 40, fill: '#2f6fd6' },
      { kind: 'circle', x: 70, y: 34, r: 7, fill: '#2f6fd6' },
      { kind: 'circle', x: 33, y: 16, r: 2, fill: '#e9edf2' },
      { kind: 'rect', x: 36, y: 30, w: 22, h: 10, fill: '#ffffff' },
      { kind: 'text', x: 37, y: 36, text: 'CONTOSO' },
    ],
  },
  box_dented: {
    label: 'Shipping box, dented corner',
    truth: { color: 'brown', damage: true, label: 'FRAGILE THIS SIDE UP', damageDesc: 'Dented corner, bottom right' },
    quality: 0.95, damageSubtle: false,
    labelBox: { x: 26, y: 22, w: 36, h: 10 }, damageBox: { x: 66, y: 48, w: 12, h: 12 },
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#eef0f3' },
      { kind: 'rect', x: 18, y: 12, w: 62, h: 48, fill: '#b07a45' },
      { kind: 'line', x: 70, y: 60, x2: 80, y2: 50, tone: 'muted' },
      { kind: 'rect', x: 26, y: 22, w: 36, h: 10, fill: '#ffffff' },
      { kind: 'text', x: 27, y: 28, text: 'FRAGILE ↑' },
    ],
  },
  blurry: {
    label: 'Red kettle, blurry phone photo',
    truth: { color: 'red', damage: true, label: 'NORTHWIND', damageDesc: 'Hairline crack on the spout' },
    quality: 0.55, damageSubtle: true,
    labelBox: { x: 34, y: 34, w: 24, h: 8 }, damageBox: { x: 66, y: 24, w: 10, h: 8 },
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#dfe3e8' },
      { kind: 'circle', x: 46, y: 38, r: 20, fill: '#d0453a' },
      { kind: 'line', x: 62, y: 32, x2: 76, y2: 24, tone: 'error' },
      { kind: 'rect', x: 34, y: 34, w: 24, h: 8, fill: '#f2c9c5' },
      { kind: 'text', x: 35, y: 40, text: 'N0RTHW…' },
    ],
  },
};

const CONCEPTS = {
  color: { types: ['string'], match: (n, d) => /colou?r/.test(n + ' ' + d) },
  damageBool: { types: ['boolean'], match: (n, d, t) => /damage|chip|crack|dent|defect/.test(n + ' ' + d) && t === 'boolean' },
  damageDesc: { types: ['string'], match: (n, d, t) => /damage|chip|crack|dent|defect/.test(n + ' ' + d) && t !== 'boolean' },
  label: { types: ['string'], match: (n, d) => /label|printed|text|brand/.test(n + ' ' + d) },
};
const TYPES = ['string', 'boolean', 'number', 'integer', 'date'];
const METHODS = ['generate', 'classify', 'extract'];
const VAGUE = new Set(['info', 'information', 'details', 'detail', 'data', 'stuff', 'thing', 'things', 'about', 'the', 'image', 'it', 'any']);

function parseSchema(text) {
  const fields = [], errors = [];
  String(text || '').split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const parts = line.split('|').map(s => s.trim());
    const [name, type, method, description = '', enumList = ''] = parts;
    if (parts.length < 3 || !name) { errors.push(`line ${i + 1}: expected Name|type|method|description|enum`); return; }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) { errors.push(`line ${i + 1}: invalid field name "${name}"`); return; }
    if (!TYPES.includes(type)) { errors.push(`${name}: unknown type "${type}"`); return; }
    if (!METHODS.includes(method)) { errors.push(`${name}: unknown method "${method}"`); return; }
    const en = enumList.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (method === 'classify' && !en.length) { errors.push(`${name}: method "classify" requires an enum list`); return; }
    fields.push({ name, type, method, description, enum: en });
  });
  if (!fields.length && !errors.length) errors.push('schema has no fields');
  return { fields, errors };
}

function specificity(desc) {
  const w = words(desc).filter(x => x.length > 2 && !VAGUE.has(x));
  return clamp(w.length / 6, 0, 1); // 6+ meaningful words = fully specific in this simulation
}

function extractField(f, img, p, r) {
  const n = f.name.toLowerCase(), d = f.description.toLowerCase();
  const concept = Object.keys(CONCEPTS).find(k => CONCEPTS[k].match(n, d, f.type));
  const spec = specificity(f.description);
  const issues = [];
  let conf = 0.93 - (1 - img.quality) * 0.6 - (1 - spec) * 0.3 + (r() - 0.5) * 0.04;
  let value = null, correct = false, box = null;
  if (p.base === 'document' && concept !== 'label') { conf -= 0.45; issues.push('document base analyzer is text/layout oriented; visual attributes are weak'); }
  if (!concept) {
    issues.push('description matches nothing visible in the image');
    return { ...f, concept: '—', value: null, conf: round(clamp(conf - 0.5, 0.05, 0.99), 2), correct: false, issues, box };
  }
  if (!CONCEPTS[concept].types.includes(f.type)) issues.push(`type "${f.type}" does not fit this characteristic`);
  if (f.method === 'extract') { issues.push('extract returns text as it appears; for visual characteristics of images use generate or classify (check the modality support matrix)'); conf -= 0.15; }
  const t = img.truth;
  if (concept === 'color') {
    if (f.method === 'classify') {
      if (f.enum.includes(t.color)) { value = t.color; correct = true; }
      else if (f.enum.includes('other')) { value = 'other'; issues.push(`true colour "${t.color}" is not in the enum; mapped to "other"`); conf -= 0.1; }
      else { value = f.enum[0]; issues.push(`true colour "${t.color}" is not in the enum; forced to nearest category`); conf -= 0.35; }
    } else { value = spec > 0.5 ? `${t.color}` + (t.color === 'brown' ? ' (cardboard)' : '') : `mostly ${t.color} with some other tones`; correct = value === t.color; if (!correct) issues.push('free-text value is not normalised; use classify with an enum for consistent values'); }
  } else if (concept === 'damageBool') {
    const sees = !(img.damageSubtle && (spec < 0.5 || img.quality < 0.7));
    value = f.type === 'boolean' ? (sees ? t.damage : false) : (sees && t.damage ? 1 : 0);
    correct = value === t.damage;
    if (!sees && t.damage) issues.push('subtle damage missed: the description does not tell the model what counts as damage');
    if (img.damageBox && value) box = img.damageBox;
  } else if (concept === 'damageDesc') {
    value = spec >= 0.5 ? t.damageDesc : (t.damage ? 'The item looks used.' : 'Looks fine.');
    correct = value === t.damageDesc;
    if (!correct) issues.push('generic answer: the description does not ask for location and type of damage');
    if (img.damageBox && t.damage) box = img.damageBox;
  } else if (concept === 'label') {
    value = img.quality < 0.7 ? t.label.slice(0, 6) + '…' : t.label;
    correct = value === t.label;
    if (!correct) issues.push('label partly unreadable at this image quality');
    box = img.labelBox;
  }
  if (!CONCEPTS[concept].types.includes(f.type)) correct = false;
  return { ...f, concept, value, conf: round(clamp(conf, 0.05, 0.99), 2), correct, issues, box };
}

function run(p) {
  const img = IMAGES[p.image] || IMAGES.mug_ok;
  const r = rng(`${p.image}|${p.schema}|${p.base}`);
  const steps = [];

  if (p.role === 'reader') {
    steps.push(step('auth', 'Request denied (403)', 'The identity has only the Reader role on the Foundry resource. Reader is a control-plane role: it cannot call data-plane analyze operations.', { httpStatus: 403, role: 'Reader', needs: 'Cognitive Services User (or a role with the data actions)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Assign the Cognitive Services User role to the app’s managed identity on the Foundry resource.' }], metrics: [], summary: 'Denied: missing data-plane role' };
  }
  steps.push(step('auth', 'Authenticated', 'DefaultAzureCredential → managed identity with Cognitive Services User.', { role: 'Cognitive Services User' }));

  const { fields, errors } = parseSchema(p.schema);
  if (errors.length) {
    steps.push(step('analyzer', 'Analyzer definition rejected', 'The field schema is invalid, so the analyzer cannot be created or updated.', { errors }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: errors.join(' • ') }, { type: 'code', title: 'Expected line format', text: 'FieldName|type|method|description|enum,values\nPrimaryColor|string|classify|Dominant colour of the product body|white,blue,red,other' }], metrics: [], summary: 'Schema invalid' };
  }
  if (p.models === 'missing') {
    steps.push(step('analyzer', 'Analyzer cannot run: no model deployment', 'Generative fields (generate/classify) need a chat model deployment that Content Understanding is configured to use. In the GA API you set default model deployments for the resource (or name models on the analyzer); none is configured here.', { completionModel: null }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Deploy a supported chat (and embedding) model in the Foundry resource and set it as the Content Understanding default, then retry. Exact model list and API version: see the docs.' }], metrics: [], summary: 'No model deployment configured' };
  }
  const baseId = p.base === 'image' ? 'prebuilt-image' : 'prebuilt-document';
  steps.push(step('analyzer', 'Analyzer ready', `Custom analyzer on ${baseId} with ${fields.length} field(s).`, { baseAnalyzerId: `${baseId} (illustrative; preview APIs used e.g. prebuilt-imageAnalyzer)`, fields: fields.map(f => `${f.name}: ${f.type}/${f.method}`) }, p.base === 'image' ? 'ok' : 'warn'));

  steps.push(step('analyze', 'Image analyzed', `${img.label}${img.quality < 0.7 ? ' • low quality input' : ''}. Long-running operation: POST analyze, poll the result.`, { quality: img.quality }, img.quality < 0.7 ? 'warn' : 'ok'));

  const res = fields.map(f => extractField(f, img, p, r));
  const below = res.filter(f => f.conf < p.threshold);
  const problems = res.filter(f => f.issues.length);
  steps.push(step('fields', 'Fields returned', `${res.length} field(s); ${problems.length} with issues; ${p.grounding ? `${below.length} below ${p.threshold}` : 'no confidence requested'}.`,
    Object.fromEntries(res.map(f => [f.name, { value: f.value, ...(p.grounding ? { confidence: f.conf } : {}), issues: f.issues }])), problems.length ? 'warn' : 'ok'));

  let route;
  if (!p.grounding) route = { status: 'warn', title: 'Cannot route automatically', text: 'No confidence or source returned, so the app cannot decide which values to trust. Turn on source/confidence estimation where the modality supports it, or review everything.' };
  else if (problems.length || below.length) route = { status: 'warn', title: 'Sent to inspector review', text: `${below.length} low-confidence and ${problems.length} problematic field(s).` };
  else route = { status: 'ok', title: 'Auto-accepted', text: 'All fields well-typed and above threshold.' };
  steps.push(step('route', route.title, route.text, { threshold: p.threshold }, route.status));

  const shapes = [...img.scene];
  if (p.grounding) for (const f of res) if (f.box) shapes.push({ kind: 'box', ...f.box, label: `${f.name} ${f.conf.toFixed(2)}`, tone: f.conf < p.threshold ? 'warn' : 'ok' });
  const correct = res.filter(f => f.correct).length;

  return {
    steps,
    output: [
      { type: 'image', title: `${img.label}${p.grounding ? ' with field grounding' : ''}`, shapes },
      { type: 'table', title: 'Extracted visual characteristics', columns: ['Field', 'Type / method', 'Value', 'Confidence', 'Matches inspector', 'Notes'],
        rows: res.map(f => [f.name, `${f.type} / ${f.method}`, f.value == null ? '—' : String(f.value), p.grounding ? f.conf.toFixed(2) : 'n/a', f.correct ? 'yes' : 'no', f.issues.join('; ') || '—']),
        tones: res.map(f => !f.correct ? 'error' : f.issues.length || (p.grounding && f.conf < p.threshold) ? 'warn' : 'ok') },
      { type: 'json', title: 'Analyzer definition (illustrative shape)', data: {
        description: 'Product condition analyzer', baseAnalyzerId: baseId,
        config: { estimateFieldSourceAndConfidence: !!p.grounding },
        fieldSchema: { fields: Object.fromEntries(fields.map(f => [f.name, { type: f.type, method: f.method, description: f.description, ...(f.enum.length ? { enum: f.enum } : {}) }])) },
      } },
    ],
    metrics: [
      metric('Fields matching inspector', `${correct}/${res.length}`, 'computed', 'Compared with the synthetic ground truth for this image.'),
      metric('Fields below threshold', p.grounding ? String(below.length) : 'n/a', 'computed'),
      metric('Relative cost per image', p.grounding ? 'higher' : 'baseline', 'estimate', 'Generative fields and confidence estimation consume model tokens billed through your deployment. See the Content Understanding pricing page.'),
    ],
    summary: `${img.label}: ${correct}/${res.length} correct • ${route.title}`,
  };
}

const DEFAULT_SCHEMA = [
  'PrimaryColor|string|classify|Dominant colour of the product body, ignoring labels and background|white,blue,red,other',
  'DamagePresent|boolean|generate|True if the product shows any visible chip, crack, dent, tear or scratch, including small ones on rims and corners',
  'LabelText|string|generate|Exact text printed on the main product label, preserving capitalisation',
  'DamageDescription|string|generate|One sentence giving the type and location of each visible defect, or none',
].join('\n');

export default {
  id: '3.2.5',
  lab: 'Content Understanding field schema studio',
  services: [
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/overview' },
    { name: 'Content Understanding: image solutions', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/image/overview' },
    { name: 'Analyzer field schema', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/analyzer-reference' },
  ],
  prereqs: ['3.2.1', '5.2.1'],
  next: ['3.2.6', '3.2.7'],

  concept: {
    plain: 'Content Understanding lets you describe, in plain words, the facts you want from a picture: "what colour is it", "is it damaged", "what does the label say". Each fact is a field with a type and a description. The service looks at the image and fills in the fields. How good the answers are depends mostly on how precisely you describe each field and whether you pick the right kind of answer: a fixed list of choices, a yes/no, or free text.',
    technical: 'An analyzer is created from a base analyzer (image modality) plus a fieldSchema. Each field declares type (string, boolean, number, integer, date, array, object), method (generate = model produces the value; classify = choose from an enum; extract = take the value as it appears, which is document-oriented) and a description that acts as the instruction. Generative methods use the chat model deployment configured for the resource. Results return per-field values and, where supported for the modality, confidence and source grounding, which your app uses for routing. Calls are authenticated with Entra ID (Cognitive Services User role) and are long-running operations.',
    useCase: 'A returns centre photographs every item received. A Content Understanding analyzer returns PrimaryColor (classify), DamagePresent (boolean), LabelText and DamageDescription. Undamaged items with confident fields are restocked automatically; anything damaged or low-confidence goes to an inspector with the grounding boxes highlighted.',
    terms: [
      ['Analyzer', 'A reusable configuration: base analyzer + field schema + config, called by ID.'],
      ['Field method', 'generate (free value from the model), classify (pick from enum), extract (verbatim, document-oriented).'],
      ['Field description', 'Natural-language instruction for the field. It is the main quality lever.'],
      ['Grounding', 'The region of the input that supports a value, returned with a confidence where supported.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'auth', label: 'Caller identity', col: 0, row: 1, kind: 'user', detail: 'Entra ID token for a principal with a data-plane role.' },
          { id: 'analyzer', label: 'Field schema', col: 1, row: 0, kind: 'policy', detail: 'Each field: name, type, method, description, optional enum.', substeps: ['Choose type', 'Choose method', 'Write a precise description', 'Enum for classify'] },
          { id: 'analyze', label: 'Image analysis', col: 2, row: 1, kind: 'ai', detail: 'Visual features + generative model fill the fields.' },
          { id: 'fields', label: 'Field values', col: 3, row: 1, kind: 'data', detail: 'Value, confidence and grounding per field.', badge: p && p.grounding ? 'grounded' : undefined },
          { id: 'route', label: 'Accept or review', col: 4, row: 1, kind: 'app', detail: 'Your threshold decides what is trusted.' },
        ],
        edges: [['auth', 'analyze'], ['analyzer', 'analyze'], ['analyze', 'fields'], ['fields', 'route']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'auth', label: 'App (managed identity)', col: 0, row: 1, kind: 'app', detail: 'Needs Cognitive Services User on the resource. Reader is not enough.', badge: p && p.role === 'reader' ? 'Reader ✗' : undefined },
          { id: 'analyzer', label: `Analyzer on ${p && p.base === 'document' ? 'prebuilt-document' : 'prebuilt-image'}`, col: 1, row: 0, kind: 'policy', detail: 'Stored in the Foundry resource; created with PUT /analyzers/{id}.' },
          { id: 'models', label: 'Chat + embedding deployments', col: 1, row: 2, kind: 'ai', detail: 'Used by generative fields. Configured as resource defaults or per analyzer (GA API; check docs).', disabled: p && p.models === 'missing', badge: p && p.models === 'missing' ? 'missing' : undefined },
          { id: 'analyze', label: 'Content Understanding', col: 2, row: 1, kind: 'ai', detail: 'Foundry Tools service endpoint.' },
          { id: 'fields', label: 'Result JSON', col: 3, row: 1, kind: 'data', detail: 'contents[].fields with values (+ confidence/source where supported).' },
          { id: 'route', label: 'Inspection app', col: 4, row: 1, kind: 'app', detail: 'Restock or route to inspector.' },
        ],
        edges: [['auth', 'analyze', 'analyze'], ['analyzer', 'analyze'], ['models', 'analyze'], ['analyze', 'fields'], ['fields', 'route']],
      }),
      implementation: () => ({
        nodes: [
          { id: 'auth', label: 'cred = DefaultAzureCredential()', col: 0, row: 0, kind: 'code', detail: 'Keyless auth.' },
          { id: 'analyzer', label: 'PUT {endpoint}/contentunderstanding/analyzers/{id}?api-version=...  body: {baseAnalyzerId, fieldSchema}', col: 0, row: 1, kind: 'code', detail: 'REST shape is illustrative; an SDK may wrap it. Check the current API version.' },
          { id: 'analyze', label: 'POST .../analyzers/{id}:analyze  → Operation-Location', col: 0, row: 2, kind: 'code', detail: 'Long-running: poll until status is Succeeded.' },
          { id: 'fields', label: 'fields = result["contents"][0]["fields"]', col: 0, row: 3, kind: 'code', detail: 'Each field has a type-specific value property.' },
          { id: 'route', label: 'if any(f.confidence < T for f in fields): review()', col: 0, row: 4, kind: 'code', detail: 'Your routing rule.' },
        ],
        edges: [['auth', 'analyzer'], ['analyzer', 'analyze'], ['analyze', 'fields'], ['fields', 'route']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'image', label: 'Sample image', type: 'select', options: Object.entries(IMAGES).map(([v, i]) => [v, i.label]), default: 'mug_chipped' },
      { id: 'schema', label: 'Field schema (Name|type|method|description|enum)', type: 'textarea', default: DEFAULT_SCHEMA, help: 'One field per line. method: generate, classify or extract. classify needs a comma-separated enum.' },
      { id: 'base', label: 'Base analyzer', type: 'select', options: [['image', 'Image base analyzer'], ['document', 'Document base analyzer']], default: 'image' },
      { id: 'grounding', label: 'Estimate source & confidence', type: 'toggle', default: true, help: 'Support differs by modality and API version; see docs.' },
      { id: 'threshold', label: 'Auto-accept threshold', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.75 },
      { id: 'role', label: 'App identity role', type: 'select', options: [['user', 'Cognitive Services User'], ['reader', 'Reader only']], default: 'user' },
      { id: 'models', label: 'Model deployment defaults', type: 'select', options: [['set', 'Configured'], ['missing', 'Not configured']], default: 'set' },
    ],
    samples: [
      { label: 'Chipped mug, good schema', values: { image: 'mug_chipped' } },
      { label: 'Dented box (colour not in enum)', values: { image: 'box_dented' } },
      { label: 'Blurry kettle photo', values: { image: 'blurry' } },
      { label: 'Vague descriptions', values: { image: 'mug_chipped', schema: 'Colour|string|generate|colour\nDamaged|boolean|generate|damage info\nLabel|string|generate|text' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the chipped mug with the default schema, then with the "Vague descriptions" sample, and compare DamagePresent.',
      'Run the dented box with enum "white,blue,red,other" and then add "brown": what changes in PrimaryColor?',
      'Change LabelText’s method from generate to extract and compare the notes.',
      'Switch the base analyzer to document on the mug and compare confidences.',
    ],
  },

  debug: [
    { id: 'enum', title: 'Analyzer creation fails', values: { schema: 'PrimaryColor|string|classify|Dominant colour of the product body\nDamagePresent|boolean|generate|True if any visible chip, crack or dent' }, node: 'analyzer',
      symptom: 'Analyzer definition rejected: classify requires an enum list.', cause: 'A classify field without categories (malformed schema).', fix: 'Add the enum values after the description, e.g. "|white,blue,red,brown,other".' },
    { id: 'vague', title: 'Chip on the rim not detected', values: { image: 'mug_chipped', schema: 'Colour|string|classify|colour|white,blue,red,other\nDamaged|boolean|generate|damage info' }, node: 'fields',
      symptom: 'Damaged = false on a chipped mug; low confidence.', cause: 'Field descriptions are too vague: the model is not told that small chips on rims count as damage.', fix: 'Write specific descriptions (what counts, where to look); restore the default schema.' },
    { id: 'type', title: 'Damage comes back as a number', values: { schema: 'PrimaryColor|string|classify|Dominant colour of the product body, ignoring labels|white,blue,red,other\nDamagePresent|number|generate|1 if the product shows any visible chip, crack, dent or scratch, including small ones on rims' }, node: 'fields',
      symptom: 'DamagePresent is 1 instead of true and flagged as a type mismatch.', cause: 'Wrong field type for a yes/no characteristic.', fix: 'Use type boolean for yes/no characteristics.' },
    { id: 'role', title: '403 on analyze', values: { role: 'reader' }, node: 'auth',
      symptom: 'Request denied before analysis.', cause: 'Reader is a control-plane role without data actions (permission problem).', fix: 'Grant Cognitive Services User to the managed identity.' },
    { id: 'models', title: 'Analyzer has no model to run on', values: { models: 'missing' }, node: 'analyzer',
      symptom: 'Analyzer cannot run generative fields.', cause: 'No chat model deployment configured for Content Understanding (downstream dependency missing).', fix: 'Deploy a supported model and set it as the default (Model deployment defaults = Configured).' },
  ],

  challenge: {
    task: 'For the dented shipping box, return PrimaryColor = "brown" via classify and get every field auto-accepted at a threshold of at least 0.75.',
    condition: 'Image = shipping box, threshold ≥ 0.75, PrimaryColor value is brown, final routing step is ok.',
    hint: 'A classifier can only answer with a category you gave it.',
    check: (p, res) => p.image === 'box_dented' && p.threshold >= 0.75 && res.steps.at(-1).status === 'ok' && /classify/.test(p.schema) && JSON.stringify(res.steps.find(s => s.node === 'fields')?.data?.PrimaryColor?.value) === '"brown"',
    solution: ['Select the dented shipping box.', 'Add "brown" to the PrimaryColor enum (white,blue,red,brown,other).', 'Keep specific descriptions, generate for LabelText, image base analyzer and confidence estimation on.', 'Keep the threshold at 0.75 and run.'],
    solutionValues: { image: 'box_dented', threshold: 0.75, base: 'image', grounding: true, role: 'user', models: 'set', schema: DEFAULT_SCHEMA.replace('white,blue,red,other', 'white,blue,red,brown,other') },
  },

  quiz: [
    { q: 'You need product colour normalised to one of five catalogue values. Which field configuration fits best?', options: ['string / generate with description "colour"', 'string / classify with an enum of the five values (plus "other")', 'string / extract', 'number / generate'], answer: 1, why: 'classify constrains output to your categories, which makes downstream matching reliable; include "other" for unexpected values.' },
    { q: 'DamagePresent keeps returning false for small chips. Schema: boolean / generate, description "damage info". What should you change first?', options: ['Switch to a document base analyzer', 'Rewrite the description to say exactly what counts as damage and where to look', 'Lower the confidence threshold', 'Change the type to string'], answer: 1, why: 'The description is the instruction the model follows. Vague descriptions give vague results.' },
    { q: 'An app with a managed identity gets 403 when calling analyze. The identity has Reader on the Foundry resource. What fixes it?', options: ['Use a larger model', 'Assign Cognitive Services User (data-plane) to the identity', 'Use an API version with preview', 'Add the identity to the analyzer’s field schema'], answer: 1, why: 'Reader grants control-plane read only; analyze is a data-plane action.' },
  ],

  recap: 'In Content Understanding the field schema is the program: pick the right type, use classify with a complete enum for categorical attributes, write specific descriptions, request confidence and grounding where supported, and route low-confidence fields to review. Remember the identity needs a data-plane role and generative fields need a configured model deployment.',
};
