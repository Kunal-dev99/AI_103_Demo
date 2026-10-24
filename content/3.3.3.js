// 3.3.3 Enforce visual policy rules, such as applying watermarks, flagging prohibited symbols,
// upholding brand usage requirements, and detecting potentially inappropriate content
// Lab: Brand & provenance policy gate.
import { step, metric } from '../src/engine/util.js';

// Generated marketing images. logo.size = logo width as % of image width; logo.clear = clear space in grid units.
// Brand guideline (ground truth used by the reviewer): logo ≥ 10%, clear space ≥ 4, colour in palette,
// visible "AI-generated" disclosure, valid Content Credentials, no prohibited symbols, Sexual/Violence < Medium.
const GUIDE = { minLogo: 10, clear: 4, safety: 4 };
const PALETTE = { brand: '#1f5fbf', white: '#ffffff' };

const IMAGES = {
  spring: { label: 'Spring sale banner (compliant)', logo: { x: 6, y: 6, size: 14, clear: 6, color: 'brand' }, label: true, c2pa: true, symbol: null, decorStar: true, severity: 0, bg: '#e8f5e9' },
  nolabel: { label: 'Beachwear ad without AI disclosure', logo: { x: 6, y: 6, size: 12, clear: 5, color: 'brand' }, label: false, c2pa: true, symbol: null, severity: 2, bg: '#fff8e1' },
  smalllogo: { label: 'Social post: tiny, crowded logo', logo: { x: 6, y: 6, size: 7, clear: 2, color: 'brand' }, label: true, c2pa: true, symbol: null, severity: 0, bg: '#e3f2fd', crowd: true },
  recolor: { label: 'Poster with recoloured logo', logo: { x: 6, y: 6, size: 15, clear: 6, color: 'red' }, label: true, c2pa: true, symbol: null, severity: 0, bg: '#f3e5f5' },
  symbol: { label: 'Street scene with a prohibited symbol on a wall', logo: { x: 6, y: 6, size: 12, clear: 5, color: 'brand' }, label: true, c2pa: true, symbol: { x: 62, y: 30, subtle: true }, severity: 0, bg: '#eceff1' },
  unsafe: { label: 'Fashion ad flagged as suggestive', logo: { x: 6, y: 6, size: 12, clear: 5, color: 'brand' }, label: true, c2pa: true, symbol: null, severity: 4, bg: '#fce4ec' },
  stripped: { label: 'Image re-saved by a third-party tool (credentials stripped)', logo: { x: 6, y: 6, size: 12, clear: 5, color: 'brand' }, label: true, c2pa: false, symbol: null, severity: 0, bg: '#efebe9' },
};

const RULES = {
  provenance: 'Content Credentials (C2PA) present and valid',
  label: 'Visible "AI-generated" disclosure',
  symbol: 'No prohibited symbols',
  logoSize: 'Logo minimum size',
  clearSpace: 'Logo clear space',
  logoColor: 'Logo uses approved colours',
  safety: 'No inappropriate content (Content Safety)',
};
const FIXABLE = { label: 'add disclosure overlay', logoSize: 'resize logo', clearSpace: 're-layout to restore clear space', logoColor: 'recolour logo to brand blue', provenance: 're-generate from stored prompt via the image API (new Content Credentials)' };

function truth(img) {
  const v = [];
  if (!img.c2pa) v.push('provenance');
  if (!img.label) v.push('label');
  if (img.symbol) v.push('symbol');
  if (img.logo.size < GUIDE.minLogo) v.push('logoSize');
  if (img.logo.clear < GUIDE.clear) v.push('clearSpace');
  if (img.logo.color !== 'brand') v.push('logoColor');
  if (img.severity >= GUIDE.safety) v.push('safety');
  return v;
}

