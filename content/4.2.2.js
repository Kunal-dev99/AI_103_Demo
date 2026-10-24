// 4.2.2 Integrate speech as an agent modality, including custom speech models
// Lab: Custom speech WER bench.
import { rng, round, step, metric } from '../src/engine/util.js';

// Toy test sets: reference transcripts (lowercase, spoken form) and domain terms with typical base-model errors.
const SETS = {
  clinical: {
    label: 'Clinical dictation', agentTool: 'medication_lookup',
    utts: [
      { ref: 'start metoprolol twenty five milligrams twice daily', terms: [{ ref: 'metoprolol', alias: 'metoprolol', base: 'metro pole all' }] },
      { ref: 'patient reports dyspnea on exertion and orthopnea', terms: [{ ref: 'dyspnea', alias: 'dyspnea', base: 'disney a' }, { ref: 'orthopnea', alias: 'orthopnea', base: 'ortho near' }] },
      { ref: 'continue apixaban and recheck creatinine in one week', terms: [{ ref: 'apixaban', alias: 'apixaban', base: 'a pick saban' }] },
      { ref: 'no known allergies to penicillin', terms: [] },
    ],
  },
  manufacturing: {
    label: 'Factory floor reports', agentTool: 'create_work_order',
    utts: [
      { ref: 'replace the hx two forty gasket on press line three', terms: [{ ref: 'hx two forty', alias: 'HX-240', base: 'h x to forty' }] },
      { ref: 'torque the flange bolts to forty newton meters', terms: [{ ref: 'newton meters', alias: 'newton meters', base: 'neutron meters' }] },
      { ref: 'the deburring station reports a spindle fault', terms: [{ ref: 'deburring', alias: 'deburring', base: 'the burring' }] },
      { ref: 'apply lockout tagout before opening the guard', terms: [{ ref: 'lockout tagout', alias: 'lockout tagout', base: 'lock out tag out' }] },
    ],
  },
  contact: {
    label: 'Contact-center calls', agentTool: 'change_plan',
    utts: [
      { ref: 'i want to upgrade to the fabrikam ultra flex plan', terms: [{ ref: 'fabrikam', alias: 'Fabrikam', base: 'fabric cam' }, { ref: 'ultra flex', alias: 'UltraFlex', base: 'ultra flecks' }] },
      { ref: 'my contoso go router keeps dropping wifi', terms: [{ ref: 'contoso go', alias: 'Contoso Go', base: 'can toss so go' }] },
      { ref: 'please cancel the add on for roaming', terms: [] },
    ],
  },
};
const MODELS = {
  base: 'Base model',
  'base+phrase': 'Base model + phrase list',
  custom: 'Custom Speech model',
  'custom+phrase': 'Custom Speech model + phrase list',
};
const TRAINING = {
  'domain-text': 'Plain text from the same domain',
  'domain-audio': 'Domain audio + human-labelled transcripts',
  'other-domain': 'Plain text from another domain (retail catalogue)',
};
const PATHS = {
  sdk: 'Speech SDK STT → agent (text)',
  voicelive: 'Voice Live API (speech-to-speech agent)',
  realtime: 'gpt-realtime model (native audio, no custom STT)',
};

// Word error rate = (S + D + I) / N via Levenshtein on word sequences. Real computation.
function wer(ref, hyp) {
  const a = ref.split(/\s+/).filter(Boolean), b = hyp.split(/\s+/).filter(Boolean);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return { errors: d[a.length][b.length], n: a.length };
}

