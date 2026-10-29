// Archetype 2 — Parsing & ingestion pipeline integration: OCR vs layout vs high-resolution,
// then layout-aware chunking, metadata fields and a vector index for grounded RAG answers.
import { h, clear } from '../engine/dom.js';

// One sample report page. Footnote text is deliberately tiny (only high-res OCR reads it).
const TITLE = 'Q3 Returns Report';
const SOURCE = 'returns-q3-2026.pdf';
const PAGE = 4;
const DOC = [
  { kind: 'title', text: TITLE },
  { kind: 'sub', text: 'Northern Region operations, October 2026' },
  { kind: 'h', text: '1. Summary' },
  { kind: 'p', text: 'Returns fell in Q3, helped by new packaging at the Leeds and York depots.' },
  { kind: 'h', text: '2. Return rates by depot' },
  { kind: 'p', text: 'Leeds remains the best depot. Hull is under review after a courier change.' },
  { kind: 'table', head: ['Depot', 'Orders', 'Returns', 'Rate'], rows: [['Leeds', '12,400', '434', '3.5%*'], ['York', '8,100', '372', '4.6%'], ['Hull', '5,900', '336', '5.7%']] },
  { kind: 'foot', text: '* Excludes 41 warranty returns; including them, Leeds is 3.8%.', garbled: '* Exc|udes 4l w..r.nty ret..ns; inc..d.ng th.m, L..ds is 3.B%.' },
  { kind: 'h', text: '3. Audit checklist' },
  { kind: 'check', items: [['Packaging audit complete', true], ['Courier SLA reviewed', false], ['Refund policy updated', true]] },
];

const MODES = {
  read: { label: 'Read (OCR)', api: 'prebuilt-read' },
  layout: { label: 'Layout', api: 'prebuilt-layout' },
  hr: { label: 'Layout + high-res', api: 'prebuilt-layout + ocrHighResolution' },
};
const CHUNKERS = { fixed: 'Fixed 300 chars', section: 'By section headings' };
const QUERY = 'What was the Leeds return rate?';

// ---- Extract: turn the page into lines tagged with section and kind. ----
function extract(mode) {
  const lines = [];
  let sec = null;
  const md = mode !== 'read';
  const push = (text, kind, extra = {}) => lines.push({ text, kind, sec, ...extra });
  for (const b of DOC) {
    if (b.kind === 'title') push(md ? `# ${b.text}` : b.text, 'title');
    else if (b.kind === 'sub') push(b.text, 'p');
    else if (b.kind === 'h') { sec = b.text; push(md ? `## ${b.text}` : b.text, md ? 'h' : 'p'); }
    else if (b.kind === 'p') push(b.text, 'p');
    else if (b.kind === 'table') {
      if (md) {
        push(`| ${b.head.join(' | ')} |`, 'table', { header: true });
        push(`|${b.head.map(() => '---').join('|')}|`, 'table');
        b.rows.forEach(r => push(`| ${r.join(' | ')} |`, 'table'));
      } else {
        push(b.head.join(' '), 'table', { header: true });
        b.rows.forEach(r => push(r.join(' '), 'table'));
      }
    } else if (b.kind === 'foot') {
      push(mode === 'hr' ? b.text : b.garbled, 'foot', { low: mode !== 'hr' });
    } else if (b.kind === 'check') {
      b.items.forEach(([t, on]) => push(md ? `- ${on ? ':selected:' : ':unselected:'} ${t}` : t, 'check'));
    }
  }
  // In read mode there are no heading roles, so the pipeline cannot know sections.
  if (!md) lines.forEach(l => { l.sec = null; });
  let pos = 0;
  lines.forEach(l => { l.start = pos; l.end = pos + l.text.length; pos = l.end + 1; });
  return { lines, text: lines.map(l => l.text).join('\n') };
}

