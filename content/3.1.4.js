// 3.1.4 Implement workflows to edit generated videos
// Lab: Generated video edit bay.
import { rng, round, step, metric, words } from '../src/engine/util.js';

// Clip A is the generated video being edited. B/C/D are candidates to append.
const CLIPS = {
  A: { label: 'gen_boat — generated, 8 s, 1280x720 @30 fps', dur: 8, res: '1280x720', fps: 30, generated: true },
  B: { label: 'gen_harbour — generated, 6 s, 1280x720 @30 fps', dur: 6, res: '1280x720', fps: 30, generated: true },
  C: { label: 'gen_harbour_cine — generated, 6 s, 1280x720 @24 fps', dur: 6, res: '1280x720', fps: 24, generated: true },
  D: { label: 'stock_vertical — uploaded, 6 s, 720x1280 @30 fps', dur: 6, res: '720x1280', fps: 30, generated: false },
};
const SEGMENTS = { none: null, s1: [2, 4], s2: [5, 7], s3: [6, 9] };
const BLOCKED = ['gore', 'blood', 'weapon', 'nude', 'violent', 'celebrity'];

function frame(prompt, t, tone) {
  const ws = words(prompt);
  const snow = ws.includes('snow') || ws.includes('winter'), night = ws.includes('night'), sunset = ws.includes('sunset');
  const sky = night ? '#1d2340' : sunset ? '#f4a261' : snow ? '#cfd8dc' : '#90a4ae';
  const ground = snow ? '#fafafa' : '#455a64';
  const x = 15 + t * 60;
  const s = [{ kind: 'rect', x: 0, y: 0, w: 100, h: 56, fill: sky }, { kind: 'rect', x: 0, y: 38, w: 100, h: 18, fill: ground }];
  for (let i = 0; i < 4; i++) s.push({ kind: 'rect', x: 5 + i * 25, y: 22 - (i % 2) * 5, w: 10, h: 16 + (i % 2) * 5, fill: night ? '#37474f' : '#607d8b' });
  s.push({ kind: 'rect', x: x - 5, y: 40, w: 10, h: 3, fill: '#f5f5f5' }, { kind: 'rect', x: x - 1, y: 33, w: 4, h: 7, fill: '#fafafa' });
  if (tone) s.push({ kind: 'box', x: 1, y: 1, w: 98, h: 54, label: tone, tone: 'info', dashed: true });
  return s;
}

