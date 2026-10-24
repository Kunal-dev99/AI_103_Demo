// 3.2.6 Implement video analysis workflows to process and interpret video segments
// Lab: Video segment analyzer.
import { round, step, metric } from '../src/engine/util.js';

// Synthetic videos. Times in seconds. cue = how the event can be noticed: visual, speech or both.
const VIDEOS = {
  retail: {
    label: 'Store CCTV, 2 min, no audio',
    duration: 120, speech: false,
    shots: [[0, 18, 'Customers enter the store'], [18, 50, 'Customer browses aisle 4'], [50, 80, 'Queue at checkout'], [80, 92, 'Bottle falls and spills in aisle 4'], [92, 120, 'Staff cleans up and places a wet-floor sign']],
    transcript: [],
    events: [
      { id: 'spill', label: 'Spill in aisle 4', start: 80, end: 92, cue: 'visual', type: 'hazard' },
      { id: 'sign', label: 'Wet-floor sign placed', start: 100, end: 108, cue: 'visual', type: 'mitigation' },
    ],
    keyScene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#d9dde3' },
      { kind: 'rect', x: 4, y: 6, w: 18, h: 56, fill: '#9aa5b1' }, { kind: 'rect', x: 78, y: 6, w: 18, h: 56, fill: '#9aa5b1' },
      { kind: 'circle', x: 48, y: 54, r: 9, fill: '#7fb3e6' }, { kind: 'rect', x: 54, y: 46, w: 4, h: 10, fill: '#2e7d32' },
      { kind: 'rect', x: 64, y: 30, w: 6, h: 20, fill: '#f5c518' },
    ],
    boxes: { spill: { x: 38, y: 44, w: 22, h: 18 }, sign: { x: 61, y: 27, w: 12, h: 26 } },
  },
  training: {
    label: 'Plumbing how-to, 3 min, narrated',
    duration: 180, speech: true,
    shots: [[0, 20, 'Presenter introduces the task'], [20, 55, 'Tools laid out on bench'], [55, 100, 'Step 1: measure and cut pipe'], [100, 112, 'Presenter holds goggles'], [112, 160, 'Step 2: join pipe sections'], [160, 180, 'Outro']],
    transcript: [[2, 8, 'Welcome, today we replace a section of copper pipe.'], [22, 30, 'You will need a pipe cutter, fittings and a deburring tool.'], [58, 70, 'First, measure twice and mark the cut.'], [101, 110, 'Stop. Put on safety goggles before cutting or soldering.'], [115, 130, 'Now push the fitting onto both ends.'], [165, 175, 'Thanks for watching.']],
    events: [
      { id: 'safety', label: 'Safety instruction: goggles', start: 100, end: 112, cue: 'speech', type: 'safety' },
      { id: 'step1', label: 'Step 1 begins', start: 55, end: 70, cue: 'both', type: 'chapter' },
      { id: 'step2', label: 'Step 2 begins', start: 112, end: 130, cue: 'both', type: 'chapter' },
    ],
    keyScene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#e8e2d6' },
      { kind: 'circle', x: 50, y: 22, r: 10, fill: '#c69c7b' }, { kind: 'rect', x: 36, y: 32, w: 28, h: 30, fill: '#3e6fa8' },
      { kind: 'rect', x: 40, y: 18, w: 20, h: 5, fill: '#90caf9' },
      { kind: 'rect', x: 6, y: 56, w: 88, h: 6, fill: '#8d6e63' },
    ],
    boxes: { safety: { x: 38, y: 15, w: 24, h: 11 }, step1: { x: 6, y: 52, w: 88, h: 12 }, step2: { x: 6, y: 52, w: 88, h: 12 } },
  },
  webinar: {
    label: 'Product webinar, 5 min, slides + speaker',
    duration: 300, speech: true,
    shots: [[0, 30, 'Title slide'], [30, 150, 'Speaker with roadmap slides'], [150, 240, 'Screen-share demo'], [240, 300, 'Speaker on camera answering questions']],
    transcript: [[3, 12, 'Welcome to the spring product update.'], [35, 60, 'Here is our roadmap for the next two quarters.'], [152, 165, 'Let me switch to a live demo.'], [241, 250, 'Let’s take your questions now.'], [255, 280, 'Yes, the export feature ships in June.']],
    events: [
      { id: 'demo', label: 'Chapter: live demo', start: 150, end: 165, cue: 'both', type: 'chapter' },
      { id: 'qa', label: 'Chapter: Q&A', start: 240, end: 252, cue: 'speech', type: 'chapter' },
    ],
    keyScene: [
      { kind: 'rect', x: 0, y: 0, w: 100, h: 70, fill: '#1f2a37' },
      { kind: 'rect', x: 8, y: 8, w: 60, h: 40, fill: '#f4f6f8' }, { kind: 'text', x: 12, y: 18, text: 'Demo: export' },
      { kind: 'rect', x: 72, y: 34, w: 22, h: 26, fill: '#56657a' }, { kind: 'circle', x: 83, y: 40, r: 5, fill: '#c69c7b' },
    ],
    boxes: { demo: { x: 6, y: 6, w: 64, h: 44 }, qa: { x: 70, y: 32, w: 26, h: 30 } },
  },
};

