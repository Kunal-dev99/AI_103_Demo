// 3.3.1 Implement filters to classify unsafe or disallowed visual content
// Lab: Image moderation threshold console.
import { step, metric } from '../src/engine/util.js';

const CATS = ['Hate', 'Sexual', 'Violence', 'SelfHarm'];
const AUD = ['kids', 'general', 'news'];

// Synthetic batch. Descriptions only: no real images. pred = severities the (simulated) classifier returns
// on the 0/2/4/6 image scale; expect = decision a human policy reviewer made for each audience [kids, general, news].
const BATCH = [
  { id: 'img01', name: 'Family beach photo', pred: [0, 0, 0, 0], expect: ['allow', 'allow', 'allow'] },
  { id: 'img02', name: 'Swimwear advert', pred: [0, 2, 0, 0], expect: ['block', 'allow', 'allow'] },
  { id: 'img03', name: 'Cartoon slapstick fight', pred: [0, 0, 4, 0], expect: ['block', 'allow', 'allow'], note: 'classifier over-rates stylised violence' },
  { id: 'img04', name: 'News photo: protest with injuries', pred: [0, 0, 4, 0], expect: ['block', 'block', 'allow'] },
  { id: 'img05', name: 'Medical anatomy diagram', pred: [0, 2, 0, 0], expect: ['allow', 'allow', 'allow'], note: 'benign but scored like the swimwear advert' },
  { id: 'img06', name: 'History textbook photo with extremist symbol', pred: [4, 0, 2, 0], expect: ['block', 'block', 'allow'] },
  { id: 'img07', name: 'Self-harm awareness poster with helpline', pred: [0, 0, 0, 2], expect: ['block', 'allow', 'allow'] },
  { id: 'img08', name: '[simulated] graphic violence', pred: [0, 0, 6, 0], expect: ['block', 'block', 'block'] },
  { id: 'img09', name: '[simulated] explicit content', pred: [0, 6, 0, 0], expect: ['block', 'block', 'block'] },
  { id: 'img10', name: '[simulated] hateful meme', pred: [4, 0, 0, 0], expect: ['block', 'block', 'block'], note: 'classifier under-rates; true severity higher' },
  { id: 'img11', name: 'Museum display of antique weapons', pred: [0, 0, 2, 0], expect: ['allow', 'allow', 'allow'] },
];
const CORRUPT = { id: 'img12', name: 'Corrupted upload (truncated PNG)', corrupt: true, expect: ['block', 'block', 'block'] };

const THR_OPTS = [['2', 'Block at Low (2+)'], ['4', 'Block at Medium (4+)'], ['6', 'Block at High (6)'], ['off', 'Off']];

function decide(item, thr, p) {
  let block = false, review = false;
  item.pred.forEach((sev, i) => {
    const t = thr[i];
    if (t == null) return;
    if (sev >= t) block = true;
    else if (p.reviewBand && sev >= 2 && sev >= t - 2) review = true;
  });
  return block ? 'block' : review ? 'review' : 'allow';
}

