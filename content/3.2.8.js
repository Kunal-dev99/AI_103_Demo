// 3.2.8 Implement solutions that identify objects, components, or regions within images or video
// Lab: Object detection precision lab.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

// Ground-truth objects on a 100 x 70 canvas. fill = how the synthetic scene draws them.
const SCENES = {
  shelf: {
    label: 'Retail shelf (bottles, boxes, price tags)',
    background: '#f1ece4',
    decor: [{ kind: 'rect', x: 0, y: 30, w: 100, h: 2, fill: '#8d6e63' }, { kind: 'rect', x: 0, y: 64, w: 100, h: 2, fill: '#8d6e63' }],
    objects: [
      ['bottle', 6, 11, 6, 19, '#2e7d32'], ['bottle', 15, 11, 6, 19, '#2e7d32'], ['bottle', 24, 11, 6, 19, '#1565c0'], ['bottle', 33, 11, 6, 19, '#1565c0'],
      ['box', 52, 16, 14, 14, '#ef6c00'], ['box', 70, 16, 14, 14, '#ef6c00'], ['box', 20, 48, 16, 16, '#6d4c41'],
      ['price tag', 8, 32, 4, 2.5, '#fff59d'], ['price tag', 26, 32, 4, 2.5, '#fff59d'], ['price tag', 56, 32, 4, 2.5, '#fff59d'], ['price tag', 74, 32, 4, 2.5, '#fff59d'],
    ],
  },
  pcb: {
    label: 'Circuit board inspection (chips, capacitors, connector, empty pad)',
    background: '#1b5e20',
    decor: [{ kind: 'line', x: 10, y: 35, x2: 90, y2: 35, tone: 'warn' }, { kind: 'line', x: 50, y: 5, x2: 50, y2: 65, tone: 'warn' }],
    objects: [
      ['chip', 14, 10, 16, 12, '#212121'], ['chip', 62, 40, 16, 12, '#212121'],
      ['capacitor', 38, 12, 4, 4, '#90a4ae'], ['capacitor', 44, 12, 4, 4, '#90a4ae'], ['capacitor', 14, 44, 4, 4, '#90a4ae'], ['capacitor', 22, 50, 4, 4, '#90a4ae'], ['capacitor', 84, 14, 4, 4, '#90a4ae'],
      ['connector', 30, 58, 24, 6, '#eeeeee'],
      ['empty pad', 84, 26, 5, 5, '#c0a060'],
    ],
  },
  yard: {
    label: 'Warehouse yard (forklifts, pallets, people)',
    background: '#cfd8dc',
    decor: [{ kind: 'line', x: 0, y: 40, x2: 100, y2: 40, tone: 'muted' }],
    objects: [
      ['forklift', 8, 20, 18, 16, '#f9a825'], ['forklift', 60, 44, 18, 16, '#f9a825'],
      ['pallet', 32, 30, 14, 6, '#a1887f'], ['pallet', 32, 22, 14, 6, '#a1887f'], ['pallet', 82, 30, 14, 6, '#a1887f'], ['pallet', 40, 58, 14, 6, '#a1887f'],
      ['person', 52, 18, 4, 11, '#5c6bc0'], ['person', 88, 50, 4, 11, '#5c6bc0'], ['person', 70, 10, 2, 5, '#5c6bc0'],
    ],
  },
};

const MODELS = {
  vision: { label: 'Azure AI Vision Image Analysis: object detection (generic taxonomy)', base: 0.8, small: 0.55, jitter: 0.07, dupes: 1, fp: 3, fpConf: 0.4, known: ['bottle', 'box', 'person'], calibrated: true },
  llm: { label: 'Multimodal LLM prompted for JSON bounding boxes', base: 0.78, small: 0.4, jitter: 0.24, dupes: 0, fp: 1, fpConf: 0.72, known: 'all', calibrated: false },
  custom: { label: 'Custom-trained detector (your labelled images)', base: 0.9, small: 0.5, jitter: 0.04, dupes: 2, fp: 3, fpConf: 0.35, known: 'all', calibrated: true },
  customOther: { label: 'Custom detector from another project (different label set)', base: 0.9, small: 0.5, jitter: 0.04, dupes: 2, fp: 3, fpConf: 0.35, known: [], calibrated: true },
};

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a.w * a.h + b.w * b.h - inter;
  return u ? inter / u : 0;
};

