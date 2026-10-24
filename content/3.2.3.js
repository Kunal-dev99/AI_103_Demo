// 3.2.3 Implement a solution that enables question-answering grounded in visual evidence
// Lab: Grounded visual QA bench.
import { rng, round, step, metric, words } from '../src/engine/util.js';

// Loading-dock scene on a 100x70 canvas. Regions are the ground-truth evidence the model may cite.
const REGIONS = [
  { id: 'truck', label: 'truck', x: 4, y: 18, w: 40, h: 36, tags: 'truck lorry vehicle trailer' },
  { id: 'plate', label: 'plate "KX-42 PLM"', x: 17, y: 46, w: 14, h: 5, small: true, tags: 'plate licence license registration number truck', text: 'KX-42 PLM', misread: 'KX-42 PIM' },
  { id: 'door', label: 'dock door "3"', x: 50, y: 4, w: 10, h: 8, tags: 'door dock bay number', text: 'Dock 3' },
  { id: 'sign', label: 'sign "MAX LOAD 2 t"', x: 72, y: 10, w: 22, h: 7, small: true, tags: 'sign maximum max load limit weight capacity', text: '2 t', misread: '7 t' },
  { id: 'clock', label: 'clock 10:15', x: 88, y: 0.5, w: 10, h: 9, small: true, tags: 'clock time', text: '10:15' },
  { id: 'worker', label: 'worker (hi-vis)', x: 46, y: 28, w: 8, h: 24, tags: 'worker person people staff vest' },
  ...[0, 1, 2, 3].map(i => ({ id: `pallet${i + 1}`, label: `pallet ${i + 1}`, x: 58 + i * 10, y: 44, w: 8, h: 9, tags: 'pallet pallets dock boxes count', pallet: true })),
];
const SCENE = [
  { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#cfd8dc' }, { kind: 'rect', x: 0, y: 53, w: 100, h: 17, fill: '#78909c' },
  { kind: 'rect', x: 48, y: 12, w: 50, h: 41, fill: '#90a4ae' },
  { kind: 'rect', x: 4, y: 18, w: 40, h: 32, fill: '#eceff1' }, { kind: 'circle', x: 12, y: 53, r: 4, fill: '#212121' }, { kind: 'circle', x: 36, y: 53, r: 4, fill: '#212121' },
  { kind: 'rect', x: 17, y: 46, w: 14, h: 5, fill: '#fdd835' }, { kind: 'text', x: 17.5, y: 50, text: 'KX-42 PLM', fill: '#212121' },
  { kind: 'rect', x: 50, y: 4, w: 10, h: 8, fill: '#ffffff' }, { kind: 'text', x: 53.5, y: 10.5, text: '3', fill: '#212121' },
  { kind: 'rect', x: 72, y: 10, w: 22, h: 7, fill: '#ffffff' }, { kind: 'text', x: 73, y: 15.5, text: 'MAX LOAD 2 t', fill: '#c62828' },
  { kind: 'circle', x: 93, y: 5, r: 4.5, fill: '#fafafa' }, { kind: 'line', x: 93, y: 5, x2: 93, y2: 1.5, fill: '#212121' }, { kind: 'line', x: 93, y: 5, x2: 95.5, y2: 5.5, fill: '#212121' },
  { kind: 'rect', x: 47, y: 34, w: 6, h: 10, fill: '#ff9800' }, { kind: 'circle', x: 50, y: 31, r: 2.5, fill: '#f1c27d' }, { kind: 'rect', x: 47.5, y: 44, w: 5, h: 8, fill: '#37474f' },
  ...[0, 1, 2, 3].map(i => ({ kind: 'rect', x: 58 + i * 10, y: 44, w: 8, h: 9, fill: i % 2 ? '#a1887f' : '#8d6e63' })),
];

const QUESTIONS = {
  plate: { label: 'What is the truck\'s licence plate?', evidence: ['plate'], answer: r => r.text },
  pallets: { label: 'How many pallets are on the dock?', evidence: ['pallet1', 'pallet2', 'pallet3', 'pallet4'], answer: () => '4 pallets' },
  load: { label: 'What is the maximum load shown on the sign?', evidence: ['sign'], answer: r => r.text },
  close: { label: 'What time does the dock close?', evidence: [], distractor: 'clock', hallucination: 'The dock closes at 18:00.' },
  employer: { label: 'Which company employs the driver?', evidence: [], hallucination: 'The driver works for Contoso Logistics.' },
  custom: { label: 'Custom question…', evidence: null },
};
const MODELS = { 'gpt-4.1': { label: 'gpt-4.1', vision: true, boxNoise: 1 }, 'gpt-4o-mini': { label: 'gpt-4o-mini', vision: true, boxNoise: 2 }, 'gpt-35-turbo': { label: 'gpt-35-turbo (text only)', vision: false } };

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

function run(p) {
  const steps = [];
  const m = MODELS[p.model];
  const qd = QUESTIONS[p.question];
  const qText = p.question === 'custom' ? String(p.customQuestion || '') : qd.label;
  const img = extra => ({ type: 'image', title: 'Loading dock (camera 2)', width: 100, height: 70, shapes: [...SCENE, ...extra] });
  const fail = (node, title, detail, data, summary) => { steps.push(step(node, title, detail, data, 'error')); return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, img([])], metrics: [metric('Grounded', 'no', 'computed')], summary }; };

  if (!qText.trim()) return fail('question', 'Empty question', 'Provide a question about the image.', {}, 'Rejected: empty question');
  steps.push(step('question', 'Question received', qText, { question: qText, grounding: p.grounding, structured: p.structured }));
  if (!m.vision) return fail('model', 'HTTP 400: model does not accept images', `${m.label} cannot see the image. Use a multimodal deployment.`, { model: p.model }, 'Rejected: text-only model');

  // Resolve which regions truly answer the question (ground truth for this lab).
  let evidenceIds = qd.evidence;
  if (evidenceIds === null) {
    const qw = new Set(words(qText).filter(w => w.length > 2));
    const score = r => words(r.tags).filter(t => qw.has(t)).length;
    evidenceIds = REGIONS.filter(r => score(r) > 0 && r.text).sort((a, b) => score(b) - score(a)).map(r => r.id).slice(0, 1);
    if (!evidenceIds.length) evidenceIds = REGIONS.filter(r => r.pallet && /pallet/i.test(qText)).map(r => r.id);
  }
  const answerable = evidenceIds.length > 0;
  steps.push(step('prompt', p.grounding ? 'Grounding instructions applied' : 'No grounding instructions', p.grounding
    ? 'System: "Answer only from visible evidence. Cite each supporting region as a box [x, y, w, h]. If the image does not show the answer, set answerable=false and say what is visible instead."'
    : 'System: "You are a helpful assistant." The model is free to fill gaps with plausible guesses.', { response_format: p.structured ? 'json_schema: {answer, answerable, evidence[{label, box}], confidence}' : 'text' }, p.grounding ? 'ok' : 'info'));

  // Model answer (simulated)
  const r = rng(`${qText}|${p.detail}|${p.model}`);
  const noise = (p.detail === 'high' ? 1 : 3.5) * m.boxNoise;
  let answer, conf, cited = [], misread = false;
  if (answerable) {
    const regs = evidenceIds.map(id => REGIONS.find(x => x.id === id));
    const small = regs.some(x => x.small);
    misread = small && p.detail === 'low';
    const main = regs[0];
    answer = main.pallet ? qd.answer() : misread ? main.misread : (qd.answer ? qd.answer(main) : main.text);
    conf = round(misread ? 0.42 + r() * 0.1 : small ? 0.86 + r() * 0.06 : 0.9 + r() * 0.05, 2);
    cited = regs.map(x => ({ id: x.id, label: x.label, box: { x: round(x.x + (r() - 0.5) * noise, 1), y: round(x.y + (r() - 0.5) * noise, 1), w: round(x.w * (1 + (r() - 0.5) * noise * 0.08), 1), h: round(x.h * (1 + (r() - 0.5) * noise * 0.08), 1) }, truth: x }));
  } else if (p.grounding) {
    answer = qd.distractor ? 'Not visible in the image. A wall clock shows about 10:15 (the current time), but no closing time is shown.' : 'Not visible in the image. Nothing in the scene identifies the driver\'s employer.';
    conf = 0;
    if (qd.distractor) { const d = REGIONS.find(x => x.id === qd.distractor); cited = [{ id: d.id, label: `${d.label} (context only)`, box: { x: d.x, y: d.y, w: d.w, h: d.h }, truth: d, context: true }]; }
  } else {
    answer = qd.hallucination || 'Probably yes, based on the scene.';
    conf = 0.8;
  }

  // OCR cross-check (app-side verification of text answers)
  let corrected = false;
  if (p.verify && misread) { answer = evidenceIds.map(id => REGIONS.find(x => x.id === id))[0].text; conf = 0.93; corrected = true; }
  steps.push(step('model', 'Model answer', `"${answer}" (self-reported confidence ${conf})`, p.structured ? { answer, answerable: answerable || !p.grounding, evidence: cited.map(c => ({ label: c.label, box: [c.box.x, c.box.y, c.box.w, c.box.h] })), confidence: conf } : { text: answer }, 'ok'));
  if (p.verify) steps.push(step('verify', corrected ? 'OCR cross-check corrected the answer' : 'OCR cross-check', corrected ? 'Azure AI Vision Read on the cited box returned different text than the model; the OCR value replaced the model reading and the change was logged.' : answerable && evidenceIds.some(id => REGIONS.find(x => x.id === id).text) ? 'OCR on the cited box agrees with the model.' : 'Nothing to OCR for this answer.', { method: 'crop cited box → Vision Read (illustrative)' }, corrected ? 'info' : 'ok'));

  // Evidence validation
  const meanIou = cited.filter(c => !c.context).length ? cited.filter(c => !c.context).reduce((a, c) => a + iou(c.box, c.truth), 0) / cited.filter(c => !c.context).length : 0;
  let status = 'ok', title, detail;
  if (!answerable && !p.grounding) { status = 'error'; title = p.structured ? 'Ungrounded answer: no supporting evidence' : 'Hallucinated answer (undetectable: no structured evidence)'; detail = `The image does not contain this information, yet the model answered "${answer}". ${p.structured ? 'The evidence list is empty, so the validator rejects it.' : 'With free text the app cannot even tell.'} Turn on grounding instructions so the model says "not visible".`; }
  else if (!answerable) { title = 'Correct refusal'; detail = 'The model declined and described what is visible instead of guessing.'; }
  else if (!p.structured) { status = 'warn'; title = 'Answer has no machine-readable evidence'; detail = 'Evidence is described in prose, so the app cannot draw boxes, validate them, or show reviewers where the answer came from. Use structured outputs.'; }
  else if (conf < p.minConfidence) { status = 'warn'; title = 'Low confidence: route to human review'; detail = `Confidence ${conf} < threshold ${p.minConfidence}. ${misread ? 'Small text read at low detail is unreliable (the value is actually wrong).' : ''}`; }
  else { title = 'Answer grounded'; detail = `${cited.length} evidence region(s); mean box IoU ${round(meanIou, 2)} with ground truth. Multimodal LLM boxes are approximate; for precise localisation use an object-detection service.`; }
  steps.push(step('evidence', title, detail, { answerable, cited: cited.length, meanIou: round(meanIou, 2), confidence: conf, correct: answerable ? !misread || corrected : !p.grounding ? false : true }, status));

  const shapes = p.structured || !answerable ? cited.map(c => ({ kind: 'box', ...c.box, label: c.label, tone: c.context ? 'info' : status === 'ok' ? 'ok' : 'warn', dashed: !!c.context })) : [];
  const json = { answer, answerable: answerable || !p.grounding, evidence: cited.map(c => ({ label: c.label, box: [c.box.x, c.box.y, c.box.w, c.box.h] })), confidence: conf };
  return {
    steps,
    output: [
      img(shapes),
      { type: 'chat', title: 'Exchange', turns: [{ role: 'user', text: `${qText}\n[image: dock_cam2.jpg, detail=${p.detail}]` }, { role: 'assistant', text: p.structured ? JSON.stringify(json, null, 1) : answer + (answerable ? ' (I can see it near the truck / dock area.)' : '') }] },
      { type: 'table', title: 'Evidence', columns: ['Region', 'Box [x,y,w,h]', 'IoU vs truth', 'Role'], rows: cited.length ? cited.map(c => [c.label, `[${c.box.x}, ${c.box.y}, ${c.box.w}, ${c.box.h}]`, c.context ? '—' : String(round(iou(c.box, c.truth), 2)), c.context ? 'context only' : 'supports answer']) : [['—', '—', '—', answerable ? 'missing' : 'no evidence exists']], tones: cited.length ? cited.map(c => (c.context ? 'info' : iou(c.box, c.truth) > 0.5 ? 'ok' : 'warn')) : [status === 'error' ? 'error' : 'info'] },
      ...(status === 'error' ? [{ type: 'alert', tone: 'error', text: 'Never show an answer without evidence for questions the image cannot answer.' }] : []),
    ],
    metrics: [
      metric('Answer correct', answerable ? (!misread || corrected ? 'yes' : 'no (misread)') : p.grounding ? 'yes (refused)' : 'no (hallucinated)', 'computed', 'Compared with the lab\'s ground truth.'),
      metric('Evidence regions', String(cited.filter(c => !c.context).length), 'computed'),
      metric('Mean box IoU', cited.filter(c => !c.context).length ? String(round(meanIou, 2)) : '—', 'computed', 'Overlap of cited boxes with ground-truth regions; noise grows at low detail (simulation rule).'),
      metric('Image tokens', p.detail === 'high' ? '~765' : '~85', 'estimate', 'GPT-4o-class tile formula for a 1024x768 image; other models differ.'),
    ],
    summary: `${p.question}: "${answer.slice(0, 30)}" • ${status}${corrected ? ' • OCR-corrected' : ''}`,
  };
}

