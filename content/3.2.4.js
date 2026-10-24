// 3.2.4 Configure generation of alt-text and extended image descriptions aligned to accessibility guidelines
// Lab: Alt-text accessibility workshop.
import { step, metric, estTokens, words } from '../src/engine/util.js';

// Sample images. truePurpose = what an accessibility reviewer would decide for this image in its page.
// `scene` is drawn by the image block (100 x 70 canvas).
const IMAGES = {
  product: {
    label: 'Product photo (shoe on product page)',
    truePurpose: 'informative',
    look: 'a blue running shoe with orange laces, side view on a white background',
    subject: 'running shoe in blue with orange laces',
    named: 'Contoso TrailRunner 3',
    nameKey: 'trailrunner',
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#f6f7f9' },
      { kind: 'rect', x: 20, y: 30, w: 56, h: 18, fill: '#2f6fd6' },
      { kind: 'rect', x: 60, y: 22, w: 16, h: 10, fill: '#2f6fd6' },
      { kind: 'line', x: 34, y: 32, x2: 58, y2: 30, tone: 'warn' },
      { kind: 'line', x: 36, y: 36, x2: 58, y2: 34, tone: 'warn' },
      { kind: 'rect', x: 18, y: 48, w: 60, h: 4, fill: '#333' },
    ],
  },
  logo: {
    label: 'Company logo (links to home page)',
    truePurpose: 'functional',
    look: 'a stylised blue hexagon next to the word Contoso',
    subject: 'Contoso logo',
    action: 'Contoso home page',
    contextKeys: ['link', 'home', 'navigation', 'nav'],
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#ffffff' },
      { kind: 'circle', x: 28, y: 35, r: 12, fill: '#2f6fd6' },
      { kind: 'text', x: 44, y: 38, text: 'Contoso' },
    ],
  },
  hero: {
    label: 'Hero banner (blurred mountains behind headline)',
    truePurpose: 'decorative',
    look: 'a soft-focus photo of misty mountains at sunrise',
    subject: 'misty mountains at sunrise',
    contextKeys: ['decorative', 'background', 'banner', 'mood'],
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#f3d9c4' },
      { kind: 'line', x: 0, y: 55, x2: 30, y2: 25, tone: 'muted' },
      { kind: 'line', x: 30, y: 25, x2: 55, y2: 50, tone: 'muted' },
      { kind: 'line', x: 45, y: 42, x2: 72, y2: 18, tone: 'muted' },
      { kind: 'line', x: 72, y: 18, x2: 100, y2: 50, tone: 'muted' },
      { kind: 'text', x: 22, y: 64, text: 'Run further. (headline is real HTML text)' },
    ],
  },
  chart: {
    label: 'Bar chart (quarterly sales)',
    truePurpose: 'complex',
    look: 'a bar chart with four blue bars of different heights',
    subject: 'bar chart of quarterly sales',
    summary: 'Bar chart: 2026 sales by quarter, lowest in Q3 and peaking in Q4 at $180k',
    data: [['Q1', 120], ['Q2', 150], ['Q3', 90], ['Q4', 180]],
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#ffffff' },
      { kind: 'line', x: 12, y: 60, x2: 92, y2: 60, tone: 'muted' },
      { kind: 'rect', x: 18, y: 36, w: 12, h: 24, fill: '#2f6fd6', label: 'Q1' },
      { kind: 'rect', x: 36, y: 30, w: 12, h: 30, fill: '#2f6fd6', label: 'Q2' },
      { kind: 'rect', x: 54, y: 42, w: 12, h: 18, fill: '#2f6fd6', label: 'Q3' },
      { kind: 'rect', x: 72, y: 24, w: 12, h: 36, fill: '#2f6fd6', label: 'Q4' },
      { kind: 'text', x: 20, y: 12, text: 'Sales 2026 ($k)' },
    ],
  },
  button: {
    label: 'Icon-only search button',
    truePurpose: 'functional',
    look: 'a grey magnifying-glass icon',
    subject: 'magnifying-glass icon',
    action: 'Search',
    contextKeys: ['button', 'search', 'submit', 'form'],
    scene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#ffffff' },
      { kind: 'rect', x: 10, y: 26, w: 62, h: 18, fill: '#eef1f5' },
      { kind: 'rect', x: 72, y: 26, w: 18, h: 18, fill: '#d8dde5' },
      { kind: 'circle', x: 80, y: 34, r: 4, fill: '#ffffff' },
      { kind: 'line', x: 83, y: 37, x2: 87, y2: 41, tone: 'muted' },
    ],
  },
};