// ---- Chunk ----
function chunk(ex, how) {
  const { lines, text } = ex;
  const lineAt = i => lines.find(l => i >= l.start && i <= l.end) || lines[lines.length - 1];
  const tbl = lines.filter(l => l.kind === 'table');
  const tStart = tbl[0].start, tEnd = tbl[tbl.length - 1].end;
  let parts = [];
  if (how === 'fixed') {
    for (let i = 0; i < text.length; i += 300) parts.push({ start: i, end: Math.min(text.length, i + 300) });
  } else {
    const heads = lines.filter(l => l.kind === 'h');
    if (!heads.length) parts.push({ start: 0, end: text.length, noHeads: true });
    else heads.forEach((hd, i) => parts.push({ start: i === 0 ? 0 : hd.start, end: i + 1 < heads.length ? heads[i + 1].start - 1 : text.length }));
  }
  return parts.map((p, i) => {
    const t = text.slice(p.start, p.end);
    const first = lineAt(p.start);
    const inTable = x => x > tStart && x < tEnd;
    return {
      id: `q3-p${PAGE}-c${i + 1}`, n: i + 1, text: t, start: p.start, end: p.end,
      sec: how === 'section' ? (lines.find(l => l.kind === 'h' && l.start >= p.start && l.start < p.end) || {}).sec || null : first.sec,
      cutStart: inTable(p.start), cutEnd: inTable(p.end), noHeads: p.noHeads,
    };
  });
}

// ---- Retrieve (simulated relevance: weighted query-term hits) and judge the answer. ----
function retrieve(chunks) {
  const score = c => {
    const t = c.text.toLowerCase();
    const n = re => (t.match(re) || []).length;
    return 2 * Math.min(n(/leeds/g), 3) + Math.min(n(/return/g), 2) + Math.min(n(/rate/g), 2) + (/3\.5%/.test(t) ? 2 : 0);
  };
  const ranked = chunks.map(c => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  return { top: ranked[0].c, sim: (0.55 + 0.4 * ranked[0].s / 14).toFixed(2) };
}

function judge(st, ex, chunks, top) {
  const header = ex.lines.find(l => l.header).text;
  const hasRow = top.text.includes('3.5%');
  const hasHeader = top.text.includes(header);
  const rowChunk = chunks.find(c => c.text.includes('3.5%'));
  const foot = st.mode === 'hr' && top.text.includes('warranty');
  const checks = [];
  if (!hasRow) checks.push(['error', 'Table row', `The Leeds row is not in the retrieved chunk (it landed in chunk ${rowChunk ? rowChunk.n : '?'}), so the answer has no number.`]);
  else if (st.mode === 'read') checks.push(['warn', 'Table row', 'Row found, but the table was flattened to plain text: which number is the rate is guessed from word order.']);
  else if (!hasHeader) checks.push(['warn', 'Table row', 'Row found, but the header row is in another chunk: 3.5% arrives without its column name.']);
  else checks.push(['ok', 'Table row', 'Row and header arrive together as a markdown table.']);
  if (foot) checks.push(['ok', 'Footnote', 'Tiny footnote recovered by high-res OCR: the 3.8% caveat is included.']);
  else if (st.mode === 'hr') checks.push(['warn', 'Footnote', 'Footnote was recovered, but chunking put it in a different chunk from the row.']);
  else checks.push(['warn', 'Footnote', 'Footnote text is too small for standard OCR, so the warranty caveat is lost.']);
  if (!st.meta) checks.push(['error', 'Citation', `Only a chunk id (${top.id}): no page, section or source to cite or filter on.`]);
  else if (!top.sec) checks.push(['warn', 'Citation', `Page-level only (${SOURCE}, p.${PAGE}): no heading roles, so the section is unknown.`]);
  else checks.push(['ok', 'Citation', `${TITLE}, p.${PAGE}, section "${top.sec}".`]);
  let answer;
  if (!hasRow) answer = 'I could not find the Leeds return rate in the retrieved content.';
  else answer = `The Leeds return rate was 3.5%${foot ? ' (excluding 41 warranty returns; 3.8% including them)' : ''}.`;
  const cite = !st.meta ? `[${top.id}]` : top.sec ? `[${TITLE}, p.${PAGE}, ${top.sec}]` : `[${SOURCE}, p.${PAGE}]`;
  return { checks, answer: hasRow ? `${answer} ${cite}` : answer, verdict: checks.every(c => c[0] === 'ok') ? 'ok' : checks.some(c => c[0] === 'error') ? 'error' : 'warn' };
}

// Deterministic fake embedding preview.
function vec(text) {
  let x = 0;
  for (let i = 0; i < text.length; i++) x = (x * 31 + text.charCodeAt(i)) >>> 0;
  const out = [];
  for (let i = 0; i < 3; i++) { x = (x * 1103515245 + 12345) >>> 0; out.push(((x % 2000) / 1000 - 1).toFixed(2).replace('-', '−')); }
  return `[${out.join(', ')}, …]`;
}

// ---- The rendered source page ----
function sourcePage() {
  const els = [];
  for (const b of DOC) {
    if (b.kind === 'title') els.push(h('div.bz-ing-pt', { 'data-role': 'title' }, b.text));
    else if (b.kind === 'sub') els.push(h('div.bz-ing-psub', b.text));
    else if (b.kind === 'h') els.push(h('div.bz-ing-ph', { 'data-role': 'sectionHeading' }, b.text));
    else if (b.kind === 'p') els.push(h('p.bz-ing-pp', { 'data-role': 'paragraph' }, b.text));
    else if (b.kind === 'table') els.push(h('table.bz-ing-ptable', { 'data-role': 'table' },
      h('thead', h('tr', b.head.map(c => h('th', c)))), h('tbody', b.rows.map(r => h('tr', r.map(c => h('td', c)))))));
    else if (b.kind === 'foot') els.push(h('div.bz-ing-pfoot', { 'data-role': 'footnote (6pt)' }, b.text));
    else if (b.kind === 'check') els.push(h('ul.bz-ing-pcheck', { 'data-role': 'selectionMarks' }, b.items.map(([t, on]) => h('li', h(`span.bz-ing-box${on ? '.on' : ''}`, { 'aria-label': on ? 'checked' : 'unchecked' }), t))));
  }
  return h('div.bz-ing-page', { role: 'img', 'aria-label': 'Sample report page' }, h('div.bz-ing-pnum', `${SOURCE} · page ${PAGE}`), els);
}

function seg(label, opts, get, set) {
  const wrap = h('div.bz-ing-seg', { role: 'group', 'aria-label': label });
  const btns = Object.entries(opts).map(([v, t]) => {
    const b = h('button', { type: 'button', 'data-v': v }, typeof t === 'string' ? t : t.label);
    b.addEventListener('click', () => set(v));
    return b;
  });
  wrap.append(...btns);
  const sync = () => btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === get())));
  return { el: h('div.bz-ing-ctl', h('span.bz-ing-ctl-l', label), wrap), sync };
}