function check(img, p) {
  const found = [], skipped = [];
  if (p.ruleProvenance) { if (!img.c2pa) found.push('provenance'); } else skipped.push('provenance');
  if (p.ruleLabel) { if (!img.label) found.push('label'); } else skipped.push('label');
  if (p.detector === 'custom') { if (img.symbol) found.push('symbol'); }
  else if (p.detector === 'llm') { if (img.symbol && !img.symbol.subtle) found.push('symbol'); if (img.decorStar) found.push('symbol'); }
  else skipped.push('symbol');
  if (p.ruleBrand) {
    if (img.logo.size < p.minLogo) found.push('logoSize');
    if (img.logo.clear < p.clearSpace) found.push('clearSpace');
    if (img.logo.color !== 'brand') found.push('logoColor');
  } else skipped.push('logoSize', 'clearSpace', 'logoColor');
  if (p.safetyThr !== 'off') { if (img.severity >= Number(p.safetyThr)) found.push('safety'); } else skipped.push('safety');
  return { found: [...new Set(found)], skipped };
}

function evaluate(key, p) {
  const img = IMAGES[key];
  const t = truth(img);
  const { found, skipped } = check(img, p);
  const caught = found.filter(f => t.includes(f));
  const falseFlags = found.filter(f => !t.includes(f));
  const missed = t.filter(v => !found.includes(v));
  let fixed = [], unfixable = [], credsBroken = false, regenerated = false;
  if (p.remediation === 'autoFix') {
    for (const f of found) (FIXABLE[f] ? fixed : unfixable).push(f);
    regenerated = fixed.includes('provenance');
    const pixelEdits = fixed.filter(f => f !== 'provenance');
    if (pixelEdits.length && !regenerated && img.c2pa && !p.resign) credsBroken = true;
  } else unfixable = [...found];
  let outcome;
  if (missed.length) outcome = 'violation published';
  else if (credsBroken) outcome = 'published without valid credentials';
  else if (unfixable.length) outcome = 'rejected';
  else if (fixed.length) outcome = 'published after fixes';
  else outcome = 'published';
  return { key, img, t, found, skipped, caught, falseFlags, missed, fixed, unfixable, credsBroken, outcome };
}

function sceneFor(img, after) {
  const L = img.logo;
  const fixed = after || [];
  const size = fixed.includes('logoSize') ? Math.max(GUIDE.minLogo, L.size) : L.size;
  const color = fixed.includes('logoColor') || L.color === 'brand' ? PALETTE.brand : '#e53935';
  const shapes = [
    { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: img.bg },
    { kind: 'rect', x: 30, y: 20, w: 40, h: 34, fill: '#b0bec5' },
    { kind: 'text', x: 34, y: 38, text: 'product hero' },
    { kind: 'rect', x: L.x, y: L.y, w: size, h: size * 0.5, fill: color },
  ];
  if (img.crowd && !fixed.includes('clearSpace')) shapes.push({ kind: 'text', x: L.x + size + 1, y: L.y + 3, text: 'SALE!!' });
  if (img.decorStar) shapes.push({ kind: 'circle', x: 84, y: 14, r: 4, fill: '#ffd54f' });
  if (img.symbol) shapes.push({ kind: 'circle', x: img.symbol.x + 4, y: img.symbol.y + 4, r: 4, fill: '#757575' }, { kind: 'text', x: img.symbol.x - 6, y: img.symbol.y + 13, text: '(simulated symbol)' });
  if (img.severity >= 2) shapes.push({ kind: 'text', x: 32, y: 50, text: `[simulated: Sexual severity ${img.severity}]` });
  if (img.label || fixed.includes('label')) shapes.push({ kind: 'rect', x: 70, y: 62, w: 28, h: 6, fill: '#263238' }, { kind: 'text', x: 71, y: 66.5, text: 'AI-generated' });
  if (!img.c2pa && !fixed.includes('provenance')) shapes.push({ kind: 'text', x: 2, y: 66, text: 'no Content Credentials' });
  return shapes;
}

