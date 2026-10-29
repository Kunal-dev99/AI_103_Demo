// Archetype 4 — System architecture & troubleshooting: find the broken layer, then fix 429s properly.
import { h, s, clear } from '../engine/dom.js';
import { rng } from '../engine/util.js';

// ---------------------------------------------------------------- (a) Pipeline doctor
const LAYERS = [
  { id: 'extract', name: 'Extraction', sub: 'OCR, layout, tables' },
  { id: 'chunk', name: 'Chunking', sub: 'boundaries, overlap' },
  { id: 'index', name: 'Embed & index', sub: 'vectors, indexer, freshness' },
  { id: 'retrieve', name: 'Retrieval', sub: 'query type, top-k, filters, ranker' },
  { id: 'generate', name: 'Generation', sub: 'prompt, temperature, max tokens' },
  { id: 'cite', name: 'Citations', sub: 'source, page, chunk id' },
];

const SYMPTOMS = [
  { id: 'classic', exam: true, label: 'Citations point to irrelevant snippets and recent documents are missing',
    layers: ['extract', 'chunk', 'index'],
    dx: 'Bad snippets plus missing documents is an ingestion problem, not an LLM problem: the model can only cite what was extracted, chunked and indexed.',
    check: 'Open the indexed chunks: is the OCR text clean, do chunks split mid-clause, and when did the indexer last run?' },
  { id: 'stale', label: 'Documents uploaded yesterday never show up in answers',
    layers: ['index'],
    dx: 'The index is stale. New blobs are only picked up when the indexer runs and change detection notices them.',
    check: 'Indexer schedule and run history, and the change-detection policy on the data source.' },
  { id: 'tables', label: 'Tables come out garbled in answers (numbers in the wrong rows)',
    layers: ['extract'],
    dx: 'Plain OCR (read) flattens tables into a stream of words, so row and column structure is lost before chunking.',
    check: 'Switch extraction to the layout model (markdown output keeps table structure).' },
  { id: 'split', label: 'The right document is cited, but a clause that spans two pages is answered half-right',
    layers: ['chunk'],
    dx: 'The fact is cut across a chunk boundary, so neither chunk holds the whole answer.',
    check: 'Chunk by document structure (sections, paragraphs) and add overlap between chunks.' },
  { id: 'synonyms', label: 'Relevant passages exist but rank below unrelated ones; synonyms are missed',
    layers: ['retrieve'],
    dx: 'Keyword-only search misses meaning; the good chunks are not in the top-k sent to the model.',
    check: 'Use hybrid (keyword + vector) query with the semantic ranker, then tune top-k.' },
  { id: 'random', label: 'The same question gives different, sometimes creative answers each run',
    layers: ['generate'],
    dx: 'Retrieval is fine; the model is sampling too freely.',
    check: 'Lower temperature (and top_p) and tighten the system prompt to answer only from sources.' },
  { id: 'cutoff', label: 'Answers stop mid-sentence',
    layers: ['generate'],
    dx: 'The completion hit its output token limit.',
    check: 'Raise max tokens (max_completion_tokens), or send fewer / shorter chunks.' },
  { id: 'nosource', label: 'Answers are correct but citations have no page number or link',
    layers: ['cite', 'chunk'],
    dx: 'Source metadata was not carried with each chunk, so there is nothing to cite.',
    check: 'Store source path and page number as index fields on every chunk and return them with results.' },
];