function viz() {
  const st = { mode: 'read', chunk: 'fixed', meta: false };
  const set = patch => { Object.assign(st, patch); draw(); };
  const cMode = seg('1 · Extraction', MODES, () => st.mode, v => set({ mode: v }));
  const cChunk = seg('2 · Chunking', CHUNKERS, () => st.chunk, v => set({ chunk: v }));
  const cMeta = seg('3 · Metadata fields', { off: 'Off', on: 'On' }, () => (st.meta ? 'on' : 'off'), v => set({ meta: v === 'on' }));
  const presets = h('div.bz-ing-presets',
    h('button.bz-ing-link', { type: 'button', onclick: () => set({ mode: 'read', chunk: 'fixed', meta: false }) }, 'Naive pipeline'),
    h('button.bz-ing-link', { type: 'button', onclick: () => set({ mode: 'hr', chunk: 'section', meta: true }) }, 'Best practice'));
  const controls = h('div.bz-ing-controls', cMode.el, cChunk.el, cMeta.el, presets);

  const pipe = h('ol.bz-ing-pipe');
  const page = sourcePage();
  const extracted = h('pre.bz-ing-out', { tabindex: 0, 'aria-label': 'Extracted output' });
  const caps = h('div.bz-ing-caps');
  const chunksEl = h('div.bz-ing-chunks');
  const chunkNote = h('p.bz-ing-note');
  const index = h('div.bz-ing-tablewrap');
  const query = h('div.bz-ing-query', { 'aria-live': 'polite' });

  function draw() {
    [cMode, cChunk, cMeta].forEach(c => c.sync());
    const ex = extract(st.mode);
    const chunks = chunk(ex, st.chunk);
    const { top, sim } = retrieve(chunks);
    const res = judge(st, ex, chunks, top);
    const md = st.mode !== 'read';

    // pipeline strip
    const steps = [
      ['Extract', MODES[st.mode].api],
      ['Chunk', `${CHUNKERS[st.chunk]} · ${chunks.length} chunk${chunks.length > 1 ? 's' : ''}`],
      ['Metadata', st.meta ? 'title, page, section, url' : 'none'],
      ['Index', `${chunks.length} docs + vector field`],
      ['Query', res.verdict === 'ok' ? 'grounded, precise citation' : res.verdict === 'warn' ? 'partial answer' : 'answer fails'],
    ];
    clear(pipe).append(...steps.map(([n, v], i) => h(`li${i === 4 ? `.v-${res.verdict}` : ''}`, h('span.bz-ing-pipe-n', `${i + 1}`), h('strong', n), h('span', v))));

    // page overlay state
    page.className = `bz-ing-page m-${st.mode}`;

    // extracted output
    clear(extracted);
    ex.lines.forEach(l => extracted.append(h(`span.k-${l.kind}${l.low ? '.low' : ''}`, l.text), '\n'));
    const cap = (ok, t) => h(`span.chip.tone-${ok ? 'ok' : 'error'}`, `${ok ? '✓' : '✕'} ${t}`);
    clear(caps).append(cap(true, 'Text + confidence'), cap(md, 'Headings / roles'), cap(md, 'Table structure'), cap(md, 'Checkbox states'), cap(st.mode === 'hr', 'Tiny footnote'),
      h('span.bz-ing-capnote', md ? 'Output: markdown (outputContentFormat=markdown)' : 'Output: lines and words only'));

    // chunk cards
    clear(chunksEl);
    chunks.forEach(c => {
      const flags = [];
      if (c.cutStart || c.cutEnd) flags.push(h('span.chip.tone-error', 'Table split'));
      if (c === top) flags.push(h('span.chip.tone-info', 'Retrieved'));
      const meta = st.meta
        ? h('dl.bz-ing-meta', h('dt', 'title'), h('dd', TITLE), h('dt', 'page'), h('dd', String(PAGE)), h('dt', 'section'), h('dd', c.sec || '— (unknown)'), h('dt', 'url'), h('dd', `…/${SOURCE}#page=${PAGE}`))
        : h('p.bz-ing-nometa', 'No metadata: content + vector only');
      chunksEl.append(h(`article.bz-ing-chunk${c === top ? '.top' : ''}`,
        h('header', h('strong', `Chunk ${c.n}`), h('span.bz-ing-len', `${c.text.length} chars`), flags),
        c.cutStart ? h('div.bz-ing-cut', 'cut: continues from previous chunk') : null,
        h('pre', c.text),
        c.cutEnd ? h('div.bz-ing-cut', 'cut at 300 chars, mid-table') : null,
        meta));
    });
    const cutCount = chunks.filter(c => c.cutEnd).length;
    chunkNote.textContent = st.chunk === 'fixed'
      ? `Fixed-size splitting ignores structure: ${cutCount ? 'a boundary falls inside the table, so its rows (and possibly its header) end up in different chunks.' : 'boundaries land wherever the character count says.'}`
      : chunks[0].noHeads
        ? 'No heading roles in read output, so there is nothing to split on: the whole page becomes one oversized chunk.'
        : 'One chunk per section heading: the table stays intact with its heading and footnote. Long sections would be split further with a small overlap.';

    // search index
    const metaCell = v => (st.meta ? h('td', v) : h('td.off', '—'));
    clear(index).append(h('table.bz-ing-index',
      h('thead', h('tr', ['id', 'content', 'section', 'page', 'vector'].map((f, i) => h(`th${!st.meta && (i === 2 || i === 3) ? '.off' : ''}`, f)))),
      h('tbody', chunks.map(c => h(`tr${c === top ? '.top' : ''}`,
        h('td.mono', c.id),
        h('td.content', c.text.replace(/\n/g, ' ').slice(0, 48) + '…'),
        metaCell(c.sec || '—'),
        metaCell(String(PAGE)),
        h('td.mono', vec(c.text)))))),
    h('p.bz-ing-schema', st.meta
      ? 'Schema: id (key) · content (searchable) · section, page, title (filterable, retrievable) · url (retrievable) · vector (Collection(Edm.Single), dimensions match the embedding model)'
      : 'Schema: id (key) · content (searchable) · vector. Nothing to filter on and nothing to cite but the chunk id.'));

    // test query
    clear(query).append(
      h('div.bz-ing-q', h('span.bz-ing-ctl-l', 'Test query'), h('strong', QUERY)),
      h('p.bz-ing-hit', `Top match: chunk ${top.n} (${top.id}), similarity ${sim}`),
      h(`div.bz-ing-answer.v-${res.verdict}`, h('span.bz-ing-ctl-l', 'Grounded answer'), h('p', res.answer)),
      h('ul.bz-ing-checks', res.checks.map(([tone, k, t]) => h(`li.tone-${tone}`, h('strong', k), h('span', t)))));
  }
  draw();

  return h('div.bz-viz.bz-ing', controls, pipe,
    h('div.bz-ing-grid',
      h('section', h('p.overline', 'Source page'), page),
      h('section', h('p.overline', 'Step 1 · Extracted output'), extracted, caps)),
    h('section', h('p.overline', 'Step 2–3 · Chunks and metadata'), chunkNote, chunksEl),
    h('section', h('p.overline', 'Step 4 · Search index (Azure AI Search, illustrative)'), index),
    h('section', h('p.overline', 'Step 5 · Retrieve and answer'), query));
}