const BOX = { logoSize: e => ({ x: e.img.logo.x - 1, y: e.img.logo.y - 1, w: e.img.logo.size + 2, h: e.img.logo.size * 0.5 + 2 }), clearSpace: e => ({ x: e.img.logo.x - 2, y: e.img.logo.y - 2, w: e.img.logo.size + 12, h: e.img.logo.size * 0.5 + 4 }), logoColor: e => ({ x: e.img.logo.x - 1, y: e.img.logo.y - 1, w: e.img.logo.size + 2, h: e.img.logo.size * 0.5 + 2 }),
  symbol: e => e.img.symbol ? { x: e.img.symbol.x - 1, y: e.img.symbol.y - 1, w: 10, h: 10 } : { x: 79, y: 9, w: 10, h: 10 }, label: () => ({ x: 69, y: 61, w: 30, h: 8 }), safety: () => ({ x: 29, y: 19, w: 42, h: 36 }), provenance: () => ({ x: 1, y: 62, w: 34, h: 6 }) };

function run(p) {
  const steps = [];
  const single = evaluate(IMAGES[p.image] ? p.image : 'recolor', p);
  const e = single;
  const st = (rules) => {
    const missed = e.missed.filter(r => rules.includes(r));
    const caught = e.found.filter(r => rules.includes(r));
    const fp = e.falseFlags.filter(r => rules.includes(r));
    const skipped = e.skipped.filter(r => rules.includes(r));
    const status = fp.length || caught.length ? 'warn' : skipped.length === rules.length ? 'skip' : 'ok';
    return { missed, caught, fp, skipped, status };
  };
  steps.push(step('gen', 'Generated image received', `${e.img.label}.`, { contentCredentials: e.img.c2pa ? 'present (manifest signed by the generator)' : 'missing' }));
  const pv = st(['provenance', 'label']);
  steps.push(step('provenance', 'Provenance & disclosure', pv.caught.length ? `Violations: ${pv.caught.map(r => RULES[r]).join(', ')}.` : pv.skipped.length === 2 ? 'Rules off.' : 'Content Credentials valid; disclosure present.', { checked: ['provenance', 'label'].filter(r => !pv.skipped.includes(r)), found: pv.caught }, pv.status));
  const sy = st(['symbol']);
  steps.push(step('symbols', `Symbol check (${p.detector})`, sy.fp.length ? 'Flagged a decorative star as a prohibited symbol (false positive).' : sy.caught.length ? 'Prohibited symbol detected.' : p.detector === 'none' ? 'No detector configured.' : 'No prohibited symbols found.', { detector: p.detector, found: sy.caught.concat(sy.fp) }, sy.status));
  const br = st(['logoSize', 'clearSpace', 'logoColor']);
  steps.push(step('brand', 'Brand rules', br.caught.length || br.fp.length ? `Flagged: ${br.caught.concat(br.fp).map(r => RULES[r]).join(', ')}${br.fp.length ? ' (stricter than the brand guideline)' : ''}.` : br.skipped.length ? 'Rules off.' : 'Logo size, clear space and colour OK.', { minLogoPct: p.minLogo, clearSpace: p.clearSpace, logo: e.img.logo }, br.status));
  const sf = st(['safety']);
  steps.push(step('safety', 'Inappropriate content', sf.caught.length || sf.fp.length ? `Content Safety severity ${e.img.severity} ≥ threshold ${p.safetyThr}.` : p.safetyThr === 'off' ? 'Check off.' : `Severity ${e.img.severity} below threshold ${p.safetyThr}.`, { severity: e.img.severity, threshold: p.safetyThr }, sf.status));

  if (p.remediation === 'autoFix') steps.push(step('remediate', e.fixed.length ? `Auto-fixed ${e.fixed.length}` : 'Nothing auto-fixable', e.fixed.map(f => FIXABLE[f]).join('; ') + (e.unfixable.length ? ` | Not auto-fixable: ${e.unfixable.map(r => RULES[r]).join(', ')}` : '') + (e.credsBroken ? ' | Pixel edits invalidated the original Content Credentials and they were not re-signed.' : e.fixed.length && p.resign ? ' | Edited image re-signed: manifest records the edits.' : ''),
    { fixed: e.fixed, unfixable: e.unfixable, resign: p.resign }, e.credsBroken ? 'error' : e.fixed.length ? 'ok' : 'skip'));
  else steps.push(step('remediate', 'Flag only', 'Violations are reported; no edits made.', { found: e.found }, 'skip'));

  let batch = null;
  if (p.scope === 'batch') batch = Object.keys(IMAGES).map(k => evaluate(k, p));
  const pool = batch || [e];
  const missedN = pool.reduce((a, x) => a + x.missed.length, 0);
  const fpN = pool.reduce((a, x) => a + x.falseFlags.length, 0);
  const brokenN = pool.filter(x => x.credsBroken).length;
  const published = pool.filter(x => x.outcome.startsWith('published') && !x.credsBroken).length;
  const gateStatus = missedN || brokenN ? 'error' : fpN || (p.scope === 'single' && e.outcome === 'rejected') ? 'warn' : 'ok';
  steps.push(step('gate', missedN ? `${missedN} violation(s) slipped through` : brokenN ? 'Published without valid credentials' : fpN ? `${fpN} false flag(s)` : p.scope === 'batch' ? 'Batch gated correctly' : e.outcome, p.scope === 'batch' ? `${pool.length} images: ${published} published, ${pool.filter(x => x.outcome === 'rejected').length} rejected.` : `Outcome: ${e.outcome}.${e.missed.length ? ` Missed: ${e.missed.map(r => RULES[r]).join(', ')}.` : ''}`,
    { missed: missedN, falseFlags: fpN, credentialsBroken: brokenN }, gateStatus));

  const shapes = [...sceneFor(e.img), ...e.found.map(r => ({ kind: 'box', ...BOX[r](e), label: RULES[r].split(' ').slice(0, 3).join(' '), tone: e.falseFlags.includes(r) ? 'warn' : 'error' })), ...e.missed.map(r => ({ kind: 'box', ...BOX[r](e), label: `missed: ${RULES[r].split(' ').slice(0, 2).join(' ')}`, tone: 'warn', dashed: true }))];
  const output = [{ type: 'image', title: `${e.img.label}: violations (red), false flags (amber), missed (dashed)`, shapes }];
  if (p.remediation === 'autoFix' && e.fixed.length) output.push({ type: 'image', title: `After auto-fix${e.credsBroken ? ' (credentials no longer valid!)' : p.resign ? ' (re-signed)' : ''}`, shapes: sceneFor({ ...e.img, c2pa: e.img.c2pa && !e.credsBroken }, e.fixed) });
  output.push({ type: 'table', title: 'Rule results for this image', columns: ['Rule', 'Result', 'Remediation'],
    rows: Object.keys(RULES).map(r => [RULES[r], e.skipped.includes(r) ? (e.missed.includes(r) ? 'not checked (violation!)' : 'not checked') : e.falseFlags.includes(r) ? 'flagged (false positive)' : e.found.includes(r) ? 'violation' : e.missed.includes(r) ? 'missed' : 'pass', e.fixed.includes(r) ? FIXABLE[r] : e.unfixable.includes(r) ? (p.remediation === 'autoFix' ? 'reject → regenerate with a revised prompt' : 'flagged for designer') : '—']),
    tones: Object.keys(RULES).map(r => e.missed.includes(r) ? 'error' : e.falseFlags.includes(r) ? 'warn' : e.found.includes(r) ? 'info' : e.skipped.includes(r) ? 'muted' : 'ok') });
  if (batch) output.push({ type: 'grid', title: 'Batch gate results', cols: 4, caption: 'green = published (clean or fixed), blue = correctly rejected, red = violation published or credentials broken, amber = false flag',
    cells: batch.map(x => ({ label: x.img.label, v: x.outcome, tone: x.missed.length || x.credsBroken ? 'error' : x.falseFlags.length ? 'warn' : x.outcome === 'rejected' ? 'info' : 'ok' })) });
  output.push({ type: 'json', title: 'Policy definition (your config, illustrative)', data: { contentCredentials: p.ruleProvenance ? 'required' : 'ignored', disclosureOverlay: p.ruleLabel ? 'required' : 'ignored', prohibitedSymbols: { detector: p.detector }, brand: p.ruleBrand ? { minLogoWidthPct: p.minLogo, minClearSpace: p.clearSpace, palette: Object.values(PALETTE) } : 'off', contentSafety: { blockAtSeverity: p.safetyThr }, remediation: p.remediation, resignAfterEdit: p.resign } });

  return {
    steps, output,
    metrics: [
      metric('Missed violations', String(missedN), 'computed', p.scope === 'batch' ? 'Across the 7-image batch.' : 'This image.'),
      metric('False flags', String(fpN), 'computed'),
      metric('Published', `${published}/${pool.length}`, 'computed', 'Clean or fixed, with valid credentials.'),
      metric('Credentials broken by edits', String(brokenN), 'computed'),
    ],
    summary: `${p.scope === 'batch' ? 'Batch' : p.image} • ${p.detector} • ${p.remediation}${p.resign ? '+resign' : ''}: missed ${missedN}, false ${fpN}, published ${published}/${pool.length}`,
  };
}