export default {
  id: '3.2.3',
  lab: 'Grounded visual QA bench',
  services: [
    { name: 'Use vision-enabled chat models', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/gpt-with-vision' },
    { name: 'Structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
    { name: 'Azure AI Vision OCR (Read)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-ocr' },
  ],
  prereqs: ['3.2.1'],
  next: ['3.2.8', '3.2.4'],

  concept: {
    plain: 'When someone asks a question about a photo, a trustworthy answer points at the part of the picture that proves it ("the plate reads KX-42 PLM — here"). If the photo does not contain the answer, the right reply is "I can\'t see that", not a confident guess. Your app should ask for the proof, check it, and treat answers without proof as unreliable.',
    technical: 'Grounded visual QA sends the image and question to a multimodal model with a system message that restricts answers to visible evidence and a structured-outputs JSON schema ({answer, answerable, evidence[{label, box}], confidence}). The app validates the response: unanswerable questions must yield answerable=false; answers need at least one evidence box; low confidence routes to review. Boxes from multimodal LLMs are approximate; for exact localisation pair with an object-detection or OCR service (for example Azure AI Vision Read on the cited crop) to verify text answers. Use detail high for small text.',
    useCase: 'A yard-management app lets gate staff ask questions about dock-camera stills ("Which bay is the KX-42 truck at?"). Every answer shows highlighted evidence boxes; text values such as plates are double-checked with OCR on the cited crop, and questions the image cannot answer return "not visible" instead of a guess.',
    terms: [
      ['Grounding', 'Tying each answer to specific visible evidence.'],
      ['Evidence box', 'Region [x, y, w, h] the model cites as support; approximate for LLMs.'],
      ['answerable flag', 'Schema field that lets the model say the image does not contain the answer.'],
      ['IoU', 'Intersection over union: how well a cited box overlaps the true region.'],
      ['Cross-check', 'Verifying a cited region with a deterministic tool (OCR, detector) before trusting the value.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'question', label: 'Question + image', col: 0, row: 1, kind: 'user', detail: 'What the user wants to know about the image.' },
          { id: 'prompt', label: p && p.grounding ? 'Grounding rules + schema' : 'No grounding rules', col: 1, row: 1, kind: 'policy', detail: 'Evidence-only answers; answerable flag; boxes.' },
          { id: 'model', label: 'Multimodal model', col: 2, row: 1, kind: 'ai', detail: 'Answers and cites regions.', badge: p ? `detail ${p.detail}` : undefined },
          { id: 'verify', label: 'OCR cross-check', col: 3, row: 0, kind: 'compute', disabled: p && !p.verify, detail: 'Re-reads text in the cited box.' },
          { id: 'evidence', label: 'Evidence validator', col: 3, row: 2, kind: 'policy', detail: 'Empty evidence → reject; low confidence → review.' },
        ],
        edges: [['question', 'prompt'], ['prompt', 'model'], ['model', 'verify'], ['model', 'evidence'], ['verify', 'evidence']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'question', label: 'Gate app (Static Web Apps)', col: 0, row: 1, kind: 'app', detail: 'Shows answer with highlighted boxes.' },
          { id: 'prompt', label: 'API (Container Apps, managed identity)', col: 1, row: 1, kind: 'compute', detail: 'Builds messages and JSON schema; validates response.' },
          { id: 'model', label: `Foundry deployment: ${p ? p.model : 'gpt-4.1'}`, col: 2, row: 1, kind: 'ai', detail: 'Vision-capable chat model.' },
          { id: 'verify', label: 'Azure AI Vision (Read)', col: 3, row: 0, kind: 'ai', detail: 'OCR on cited crops.', disabled: p && !p.verify },
          { id: 'evidence', label: 'Review queue (Service Bus)', col: 3, row: 2, kind: 'store', detail: 'Low-confidence or unverified answers.' },
        ],
        edges: [['question', 'prompt'], ['prompt', 'model', 'chat + schema'], ['prompt', 'verify', 'crop'], ['prompt', 'evidence']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'question', label: 'messages = [system(GROUNDING), user([text(q), image_url(url, detail)])]', col: 0, row: 0, kind: 'code', detail: 'Grounding rules in the system message.' },
          { id: 'prompt', label: 'response_format = {"type":"json_schema", "json_schema": QA_SCHEMA}', col: 0, row: 1, kind: 'code', detail: 'answer, answerable, evidence[{label, box}], confidence.' },
          { id: 'model', label: 'resp = client.chat.completions.create(model=dep, messages, response_format)', col: 0, row: 2, kind: 'code', detail: 'Illustrative.' },
          { id: 'verify', label: 'ocr = read(crop(img, ev.box)); if ocr != answer: answer = ocr', col: 0, row: 3, kind: 'code', detail: 'Deterministic verification of text answers.', disabled: p && !p.verify },
          { id: 'evidence', label: 'if not r.answerable or not r.evidence or r.confidence < T: review()', col: 0, row: 4, kind: 'code', detail: 'Never display ungrounded answers as facts.' },
        ],
        edges: [['question', 'prompt'], ['prompt', 'model'], ['model', 'verify'], ['verify', 'evidence']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'question', label: 'Question', type: 'select', options: Object.entries(QUESTIONS).map(([v, q]) => [v, q.label]), default: 'plate' },
      { id: 'customQuestion', label: 'Custom question text', type: 'text', default: 'Which dock door number is shown?' },
      { id: 'model', label: 'Model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-4.1' },
      { id: 'detail', label: 'detail', type: 'select', options: [['low', 'low'], ['high', 'high']], default: 'low' },
      { id: 'grounding', label: 'Grounding instructions (evidence only, allow "not visible")', type: 'toggle', default: true },
      { id: 'structured', label: 'Structured output (JSON schema with boxes)', type: 'toggle', default: true },
      { id: 'verify', label: 'OCR cross-check of cited text', type: 'toggle', default: false },
      { id: 'minConfidence', label: 'Minimum confidence', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.7 },
    ],
    samples: [
      { label: 'Plate at low detail', values: {} },
      { label: 'Plate at high detail', values: { detail: 'high' } },
      { label: 'Count pallets', values: { question: 'pallets' } },
      { label: 'Closing time (not in image), grounded', values: { question: 'close' } },
      { label: 'Custom: dock door', values: { question: 'custom', customQuestion: 'Which dock door number is shown?', detail: 'high' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Ask for the plate at low vs high detail: compare answer, confidence and box IoU.',
      'Ask "What time does the dock close?" with grounding on vs off.',
      'Run the plate at low detail with OCR cross-check off vs on.',
    ],
  },

  debug: [
    { id: 'halluc', title: 'Confident answer about something not in the image', values: { question: 'employer', grounding: false }, node: 'evidence',
      symptom: '"The driver works for Contoso Logistics" — with no evidence.', cause: 'No grounding instruction: the model fills the gap with a plausible guess.', fix: 'Turn on grounding instructions so the model returns answerable=false / "not visible".' },
    { id: 'distractor', title: 'Clock read as closing time', values: { question: 'close', grounding: false }, node: 'evidence',
      symptom: 'Answer "18:00" or the clock time presented as closing time.', cause: 'Related-but-insufficient evidence plus no grounding rule.', fix: 'Enable grounding; the model should cite the clock as context only and say the closing time is not visible.' },
    { id: 'misread', title: 'Wrong plate, low confidence', values: { question: 'plate', detail: 'low', verify: false }, node: 'model',
      symptom: 'Answer KX-42 PIM (wrong) with confidence ~0.45.', cause: 'Small text read at low detail.', fix: 'Use detail high, or cross-check the cited box with OCR.' },
    { id: 'prose', title: 'No boxes to show reviewers', values: { structured: false, detail: 'high' }, node: 'evidence',
      symptom: 'Answer text only; the app cannot highlight evidence.', cause: 'Malformed/unstructured output: evidence described in prose.', fix: 'Enable structured output with a JSON schema that includes evidence boxes.' },
    { id: 'textmodel', title: 'Model cannot see the image', values: { model: 'gpt-35-turbo' }, node: 'model',
      symptom: 'HTTP 400: image input not supported.', cause: 'Unsuitable model.', fix: 'Use gpt-4.1 or gpt-4o-mini.' },
  ],

  challenge: {
    task: 'Answer "What is the truck\'s licence plate?" correctly with at least one evidence box, confidence at or above a 0.8 threshold, and no warnings or errors.',
    condition: 'Question = plate, minimum confidence ≥ 0.8, structured + grounding on, correct answer, no warn/error step.',
    hint: 'The plate is small. Either let the model see more pixels, or verify what it cites.',
    check: (p, res) => p.question === 'plate' && p.minConfidence >= 0.8 && p.structured && p.grounding && res.steps.some(s => s.node === 'evidence' && s.status === 'ok' && s.data && s.data.correct) && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Keep grounding and structured output on.', 'Set detail to high (or enable OCR cross-check).', 'Set minimum confidence to 0.8.'],
    solutionValues: { question: 'plate', model: 'gpt-4.1', detail: 'high', grounding: true, structured: true, verify: false, minConfidence: 0.8 },
  },

  quiz: [
    { q: 'Users ask your visual QA app questions the photo cannot answer and get confident made-up replies. What is the best fix?', options: ['Raise temperature', 'Instruct evidence-only answers and add an answerable flag in a JSON schema; reject answers without evidence', 'Use detail low', 'Add more images'], answer: 1, why: 'Grounding instructions plus a schema that allows "not answerable", enforced by validation, prevent ungrounded answers.' },
    { q: 'Auditors need to see where in the image each answer came from. What should the response contain?', options: ['A longer explanation', 'Evidence entries with labels and bounding boxes, rendered over the image', 'The token count', 'The system prompt'], answer: 1, why: 'Region citations make answers verifiable.' },
    { q: 'Plate numbers cited by the model are sometimes wrong although the cited box is correct. Which addition improves reliability most?', options: ['Ask the model to be more careful', 'Crop the cited box and verify the text with OCR (Vision Read) before accepting', 'Use structured outputs only', 'Lower the confidence threshold'], answer: 1, why: 'Deterministic OCR on the cited region verifies text values the LLM may misread.' },
  ],

  recap: 'Grounded visual QA = evidence-only instructions + a JSON schema with answer, answerable, evidence boxes and confidence + app-side validation (reject empty evidence, review low confidence) + optional OCR/detector cross-checks. Use high detail for small text, and treat LLM boxes as approximate.',
};