function doctor() {
  let cur = SYMPTOMS[0];
  const nodes = {};
  const pipe = h('div.bz4-pipe', { role: 'list', 'aria-label': 'RAG pipeline layers' });
  LAYERS.forEach((L, i) => {
    nodes[L.id] = h('div.bz4-node', { role: 'listitem' }, h('span.bz4-node-n', String(i + 1).padStart(2, '0')), h('strong', L.name), h('span.bz4-node-sub', L.sub));
    pipe.appendChild(nodes[L.id]);
  });
  const list = h('div.bz4-symptoms', { role: 'radiogroup', 'aria-label': 'Symptom' });
  const btns = SYMPTOMS.map(sym => {
    const b = h('button.bz4-sym', { type: 'button', role: 'radio' }, sym.label, sym.exam ? h('span.bz4-tag', 'classic exam case') : null);
    b.addEventListener('click', () => { cur = sym; draw(); });
    list.appendChild(b);
    return b;
  });
  const out = h('div.bz4-dx', { 'aria-live': 'polite' });
  function draw() {
    SYMPTOMS.forEach((sym, i) => { btns[i].setAttribute('aria-checked', String(sym === cur)); btns[i].classList.toggle('on', sym === cur); });
    LAYERS.forEach(L => {
      const on = cur.layers.includes(L.id);
      nodes[L.id].classList.toggle('hot', on);
      nodes[L.id].classList.toggle('dim', !on);
    });
    const names = cur.layers.map(id => LAYERS.find(L => L.id === id).name).join(' + ');
    clear(out).append(
      h('p.bz4-dx-layer', h('span', 'Suspect layer'), h('strong', names)),
      h('p', h('strong', 'Diagnosis. '), cur.dx),
      h('p', h('strong', 'Check first. '), cur.check));
  }
  draw();
  return h('section.bz4-part',
    h('div.bz4-part-head', h('p.overline', 'Part A · Pipeline doctor'), h('p.bz4-hint', 'Pick a symptom. The likely broken layer lights up.')),
    pipe,
    h('div.bz4-doctor-grid', h('div', h('p.bz4-label', 'Symptom reported'), list), h('div', h('p.bz4-label', 'Diagnosis'), out)));
}

// ---------------------------------------------------------------- (b) 429 simulator
const N = 200;
const WINDOW = 1000; // ms
export const STRATEGIES = [
  { id: 'none', name: 'No retry', note: 'every 429 is a lost document' },
  { id: 'fixed', name: 'Fixed 1 s retry', note: 'up to 5 retries, all on the same 1 s beat' },
  { id: 'backoff', name: 'Exponential backoff + jitter', note: 'pauses the queue for Retry-After, then retries after random jitter up to 0.5 s \u00d7 2\u207f' },
];

// Deterministic: fixed-window limiter (limit per 1 s window), client submits at sendRate per second.
export function simulate(strategy, { limit = 20, sendRate = 40, seed = 103 } = {}) {
  const rand = rng(seed);
  const q = [];
  for (let i = 0; i < N; i++) q.push({ t: Math.round(i * 1000 / sendRate), id: i, attempt: 0 });
  const used = new Map();
  const events = []; // { t, kind: 'ok' | '429' | 'fail', retry }
  let ok = 0, failed = 0, calls = 0, gate = 0;
  while (q.length) {
    q.sort((a, b) => a.t - b.t || a.id - b.id);
    const r = q.shift();
    // Backoff client honours Retry-After for the whole queue: nothing is sent while the gate is closed.
    if (strategy === 'backoff' && r.t < gate) { r.t = gate + Math.round(rand() * 1000); q.push(r); continue; }
    calls++;
    const w = Math.floor(r.t / WINDOW);
    const n = used.get(w) || 0;
    if (n < limit) { used.set(w, n + 1); ok++; events.push({ t: r.t, kind: 'ok', retry: r.attempt > 0 }); continue; }
    const retryAfter = Math.ceil(((w + 1) * WINDOW - r.t) / 1000) * 1000; // header is whole seconds
    let next = null;
    if (strategy === 'fixed' && r.attempt < 5) next = r.t + 1000;
    if (strategy === 'backoff' && r.attempt < 8) {
      gate = Math.max(gate, r.t + retryAfter);
      next = r.t + retryAfter + Math.round(rand() * Math.min(8000, 500 * 2 ** r.attempt));
    }
    if (next == null) { failed++; events.push({ t: r.t, kind: 'fail', retry: r.attempt > 0 }); }
    else { events.push({ t: r.t, kind: '429', retry: r.attempt > 0 }); q.push({ t: next, id: r.id, attempt: r.attempt + 1 }); }
  }
  const end = Math.max(...events.map(e => e.t)) + 1;
  const bins = [];
  for (let b = 0; b < Math.ceil(end / WINDOW); b++) bins.push({ ok: 0, err: 0, retries: 0 });
  events.forEach(e => {
    const b = bins[Math.floor(e.t / WINDOW)];
    if (e.kind === 'ok') b.ok++; else b.err++;
    if (e.retry) b.retries++;
  });
  return { ok, failed, calls, totalMs: end, peakRetry: Math.max(0, ...bins.map(b => b.retries)), bins };
}