const MODELS = {
  multimodal: { label: 'Multimodal chat model (e.g. a GPT-4o-class deployment)', vision: true, follows: true },
  caption: { label: 'Azure AI Vision image captioning', vision: true, follows: false },
  textonly: { label: 'Text-only model deployment', vision: false, follows: true },
};

const PURPOSES = [['auto', 'Let the model infer from page context'], ['informative', 'Informative'], ['functional', 'Functional (link / button)'], ['decorative', 'Decorative'], ['complex', 'Complex (chart / diagram)']];

const GUIDED_PROMPT = 'You write alt text for screen-reader users. Convey the purpose of the image in its page context, not its appearance. Do not start with "image of" or "picture of". Keep alt under {N} characters. For functional images describe the action or destination. For decorative images return an empty string. For charts and diagrams return a short alt plus an extended description that includes the data.';

function inferPurpose(img, p) {
  if (p.purpose !== 'auto') return { purpose: p.purpose, how: 'declared by the developer' };
  const ctx = words(p.context);
  if (!MODELS[p.model].follows) return { purpose: 'informative', how: 'captioning service has no notion of purpose; treated as informative' };
  if (img.truePurpose === 'informative' || img.truePurpose === 'complex') return { purpose: img.truePurpose, how: 'inferred from image content' };
  const hit = (img.contextKeys || []).some(k => ctx.includes(k));
  if (hit) return { purpose: img.truePurpose, how: 'inferred from page context' };
  return { purpose: 'informative', how: 'page context gave no hint, so the model guessed "informative"' };
}

function generate(img, purpose, p) {
  const maxLen = p.maxLen;
  const ctx = words(p.context);
  const knowsName = img.nameKey && ctx.includes(img.nameKey);
  if (MODELS[p.model].follows === false) {
    // Captioning: short, appearance-only, lower-case, no purpose awareness, no extended description.
    const cap = { product: 'a blue shoe on a white surface', logo: 'a blue circle and text', hero: 'a mountain range in the fog', chart: 'a bar graph', button: 'a magnifying glass' }[p.image];
    return { alt: cap, extended: '' };
  }
  if (p.style === 'naive') {
    let alt = `Image of ${img.look}`;
    if (p.detail === 'detailed') alt += `. The image is well lit and shows the ${img.subject} clearly in the centre of the frame, with plenty of empty space around it`;
    alt += '.';
    return { alt, extended: '' };
  }
  // Guided prompt: purpose-aware.
  let alt = '', extended = '';
  if (purpose === 'decorative') alt = '';
  else if (purpose === 'functional') alt = img.action || img.subject;
  else if (purpose === 'complex') {
    alt = img.summary || `Diagram: ${img.subject}`;
    if (p.extended) extended = img.data ? `${img.subject[0].toUpperCase() + img.subject.slice(1)}, values in $k: ` + img.data.map(([k, v]) => `${k} ${v}`).join(', ') + '. Q4 is the highest quarter, Q3 the lowest.' : `Detailed description of ${img.subject}.`;
  } else {
    const name = knowsName ? `${img.named} ` : '';
    const short = `${name}${img.subject}`;
    const long = `${short}, ${img.look.split(',').slice(1).join(',').trim() || 'shown in full'}`;
    alt = p.detail === 'detailed' && long.length <= maxLen ? long : short;
    alt = alt[0].toUpperCase() + alt.slice(1);
    if (p.extended && p.detail === 'detailed') extended = `Extended description: ${img.look}.`;
  }
  if (alt.length > maxLen) {
    // The prompt carries the limit; the model shortens, and very tight limits force truncation.
    alt = alt.slice(0, Math.max(0, maxLen - 1)).replace(/\s+\S*$/, '') + '…';
  }
  return { alt, extended };
}

