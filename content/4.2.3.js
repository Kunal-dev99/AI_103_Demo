// 4.2.3 Enable multimodal reasoning from audio inputs
// Lab: Audio reasoning lab (conceptual).
import { step, metric } from '../src/engine/util.js';

// Information units in each clip. type decides which processing path can preserve it.
// t = [start, end] seconds, lane = timeline lane.
const CLIPS = {
  support: {
    label: 'Support call: cancellation (2 speakers)', seconds: 180,
    units: [
      { type: 'words', text: 'Customer: "It\'s fine, I guess. Just cancel the renewal."', t: [95, 99], lane: 'Customer' },
      { type: 'number', text: 'Agent quotes a refund of 49.99', t: [60, 64], lane: 'Agent' },
      { type: 'speaker', text: 'Agent (speaker 1) makes the retention offer; customer (speaker 2) declines', t: [40, 99], lane: 'Agent' },
      { type: 'tone', text: 'Customer sighs and sounds strained: dissatisfied despite neutral words', t: [93, 99], lane: 'Customer' },
      { type: 'overlap', text: 'Customer talks over the agent twice during the retention offer', t: [44, 52], lane: 'Customer' },
      { type: 'timing', text: '4-second silence after the price is mentioned', t: [64, 68], lane: 'Agent' },
      { type: 'event', text: 'Hold music for ~20 s', t: [70, 90], lane: 'Background' },
    ],
  },
  meeting: {
    label: 'Team meeting excerpt (3 speakers)', seconds: 240,
    units: [
      { type: 'words', text: 'Lena: "Sure, Friday works, great idea."', t: [150, 154], lane: 'Lena' },
      { type: 'number', text: 'Budget of 12,000 mentioned by Raj', t: [100, 104], lane: 'Raj' },
      { type: 'speaker', text: 'Raj proposes the Friday deadline; Lena agrees reluctantly; Omar stays silent', t: [120, 154], lane: 'Raj' },
      { type: 'tone', text: 'Lena\'s "great idea" is flat and sarcastic', t: [152, 154], lane: 'Lena' },
      { type: 'overlap', text: 'Raj and Lena speak at the same time when the deadline is set', t: [140, 146], lane: 'Lena' },
      { type: 'timing', text: 'Decision made at 02:34', t: [154, 155], lane: 'Raj' },
      { type: 'event', text: 'Laughter after Lena\'s remark', t: [155, 158], lane: 'Background' },
    ],
  },
  field: {
    label: 'Field radio check from a plant floor', seconds: 30,
    units: [
      { type: 'words', text: 'Worker: "Everything\'s fine here, line 3 is running."', t: [10, 14], lane: 'Worker' },
      { type: 'number', text: 'Line 3', t: [12, 13], lane: 'Worker' },
      { type: 'speaker', text: 'One main speaker on the radio', t: [10, 14], lane: 'Worker' },
      { type: 'tone', text: 'Speaker is rushed and shouting over noise', t: [10, 14], lane: 'Worker' },
      { type: 'overlap', text: 'Second voice shouts "shut it down", partly masked by the alarm', t: [13, 15], lane: 'Background' },
      { type: 'timing', text: 'Alarm starts 5 s before the statement', t: [5, 10], lane: 'Background' },
      { type: 'event', text: 'Repeated high-pitched alarm beeping throughout', t: [5, 30], lane: 'Background' },
    ],
  },
  voicemail: {
    label: 'Insurance voicemail', seconds: 25,
    units: [
      { type: 'words', text: '"Please call me back about the claim when you can."', t: [3, 9], lane: 'Caller' },
      { type: 'number', text: 'Claim number 55-1043', t: [10, 14], lane: 'Caller' },
      { type: 'speaker', text: 'Single caller', t: [3, 14], lane: 'Caller' },
      { type: 'tone', text: 'Caller is breathless and shaky: sounds distressed', t: [3, 14], lane: 'Caller' },
      { type: 'event', text: 'Siren passes; traffic noise suggests the caller is at a roadside', t: [6, 12], lane: 'Background' },
      { type: 'timing', text: 'Long pause before giving the claim number', t: [9, 10], lane: 'Caller' },
    ],
  },
};
const QUESTIONS = {
  agreed: { label: 'What was said or agreed?', needs: ['words', 'speaker', 'number'] },
  feel: { label: 'How does the person really feel?', needs: ['tone', 'words'] },
  interrupt: { label: 'Who interrupted whom, and when?', needs: ['speaker', 'overlap', 'timing'] },
  events: { label: 'What happened in the background?', needs: ['event', 'timing'] },
  risk: { label: 'Is there a safety or urgency risk?', needs: ['event', 'tone', 'words', 'overlap'] },
};
// What each path preserves: kept | approx | lost.
const PATHS = {
  transcribe: { label: 'Transcribe, then reason (text only)', keep: { words: 'kept', number: 'kept', speaker: 'lost', timing: 'lost', overlap: 'lost', tone: 'lost', event: 'lost' } },
  diarize: { label: 'Transcribe + diarization + timestamps, then reason', keep: { words: 'kept', number: 'kept', speaker: 'kept', timing: 'kept', overlap: 'approx', tone: 'lost', event: 'lost' } },
  native: { label: 'Native audio model', keep: { words: 'approx', number: 'approx', speaker: 'approx', timing: 'approx', overlap: 'kept', tone: 'kept', event: 'kept' } },
  hybrid: { label: 'Hybrid: native audio + transcript for grounding', keep: { words: 'kept', number: 'kept', speaker: 'kept', timing: 'kept', overlap: 'kept', tone: 'kept', event: 'kept' } },
};
const MODELS = {
  'gpt-4o-audio-preview': { audio: true, label: 'gpt-4o-audio-preview (audio in/out)' },
  'gpt-realtime': { audio: true, label: 'gpt-realtime (low-latency audio)' },
  'gpt-4.1': { audio: false, label: 'gpt-4.1 (text and image only)' },
};
const STATUS_TONE = { kept: 'ok', approx: 'warn', lost: 'error' };