function run(p) {
  const steps = [];
  const A = CLIPS.A;
  const ts = Number(p.trimStart), te = Number(p.trimEnd);
  const seg = SEGMENTS[p.replace];
  const remixPrompt = String(p.remixPrompt || '');
  const extendS = Number(p.extend);
  const B = p.concat !== 'none' ? CLIPS[p.concat] : null;
  const fail = (node, title, detail, data, summary) => { steps.push(step(node, title, detail, data, 'error')); return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, beforeTimeline()], metrics: [metric('Final duration', '—', 'computed')], summary }; };
  const beforeTimeline = () => ({ type: 'timeline', title: 'Source clip A (before)', unit: 's', items: [{ label: 'gen_boat (generated)', start: 0, end: A.dur, lane: 'video', tone: 'ok' }, { label: 'trim window', start: Math.min(ts, A.dur), end: Math.min(te, A.dur), lane: 'edit', tone: te > A.dur || ts >= te ? 'error' : 'info' }] });

  // 1. Load source
  steps.push(step('source', 'Source loaded from storage', `${A.label}. Generated ${p.sourceAge} h ago; MP4 already copied to Blob Storage.`, { clip: 'A', ...A, sourceAgeHours: p.sourceAge }));

  // 2. Trim (deterministic, local tooling)
  if (ts >= te) return fail('trim', 'Invalid trim range', `Start ${ts}s must be before end ${te}s.`, { trimStart: ts, trimEnd: te }, 'Rejected: empty trim range');
  if (te > A.dur) return fail('trim', 'Trim beyond clip duration', `End ${te}s is past the clip length (${A.dur}s). Tools may silently clamp, which breaks every later timing (segments, captions).`, { trimEnd: te, duration: A.dur }, 'Rejected: trim beyond duration');
  const cut = round(te - ts, 1);
  steps.push(step('trim', `Trimmed to ${ts}–${te}s (${cut}s)`, 'Deterministic edit in your own tooling (for example ffmpeg in a Container Apps job); no model call, no cost per second generated.', { op: 'trim', in: ts, out: te }));

  // 3. Replace a segment via model remix
  let genSeconds = 0;
  const timeline = [];
  if (seg) {
    if (!remixPrompt.trim()) return fail('remix', 'Remix prompt missing', 'Replacing a segment needs a prompt describing the new content.', { segment: seg }, 'Rejected: no remix prompt');
    if (seg[1] > cut) return fail('remix', 'Segment outside the trimmed clip', `Segment ${seg[0]}–${seg[1]}s (relative to the trimmed clip) ends after its ${cut}s length. Re-plan segment times after trimming.`, { segment: seg, trimmedDuration: cut }, 'Rejected: segment beyond trimmed duration');
    const blocked = words(remixPrompt).filter(w => BLOCKED.includes(w));
    if (blocked.length) return fail('remix', 'HTTP 400 remix prompt filtered', `Content filtering blocked the remix prompt (${blocked.join(', ')}).`, { filtered: true }, 'Remix blocked by content filter');
    if (p.remixMethod === 'byid' && p.sourceAge >= 24) return fail('remix', 'HTTP 404 source generation not found', `Remix-by-id needs the generation to still exist on the service; it was created ${p.sourceAge} h ago and service retention is limited (24 h at the time of writing — check the docs). Your stored MP4 is fine, but the service no longer has it.`, { method: 'remix by generation id', sourceAgeHours: p.sourceAge }, 'Remix failed: source generation expired');
    genSeconds += seg[1] - seg[0];
    steps.push(step('remix', `Segment ${seg[0]}–${seg[1]}s regenerated`, p.remixMethod === 'byid'
      ? `Remix of the existing generation with prompt "${remixPrompt}". The model keeps motion/composition and changes what the prompt asks (model/API dependent; check whether your model supports remix).`
      : `New generation conditioned on the stored frame at ${seg[0]}s (image reference) with prompt "${remixPrompt}"; spliced back in your tooling. Works even after service retention expires.`,
      { op: 'replace', segment: seg, method: p.remixMethod, prompt: remixPrompt }, 'ok'));
  } else steps.push(step('remix', 'No segment replaced', 'Skipping model-side edits keeps cost and latency low.', null, 'skip'));

  // 4. Extend
  if (extendS > 0) {
    genSeconds += extendS;
    steps.push(step('extend', `Extended by ${extendS}s`, 'Continuation generated from the last frame of the cut (used as an image reference) plus a continuation prompt, then appended. Check the seam for jumps in lighting or motion.', { op: 'extend', seconds: extendS, reference: 'last_frame.png' }, 'ok'));
  } else steps.push(step('extend', 'No extension', null, null, 'skip'));

  // Build the edited A timeline
  let t = 0;
  const push = (label, d, tone) => { if (d > 0) { timeline.push({ label, start: round(t, 1), end: round(t + d, 1), lane: 'video', tone }); t += d; } };
  if (seg) { push('A (orig)', seg[0], 'ok'); push('A remixed', seg[1] - seg[0], 'info'); push('A (orig)', cut - seg[1], 'ok'); } else push('A trimmed', cut, 'ok');
  push('extension', extendS, 'warn');

  // 5. Concatenate
  let reencode = false;
  if (B) {
    const resMismatch = B.res !== A.res, fpsMismatch = B.fps !== A.fps;
    if (resMismatch && !p.normalize) return fail('concat', 'Concatenation failed: resolution mismatch', `Clip A is ${A.res}, ${p.concat} is ${B.res}. Stream-copy concatenation requires identical resolution and codec parameters.`, { a: A.res, b: B.res, normalize: false }, 'Concat failed (resolution mismatch)');
    if (fpsMismatch && !p.normalize) steps.push(step('concat', 'Frame-rate mismatch', `A is ${A.fps} fps, ${p.concat} is ${B.fps} fps. Without re-encoding to a common rate the joined file stutters or drifts out of audio sync.`, { a: A.fps, b: B.fps }, 'warn'));
    else {
      reencode = resMismatch || fpsMismatch;
      steps.push(step('concat', `Appended ${p.concat}`, reencode ? `Re-encoded ${p.concat} to ${A.res} @ ${A.fps} fps${resMismatch ? ' (letterboxed/cropped: vertical into landscape)' : ''} before joining.` : 'Same resolution, frame rate and codec: joined without re-encoding.', { normalize: p.normalize, target: `${A.res}@${A.fps}` }, resMismatch ? 'info' : 'ok'));
    }
    push(B.generated ? `${p.concat} (generated)` : `${p.concat} (uploaded)`, B.dur, 'muted');
  } else steps.push(step('concat', 'No concatenation', null, null, 'skip'));
  const total = round(t, 1);

  // 6. Captions
  const cap = String(p.captionText || '');
  const capDur = Math.min(3, total);
  const cps = p.captions && cap ? round(cap.length / capDur, 1) : 0;
  if (p.captions && cap) steps.push(step('captions', cps > 17 ? 'Caption too fast to read' : 'Captions burned in / sidecar WebVTT', cps > 17 ? `${cap.length} characters in ${capDur}s = ${cps} chars/s. Common subtitle guidance is roughly 15–17 chars/s; split it or show it longer.` : `${cps} chars/s over ${capDur}s. Prefer a WebVTT sidecar for accessibility and translation.`, { text: cap, start: 0, end: capDur, cps }, cps > 17 ? 'warn' : 'ok'));
  else steps.push(step('captions', 'No captions', 'Consider captions for accessibility (sound-off playback).', null, 'skip'));

  // 7. Render
  steps.push(step('render', 'Rendered final MP4', `${total}s, ${A.res} @ ${A.fps} fps, H.264. Edit decision list saved next to the file so the cut is reproducible.`, { duration: total, reencoded: reencode || !!seg || extendS > 0 }));

  const r = rng(`${remixPrompt}|${p.replace}`);
  const edl = [['trim', 'A', `${ts}–${te}s`, 'local tool']];
  if (seg) edl.push(['replace', 'A', `${seg[0]}–${seg[1]}s`, p.remixMethod === 'byid' ? 'model: remix by id' : 'model: image-ref regenerate']);
  if (extendS) edl.push(['extend', 'A', `+${extendS}s`, 'model: last-frame continuation']);
  if (B) edl.push(['concat', p.concat, `${B.dur}s`, reencode ? 'local tool: re-encode + join' : 'local tool: join']);
  if (p.captions && cap) edl.push(['caption', '—', `0–${capDur}s`, 'WebVTT']);
  const segMid = seg ? (seg[0] + seg[1]) / 2 / cut : 0.5;
  return {
    steps,
    output: [
      beforeTimeline(),
      { type: 'timeline', title: 'Edited cut (after)', unit: 's', items: [...timeline, ...(p.captions && cap ? [{ label: cap.slice(0, 30), start: 0, end: capDur, lane: 'captions', tone: cps > 17 ? 'warn' : 'ok' }] : [])] },
      { type: 'image', title: `Frame @ ${seg ? round((seg[0] + seg[1]) / 2, 1) : round(cut / 2, 1)}s — before`, width: 100, height: 56, shapes: frame('', segMid, null) },
      { type: 'image', title: seg ? `Same frame after remix: "${remixPrompt.slice(0, 40)}"` : 'Same frame after (unchanged)', width: 100, height: 56, shapes: frame(seg ? remixPrompt : '', segMid + (seg ? (r() - 0.5) * 0.05 : 0), seg ? 'remixed' : null) },
      { type: 'table', title: 'Edit decision list', columns: ['Operation', 'Clip', 'Range', 'Done by'], rows: edl },
      { type: 'code', lang: 'bash', title: 'Local steps (illustrative ffmpeg)', text: [`ffmpeg -ss ${ts} -to ${te} -i gen_boat.mp4 -c copy a_trim.mp4`, B && reencode ? `ffmpeg -i ${p.concat}.mp4 -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30" ${p.concat}_norm.mp4` : null, B ? `ffmpeg -f concat -safe 0 -i list.txt ${reencode ? '-c:v libx264' : '-c copy'} final.mp4` : null, p.captions && cap ? 'ffmpeg -i final.mp4 -vf subtitles=captions.vtt final_captioned.mp4' : null].filter(Boolean).join('\n') },
    ],
    metrics: [
      metric('Final duration', `${total}s`, 'computed'),
      metric('Model-generated seconds', `${genSeconds}s`, 'computed', 'Only remix/extend call the model; trim, concat and captions are local.'),
      metric('Re-encode required', reencode ? 'yes' : 'no', 'computed'),
      metric('Relative cost', genSeconds ? `~${genSeconds}× a 1 s generation` : 'local compute only', 'estimate', 'Assumes generation cost scales with generated seconds at the same resolution; check pricing.'),
    ],
    summary: `${total}s cut • ${edl.map(e => e[0]).join('+')} • ${genSeconds}s generated${steps.some(s => s.status === 'warn') ? ' • warnings' : ''}`,
  };
}