function rubric(img, purpose, gen, p) {
  const t = img.truePurpose;
  const alt = gen.alt;
  const checks = [];
  const add = (rule, pass, evidence, severity = 'warn', applies = true) => checks.push({ rule, pass, evidence, severity, applies });
  add('Purpose classified correctly', purpose === t, `Used "${purpose}", reviewer expects "${t}".`, 'warn');
  add('Decorative image has empty alt (alt="")', alt === '', t === 'decorative' ? (alt ? `alt has ${alt.length} chars: screen readers will announce noise.` : 'Empty alt: assistive tech skips it.') : 'n/a', 'warn', t === 'decorative');
  add('No redundant prefix ("image of", "picture of")', !/^(an? )?(image|picture|photo|graphic) of/i.test(alt), alt ? `Starts: "${alt.slice(0, 20)}…"` : 'empty', 'warn', t !== 'decorative');
  add(`Concise (≤ ${p.maxLen} chars, not truncated)`, alt.length <= p.maxLen && !alt.endsWith('…'), `${alt.length} chars${alt.endsWith('…') ? ', truncated mid-thought' : ''}.`, 'warn', t !== 'decorative');
  add('Functional image names the action/destination', !!img.action && alt.toLowerCase().includes(img.action.toLowerCase()), `Expected something like "${img.action}".`, 'error', t === 'functional');
  add('Informative alt carries page-specific detail', !!img.named && alt.toLowerCase().includes(img.named.toLowerCase()), img.named ? `Page is about "${img.named}".` : 'n/a', 'warn', t === 'informative');
  add('Complex image has an extended description with the data', !!gen.extended && /\d/.test(gen.extended), gen.extended ? `${gen.extended.length} chars of long description.` : 'No long description: the data is invisible to screen-reader users.', 'error', t === 'complex');
  add('Alt text present for non-decorative image', alt !== '', alt ? 'present' : 'missing: screen reader may read the file name', 'error', t !== 'decorative');
  return checks.filter(c => c.applies);
}

