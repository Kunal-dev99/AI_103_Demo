// 3.1.2 Implement a solution that generates videos from text prompts and reference media
// Lab: Video generation job studio.
import { rng, clamp, round, step, metric, estTokens, words } from '../src/engine/util.js';

// Model capability table used by this simulation. Values mirror the shape of the public docs at the time
// of writing (Sora preview job API vs the newer videos API) but are illustrative: always check the docs.
const MODELS = {
  sora: {
    label: 'Sora (preview jobs API)', video: true, api: 'jobs',
    resolutions: ['480x480', '854x480', '480x854', '720x720', '1280x720', '720x1280', '1080x1080', '1920x1080', '1080x1920'],
    seconds: s => s >= 1 && s <= 20, secondsText: '1–20 s', maxVariants: res => (Number(res.split('x')[0]) * Number(res.split('x')[1]) >= 1080 * 1080 ? 1 : 4),
    refImage: true, refVideo: true, audio: false,
  },
  'sora-2': {
    label: 'Sora 2 (videos API)', video: true, api: 'videos',
    resolutions: ['1280x720', '720x1280'], seconds: s => [4, 8, 12].includes(s), secondsText: '4, 8 or 12 s', maxVariants: () => 1,
    refImage: true, refVideo: false, audio: true,
  },
  'gpt-image-1': { label: 'gpt-image-1 (image model)', video: false, api: 'images', resolutions: [], seconds: () => false, secondsText: '—', maxVariants: () => 0, refImage: false, refVideo: false, audio: false },
};
const REFS = {
  none: { label: 'None (text only)' },
  image: { label: 'Image: product still (first frame)' },
  video: { label: 'Video: 3 s dolly-in camera reference' },
};
const BLOCKED_IN = ['gore', 'blood', 'nude', 'weapon', 'bomb', 'celebrity', 'violent'];
const BLOCKED_OUT = ['explosion', 'crash', 'fire'];
const SUBJ = { boat: '#f5f5f5', car: '#1565c0', bird: '#37474f', person: '#3f51b5', dog: '#a0703c', ball: '#e53935', train: '#c62828', bottle: '#0f8b8d', kite: '#fb8c00' };

function planShots(prompt) {
  const parts = String(prompt).split(/\bthen\b|\.\s+|;/i).map(s => s.trim()).filter(s => words(s).length > 1);
  return parts.length ? parts : [String(prompt).trim() || '(empty)'];
}
function camera(text) {
  const t = ' ' + words(text).join(' ') + ' ';
  if (/ follows? | tracking /.test(t)) return 'tracking';
  if (/ zoom| push in| dolly/.test(t)) return 'dolly-in';
  if (/ pan /.test(t)) return 'pan';
  if (/ aerial | drone /.test(t)) return 'aerial';
  return 'static';
}
function setting(text) {
  const ws = words(text);
  if (ws.some(w => ['rain', 'rainy', 'street', 'city'].includes(w))) return { sky: '#90a4ae', ground: '#455a64', rain: true };
  if (ws.some(w => ['beach', 'sea', 'ocean'].includes(w))) return { sky: '#81d4fa', ground: '#e9d8a6', water: true };
  if (ws.some(w => ['night', 'midnight'].includes(w))) return { sky: '#1d2340', ground: '#263238' };
  return { sky: '#a8d8f0', ground: '#7cb26a' };
}