function candidates(scene, model, p) {
  const r = rng(`${p.scene}|${p.model}|${p.tiling}`);
  const out = [];
  scene.objects.forEach(([cls, x, y, w, h], i) => {
    const knows = model.known === 'all' || model.known.includes(cls);
    if (!knows) { r(); r(); r(); return; }
    const small = w * h < 30;
    const pen = small ? model.small * (p.tiling ? 0.35 : 1) : 0;
    const conf = clamp(model.base - pen + (r() - 0.5) * 0.16, 0.02, 0.99);
    const j = model.jitter;
    const jx = (r() - 0.5) * 2 * j * w, jy = (r() - 0.5) * 2 * j * h, js = 1 + (r() - 0.5) * 2 * j;
    out.push({ cls, x: x + jx, y: y + jy, w: w * js, h: h * js, conf, gt: i });
    for (let d = 0; d < model.dupes; d++) {
      const s = 0.12 + d * 0.06;
      out.push({ cls, x: x + w * s * (d ? -1 : 1), y: y + h * s * 0.5, w: w * (1 + s * 0.4), h: h * (1 - s * 0.3), conf: clamp(conf - 0.12 - d * 0.12 - r() * 0.05, 0.02, 0.99), gt: i, dup: true });
    }
  });
  const classes = [...new Set(scene.objects.map(o => o[0]))].filter(c => model.known === 'all' || model.known.includes(c));
  for (let k = 0; k < model.fp && classes.length; k++) {
    const cls = classes[Math.floor(r() * classes.length)];
    out.push({ cls, x: 5 + r() * 80, y: 5 + r() * 55, w: 6 + r() * 8, h: 5 + r() * 6, conf: clamp(model.fpConf - r() * 0.2, 0.02, 0.99), fp: true });
  }
  return out.map(c => ({ ...c, x: round(c.x, 1), y: round(c.y, 1), w: round(c.w, 1), h: round(c.h, 1), conf: round(c.conf, 2) }));
}

function nms(dets, thr) {
  const kept = [];
  for (const d of [...dets].sort((a, b) => b.conf - a.conf)) if (!kept.some(k => k.cls === d.cls && iou(k, d) > thr)) kept.push(d);
  return kept;
}