function transcribe(set, cfg, p) {
  const phrases = String(p.phraseList || '').split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const usePhrase = cfg.includes('phrase') && p.integration !== 'realtime';
  const useCustom = cfg.startsWith('custom') && p.integration !== 'realtime';
  const fixedByCustom = useCustom && p.trainingData !== 'other-domain';
  const noiseP = p.noise === 'factory' ? (useCustom && p.trainingData === 'domain-audio' ? 0.03 : 0.12) : 0;
  return set.utts.map((u, i) => {
    let hyp = u.ref;
    const termOk = [];
    for (const t of u.terms) {
      const ok = fixedByCustom || (usePhrase && (phrases.includes(t.alias.toLowerCase()) || phrases.includes(t.ref)));
      if (!ok) hyp = hyp.replace(t.ref, t.base);
      termOk.push(ok);
    }
    if (noiseP) {
      const r = rng(`${p.testSet}|${i}|${noiseP}`);
      // In this simulation noise hits ordinary words; domain-term errors are modelled above.
      const protectedWords = new Set(u.terms.flatMap(t => (t.ref + ' ' + t.base).split(' ')));
      hyp = hyp.split(' ').map(w => { const x = r(); if (protectedWords.has(w)) return w; return x < noiseP / 2 ? '' : x < noiseP ? (w === 'the' ? 'a' : w + 's') : w; }).filter(Boolean).join(' ');
    }
    return { ref: u.ref, hyp, ...wer(u.ref, hyp), terms: u.terms.length, termsOk: u.terms.filter(t => (' ' + hyp + ' ').includes(' ' + t.ref + ' ')).length };
  });
}
const total = rows => { const e = rows.reduce((a, r) => a + r.errors, 0), n = rows.reduce((a, r) => a + r.n, 0); return n ? e / n : 0; };