function segmentsFor(v, p) {
  if (p.segmentation === 'none') return [[0, v.duration]];
  if (p.segmentation === 'auto') return v.shots.map(s => [s[0], s[1]]);
  const L = Math.max(1, Number(p.segLen) || 30);
  const out = [];
  for (let t = 0; t < v.duration; t += L) out.push([t, Math.min(v.duration, t + L)]);
  return out;
}

function keyframesFor(seg, k) {
  const len = seg[1] - seg[0];
  return Array.from({ length: k }, (_, i) => round(seg[0] + ((i + 0.5) * len) / k, 1));
}

const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function run(p) {
  const v = VIDEOS[p.video] || VIDEOS.training;
  const steps = [];
  const k = Math.max(1, Math.round(p.keyframes));

  if (p.source === 'private') {
    steps.push(step('ingest', 'Cannot read the video (403)', 'The analyzer was given a blob URL it is not authorised to read: no SAS token and no role for the service identity on the storage account.', { httpStatus: 403, url: 'https://<account>.blob.core.windows.net/videos/clip.mp4' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Use a short-lived SAS URL, upload the bytes, or grant the service’s managed identity Storage Blob Data Reader on the container.' }], metrics: [], summary: 'Ingest failed: storage access' };
  }
  steps.push(step('ingest', 'Video ingested', `${v.label}. ${p.source === 'sas' ? 'Read from Blob Storage via SAS URL.' : 'Uploaded as binary.'}`, { durationSec: v.duration, audio: v.speech }));

  // Transcript
  let transcript = [];
  let tStatus = 'ok', tText;
  if (!p.transcript) { tStatus = v.speech ? 'warn' : 'skip'; tText = v.speech ? 'Transcription off: spoken information (instructions, chapter cues) is ignored.' : 'Transcription off (video has no speech anyway).'; }
  else if (!v.speech) { tStatus = 'info'; tText = 'No speech detected; transcript is empty. Visual cues only.'; }
  else if (p.locale === 'fr-FR') { tStatus = 'warn'; tText = 'Locale fr-FR set for English speech: the transcript is low quality, so speech cues are unreliable.'; transcript = v.transcript.map(([s, e]) => [s, e, '(low-confidence French transcription of English audio)']); }
  else { transcript = v.transcript; tText = `${transcript.length} transcript phrases, aligned to video time${p.locale === 'auto' ? ' (language auto-detected)' : ''}.`; }
  const speechUsable = transcript.length && p.locale !== 'fr-FR';
  steps.push(step('transcript', 'Speech transcription', tText, { phrases: transcript.slice(0, 4).map(([s, e, t]) => ({ start: s, end: e, text: t })) }, tStatus));

  // Segmentation
  const segs = segmentsFor(v, p);
  const longest = Math.max(...segs.map(s => s[1] - s[0]));
  const shortestEvent = Math.min(...v.events.map(e => e.end - e.start));
  const segWarn = p.segmentation === 'none' || (p.segmentation === 'fixed' && longest > 2 * shortestEvent);
  steps.push(step('segment', `${segs.length} segment(s)`, p.segmentation === 'auto' ? 'Boundaries follow shot/scene changes.' : p.segmentation === 'fixed' ? `Fixed ${p.segLen}s segments, regardless of content.` : 'Whole video treated as one segment.',
    { segments: segs.length, longestSec: longest, shortestEventSec: shortestEvent }, segWarn ? 'warn' : 'ok'));

  // Keyframes
  const kfs = segs.map(s => keyframesFor(s, k));
  steps.push(step('keyframes', `${k} keyframe(s) per segment`, `${kfs.flat().length} frames sent for visual analysis in total.`, { sample: kfs.slice(0, 3) }, 'ok'));

  // Per-segment description + event detection
  const detected = [];
  const rows = segs.map((seg, i) => {
    const shotsIn = v.shots.filter(s => ov(seg[0], seg[1], s[0], s[1]) > 0).sort((a, b) => ov(seg[0], seg[1], b[0], b[1]) - ov(seg[0], seg[1], a[0], a[1]));
    const desc = shotsIn.length > 2 ? `${shotsIn[0][2]}; also ${shotsIn.length - 1} other scenes (summary loses detail)` : shotsIn.map(s => s[2]).join('; then ');
    const evs = [];
    for (const e of v.events) {
      const o = ov(seg[0], seg[1], e.start, e.end);
      if (!o) continue;
      const share = o / (seg[1] - seg[0]);
      // Chapters are visible as a scene change at the segment start; short incidents need a keyframe inside them.
      const visualHit = e.cue !== 'speech' && (e.type === 'chapter' ? Math.abs(seg[0] - e.start) <= 3 || (share >= 0.25 && kfs[i].some(t => t >= e.start && t <= e.end)) : share >= 0.25 && kfs[i].some(t => t >= e.start && t <= e.end));
      const speechHit = (e.cue !== 'visual') && speechUsable && share >= 0.1 && transcript.some(([s, en]) => ov(s, en, e.start, e.end) > 0 && ov(s, en, seg[0], seg[1]) > 0);
      if ((visualHit || speechHit) && !detected.find(d => d.id === e.id)) { detected.push({ ...e, seg: i, via: visualHit && speechHit ? 'vision + speech' : visualHit ? 'vision' : 'speech' }); evs.push(e.label); }
    }
    return { seg, desc, evs, kf: kfs[i] };
  });
  const missed = v.events.filter(e => !detected.find(d => d.id === e.id));
  steps.push(step('describe', 'Segment descriptions generated', `${rows.length} segment summaries.${segWarn ? ' Long segments blend several scenes into one summary.' : ''}`, { segments: rows.slice(0, 6).map(r => ({ start: r.seg[0], end: r.seg[1], description: r.desc })) }, segWarn ? 'warn' : 'ok'));

  const structured = p.fields === 'events';
  steps.push(step('fields', structured ? 'Event fields extracted' : 'Only free-text summaries', structured
    ? `${detected.length}/${v.events.length} events detected${missed.length ? `; missed: ${missed.map(e => e.label).join(', ')}` : ''}.`
    : 'No EventType/EventTime fields: downstream code would have to parse prose to find incidents.',
    structured ? { events: detected.map(d => ({ EventType: d.type, Label: d.label, StartSec: d.start, Segment: d.seg, Evidence: d.via })) } : null,
    !structured || missed.length ? 'warn' : 'ok'));

  // Output
  const focus = detected[0] || v.events[0];
  const shapes = [...v.keyScene];
  if (detected.length && structured) for (const d of detected) if (v.boxes[d.id]) shapes.push({ kind: 'box', ...v.boxes[d.id], label: d.label, tone: 'ok' });
  for (const e of missed) if (v.boxes[e.id]) shapes.push({ kind: 'box', ...v.boxes[e.id], label: `missed: ${e.label}`, tone: 'error', dashed: true });

  const items = [
    ...v.shots.map(s => ({ label: s[2], start: s[0], end: s[1], lane: 'Shots (ground truth)', tone: 'muted' })),
    ...segs.map((s, i) => ({ label: `Seg ${i + 1}`, start: s[0], end: s[1], lane: 'Segments', tone: rows[i].evs.length ? 'ok' : 'info' })),
    ...kfs.flat().map(t => ({ label: 'kf', start: t, end: t + 0.8, lane: 'Keyframes' })),
    ...transcript.map(([s, e, t]) => ({ label: t.slice(0, 28), start: s, end: e, lane: 'Transcript', tone: p.locale === 'fr-FR' ? 'warn' : 'info' })),
    ...v.events.map(e => ({ label: e.label, start: e.start, end: e.end, lane: 'Events', tone: detected.find(d => d.id === e.id) ? 'ok' : 'error' })),
  ];

  const recall = v.events.length ? detected.length / v.events.length : 1;
  return {
    steps,
    output: [
      { type: 'timeline', title: `${v.label}: segments vs ground truth`, unit: 's', items },
      { type: 'image', title: `Keyframe around "${focus.label}" (synthetic)`, shapes },
      { type: 'table', title: 'Per-segment results', columns: ['Segment', 'Range (s)', 'Keyframes', 'Description', 'Events'],
        rows: rows.map((r, i) => [`${i + 1}`, `${r.seg[0]}–${r.seg[1]}`, r.kf.join(', '), r.desc, r.evs.join(', ') || '—']), tones: rows.map(r => r.evs.length ? 'ok' : undefined) },
      { type: 'json', title: 'Result shape (abridged, illustrative)', data: { contents: rows.slice(0, 2).map(r => ({ kind: 'audioVisual', startTimeMs: r.seg[0] * 1000, endTimeMs: r.seg[1] * 1000, fields: structured ? { Summary: { valueString: r.desc }, EventType: { valueString: r.evs.length ? 'event' : 'none' } } : { Summary: { valueString: r.desc } } })) } },
    ],
    metrics: [
      metric('Event recall', `${detected.length}/${v.events.length}`, 'computed', 'Against the synthetic ground-truth events.'),
      metric('Segments', String(segs.length), 'computed'),
      metric('Frames analysed', String(kfs.flat().length), 'computed'),
      metric('Relative processing', kfs.flat().length > 30 ? 'high' : kfs.flat().length > 12 ? 'medium' : 'low', 'estimate', 'Assumes cost and latency grow with frames analysed and transcribed minutes. See Content Understanding pricing.'),
    ],
    summary: `${p.video} • ${p.segmentation}${p.segmentation === 'fixed' ? ` ${p.segLen}s` : ''} • ${k} kf/seg • recall ${round(recall * 100, 0)}%`,
  };
}

export default {
  id: '3.2.6',
  lab: 'Video segment analyzer',
  services: [
    { name: 'Azure Content Understanding video solutions', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/video/overview' },
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/overview' },
    { name: 'Azure AI Speech (speech to text)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text' },
  ],
  prereqs: ['3.2.5'],
  next: ['3.2.7', '3.2.8'],

  concept: {
    plain: 'A video is too long to understand in one glance, so a video workflow cuts it into segments, looks at a few still frames (keyframes) from each segment, listens to the speech, and then describes each segment and pulls out the facts you need: what happened, when, and what was said. Segments that are too long blur short events together; skipping the audio loses anything that was only said out loud.',
    technical: 'Content Understanding video analyzers combine shot/scene detection, keyframe extraction, speech transcription with timestamps and generative field extraction per segment. The result is a list of time-ranged contents (startTimeMs/endTimeMs) each with fields such as a summary or a classified event type. Segmentation can follow content (auto) or be defined by you; when you build the pipeline yourself with a multimodal model you sample frames per chunk and pass the aligned transcript. Configure locale correctly for transcription and grant the service read access to the blob.',
    useCase: 'A retail chain reviews CCTV for slip hazards. Video from each store lands in Blob Storage; an analyzer returns per-segment summaries and a HazardType field with timestamps, so the safety team jumps straight to the 12 seconds where a bottle spilled instead of watching two hours of footage.',
    terms: [
      ['Segment', 'A time range of the video analysed as one unit; fields are produced per segment.'],
      ['Keyframe', 'A representative still frame sampled from a segment and sent for visual analysis.'],
      ['Transcript alignment', 'Speech-to-text phrases with timestamps, matched to the segment they fall in.'],
      ['Shot / scene detection', 'Finding boundaries where the visual content changes, used for content-aware segmentation.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'ingest', label: 'Video', col: 0, row: 1, kind: 'data', detail: 'MP4 or similar from storage or upload.' },
          { id: 'segment', label: `Segment (${p ? p.segmentation : 'auto'})`, col: 1, row: 0, detail: 'Cut into time ranges.', badge: p && p.segmentation === 'fixed' ? `${p.segLen}s` : undefined, substeps: ['Shot detection', 'Scene grouping', 'Segment boundaries'] },
          { id: 'keyframes', label: 'Keyframes', col: 2, row: 0, detail: 'Representative frames per segment.', badge: p ? `${p.keyframes}/seg` : undefined },
          { id: 'transcript', label: 'Transcript', col: 1, row: 2, kind: 'ai', detail: 'Speech-to-text with timestamps.', disabled: p && !p.transcript },
          { id: 'describe', label: 'Describe segment', col: 3, row: 1, kind: 'ai', detail: 'Multimodal model sees keyframes + aligned transcript.' },
          { id: 'fields', label: 'Per-segment fields', col: 4, row: 1, kind: 'data', detail: 'Summary, event type, time.' },
        ],
        edges: [['ingest', 'segment'], ['segment', 'keyframes'], ['ingest', 'transcript'], ['keyframes', 'describe'], ['transcript', 'describe', 'aligned'], ['describe', 'fields']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'ingest', label: 'Blob Storage (videos)', col: 0, row: 1, kind: 'store', detail: 'Service reads via SAS URL or managed identity with Storage Blob Data Reader.', badge: p && p.source === 'private' ? 'no access' : undefined },
          { id: 'segment', label: 'Content Understanding video analyzer', col: 1, row: 1, kind: 'ai', detail: 'Segmentation, keyframes and transcription are part of the analyzer.' },
          { id: 'keyframes', label: 'Keyframe images', col: 2, row: 0, kind: 'data', detail: 'Returned/referenced in results for review UIs.' },
          { id: 'transcript', label: `Transcription (${p ? p.locale : 'en-US'})`, col: 2, row: 2, kind: 'ai', detail: 'Locale must match the spoken language, or use auto-detection where supported.' },
          { id: 'describe', label: 'Chat model deployment', col: 3, row: 1, kind: 'ai', detail: 'Generates descriptions and fields.' },
          { id: 'fields', label: 'Results → Cosmos DB / Search', col: 4, row: 1, kind: 'store', detail: 'Index segments so users can search "spill" and jump to the timestamp.' },
        ],
        edges: [['ingest', 'segment', 'analyze'], ['segment', 'keyframes'], ['segment', 'transcript'], ['keyframes', 'describe'], ['transcript', 'describe'], ['describe', 'fields']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'ingest', label: 'body = {"url": sas_url}  # or binary upload', col: 0, row: 0, kind: 'code', detail: 'Illustrative request body.' },
          { id: 'segment', label: `config: segmentation = ${p ? JSON.stringify(p.segmentation) : '"auto"'}${p && p.segmentation === 'fixed' ? `, chunk = ${p.segLen}s` : ''}`, col: 0, row: 1, kind: 'code', detail: 'Exact property names vary by API version (e.g. segmentation mode / definition). Check the analyzer reference.' },
          { id: 'transcript', label: `config: locales = [${p ? JSON.stringify(p.locale) : '"en-US"'}]`, col: 0, row: 2, kind: 'code', detail: 'Transcription language(s); illustrative.' },
          { id: 'keyframes', label: 'frames = sample(segment, n)  # DIY path with a multimodal model', col: 0, row: 3, kind: 'code', detail: 'If you build it yourself: extract frames (e.g. ffmpeg) and send them as image parts with the transcript slice.' },
          { id: 'describe', label: 'poller = analyze(analyzer_id, body); result = poll(...)', col: 0, row: 4, kind: 'code', detail: 'Long-running operation.' },
          { id: 'fields', label: 'for c in result["contents"]: c["startTimeMs"], c["fields"]', col: 0, row: 5, kind: 'code', detail: 'One content entry per segment.' },
        ],
        edges: [['ingest', 'segment'], ['segment', 'transcript'], ['transcript', 'keyframes'], ['keyframes', 'describe'], ['describe', 'fields']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'video', label: 'Video', type: 'select', options: Object.entries(VIDEOS).map(([v, x]) => [v, x.label]), default: 'training' },
      { id: 'source', label: 'Input', type: 'select', options: [['sas', 'Blob URL with SAS'], ['upload', 'Binary upload'], ['private', 'Blob URL, no access']], default: 'sas' },
      { id: 'segmentation', label: 'Segmentation', type: 'select', options: [['auto', 'Auto (shot/scene based)'], ['fixed', 'Fixed length'], ['none', 'No segmentation (whole video)']], default: 'auto' },
      { id: 'segLen', label: 'Fixed segment length (s)', type: 'range', min: 5, max: 120, step: 5, default: 30 },
      { id: 'keyframes', label: 'Keyframes per segment', type: 'range', min: 1, max: 5, step: 1, default: 1 },
      { id: 'transcript', label: 'Transcribe speech', type: 'toggle', default: true },
      { id: 'locale', label: 'Transcription locale', type: 'select', options: [['en-US', 'en-US'], ['auto', 'Auto-detect'], ['fr-FR', 'fr-FR']], default: 'en-US' },
      { id: 'fields', label: 'Per-segment fields', type: 'select', options: [['summary', 'Summary only'], ['events', 'Summary + EventType + time']], default: 'events' },
    ],
    samples: [
      { label: 'How-to video, auto segments', values: { video: 'training' } },
      { label: 'CCTV, fixed 60 s chunks', values: { video: 'retail', segmentation: 'fixed', segLen: 60 } },
      { label: 'Webinar chapters, no transcript', values: { video: 'webinar', transcript: false } },
      { label: 'Webinar, whole video', values: { video: 'webinar', segmentation: 'none' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the CCTV video with fixed 60 s segments and then 10 s segments: compare event recall and frames analysed.',
      'Run the how-to video with transcription on and off: which event disappears?',
      'Run the webinar with auto segmentation and with no segmentation and compare the timeline.',
      'Keep CCTV at 20 s segments and raise keyframes from 1 to 2.',
    ],
  },

  debug: [
    { id: 'long', title: 'Spill never shows up in results', values: { video: 'retail', segmentation: 'fixed', segLen: 60, keyframes: 1 }, node: 'segment',
      symptom: 'Event recall is low; the spill segment is summarised as "queue at checkout".', cause: 'Segments are much longer than the event, and one keyframe per minute lands outside the 12-second spill (wrong configuration).', fix: 'Use auto segmentation, or shorter segments (≤ 20 s) and more keyframes.' },
    { id: 'noaudio', title: 'Safety instruction missing from training index', values: { video: 'training', transcript: false }, node: 'transcript',
      symptom: 'The goggles instruction is not detected.', cause: 'It is only spoken; transcription is off (missing input modality).', fix: 'Turn speech transcription on.' },
    { id: 'locale', title: 'Transcript is gibberish', values: { video: 'webinar', locale: 'fr-FR' }, node: 'transcript',
      symptom: 'Transcript phrases are low quality; the Q&A chapter is missed.', cause: 'Transcription locale does not match the spoken language.', fix: 'Set the locale to en-US or use auto-detection.' },
    { id: 'access', title: 'Analyze fails immediately', values: { source: 'private' }, node: 'ingest',
      symptom: '403 when the service tries to read the video.', cause: 'Blob URL without SAS and no role for the service identity (permission problem).', fix: 'Pass a SAS URL or upload the bytes; or grant Storage Blob Data Reader.' },
    { id: 'prose', title: 'Incidents only buried in prose', values: { video: 'retail', fields: 'summary' }, node: 'fields',
      symptom: 'No EventType or time fields; alerts cannot be automated.', cause: 'Field schema only asks for a summary.', fix: 'Add structured per-segment fields (EventType + time).' },
  ],

  challenge: {
    task: 'Using fixed-length segmentation on the CCTV video (as when you chunk video yourself), detect both events while sending at most 16 frames in total.',
    condition: 'Video = CCTV, segmentation = fixed, event recall 2/2, frames analysed ≤ 16, no warn/error on the fields step.',
    hint: 'Frames analysed = number of segments × keyframes per segment. Short events need a keyframe inside them.',
    check: (p, res) => p.video === 'retail' && p.segmentation === 'fixed' && res.metrics.some(m => m.label === 'Event recall' && m.value === '2/2') && Number((res.metrics.find(m => m.label === 'Frames analysed') || {}).value) <= 16 && res.steps.find(s => s.node === 'fields')?.status === 'ok',
    solution: ['Select the CCTV video and fixed segmentation.', 'Try 10 s segments with 1 keyframe (12 frames), or 20 s with 2 keyframes (12 frames).', 'Keep per-segment fields = Summary + EventType + time.'],
    solutionValues: { video: 'retail', segmentation: 'fixed', segLen: 10, keyframes: 1, fields: 'events', source: 'sas' },
  },

  quiz: [
    { q: 'A 2-hour CCTV feed is chunked into 5-minute segments with one keyframe each. Short incidents are missed. What is the most effective change?', options: ['Use a bigger chat model', 'Shorter or content-aware segments and more frames per segment', 'Turn on transcription', 'Lower the output token limit'], answer: 1, why: 'Short events need a segment and a keyframe that actually cover them. CCTV usually has no speech.' },
    { q: 'Training videos give spoken safety instructions that are not visible on screen. Which configuration is required to capture them per segment?', options: ['More keyframes', 'Speech transcription with the correct locale, aligned to segment times', 'Object detection', 'A higher confidence threshold'], answer: 1, why: 'Spoken-only content exists only in the audio track.' },
    { q: 'The analyzer returns 403 when given a blob URL. The blob is in a private container. What is a valid fix?', options: ['Make the container public', 'Provide a short-lived SAS URL or grant the service identity Storage Blob Data Reader', 'Retry with exponential backoff', 'Lower the segment length'], answer: 1, why: 'The service needs authorised read access; public containers are an unnecessary risk.' },
  ],

  recap: 'Video understanding is segmentation + keyframes + aligned transcript + per-segment fields. Match segment length to the shortest event you care about, sample enough frames, transcribe in the right locale, ask for structured time-stamped fields, and make sure the service can read the video.',
};
