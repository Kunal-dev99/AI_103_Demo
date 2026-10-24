// 4.2.4 Translate speech into other languages by using language models and Foundry Tools
// Lab: Speech translation pipeline comparer.
import { step, metric, estTokens } from '../src/engine/util.js';

// Recorded sample translations. {0} = glossary term slot (gen = general rendering, tgt = approved term).
const CLIPS = {
  keynote: {
    label: 'Product keynote (English)', locale: 'en-US',
    source: 'Today we are launching the Contoso Fleet dashboard for every tenant.',
    brand: { term: 'Contoso Fleet', misheard: 'can toss so fleet' },
    term: { src: 'tenant', de: { gen: 'Mieter', tgt: 'Mandanten' }, fr: { gen: 'locataire', tgt: 'locataire' }, es: { gen: 'inquilino', tgt: 'inquilino' }, ja: { gen: '借主', tgt: 'テナント' } },
    tr: {
      de: 'Heute führen wir das {B}-Dashboard für jeden {0} ein.',
      fr: 'Aujourd\'hui, nous lançons le tableau de bord {B} pour chaque {0}.',
      es: 'Hoy lanzamos el panel de {B} para cada {0}.',
      ja: '本日、すべての{0}向けに {B} ダッシュボードを公開します。',
    },
  },
  support: {
    label: 'Support call (Spanish, Mexico)', locale: 'es-MX',
    source: 'Mi factura de Contoso Fleet tiene un cargo duplicado.',
    brand: { term: 'Contoso Fleet', misheard: 'con todo flit' },
    term: { src: 'factura', en: { gen: 'bill', tgt: 'invoice' }, fr: { gen: 'facture', tgt: 'facture' }, de: { gen: 'Rechnung', tgt: 'Rechnung' }, ja: { gen: '勘定書', tgt: '請求書' } },
    tr: {
      en: 'My {B} {0} has a duplicate charge.',
      fr: 'Ma {0} {B} comporte un débit en double.',
      de: 'Meine {B}-{0} enthält eine doppelte Belastung.',
      ja: '{B} の{0}に二重請求があります。',
    },
  },
  briefing: {
    label: 'Shift briefing (German)', locale: 'de-DE',
    source: 'Die Wartung der Linie drei beginnt am Montag um sechs Uhr.',
    term: { src: 'Wartung', en: { gen: 'servicing', tgt: 'maintenance' }, fr: { gen: 'entretien', tgt: 'maintenance' }, es: { gen: 'servicio', tgt: 'mantenimiento' }, ja: { gen: 'サービス', tgt: 'メンテナンス' } },
    tr: {
      en: 'The {0} of line three begins on Monday at 6 a.m.',
      fr: 'La {0} de la ligne trois commence lundi à six heures.',
      es: 'El {0} de la línea tres comienza el lunes a las seis.',
      ja: '3号ラインの{0}は月曜日の6時に始まります。',
    },
  },
};
// Real translation language codes (subset) vs. what this lab has recordings for.
const KNOWN = ['en', 'fr', 'de', 'es', 'ja', 'it', 'pt', 'zh-Hans', 'zh-Hant', 'ko', 'ar', 'hi', 'nl', 'sv', 'pl', 'tr', 'uk'];
const VOICES = { en: 'en-US-AvaMultilingualNeural', fr: 'fr-FR-DeniseNeural', de: 'de-DE-KatjaNeural', es: 'es-ES-ElviraNeural', ja: 'ja-JP-NanamiNeural' };
const PIPES = {
  speech: 'Azure AI Speech translation (one pass)',
  'cascade-mt': 'Cascade: STT → Translator → TTS',
  'cascade-llm': 'Cascade: STT → LLM → TTS',
};