function run(p) {
  const set = SETS[p.testSet] || SETS.clinical;
  const steps = [];
  const custom = p.model.startsWith('custom');
  steps.push(step('audio', 'Test set loaded', `${set.label}: ${set.utts.length} utterances with human reference transcripts, ${p.noise === 'factory' ? 'recorded in a noisy environment' : 'quiet recording'}.`, { utterances: set.utts.length, noise: p.noise }));

  // Model / endpoint
  if (custom && p.integration !== 'realtime') {
    if (p.endpoint !== 'deployed') {
      const region = p.endpoint === 'other-region';
      steps.push(step('model', region ? 'Custom endpoint not found in this region' : 'Custom model has no endpoint', region ? 'The endpoint ID belongs to a Speech resource in another region. The recogniser connects to this resource\'s region and cannot find it.' : 'Training succeeded, but the model was never deployed to a custom endpoint, so there is no endpoint ID to set on SpeechConfig.', { endpoint_id: region ? '<id from other region>' : null, status: region ? 'NotFound / auth error (illustrative)' : 'NotDeployed' }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: region ? 'Deploy the custom model in the same region as the Speech resource you call.' : 'Deploy the model to a custom endpoint and set speech_config.endpoint_id.' }], metrics: [], summary: `Custom model: ${p.endpoint}`, meta: {} };
    }
    steps.push(step('model', 'Custom Speech endpoint', `Trained on: ${TRAINING[p.trainingData]}. Deployed; SpeechConfig.endpoint_id points to it.`, { trainingData: p.trainingData, endpoint_id: '<custom-endpoint-id>' }, p.trainingData === 'other-domain' ? 'warn' : 'ok'));
  } else if (custom) {
    steps.push(step('model', 'Custom Speech model not used on this path', 'gpt-realtime models take audio directly. A Custom Speech endpoint does not apply; vocabulary can only be hinted in instructions or a transcription prompt (illustrative).', null, 'warn'));
  } else steps.push(step('model', 'Base model', 'Microsoft\'s general-purpose model for the locale.', null, 'ok'));
  if (p.integration === 'realtime' && p.model.includes('phrase')) steps.push(step('model', 'Phrase list not applied', 'PhraseListGrammar belongs to the Speech SDK recogniser; it does not bias a native-audio model in this simulation.', null, 'warn'));
  if (p.integration === 'voicelive') steps.push(step('model', 'Voice Live session', 'Speech-to-speech agent session; in this simulation it can reference the same custom speech model and phrase list (check the current Voice Live docs for supported configuration).', { session: { input_audio_transcription: custom ? '<custom speech model>' : 'default', phrase_list: p.model.includes('phrase') } }, 'info'));

  // Transcribe + WER
  const rows = transcribe(set, p.model, p);
  const w = total(rows);
  const termsTotal = rows.reduce((a, r) => a + r.terms, 0), termsOk = rows.reduce((a, r) => a + r.termsOk, 0);
  steps.push(step('stt', `Transcribed ${rows.length} utterances`, rows.map(r => `"${r.hyp}"`).join(' | '), { results: rows.map(r => ({ reference: r.ref, hypothesis: r.hyp, errors: r.errors, words: r.n })) }));
  const baseRows = transcribe(set, 'base', p), wBase = total(baseRows);
  steps.push(step('wer', `WER ${round(w * 100, 1)}% (target ≤ ${round(p.targetWer * 100, 0)}%)`, `Word error rate = (substitutions + deletions + insertions) / reference words = ${rows.reduce((a, r) => a + r.errors, 0)}/${rows.reduce((a, r) => a + r.n, 0)}. Base model: ${round(wBase * 100, 1)}%.${custom && p.trainingData === 'other-domain' ? ' Training data from another domain gave no gain on these terms.' : ''}`,
    { wer: round(w, 3), baseWer: round(wBase, 3), domainTermsCorrect: `${termsOk}/${termsTotal}` }, w > p.targetWer ? 'warn' : 'ok'));

  // Agent integration
  const failedTools = rows.filter(r => r.termsOk < r.terms).length;
  const toolCalls = rows.filter(r => r.terms > 0).length;
  steps.push(step('agent', `${set.agentTool}: ${toolCalls - failedTools}/${toolCalls} calls resolved`, failedTools ? `${failedTools} utterance(s) reached the agent with a misrecognised domain term, so the tool could not match it.` : 'Every domain term reached the agent correctly.', { tool: set.agentTool, failed: failedTools }, failedTools ? 'warn' : 'ok'));

  // Compare all model variants (same training data / noise / path)
  const variants = Object.keys(MODELS).map(k => ({ k, w: total(transcribe(set, k, p)) }));
  const worst = [...rows].sort((a, b) => b.errors / b.n - a.errors / a.n)[0];
  const output = [
    { type: 'table', title: 'Reference vs hypothesis', columns: ['Reference', 'Hypothesis', 'WER'], rows: rows.map(r => [r.ref, r.hyp, `${round((r.errors / r.n) * 100, 0)}%`]), tones: rows.map(r => (r.errors === 0 ? 'ok' : r.termsOk < r.terms ? 'error' : 'warn')) },
    { type: 'bars', title: 'WER by model variant (same audio, training data and path)', threshold: p.targetWer, items: variants.map(v => ({ label: MODELS[v.k], value: round(v.w, 3), max: Math.max(0.5, ...variants.map(x => x.w)), tone: v.w <= p.targetWer ? 'ok' : 'warn', note: `${round(v.w * 100, 1)}%` })) },
    { type: 'diff', title: 'Worst utterance', before: worst.ref, after: worst.hyp },
    { type: 'alert', tone: w <= p.targetWer && !failedTools ? 'ok' : 'warn', text: w <= p.targetWer && !failedTools ? 'Accuracy target met and every domain term reaches the agent.' : 'Below target: compare variants above to decide between a phrase list and Custom Speech (and which training data).' },
  ];
  return {
    steps, output,
    metrics: [
      metric('WER', `${round(w * 100, 1)}%`, 'computed', 'Levenshtein word distance on toy transcripts.'),
      metric('Relative WER reduction vs base', wBase ? `${Math.round((1 - w / wBase) * 100)}%` : '—', 'computed'),
      metric('Domain terms correct', `${termsOk}/${termsTotal}`, 'computed'),
      metric('Setup effort', custom ? 'training + endpoint hosting' : p.model.includes('phrase') ? 'none (runtime list)' : 'none', 'estimate', 'Custom endpoints are billed for hosting as well as usage; see the Speech pricing page.'),
    ],
    summary: `${set.label} • ${MODELS[p.model]}${custom ? ` (${p.trainingData})` : ''} • ${p.noise} • WER ${round(w * 100, 1)}%`,
    meta: { wer: w, failedTools },
  };
}