function run(p) {
  const steps = [];
  const a = Math.max(0, AUD.indexOf(p.audience));
  const thr = [p.hate, p.sexual, p.violence, p.selfharm].map(v => v === 'off' ? null : Number(v));

  if (p.auth === 'norole') {
    steps.push(step('auth', 'Request denied (403)', 'The managed identity has no data-plane role on the Content Safety resource.', { httpStatus: 403, needs: 'Cognitive Services User' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Assign Cognitive Services User to the app identity on the Content Safety (Foundry) resource.' }], metrics: [], summary: 'Denied: no role' };
  }
  if (p.batch === 'oversize') {
    steps.push(step('auth', 'Authenticated', 'Entra ID token via DefaultAzureCredential.', null));
    steps.push(step('analyze', 'Every request rejected (400)', 'Images exceed the documented size/dimension limits for image analysis. Limits can change; check the docs.', { httpStatus: 400, code: 'InvalidRequestBody (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Downscale images before analysis (keep a copy of the original for audit).' }], metrics: [], summary: 'Rejected: oversize images' };
  }
  steps.push(step('auth', 'Authenticated', 'Entra ID token via DefaultAzureCredential (Cognitive Services User).', null));

  const items = p.batch === 'withCorrupt' ? [...BATCH, CORRUPT] : BATCH;
  steps.push(step('analyze', `${items.length} images analysed`, 'One analyze-image call per image; each returns a severity per category (images use 0, 2, 4, 6).', { categories: CATS }, 'ok'));

  const rows = items.map(it => {
    const expect = it.expect[a];
    if (it.corrupt) {
      const decision = p.onError === 'closed' ? 'review' : 'allow';
      return { it, decision, expect, verdict: decision === 'allow' ? 'FN' : 'review', err: true };
    }
    const decision = decide(it, thr, p);
    const verdict = decision === 'review' ? 'review' : decision === expect ? 'correct' : decision === 'block' ? 'FP' : 'FN';
    return { it, decision, expect, verdict };
  });
  if (p.batch === 'withCorrupt') steps.push(step('analyze', 'One image failed (InvalidImage)', p.onError === 'closed' ? 'Fail closed: the unanalysed image is held for human review.' : 'Fail open: the unanalysed image is published without moderation.', { id: CORRUPT.id }, p.onError === 'closed' ? 'warn' : 'error'));

  const fn = rows.filter(r => r.verdict === 'FN').length;
  const fp = rows.filter(r => r.verdict === 'FP').length;
  const rv = rows.filter(r => r.verdict === 'review').length;
  const correct = rows.filter(r => r.verdict === 'correct').length;
  steps.push(step('policy', 'Thresholds applied', `Audience: ${p.audience}. Block at ${CATS.map((c, i) => `${c} ${thr[i] == null ? 'off' : thr[i] + '+'}`).join(', ')}${p.reviewBand ? '; one level below → human review' : ''}.`, { thresholds: Object.fromEntries(CATS.map((c, i) => [c, thr[i]])), reviewBand: p.reviewBand }, thr.some(t => t == null) ? 'warn' : 'ok'));

  const st = fn ? 'error' : fp > 1 || rv > 4 ? 'warn' : 'ok';
  steps.push(step('route', fn ? `${fn} disallowed image(s) published` : fp > 1 ? `${fp} acceptable images blocked` : rv > 4 ? 'Review queue overloaded' : 'Batch routed', `Correct ${correct}, false positives ${fp}, false negatives ${fn}, sent to review ${rv}.`, { fp, fn, review: rv }, st));

  const toneOf = r => r.verdict === 'FN' ? 'error' : r.verdict === 'FP' ? 'warn' : r.verdict === 'review' ? 'info' : 'ok';
  return {
    steps,
    output: [
      { type: 'grid', title: 'Batch outcome (simulated labels, no real images)', cols: 4, caption: 'green = correct, red = unsafe image allowed (FN), amber = acceptable image blocked (FP), blue = human review',
        cells: rows.map(r => ({ label: r.it.name, v: r.decision, tone: toneOf(r) })) },
      { type: 'table', title: 'Per-image severities and decisions', columns: ['Image', ...CATS, 'Decision', `Reviewer (${p.audience})`, 'Verdict'],
        rows: rows.map(r => [r.it.name + (r.it.note ? ` (${r.it.note})` : ''), ...(r.err ? ['err', 'err', 'err', 'err'] : r.it.pred.map(String)), r.decision, r.expect, r.verdict]), tones: rows.map(toneOf) },
      { type: 'bars', title: 'Outcome counts', items: [{ label: 'Correct', value: correct, max: rows.length, tone: 'ok' }, { label: 'False positives', value: fp, max: rows.length, tone: 'warn' }, { label: 'False negatives', value: fn, max: rows.length, tone: 'error' }, { label: 'Human review', value: rv, max: rows.length, tone: 'info' }] },
      { type: 'json', title: 'Analyze image response (shape)', data: { categoriesAnalysis: CATS.map((c, i) => ({ category: c, severity: BATCH[3].pred[i] })) } },
      { type: 'code', title: 'azure-ai-contentsafety (Python, sketch)', lang: 'python', text: 'from azure.ai.contentsafety import ContentSafetyClient\nfrom azure.ai.contentsafety.models import AnalyzeImageOptions, ImageData\nfrom azure.identity import DefaultAzureCredential\n\nclient = ContentSafetyClient(endpoint, DefaultAzureCredential())\nresp = client.analyze_image(AnalyzeImageOptions(image=ImageData(content=img_bytes)))\nsev = {c.category: c.severity for c in resp.categories_analysis}\n' + `block = any(sev[c] >= t for c, t in THRESHOLDS.items())  # ${p.audience} policy` },
    ],
    metrics: [
      metric('False negatives', String(fn), 'computed', 'Simulated: disallowed images that would be published.'),
      metric('False positives', String(fp), 'computed', 'Simulated: acceptable images blocked.'),
      metric('Review rate', `${rv}/${rows.length}`, 'computed'),
      metric('Calls', String(items.length), 'computed', 'One image per analyze call. Pricing per image: see the Content Safety pricing page.'),
    ],
    summary: `${p.audience} • H${p.hate} S${p.sexual} V${p.violence} SH${p.selfharm}${p.reviewBand ? ' +review' : ''}: FN ${fn}, FP ${fp}, review ${rv}`,
  };
}

export default {
  id: '3.3.1',
  lab: 'Image moderation threshold console',
  services: [
    { name: 'Azure AI Content Safety: harm categories', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/harm-categories' },
    { name: 'Quickstart: analyze image content', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-safety/quickstart-image' },
    { name: 'Content filtering in Azure OpenAI / Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-filter' },
  ],
  prereqs: ['3.2.1'],
  next: ['3.3.2', '3.3.3'],

  concept: {
    plain: 'Before user-uploaded or AI-generated pictures are shown, a filter scores each one for categories of harm such as hate, sexual content, violence and self-harm. You decide, per category and per audience, how high a score is too high. A children’s app blocks more than a news site. No filter is perfect, so you watch both mistakes: harmful images that slip through and harmless ones that get blocked, and you send borderline cases to people.',
    technical: 'Azure AI Content Safety analyze image returns categoriesAnalysis with a severity per category (Hate, Sexual, Violence, SelfHarm); for images the scale is trimmed to 0, 2, 4, 6. Your application maps severities to actions with per-category thresholds, typically with a review band below the block level, and decides how to treat analysis failures (fail closed). Foundry content filters apply similar categories to model inputs/outputs, including images sent to multimodal deployments. Authenticate with Entra ID (Cognitive Services User). Evaluate thresholds on a labelled sample per audience before going live.',
    useCase: 'A school learning platform lets pupils upload project images. Every upload is analysed; anything at Low or above for sexual or self-harm content is blocked, borderline violence (e.g. history illustrations) goes to a teacher queue, and failures are held rather than published.',
    terms: [
      ['Harm category', 'Hate, Sexual, Violence, SelfHarm: the classes Content Safety scores.'],
      ['Severity', 'Level per category; images return 0 (safe), 2 (low), 4 (medium) or 6 (high).'],
      ['Threshold', 'Severity at or above which your app blocks content in a category.'],
      ['Fail closed', 'When analysis fails, do not publish: hold for review.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'auth', label: 'Upload / generated image', col: 0, row: 1, kind: 'data', detail: 'Every image goes through the filter before display.' },
          { id: 'analyze', label: 'Classify harm', col: 1, row: 1, kind: 'ai', detail: 'Severity per category.', substeps: CATS },
          { id: 'policy', label: `Thresholds (${p ? p.audience : 'audience'})`, col: 2, row: 1, kind: 'policy', detail: 'Per-category block level, review band.', badge: p && p.reviewBand ? 'review band' : undefined },
          { id: 'route', label: 'Allow / review / block', col: 3, row: 1, kind: 'app', detail: 'Decision and audit log.' },
          { id: 'review', label: 'Human review', col: 3, row: 2.5, kind: 'user', detail: 'Borderline images and failures.', disabled: p && !p.reviewBand && p.onError !== 'closed' },
        ],
        edges: [['auth', 'analyze'], ['analyze', 'policy'], ['policy', 'route'], ['route', 'review', 'borderline']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'auth', label: 'Upload API (managed identity)', col: 0, row: 1, kind: 'app', detail: 'Needs Cognitive Services User on the Content Safety resource.', badge: p && p.auth === 'norole' ? 'no role' : undefined },
          { id: 'analyze', label: 'Azure AI Content Safety', col: 1, row: 1, kind: 'ai', detail: 'analyze image endpoint (Foundry Tools).' },
          { id: 'policy', label: 'Policy config (App Configuration)', col: 2, row: 0, kind: 'policy', detail: 'Thresholds per audience, versioned.' },
          { id: 'route', label: 'Publish / quarantine storage', col: 3, row: 1, kind: 'store', detail: 'Allowed images to public container; others to quarantine.' },
          { id: 'review', label: 'Moderator app', col: 3, row: 2.5, kind: 'user', detail: 'Reviews queue items.' },
        ],
        edges: [['auth', 'analyze', 'analyze image'], ['policy', 'route'], ['analyze', 'route'], ['route', 'review']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'auth', label: 'client = ContentSafetyClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'azure-ai-contentsafety.' },
          { id: 'analyze', label: 'resp = client.analyze_image(AnalyzeImageOptions(image=ImageData(content=b)))', col: 0, row: 1, kind: 'code', detail: 'Returns categories_analysis.' },
          { id: 'policy', label: p ? `THRESHOLDS = {"Hate": ${p.hate}, "Sexual": ${p.sexual}, "Violence": ${p.violence}, "SelfHarm": ${p.selfharm}}` : 'THRESHOLDS = {...}', col: 0, row: 2, kind: 'code', detail: 'Your policy.' },
          { id: 'route', label: 'action = block if any(sev >= t) else review if near else allow', col: 0, row: 3, kind: 'code', detail: 'Decision logic.' },
          { id: 'review', label: 'except HttpResponseError: hold_for_review(img)  # fail closed', col: 0, row: 4, kind: 'code', detail: 'Never publish what you could not analyse.' },
        ],
        edges: [['auth', 'analyze'], ['analyze', 'policy'], ['policy', 'route'], ['route', 'review']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'audience', label: 'Audience policy (reviewer labels)', type: 'select', options: [['kids', 'Children’s platform'], ['general', 'General social app'], ['news', 'News / education archive']], default: 'general' },
      { id: 'hate', label: 'Hate', type: 'select', options: THR_OPTS, default: '4' },
      { id: 'sexual', label: 'Sexual', type: 'select', options: THR_OPTS, default: '4' },
      { id: 'violence', label: 'Violence', type: 'select', options: THR_OPTS, default: '4' },
      { id: 'selfharm', label: 'Self-harm', type: 'select', options: THR_OPTS, default: '4' },
      { id: 'reviewBand', label: 'Send one level below threshold to human review', type: 'toggle', default: false },
      { id: 'batch', label: 'Batch', type: 'select', options: [['standard', '11 sample images'], ['withCorrupt', '+ one corrupted upload'], ['oversize', 'All images over size limit']], default: 'standard' },
      { id: 'onError', label: 'On analysis error', type: 'select', options: [['closed', 'Fail closed (hold)'], ['open', 'Fail open (publish)']], default: 'closed' },
      { id: 'auth', label: 'App identity', type: 'select', options: [['entra', 'Managed identity with Cognitive Services User'], ['norole', 'Managed identity, no role']], default: 'entra' },
    ],
    samples: [
      { label: 'General app, Medium everywhere', values: { audience: 'general' } },
      { label: 'Children’s app with general thresholds', values: { audience: 'kids' } },
      { label: 'News archive, strict thresholds', values: { audience: 'news', hate: '2', sexual: '2', violence: '2', selfharm: '2' } },
      { label: 'Corrupted upload, fail open', values: { batch: 'withCorrupt', onError: 'open' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'For the children’s audience, compare Sexual = Low (2+) vs Medium (4+) with the review band on.',
      'Run the news archive with all thresholds at Low, then at High: count false positives vs false negatives.',
      'Turn Violence off for the general app and see which images slip through.',
      'Run the corrupted batch with fail open vs fail closed.',
    ],
  },

  debug: [
    { id: 'off', title: 'Graphic images published', values: { audience: 'general', violence: 'off' }, node: 'policy',
      symptom: 'Red cells: violent images allowed.', cause: 'A category threshold was switched off (wrong configuration).', fix: 'Set Violence to Medium (4+) or stricter.' },
    { id: 'strict', title: 'News archive blocks half its photos', values: { audience: 'news', hate: '2', sexual: '2', violence: '2', selfharm: '2' }, node: 'route',
      symptom: 'Many amber cells: acceptable images blocked.', cause: 'Thresholds suited to children applied to an archive with legitimate context.', fix: 'Raise thresholds per category (e.g. Violence/Hate High, Sexual/Self-harm Medium) and use a review band.' },
    { id: 'open', title: 'Unanalysed image went live', values: { batch: 'withCorrupt', onError: 'open' }, node: 'analyze',
      symptom: 'Corrupted upload published without moderation.', cause: 'Fail-open error handling around the analyze call (malformed input + downstream failure).', fix: 'Fail closed: hold images that could not be analysed.' },
    { id: 'role', title: '403 on every call', values: { auth: 'norole' }, node: 'auth',
      symptom: 'Request denied.', cause: 'Identity lacks a data-plane role (permission problem).', fix: 'Assign Cognitive Services User.' },
    { id: 'size', title: '400 for the whole batch', values: { batch: 'oversize' }, node: 'analyze',
      symptom: 'Every request rejected.', cause: 'Images exceed size/dimension limits (invalid input).', fix: 'Downscale before analysis (choose the standard batch).' },
  ],

  challenge: {
    task: 'Configure the children’s platform so no disallowed image is published, no acceptable image is blocked, and at most 3 images go to human review.',
    condition: 'Audience = children’s platform, false negatives 0, false positives 0, review ≤ 3, standard batch.',
    hint: 'Two images get the same Sexual score but deserve different outcomes. Who can tell them apart?',
    check: (p, res) => p.audience === 'kids' && p.batch === 'standard' && ['False negatives', 'False positives'].every(l => (res.metrics.find(m => m.label === l) || {}).value === '0') && Number(((res.metrics.find(m => m.label === 'Review rate') || {}).value || '99/').split('/')[0]) <= 3,
    solution: ['Choose the children’s platform.', 'Hate Low (2+), Self-harm Low (2+): any signal is disallowed.', 'Sexual Medium (4+) and Violence Medium (4+) with the review band on, so Low scores (swimwear vs medical diagram, museum weapons) go to a person.', 'Run: 0 FN, 0 FP, 3 reviews.'],
    solutionValues: { audience: 'kids', hate: '2', sexual: '4', violence: '4', selfharm: '2', reviewBand: true, batch: 'standard', onError: 'closed', auth: 'entra' },
  },

  quiz: [
    { q: 'A news archive keeps blocking legitimate war photography while a children’s app on the same filter must block it. What is the right design?', options: ['Use one global threshold', 'Per-audience, per-category thresholds with a review band', 'Disable the Violence category for both', 'Train a new model'], answer: 1, why: 'Severity is the same; acceptability depends on audience and context. Configure thresholds per policy.' },
    { q: 'Content Safety returns Sexual severity 2 for both a swimwear advert and a medical diagram. Your children’s policy should block the first and allow the second. What is the most reliable approach?', options: ['Block at 2', 'Allow at 2', 'Route severity 2 to human review', 'Lower the Violence threshold'], answer: 2, why: 'When scores cannot separate cases, route the band to people.' },
    { q: 'The analyze call fails for a corrupted image. What should the app do?', options: ['Publish it; the filter was unavailable', 'Fail closed: hold it for review or reject it', 'Retry forever', 'Mark it severity 0'], answer: 1, why: 'Unanalysed content must not bypass moderation.' },
  ],

  recap: 'Image moderation = severity per harm category (0/2/4/6 for images) + your per-audience thresholds + a review band + fail-closed error handling. Measure false negatives and false positives on labelled samples and adjust per category; use Entra ID auth with a data-plane role.',
};