export default {
  id: 'ingestion',
  n: 2,
  title: 'Parsing & ingestion pipeline integration',
  minutes: 9,
  crux: 'Match the extraction mode to what is on the page (text only, structure, or tiny print), then chunk along the structure, attach metadata as fields and embed, so retrieval returns whole facts with precise citations.',
  rules: [
    ['You only need the text (lines, words, confidence) for search or translation', 'prebuilt-read (OCR)', 'Cheapest text extraction; no tables, checkboxes or roles.'],
    ['You need tables, checkboxes / selection marks, headings, reading order or markdown for RAG', 'prebuilt-layout (or a Content Understanding document analyzer)', 'Adds structure and roles; markdown output feeds header-based chunking.'],
    ['Tiny text on large-format pages such as engineering drawings or maps', 'High-resolution OCR add-on (features=ocrHighResolution)', 'Recognises small print that standard-resolution OCR misses; billed as an add-on.'],
    ['RAG answers are cut off mid-table or citations point at fragments', 'Layout-aware chunking by section / markdown headers (e.g. Document Layout skill), small overlap, keep tables whole', 'Each chunk holds a complete, self-describing unit.'],
    ['Users must filter by department or date, or answers need page-level citations', 'Metadata as index fields (filterable / retrievable), plus a vector field', 'Filters narrow the search; page, section and source make citations precise.'],
  ],
  viz,
  questions: [
    { q: 'An insurer processes scanned claim forms. Agents need the printed text and also whether each "Yes / No" checkbox on the form is ticked. Which Document Intelligence model should they call?',
      options: ['prebuilt-read', 'prebuilt-layout', 'A custom text classification model', 'Azure AI Vision image tagging'], answer: 1,
      why: 'Checkbox states are selection marks, which layout returns along with tables and roles. Read returns only text lines and words; classification and image tagging do not extract checkbox states.' },
    { q: 'An engineering firm digitises large-format construction drawings. Standard OCR misses the small dimension labels and part numbers in the margins. What is the least effort fix?',
      options: ['Train a custom neural model on labelled drawings', 'Split each drawing into tiles before calling prebuilt-read', 'Enable the high-resolution OCR add-on capability (ocrHighResolution)', 'Switch to the prebuilt-invoice model'], answer: 2,
      why: 'The high-resolution add-on exists for tiny text on large-format documents. Tiling is manual work you do not need; a custom model or an invoice model does not fix recognition resolution.' },
    { q: 'A RAG chatbot over policy PDFs gives answers with numbers but the wrong column, and citations often point to a chunk that starts halfway through a table. Ingestion currently splits text every 500 characters. What should you change?',
      options: ['Increase the chunk size to 5,000 characters', 'Use layout extraction with markdown output and chunk by section headers, keeping tables intact', 'Switch the embedding model to a larger one', 'Turn off chunking and index each PDF as one document'], answer: 1,
      why: 'Fixed-size splitting cuts tables and separates headers from rows. Layout-aware chunking by headings keeps each table whole with its context. Bigger chunks or one document per PDF dilute relevance; a better embedding cannot rebuild a split table.' },
    { q: 'HR wants the knowledge assistant to answer only from documents of the employee\'s own department and from policies issued after 2024, and to cite the page number. How should the Azure AI Search index be designed?',
      options: ['Put department and date in the chunk text so the vector search picks them up', 'Add department, issue date and page as filterable, retrievable fields on each chunk and apply a filter at query time', 'Create one index per department and ignore dates', 'Rely on the language model to ignore irrelevant chunks'], answer: 1,
      why: 'Metadata stored as filterable fields lets the query apply exact filters before or alongside vector search, and retrievable page fields give precise citations. Embedding metadata in text is fuzzy, and per-department indexes still do not handle dates or citations.' },
  ],
  live: [{ label: 'Ingestion workbench: OCR, layout, tables and reading order', href: '#/s/ingestion' }],
  takeaway: 'Read for text, layout for structure (tables, checkboxes, headings), the high-res add-on for tiny print; then chunk by sections, keep tables whole and store page and section as filterable fields so answers cite precisely.',
};