export default {
  id: '4.2.2',
  lab: 'Custom speech WER bench',
  services: [
    { name: 'Custom Speech overview', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-speech-overview' },
    { name: 'Test accuracy of a custom speech model (WER)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-custom-speech-evaluate-data' },
    { name: 'Voice Live API overview', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live' },
  ],
  prereqs: ['4.2.1'],
  next: ['4.2.3', '4.2.4'],

  concept: {
    plain: 'If an agent listens, every misheard word becomes a wrong action: "metro pole all" is not a medicine. You measure recognition with a word error rate against human transcripts, then improve it: a phrase list for a few names, or a custom speech model trained on your own text or audio when there is a lot of jargon or noise. The improved recogniser then feeds the agent, either through the Speech SDK or a speech-to-speech session.',
    technical: 'Custom Speech in Azure AI Speech adapts the base model with plain text, structured text or pronunciation data (vocabulary) and with audio plus human-labelled transcripts (acoustic conditions). You evaluate base vs custom models on a test set by WER = (S + D + I) / N, deploy the chosen model to a custom endpoint, and set SpeechConfig.endpoint_id in the same region. Phrase lists bias the recogniser at runtime without training. As an agent modality, speech can run as STT → agent → TTS with the Speech SDK, as a Voice Live session, or with native audio models such as gpt-realtime, which do not use Custom Speech endpoints.',
    useCase: 'A hospital adds voice dictation to its clinical documentation agent. Base recognition mangles drug names, so the team trains a Custom Speech model on de-identified notes and formulary text, compares WER per release on a held-out test set, deploys it to an endpoint, and keeps a phrase list for new drug names between retraining cycles.',
    terms: [
      ['WER', 'Word error rate: substitutions + deletions + insertions divided by reference word count.'],
      ['Custom endpoint', 'Deployment of a Custom Speech model; requests reference its endpoint ID.'],
      ['Phrase list', 'Runtime biasing list; no training, good for a handful of names.'],
      ['Acoustic adaptation', 'Training with audio + transcripts so the model handles your microphones, accents and noise.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'audio', label: 'Domain audio', col: 0, row: 1, kind: 'data', badge: p ? p.noise : undefined, detail: 'Test set with human reference transcripts.' },
          { id: 'model', label: p && p.model.startsWith('custom') ? 'Custom Speech model' : 'Base model', col: 1, row: 1, kind: 'ai', badge: p && p.model.includes('phrase') ? '+ phrase list' : undefined, detail: 'Base, phrase-list biased, or custom-trained.', substeps: ['Upload data', 'Train', 'Test (WER)', 'Deploy endpoint'] },
          { id: 'stt', label: 'Transcripts', col: 2, row: 1, kind: 'data', detail: 'Hypotheses to compare with references.' },
          { id: 'wer', label: 'WER evaluation', col: 3, row: 0, kind: 'policy', detail: 'Compare models on the same test set.' },
          { id: 'agent', label: 'Agent + tools', col: 3, row: 2, kind: 'ai', badge: p ? PATHS[p.integration].split(' (')[0] : undefined, detail: 'Domain terms must survive to the tool call.' },
        ],
        edges: [['audio', 'model'], ['model', 'stt'], ['stt', 'wer'], ['stt', 'agent']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'audio', label: 'Speech Studio project (datasets)', col: 0, row: 1, kind: 'store', detail: 'Training and test datasets, stored with the Speech resource.' },
          { id: 'model', label: 'Custom endpoint', col: 1, row: 0, kind: 'ai', disabled: p && !p.model.startsWith('custom'), badge: p && p.model.startsWith('custom') ? p.endpoint : undefined, detail: 'Must be deployed in the region of the Speech resource you call.' },
          { id: 'stt', label: 'Azure AI Speech resource', col: 1, row: 2, kind: 'ai', detail: 'Base models and runtime phrase lists.' },
          { id: 'wer', label: 'Evaluation pipeline', col: 2, row: 0, kind: 'compute', detail: 'Batch transcription + WER per release.' },
          { id: 'agent', label: p ? PATHS[p.integration] : 'Agent', col: 3, row: 1, kind: 'app', detail: 'SDK → Foundry agent, Voice Live session, or realtime model.' },
        ],
        edges: [['audio', 'model', 'train'], ['model', 'stt'], ['stt', 'wer'], ['stt', 'agent']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'model', label: `speech_config.endpoint_id = "${p && p.model.startsWith('custom') ? '<custom-endpoint-id>' : ''}"`, col: 0, row: 0, kind: 'code', detail: 'azure-cognitiveservices-speech; same region as the resource. Illustrative.' },
          { id: 'stt', label: `PhraseListGrammar.from_recognizer(rec).addPhrase(...)  # ${p && p.model.includes('phrase') ? p.phraseList : 'not used'}`, col: 0, row: 1, kind: 'code', detail: 'Runtime biasing.' },
          { id: 'audio', label: 'result = rec.recognize_once()  # or batch transcription for test sets', col: 0, row: 2, kind: 'code', detail: 'Test sets are usually run in batch.' },
          { id: 'wer', label: 'wer = edit_distance(ref.split(), hyp.split()) / len(ref.split())', col: 0, row: 3, kind: 'code', detail: 'Normalise case/punctuation first, as Speech Studio does.' },
          { id: 'agent', label: 'agent.run(thread, user_message=result.text)', col: 0, row: 4, kind: 'code', detail: 'Hand final text to the agent.' },
        ],
        edges: [['model', 'stt'], ['stt', 'audio'], ['audio', 'wer'], ['audio', 'agent']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'testSet', label: 'Test set', type: 'select', options: Object.entries(SETS).map(([k, s]) => [k, s.label]), default: 'clinical' },
      { id: 'noise', label: 'Recording conditions', type: 'select', options: [['quiet', 'Quiet'], ['factory', 'Noisy (factory floor)']], default: 'quiet' },
      { id: 'model', label: 'Recognition model', type: 'select', options: Object.entries(MODELS), default: 'base' },
      { id: 'trainingData', label: 'Custom model training data', type: 'select', options: Object.entries(TRAINING), default: 'domain-text' },
      { id: 'endpoint', label: 'Custom endpoint status', type: 'select', options: [['deployed', 'Deployed (same region)'], ['not-deployed', 'Trained, not deployed'], ['other-region', 'Deployed in another region']], default: 'deployed' },
      { id: 'phraseList', label: 'Phrase list (comma-separated)', type: 'text', default: 'metoprolol, apixaban' },
      { id: 'integration', label: 'Agent integration path', type: 'select', options: Object.entries(PATHS), default: 'sdk' },
      { id: 'targetWer', label: 'Target WER', type: 'range', min: 0.02, max: 0.3, step: 0.01, default: 0.1 },
    ],
    samples: [
      { label: 'Clinical, base model', values: { testSet: 'clinical', model: 'base' } },
      { label: 'Clinical, phrase list (two drugs)', values: { testSet: 'clinical', model: 'base+phrase' } },
      { label: 'Factory, custom (text only)', values: { testSet: 'manufacturing', noise: 'factory', model: 'custom', trainingData: 'domain-text' } },
      { label: 'Contact center, phrase list', values: { testSet: 'contact', model: 'base+phrase', phraseList: 'Fabrikam, UltraFlex, Contoso Go' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'On the clinical set run base, base + phrase list and custom: compare WER and the domain terms that reach the agent.',
      'On the factory set with noise, compare custom models trained on domain text vs domain audio + transcripts.',
      'Run custom + phrase list through the Speech SDK path and the gpt-realtime path and compare.',
    ],
  },

  debug: [
    { id: 'notdeployed', title: 'Custom model "does nothing" in production', values: { model: 'custom', endpoint: 'not-deployed' }, node: 'model',
      symptom: 'No endpoint ID to configure; requests fail or silently use the base model.', cause: 'The model was trained and tested but never deployed to a custom endpoint.', fix: 'Deploy to an endpoint (status "Deployed") and set endpoint_id.' },
    { id: 'region', title: 'Endpoint ID rejected', values: { model: 'custom', endpoint: 'other-region' }, node: 'model',
      symptom: 'Connection fails with a not-found/auth error.', cause: 'The custom endpoint lives in a different region than the Speech resource used by the app.', fix: 'Deploy in the same region (status "Deployed (same region)").' },
    { id: 'mismatch', title: 'Custom model barely better than base', values: { testSet: 'clinical', model: 'custom', trainingData: 'other-domain' }, node: 'wer',
      symptom: 'WER unchanged; drug names still wrong.', cause: 'Training data mismatch: retail text has none of the clinical vocabulary.', fix: 'Train on text from the target domain (or audio + transcripts).' },
    { id: 'noise', title: 'Factory reports still garbled after text training', values: { testSet: 'manufacturing', noise: 'factory', model: 'custom', trainingData: 'domain-text' }, node: 'wer',
      symptom: 'Terms are right but random words are dropped; WER above target.', cause: 'Plain text fixes vocabulary, not acoustics.', fix: 'Train with domain audio + human-labelled transcripts.' },
    { id: 'realtime', title: 'Custom model ignored by the realtime agent', values: { integration: 'realtime', model: 'custom+phrase' }, node: 'model',
      symptom: 'WER equals the base model.', cause: 'Unsuitable path: the native-audio model does not use Custom Speech endpoints or phrase lists.', fix: 'Use the Speech SDK path (or Voice Live) when you depend on Custom Speech.' },
  ],

  challenge: {
    task: 'Bring the noisy factory-floor test set to WER ≤ 10% with every domain term reaching the work-order tool.',
    condition: 'Test set = factory, noise = noisy, target WER ≤ 0.10, WER ≤ target, all tool calls resolved, no errors.',
    hint: 'Noise and vocabulary are different problems. Which training data addresses both?',
    check: (p, res) => p.testSet === 'manufacturing' && p.noise === 'factory' && p.targetWer <= 0.1 && !!res.meta && res.meta.wer <= p.targetWer && res.meta.failedTools === 0 && !res.steps.some(s => s.status === 'error'),
    solution: ['Test set: factory floor, noisy.', 'Model: Custom Speech (optionally + phrase list).', 'Training data: domain audio + human-labelled transcripts.', 'Endpoint deployed in the same region; Speech SDK path.'],
    solutionValues: { testSet: 'manufacturing', noise: 'factory', model: 'custom+phrase', trainingData: 'domain-audio', endpoint: 'deployed', integration: 'sdk', targetWer: 0.1, phraseList: 'HX-240' },
  },

  quiz: [
    { q: 'Call-center transcripts misrecognise three new product names launched this week. Retraining is scheduled next quarter. What do you do now?', options: ['Add the names to a phrase list', 'Switch to a neural voice', 'Lower the target WER', 'Use recognize_once'], answer: 0, why: 'Phrase lists bias recognition immediately without training; ideal for a handful of new names.' },
    { q: 'A Custom Speech model trained on domain text fixes jargon but WER stays high on noisy shop-floor recordings. Next step?', options: ['Add more plain text', 'Train with audio + human-labelled transcripts from the shop floor', 'Use a phrase list only', 'Increase silence timeout'], answer: 1, why: 'Audio + transcripts adapt to acoustic conditions; text only adapts vocabulary.' },
    { q: 'You must choose between two custom model versions for release. How do you decide objectively?', options: ['Listen to a few calls', 'Run both on the same held-out test set with reference transcripts and compare WER', 'Pick the newest', 'Compare training time'], answer: 1, why: 'WER on a representative held-out test set is the standard comparison.' },
  ],

  recap: 'Measure speech accuracy with WER on a held-out test set. Use phrase lists for a few names, Custom Speech for heavy jargon (text) and acoustic conditions (audio + transcripts), deploy to an endpoint in the same region, and check that domain terms actually reach the agent\'s tools on the integration path you choose.',
};