function simulator() {
  const p = { limit: 20, sendRate: 40 };
  const mkSel = (label, key, opts, unit) => {
    const sel = h('select', { 'aria-label': label }, opts.map(v => h('option', { value: v, selected: v === p[key] }, `${v} ${unit}`)));
    sel.addEventListener('change', () => { p[key] = +sel.value; draw(); });
    return h('label.bz4-field', h('span', label), sel);
  };
  const controls = h('div.bz4-controls',
    mkSel('Rate limit', 'limit', [10, 15, 20], 'requests / s'),
    mkSel('Client send rate', 'sendRate', [40, 60], 'requests / s'),
    h('div.bz4-legend', h('span.bz4-key.ok', 'success'), h('span.bz4-key.err', '429 Too Many Requests'), h('span.bz4-key.lim', 'rate limit')));
  const rows = h('div.bz4-rows');
  const foot = h('p.bz4-foot');
  function draw() {
    const res = STRATEGIES.map(st => ({ st, r: simulate(st.id, p) }));
    const maxBins = Math.max(...res.map(x => x.r.bins.length));
    const peak = Math.max(...res.map(x => Math.max(...x.r.bins.map(b => b.ok + b.err))));
    const maxY = Math.min(Math.max(p.limit * 1.25, peak), p.limit * 4); // taller bars are clipped and marked
    const best = res.reduce((a, b) => (b.r.ok > a.r.ok || (b.r.ok === a.r.ok && b.r.totalMs < a.r.totalMs) ? b : a));
    clear(rows);
    res.forEach(({ st, r }) => {
      const W = maxBins * 10, H = 100, bw = 10;
      const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'bz4-chart', role: 'img',
        'aria-label': `${st.name}: ${r.ok} succeeded, ${r.failed} failed over ${(r.totalMs / 1000).toFixed(1)} seconds` });
      for (let x = 0; x <= maxBins; x += 5) svg.appendChild(s('line', { x1: x * bw, x2: x * bw, y1: 0, y2: H, class: 'bz4-grid', 'vector-effect': 'non-scaling-stroke' }));
      r.bins.forEach((b, i) => {
        const hOk = (b.ok / maxY) * H, hErr = Math.min((b.err / maxY) * H, H - hOk);
        if (b.ok) svg.appendChild(s('rect', { x: i * bw + 1, width: bw - 2, y: H - hOk, height: hOk, class: 'bz4-bar-ok' }));
        if (b.err) svg.appendChild(s('rect', { x: i * bw + 1, width: bw - 2, y: H - hOk - hErr, height: hErr, class: 'bz4-bar-err' }));
        if (b.ok + b.err > maxY) svg.appendChild(s('rect', { x: i * bw + 1, width: bw - 2, y: 6, height: 3, class: 'bz4-clip' }));
      });
      const ly = H - (p.limit / maxY) * H;
      svg.appendChild(s('line', { x1: 0, x2: W, y1: ly, y2: ly, class: 'bz4-limit', 'vector-effect': 'non-scaling-stroke' }));
      const ticks = h('div.bz4-ticks');
      for (let x = 0; x <= maxBins; x += 5) ticks.appendChild(h('span', { style: { left: `${(x / maxBins) * 100}%` } }, `${x}s`));
      const stat = (label, val, cls) => h(`div.bz4-stat${cls ? '.' + cls : ''}`, h('span', label), h('strong', val));
      rows.appendChild(h(`div.bz4-row${st === best.st ? '.best' : ''}`,
        h('div.bz4-row-head', h('strong', st.name), h('span', st.note)),
        h('div.bz4-plot', svg, ticks),
        h('div.bz4-stats',
          stat('Succeeded', `${r.ok} / ${N}`, r.ok === N ? 'good' : ''),
          stat('Failed', String(r.failed), r.failed ? 'bad' : 'good'),
          stat('Total time', `${(r.totalMs / 1000).toFixed(1)} s`),
          stat('Peak retries in 1 s', String(r.peakRetry), r.peakRetry > p.limit ? 'bad' : ''))));
    });
    clear(foot).append(`Simulated, deterministic (seed 103): ${N} analyze calls, fixed 1 s rate-limit window, 1 s bars; a notch marks a bar clipped at the top. `,
      'Fixed retries land on the same beat as new traffic, so the red storm grows; backoff waits out Retry-After and spreads retries with jitter, trading time for zero lost documents.');
  }
  draw();
  return h('section.bz4-part',
    h('div.bz4-part-head', h('p.overline', 'Part B · 429 simulator'), h('p.bz4-hint', 'Bulk ingestion of 200 documents against a rate limit. Same seed, same result every time.')),
    controls, rows, foot);
}