function run(p) {
  const scene = SCENES[p.scene] || SCENES.shelf;
  const model = MODELS[p.model] || MODELS.custom;
  const steps = [];
  const gtShapes = scene.objects.map(([cls, x, y, w, h, fill]) => ({ kind: 'rect', x, y, w, h, fill }));
  const base = [{ kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: scene.background }, ...scene.decor, ...gtShapes];

  if (p.input === 'oversize') {
    steps.push(step('input', 'Image rejected (400)', 'The upload exceeds the service’s size/dimension limits. Limits differ per service and API version; check the docs.', { httpStatus: 400, code: 'InvalidImageSize (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Resize or tile the image before sending it.' }, { type: 'image', title: scene.label, shapes: base }], metrics: [], summary: 'Rejected: image too large' };
  }
  steps.push(step('input', 'Image received', `${scene.label}. ${scene.objects.length} labelled objects in ground truth.${p.tiling ? ' Split into 4 overlapping tiles at higher resolution.' : ''}`, { objects: scene.objects.length, tiling: p.tiling }));

  const wanted = [...new Set(scene.objects.map(o => o[0]))];
  const unknown = wanted.filter(c => !(model.known === 'all' || model.known.includes(c)));
  if (unknown.length === wanted.length) {
    steps.push(step('detect', 'No usable detections', p.model === 'customOther'
      ? 'The model’s label set does not include any of the classes this app needs (bottle, chip, …). It was trained for another project.'
      : `None of the required classes (${wanted.join(', ')}) exist in this model’s generic taxonomy.`, { requiredClasses: wanted, modelClasses: model.known }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Choose a model whose classes cover your objects: a custom detector trained on your labels, or an open-vocabulary multimodal model.' }, { type: 'image', title: scene.label, shapes: base }], metrics: [], summary: `${p.scene} • ${p.model}: classes not supported` };
  }

  const raw = candidates(scene, model, p);
  steps.push(step('detect', `${raw.length} raw candidates`, `${model.label}.${unknown.length ? ` Not in taxonomy: ${unknown.join(', ')}.` : ''}${model.calibrated ? '' : ' Scores are self-reported by the language model, not calibrated probabilities.'}`,
    { sample: raw.slice(0, 4) }, unknown.length ? 'warn' : 'ok'));

  const passed = raw.filter(d => d.conf >= p.threshold);
  steps.push(step('threshold', `${passed.length} above ${p.threshold}`, `Confidence threshold removed ${raw.length - passed.length} candidates.`, { kept: passed.length, dropped: raw.length - passed.length }, 'ok'));

  const final = p.nms ? nms(passed, p.nmsIou) : passed;
  steps.push(step('nms', p.nms ? `NMS kept ${final.length}` : 'NMS off', p.nms ? `Suppressed ${passed.length - final.length} overlapping same-class boxes (IoU > ${p.nmsIou}).` : 'Overlapping duplicates are passed through.', { before: passed.length, after: final.length }, !p.nms && passed.length - final.length === 0 && passed.some(d => d.dup) ? 'warn' : 'ok'));

  // Evaluation against ground truth at IoU 0.5
  const gts = scene.objects.map(([cls, x, y, w, h], i) => ({ cls, x, y, w, h, i, matched: false }));
  const evald = [...final].sort((a, b) => b.conf - a.conf).map(d => {
    let best = null, bi = 0;
    for (const g of gts) if (!g.matched && g.cls === d.cls) { const v = iou(d, g); if (v > bi) { bi = v; best = g; } }
    if (best && bi >= 0.5) { best.matched = true; return { ...d, tp: true, iou: round(bi, 2) }; }
    return { ...d, tp: false, iou: round(bi, 2), why: d.dup ? 'duplicate' : d.fp ? 'background' : 'poor localisation' };
  });
  const tp = evald.filter(d => d.tp).length, fp = evald.length - tp, fn = gts.filter(g => !g.matched).length;
  const precision = evald.length ? tp / evald.length : 0, recall = gts.length ? tp / gts.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const smallMissed = gts.filter(g => !g.matched && g.w * g.h < 30).length;
  const evStatus = precision < 0.75 || recall < 0.75 ? 'warn' : 'ok';
  steps.push(step('evaluate', `Precision ${round(precision, 2)} • recall ${round(recall, 2)}`, `${tp} true positives, ${fp} false positives, ${fn} missed (${smallMissed} of them small objects). Match rule: same class and IoU ≥ 0.5.`, { tp, fp, fn, smallMissed }, evStatus));

  const shapes = [...base,
    ...gts.filter(g => !g.matched).map(g => ({ kind: 'box', x: g.x - 0.5, y: g.y - 0.5, w: g.w + 1, h: g.h + 1, label: `missed ${g.cls}`, tone: 'warn', dashed: true })),
    ...evald.map(d => ({ kind: 'box', x: d.x, y: d.y, w: d.w, h: d.h, label: `${d.cls} ${d.conf.toFixed(2)}`, tone: d.tp ? 'ok' : 'error' })),
  ];

  return {
    steps,
    output: [
      { type: 'image', title: `${scene.label}: green = correct, red = false positive, dashed = missed`, shapes },
      { type: 'bars', title: 'Detection quality vs ground truth (IoU ≥ 0.5)', threshold: 0.75, items: [{ label: 'Precision', value: round(precision, 2), tone: precision < 0.75 ? 'warn' : 'ok' }, { label: 'Recall', value: round(recall, 2), tone: recall < 0.75 ? 'warn' : 'ok' }, { label: 'F1', value: round(f1, 2) }] },
      { type: 'table', title: 'Final detections', columns: ['Class', 'Confidence', 'Box (x,y,w,h)', 'IoU with GT', 'Verdict'],
        rows: evald.map(d => [d.cls, d.conf.toFixed(2), `${d.x}, ${d.y}, ${d.w}, ${d.h}`, d.iou.toFixed(2), d.tp ? 'true positive' : `false positive (${d.why})`]), tones: evald.map(d => d.tp ? 'ok' : 'error') },
      { type: 'json', title: 'Detection result (shape illustrative)', data: { model: p.model, objects: evald.slice(0, 3).map(d => ({ tags: [{ name: d.cls, confidence: d.conf }], boundingBox: { x: d.x, y: d.y, w: d.w, h: d.h } })) } },
    ],
    metrics: [
      metric('Precision', round(precision, 2).toFixed(2), 'computed', 'TP / all final detections.'),
      metric('Recall', round(recall, 2).toFixed(2), 'computed', 'TP / ground-truth objects.'),
      metric('F1', round(f1, 2).toFixed(2), 'computed'),
      metric('Relative inference cost', p.tiling ? '~4–5× single pass' : '1× single pass', 'estimate', 'Assumes 4 tiles plus the full image are each analysed. Actual billing depends on the service.'),
    ],
    summary: `${p.scene} • ${p.model} • t=${p.threshold}${p.nms ? ` nms ${p.nmsIou}` : ' no-nms'}${p.tiling ? ' tiled' : ''}: P ${round(precision, 2)} R ${round(recall, 2)}`,
  };
}

export default {
  id: '3.2.8',
  lab: 'Object detection precision lab',
  services: [
    { name: 'Azure AI Vision Image Analysis: object detection', url: 'https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/concept-object-detection-40' },
    { name: 'Custom Vision object detection', url: 'https://learn.microsoft.com/en-us/azure/ai-services/custom-vision-service/get-started-build-detector' },
    { name: 'Vision-enabled chat models in Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/gpt-with-vision' },
  ],
  prereqs: ['3.2.1', '3.2.5'],
  next: ['3.3.3', '3.2.6'],

  concept: {
    plain: 'Object detection answers "what is in this picture and where?": each finding is a box with a label and a confidence. Real detectors produce many overlapping guesses, so you keep only confident ones and merge duplicates. Then you measure: how many boxes were right (precision) and how many real objects were found (recall). Small objects and objects the model was never taught are the usual problems. For video, you run detection on sampled frames and link boxes across frames.',
    technical: 'Options on Azure: Azure AI Vision Image Analysis object detection (generic taxonomy, bounding boxes with confidence; weak on small objects), a custom detector trained on your labelled images (Custom Vision or a model trained/deployed via Azure Machine Learning or Foundry; check current service availability), or a multimodal chat model asked to return JSON boxes (open vocabulary but looser localisation and uncalibrated scores). Post-processing applies a confidence threshold and non-maximum suppression (NMS) by IoU. Evaluate against a labelled set with IoU-based matching (e.g. IoU ≥ 0.5) and tune the threshold for the precision/recall trade-off your scenario needs. Tiling or higher resolution helps small objects at extra cost.',
    useCase: 'An electronics manufacturer inspects circuit boards on a line camera. A custom detector trained on their component labels finds chips, capacitors and connectors and flags empty pads; images are tiled so 2-mm capacitors are visible, and the threshold is tuned on a validation set so missed defects (recall) stay above the quality target.',
    terms: [
      ['Bounding box', 'Rectangle (x, y, width, height) locating a detected object, with a class label and confidence.'],
      ['IoU', 'Intersection over union between two boxes; used for NMS and for matching to ground truth.'],
      ['NMS', 'Non-maximum suppression: keep the highest-scoring box and remove same-class boxes overlapping it above an IoU threshold.'],
      ['Precision / recall', 'Share of detections that are correct / share of real objects that were found.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: p && p.tiling ? 'Image → tiles' : 'Image', col: 0, row: 1, kind: 'data', detail: 'Frame or photo. Tiling helps small objects.' },
          { id: 'detect', label: 'Detector', col: 1, row: 1, kind: 'ai', detail: 'Raw candidate boxes with class + score.', badge: p ? p.model : undefined },
          { id: 'threshold', label: `Threshold ≥ ${p ? p.threshold : 0.5}`, col: 2, row: 0, kind: 'policy', detail: 'Drops low-confidence candidates. Higher = fewer false positives, more misses.' },
          { id: 'nms', label: p && !p.nms ? 'NMS (off)' : `NMS IoU ${p ? p.nmsIou : 0.5}`, col: 2, row: 2, kind: 'policy', detail: 'Removes duplicate boxes on the same object.', disabled: p && !p.nms },
          { id: 'evaluate', label: 'Evaluate vs ground truth', col: 3, row: 1, detail: 'IoU ≥ 0.5 + same class = true positive.', substeps: ['Match boxes greedily by score', 'Count TP / FP / FN', 'Precision, recall, F1'] },
        ],
        edges: [['input', 'detect'], ['detect', 'threshold'], ['threshold', 'nms'], ['nms', 'evaluate']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'Camera → Blob Storage', col: 0, row: 1, kind: 'store', detail: 'Images (or frames sampled from video).' },
          { id: 'detect', label: p ? MODELS[p.model].label : 'Detector', col: 1, row: 1, kind: 'ai', detail: 'Azure AI Vision, a custom detector endpoint, or a multimodal model deployment in Foundry.' },
          { id: 'labels', label: 'Labelled dataset', col: 1, row: 2.5, kind: 'store', detail: 'Training data for custom models and the validation set for evaluation.', disabled: p && p.model !== 'custom' },
          { id: 'threshold', label: 'Post-processing function', col: 2, row: 0.5, kind: 'compute', detail: 'Threshold + NMS in your code (or service options where available).' },
          { id: 'nms', label: 'Detections store', col: 2, row: 1.8, kind: 'store', detail: 'Boxes per image/frame for review and analytics.' },
          { id: 'evaluate', label: 'Evaluation job / dashboard', col: 3, row: 1, kind: 'app', detail: 'Precision/recall on a held-out labelled set; re-run after every threshold or model change.' },
        ],
        edges: [['input', 'detect'], ['labels', 'detect', 'train'], ['detect', 'threshold'], ['threshold', 'nms'], ['nms', 'evaluate'], ['labels', 'evaluate', 'ground truth']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'input', label: p && p.tiling ? 'tiles = split(img, 2, 2, overlap=0.15)' : 'img = load(path)', col: 0, row: 0, kind: 'code', detail: 'Pre-processing.' },
          { id: 'detect', label: p && p.model === 'llm' ? 'client.chat.completions.create(..., response_format=json_schema(boxes))' : p && p.model === 'vision' ? 'ImageAnalysisClient.analyze(img, visual_features=[VisualFeatures.OBJECTS])' : 'detector.predict(img)  # custom endpoint', col: 0, row: 1, kind: 'code', detail: 'Illustrative calls. azure-ai-vision-imageanalysis exposes VisualFeatures.OBJECTS; custom endpoints vary.' },
          { id: 'threshold', label: `dets = [d for d in dets if d.conf >= ${p ? p.threshold : 0.5}]`, col: 0, row: 2, kind: 'code', detail: 'Confidence filter.' },
          { id: 'nms', label: p && p.nms ? `dets = nms(dets, iou=${p.nmsIou})` : '# no NMS', col: 0, row: 3, kind: 'code', detail: 'Per class.' },
          { id: 'evaluate', label: 'p, r = evaluate(dets, ground_truth, iou=0.5)', col: 0, row: 4, kind: 'code', detail: 'Offline evaluation.' },
        ],
        edges: [['input', 'detect'], ['detect', 'threshold'], ['threshold', 'nms'], ['nms', 'evaluate']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'scene', label: 'Scene', type: 'select', options: Object.entries(SCENES).map(([v, s]) => [v, s.label]), default: 'shelf' },
      { id: 'model', label: 'Detector', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'custom' },
      { id: 'threshold', label: 'Confidence threshold', type: 'range', min: 0.05, max: 0.95, step: 0.05, default: 0.5 },
      { id: 'nms', label: 'Non-maximum suppression', type: 'toggle', default: false },
      { id: 'nmsIou', label: 'NMS IoU threshold', type: 'range', min: 0.2, max: 0.9, step: 0.05, default: 0.5 },
      { id: 'tiling', label: 'Tile / upscale for small objects', type: 'toggle', default: false },
      { id: 'input', label: 'Input image', type: 'select', options: [['ok', 'JPEG within limits'], ['oversize', 'Very large image (over service limit)']], default: 'ok' },
    ],
    samples: [
      { label: 'Shelf, custom detector with NMS', values: { scene: 'shelf', model: 'custom', nms: true } },
      { label: 'Shelf, generic Vision taxonomy', values: { scene: 'shelf', model: 'vision', nms: true } },
      { label: 'PCB, multimodal LLM', values: { scene: 'pcb', model: 'llm' } },
      { label: 'Yard, low threshold, no NMS', values: { scene: 'yard', model: 'custom', threshold: 0.1, nms: false } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'On the shelf scene with the custom detector, compare NMS off vs on at threshold 0.3: watch precision.',
      'Sweep the threshold from 0.3 to 0.9 on the yard scene and note where recall collapses.',
      'Run the PCB with the custom detector, tiling off then on: how many capacitors are recovered?',
      'Run the shelf with the generic Vision model vs the multimodal LLM: which finds price tags, and how tight are the boxes?',
    ],
  },

  debug: [
    { id: 'high', title: 'Half the objects are missing', values: { scene: 'yard', model: 'custom', threshold: 0.9, nms: true }, node: 'threshold',
      symptom: 'Recall far below target; dashed "missed" boxes everywhere.', cause: 'Threshold too high for this model’s score distribution (wrong configuration).', fix: 'Lower the threshold (≈0.4–0.6) and tune it on a validation set.' },
    { id: 'dupes', title: 'Every pallet is counted three times', values: { scene: 'yard', model: 'custom', threshold: 0.1, nms: false }, node: 'nms',
      symptom: 'Precision collapses; red duplicate boxes overlap true ones.', cause: 'Threshold very low and NMS disabled, so duplicates and background candidates pass.', fix: 'Enable NMS (IoU ~0.5) and raise the threshold.' },
    { id: 'small', title: 'Capacitors not found', values: { scene: 'pcb', model: 'custom', threshold: 0.5, nms: true, tiling: false }, node: 'input',
      symptom: 'Small components are missed while chips are found.', cause: 'Small objects occupy few pixels at full-frame resolution.', fix: 'Tile/upscale the image for small objects.' },
    { id: 'taxonomy', title: 'Zero detections on the PCB', values: { scene: 'pcb', model: 'vision' }, node: 'detect',
      symptom: 'No usable detections.', cause: 'Generic object taxonomy has no "chip" or "capacitor" (unsuitable model).', fix: 'Use a custom detector trained on your component labels.' },
    { id: 'labels', title: 'Custom model returns nothing useful', values: { model: 'customOther' }, node: 'detect',
      symptom: 'No usable detections.', cause: 'Endpoint points at a model from another project with a different label set (wrong configuration).', fix: 'Point the app at the detector trained for these classes.' },
    { id: 'size', title: 'Upload fails', values: { input: 'oversize' }, node: 'input',
      symptom: '400 before detection.', cause: 'Image exceeds service size/dimension limits (invalid input).', fix: 'Resize or tile before upload (Input image = within limits).' },
  ],

  challenge: {
    task: 'Inspect the circuit board so both precision and recall reach at least 0.85.',
    condition: 'Scene = PCB, precision ≥ 0.85 and recall ≥ 0.85 against ground truth.',
    hint: 'You need a model that knows the component classes, help for the tiny parts, and a way to remove duplicates.',
    check: (p, res) => p.scene === 'pcb' && ['Precision', 'Recall'].every(l => Number((res.metrics.find(m => m.label === l) || {}).value) >= 0.85),
    solution: ['Select the PCB scene and the custom-trained detector.', 'Turn on tiling so capacitors and the empty pad are large enough.', 'Turn on NMS at IoU 0.5 to remove duplicates.', 'Keep the threshold around 0.5 and run.'],
    solutionValues: { scene: 'pcb', model: 'custom', tiling: true, nms: true, nmsIou: 0.5, threshold: 0.5, input: 'ok' },
  },

  quiz: [
    { q: 'Your shelf detector reports each bottle two or three times with overlapping boxes. What should you add first?', options: ['A higher-resolution camera', 'Non-maximum suppression per class', 'A larger language model', 'A lower confidence threshold'], answer: 1, why: 'NMS removes overlapping same-class boxes, keeping the highest-scoring one.' },
    { q: 'You must find 2-mm capacitors on a board image. A custom detector finds chips but misses most capacitors. What is the most effective change?', options: ['Raise the confidence threshold', 'Tile or upscale the image so small objects cover more pixels', 'Switch to the generic object detection taxonomy', 'Turn off NMS'], answer: 1, why: 'Small objects are the classic failure; tiling increases their effective resolution.' },
    { q: 'You need boxes for company-specific parts that generic models do not know, with tight localisation and calibrated scores. Which option fits best?', options: ['Azure AI Vision generic object detection', 'A multimodal LLM asked for JSON boxes', 'A custom detector trained on labelled images of the parts', 'OCR'], answer: 2, why: 'Custom classes and tight boxes call for a trained detector; LLM boxes are looser and their scores are not calibrated.' },
    { q: 'In a safety app, missing a person near a forklift is worse than a false alarm. How should you tune?', options: ['Maximise precision with a high threshold', 'Favour recall with a lower threshold, keep NMS, and check precision stays acceptable on a validation set', 'Disable NMS', 'Evaluate on the training images'], answer: 1, why: 'The cost of misses drives you toward recall; validate on held-out data.' },
  ],

  recap: 'Pick a detector whose classes cover your objects, then tune post-processing: confidence threshold for the precision/recall trade-off, NMS for duplicates, tiling for small objects. Measure with IoU-matched precision and recall on labelled data, and apply the same per-frame logic (plus tracking) to video.',
};