export default {
  id: '3.3.3',
  lab: 'Brand & provenance policy gate',
  services: [
    { name: 'Content Credentials (C2PA) in Azure OpenAI image generation', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/content-credentials' },
    { name: 'Azure AI Content Safety: image analysis', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-safety/quickstart-image' },
    { name: 'Custom Vision object detection', url: 'https://learn.microsoft.com/en-us/azure/ai-services/custom-vision-service/overview' },
  ],
  prereqs: ['3.3.1', '3.2.8', '3.1.1'],
  next: ['3.1.5'],

  concept: {
    plain: 'Before an AI-generated image is published it should pass the same checks a careful designer would apply: it is marked as AI-generated, it carries provenance information, it contains no banned symbols, the logo is used correctly, and nothing inappropriate is in it. A policy gate runs these checks automatically, fixes what can safely be fixed (add the label, resize the logo) and rejects the rest. Careless fixes can break provenance, so edited images must be re-signed.',
    technical: 'Images from Azure OpenAI image models in Foundry carry C2PA Content Credentials (a signed manifest stating the image is AI-generated); verify the manifest and treat missing/invalid credentials as a violation. A visible disclosure overlay is a separate, policy-driven requirement. Prohibited symbols and logo placement are detection problems: a custom detector trained on your symbol list and brand assets, or a multimodal model with a policy prompt (more flexible, less reliable on subtle cases). Inappropriate content uses Azure AI Content Safety image severities with thresholds. Remediation that edits pixels invalidates the original manifest, so re-sign with your C2PA tooling to record the edit, or regenerate.',
    useCase: 'A marketing team generates hundreds of campaign images a week in Foundry. A gate function checks each image: credentials and disclosure present, logo ≥ 10% width with clear space and brand colours, no banned symbols (custom detector), Content Safety below Medium. Logo and disclosure issues are auto-fixed and re-signed; symbols and unsafe content are rejected and regenerated with a revised prompt.',
    terms: [
      ['Content Credentials (C2PA)', 'Signed provenance manifest embedded in media, recording how it was created and edited.'],
      ['Visible watermark / disclosure', 'On-image mark (e.g. "AI-generated") that viewers can see; independent of metadata.'],
      ['Clear space', 'Minimum empty area around a logo required by brand guidelines.'],
      ['Policy gate', 'Automated checks with remediation that decide publish, fix or reject.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'gen', label: 'Generated image', col: 0, row: 1.5, kind: 'data', detail: 'Output of an image model, with Content Credentials.' },
          { id: 'provenance', label: 'Provenance & disclosure', col: 1, row: 0, kind: 'policy', detail: 'C2PA manifest valid? Visible AI label?' },
          { id: 'symbols', label: 'Prohibited symbols', col: 1, row: 1, kind: 'ai', detail: 'Detector over your banned-symbol list.', badge: p ? p.detector : undefined, disabled: p && p.detector === 'none' },
          { id: 'brand', label: 'Brand rules', col: 1, row: 2, kind: 'policy', detail: 'Logo size, clear space, colours.', disabled: p && !p.ruleBrand, badge: p && p.ruleBrand ? `≥${p.minLogo}%` : undefined },
          { id: 'safety', label: 'Inappropriate content', col: 1, row: 3, kind: 'ai', detail: 'Content Safety severity vs threshold.', disabled: p && p.safetyThr === 'off' },
          { id: 'remediate', label: p && p.remediation === 'autoFix' ? 'Auto-fix' : 'Flag only', col: 2, row: 1.5, detail: 'Fix safe issues, reject the rest.', substeps: ['Add disclosure', 'Resize / recolour logo', 'Regenerate', 'Re-sign credentials'] },
          { id: 'gate', label: 'Publish / reject', col: 3, row: 1.5, kind: 'app', detail: 'Final decision with audit trail.' },
        ],
        edges: [['gen', 'provenance'], ['gen', 'symbols'], ['gen', 'brand'], ['gen', 'safety'], ['provenance', 'remediate'], ['symbols', 'remediate'], ['brand', 'remediate'], ['safety', 'remediate'], ['remediate', 'gate']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'gen', label: 'Azure OpenAI image model (Foundry)', col: 0, row: 1.5, kind: 'ai', detail: 'Generated images include C2PA Content Credentials.' },
          { id: 'provenance', label: 'C2PA verify (your tooling)', col: 1, row: 0, kind: 'compute', detail: 'Validate manifest signature and assertions.' },
          { id: 'symbols', label: p && p.detector === 'llm' ? 'Multimodal model + policy prompt' : 'Custom detector endpoint', col: 1, row: 1, kind: 'ai', detail: 'Trained on banned symbols and brand assets.' },
          { id: 'brand', label: 'Brand rules function', col: 1, row: 2, kind: 'compute', detail: 'Uses logo detection boxes to compute size and clear space.' },
          { id: 'safety', label: 'Azure AI Content Safety', col: 1, row: 3, kind: 'ai', detail: 'Image analysis severities.' },
          { id: 'remediate', label: 'Remediation worker', col: 2, row: 1.5, kind: 'compute', detail: 'Edits, regeneration, re-signing.', badge: p && p.resign ? 're-sign' : undefined },
          { id: 'gate', label: 'DAM / CMS publish', col: 3, row: 1.5, kind: 'app', detail: 'Digital asset management with audit log.' },
        ],
        edges: [['gen', 'provenance'], ['gen', 'symbols'], ['gen', 'brand'], ['gen', 'safety'], ['provenance', 'remediate'], ['symbols', 'remediate'], ['brand', 'remediate'], ['safety', 'remediate'], ['remediate', 'gate']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'gen', label: 'img = client.images.generate(model=DEPLOYMENT, prompt=...)', col: 0, row: 0, kind: 'code', detail: 'openai SDK against the Foundry endpoint (illustrative).' },
          { id: 'provenance', label: 'manifest = c2pa_read(img); assert manifest.valid', col: 0, row: 1, kind: 'code', detail: 'Use a C2PA SDK/tool; illustrative.' },
          { id: 'symbols', label: 'hits = detector.detect(img, classes=BANNED)', col: 0, row: 2, kind: 'code', detail: 'Custom detector or multimodal judge.' },
          { id: 'brand', label: p ? `check_logo(box, min_pct=${p.minLogo}, clear=${p.clearSpace}, palette=BRAND)` : 'check_logo(...)', col: 0, row: 3, kind: 'code', detail: 'Geometry + colour checks.' },
          { id: 'safety', label: 'cs.analyze_image(...).categories_analysis', col: 0, row: 4, kind: 'code', detail: 'azure-ai-contentsafety.' },
          { id: 'remediate', label: p && p.resign ? 'fixed = apply_fixes(img); c2pa_sign(fixed, parent=manifest)' : 'fixed = apply_fixes(img)', col: 0, row: 5, kind: 'code', detail: 'Re-sign so the manifest records the edit.' },
          { id: 'gate', label: 'publish(fixed) if not violations else reject()', col: 0, row: 6, kind: 'code', detail: 'Decision.' },
        ],
        edges: [['gen', 'provenance'], ['provenance', 'symbols'], ['symbols', 'brand'], ['brand', 'safety'], ['safety', 'remediate'], ['remediate', 'gate']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'image', label: 'Image to inspect', type: 'select', options: Object.entries(IMAGES).map(([v, i]) => [v, i.label]), default: 'recolor' },
      { id: 'scope', label: 'Scope', type: 'select', options: [['single', 'Selected image'], ['batch', 'Whole batch (7 images)']], default: 'single' },
      { id: 'ruleProvenance', label: 'Require Content Credentials (C2PA)', type: 'toggle', default: true },
      { id: 'ruleLabel', label: 'Require visible "AI-generated" disclosure', type: 'toggle', default: true },
      { id: 'detector', label: 'Prohibited-symbol detector', type: 'select', options: [['custom', 'Custom detector (trained on banned list)'], ['llm', 'Multimodal model with policy prompt'], ['none', 'None']], default: 'llm' },
      { id: 'ruleBrand', label: 'Brand rules', type: 'toggle', default: true },
      { id: 'minLogo', label: 'Min logo width (% of image)', type: 'range', min: 4, max: 30, step: 1, default: 10 },
      { id: 'clearSpace', label: 'Min clear space (units)', type: 'range', min: 0, max: 10, step: 1, default: 4 },
      { id: 'safetyThr', label: 'Block inappropriate content at severity', type: 'select', options: [['2', 'Low (2+)'], ['4', 'Medium (4+)'], ['6', 'High (6)'], ['off', 'Off']], default: '4' },
      { id: 'remediation', label: 'Remediation', type: 'select', options: [['flag', 'Flag only'], ['autoFix', 'Auto-fix where safe']], default: 'flag' },
      { id: 'resign', label: 'Re-sign Content Credentials after edits', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Recoloured logo, flag only', values: { image: 'recolor' } },
      { label: 'Recoloured logo, auto-fix without re-signing', values: { image: 'recolor', remediation: 'autoFix' } },
      { label: 'Subtle symbol, multimodal judge', values: { image: 'symbol', detector: 'llm' } },
      { label: 'Whole batch, custom detector, auto-fix + re-sign', values: { scope: 'batch', detector: 'custom', remediation: 'autoFix', resign: true } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the symbol image with the custom detector and with the multimodal judge; then run the compliant banner with both.',
      'Run the recoloured poster with auto-fix, re-signing off then on, and compare the after-image provenance.',
      'Run the whole batch with min logo width 10% and then 15%: count false flags.',
      'Run the beachwear ad with the inappropriate-content threshold at Low and at Medium.',
    ],
  },

  debug: [
    { id: 'resign', title: 'Fixed images fail provenance audit', values: { image: 'recolor', remediation: 'autoFix', resign: false }, node: 'remediate',
      symptom: 'After auto-fix, the image is published without valid Content Credentials.', cause: 'Pixel edits invalidate the original signed manifest (downstream integration failure).', fix: 'Re-sign after edits so the manifest records them (or regenerate).' },
    { id: 'subtle', title: 'Banned symbol published', values: { image: 'symbol', detector: 'llm' }, node: 'symbols',
      symptom: 'Missed: prohibited symbol (dashed box).', cause: 'A general multimodal judge misses a partially hidden symbol (unsuitable model for this check).', fix: 'Use a custom detector trained on the banned-symbol list.' },
    { id: 'strict', title: 'Compliant banners rejected', values: { scope: 'batch', detector: 'custom', minLogo: 15, clearSpace: 7 }, node: 'brand',
      symptom: 'False flags on logo size and clear space.', cause: 'Rule parameters are stricter than the brand guideline (wrong configuration).', fix: 'Set min logo width 10% and clear space 4, as in the guideline.' },
    { id: 'stripped', title: 'Image with stripped credentials', values: { image: 'stripped', ruleProvenance: false }, node: 'provenance',
      symptom: 'Image published although its Content Credentials are missing.', cause: 'Provenance rule disabled; a third-party tool re-saved the file and dropped the manifest (malformed/missing data).', fix: 'Require Content Credentials; auto-fix regenerates the image via the image API.' },
    { id: 'safetyOff', title: 'Suggestive ad goes live', values: { image: 'unsafe', safetyThr: 'off' }, node: 'safety',
      symptom: 'Missed: inappropriate content.', cause: 'Content Safety check disabled.', fix: 'Block at Medium (4+) per policy.' },
  ],

  challenge: {
    task: 'Gate the whole batch correctly: no violation published, no false flags, credentials valid on everything published, and at least 5 of the 7 images published (clean or fixed).',
    condition: 'Scope = batch, missed violations 0, false flags 0, credentials broken 0, published ≥ 5/7.',
    hint: 'Some violations can be fixed automatically; fixing changes pixels. The two images that cannot be fixed should be rejected.',
    check: (p, res) => p.scope === 'batch' && ['Missed violations', 'False flags', 'Credentials broken by edits'].every(l => (res.metrics.find(m => m.label === l) || {}).value === '0') && Number(((res.metrics.find(m => m.label === 'Published') || {}).value || '0/').split('/')[0]) >= 5,
    solution: ['Scope: whole batch.', 'Keep provenance and disclosure rules on; use the custom symbol detector (the multimodal judge misses the subtle symbol and flags a decorative star).', 'Brand rules at the guideline values: 10% and 4 units. Content Safety at Medium (4+).', 'Remediation: auto-fix with re-signing on. Result: 5 published, symbol and unsafe images rejected.'],
    solutionValues: { scope: 'batch', ruleProvenance: true, ruleLabel: true, detector: 'custom', ruleBrand: true, minLogo: 10, clearSpace: 4, safetyThr: '4', remediation: 'autoFix', resign: true },
  },

  quiz: [
    { q: 'Your pipeline adds an "AI-generated" overlay to images from Azure OpenAI and then publishes them. An audit finds the Content Credentials no longer validate. Why, and what should you do?', options: ['The overlay is not supported; remove it', 'Editing pixels invalidates the signed manifest; re-sign with C2PA tooling that records the edit (or regenerate)', 'Content Credentials expire after 24 hours', 'Use PNG instead of JPEG'], answer: 1, why: 'A C2PA manifest binds to the content; edits must be recorded in a new signed manifest.' },
    { q: 'You must reliably flag a fixed list of banned symbols, including partially occluded ones. Which approach fits best?', options: ['A general multimodal model with a one-line prompt', 'A custom detector trained on labelled examples of the symbols', 'OCR', 'Content Safety text blocklists'], answer: 1, why: 'A closed list of visual patterns with hard cases is a detection task for a trained model; blocklists are text-only.' },
    { q: 'Many compliant images are rejected for "logo too small". The guideline says 10%; your rule uses 15%. What is the issue?', options: ['Detector accuracy', 'Rule configuration stricter than policy, producing false positives', 'Missing Content Credentials', 'Content Safety threshold'], answer: 1, why: 'Rule parameters must mirror the written policy; validate them on known-good samples.' },
  ],

  recap: 'A visual policy gate checks provenance (C2PA Content Credentials) and visible disclosure, detects prohibited symbols with a suitable detector, enforces brand geometry and colours from the guideline, screens with Content Safety, auto-fixes only what is safe, re-signs edited images, and rejects the rest. Measure missed violations and false flags on a labelled batch.',
};