function viz() {
  return h('div.bz-viz.bz4', doctor(), simulator());
}

export default {
  id: 'troubleshoot',
  n: 4,
  title: 'System architecture & troubleshooting',
  minutes: 12,
  crux: 'Read the symptoms, name the broken layer of the pipeline first (extraction, chunking, indexing, retrieval, generation, citations), and only then pick the fix; for 429s, back off instead of hammering.',
  rules: [
    ['Irrelevant citations and recent documents missing', 'Investigate ingestion: extraction quality, chunk boundaries, index freshness', 'The model can only cite what was extracted, chunked and indexed. Not an LLM problem.'],
    ['New or changed documents do not appear in results', 'Check the indexer schedule and change detection', 'The index only updates when the indexer runs and detects the change.'],
    ['Tables garbled, columns merged in answers', 'Use layout extraction (markdown) instead of plain read OCR', 'Layout keeps table, row and section structure for chunking.'],
    ['Answers inconsistent or creative / cut off mid-sentence', 'Lower temperature / raise max tokens', 'These are generation parameters; retrieval is not the cause.'],
    ['429 Too Many Requests during bulk ingestion', 'Honour Retry-After, exponential backoff with jitter, cap concurrency; raise quota or spread across deployments if sustained', 'Fixed-interval retries synchronise into retry storms and keep you throttled.'],
  ],
  viz,
  questions: [
    { q: 'After launching a document Q&A assistant, users report that citations point to irrelevant snippets and that documents added in the last two weeks never appear. What should the team investigate first?',
      options: ['Increase the model temperature so answers are more varied', 'Switch to a larger chat model deployment', 'Extraction quality, chunking boundaries and index freshness', 'Increase max tokens on the chat completion'], answer: 2,
      why: 'Both symptoms sit upstream of the model: poor snippets come from bad extraction or chunk boundaries, and missing documents mean the index is stale. Changing the model or its parameters cannot cite content that was never indexed correctly.' },
    { q: 'A nightly job sends 5,000 documents to Document Intelligence. Many calls fail with HTTP 429 and the job retries each failure every 1 second, but the failures continue. What should you change?',
      options: ['Retry immediately with no delay to finish faster', 'Honour the Retry-After header and use exponential backoff with jitter, limiting concurrent requests', 'Switch every call to the prebuilt-read model', 'Disable retries and log the failed documents'], answer: 1,
      why: 'Fixed-interval retries arrive in synchronised waves and keep hitting the limit. Waiting for Retry-After, backing off exponentially with random jitter and capping concurrency keeps you under the limit; if the load is sustained, raise quota or spread across deployments.' },
    { q: 'Contracts uploaded to Blob Storage this morning are not returned by Azure AI Search, although last month’s contracts are. The indexer has no errors. What should you check?',
      options: ['The semantic ranker configuration', 'The indexer schedule and the data source change-detection policy', 'The chat model’s temperature', 'The vector dimensions of the embedding model'], answer: 1,
      why: 'Old documents work and new ones are missing: a freshness problem. The indexer must run on a schedule (or be triggered) and change detection must pick up new or modified blobs.' },
    { q: 'Answers about invoice line items mix up quantities and prices from different rows. The pipeline uses prebuilt-read output split into 1,000-token chunks. What is the best first fix?',
      options: ['Use prebuilt-layout (markdown output) so table structure survives into the chunks', 'Raise top-k from 5 to 50', 'Lower the temperature to 0', 'Add a second embedding model'], answer: 0,
      why: 'Read returns text lines without table structure, so rows and columns are flattened before chunking. Layout extraction keeps the table, which fixes the problem at its source.' },
  ],
  live: [{ label: 'Ingestion lab: extract, chunk, index', href: '#/s/ingestion' }],
  takeaway: 'Diagnose the layer before the fix: bad citations and missing documents are ingestion problems (extraction, chunking, index freshness), erratic or cut-off answers are generation settings, and 429s need Retry-After plus exponential backoff with jitter.',
};