function htmlFor(img, gen, p) {
  const esc = s => s.replace(/"/g, '&quot;');
  if (img.truePurpose === 'functional' && p.image === 'logo') return `<a href="/">\n  <img src="logo.svg" alt="${esc(gen.alt)}">\n</a>`;
  if (img.truePurpose === 'functional') return `<button type="submit">\n  <img src="search.svg" alt="${esc(gen.alt)}">\n</button>`;
  if (gen.extended) return `<figure>\n  <img src="${p.image}.png" alt="${esc(gen.alt)}" aria-describedby="${p.image}-desc">\n  <figcaption id="${p.image}-desc">${gen.extended}</figcaption>\n</figure>`;
  return `<img src="${p.image}.jpg" alt="${esc(gen.alt)}">`;
}

function run(p) {
  const img = IMAGES[p.image] || IMAGES.product;
  const model = MODELS[p.model] || MODELS.multimodal;
  const steps = [];
  const prompt = p.style === 'guided' ? GUIDED_PROMPT.replace('{N}', p.maxLen) : 'Describe this image.';

  steps.push(step('input', 'Image + page context received', `${img.label}. Context: ${p.context ? `"${p.context.slice(0, 80)}${p.context.length > 80 ? '…' : ''}"` : '(none)'}`,
    { image: p.image, contextWords: words(p.context).length }, p.context ? 'ok' : 'warn'));

  if (!model.vision) {
    steps.push(step('generate', 'Model cannot see the image', 'The selected deployment accepts text only. In a real call the image content part is rejected (or ignored), so any alt text would be invented from the file name.', { model: p.model, error: 'image input not supported by this deployment (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Choose a vision-capable (multimodal) deployment or a vision captioning service.' }, { type: 'image', title: img.label, shapes: img.scene }], metrics: [], summary: 'Failed: text-only model' };
  }

  const inf = inferPurpose(img, p);
  steps.push(step('purpose', `Purpose: ${inf.purpose}`, `Image purpose ${inf.how}.`, { purpose: inf.purpose, expected: img.truePurpose }, inf.purpose === img.truePurpose ? 'ok' : 'warn'));

  const gen = generate(img, inf.purpose, p);
  steps.push(step('generate', 'Alt text generated', `${model.label} • ${p.style === 'guided' ? 'accessibility system prompt' : 'naive prompt'} • ${p.detail}.`,
    { prompt, alt: gen.alt, extendedDescription: gen.extended || null, estPromptTokens: estTokens(prompt) }, 'ok'));

  const checks = rubric(img, inf.purpose, gen, p);
  const passed = checks.filter(c => c.pass).length;
  const hardFail = checks.some(c => !c.pass && c.severity === 'error');
  const softFail = checks.some(c => !c.pass);
  steps.push(step('check', hardFail ? 'Accessibility check failed' : softFail ? 'Accessibility check: issues to fix' : 'Accessibility check passed', `${passed}/${checks.length} rubric checks pass.`,
    { failed: checks.filter(c => !c.pass).map(c => c.rule) }, hardFail ? 'error' : softFail ? 'warn' : 'ok'));

  const html = htmlFor(img, gen, p);
  steps.push(step('publish', hardFail ? 'Held for manual review' : 'Markup produced', hardFail ? 'A failing image is not published automatically; an editor must write or fix the description.' : 'Alt (and long description, if any) written into the page markup.', { html }, hardFail ? 'warn' : 'ok'));

  const naive = generate(img, inf.purpose, { ...p, style: 'naive', detail: 'concise' }).alt;
  const output = [
    { type: 'image', title: `${img.label} (synthetic scene)`, shapes: img.scene },
    { type: 'kv', title: 'Generated description', items: [['alt', gen.alt === '' ? '"" (empty: decorative)' : gen.alt], ['Length', `${gen.alt.length} / ${p.maxLen} chars`], ['Extended description', gen.extended || '—'], ['Purpose used', inf.purpose]] },
    { type: 'table', title: 'Accessibility rubric (simplified from WCAG 1.1.1 practice)', columns: ['Rule', 'Result', 'Evidence'],
      rows: checks.map(c => [c.rule, c.pass ? 'pass' : 'fail', c.evidence]), tones: checks.map(c => c.pass ? 'ok' : c.severity) },
    { type: 'diff', title: 'Naive "Describe this image" vs this configuration', before: naive, after: gen.alt === '' ? '(empty alt)' : gen.alt },
    { type: 'code', title: 'Resulting markup', lang: 'html', text: html },
  ];
  if (hardFail) output.push({ type: 'alert', tone: 'error', text: 'A screen-reader user would miss essential information. Fix the configuration before publishing.' });

  return {
    steps, output,
    metrics: [
      metric('Rubric score', `${passed}/${checks.length}`, 'computed', 'Simplified checks from common alt-text guidance; not a full WCAG audit.'),
      metric('Alt length', `${gen.alt.length} chars`, 'computed', '~125 chars is a widely used convention, not a WCAG rule.'),
      metric('Prompt size', `~${estTokens(prompt)} tokens`, 'estimate', '4-chars-per-token heuristic for the text part only; image tokens depend on resolution and detail setting.'),
    ],
    summary: `${p.image} • ${p.style} • ${inf.purpose}: ${passed}/${checks.length} checks${hardFail ? ' (blocking failure)' : ''}`,
  };
}

const DEFAULT_CONTEXT = 'Product page for the Contoso TrailRunner 3 running shoe. The logo in the header is a link to the home page. The hero banner is a decorative background behind the headline. The search button submits the site search form.';

export default {
  id: '3.2.4',
  lab: 'Alt-text accessibility workshop',
  services: [
    { name: 'Azure OpenAI vision-enabled chat models in Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/gpt-with-vision' },
    { name: 'Azure AI Vision image captions', url: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/concept-describe-images-40' },
  ],
  prereqs: ['3.2.1', '3.2.2'],
  next: ['3.2.3', '3.3.1'],

  concept: {
    plain: 'Alt text is what a screen reader says instead of showing an image. Good alt text tells the listener why the image is there, not just what it looks like: a logo that links home should say "Contoso home page", a decorative background should say nothing at all, and a chart needs a short summary plus a longer description that contains the actual numbers. An AI model can draft this, but only if you tell it the image purpose, the page context and the rules.',
    technical: 'Send the image (base64 or URL content part) plus page context to a vision-capable chat deployment with a system prompt that encodes the guidance: classify purpose (informative, functional, decorative, complex), omit "image of", respect a length budget, return an empty string for decorative images and a structured extended description for charts. Ask for JSON (alt, extendedDescription, purpose) so your code can validate it, then render alt="" or aria-describedby / figure+figcaption for long descriptions. Captioning APIs describe appearance only and are not purpose-aware, so they are a weaker fit on their own.',
    useCase: 'A retailer’s CMS auto-drafts alt text for 30,000 product and marketing images. A Foundry-hosted multimodal model receives each image with the page title and placement; drafts that fail a rubric (decorative image with text, chart without data, functional icon without its action) go to an editor queue instead of being published.',
    terms: [
      ['Alt text', 'Short text alternative in the img alt attribute, read by screen readers (WCAG 1.1.1 Non-text Content).'],
      ['Decorative image', 'Adds no information; uses alt="" so assistive technology skips it.'],
      ['Functional image', 'An image that is a link or button; its alt describes the action or destination.'],
      ['Extended description', 'A longer description (e.g. figcaption referenced by aria-describedby) for charts, diagrams and maps.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: 'Image + page context', col: 0, row: 1, kind: 'data', detail: 'The same image can need different alt text on different pages. Context is part of the input.' },
          { id: 'purpose', label: `Purpose: ${p ? (p.purpose === 'auto' ? 'inferred' : p.purpose) : 'classify'}`, col: 1, row: 1, detail: 'Informative, functional, decorative or complex. Drives everything that follows.', substeps: ['Is it a link or button?', 'Does it add information?', 'Does it contain data?'] },
          { id: 'generate', label: p && p.style === 'naive' ? 'Describe (naive prompt)' : 'Draft alt + long description', col: 2, row: 1, kind: 'ai', detail: 'A model drafts alt text following your rules.', badge: p ? `≤${p.maxLen}` : undefined },
          { id: 'check', label: 'Rubric check', col: 3, row: 1, kind: 'policy', detail: 'Automated checks before publishing.', substeps: ['No "image of"', 'Length budget', 'Empty for decorative', 'Action for functional', 'Data for charts'] },
          { id: 'publish', label: 'Markup', col: 4, row: 1, kind: 'app', detail: 'alt attribute, aria-describedby / figcaption for long descriptions.' },
        ],
        edges: [['input', 'purpose'], ['purpose', 'generate'], ['generate', 'check'], ['check', 'publish']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'CMS / Blob Storage', col: 0, row: 1, kind: 'store', detail: 'Images and page metadata (title, placement, link target).' },
          { id: 'purpose', label: 'Function: build request', col: 1, row: 1, kind: 'compute', detail: 'Adds page context and the accessibility system prompt; uses managed identity.' },
          { id: 'generate', label: p ? MODELS[p.model].label : 'Model', col: 2, row: 1, kind: 'ai', detail: 'Vision-capable deployment in a Foundry project, or Azure AI Vision captioning.', badge: p && !MODELS[p.model].vision ? 'no vision' : undefined },
          { id: 'check', label: 'Validation function', col: 3, row: 0, kind: 'policy', detail: 'Rubric rules in code; failures routed to editors.' },
          { id: 'review', label: 'Editor review queue', col: 3, row: 2, kind: 'user', detail: 'Humans fix or approve failing drafts.' },
          { id: 'publish', label: 'CMS publish', col: 4, row: 1, kind: 'app', detail: 'Writes alt/long description into templates.' },
        ],
        edges: [['input', 'purpose'], ['purpose', 'generate', 'chat.completions'], ['generate', 'check', 'JSON'], ['check', 'publish', 'pass'], ['check', 'review', 'fail'], ['review', 'publish']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'input', label: 'content = [{"type":"text","text":page_ctx}, {"type":"image_url","image_url":{"url":data_url}}]', col: 0, row: 0, kind: 'code', detail: 'Image as a content part next to the page context (illustrative shape of the chat completions API).' },
          { id: 'purpose', label: p && p.style === 'guided' ? 'messages=[{"role":"system","content":ALT_RULES}, ...]' : 'messages=[{"role":"user","content":"Describe this image."}]', col: 0, row: 1, kind: 'code', detail: 'The system prompt is where accessibility guidance lives.' },
          { id: 'generate', label: 'resp = client.chat.completions.create(model=DEPLOYMENT, messages=..., response_format={"type":"json_object"})', col: 0, row: 2, kind: 'code', detail: 'openai SDK against the Foundry/Azure OpenAI endpoint with Entra ID auth. Ask for JSON: {alt, extendedDescription, purpose}.' },
          { id: 'check', label: 'issues = rubric(json.loads(resp.choices[0].message.content))', col: 0, row: 3, kind: 'code', detail: 'Your validation code (illustrative).' },
          { id: 'publish', label: 'render(alt or "", aria_describedby=long_desc_id)', col: 0, row: 4, kind: 'code', detail: 'Template output.' },
        ],
        edges: [['input', 'purpose'], ['purpose', 'generate'], ['generate', 'check'], ['check', 'publish']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'image', label: 'Image', type: 'select', options: Object.entries(IMAGES).map(([v, i]) => [v, i.label]), default: 'product' },
      { id: 'context', label: 'Page context sent with the image', type: 'textarea', default: DEFAULT_CONTEXT, help: 'Where and why the image appears. Purpose often cannot be inferred from pixels alone.' },
      { id: 'purpose', label: 'Image purpose', type: 'select', options: PURPOSES, default: 'auto' },
      { id: 'model', label: 'Model / service', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'multimodal' },
      { id: 'style', label: 'Prompt', type: 'select', options: [['naive', 'Naive: "Describe this image."'], ['guided', 'Accessibility system prompt']], default: 'naive' },
      { id: 'detail', label: 'Detail level', type: 'select', options: [['concise', 'Concise'], ['detailed', 'Detailed']], default: 'concise' },
      { id: 'maxLen', label: 'Alt length budget (chars)', type: 'range', min: 40, max: 250, step: 5, default: 125 },
      { id: 'extended', label: 'Generate extended description for complex images', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Product photo, guided prompt', values: { image: 'product', style: 'guided' } },
      { label: 'Decorative hero, naive prompt', values: { image: 'hero', style: 'naive' } },
      { label: 'Chart with long description', values: { image: 'chart', style: 'guided', extended: true } },
      { label: 'Search icon with captioning service', values: { image: 'button', model: 'caption' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the hero banner with the naive prompt, then with the guided prompt, and compare the alt attribute and rubric.',
      'Run the chart with extended description off and on: what does a screen-reader user lose?',
      'Run the logo with the multimodal model and then with the captioning service: which one names the destination?',
      'Clear the page context and run the logo with purpose = auto: watch the purpose inference change.',
    ],
  },

  debug: [
    { id: 'textonly', title: 'Alt text is invented from nothing', values: { model: 'textonly', image: 'product' }, node: 'generate',
      symptom: 'The run fails at generation: the model cannot accept image input.', cause: 'A text-only deployment was selected (unsuitable model).', fix: 'Select a vision-capable multimodal deployment.' },
    { id: 'decorative', title: 'Screen reader reads a long description of a background', values: { image: 'hero', style: 'naive', purpose: 'auto' }, node: 'check',
      symptom: 'The rubric flags the decorative hero: alt is not empty and starts with "Image of".', cause: 'The naive prompt describes appearance and ignores purpose.', fix: 'Use the accessibility system prompt so decorative images get alt="".' },
    { id: 'nocontext', title: 'Logo announced as "Contoso logo" instead of its link target', values: { image: 'logo', context: '', style: 'guided', purpose: 'auto' }, node: 'purpose',
      symptom: 'Purpose inferred as informative; functional rule fails.', cause: 'No page context, so the model cannot know the logo is a home link (missing input).', fix: 'Send page context (e.g. "logo is a link to the home page") or declare purpose = functional.' },
    { id: 'chart', title: 'Chart data invisible to screen-reader users', values: { image: 'chart', style: 'guided', extended: false }, node: 'check',
      symptom: 'Blocking rubric failure: complex image has no extended description.', cause: 'Extended descriptions are disabled; a short alt cannot carry four data points.', fix: 'Turn on extended descriptions so the page gets aria-describedby + figcaption with the data.' },
    { id: 'tooShort', title: 'Alt ends with "…"', values: { image: 'chart', style: 'guided', extended: true, maxLen: 40 }, node: 'generate',
      symptom: 'Alt text is truncated mid-thought.', cause: 'Length budget too tight for the chart summary (wrong configuration).', fix: 'Raise the budget to about 100–125 characters and put detail in the extended description.' },
  ],

  challenge: {
    task: 'Make the quarterly sales chart fully accessible: every rubric check passes and the alt stays within a 125-character budget.',
    condition: 'Image = bar chart, alt length budget ≤ 125, all rubric checks pass (no warn or error steps).',
    hint: 'A chart needs two things: a short summary and somewhere to put the numbers.',
    check: (p, res) => p.image === 'chart' && p.maxLen <= 125 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Select the bar chart.', 'Use the accessibility system prompt (the naive one starts with "Image of" and has no data).', 'Turn on extended descriptions.', 'Keep the budget at 100–125 characters so the summary is not truncated.'],
    solutionValues: { image: 'chart', style: 'guided', extended: true, maxLen: 125, purpose: 'auto', model: 'multimodal' },
  },

  quiz: [
    { q: 'A hero photo sits behind a page headline and adds no information. Your pipeline produces "Image of misty mountains at sunrise". What should the published markup contain?', options: ['alt="Image of misty mountains at sunrise"', 'alt="" (empty)', 'No alt attribute at all', 'alt="decorative"'], answer: 1, why: 'Decorative images use an empty alt so assistive technology skips them. A missing alt makes some screen readers read the file name; the word "decorative" is noise.' },
    { q: 'An icon-only button submits a search. Which alt text is best?', options: ['"Magnifying glass icon"', '"Search"', '"Image of a grey magnifier"', '"Button"'], answer: 1, why: 'Functional images describe the action, not the appearance.' },
    { q: 'You must make a bar chart of quarterly revenue accessible. What should the generation step return?', options: ['A 300-character alt with every value', 'A short alt summarising the trend plus an extended description with the data, linked with aria-describedby', 'Only a caption from an image captioning API', 'alt="" because charts are decorative'], answer: 1, why: 'Complex images need a short alt plus a long description containing the data.' },
    { q: 'Your drafts often describe a company logo as "Blue hexagon and text" even though it links home. What is the most effective fix?', options: ['Switch to a larger model', 'Send page context (placement and link target) and an accessibility system prompt that prioritises purpose', 'Increase max tokens', 'Lower the temperature to 0'], answer: 1, why: 'Purpose is often not visible in the pixels. The model needs page context and explicit guidance.' },
  ],

  recap: 'Alt text is about purpose in context. Give the model the page context and explicit rules, return structured JSON, validate it (empty for decorative, action for functional, data in an extended description for complex images, no "image of", within budget) and route failures to an editor.',
};
