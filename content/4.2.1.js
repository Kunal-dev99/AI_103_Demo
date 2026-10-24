// 4.2.1 Implement workflows to convert speech to text and text to speech for agentic interactions
// Lab: Voice agent turn simulator.
import { rng, round, step, metric } from '../src/engine/util.js';

// Callers: what they actually say, as timed segments. pauseMs = silence between segments.
const CALLERS = {
  reschedule: {
    label: 'Caller reschedules, then interrupts the agent', lang: 'en-US',
    segments: ['I need to move my appointment to Thursday at 3 pm.'], pauseMs: 0,
    bargeIn: { atMs: 1200, text: 'Actually, make it Friday.' },
  },
  order: {
    label: 'Caller asks about an order (pauses to find the number)', lang: 'en-US',
    segments: ['Where is my order for the ZX-450 earbuds?', 'The order number is 7731.'], pauseMs: 900,
    hard: { term: 'ZX-450', misheard: 'said X 450' },
  },
  spanish: {
    label: 'Spanish-speaking caller cancels an order', lang: 'es-ES',
    segments: ['Quiero cancelar mi pedido 7731 de los auriculares ZX-450.'], pauseMs: 0,
    hard: { term: 'ZX-450', misheard: 'zeta equis 450' },
    asEnglish: 'Key arrow cancel are me pay the oh seven seven three one day lows outdoor colors.',
  },
};
const FORMATS = {
  pcm16k: { label: '16 kHz 16-bit mono PCM (default stream format)', ok: true },
  pcm8k: { label: '8 kHz 16-bit mono PCM (telephony, declared)', ok: true, lowBand: true },
  pcm48stereo: { label: '48 kHz stereo PCM, not declared', ok: false },
  mp3raw: { label: 'MP3 bytes pushed as raw PCM', ok: false },
};
const VOICES = {
  'en-US-AvaMultilingualNeural': { lang: 'en-US', multilingual: true },
  'en-US-AndrewNeural': { lang: 'en-US', multilingual: false },
  'es-ES-ElviraNeural': { lang: 'es-ES', multilingual: false },
};
const MODELS = { 'gpt-4.1-mini': 300, 'gpt-4.1': 550, 'o4-mini': 1400 };
const DEFAULT_SSML = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{lang}"><voice name="{voice}"><prosody rate="+5%">{text}</prosody></voice></speak>';