export default {
  id: '3.1.4',
  lab: 'Generated video edit bay',
  services: [
    { name: 'Video generation in Azure OpenAI (concepts)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/video-generation' },
    { name: 'Azure Container Apps jobs', url: 'https://learn.microsoft.com/en-us/azure/container-apps/jobs' },
  ],
  prereqs: ['3.1.2'],
  next: ['3.1.5'],

  concept: {
    plain: 'A generated video is rarely perfect first time. Some fixes are simple cutting-room work — trim the start, glue two clips together, add captions — and you do those yourself without the AI. Other fixes need the model again: redo one bad moment in a new style, or make the clip longer. Mixing the two well keeps costs down and keeps the final video consistent.',
    technical: 'An edit workflow separates deterministic operations (trim, concatenate, normalise resolution/frame rate, burn or attach WebVTT captions) done with tooling such as ffmpeg in Container Apps jobs or Functions, from model-side operations: remixing an existing generation by id (where the model/API supports it), regenerating a segment conditioned on a stored frame (image reference), or extending from the last frame. Remix-by-id depends on the service still holding the generation (limited retention), while reference-based regeneration only needs your stored MP4. Joining clips requires matching resolution, frame rate and codec, otherwise re-encode. Keep an edit decision list for reproducibility.',
    useCase: 'A social team generates an 8-second clip, trims the first second, asks the model to redo seconds 2–4 "with snow falling", appends a 24 fps harbour clip after normalising it to 30 fps, and adds WebVTT captions before publishing. The pipeline runs as a Container Apps job triggered by Blob events.',
    terms: [
      ['Remix', 'Model-side edit of an existing generation guided by a new prompt (availability depends on model/API).'],
      ['Extend', 'Generate a continuation from the last frame and append it.'],
      ['Normalise', 'Re-encode clips to a common resolution, frame rate and codec before joining.'],
      ['EDL', 'Edit decision list: the ordered operations and ranges that produce the final cut.'],
      ['WebVTT', 'Sidecar caption format for web video players.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'source', label: 'Generated clip A', col: 0, row: 1, kind: 'data', detail: '8 s, 1280x720 @30 fps, stored MP4.' },
          { id: 'trim', label: 'Trim', col: 1, row: 0, kind: 'compute', detail: 'Local, deterministic.', badge: p ? `${p.trimStart}–${p.trimEnd}s` : undefined },
          { id: 'remix', label: 'Replace segment (model)', col: 1, row: 2, kind: 'ai', disabled: p && p.replace === 'none', detail: 'Remix by id or regenerate from a frame reference.' },
          { id: 'extend', label: 'Extend (model)', col: 2, row: 2, kind: 'ai', disabled: p && Number(p.extend) === 0, detail: 'Continuation from last frame.' },
          { id: 'concat', label: 'Concatenate', col: 2, row: 0, kind: 'compute', disabled: p && p.concat === 'none', detail: 'Needs matching resolution/fps/codec or re-encode.' },
          { id: 'captions', label: 'Captions', col: 3, row: 1, kind: 'compute', disabled: p && !p.captions, detail: 'WebVTT sidecar or burned-in.' },
          { id: 'render', label: 'Final render', col: 4, row: 1, kind: 'data', detail: 'MP4 + EDL.' },
        ],
        edges: [['source', 'trim'], ['trim', 'remix'], ['remix', 'extend'], ['trim', 'concat'], ['extend', 'concat'], ['concat', 'captions'], ['captions', 'render']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'source', label: 'Blob: generated-video', col: 0, row: 1, kind: 'store', detail: 'Stored MP4s (your copy, independent of service retention).' },
          { id: 'trim', label: 'Container Apps job (ffmpeg)', col: 1, row: 0, kind: 'compute', detail: 'Trim, normalise, concat, captions.' },
          { id: 'concat', label: 'Same job: join + re-encode', col: 2, row: 0, kind: 'compute', detail: 'Normalises fps/resolution when needed.', badge: p && p.normalize ? 'normalize' : undefined },
          { id: 'remix', label: 'Foundry video deployment (remix / generate)', col: 1, row: 2, kind: 'ai', detail: 'Managed identity with Cognitive Services OpenAI User.' },
          { id: 'extend', label: 'Foundry video deployment (continuation)', col: 2, row: 2, kind: 'ai', detail: 'Image-referenced generation.' },
          { id: 'captions', label: 'Captions (WebVTT in Blob)', col: 3, row: 1, kind: 'store', detail: 'Could come from Speech-to-text or the script.' },
          { id: 'render', label: 'Blob: published + EDL', col: 4, row: 1, kind: 'store', detail: 'Final output and manifest.' },
        ],
        edges: [['source', 'trim'], ['trim', 'remix', 'segment'], ['remix', 'extend'], ['trim', 'concat'], ['extend', 'concat'], ['concat', 'captions'], ['captions', 'render']],
      }),
      implementation: () => ({
        nodes: [
          { id: 'source', label: 'download("gen_boat.mp4")', col: 0, row: 0, kind: 'code', detail: 'From your Blob container.' },
          { id: 'trim', label: 'ffmpeg -ss IN -to OUT -c copy', col: 0, row: 1, kind: 'code', detail: 'Validate IN < OUT ≤ duration first.' },
          { id: 'remix', label: 'remix(video_id, prompt) or create(prompt, input_reference=frame)', col: 0, row: 2, kind: 'code', detail: 'Illustrative; check which edit operations your model/API version supports.' },
          { id: 'extend', label: 'create(prompt="continue…", input_reference=last_frame)', col: 0, row: 3, kind: 'code', detail: 'Async job → poll → download (see 3.1.2).' },
          { id: 'concat', label: 'ffmpeg -vf scale,fps → concat', col: 0, row: 4, kind: 'code', detail: 'Normalise before joining.' },
          { id: 'captions', label: 'write captions.vtt; ffmpeg -vf subtitles', col: 0, row: 5, kind: 'code', detail: 'Or attach as sidecar.' },
          { id: 'render', label: 'upload(final.mp4, edl.json)', col: 0, row: 6, kind: 'code', detail: 'Reproducible output.' },
        ],
        edges: [['source', 'trim'], ['trim', 'remix'], ['remix', 'extend'], ['extend', 'concat'], ['concat', 'captions'], ['captions', 'render']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'trimStart', label: 'Trim start (s)', type: 'range', min: 0, max: 12, step: 0.5, default: 1 },
      { id: 'trimEnd', label: 'Trim end (s)', type: 'range', min: 0, max: 12, step: 0.5, default: 8 },
      { id: 'replace', label: 'Replace segment (relative to trimmed clip)', type: 'select', options: [['none', 'None'], ['s1', '2–4 s'], ['s2', '5–7 s'], ['s3', '6–9 s']], default: 'none' },
      { id: 'remixPrompt', label: 'Remix prompt', type: 'text', default: 'same scene with snow falling' },
      { id: 'remixMethod', label: 'Model edit method', type: 'select', options: [['byid', 'Remix existing generation by id'], ['ref', 'Regenerate from stored frame (image reference)']], default: 'byid' },
      { id: 'extend', label: 'Extend (s)', type: 'select', options: [['0', 'No'], ['4', '+4 s'], ['8', '+8 s']], default: '0' },
      { id: 'concat', label: 'Append clip', type: 'select', options: [['none', 'None'], ...['B', 'C', 'D'].map(k => [k, CLIPS[k].label])], default: 'none' },
      { id: 'normalize', label: 'Normalise resolution/fps before joining', type: 'toggle', default: false },
      { id: 'captions', label: 'Captions', type: 'toggle', default: true },
      { id: 'captionText', label: 'Caption text (first 3 s)', type: 'text', default: 'A paper boat in the rain' },
      { id: 'sourceAge', label: 'Hours since clip A was generated', type: 'range', min: 0, max: 48, step: 1, default: 2 },
    ],
    samples: [
      { label: 'Trim + caption only', values: {} },
      { label: 'Snow remix of 2–4 s', values: { replace: 's1' } },
      { label: 'Extend and append harbour clip', values: { extend: '4', concat: 'B' } },
      { label: 'Join a 24 fps clip with normalisation', values: { concat: 'C', normalize: true } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Compare remix by id vs regenerate from stored frame with "Hours since generated" at 30: only one survives retention.',
      'Append clip C with and without normalisation and compare steps and the re-encode metric.',
      'Compare model-generated seconds for "trim only" vs "remix + extend 8 s".',
    ],
  },

  debug: [
    { id: 'trim', title: 'Trim end past the clip', values: { trimEnd: 10 }, node: 'trim',
      symptom: 'Validation error: trim beyond clip duration.', cause: 'Invalid input: out point larger than the 8 s clip.', fix: 'Set trim end ≤ 8 s.' },
    { id: 'segment', title: 'Segment no longer exists after trimming', values: { trimStart: 2, trimEnd: 8, replace: 's3' }, node: 'remix',
      symptom: 'Segment 6–9 s rejected.', cause: 'Segment times are relative to the trimmed clip (6 s long).', fix: 'Pick 2–4 s (or 5–7 s with a longer cut).' },
    { id: 'expired', title: 'Remix 404 the next day', values: { replace: 's1', sourceAge: 30 }, node: 'remix',
      symptom: 'HTTP 404 for the source generation.', cause: 'Remix-by-id needs the service-side generation, which has expired.', fix: 'Use "Regenerate from stored frame" (your copy) or remix within the retention window.' },
    { id: 'res', title: 'Concat fails with vertical stock clip', values: { concat: 'D', normalize: false }, node: 'concat',
      symptom: 'Concatenation failed: resolution mismatch.', cause: 'Wrong configuration: 720x1280 cannot be stream-joined to 1280x720.', fix: 'Enable normalisation (scale/pad and fps) before joining.' },
    { id: 'fps', title: 'Stutter after joining', values: { concat: 'C', normalize: false }, node: 'concat',
      symptom: 'Frame-rate mismatch warning; playback stutters.', cause: '30 fps and 24 fps clips joined without re-encoding.', fix: 'Enable normalisation to a common frame rate.' },
    { id: 'caption', title: 'Unreadable caption', values: { captionText: 'A small paper boat drifts down a flooded city street in heavy evening rain' }, node: 'captions',
      symptom: 'Reading-speed warning.', cause: 'Too many characters for a 3 s caption.', fix: 'Shorten the caption (for example "A paper boat in the rain").' },
    { id: 'filter', title: 'Remix prompt blocked', values: { replace: 's1', remixPrompt: 'same scene with blood on the street' }, node: 'remix',
      symptom: 'HTTP 400 content filtered.', cause: 'Remix prompts pass through content filtering like any generation.', fix: 'Use an allowed prompt such as "same scene with snow falling".' },
  ],

  challenge: {
    task: 'Produce a final cut of at least 12 s: trimmed clip A with seconds 2–4 remixed to snow, followed by the 24 fps harbour clip C, with readable captions and no warnings — even though clip A was generated 30 hours ago.',
    condition: 'Segment replaced, clip C appended, source age ≥ 24 h, final duration ≥ 12 s, no warn/error step.',
    hint: 'One remix method depends on service retention; the joined clip needs a common frame rate.',
    check: (p, res) => p.replace !== 'none' && p.concat === 'C' && p.sourceAge >= 24 && res.steps.some(s => s.node === 'render' && s.data && s.data.duration >= 12) && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Trim 1–8 s (7 s), replace 2–4 s with prompt "same scene with snow falling".', 'Remix method: Regenerate from stored frame (works after retention expiry).', 'Append clip C and enable normalisation.', 'Keep the caption short.'],
    solutionValues: { trimStart: 1, trimEnd: 8, replace: 's1', remixPrompt: 'same scene with snow falling', remixMethod: 'ref', extend: '0', concat: 'C', normalize: true, captions: true, captionText: 'A paper boat in the rain', sourceAge: 30 },
  },

  quiz: [
    { q: 'You must cut the first second of a generated clip and append an outro. Which approach is most cost-effective?', options: ['Regenerate the whole clip with a new prompt', 'Trim and concatenate with local tooling (for example ffmpeg); no model call', 'Remix the clip by id twice', 'Extend the clip by 8 s'], answer: 1, why: 'Deterministic edits need no generation; only use the model for content changes.' },
    { q: 'Joining a 24 fps generated clip to a 30 fps one causes stutter. Fix?', options: ['Increase bitrate', 'Re-encode both to a common frame rate (and resolution) before concatenating', 'Use stream copy', 'Add captions'], answer: 1, why: 'Concatenation needs matching stream parameters; normalise first.' },
    { q: 'A remix-by-id call returns 404 for a generation created two days ago, but the MP4 is in your Blob storage. What do you do?', options: ['Retry with backoff', 'Regenerate the segment using a frame from your stored MP4 as an image reference', 'Grant Storage Blob Data Reader', 'Switch to an image model'], answer: 1, why: 'Service-side retention expired; reference-based regeneration only needs your own copy.' },
  ],

  recap: 'Split video edits into local deterministic steps (trim, normalise, concatenate, caption) and model steps (remix, regenerate from a frame reference, extend). Validate ranges against the trimmed timeline, normalise fps/resolution before joining, remember remix-by-id depends on service retention, and keep an EDL.',
};