// One keyframe: subject position moves with time t (0..1) according to the shot's camera move.
function keyframe(prompt, cam, t, W, H, ref, seed) {
  const r = rng(seed);
  const st = setting(prompt);
  const subj = words(prompt).find(w => SUBJ[w]) || (ref === 'image' ? 'bottle' : null);
  const gy = H * 0.72;
  const shapes = [{ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: st.sky }, { kind: 'rect', x: 0, y: gy, w: W, h: H - gy, fill: st.ground }];
  if (st.water) shapes.push({ kind: 'rect', x: 0, y: gy - 5, w: W, h: 5, fill: '#4fa3d1' });
  // background markers move opposite to camera when tracking / panning (parallax)
  const bgShift = cam === 'tracking' || cam === 'pan' ? -t * W * 0.5 : 0;
  for (let i = 0; i < 5; i++) {
    const bx = ((i * W) / 4 + bgShift + W * 2) % (W * 1.25) - 5;
    shapes.push({ kind: 'rect', x: bx, y: gy - 14 - (i % 2) * 6, w: 7, h: 14 + (i % 2) * 6, fill: st.rain ? '#607d8b' : '#558b2f' });
  }
  if (st.rain) for (let i = 0; i < 8; i++) { const x = r() * W, y = r() * gy; shapes.push({ kind: 'line', x, y, x2: x - 1.5, y2: y + 4, fill: '#cfd8dc' }); }
  if (subj) {
    const scale = cam === 'dolly-in' ? 1 + t * 1.2 : cam === 'aerial' ? 0.6 : 1;
    const x = cam === 'tracking' ? W * 0.5 : cam === 'static' || cam === 'dolly-in' ? W * (0.25 + t * 0.5) : W * (0.3 + t * 0.2);
    const s = 4 * scale;
    const fill = ref === 'image' && subj === 'bottle' ? '#0f8b8d' : SUBJ[subj];
    if (subj === 'boat') shapes.push({ kind: 'rect', x: x - s * 1.5, y: gy - s * 0.6, w: s * 3, h: s * 0.6, fill }, { kind: 'rect', x: x - s * 0.2, y: gy - s * 2.4, w: s * 1.2, h: s * 1.8, fill: '#fafafa' });
    else if (subj === 'bottle') shapes.push({ kind: 'rect', x: x - s * 0.6, y: gy - s * 2.6, w: s * 1.2, h: s * 2.6, fill }, { kind: 'text', x: x - s * 0.6, y: gy - s * 1.2, text: 'CONTOSO', fill: '#ffffff' });
    else if (subj === 'bird' || subj === 'kite') shapes.push({ kind: 'circle', x, y: H * (0.35 - t * 0.1), r: s * 0.7, fill });
    else shapes.push({ kind: 'rect', x: x - s, y: gy - s * 1.6, w: s * 2, h: s * 1.6, fill }, { kind: 'circle', x: x + s * 0.9, y: gy - s * 1.8, r: s * 0.5, fill });
  }
  shapes.push({ kind: 'text', x: 2, y: H - 2, text: `t=${round(t, 2)} • ${cam}`, fill: '#ffffff' });
  return shapes;
}