function checkSsml(s) {
  const errs = [];
  if (!/^\s*<speak\b[^>]*>/.test(s) || !/<\/speak>\s*$/.test(s)) errs.push('root element must be <speak>…</speak>');
  const head = (s.match(/<speak\b[^>]*>/) || [''])[0];
  if (head && !/version=/.test(head)) errs.push('<speak> is missing the version attribute');
  if (head && !/xmlns=/.test(head)) errs.push('<speak> is missing xmlns');
  const stack = []; const re = /<(\/?)([a-zA-Z:]+)\b[^>]*?(\/?)>/g; let m;
  while ((m = re.exec(s))) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) { errs.push(`unexpected </${m[2]}>`); break; }
  }
  if (stack.length && !errs.some(e => e.startsWith('unexpected'))) errs.push(`unclosed <${stack[stack.length - 1]}>`);
  if ((s.match(/</g) || []).length !== (s.match(/>/g) || []).length) errs.push('unbalanced angle brackets');
  return errs;
}
const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function run(p) {
  const c = CALLERS[p.caller] || CALLERS.reschedule;
  const f = FORMATS[p.audioFormat] || FORMATS.pcm16k;
  const r = rng(`${p.caller}|${p.audioFormat}|${p.locale}|${p.silenceMs}`);
  const steps = [];
  const timeline = [];
  let t = 0;
  const speechMs = s => s.split(/\s+/).length * 330;

  // 1. Audio in
  steps.push(step('mic', 'Caller audio stream', `${f.label}. ${c.segments.length} spoken segment(s)${c.pauseMs ? `, ${c.pauseMs} ms pause between them` : ''}.`, { format: p.audioFormat }));
  c.segments.forEach((s, i) => { const d = speechMs(s); timeline.push({ label: `Caller: "${s.slice(0, 28)}…"`, start: t, end: t + d, lane: 'Caller', tone: 'info' }); t += d + (i < c.segments.length - 1 ? c.pauseMs : 0); });
  const endOfSpeech = t;

  if (p.auth === 'entra-nodomain') {
    steps.push(step('stt', '401: Entra ID auth not accepted', 'Microsoft Entra authentication for Speech needs a resource with a custom subdomain (and a role such as "Cognitive Services Speech User"). This resource only has the regional endpoint.', { httpStatus: 401, auth: 'Entra ID token' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Recognizer canceled (CancellationReason.Error). Fix authentication before anything else.' }], metrics: [], summary: 'Auth failure', meta: {} };
  }

  // 2. STT
  if (!f.ok) {
    steps.push(step('stt', 'No speech recognised (NoMatch)', `The push stream assumes the declared AudioStreamFormat (default 16 kHz, 16-bit, mono PCM). ${p.audioFormat === 'mp3raw' ? 'Compressed MP3 bytes were read as raw samples.' : '48 kHz stereo samples were read as 16 kHz mono.'} The recogniser hears noise.`, { reason: 'NoMatch', hint: 'Declare the real format (AudioStreamFormat / compressed container format) or resample to 16 kHz mono.' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'The agent never receives text. Fix the audio format at the edge (resample or declare it).' }, { type: 'timeline', title: 'Turn timeline (estimates)', unit: 'ms', items: timeline }], metrics: [], summary: `STT NoMatch (${f.label})`, meta: {} };
  }
  const autoDetect = p.locale === 'auto';
  const usedLocale = autoDetect ? c.lang : p.locale;
  const localeMismatch = usedLocale !== c.lang;
  const phrases = String(p.phraseList || '').split(/[,;\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const boosted = c.hard && phrases.includes(c.hard.term.toLowerCase());
  let heard = c.segments.map(s => (localeMismatch ? (c.asEnglish || s.replace(/[a-z]/g, x => x)) : c.hard && !boosted ? s.replace(c.hard.term, c.hard.misheard) : s));
  if (localeMismatch && c.lang === 'en-US') heard = c.segments.map(s => s.toLowerCase().replace(/the|my/g, 'el').replace(/order/g, 'orden'));
  const split = c.segments.length > 1 && (p.mode === 'once' || p.silenceMs < c.pauseMs);
  const lost = p.mode === 'once' && c.segments.length > 1;
  const conf = round((f.lowBand ? 0.82 : 0.92) - (localeMismatch ? 0.5 : 0) - (c.hard && !boosted ? 0.06 : 0) + r() * 0.04, 2);
  const sttFinal = endOfSpeech + p.silenceMs + 100;
  const firstFinal = split ? speechMs(c.segments[0]) + p.silenceMs + 100 : sttFinal;
  timeline.push({ label: `STT final (silence timeout ${p.silenceMs} ms)`, start: split ? speechMs(c.segments[0]) : endOfSpeech, end: firstFinal, lane: 'STT', tone: split ? 'warn' : 'ok' });

  steps.push(step('stt', localeMismatch ? `Recognised with the wrong locale (${usedLocale})` : `Recognised (${usedLocale}${autoDetect ? ', auto-detected' : ''})`,
    `${p.mode === 'continuous' ? 'Continuous recognition' : 'recognize_once (single utterance)'}; ${phrases.length ? `phrase list: ${phrases.join(', ')}` : 'no phrase list'}. Transcript: "${(lost ? heard.slice(0, 1) : heard).join(' ')}".`,
    { RecognitionStatus: 'Success', DisplayText: (lost ? heard.slice(0, 1) : heard).join(' '), Language: autoDetect ? c.lang : undefined, confidence: conf, segmentationSilenceTimeoutMs: p.silenceMs },
    localeMismatch ? 'warn' : f.lowBand ? 'info' : 'ok'));
  if (c.hard && !boosted && !localeMismatch) steps.push(step('stt', `Product code misrecognised: "${c.hard.misheard}"`, `"${c.hard.term}" is not ordinary vocabulary. A phrase list (PhraseListGrammar) with the term biases recognition towards it.`, { expected: c.hard.term, heard: c.hard.misheard }, 'warn'));
  if (split) steps.push(step('stt', lost ? 'Second half of the request lost' : 'Utterance split into two turns', lost ? 'recognize_once returns after the first pause; "The order number is 7731." is never heard.' : `The caller paused ${c.pauseMs} ms, longer than the ${p.silenceMs} ms segmentation silence timeout, so the first half was finalised and sent to the agent alone.`, { pauseMs: c.pauseMs, silenceMs: p.silenceMs, mode: p.mode }, 'warn'));

  // 3. Agent
  const firstTurn = split ? heard[0] : heard.join(' ');
  const txt = firstTurn.toLowerCase();
  let reply, tool = null, agentStatus = 'ok';
  const es = c.lang === 'es-ES' && !localeMismatch;
  if (localeMismatch) { reply = 'Sorry, I did not catch that. Could you repeat your request?'; agentStatus = 'warn'; }
  else if (/appointment/.test(txt)) { tool = { name: 'reschedule_appointment', arguments: { day: 'Thursday', time: '15:00' } }; reply = 'Done. Your appointment is moved to Thursday at 3 pm. Is there anything else?'; }
  else if (/zx-450/.test(txt) && /7731/.test(txt)) { tool = { name: es ? 'cancel_order' : 'get_order_status', arguments: { order_id: '7731', product: 'ZX-450' } }; reply = es ? 'He cancelado su pedido 7731 de los auriculares ZX-450. Recibirá el reembolso en cinco días.' : 'Your ZX-450 earbuds, order 7731, shipped yesterday and should arrive on Tuesday.'; }
  else if (/7731/.test(txt)) { tool = { name: es ? 'cancel_order' : 'get_order_status', arguments: { order_id: '7731', product: c.hard ? c.hard.misheard : null } }; reply = es ? 'No encuentro el producto "zeta equis 450" en el pedido 7731. ¿Puede repetirlo?' : 'I could not find that product on order 7731. Which product was it?'; agentStatus = 'warn'; }
  else { reply = 'I can help with that. What is your order number?'; agentStatus = split ? 'warn' : 'ok'; }
  const llmMs = MODELS[p.model] + (tool ? 150 : 0);
  timeline.push({ label: `Agent ${p.model}${tool ? ' + tool' : ''}`, start: firstFinal, end: firstFinal + llmMs, lane: 'Agent', tone: 'info' });
  steps.push(step('agent', tool ? `Agent called ${tool.name}` : 'Agent replied without a tool', `Input: "${firstTurn}". Reply: "${reply}"`, { tool_call: tool, model: p.model }, agentStatus));
  if (tool) steps.push(step('tool', `${tool.name} → ${agentStatus === 'ok' ? 'success' : 'not found'}`, agentStatus === 'ok' ? 'Back-end confirmed.' : 'Back-end could not match the product argument.', { arguments: tool.arguments }, agentStatus === 'ok' ? 'ok' : 'warn'));

  // 4. TTS
  const voice = VOICES[p.voice] || VOICES['en-US-AvaMultilingualNeural'];
  const replyLang = es ? 'es-ES' : 'en-US';
  const ssml = String(p.ssml || '').replace('{voice}', p.voice).replace('{lang}', replyLang).replace('{text}', esc(reply));
  const ssmlErrs = checkSsml(ssml);
  if (ssmlErrs.length) {
    steps.push(step('tts', 'Synthesis canceled: SSML invalid', ssmlErrs.join('; ') + '. The service rejects malformed SSML (CancellationReason.Error) and the caller hears silence.', { ssml: ssml.slice(0, 160) }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'The agent produced a reply but the caller hears nothing. Validate SSML before sending it, and fall back to plain text synthesis on error.' }, { type: 'code', title: 'SSML sent', lang: 'xml', text: ssml }, { type: 'timeline', title: 'Turn timeline (estimates)', unit: 'ms', items: timeline }], metrics: [], summary: 'TTS failed: malformed SSML', meta: {} };
  }
  const voiceName = (ssml.match(/<voice\s+name="([^"]+)"/) || [])[1];
  const voiceOk = voice.lang === replyLang || voice.multilingual;
  const ttsStart = firstFinal + llmMs;
  const ttsFirst = ttsStart + 150;
  const replyDur = speechMs(reply);
  timeline.push({ label: `TTS ${voiceName || p.voice} (first audio)`, start: ttsStart, end: ttsFirst, lane: 'TTS', tone: voiceOk ? 'ok' : 'warn' });
  timeline.push({ label: 'Agent speaking', start: ttsFirst, end: ttsFirst + replyDur, lane: 'TTS', tone: 'muted' });
  steps.push(step('tts', voiceOk ? `Synthesised with ${p.voice}` : `Voice ${p.voice} cannot speak ${replyLang} natively`, voiceOk ? `Neural voice, SSML valid, streaming audio to the caller.` : `${p.voice} is a ${voice.lang} voice without multilingual support: the ${replyLang} reply will be read with the wrong pronunciation. Use a ${replyLang} or multilingual voice.`, { voice: p.voice, xmlLang: replyLang, ssmlValid: true }, voiceOk ? 'ok' : 'warn'));

  // 5. Barge-in
  if (c.bargeIn) {
    const at = ttsFirst + c.bargeIn.atMs;
    timeline.push({ label: `Caller interrupts: "${c.bargeIn.text}"`, start: at, end: at + speechMs(c.bargeIn.text), lane: 'Caller', tone: 'warn' });
    if (p.bargeIn && p.mode === 'continuous') steps.push(step('speaker', 'Barge-in handled', 'Recogniser kept listening during playback (with echo cancellation); on speech start the app stopped synthesis and sent "Actually, make it Friday." to the agent, which re-called reschedule_appointment(day="Friday").', { stopSpeaking: true, newTool: { name: 'reschedule_appointment', arguments: { day: 'Friday', time: '15:00' } } }));
    else steps.push(step('speaker', 'Interruption ignored', p.mode === 'once' ? 'recognize_once is not listening during playback, so the correction is never heard.' : 'Barge-in is off: playback continues over the caller and the correction is dropped. The appointment stays on Thursday.', null, 'warn'));
  } else steps.push(step('speaker', 'Reply played', `~${round(replyDur / 1000, 1)} s of audio (estimate).`, null));

  const latency = ttsFirst - (split ? speechMs(c.segments[0]) : endOfSpeech);
  const over = latency > p.budgetMs;
  steps.push(step('agent', over ? `Response latency ~${latency} ms exceeds budget` : `Response latency ~${latency} ms within budget`, `End of speech → first audio: silence timeout ${p.silenceMs} + STT finalisation ~100 + model ~${MODELS[p.model]}${tool ? ' + tool ~150' : ''} + TTS first byte ~150 (all estimates). Budget ${p.budgetMs} ms.`, { budgetMs: p.budgetMs, estimateMs: latency }, over ? 'warn' : 'ok'));

  const output = [
    { type: 'chat', title: 'Turn transcript', turns: [
      ...c.segments.map((s, i) => ({ role: 'user', text: (lost && i > 0) ? `(not heard) ${s}` : heard[i], meta: i === 0 || !split ? `STT ${usedLocale} • conf ${conf}` : 'arrives as a separate turn' })),
      ...(tool ? [{ role: 'tool', text: `${tool.name}(${JSON.stringify(tool.arguments)})` }] : []),
      { role: 'assistant', text: reply, meta: `TTS ${p.voice}` },
      ...(c.bargeIn ? [{ role: 'user', text: c.bargeIn.text, meta: p.bargeIn && p.mode === 'continuous' ? 'barge-in → playback stopped' : 'ignored (talked over)' }] : []),
    ] },
    { type: 'timeline', title: 'Turn timeline (estimates, not measurements)', unit: 'ms', items: timeline },
    { type: 'code', title: 'SSML sent to the Speech service', lang: 'xml', text: ssml },
  ];
  return {
    steps, output,
    metrics: [
      metric('End of speech → first audio', `~${latency} ms`, 'estimate', 'Sum of illustrative stage estimates; measure real latency per region and model.'),
      metric('Product code recognised', c.hard ? (boosted && !localeMismatch ? 'yes' : 'no') : 'n/a', 'computed'),
      metric('Turns sent to the agent', String(split && !lost ? 2 : 1), 'computed'),
      metric('SSML valid', 'yes', 'computed'),
    ],
    summary: `${c.label.split(' (')[0]} • ${usedLocale} • silence ${p.silenceMs} ms • ~${latency} ms${over ? ' (over budget)' : ''}`,
    meta: { latency, over, split, boosted, voiceOk },
  };
}

export default {
  id: '4.2.1',
  lab: 'Voice agent turn simulator',
  services: [
    { name: 'Azure AI Speech: speech to text', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text' },
    { name: 'Azure AI Speech: text to speech and SSML', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup' },
    { name: 'Improve recognition with phrase lists', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list' },
  ],
  prereqs: ['2.2.2'],
  next: ['4.2.2', '4.2.3'],

  concept: {
    plain: 'A voice agent is a loop: listen, turn speech into text, let the agent decide what to do, turn the answer back into speech, and keep listening in case the caller interrupts. Each step has settings that decide whether the caller feels understood: the audio format, the language, how long a pause ends a sentence, special words like product codes, and the voice used to answer.',
    technical: 'With the Speech SDK (azure-cognitiveservices-speech), a SpeechRecognizer reads from a microphone or push stream (default 16 kHz 16-bit mono PCM unless an AudioStreamFormat is declared), uses a recognition language or AutoDetectSourceLanguageConfig, and runs recognize_once or continuous recognition; the segmentation silence timeout decides when a phrase is finalised, and a PhraseListGrammar biases recognition towards domain terms. Final text goes to the agent (Foundry Agent Service or a chat model with tools); the reply is synthesised by a SpeechSynthesizer with a neural voice, optionally via SSML (<speak version xmlns xml:lang><voice name><prosody>). Barge-in means continuing recognition during playback and stopping synthesis when the caller speaks.',
    useCase: 'A retailer\'s phone line uses Azure Communication Services to stream call audio to a recogniser with a phrase list of product codes, sends final text to an order-status agent, and answers with a multilingual neural voice. The latency budget from end of speech to first audio is tracked per stage, and callers can interrupt at any time.',
    terms: [
      ['Segmentation silence timeout', 'How much silence ends a phrase in continuous recognition. Too short splits sentences; too long adds latency.'],
      ['Phrase list', 'Runtime list of words/phrases that biases recognition, e.g. product codes and names.'],
      ['SSML', 'Speech Synthesis Markup Language: XML controlling voice, language, prosody, pauses and pronunciation.'],
      ['Barge-in', 'Letting the user interrupt playback; the app stops TTS and processes the new speech.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'mic', label: 'Caller audio', col: 0, row: 1, kind: 'user', badge: p ? p.audioFormat : undefined, detail: 'Microphone, browser or telephony stream.' },
          { id: 'stt', label: 'Speech to text', col: 1, row: 1, kind: 'ai', badge: p ? `${p.locale} • ${p.silenceMs} ms` : undefined, detail: 'Recognition language, mode, silence timeout, phrase list.', substeps: ['Voice activity', 'Partial results', 'Final result at silence', 'Language detection'] },
          { id: 'agent', label: 'Agent reasoning', col: 2, row: 1, kind: 'ai', badge: p ? p.model : undefined, detail: 'Decides intent, calls tools, writes the reply.' },
          { id: 'tool', label: 'Tools', col: 2, row: 2.3, kind: 'external', detail: 'Order status, scheduling APIs.' },
          { id: 'tts', label: 'Text to speech', col: 3, row: 1, kind: 'ai', badge: p ? p.voice.replace('Neural', '') : undefined, detail: 'Neural voice, SSML prosody, streaming audio.' },
          { id: 'speaker', label: 'Playback + barge-in', col: 4, row: 1, kind: 'user', badge: p && p.bargeIn ? 'barge-in' : 'no barge-in', detail: 'Keep listening while speaking; stop playback when the caller talks.' },
        ],
        edges: [['mic', 'stt'], ['stt', 'agent', 'final text'], ['agent', 'tool'], ['tool', 'agent'], ['agent', 'tts', 'reply'], ['tts', 'speaker'], ['speaker', 'stt', 'interrupt']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'mic', label: 'Azure Communication Services / web client', col: 0, row: 1, kind: 'app', detail: 'Streams call audio to your service.' },
          { id: 'stt', label: 'Azure AI Speech (STT)', col: 1, row: 0, kind: 'ai', badge: p && p.auth === 'entra-nodomain' ? 'no custom domain' : undefined, detail: 'Key, or Entra ID with a custom subdomain and a Speech role.' },
          { id: 'agent', label: 'Foundry Agent Service', col: 2, row: 1, kind: 'ai', detail: 'Agent with tools; thread per call.' },
          { id: 'tool', label: 'Order API (Functions)', col: 2, row: 2.5, kind: 'compute', detail: 'Tool back-end.' },
          { id: 'tts', label: 'Azure AI Speech (TTS)', col: 3, row: 0, kind: 'ai', detail: 'Neural voices, SSML.' },
          { id: 'speaker', label: 'Media stream back to caller', col: 4, row: 1, kind: 'app', detail: 'Playback with interruption handling.' },
        ],
        edges: [['mic', 'stt', 'PCM'], ['stt', 'agent'], ['agent', 'tool'], ['agent', 'tts'], ['tts', 'speaker']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'mic', label: `stream = PushAudioInputStream(${p && p.audioFormat === 'pcm8k' ? 'AudioStreamFormat(samples_per_second=8000)' : ''})`, col: 0, row: 0, kind: 'code', detail: 'Declare the real format; default is 16 kHz 16-bit mono PCM. Illustrative.' },
          { id: 'stt', label: `speech_config.set_property(PropertyId.Speech_SegmentationSilenceTimeoutMs, "${p ? p.silenceMs : 500}"); rec = SpeechRecognizer(speech_config, audio_config${p && p.locale === 'auto' ? ', auto_detect_source_language_config=AutoDetectSourceLanguageConfig(["en-US","es-ES"])' : ''})`, col: 0, row: 1, kind: 'code', detail: 'azure-cognitiveservices-speech.' },
          { id: 'tool', label: `PhraseListGrammar.from_recognizer(rec).addPhrase(...)  # ${p && p.phraseList ? p.phraseList : 'none'}`, col: 0, row: 2, kind: 'code', detail: 'Runtime biasing.' },
          { id: 'agent', label: `rec.recognized.connect(on_final); rec.${p && p.mode === 'once' ? 'recognize_once()' : 'start_continuous_recognition()'}`, col: 0, row: 3, kind: 'code', detail: 'on_final sends text to the agent.' },
          { id: 'tts', label: 'synth.speak_ssml_async(ssml)', col: 0, row: 4, kind: 'code', detail: 'SpeechSynthesizer with the chosen voice.' },
          { id: 'speaker', label: 'rec.recognizing → synth.stop_speaking_async()', col: 0, row: 5, kind: 'code', detail: 'Barge-in: stop playback on new speech.' },
        ],
        edges: [['mic', 'stt'], ['stt', 'tool'], ['tool', 'agent'], ['agent', 'tts'], ['tts', 'speaker']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'caller', label: 'Caller scenario', type: 'select', options: Object.entries(CALLERS).map(([k, c]) => [k, c.label]), default: 'reschedule' },
      { id: 'audioFormat', label: 'Audio format into the recogniser', type: 'select', options: Object.entries(FORMATS).map(([k, f]) => [k, f.label]), default: 'pcm16k' },
      { id: 'locale', label: 'Recognition language', type: 'select', options: [['en-US', 'en-US'], ['es-ES', 'es-ES'], ['auto', 'Auto-detect (en-US, es-ES)']], default: 'en-US' },
      { id: 'mode', label: 'Recognition mode', type: 'select', options: [['continuous', 'Continuous'], ['once', 'recognize_once']], default: 'continuous' },
      { id: 'silenceMs', label: 'Segmentation silence timeout (ms)', type: 'range', min: 200, max: 2000, step: 100, default: 500 },
      { id: 'phraseList', label: 'Phrase list (comma-separated)', type: 'text', default: '' },
      { id: 'model', label: 'Agent model', type: 'select', options: Object.keys(MODELS).map(k => [k, k]), default: 'gpt-4.1-mini' },
      { id: 'voice', label: 'TTS voice', type: 'select', options: Object.keys(VOICES).map(k => [k, k]), default: 'en-US-AvaMultilingualNeural' },
      { id: 'ssml', label: 'SSML template ({voice}, {lang}, {text})', type: 'textarea', default: DEFAULT_SSML },
      { id: 'bargeIn', label: 'Barge-in (stop playback when caller speaks)', type: 'toggle', default: true },
      { id: 'budgetMs', label: 'Latency budget, end of speech → first audio (ms)', type: 'number', min: 500, max: 5000, step: 100, default: 1800 },
      { id: 'auth', label: 'Speech authentication', type: 'select', options: [['key', 'Resource key'], ['entra', 'Entra ID (custom subdomain + role)'], ['entra-nodomain', 'Entra ID, no custom subdomain']], default: 'key' },
    ],
    samples: [
      { label: 'Reschedule with barge-in', values: { caller: 'reschedule' } },
      { label: 'Order lookup, default settings', values: { caller: 'order' } },
      { label: 'Order lookup, tuned', values: { caller: 'order', phraseList: 'ZX-450, Contoso', silenceMs: 1000 } },
      { label: 'Spanish caller, auto-detect', values: { caller: 'spanish', locale: 'auto', phraseList: 'ZX-450' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the order caller with silence timeout 500, 1000 and 1800 ms: compare turn splitting and estimated latency.',
      'Run the order caller with and without "ZX-450" in the phrase list and compare the tool result.',
      'Run the Spanish caller with en-US, then auto-detect, then switch the voice from AndrewNeural to AvaMultilingualNeural.',
    ],
  },

  debug: [
    { id: 'format', title: 'Recogniser returns NoMatch for every call', values: { audioFormat: 'pcm48stereo' }, node: 'stt',
      symptom: 'ResultReason.NoMatch; the agent never gets text.', cause: '48 kHz stereo audio pushed into a stream that expects 16 kHz mono PCM.', fix: 'Resample to 16 kHz mono (or declare the real AudioStreamFormat).' },
    { id: 'locale', title: 'Spanish callers get "Sorry, I did not catch that"', values: { caller: 'spanish', locale: 'en-US', phraseList: 'ZX-450' }, node: 'stt',
      symptom: 'Transcript is English-sounding nonsense.', cause: 'Recognition language is fixed to en-US.', fix: 'Use AutoDetectSourceLanguageConfig with candidate locales (or es-ES).' },
    { id: 'split', title: 'Agent answers before the caller finishes', values: { caller: 'order', phraseList: 'ZX-450', silenceMs: 400 }, node: 'stt',
      symptom: 'Agent asks for the order number the caller was about to say.', cause: 'Silence timeout shorter than the caller\'s natural pause.', fix: 'Raise the segmentation silence timeout (≈1000 ms here), balancing latency.' },
    { id: 'ssml', title: 'Caller hears silence after the agent replies', values: { ssml: '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{lang}"><voice name="{voice}"><prosody rate="+5%">{text}</voice></speak>' }, node: 'tts',
      symptom: 'Synthesis canceled with an SSML error.', cause: 'Malformed SSML: <prosody> is not closed.', fix: 'Restore the closing </prosody> (validate SSML before sending).' },
    { id: 'bargein', title: 'Caller correction ignored', values: { caller: 'reschedule', bargeIn: false }, node: 'speaker',
      symptom: 'Agent talks over "Actually, make it Friday" and books Thursday.', cause: 'No barge-in handling during playback.', fix: 'Keep continuous recognition running and stop synthesis on speech start.' },
    { id: 'auth', title: '401 after switching to keyless auth', values: { auth: 'entra-nodomain' }, node: 'stt',
      symptom: 'Recogniser canceled with an authentication error.', cause: 'Entra ID auth for Speech needs a custom subdomain on the resource.', fix: 'Add a custom domain and role, or (temporarily) use the key.' },
    { id: 'slowmodel', title: 'Callers complain about long pauses', values: { caller: 'order', phraseList: 'ZX-450', silenceMs: 1000, model: 'o4-mini' }, node: 'agent',
      symptom: 'Estimated latency far above the budget.', cause: 'A reasoning model adds seconds before the first token: unsuitable for real-time turn-taking.', fix: 'Use a fast chat model (e.g. gpt-4.1-mini) for the voice loop.' },
  ],

  challenge: {
    task: 'Make the order-lookup call work end to end: correct product code, one complete turn, a successful tool call and first audio within the 1800 ms budget.',
    condition: 'Caller = order lookup, budget ≤ 1800 ms, no warnings or errors.',
    hint: 'Two STT settings matter, and they pull latency in opposite directions. Then pick the agent model.',
    check: (p, res) => p.caller === 'order' && p.budgetMs <= 1800 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Add "ZX-450" to the phrase list.', 'Set the silence timeout to ~1000 ms (longer than the 900 ms pause, short enough for the budget).', 'Keep gpt-4.1-mini as the agent model.', 'Run: one turn, get_order_status succeeds, ~1700 ms estimate.'],
    solutionValues: { caller: 'order', audioFormat: 'pcm16k', locale: 'en-US', mode: 'continuous', silenceMs: 1000, phraseList: 'ZX-450', model: 'gpt-4.1-mini', budgetMs: 1800, ssml: DEFAULT_SSML, auth: 'key' },
  },

  quiz: [
    { q: 'Callers often pause mid-sentence while reading account numbers, and the agent responds too early. Which setting do you tune first?', options: ['TTS prosody rate', 'Segmentation silence timeout of continuous recognition', 'Neural voice', 'Agent temperature'], answer: 1, why: 'The silence timeout decides when a phrase is finalised; raise it carefully because it adds latency.' },
    { q: 'Your recogniser keeps transcribing "ZX-450" as "said X 450". You need a fix today without training. What do you use?', options: ['A phrase list containing ZX-450', 'A custom neural voice', 'SSML <phoneme>', 'Switch to recognize_once'], answer: 0, why: 'Phrase lists bias recognition at runtime with no training. SSML affects synthesis, not recognition.' },
    { q: 'A bilingual hotline must handle English and Spanish callers and answer in the caller\'s language. Which combination fits?', options: ['Fixed en-US recognition and an en-US voice', 'AutoDetectSourceLanguageConfig with candidate locales and a multilingual (or per-language) neural voice', 'Translator on the audio stream', 'Two separate phone numbers only'], answer: 1, why: 'Detect the spoken language from candidates, then synthesise with a voice that can speak the reply language.' },
    { q: 'Synthesis is canceled with an error after a template change. Plain-text synthesis still works. Most likely cause?', options: ['Wrong recognition language', 'Malformed SSML (e.g. unclosed element or missing xmlns/version)', 'Phrase list too long', 'Missing tool definition'], answer: 1, why: 'SSML must be well-formed XML with a valid <speak> root; validate templates and fall back to plain text.' },
  ],

  recap: 'A voice agent loop is STT → agent → TTS with barge-in. Get the audio format right, set the recognition language or auto-detect, tune the silence timeout against latency, add phrase lists for domain terms, use a fast model, validate SSML, choose a voice that speaks the reply language, and track the latency budget per stage.',
};