function run(p) {
  const clip = CLIPS[p.clip] || CLIPS.keynote;
  const steps = [];
  const timeline = [];
  const srcLang = clip.locale.slice(0, 2);
  const speechEnd = clip.source.split(' ').length * 330;
  timeline.push({ label: 'Speaker talking', start: 0, end: speechEnd, lane: 'Source audio', tone: 'info' });
  steps.push(step('mic', 'Source audio', `${clip.label}: "${clip.source}"`, { locale: clip.locale, durationMsEstimate: speechEnd }));

  if (p.region === 'mismatch') {
    steps.push(step('stt', '401: key and region do not match', 'SpeechTranslationConfig / SpeechConfig was created with a key from one region and a different region name. The service rejects the connection.', { httpStatus: 401 }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Use the region of the Speech resource that issued the key (or Entra ID with the resource endpoint).' }], metrics: [], summary: 'Auth: region mismatch', meta: {} };
  }

  // Targets
  const targets = String(p.targets || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!targets.length) {
    steps.push(step('route', 'No target language', 'At least one target language is required (add_target_language).', null, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Add one or more target language codes, e.g. "fr,de".' }], metrics: [], summary: 'No targets', meta: {} };
  }
  const invalid = targets.filter(t => !KNOWN.includes(t));
  if (invalid.length) {
    if (p.pipeline === 'cascade-llm') steps.push(step('route', `Unvalidated target code(s): ${invalid.join(', ')}`, 'The LLM accepts any string as a "language". Nothing rejects the bad code; validate codes in your app.', { invalid }, 'warn'));
    else {
      steps.push(step('route', `Unsupported target language: ${invalid.join(', ')}`, `${p.pipeline === 'speech' ? 'Speech translation' : 'Translator'} only accepts supported language codes (e.g. "fr", "de", "zh-Hans"). In this simulation the session fails to start.`, { invalid, hint: 'Check the language support page; use text language codes for targets.' }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: `Remove or correct: ${invalid.join(', ')}.` }], metrics: [], summary: 'Unsupported target', meta: {} };
    }
  }
  const usable = targets.filter(t => KNOWN.includes(t) && t !== srcLang);
  steps.push(step('route', `Targets: ${usable.join(', ') || '—'}`, `${PIPES[p.pipeline]}.${targets.includes(srcLang) ? ` "${srcLang}" is the source language and is skipped.` : ''}`, { targets: usable }));

  // Recognition
  const auto = p.sourceLocale === 'auto';
  const used = auto ? clip.locale : p.sourceLocale;
  const wrong = used !== clip.locale;
  const phrases = String(p.phraseList || '').split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const brandOk = !clip.brand || phrases.includes(clip.brand.term.toLowerCase());
  const recognised = wrong ? '(low-confidence text in the wrong language)' : brandOk || !clip.brand ? clip.source : clip.source.replace(clip.brand.term, clip.brand.misheard);
  steps.push(step('stt', wrong ? `Recognised as ${used}: wrong source locale` : `Recognised (${used}${auto ? ', auto-detected from candidates' : ''})`, wrong ? `The speaker uses ${clip.locale}. Recognising with ${used} produces nonsense, and every translation inherits it.` : `"${recognised}"${clip.brand && !brandOk ? ` — brand misheard as "${clip.brand.misheard}"; add it to the phrase list.` : ''}`,
    { speech_recognition_language: auto ? null : used, autoDetectCandidates: auto ? ['en-US', 'es-MX', 'de-DE'] : null, text: recognised }, wrong ? 'error' : clip.brand && !brandOk ? 'warn' : 'ok'));
  if (wrong) return { steps, output: [{ type: 'alert', tone: 'error', text: 'Garbage in, garbage out: set the correct source locale or use auto-detection with candidate languages.' }, { type: 'timeline', title: 'Timeline (estimates)', unit: 'ms', items: timeline }], metrics: [], summary: `Wrong source locale (${used})`, meta: {} };

  // Translation
  const rows = [];
  let termOk = 0, termTotal = 0;
  for (const t of usable) {
    if (!clip.tr[t]) { rows.push({ t, text: '(no recorded sample for this language in the lab)', term: null }); continue; }
    const g = clip.term[t];
    const enforce = p.glossary;
    const llmContext = p.pipeline === 'cascade-llm';
    const val = enforce ? g.tgt : llmContext && t !== 'ja' ? g.tgt : g.gen;
    const brand = clip.brand ? (brandOk ? clip.brand.term : clip.brand.misheard) : '';
    const text = clip.tr[t].replace('{0}', val).replace('{B}', brand);
    termTotal++; if (val === g.tgt) termOk++;
    rows.push({ t, text, term: { src: clip.term.src, expected: g.tgt, got: val, ok: val === g.tgt }, brandOk });
  }
  const how = p.pipeline === 'speech' ? 'TranslationRecognizer returns translations for every target in one recognition result (partial results stream while the person speaks).' : p.pipeline === 'cascade-mt' ? 'Final STT text is sent to Translator with all targets in one request.' : 'Final STT text is sent to an LLM once per target (or one JSON response with all targets).';
  const glossaryHow = p.pipeline === 'speech' ? 'custom translation model category on the translation config (illustrative)' : p.pipeline === 'cascade-mt' ? 'Translator dynamic dictionary / Custom Translator category' : 'glossary in the system prompt';
  steps.push(step(p.pipeline === 'cascade-llm' ? 'llm' : 'translate', `Translated into ${rows.length} language(s)`, `${how} Glossary: ${p.glossary ? glossaryHow : 'none'}.`, { translations: Object.fromEntries(rows.map(r => [r.t, r.text])) }));
  steps.push(step('check', termTotal ? `Terminology ${termOk}/${termTotal}` : 'No terminology to check', rows.filter(r => r.term).map(r => `${r.t}: ${r.term.src} → ${r.term.got}${r.term.ok ? ' ✓' : ` ✗ (expected ${r.term.expected})`}`).join('; ') || '—', null, termOk < termTotal ? 'warn' : 'ok'));

  // Latency estimates
  let tFinal;
  if (p.pipeline === 'speech') {
    timeline.push({ label: 'Partial translations', start: 600, end: speechEnd, lane: 'Translation', tone: 'muted' });
    tFinal = speechEnd + p.silenceMs + 200;
    timeline.push({ label: 'Final translations (all targets)', start: speechEnd, end: tFinal, lane: 'Translation', tone: 'ok' });
  } else {
    const sttF = speechEnd + p.silenceMs + 100;
    timeline.push({ label: 'STT final', start: speechEnd, end: sttF, lane: 'STT', tone: 'ok' });
    const tr = p.pipeline === 'cascade-mt' ? 150 : 500 + (usable.length > 1 ? 150 : 0);
    tFinal = sttF + tr;
    timeline.push({ label: p.pipeline === 'cascade-mt' ? 'Translator (all targets)' : 'LLM translation', start: sttF, end: tFinal, lane: 'Translation', tone: 'ok' });
  }

  // Voice output
  let spoken = [];
  if (p.voiceOutput) {
    if (p.pipeline === 'speech') {
      spoken = rows.filter(r => clip.tr[r.t]).slice(0, 1).map(r => r.t);
      const unspoken = rows.filter(r => clip.tr[r.t]).slice(1).map(r => r.t);
      steps.push(step('tts', unspoken.length ? `Only "${spoken[0]}" is spoken` : `Spoken: ${spoken.join(', ')}`, `The translation config takes one voice name, so built-in synthesis covers one target in this simulation.${unspoken.length ? ` ${unspoken.join(', ')} remain text only; add a TTS step per language or use the cascade.` : ''}`, { voice_name: spoken[0] ? VOICES[spoken[0]] : null }, unspoken.length ? 'warn' : 'ok'));
    } else {
      spoken = rows.filter(r => clip.tr[r.t]).map(r => r.t);
      steps.push(step('tts', `Spoken: ${spoken.join(', ')}`, `One SpeechSynthesizer per target language, running in parallel: ${spoken.map(t => VOICES[t]).join(', ')}.`, { voices: spoken.map(t => VOICES[t]) }));
    }
    spoken.forEach(t => timeline.push({ label: `TTS ${t} first audio`, start: tFinal, end: tFinal + 200, lane: 'Voice', tone: 'info' }));
  } else steps.push(step('tts', 'Text output only', 'Translations shown as captions.', null, 'skip'));
  const firstOut = tFinal + (spoken.length ? 200 : 0) - speechEnd;

  const output = [
    { type: 'table', title: 'Translations (recorded samples)', columns: ['Target', 'Output', 'Term check', 'Voice'], rows: rows.map(r => [r.t, r.text, r.term ? (r.term.ok ? `✓ ${r.term.got}` : `✗ ${r.term.got} (expected ${r.term.expected})`) : '—', spoken.includes(r.t) ? VOICES[r.t] : 'text only']), tones: rows.map(r => (!r.term ? 'info' : r.term.ok && r.brandOk !== false ? 'ok' : 'warn')) },
    { type: 'timeline', title: 'Timeline (illustrative estimates, not measurements)', unit: 'ms', items: timeline },
    { type: 'flow', title: 'Pipeline', items: p.pipeline === 'speech' ? [{ label: 'Audio' }, { label: 'Speech translation (STT + MT)', note: `${usable.length} target(s)` }, ...(p.voiceOutput ? [{ label: 'Built-in synthesis', note: '1 voice' }] : [])]
      : [{ label: 'Audio' }, { label: 'STT' }, { label: p.pipeline === 'cascade-mt' ? 'Translator' : 'LLM', note: p.glossary ? 'glossary' : '' }, ...(p.voiceOutput ? [{ label: 'TTS per language', note: `${spoken.length} voice(s)` }] : [])] },
  ];
  return {
    steps, output,
    metrics: [
      metric('Terminology correct', `${termOk}/${termTotal}`, 'computed'),
      metric('Targets spoken', `${spoken.length}/${rows.length}`, 'computed'),
      metric('End of speech → first output', `~${firstOut} ms`, 'estimate', `Silence timeout ${p.silenceMs} ms + illustrative stage estimates (MT ~150 ms, LLM ~500 ms, TTS first byte ~200 ms). Measure in your region.`),
      metric('LLM tokens per utterance', p.pipeline === 'cascade-llm' ? `~${(estTokens(clip.source) * 2 + 80) * usable.length}` : 'n/a', 'estimate', '4-chars-per-token heuristic, ~80 instruction tokens per target.'),
    ],
    summary: `${clip.label.split(' (')[0]} • ${PIPES[p.pipeline]} • ${usable.join('+')} • terms ${termOk}/${termTotal} • ~${firstOut} ms`,
    meta: { termOk, termTotal, spoken: spoken.length, brandOk },
  };
}

export default {
  id: '4.2.4',
  lab: 'Speech translation pipeline comparer',
  services: [
    { name: 'Azure AI Speech: speech translation', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation' },
    { name: 'Speech translation how-to (multiple targets, synthesis)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech' },
    { name: 'Language support for speech translation', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support' },
  ],
  prereqs: ['4.1.3', '4.2.1'],
  next: ['4.2.3'],

  concept: {
    plain: 'To translate speech you can use one service that listens and translates at the same time, or chain three steps yourself: turn speech into text, translate the text (with a translation service or a language model), then speak the result. The one-pass service is simpler and starts showing translations while the person is still talking; the chain gives you more control over wording and voices but adds waiting time between steps.',
    technical: 'Azure AI Speech translation uses a SpeechTranslationConfig (speech_recognition_language or auto-detection with candidate locales, add_target_language for several text targets) and a TranslationRecognizer that returns recognised text plus translations per target, with streaming partial results; built-in synthesis uses a configured voice name. A cascaded pipeline runs SpeechRecognizer → Azure Translator (multiple "to" codes, dynamic dictionary or Custom Translator category) or an LLM prompt with glossary and tone → SpeechSynthesizer per language. Phrase lists improve recognition of names before translation; target codes must be supported; the key must match the configured region.',
    useCase: 'A manufacturer streams German shift briefings to plants in France, Spain and Japan. Captions in three languages come from speech translation in one pass; the plant in Japan also needs audio, so a TTS step with a Japanese neural voice speaks the translation, and a glossary makes sure "Wartung" is always "maintenance".',
    terms: [
      ['Speech translation', 'One service call that recognises speech and returns translations for one or more target languages.'],
      ['Cascade', 'Separate STT, translation and TTS steps you orchestrate yourself.'],
      ['Partial results', 'Interim recognition/translation events emitted while the speaker is still talking.'],
      ['Target language code', 'Text language code such as "fr", "de" or "zh-Hans"; must be supported by the service.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'mic', label: 'Spoken source', col: 0, row: 1, kind: 'user', detail: 'Speaker in the source language.' },
          { id: 'stt', label: 'Recognition', col: 1, row: 1, kind: 'ai', badge: p ? p.sourceLocale : undefined, detail: 'Source locale or auto-detect; phrase list for names.' },
          { id: 'route', label: 'Targets', col: 1, row: 2.5, kind: 'policy', badge: p ? p.targets : undefined, detail: 'Supported target codes.' },
          { id: 'translate', label: p && p.pipeline === 'speech' ? 'Built-in translation' : 'Translator', col: 2, row: 0.5, kind: 'ai', disabled: p && p.pipeline === 'cascade-llm', detail: 'Machine translation of recognised text.' },
          { id: 'llm', label: 'LLM translation', col: 2, row: 2, kind: 'ai', disabled: p && p.pipeline !== 'cascade-llm', detail: 'Prompted translation with glossary and tone.' },
          { id: 'check', label: 'Terminology check', col: 3, row: 1, kind: 'policy', detail: 'Approved terms per language.' },
          { id: 'tts', label: 'Speech output', col: 4, row: 1, kind: 'ai', disabled: p && !p.voiceOutput, detail: 'Neural voice per target language.' },
        ],
        edges: [['mic', 'stt'], ['route', 'translate'], ['route', 'llm'], ['stt', 'translate'], ['stt', 'llm'], ['translate', 'check'], ['llm', 'check'], ['check', 'tts']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'mic', label: 'Client app / Teams-style captions', col: 0, row: 1, kind: 'app', detail: 'Streams microphone audio.' },
          { id: 'stt', label: p && p.pipeline === 'speech' ? 'Azure AI Speech (translation)' : 'Azure AI Speech (STT)', col: 1, row: 1, kind: 'ai', badge: p && p.region === 'mismatch' ? 'region ≠ key' : undefined, detail: 'Key + matching region, or Entra ID.' },
          { id: 'translate', label: 'Azure Translator', col: 2, row: 0, kind: 'ai', disabled: p && p.pipeline !== 'cascade-mt', detail: 'Text translation, glossary.' },
          { id: 'llm', label: 'Foundry model deployment', col: 2, row: 2, kind: 'ai', disabled: p && p.pipeline !== 'cascade-llm', detail: 'LLM translation.' },
          { id: 'tts', label: 'Azure AI Speech (TTS)', col: 3, row: 1, kind: 'ai', disabled: p && !p.voiceOutput, detail: 'Neural voices per language.' },
          { id: 'check', label: 'Caption / audio fan-out', col: 4, row: 1, kind: 'app', detail: 'Per-language channels.' },
        ],
        edges: [['mic', 'stt'], ['stt', 'translate'], ['stt', 'llm'], ['translate', 'tts'], ['llm', 'tts'], ['stt', 'check', 'captions'], ['tts', 'check']],
      }),
      implementation: p => ({
        nodes: p && p.pipeline !== 'speech' ? [
          { id: 'stt', label: 'rec = SpeechRecognizer(speech_config, audio_config, auto_detect_source_language_config=...)', col: 0, row: 0, kind: 'code', detail: 'azure-cognitiveservices-speech. Illustrative.' },
          { id: p.pipeline === 'cascade-mt' ? 'translate' : 'llm', label: p.pipeline === 'cascade-mt' ? `translator.translate(body=[text], to_language=[${(p.targets || '').split(',').map(s => `"${s.trim()}"`).join(', ')}])` : 'chat.completions.create(messages=[system(glossary, target), user(text)])', col: 0, row: 1, kind: 'code', detail: 'Translation step.' },
          { id: 'check', label: 'check_terms(translations, glossary)', col: 0, row: 2, kind: 'code', detail: 'Your QA step.' },
          { id: 'tts', label: 'for lang in targets: SpeechSynthesizer(voice=VOICES[lang]).speak_text_async(t)', col: 0, row: 3, kind: 'code', detail: 'One voice per language.' },
        ] : [
          { id: 'stt', label: `cfg = SpeechTranslationConfig(subscription=key, region=region)${p && p.sourceLocale !== 'auto' ? `; cfg.speech_recognition_language = "${p.sourceLocale}"` : ''}`, col: 0, row: 0, kind: 'code', detail: 'azure-cognitiveservices-speech. Illustrative.' },
          { id: 'route', label: `for t in [${p ? (p.targets || '').split(',').map(s => `"${s.trim()}"`).join(', ') : '"fr"'}]: cfg.add_target_language(t)`, col: 0, row: 1, kind: 'code', detail: 'Several text targets in one session.' },
          { id: 'translate', label: 'rec = TranslationRecognizer(cfg, audio_config); rec.recognizing.connect(show_partial)', col: 0, row: 2, kind: 'code', detail: 'Partial and final events carry translations[lang].' },
          { id: 'tts', label: 'cfg.voice_name = "fr-FR-DeniseNeural"; rec.synthesizing.connect(play)', col: 0, row: 3, kind: 'code', detail: 'Built-in synthesis with one voice.' },
        ],
        edges: p && p.pipeline !== 'speech' ? [['stt', p.pipeline === 'cascade-mt' ? 'translate' : 'llm'], [p.pipeline === 'cascade-mt' ? 'translate' : 'llm', 'check'], ['check', 'tts']] : [['stt', 'route'], ['route', 'translate'], ['translate', 'tts']],
      }),
    },
  },

  sim: {
    mode: 'recorded',
    controls: [
      { id: 'clip', label: 'Source clip', type: 'select', options: Object.entries(CLIPS).map(([k, c]) => [k, c.label]), default: 'keynote' },
      { id: 'pipeline', label: 'Pipeline', type: 'select', options: Object.entries(PIPES), default: 'speech' },
      { id: 'sourceLocale', label: 'Source locale', type: 'select', options: [['auto', 'Auto-detect (en-US, es-MX, de-DE)'], ['en-US', 'en-US'], ['es-MX', 'es-MX'], ['de-DE', 'de-DE']], default: 'en-US' },
      { id: 'targets', label: 'Target languages (comma-separated codes)', type: 'text', default: 'fr,de' },
      { id: 'phraseList', label: 'Phrase list', type: 'text', default: '' },
      { id: 'glossary', label: 'Enforce glossary', type: 'toggle', default: false },
      { id: 'voiceOutput', label: 'Spoken output', type: 'toggle', default: false },
      { id: 'silenceMs', label: 'Segmentation silence (ms)', type: 'range', min: 200, max: 1500, step: 100, default: 500 },
      { id: 'region', label: 'Key / region configuration', type: 'select', options: [['match', 'Region matches the key'], ['mismatch', 'Region does not match the key']], default: 'match' },
    ],
    samples: [
      { label: 'Keynote → fr, de captions', values: { clip: 'keynote', targets: 'fr,de' } },
      { label: 'Keynote → ja with glossary, phrase list, voice', values: { clip: 'keynote', targets: 'ja', glossary: true, phraseList: 'Contoso Fleet', voiceOutput: true } },
      { label: 'Spanish support call → en via LLM cascade', values: { clip: 'support', sourceLocale: 'auto', pipeline: 'cascade-llm', targets: 'en', phraseList: 'Contoso Fleet' } },
      { label: 'German briefing → fr, es, ja (Translator cascade, spoken)', values: { clip: 'briefing', sourceLocale: 'de-DE', pipeline: 'cascade-mt', targets: 'fr,es,ja', glossary: true, voiceOutput: true } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Translate the German briefing to fr,es,ja with each pipeline and compare estimated time to first output and terminology.',
      'Run the keynote to de with and without the glossary, then with and without "Contoso Fleet" in the phrase list.',
      'Turn on spoken output with two targets in one-pass speech translation and in the Translator cascade.',
    ],
  },

  debug: [
    { id: 'wronglocale', title: 'Spanish callers produce nonsense translations', values: { clip: 'support', sourceLocale: 'en-US', targets: 'en,fr' }, node: 'stt',
      symptom: 'Every target language contains garbled text.', cause: 'Source locale fixed to en-US for a Spanish speaker.', fix: 'Use auto-detection with candidate locales (or es-MX).' },
    { id: 'badtarget', title: 'Session fails to start for a new market', values: { targets: 'fr,english' }, node: 'route',
      symptom: 'Unsupported target language error.', cause: '"english" is not a language code (use "en").', fix: 'Use supported text language codes, validated against the language support list.' },
    { id: 'onevoice', title: 'Only French is spoken; German listeners hear nothing', values: { pipeline: 'speech', targets: 'fr,de', voiceOutput: true }, node: 'tts',
      symptom: 'German translation arrives as text only.', cause: 'Built-in synthesis uses a single voice name (in this simulation).', fix: 'Use the cascade with one TTS voice per language (or a single target).' },
    { id: 'term', title: 'German plants see "Mieter" instead of "Mandanten"', values: { clip: 'keynote', targets: 'de', glossary: false, phraseList: 'Contoso Fleet' }, node: 'check',
      symptom: 'Terminology check fails.', cause: 'General MT picks the everyday meaning of "tenant".', fix: 'Enforce the glossary (custom model / dynamic dictionary / prompt glossary).' },
    { id: 'brand', title: 'Brand name translated as "can toss so fleet"', values: { clip: 'keynote', glossary: true, phraseList: '' }, node: 'stt',
      symptom: 'Every translation carries the misrecognised brand.', cause: 'Recognition error before translation; the glossary cannot fix words that were never recognised.', fix: 'Add "Contoso Fleet" to the phrase list.' },
    { id: 'region', title: '401 when the app moves to West Europe', values: { region: 'mismatch' }, node: 'stt',
      symptom: 'Authentication fails.', cause: 'Key from one region used with another region name.', fix: 'Configure the region of the resource that issued the key.' },
  ],

  challenge: {
    task: 'Serve the Spanish support call to English and French agents: both languages spoken aloud, brand recognised, approved terms, source language detected automatically.',
    condition: 'Clip = Spanish support call, source = auto-detect, targets include en and fr, both spoken, terminology all correct, no warnings or errors.',
    hint: 'One-pass translation is great for captions; think about how many voices you need.',
    check: (p, res) => p.clip === 'support' && p.sourceLocale === 'auto' && /\ben\b/.test(p.targets) && /\bfr\b/.test(p.targets) && !!res.meta && res.meta.spoken >= 2 && res.meta.termOk === res.meta.termTotal && res.meta.termTotal >= 2 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Clip: Spanish support call; source locale: auto-detect.', 'Targets: en,fr. Phrase list: Contoso Fleet.', 'Enforce glossary ("factura" → "invoice").', 'Pipeline: Translator cascade (or LLM cascade) with spoken output: one voice per language.'],
    solutionValues: { clip: 'support', sourceLocale: 'auto', targets: 'en,fr', phraseList: 'Contoso Fleet', glossary: true, pipeline: 'cascade-mt', voiceOutput: true, region: 'match' },
  },

  quiz: [
    { q: 'A conference needs live captions in French, German and Japanese with the lowest delay and minimal code. Which option fits?', options: ['Speech translation with three target languages in one TranslationRecognizer', 'STT → LLM per language → TTS', 'Batch transcription then Translator', 'Custom neural voice'], answer: 0, why: 'One-pass speech translation returns translations for several targets with streaming partial results.' },
    { q: 'Translations must use a style guide (formal tone, brand phrasing) that MT ignores; a second or two of extra delay is acceptable. Which design?', options: ['Speech translation only', 'Cascade: STT → LLM with glossary and tone instructions → TTS', 'Raise the silence timeout', 'Use profanity filtering'], answer: 1, why: 'An LLM step can apply tone and style rules; the cascade adds latency, which is acceptable here.' },
    { q: 'Callers may speak English, Spanish or German. Translations are nonsense for non-English callers. What do you configure?', options: ['More target languages', 'Automatic source language detection with candidate locales', 'A different neural voice', 'A Custom Translator model'], answer: 1, why: 'The source must be recognised in the right language before anything can be translated.' },
  ],

  recap: 'Speech translation recognises and translates in one pass, to several targets, with streaming partials and a single built-in voice. A cascade (STT → Translator or LLM → TTS) adds latency but gives glossary, tone and per-language voices. In both, fix recognition first (locale or auto-detect, phrase lists), use supported target codes, check terminology and match key and region.',
};