function run(p) {
  const steps = [];
  const m = MODELS[p.model];
  const prompt = String(p.prompt || '');
  const ws = words(prompt);
  const secs = Math.round(p.seconds);
  const variants = Math.round(p.variants);
  const fail = (node, title, detail, data, summary, extra = []) => {
    steps.push(step(node, title, detail, data, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: `${title}: ${detail}` }, ...extra], metrics: [metric('Videos downloaded', '0', 'computed')], summary };
  };

  // 1. create job: auth + validation
  if (p.auth === 'norole') return fail('create', 'HTTP 403 PermissionDenied', 'The app identity has no data-plane role on the Foundry resource. Assign Cognitive Services OpenAI User (or Azure AI User) and retry.', { auth: 'DefaultAzureCredential', role: null }, 'Blocked: no data-plane role');
  if (!m.video) return fail('validate', 'Unsuitable model', `${m.label} produces still images, not video. Deploy a video model (Sora family) and use its video generation API.`, { model: p.model }, 'Rejected: image model used for video');
  if (!prompt.trim()) return fail('validate', 'HTTP 400 prompt required', 'A text prompt is required even when you pass reference media.', {}, 'Rejected: empty prompt');
  const problems = [];
  if (!m.resolutions.includes(p.resolution)) problems.push(`resolution ${p.resolution} not supported (allowed: ${m.resolutions.join(', ')})`);
  if (!m.seconds(secs)) problems.push(`duration ${secs}s not supported (allowed: ${m.secondsText})`);
  if (m.resolutions.includes(p.resolution) && variants > m.maxVariants(p.resolution)) problems.push(`${variants} variants not allowed at ${p.resolution} (max ${m.maxVariants(p.resolution)} in this simulation)`);
  if (p.reference === 'video' && !m.refVideo) problems.push(`${m.label} does not take a reference video here; use remix of an existing generation instead (see 3.1.4)`);
  if (problems.length) return fail('validate', 'HTTP 400 invalid request', problems.join('; ') + '. Validate combinations client-side before submitting a job.', { width: p.resolution.split('x')[0], height: p.resolution.split('x')[1], n_seconds: secs, n_variants: variants, reference: p.reference }, 'Rejected: invalid resolution/duration/variants');
  steps.push(step('validate', 'Request valid', `${p.resolution}, ${secs}s, ${variants} variant(s), reference: ${REFS[p.reference].label}.`, { model: p.model, size: p.resolution, seconds: secs, variants, reference: p.reference }));

  const blockedIn = ws.filter(w => BLOCKED_IN.includes(w));
  if (blockedIn.length) return fail('safety', 'HTTP 400 prompt filtered', `The prompt was rejected by content filtering at job creation (terms: ${blockedIn.join(', ')}). No job was created, so there is nothing to poll.`, { error: { code: 'content_filter (illustrative)', inner: { filtered: true } } }, 'Blocked at job creation (input filter)');

  const r = rng(`${prompt}|${p.model}|${p.resolution}|${secs}|${variants}|${p.reference}`);
  const jobId = `task_${Math.floor(r() * 1e8).toString(36)}`;
  const genIds = Array.from({ length: variants }, (_, i) => `gen_${Math.floor(r() * 1e8).toString(36)}${i}`);
  steps.push(step('create', 'Job created (HTTP 201/200)', `Video generation is asynchronous: the create call returns a job id (${m.api === 'videos' ? 'video id' : 'job id'} ${jobId}) immediately, not a video.`, { id: jobId, status: 'queued', model: p.model }));

  // 2. Lifecycle timing (simulated wall clock, seconds)
  const [w, h] = p.resolution.split('x').map(Number);
  const work = ((w * h) / (1280 * 720)) * secs * variants * (p.reference === 'video' ? 1.3 : 1);
  const tq = round(5 + r() * 20, 0), tp = round(3 + r() * 5, 0), tr = round(20 + work * 9, 0), tpost = round(4 + r() * 4, 0);
  const total = tq + tp + tr + tpost;
  const failOut = ws.filter(w2 => BLOCKED_OUT.includes(w2));
  steps.push(step('queue', 'queued → preprocessing', `Waited ${tq}s in the queue and ${tp}s preprocessing (simulated).`, { status: 'preprocessing' }, 'info'));

  // 3. Polling
  const polls = Math.ceil(total / Math.max(1, p.pollInterval));
  if (p.pollTarget !== 'job') {
    steps.push(step('poll', 'HTTP 404 job not found', p.pollTarget === 'generation'
      ? `GET .../jobs/${genIds[0]} — you polled the jobs endpoint with a generation id. Poll the job id; use generation ids only to download content.`
      : 'GET .../jobs/task_old123 — a job id from another resource/endpoint (or a stale id from config). Jobs are scoped to the resource that created them.', { polledId: p.pollTarget === 'generation' ? genIds[0] : 'task_old123', expected: jobId }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Polling the wrong id: the job is probably still running, but your app will never see it finish.' }, lifecycle(tq, tp, 0, 0, 'unknown')], metrics: [metric('Videos downloaded', '0', 'computed')], summary: 'Polling failed (404, wrong id)' };
  }
  if (p.pollInterval < 3) steps.push(step('poll', 'HTTP 429 while polling', `Polling every ${p.pollInterval}s issued ~${polls} status calls; some were throttled. Respect Retry-After and poll every 5–10 s or more (simulation rule).`, { polls, retryAfter: 10 }, 'warn'));

  if (failOut.length) {
    steps.push(step('render', 'running → failed', `The job ran, then failed output moderation (prompt implies "${failOut.join(', ')}"; illustrative). Failures discovered asynchronously only show up when polling.`, { status: 'failed', failure_reason: 'output_moderation (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Job status = failed. Read failure_reason, tell the user, and do not try to download.' }, lifecycle(tq, tp, tr, 0, 'failed')], metrics: [metric('Videos downloaded', '0', 'computed'), metric('Status polls', String(polls), 'computed')], summary: 'Job failed (output moderation)' };
  }
  steps.push(step('render', 'running → processing → succeeded', `Rendering took ~${tr}s and post-processing ~${tpost}s (simulated; real times vary with load, length and resolution).`, { status: m.api === 'videos' ? 'completed' : 'succeeded', generations: genIds }, 'ok'));
  if (p.pollInterval >= 3) steps.push(step('poll', `Polled ${polls} time(s)`, `GET job ${jobId} every ${p.pollInterval}s until a terminal status (succeeded / failed / cancelled).`, { polls, interval: p.pollInterval }));

  // 4. Download
  if (p.downloadDelay >= 24) {
    steps.push(step('download', 'HTTP 404 content expired', `You tried to download ${p.downloadDelay}h after completion. Generated content is kept only for a limited time (documented as 24 hours at the time of writing — check the docs). Download immediately and store it yourself.`, { generationId: genIds[0], ageHours: p.downloadDelay }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'The job succeeded but the video is gone. Copy outputs to your own storage as soon as the job completes.' }, lifecycle(tq, tp, tr, tpost, 'succeeded')], metrics: [metric('Videos downloaded', '0', 'computed')], summary: 'Content expired before download' };
  }
  steps.push(step('download', `Downloaded ${variants} MP4 file(s)`, m.api === 'videos' ? `GET /videos/${jobId}/content` : `GET /video/generations/${genIds[0]}/content/video (one call per generation id)`, { files: genIds.map(g => `${g}.mp4`) }));
  steps.push(step('store', 'Stored in Blob Storage', 'Files written with prompt, model, size and job id as metadata.', { container: 'generated-video' }));

  // Output
  const shots = planShots(prompt);
  const per = secs / shots.length;
  const refCam = p.reference === 'video' ? 'dolly-in' : null;
  const shotItems = shots.map((s, i) => ({ label: `Shot ${i + 1}: ${s.slice(0, 40)}`, start: round(i * per, 1), end: round((i + 1) * per, 1), lane: 'shots', tone: 'info' }));
  const camItems = shots.map((s, i) => ({ label: refCam || camera(s), start: round(i * per, 1), end: round((i + 1) * per, 1), lane: 'camera', tone: refCam ? 'warn' : 'ok' }));
  const [W, H] = w >= h ? [100, round((100 * h) / w, 0)] : [round((70 * w) / h, 0), 70];
  const frames = [0, 0.5, 1].map(t => {
    const idx = Math.min(shots.length - 1, Math.floor(t * shots.length * 0.999));
    return { type: 'image', title: `Keyframe @ ${round(t * secs, 1)}s${t === 0 && p.reference === 'image' ? ' (from reference image)' : ''}`, width: W, height: H, shapes: keyframe(shots[idx], refCam || camera(shots[idx]), (t * shots.length) % 1 || t, W, H, p.reference, `${jobId}|${t}`) };
  });
  const jobJson = m.api === 'videos'
    ? { id: jobId, object: 'video', model: p.model, status: 'completed', progress: 100, seconds: String(secs), size: p.resolution }
    : { object: 'video.generation.job', id: jobId, status: 'succeeded', model: p.model, n_seconds: secs, n_variants: variants, width: w, height: h, generations: genIds.map(g => ({ object: 'video.generation', id: g, job_id: jobId })), failure_reason: null };
  const output = [
    ...frames,
    { type: 'timeline', title: 'Generated video: shot plan and camera (seconds of video)', unit: 's', items: [...shotItems, ...camItems, ...(m.audio ? [{ label: 'synchronised audio', start: 0, end: secs, lane: 'audio', tone: 'muted' }] : [])] },
    lifecycle(tq, tp, tr, tpost, 'succeeded'),
    { type: 'json', title: 'Final job status (simulated shape, illustrative)', data: jobJson },
    { type: 'code', lang: 'python', title: 'Async pattern (illustrative; endpoint paths and api-version differ by model — check the docs)', text: m.api === 'videos'
      ? `video = client.videos.create(model="${p.model}", prompt=${JSON.stringify(prompt.slice(0, 60))}, size="${p.resolution}", seconds="${secs}"${p.reference === 'image' ? ', input_reference=open("still.png","rb")' : ''})\nwhile video.status in ("queued", "in_progress"):\n    time.sleep(${Math.max(5, p.pollInterval)}); video = client.videos.retrieve(video.id)\nif video.status == "completed":\n    client.videos.download_content(video.id).write_to_file("out.mp4")`
      : `job = post(f"{endpoint}/openai/v1/video/generations/jobs?api-version=preview",\n           json={"model": "${p.model}", "prompt": ..., "width": ${w}, "height": ${h}, "n_seconds": ${secs}, "n_variants": ${variants}})\nwhile job["status"] not in ("succeeded", "failed", "cancelled"):\n    time.sleep(${Math.max(5, p.pollInterval)}); job = get(f".../video/generations/jobs/{job['id']}")\nfor g in job["generations"]:\n    save(get(f".../video/generations/{g['id']}/content/video"))` },
  ];
  return {
    steps, output,
    metrics: [
      metric('Shots planned', String(shots.length), 'computed', 'Prompt split on "then", sentences and semicolons.'),
      metric('Status polls', String(polls), 'computed'),
      metric('Frames rendered', `~${secs * 30 * variants}`, 'estimate', 'Assumes ~30 fps; actual frame rate depends on the model.'),
      metric('Relative compute', `${round(work, 1)}× (720p, 1 s, 1 variant = 1)`, 'estimate', 'Scales with pixels × seconds × variants; billing differs per model — see the pricing page.'),
      metric('Prompt tokens', `~${estTokens(prompt)}`, 'estimate', '4-characters-per-token heuristic.'),
    ],
    summary: `${p.model} ${p.resolution} ${secs}s ×${variants} • ${shots.length} shot(s) • ${polls} polls${steps.some(s => s.status === 'warn') ? ' • warnings' : ''}`,
  };
}