function run(p) {
  const clip = CLIPS[p.clip] || CLIPS.support;
  const path = PATHS[p.path] || PATHS.transcribe;
  const q = QUESTIONS[p.question] || QUESTIONS.feel;
  const model = MODELS[p.model] || MODELS['gpt-4o-audio-preview'];
  const usesAudio = p.path === 'native' || p.path === 'hybrid';
  const usesStt = p.path !== 'native';
  const seconds = p.clipSeconds;
  const steps = [];
  steps.push(step('ingest', 'Audio received', `${clip.label}, ${p.format.toUpperCase()}, ${seconds} s.`, { format: p.format, seconds }));

  if (usesAudio && !model.audio) {
    steps.push(step('audioenc', 'Model cannot accept audio', `${model.label} has no audio input. Sending an input_audio content part fails (unsuitable model).`, { model: p.model, error: 'unsupported content type (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Use an audio-capable deployment (e.g. gpt-4o-audio-preview) or a transcribe-first path.' }], metrics: [], summary: `${path.label}: model has no audio input`, meta: {} };
  }
  if (usesAudio && p.format === 'm4a') {
    steps.push(step('audioenc', 'Audio format rejected', 'In this simulation the audio model deployment accepts wav or mp3 input only. Check the model\'s supported input formats and convert before sending.', { format: 'm4a' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Convert the clip to wav or mp3 (e.g. with ffmpeg) before the model call.' }], metrics: [], summary: 'Unsupported audio format for the model', meta: {} };
  }
  if (usesAudio && seconds > 600 && !p.chunking) {
    steps.push(step('audioenc', 'Clip too long for one request (simulated)', 'Long audio produces many audio tokens. In this simulation clips over 10 minutes must be chunked; real limits depend on model and API version.', { seconds }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Enable chunking (segments with overlap, summarised then combined) or use a transcribe-first path for long recordings.' }], metrics: [], summary: 'Native audio: clip too long', meta: {} };
  }

  // STT and diarization
  if (usesStt) steps.push(step('stt', 'Speech to text', 'Azure AI Speech (fast/batch transcription) or a transcription model produces words with punctuation. Prosody and non-speech sounds are discarded.', { output: 'text' }));
  else steps.push(step('stt', 'No transcript', 'Native path: the model listens directly; there is no text to quote or verify against.', null, 'skip'));
  if (p.path === 'diarize' || p.path === 'hybrid') steps.push(step('diarize', 'Diarization + timestamps', 'Speaker labels and word offsets. Overlapping speech is hard for diarization and is usually attributed to one speaker.', { speakers: [...new Set(clip.units.map(u => u.lane).filter(l => l !== 'Background'))].length }));
  else steps.push(step('diarize', 'No diarization', 'Speaker turns and timing are not available.', null, 'skip'));
  if (usesAudio) steps.push(step('audioenc', 'Audio sent to the model', `${model.label} receives the audio${p.chunking && seconds > 600 ? ' in chunks' : ''} as an input_audio content part, so tone, overlap and background sounds can inform the answer.`, { content: [{ type: 'text', text: q.label }, { type: 'input_audio', input_audio: { data: '<base64>', format: p.format } }] }, p.chunking && seconds > 600 ? 'info' : 'ok'));
  else steps.push(step('audioenc', 'Audio not sent', `The reasoning model only sees text${!model.audio ? '' : ` (${model.label} could take audio, but this path does not use it)`}.`, null, 'skip'));

  // Reasoning
  const units = clip.units.map(u => ({ ...u, status: path.keep[u.type] }));
  const needed = units.filter(u => q.needs.includes(u.type));
  const kept = needed.filter(u => u.status === 'kept');
  const approx = needed.filter(u => u.status === 'approx');
  const lost = needed.filter(u => u.status === 'lost');
  const coverage = needed.length ? (kept.length + approx.length * 0.5) / needed.length : 1;
  steps.push(step('reason', `Answering: "${q.label}"`, `Needs ${q.needs.join(', ')}. Available: ${kept.length} exact, ${approx.length} approximate, ${lost.length} lost.`, { needed: needed.map(u => ({ type: u.type, status: u.status })) }, lost.length ? 'warn' : 'ok'));

  // Grounding check on quotes and numbers
  const quoteUnits = needed.filter(u => (u.type === 'words' || u.type === 'number'));
  const unverifiable = quoteUnits.filter(u => u.status === 'approx');
  if (quoteUnits.length) steps.push(step('answer', unverifiable.length ? 'Quotes and numbers not verifiable' : 'Quotes checked against transcript', unverifiable.length ? 'Without a transcript, quoted words and numbers come from the model\'s listening and cannot be checked; they may be paraphrased or wrong.' : 'Every quote and number in the answer appears in the transcript.', { checked: quoteUnits.length }, unverifiable.length ? 'warn' : 'ok'));
  else steps.push(step('answer', 'Answer composed', 'No quotes or numbers required.', null, 'ok'));

  const answer = [
    ...kept.map(u => `• ${u.text}`),
    ...approx.map(u => `• (approximate) ${u.text}`),
    ...(lost.length ? [`Not available on this path: ${lost.map(u => u.type).join(', ')}.`] : []),
  ].join('\n');
  const matrix = Object.entries(PATHS).map(([k, v]) => {
    const n = clip.units.filter(u => q.needs.includes(u.type));
    const c = n.length ? n.reduce((a, u) => a + (v.keep[u.type] === 'kept' ? 1 : v.keep[u.type] === 'approx' ? 0.5 : 0), 0) / n.length : 1;
    return { k, label: v.label, c };
  });
  const output = [
    { type: 'chat', title: 'Question and answer (illustrative)', turns: [{ role: 'user', text: q.label, meta: clip.label }, { role: 'assistant', text: answer || 'Nothing relevant found.', meta: path.label }] },
    { type: 'timeline', title: 'What is in the clip (red = lost on this path, amber = approximate)', unit: 's', items: units.map(u => ({ label: `${u.type}: ${u.text.slice(0, 40)}`, start: u.t[0], end: u.t[1], lane: u.lane, tone: STATUS_TONE[u.status] })) },
    { type: 'table', title: 'Information preserved per path', columns: ['Information', ...Object.values(PATHS).map(v => v.label.split(',')[0].split(' (')[0])], rows: [...new Set(clip.units.map(u => u.type))].map(t => [t + (q.needs.includes(t) ? ' *' : ''), ...Object.values(PATHS).map(v => v.keep[t])]), tones: [...new Set(clip.units.map(u => u.type))].map(t => STATUS_TONE[path.keep[t]]) },
    { type: 'bars', title: 'Coverage of what this question needs', threshold: 1, items: matrix.map(m => ({ label: m.label, value: Math.round(m.c * 100) / 100, max: 1, tone: m.k === p.path ? 'info' : m.c === 1 ? 'ok' : 'warn', note: `${Math.round(m.c * 100)}%` })) },
  ];
  return {
    steps, output,
    metrics: [
      metric('Coverage of needed information', `${Math.round(coverage * 100)}%`, 'computed', 'Exact = 1, approximate = 0.5, lost = 0, over the information types the question needs (illustrative scoring).'),
      metric('Lost information types', String(lost.length), 'computed'),
      metric('Relative input cost', usesAudio ? (p.path === 'hybrid' ? 'highest (audio + transcript)' : 'higher (audio tokens)') : 'lower (text tokens + STT)', 'estimate', 'Audio input tokens are priced differently from text tokens; compare on the pricing page for your models.'),
    ],
    summary: `${clip.label.split(' (')[0]} • ${q.label} • ${path.label.split(',')[0]} • coverage ${Math.round(coverage * 100)}%`,
    meta: { coverage },
  };
}

export default {
  id: '4.2.3',
  lab: 'Audio reasoning lab',
  services: [
    { name: 'Azure OpenAI audio models (GPT-4o audio, realtime)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/audio-completions-quickstart' },
    { name: 'Azure AI Speech: diarization', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization' },
    { name: 'Content Understanding: audio', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/audio/overview' },
  ],
  prereqs: ['4.2.1', '2.1.1'],
  next: ['4.2.4', '5.1.1'],

  concept: {
    plain: 'Audio carries more than words: who spoke, when they interrupted, how they sounded, and what was happening in the background. Turning audio into text first keeps the words but throws the rest away. A model that listens to the audio itself can notice tone and sounds, but it may misquote exact words or numbers, so the strongest setup combines both.',
    technical: 'Transcribe-then-reason pipelines use Azure AI Speech (or a transcription model) and pass text to an LLM; diarization and word timestamps add speaker turns and timing but still drop prosody and non-speech events. Audio-capable models in Foundry (e.g. gpt-4o-audio-preview via chat completions with input_audio content parts, or gpt-realtime over the Realtime API) reason over the audio signal directly, capturing tone, overlap and background sounds. A hybrid passes both audio and transcript so quotes and numbers can be grounded. Check model input formats, audio token costs and length handling (chunking) for long recordings. Content Understanding analyzers are another option for structured audio extraction.',
    useCase: 'An insurer triages voicemails. A transcript gives the claim number and request; the audio model notices a siren and a distressed voice and raises urgency; the hybrid answer quotes the claim number from the transcript and flags the call for an immediate callback.',
    terms: [
      ['Diarization', 'Labelling which speaker said each segment of a transcript.'],
      ['Prosody', 'Pitch, pace, loudness and pauses: how something is said.'],
      ['Native audio model', 'A model that accepts audio as input and reasons over it without a separate transcript.'],
      ['Hybrid grounding', 'Giving the model both audio and a transcript so it can hear tone and quote exact words.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'ingest', label: 'Audio clip', col: 0, row: 1, kind: 'data', detail: 'Speech, overlap, tone, background events.' },
          { id: 'stt', label: 'Speech to text', col: 1, row: 0, kind: 'ai', disabled: p && p.path === 'native', detail: 'Keeps words and numbers; drops prosody and sounds.' },
          { id: 'diarize', label: 'Diarization + timestamps', col: 2, row: 0, disabled: p && !(p.path === 'diarize' || p.path === 'hybrid'), detail: 'Adds speakers and timing.' },
          { id: 'audioenc', label: 'Audio encoder (native model)', col: 1.5, row: 2, kind: 'ai', disabled: p && !(p.path === 'native' || p.path === 'hybrid'), detail: 'Hears tone, overlap, background events.' },
          { id: 'reason', label: 'Reasoning', col: 3, row: 1, kind: 'ai', badge: p ? p.model : undefined, detail: 'Answers the question from what survived.' },
          { id: 'answer', label: 'Answer + grounding check', col: 4, row: 1, kind: 'policy', detail: 'Quotes and numbers verified against transcript when available.' },
        ],
        edges: [['ingest', 'stt'], ['stt', 'diarize'], ['diarize', 'reason', 'text'], ['stt', 'reason'], ['ingest', 'audioenc'], ['audioenc', 'reason', 'audio'], ['reason', 'answer']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'ingest', label: 'Blob Storage (recordings)', col: 0, row: 1, kind: 'store', detail: 'Calls, meetings, voicemails.' },
          { id: 'stt', label: 'Azure AI Speech (batch / fast transcription)', col: 1, row: 0, kind: 'ai', disabled: p && p.path === 'native', detail: 'Transcript with diarization.' },
          { id: 'diarize', label: 'Transcript store (JSON)', col: 2, row: 0, kind: 'store', disabled: p && !(p.path === 'diarize' || p.path === 'hybrid'), detail: 'Phrases with speaker and offsets.' },
          { id: 'audioenc', label: `Foundry deployment: ${p ? p.model : 'gpt-4o-audio-preview'}`, col: 2, row: 2, kind: 'ai', detail: 'Chat completions with audio input, or realtime session.' },
          { id: 'reason', label: 'Orchestrator (Function)', col: 3, row: 1, kind: 'compute', detail: 'Builds the prompt from transcript and/or audio.' },
          { id: 'answer', label: 'Case system', col: 4, row: 1, kind: 'app', detail: 'Urgency flag, summary, quotes.' },
        ],
        edges: [['ingest', 'stt'], ['stt', 'diarize'], ['ingest', 'reason'], ['diarize', 'reason'], ['reason', 'audioenc'], ['reason', 'answer']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'stt', label: 'transcript = transcribe(blob_url, diarization=True)', col: 0, row: 0, kind: 'code', disabled: p && p.path === 'native', detail: 'Speech REST / SDK. Illustrative.' },
          { id: 'audioenc', label: `{"type":"input_audio","input_audio":{"data": b64, "format":"${p ? p.format : 'wav'}"}}`, col: 0, row: 1, kind: 'code', disabled: p && !(p.path === 'native' || p.path === 'hybrid'), detail: 'Audio content part (chat completions with an audio-capable model).' },
          { id: 'reason', label: `client.chat.completions.create(model="${p ? p.model : 'gpt-4o-audio-preview'}", modalities=["text"], messages=[...])`, col: 0, row: 2, kind: 'code', detail: 'openai package against the Foundry endpoint. Illustrative.' },
          { id: 'answer', label: 'assert all(q in transcript for q in quotes(answer))', col: 0, row: 3, kind: 'code', detail: 'Grounding check for quotes/numbers.' },
          { id: 'ingest', label: 'chunks = split(audio, 300s, overlap=10s) if long', col: 0, row: 4, kind: 'code', detail: 'Chunking for long recordings.' },
          { id: 'diarize', label: 'turns = [(p.speaker, p.offset, p.text) for p in transcript.phrases]', col: 0, row: 5, kind: 'code', detail: 'Speaker turns.' },
        ],
        edges: [['stt', 'reason'], ['audioenc', 'reason'], ['reason', 'answer'], ['ingest', 'audioenc'], ['stt', 'diarize']],
      }),
    },
  },

  sim: {
    mode: 'conceptual',
    controls: [
      { id: 'clip', label: 'Audio clip', type: 'select', options: Object.entries(CLIPS).map(([k, c]) => [k, c.label]), default: 'support' },
      { id: 'question', label: 'Question', type: 'select', options: Object.entries(QUESTIONS).map(([k, q]) => [k, q.label]), default: 'feel' },
      { id: 'path', label: 'Processing path', type: 'select', options: Object.entries(PATHS).map(([k, v]) => [k, v.label]), default: 'transcribe' },
      { id: 'model', label: 'Reasoning model', type: 'select', options: Object.entries(MODELS).map(([k, m]) => [k, m.label]), default: 'gpt-4o-audio-preview' },
      { id: 'format', label: 'Audio format', type: 'select', options: [['wav', 'WAV'], ['mp3', 'MP3'], ['m4a', 'M4A']], default: 'wav' },
      { id: 'clipSeconds', label: 'Clip length (s)', type: 'range', min: 10, max: 1800, step: 10, default: 180 },
      { id: 'chunking', label: 'Chunk long audio', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Support call: feelings from transcript only', values: { clip: 'support', question: 'feel', path: 'transcribe' } },
      { label: 'Meeting: interruptions with diarization', values: { clip: 'meeting', question: 'interrupt', path: 'diarize', clipSeconds: 240 } },
      { label: 'Field radio: safety risk, native audio', values: { clip: 'field', question: 'risk', path: 'native', clipSeconds: 30 } },
      { label: 'Voicemail: hybrid', values: { clip: 'voicemail', question: 'risk', path: 'hybrid', clipSeconds: 25 } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'For the field radio clip and the safety question, run all four paths and compare which information is lost.',
      'Ask "What was said or agreed?" on the meeting with native vs hybrid and compare quote verification.',
      'Run the support call "How does the person really feel?" with transcribe vs native.',
    ],
  },

  debug: [
    { id: 'textmodel', title: 'Audio request fails with a content-type error', values: { path: 'native', model: 'gpt-4.1' }, node: 'audioenc',
      symptom: 'The request with an input_audio part is rejected.', cause: 'Unsuitable model: the deployment does not accept audio input.', fix: 'Deploy an audio-capable model (gpt-4o-audio-preview / gpt-realtime) or transcribe first.' },
    { id: 'format', title: 'Uploads from iPhones fail', values: { path: 'hybrid', format: 'm4a' }, node: 'audioenc',
      symptom: 'Audio format rejected by the model call.', cause: 'Input format not accepted by this deployment (simulated).', fix: 'Convert to wav or mp3 before the call.' },
    { id: 'long', title: 'Hour-long meeting cannot be analysed', values: { path: 'native', clip: 'meeting', clipSeconds: 1800, chunking: false }, node: 'audioenc',
      symptom: 'Request too large.', cause: 'Long audio produces too many audio tokens for one request (simulated limit).', fix: 'Enable chunking (or transcribe first and reason over text).' },
    { id: 'tone', title: 'Angry customer summarised as "fine"', values: { clip: 'support', question: 'feel', path: 'transcribe' }, node: 'stt',
      symptom: 'Answer says the customer is OK; tone is lost.', cause: 'Transcription discards prosody: "It\'s fine" reads as neutral.', fix: 'Use native audio or hybrid for tone questions.' },
    { id: 'quotes', title: 'Claim number in summary is unverified', values: { clip: 'voicemail', question: 'agreed', path: 'native', clipSeconds: 25 }, node: 'answer',
      symptom: 'Quote/number check cannot run.', cause: 'No transcript on the native path; numbers may be misheard.', fix: 'Use the hybrid path so quotes and numbers are grounded in the transcript.' },
  ],

  challenge: {
    task: 'On the field radio clip, answer "Is there a safety or urgency risk?" with full coverage and verified quotes.',
    condition: 'Clip = field radio, question = safety risk, coverage 100%, no warnings or errors.',
    hint: 'The risk is in the background, the tone and a masked second voice, but the words must still be quotable.',
    check: (p, res) => p.clip === 'field' && p.question === 'risk' && !!res.meta && res.meta.coverage === 1 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Clip: field radio; question: safety risk.', 'Path: hybrid (audio + transcript).', 'Model: an audio-capable deployment; format WAV or MP3.', 'Clip length 30 s (no chunking needed).'],
    solutionValues: { clip: 'field', question: 'risk', path: 'hybrid', model: 'gpt-4o-audio-preview', format: 'wav', clipSeconds: 30, chunking: false },
  },

  quiz: [
    { q: 'Quality managers want to know whether customers sounded frustrated even when their words were polite. Which design fits?', options: ['Transcribe and run text sentiment', 'Send the audio to an audio-capable model (or hybrid with transcript)', 'Diarization only', 'Translate the transcript'], answer: 1, why: 'Tone lives in prosody, which a transcript discards; audio-capable models can use it.' },
    { q: 'A legal team needs exact quotes and speaker attribution from depositions; tone is irrelevant. What is the most suitable and cheapest path?', options: ['Native audio model only', 'Transcription with diarization and timestamps, then a text model', 'gpt-realtime session', 'Image model on spectrograms'], answer: 1, why: 'Diarized transcripts give exact words, speakers and timing at lower cost; native audio adds no needed information.' },
    { q: 'An audio model summary of a voicemail contains claim number 55-1034, but the caller said 55-1043. How do you prevent this?', options: ['Raise temperature', 'Hybrid: pass the transcript too and verify quotes/numbers against it', 'Use a longer clip', 'Remove the audio'], answer: 1, why: 'Grounding quotes and numbers in a transcript catches misheard values while keeping audio cues.' },
  ],

  recap: 'Transcripts keep words and numbers; diarization adds speakers and timing; only audio-capable models hear tone, overlap and background sounds. Pick the path by what the question needs, use audio-capable deployments and supported formats, chunk long audio, and ground quotes and numbers in a transcript (hybrid).',
};