function lifecycle(tq, tp, tr, tpost, final) {
  let t = 0;
  const items = [];
  const add = (label, d, tone) => { if (d > 0) { items.push({ label, start: t, end: t + d, tone, lane: 'job status' }); t += d; } };
  add('queued', tq, 'muted'); add('preprocessing', tp, 'info'); add('running', tr, 'info'); add('processing', tpost, 'info');
  items.push({ label: final, start: t, end: t + 3, tone: final === 'succeeded' ? 'ok' : final === 'failed' ? 'error' : 'warn', lane: 'job status' });
  return { type: 'timeline', title: 'Job lifecycle (simulated wall-clock seconds)', unit: 's', items };
}

export default {
  id: '3.1.2',
  lab: 'Video generation job studio',
  services: [
    { name: 'Sora video generation in Azure OpenAI (quickstart)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/video-generation-quickstart' },
    { name: 'Video generation concepts', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/video-generation' },
  ],
  prereqs: ['3.1.1'],
  next: ['3.1.4', '3.1.5'],

  concept: {
    plain: 'Making a video from a sentence takes much longer than making a picture, so the service works like a print shop: you hand in an order (the prompt, length, size and any reference picture or clip), get a ticket number back straight away, check the ticket now and then, and collect the finished video when it is ready. If you lose the ticket, check the wrong one, or wait too long to collect, you get nothing.',
    technical: 'Video models in Microsoft Foundry (Sora family, Azure OpenAI) use an asynchronous job pattern: POST creates a job (prompt, width/height or size, duration, variants, optional image or video reference) and returns an id; you poll GET until a terminal status (queued → preprocessing → running → processing → succeeded/failed/cancelled; the newer videos API uses queued/in_progress/completed/failed), then download each generation\'s MP4. Resolution, duration and variant combinations are constrained per model; prompts are filtered at creation and outputs can fail moderation after running. Generated content has limited retention, so copy it to your own storage.',
    useCase: 'A travel company generates 8–12 second destination clips for social posts. A Function creates the job, a Durable Functions timer polls it every 10 seconds, and when the job succeeds the MP4 is copied to Blob Storage and a reviewer is notified. Failed jobs carry their failure_reason into the review queue.',
    terms: [
      ['Video generation job', 'Server-side task with an id and a status; the create call returns immediately.'],
      ['Generation / variant', 'One produced video within a job; a job can request several variants.'],
      ['Terminal status', 'succeeded (completed), failed or cancelled; stop polling when reached.'],
      ['Reference media', 'An image (often used as the first frame or style anchor) or a video that conditions the output.'],
      ['Retention window', 'How long generated content stays downloadable from the service; limited, so persist it yourself.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'validate', label: 'Prompt + settings', col: 0, row: 1, kind: 'data', detail: 'Prompt, resolution, duration, variants, reference media.', badge: p ? `${p.resolution} • ${p.seconds}s` : undefined },
          { id: 'safety', label: 'Input filter', col: 1, row: 0, kind: 'policy', detail: 'Rejects disallowed prompts at creation time.' },
          { id: 'create', label: 'Create job → id', col: 1, row: 2, kind: 'compute', detail: 'Returns immediately with an id and status queued.' },
          { id: 'queue', label: 'Queued / preprocessing', col: 2, row: 1, kind: 'compute', detail: 'Waiting for capacity; preparing reference media.' },
          { id: 'render', label: 'Running → processing', col: 3, row: 1, kind: 'ai', detail: 'The model renders frames; output moderation may still fail the job.', substeps: ['Plan shots', 'Render frames', 'Encode MP4', 'Output moderation'] },
          { id: 'poll', label: 'Poll status', col: 3, row: 3, kind: 'app', detail: 'Your app checks the job id until a terminal status.', badge: p ? `every ${p.pollInterval}s` : undefined },
          { id: 'download', label: 'Download MP4', col: 4, row: 1, kind: 'data', detail: 'One file per generation; time-limited.' },
          { id: 'store', label: 'Your storage', col: 4, row: 3, kind: 'store', detail: 'Copy immediately; service retention is limited.' },
        ],
        edges: [['validate', 'safety'], ['validate', 'create'], ['create', 'queue'], ['queue', 'render'], ['poll', 'render', 'status?'], ['render', 'download'], ['download', 'store']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'validate', label: 'Web app (request form)', col: 0, row: 1, kind: 'app', detail: 'Validates resolution/duration combinations client-side.' },
          { id: 'create', label: 'Function: start job (managed identity)', col: 1, row: 1, kind: 'compute', detail: 'Calls the video API with DefaultAzureCredential; needs Cognitive Services OpenAI User.', badge: p && p.auth === 'norole' ? 'no role' : undefined },
          { id: 'safety', label: 'Content filters (deployment)', col: 1, row: 3, kind: 'policy', detail: 'Configured on the Foundry deployment.' },
          { id: 'queue', label: `Foundry resource: ${p ? p.model : 'sora'} deployment`, col: 2, row: 1, kind: 'ai', detail: 'Runs the job asynchronously.' },
          { id: 'render', label: 'Video model', col: 3, row: 0, kind: 'ai', detail: 'Sora family.', disabled: p && p.model === 'gpt-image-1' },
          { id: 'poll', label: 'Durable Functions timer (poll)', col: 2, row: 3, kind: 'compute', detail: 'Waits between polls without holding a thread; respects Retry-After.' },
          { id: 'download', label: 'Function: download', col: 3, row: 2, kind: 'compute', detail: 'Fetches MP4 per generation id.' },
          { id: 'store', label: 'Blob Storage + Event Grid', col: 4, row: 2, kind: 'store', detail: 'Persists outputs and notifies reviewers.' },
        ],
        edges: [['validate', 'create'], ['create', 'queue', 'POST job'], ['queue', 'safety'], ['queue', 'render'], ['poll', 'queue', 'GET job'], ['render', 'download'], ['download', 'store']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'validate', label: 'assert (size, seconds) in SUPPORTED[model]', col: 0, row: 0, kind: 'code', detail: 'Fail fast before paying for a job.' },
          { id: 'create', label: p && p.model === 'sora-2' ? 'video = client.videos.create(model, prompt, size, seconds)' : 'job = POST .../video/generations/jobs {model, prompt, width, height, n_seconds, n_variants}', col: 0, row: 1, kind: 'code', detail: 'Illustrative; paths and api-version depend on the model and are preview at the time of writing.' },
          { id: 'safety', label: 'except BadRequestError: content filter → message user', col: 0, row: 2, kind: 'code', detail: 'Input filter fires at creation.' },
          { id: 'queue', label: 'job_id = job["id"]  # persist it!', col: 0, row: 3, kind: 'code', detail: 'Store the id (not a generation id) for polling.' },
          { id: 'poll', label: 'while status not terminal: sleep(interval); GET job_id', col: 0, row: 4, kind: 'code', detail: 'Back off on 429.' },
          { id: 'render', label: 'if status == "failed": log(job["failure_reason"])', col: 0, row: 5, kind: 'code', detail: 'Output moderation failures arrive here.' },
          { id: 'download', label: 'for g in generations: GET .../{g.id}/content/video', col: 0, row: 6, kind: 'code', detail: 'Download promptly.' },
          { id: 'store', label: 'blob.upload_blob(mp4, metadata={job_id, prompt})', col: 0, row: 7, kind: 'code', detail: 'Own the retention.' },
        ],
        edges: [['validate', 'create'], ['create', 'safety'], ['safety', 'queue'], ['queue', 'poll'], ['poll', 'render'], ['render', 'download'], ['download', 'store']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'prompt', label: 'Prompt', type: 'textarea', default: 'A paper boat drifting down a rainy city street, camera follows at water level. Then the boat reaches a bright harbour at sunset', help: 'Use "then" or sentences to plan shots. Camera words: follows, zoom/dolly, pan, aerial.' },
      { id: 'model', label: 'Model', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'sora' },
      { id: 'resolution', label: 'Resolution', type: 'select', options: ['480x480', '854x480', '1280x720', '720x1280', '1080x1080', '1920x1080', '1080x1920', '3840x2160'].map(v => [v, v]), default: '1280x720' },
      { id: 'seconds', label: 'Duration (s)', type: 'range', min: 1, max: 25, step: 1, default: 8 },
      { id: 'variants', label: 'Variants', type: 'range', min: 1, max: 4, step: 1, default: 1 },
      { id: 'reference', label: 'Reference media', type: 'select', options: Object.entries(REFS).map(([v, r]) => [v, r.label]), default: 'none' },
      { id: 'pollTarget', label: 'Id used for polling', type: 'select', options: [['job', 'Job id from create response'], ['generation', 'Generation id (wrong)'], ['other', 'Stale id from config (wrong)']], default: 'job' },
      { id: 'pollInterval', label: 'Poll interval (s)', type: 'range', min: 1, max: 30, step: 1, default: 10 },
      { id: 'downloadDelay', label: 'Download delay after success (h)', type: 'range', min: 0, max: 48, step: 1, default: 1 },
      { id: 'auth', label: 'Identity', type: 'select', options: [['ok', 'Managed identity with Cognitive Services OpenAI User'], ['norole', 'Managed identity, no role']], default: 'ok' },
    ],
    samples: [
      { label: 'Paper boat, two shots', values: {} },
      { label: 'Product still → 1080p clip', values: { prompt: 'A bottle on a beach, camera zoom slowly towards the label', reference: 'image', resolution: '1920x1080', seconds: 10 } },
      { label: 'Sora 2 vertical with audio', values: { model: 'sora-2', resolution: '720x1280', seconds: 8, prompt: 'A dog chasing a red ball in a park, then the dog runs towards the camera' } },
      { label: 'Three variants at 480p', values: { resolution: '854x480', variants: 3, seconds: 5, prompt: 'A kite flying over a beach, aerial shot' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the paper boat at 854x480 and at 1920x1080 and compare relative compute and the lifecycle timeline.',
      'Compare reference media none vs video: the camera lane switches to the reference camera move.',
      'Compare poll interval 2 s vs 10 s: number of polls and the throttling warning.',
    ],
  },

  debug: [
    { id: 'res', title: 'Job rejected: 4K requested', values: { resolution: '3840x2160' }, node: 'validate',
      symptom: 'HTTP 400 invalid request at creation.', cause: 'The resolution is not in the model\'s supported list.', fix: 'Pick a supported resolution such as 1920x1080 or 1280x720.' },
    { id: 'dur', title: 'Sora 2 rejects a 10 s clip at 1080p', values: { model: 'sora-2', resolution: '1920x1080', seconds: 10 }, node: 'validate',
      symptom: 'HTTP 400: resolution and duration not supported.', cause: 'Each model has its own allowed size and duration set.', fix: 'Use 1280x720 / 720x1280 with 4, 8 or 12 s on Sora 2, or switch to the model that supports 1080p.' },
    { id: 'pollid', title: 'Status check always 404', values: { pollTarget: 'generation' }, node: 'poll',
      symptom: 'Job created successfully, but every status call returns 404.', cause: 'The app polls the jobs endpoint with a generation id (or a stale id).', fix: 'Persist and poll the job id returned by the create call.' },
    { id: 'expired', title: 'Download 404 the next day', values: { downloadDelay: 30 }, node: 'download',
      symptom: 'Job shows succeeded but the content endpoint returns 404.', cause: 'Generated content has limited retention on the service.', fix: 'Download immediately on success and store in your own Blob container (set delay below 24 h).' },
    { id: 'filter', title: 'Job never created', values: { prompt: 'A celebrity firing a weapon on a rainy street' }, node: 'safety',
      symptom: 'HTTP 400 content filtered; no job id.', cause: 'Input content filter blocked the prompt.', fix: 'Rewrite the prompt without disallowed content.' },
    { id: 'outmod', title: 'Job failed after running', values: { prompt: 'A car crash on a city street at night' }, node: 'render',
      symptom: 'Job status = failed with a failure_reason, after minutes of running.', cause: 'Output moderation can fail a job asynchronously.', fix: 'Read failure_reason, inform the user, and adjust the prompt (for example "A car driving down a city street at night").' },
    { id: 'image-model', title: 'Image model used for video', values: { model: 'gpt-image-1' }, node: 'validate',
      symptom: 'Request rejected: model cannot generate video.', cause: 'Unsuitable model deployment.', fix: 'Select a Sora-family deployment.' },
    { id: 'throttle', title: '429 while polling', values: { pollInterval: 1 }, node: 'poll',
      symptom: 'Throttling warnings during status checks.', cause: 'Polling too aggressively.', fix: 'Poll every 5–10 s or more and honour Retry-After.' },
  ],

  challenge: {
    task: 'Generate a landscape 1080p clip of at least 10 seconds that starts from the product still (image reference), and get it safely into your storage with no warnings.',
    condition: 'Resolution 1920x1080, duration ≥ 10 s, reference = image, MP4 stored, no warn/error step.',
    hint: 'Only one model supports 1080p here. Watch variants, polling and retention.',
    check: (p, res) => p.resolution === '1920x1080' && p.seconds >= 10 && p.reference === 'image' && res.steps.some(s => s.node === 'store' && s.status === 'ok') && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Model: Sora (preview jobs API).', 'Resolution 1920x1080, duration 10–20 s, variants 1 (1080p allows one variant in this simulation).', 'Reference: image.', 'Poll the job id every ≥5 s and download within the retention window.'],
    solutionValues: { model: 'sora', resolution: '1920x1080', seconds: 10, variants: 1, reference: 'image', pollTarget: 'job', pollInterval: 10, downloadDelay: 0, auth: 'ok', prompt: 'A bottle on a beach, camera zoom slowly towards the label' },
  },

  quiz: [
    { q: 'Your app calls the video API and expects an MP4 in the response, but receives JSON with an id and status "queued". What should the app do?', options: ['Retry the create call until it returns the video', 'Store the id and poll the job until a terminal status, then download each generation', 'Increase the timeout of the HTTP client', 'Switch to the images API'], answer: 1, why: 'Video generation is asynchronous: create returns a job; you poll and then download.' },
    { q: 'Jobs succeed, but a nightly batch that downloads yesterday\'s videos gets 404s. Best fix?', options: ['Poll more often', 'Download and persist each video as soon as its job succeeds', 'Request more variants', 'Use a higher resolution'], answer: 1, why: 'Service-side retention is limited; copy outputs to your own storage immediately.' },
    { q: 'A job finishes with status failed and a failure_reason after several minutes, although the create call returned 200. What happened?', options: ['The poll interval was too long', 'Output moderation (or another server-side check) failed the job asynchronously', 'The API key expired', 'The variant count was invalid'], answer: 1, why: 'Invalid parameters fail at creation; failures surfacing after running indicate server-side checks such as output moderation.' },
    { q: 'You need a 1920x1080 clip but the chosen model only lists 1280x720 and 720x1280. What do you do?', options: ['Send 1920x1080 anyway; it will be resized', 'Choose a model/deployment whose supported sizes include 1080p, or upscale afterwards', 'Increase n_seconds', 'Use a reference video'], answer: 1, why: 'Unsupported sizes are rejected; pick a capable model or post-process.' },
  ],

  recap: 'Video generation is a job: validate size/duration/variants per model, create the job, persist the job id, poll politely to a terminal status, handle failed jobs via failure_reason, then download each generation promptly into your own storage. Reference images and videos condition the first frame, style or camera.',
};
