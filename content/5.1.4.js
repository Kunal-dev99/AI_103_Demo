// 5.1.4 Configure RAG ingestion flow, including documents and using optical character recognition (OCR)
// Lab: RAG chunking & OCR bench.
import { step, metric, estTokens, round, hasError } from '../src/engine/util.js';

// Embedding input limit used for the "chunk too large" check. 8,191 tokens is the documented input
// limit of the Azure OpenAI text-embedding-3 / ada-002 models at the time of writing; check the docs.
const EMBED_LIMIT = 8191;

// Sample documents as structured sections. How they turn into text depends on the extraction route.
const DOCS = {
  handbook: {
    label: 'Travel handbook (digital PDF, 4 pages)', scanned: false,
    sections: [
      { h: 'Travel policy', level: 1, paras: ['This policy applies to all employees and contractors travelling on company business.'] },
      { h: '1. Booking', level: 2, paras: ['All trips must be booked through the travel desk at least 14 days in advance.', 'Economy class applies to flights under six hours.'] },
      { h: '2. Hotels', level: 2, paras: ['Hotel stays are capped per night by city. Use the table below when booking.'], table: [['City', 'Hotel cap per night'], ['London', '250 GBP'], ['Paris', '220 EUR'], ['Seattle', '300 USD']], after: ['Stays above the cap need director approval before booking.'] },
      { h: '3. Mileage', level: 2, paras: ['Private car use is reimbursed at 0.45 GBP per mile for the first 10,000 miles each year.'] },
    ],
    question: 'What is the hotel cap per night in London?',
    keys: ['Hotel cap per night', 'London', '250 GBP'],
    answer: 'The London hotel cap is 250 GBP per night.',
  },
  scanned: {
    label: 'Purchase approval matrix (scanned PDF, image only)', scanned: true,
    sections: [
      { h: 'Purchase approval matrix', level: 1, paras: ['All purchases need approval before the order is placed with the supplier.'] },
      { h: 'Approval thresholds', level: 2, paras: ['Use the matrix below. Amounts are in GBP and include VAT.'], table: [['Amount', 'Approver'], ['Up to 5,000', 'Line manager'], ['5,000 to 50,000', 'Finance director'], ['Above 50,000', 'Chief financial officer']] },
      { h: 'Exceptions', level: 2, paras: ['Emergency repairs may be approved retrospectively within five working days.'] },
    ],
    question: 'Who approves a purchase of 20,000 GBP?',
    keys: ['Approver', '5,000 to 50,000', 'Finance director'],
    answer: 'A 20,000 GBP purchase is approved by the Finance director.',
  },
  manual: {
    label: 'Router admin manual (digital PDF, ~120 pages; excerpt shown)', scanned: false, fullTokens: 60000,
    sections: [
      { h: 'X200 administrator manual (excerpt)', level: 1, paras: ['This excerpt shows two sections of a long manual.'] },
      { h: '7.3 Firmware recovery', level: 2, paras: ['If a firmware update is interrupted, the status light blinks amber.', 'Hold the reset button for 30 seconds until the light turns solid blue, then release it and wait for the restart.'] },
      { h: '7.4 Factory reset', level: 2, paras: ['A factory reset erases all settings. Hold the reset button for 10 seconds while the router is running.'] },
    ],
    question: 'How long do I hold the reset button to recover the firmware?',
    keys: ['Firmware recovery', 'reset button', '30 seconds'],
    answer: 'Hold the reset button for 30 seconds (firmware recovery).',
  },
};

// Text representation produced by each extraction route.
function extract(doc, ocr) {
  if (doc.scanned && ocr === 'none') return { text: '', markdown: false };
  if (ocr === 'layout') {
    const md = doc.sections.map(s => [
      `${'#'.repeat(s.level)} ${s.h}`,
      ...s.paras,
      ...(s.table ? [s.table.map((r, i) => `| ${r.join(' | ')} |${i === 0 ? '\n|' + r.map(() => ' --- ').join('|') + '|' : ''}`).join('\n')] : []),
      ...(s.after || []),
    ].join('\n\n')).join('\n\n');
    return { text: md, markdown: true };
  }
  // Text layer or OCR lines: headings become plain lines, tables become flat lines in reading order.
  const plain = doc.sections.map(s => [s.h, ...s.paras, ...(s.table ? s.table.map(r => r.join(' ')) : []), ...(s.after || [])].join('\n')).join('\n');
  return { text: plain, markdown: false };
}

// Fixed-size chunking on word boundaries with token overlap (simplified Text Split behaviour).
function fixedChunks(text, size, overlapTok) {
  const w = text.split(/(\s+)/).filter(x => x.length);
  const tokens = w.filter(x => x.trim()).map(x => x);
  const chunks = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i, cur = '';
    while (j < tokens.length && estTokens(cur + ' ' + tokens[j]) <= size) { cur += (cur ? ' ' : '') + tokens[j]; j++; }
    if (j === i) { cur = tokens[j]; j++; }
    chunks.push(cur);
    if (j >= tokens.length) break;
    let back = j, ov = '';
    while (overlapTok > 0 && back > i + 1 && estTokens(tokens[back - 1] + ' ' + ov) <= overlapTok) { ov = tokens[back - 1] + (ov ? ' ' + ov : ''); back--; }
    i = back;
  }
  return chunks;
}

// Layout-aware chunking: one chunk per markdown section; tables never split; heading repeated if a section is split.
function layoutChunks(md, size) {
  const sections = md.split(/\n(?=#{1,3} )/);
  const out = [];
  for (const sec of sections) {
    if (estTokens(sec) <= size) { out.push(sec); continue; }
    const [heading, ...blocks] = sec.split('\n\n');
    let cur = heading;
    for (const b of blocks) {
      if (estTokens(cur + '\n\n' + b) > size && cur !== heading) { out.push(cur); cur = heading + '\n\n' + b; }
      else cur += '\n\n' + b;
    }
    out.push(cur);
  }
  return out;
}

function ingest(p) {
  const doc = DOCS[p.document] || DOCS.handbook;
  const steps = [];
  const size = Number(p.chunkSize);
  const overlapTok = Math.round(size * Number(p.overlap) / 100);

  steps.push(step('source', 'Document received', `${doc.label}.${doc.scanned ? ' Pages are images: there is no text layer.' : ' Has a text layer.'}`, { scanned: doc.scanned, approxTokens: doc.fullTokens ? `${doc.fullTokens} (estimate for the full document)` : undefined }, 'info'));

  // Extraction
  const ex = extract(doc, p.ocr);
  if (!ex.text) {
    steps.push(step('extract', 'Extracted text is empty', 'Text-layer extraction returns nothing for an image-only PDF. The indexer still reports success: this is a silent failure that only shows up as unanswerable questions.', { contentLength: 0, ocr: 'off' }, 'warn'));
  } else {
    const how = p.ocr === 'layout' ? 'Layout model: markdown headings and a pipe table.' : p.ocr === 'ocr' ? (doc.scanned ? 'OCR read the scanned page: lines in reading order, table flattened into lines.' : 'OCR on a digital PDF: works, but the text layer was already available.') : 'Text layer: lines in reading order, headings and tables flattened.';
    steps.push(step('extract', p.ocr === 'layout' ? 'Layout extraction (markdown)' : p.ocr === 'ocr' ? 'OCR extraction' : 'Text layer extraction', `${how} ${estTokens(ex.text)} tokens (est.)${doc.fullTokens ? ' in the excerpt' : ''}.`,
      { chars: ex.text.length, markdown: ex.markdown, preview: ex.text.slice(0, 120) }, doc.scanned && p.ocr === 'ocr' ? 'ok' : 'ok'));
  }

  // Chunking
  let chunks = [];
  let mode = p.chunking;
  if (ex.text) {
    if (mode === 'layout' && !ex.markdown) {
      steps.push(step('chunk', 'No structure to chunk on', 'Layout-aware chunking needs markdown headings from a layout model. Falling back to fixed-size chunking.', { requested: 'layout', used: 'fixed' }, 'warn'));
      mode = 'fixed';
    }
    if (mode === 'none') chunks = [ex.text];
    else if (mode === 'fixed') chunks = fixedChunks(ex.text, size, overlapTok);
    else chunks = layoutChunks(ex.text, size);
    steps.push(step('chunk', mode === 'none' ? 'No chunking: one chunk per document' : mode === 'fixed' ? 'Fixed-size chunking' : 'Layout-aware chunking',
      mode === 'none' ? 'The whole document becomes one search document and one embedding.' : `${chunks.length} chunks, max ${size} tokens${mode === 'fixed' ? `, overlap ${overlapTok} tokens` : ', split at headings, tables kept whole'}.`,
      { skill: '#Microsoft.Skills.Text.SplitSkill', textSplitMode: 'pages', unit: 'azureOpenAITokens', maximumPageLength: mode === 'none' ? null : size, pageOverlapLength: mode === 'fixed' ? overlapTok : 0, chunks: chunks.length }));
  } else {
    steps.push(step('chunk', 'Nothing to chunk', '0 chunks produced.', { chunks: 0 }, 'warn'));
  }

  // Embedding
  const tokOf = c => (mode === 'none' && doc.fullTokens ? doc.fullTokens : estTokens(c));
  const tooBig = chunks.filter(c => tokOf(c) > EMBED_LIMIT);
  if (tooBig.length) {
    steps.push(step('embed', 'Chunk exceeds the embedding input limit', `One chunk is ~${tokOf(tooBig[0])} tokens (estimate) but the embedding model accepts about ${EMBED_LIMIT} tokens per input (documented limit at time of writing). The embedding call fails (or the input is truncated, silently losing most of the manual).`,
      { chunkTokens: tokOf(tooBig[0]), limit: EMBED_LIMIT, model: 'text-embedding-3-small' }, 'error'));
  } else if (chunks.length) {
    steps.push(step('embed', 'Embeddings generated', `${chunks.length} vectors with text-embedding-3-small (Azure OpenAI Embedding skill or integrated vectorization).`, { vectors: chunks.length, dims: 1536 }));
  } else {
    steps.push(step('embed', 'No vectors', 'Nothing to embed.', null, 'skip'));
  }

  // Index + retrieval test
  const has = (c, k) => c.toLowerCase().includes(k.toLowerCase());
  const scored = chunks.map((c, i) => ({ i, c, keys: doc.keys.filter(k => has(c, k)) })).sort((a, b) => b.keys.length - a.keys.length || a.i - b.i);
  const best = scored[0];
  const complete = !!best && best.keys.length === doc.keys.length && !tooBig.length;
  if (!tooBig.length) {
    if (!chunks.length) {
      steps.push(step('retrieve', 'Question cannot be grounded', `"${doc.question}": no chunks exist, so retrieval returns nothing and the model must answer without sources.`, { retrieved: 0 }, 'error'));
    } else if (complete) {
      steps.push(step('retrieve', 'Answer found in one chunk', `Top chunk #${best.i + 1} contains ${doc.keys.map(k => `"${k}"`).join(', ')}. The model can answer: "${doc.answer}"`, { topChunk: best.i + 1, keysFound: best.keys }));
    } else {
      const where = doc.keys.map(k => `"${k}" → ${chunks.findIndex(c => has(c, k)) >= 0 ? 'chunk ' + (chunks.findIndex(c => has(c, k)) + 1) : 'cut in half across a boundary'}`);
      steps.push(step('retrieve', 'Answer split across chunks', `The facts needed are in different chunks (${where.join(', ')}). The top chunk alone lacks ${doc.keys.filter(k => !best.keys.includes(k)).map(k => `"${k}"`).join(', ')}, so the model may guess or say it does not know.`,
        { topChunk: best.i + 1, keysFound: best.keys, missing: doc.keys.filter(k => !best.keys.includes(k)) }, 'warn'));
    }
  }

  // Output
  const output = [];
  if (chunks.length) {
    output.push({ type: 'table', title: `Chunks produced (${chunks.length})`, columns: ['#', 'Tokens (est.)', 'Text', 'Answer facts'],
      rows: chunks.map((c, i) => [String(i + 1), String(tokOf(c)), c.length > 220 ? c.slice(0, 220) + '…' : c, doc.keys.filter(k => has(c, k)).join(', ') || '—']),
      tones: chunks.map((c, i) => tokOf(c) > EMBED_LIMIT ? 'error' : best && i === best.i ? (complete ? 'ok' : 'warn') : 'info') });
    output.push({ type: 'bars', title: 'Chunk size vs configured maximum', threshold: mode === 'none' ? undefined : 1,
      items: chunks.map((c, i) => ({ label: `#${i + 1}`, value: tokOf(c), max: mode === 'none' ? Math.max(tokOf(c), 1) : Math.max(size, tokOf(c)), tone: tokOf(c) > EMBED_LIMIT ? 'error' : 'ok' })) });
  } else {
    output.push({ type: 'alert', tone: 'error', text: 'Index contains a document with empty content. Turn on OCR or a layout model for scanned PDFs.' });
  }
  output.push({ type: 'chat', title: 'Retrieval test (simulated)', turns: [
    { role: 'user', text: doc.question },
    { role: 'tool', text: chunks.length && !tooBig.length ? `search → top chunk #${best.i + 1}: ${best.c.slice(0, 140)}${best.c.length > 140 ? '…' : ''}` : 'search → 0 results', meta: 'top=1' },
    { role: 'assistant', text: complete ? doc.answer : chunks.length && !tooBig.length ? 'The retrieved passage does not contain enough information to answer reliably.' : 'I could not find this in the indexed documents.' },
  ] });
  if (ex.text) output.push({ type: 'code', title: 'Extracted text (what the chunker sees)', lang: ex.markdown ? 'markdown' : 'text', text: ex.text });

  const totalTok = chunks.reduce((a, c) => a + estTokens(c), 0);
  const srcTok = ex.text ? estTokens(ex.text) : 0;
  return {
    steps, output,
    metrics: [
      metric('Answer completeness', complete ? 'complete' : chunks.length && best ? `${best.keys.length}/${doc.keys.length} facts in top chunk` : 'none', 'computed', 'Facts needed to answer that co-occur in the best chunk.'),
      metric('Chunks', String(chunks.length), 'computed'),
      metric('Mean tokens per chunk', chunks.length ? String(round(totalTok / chunks.length, 0)) : '0', 'estimate', 'Uses the ~4 characters per token heuristic, not a tokenizer.'),
      metric('Overlap overhead', srcTok ? `${Math.max(0, Math.round((totalTok / srcTok - 1) * 100))}%` : '0%', 'estimate', 'Extra tokens stored and embedded because of overlap (and repeated headings).'),
    ],
    summary: hasError({ steps }) ? `${doc.label.split(' (')[0]}: ${steps.at(-1).title}` : `${p.ocr}/${mode} ${size}t ov${p.overlap}%: ${chunks.length} chunks, ${complete ? 'answer complete' : 'answer split'}`,
  };
}

export default {
  id: '5.1.4',
  lab: 'RAG chunking & OCR bench',
  services: [
    { name: 'Chunk documents for vector search', url: 'https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents' },
    { name: 'Text Split skill', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-skill-textsplit' },
    { name: 'Document Layout skill', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-skill-document-intelligence-layout' },
    { name: 'Azure OpenAI embeddings models', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models' },
  ],
  prereqs: ['5.1.1', '5.1.3'],
  next: ['5.1.2', '2.1.2'],

  concept: {
    plain: 'RAG only works if the right passage can be found and contains the whole answer. Ingestion turns files into text (scanned files need OCR or nothing comes out), cuts the text into chunks small enough to embed and to fit in a prompt, and stores each chunk with a vector. Cut in the wrong place and a table header ends up in one chunk and its values in another, so the model sees "250 GBP" without knowing what it is.',
    technical: 'A typical Azure ingestion flow: Blob Storage → indexer → extraction (text layer, OcrSkill, or DocumentIntelligenceLayoutSkill producing markdown sections) → chunking (SplitSkill with textSplitMode pages, maximumPageLength, pageOverlapLength and unit characters or azureOpenAITokens; or layout-aware chunking at markdown headings) → AzureOpenAIEmbeddingSkill → index projections that write one search document per chunk with a parent key. Chunks must respect the embedding model\'s input limit, and overlap or structure-aware splitting keeps related facts together. The same flow is available through the Foundry portal "import and vectorize data" wizard.',
    useCase: 'A procurement assistant answers "who approves a 20,000 GBP purchase?" from an approval matrix that only exists as a scanned PDF. Without OCR the index holds an empty document; with layout extraction and heading-based chunking, the matrix table stays in one chunk with its header and the agent answers with a citation.',
    terms: [
      ['OCR', 'Recognises text in images and scanned pages; required when a PDF has no text layer.'],
      ['Chunk', 'A passage stored as its own search document with its own vector.'],
      ['Overlap', 'Tokens repeated at the start of the next chunk so facts near a boundary appear together.'],
      ['Layout-aware chunking', 'Splitting at headings/sections and never inside tables, using layout model markdown.'],
      ['Index projection', 'Skillset feature that writes each chunk to the index as a child document linked to its parent.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'source', label: p ? DOCS[p.document].label.split(' (')[0] : 'Document', col: 0, row: 1, kind: 'data', detail: 'Digital PDFs have a text layer; scanned PDFs are images.' },
          { id: 'extract', label: p ? { none: 'Text layer only', ocr: 'OCR', layout: 'Layout → markdown' }[p.ocr] : 'Extract', col: 1, row: 1, detail: 'Gets text out: text layer, OCR lines, or layout markdown with headings and tables.', substeps: ['Text layer', 'OCR for images', 'Layout: headings, tables'] },
          { id: 'chunk', label: p ? `Chunk: ${p.chunking}${p.chunking !== 'none' ? ` ${p.chunkSize}t` : ''}` : 'Chunk', col: 2, row: 1, detail: 'Fixed-size with overlap, or at structure boundaries.', badge: p && p.chunking === 'fixed' ? `overlap ${p.overlap}%` : undefined },
          { id: 'embed', label: 'Embed', col: 3, row: 0, detail: 'One vector per chunk. Each input must fit the model limit.' },
          { id: 'index', label: 'Index chunks', col: 3, row: 2, detail: 'One search document per chunk + parent id + source page.' },
          { id: 'retrieve', label: 'Retrieve & answer', col: 4, row: 1, kind: 'user', detail: 'Top chunk(s) go into the prompt. The answer must be inside them.' },
        ],
        edges: [['source', 'extract'], ['extract', 'chunk'], ['chunk', 'embed'], ['embed', 'index'], ['index', 'retrieve']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'source', label: 'Blob Storage (PDFs)', col: 0, row: 1, kind: 'store', detail: 'Source container.' },
          { id: 'extract', label: p && p.ocr === 'layout' ? 'Document Layout skill (Foundry resource)' : p && p.ocr === 'ocr' ? 'OCR skill (Foundry resource)' : 'Indexer document cracking', col: 1, row: 1, kind: 'ai', detail: 'OCR needs imageAction=generateNormalizedImages; Layout needs allowSkillsetToReadFileData.' },
          { id: 'chunk', label: 'Text Split skill / layout sections', col: 2, row: 1, kind: 'compute', detail: 'Runs inside the skillset.' },
          { id: 'embed', label: 'Azure OpenAI embedding deployment', col: 3, row: 0, kind: 'ai', detail: 'Called by the AzureOpenAIEmbeddingSkill with the search service managed identity.' },
          { id: 'index', label: 'Azure AI Search index (chunks)', col: 3, row: 2, kind: 'data', detail: 'Index projections: chunk_id key, parent_id, chunk, vector, page.' },
          { id: 'retrieve', label: 'RAG app / agent', col: 4, row: 1, kind: 'app', detail: 'Hybrid query over chunks; cites parent document and page.' },
        ],
        edges: [['source', 'extract'], ['extract', 'chunk'], ['chunk', 'embed'], ['embed', 'index'], ['index', 'retrieve', 'query']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'source', label: 'indexer.parameters.configuration.imageAction = "generateNormalizedImages"', col: 0, row: 0, kind: 'code', detail: 'For the OCR route.' },
          { id: 'extract', label: p && p.ocr === 'layout' ? 'DocumentIntelligenceLayoutSkill(output_mode="oneToMany", markdown_header_depth="h3")' : 'OcrSkill(context="/document/normalized_images/*") + MergeSkill', col: 0, row: 1, kind: 'code', detail: 'Illustrative class/parameter names.' },
          { id: 'chunk', label: `SplitSkill(text_split_mode="pages", maximum_page_length=${p ? p.chunkSize : 200}, page_overlap_length=${p ? Math.round(p.chunkSize * p.overlap / 100) : 0}, unit="azureOpenAITokens")`, col: 0, row: 2, kind: 'code', detail: 'Check parameter availability for your API version.' },
          { id: 'embed', label: 'AzureOpenAIEmbeddingSkill(context="/document/pages/*", deployment_name="text-embedding-3-small")', col: 0, row: 3, kind: 'code', detail: 'Writes /document/pages/*/vector.' },
          { id: 'index', label: 'SearchIndexerIndexProjection(selectors=[… source_context="/document/pages/*", parent_key_field_name="parent_id"])', col: 0, row: 4, kind: 'code', detail: 'One index document per chunk.' },
          { id: 'retrieve', label: 'search_client.search(q, vector_queries=[VectorizableTextQuery(q, k_nearest_neighbors=3, fields="vector")])', col: 0, row: 5, kind: 'code', detail: 'Query the chunks.' },
        ],
        edges: [['source', 'extract'], ['extract', 'chunk'], ['chunk', 'embed'], ['embed', 'index'], ['index', 'retrieve']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Document', type: 'select', options: Object.entries(DOCS).map(([v, d]) => [v, d.label]), default: 'handbook' },
      { id: 'ocr', label: 'Extraction', type: 'select', options: [['none', 'Text layer only (no OCR)'], ['ocr', 'OCR skill'], ['layout', 'Layout model → markdown']], default: 'none' },
      { id: 'chunking', label: 'Chunking strategy', type: 'select', options: [['none', 'None (whole document)'], ['fixed', 'Fixed size + overlap'], ['layout', 'Layout-aware (headings, tables intact)']], default: 'fixed' },
      { id: 'chunkSize', label: 'Max chunk size (tokens, est.)', type: 'range', min: 20, max: 300, step: 10, default: 30 },
      { id: 'overlap', label: 'Overlap (% of chunk size)', type: 'range', min: 0, max: 50, step: 5, default: 0 },
    ],
    samples: [
      { label: 'Handbook, small fixed chunks, no overlap', values: { document: 'handbook', ocr: 'none', chunking: 'fixed', chunkSize: 30, overlap: 0 } },
      { label: 'Handbook, layout-aware', values: { document: 'handbook', ocr: 'layout', chunking: 'layout', chunkSize: 80 } },
      { label: 'Scanned matrix without OCR', values: { document: 'scanned', ocr: 'none' } },
      { label: 'Scanned matrix with OCR', values: { document: 'scanned', ocr: 'ocr', chunking: 'fixed', chunkSize: 60, overlap: 20 } },
      { label: 'Long manual, no chunking', values: { document: 'manual', chunking: 'none' } },
    ],
    run: ingest,
  },

  compare: {
    suggestions: [
      'Run the handbook with fixed 30-token chunks at 0% overlap, then 25% overlap, then layout-aware chunking. Compare answer completeness and overlap overhead.',
      'Run the scanned matrix with text layer only, OCR, and layout. Watch the empty-content silent failure.',
      'Run the long manual with no chunking, then fixed 200-token chunks.',
    ],
  },

  debug: [
    { id: 'noocr', title: 'Scanned PDF indexed but never retrieved', values: { document: 'scanned', ocr: 'none', chunking: 'fixed' }, node: 'extract',
      symptom: 'Indexer succeeds; the question returns no grounded answer.', cause: 'Image-only PDF has no text layer and OCR is off, so content is empty.', fix: 'Enable OCR (with normalized images) or the layout model.' },
    { id: 'toolarge', title: 'Embedding call fails for the manual', values: { document: 'manual', ocr: 'none', chunking: 'none' }, node: 'embed',
      symptom: 'Embedding skill error: input too long (or silent truncation).', cause: 'The whole ~60k-token manual is one chunk; embedding models have an input limit.', fix: 'Chunk the document (fixed or layout-aware) well below the model limit.' },
    { id: 'split', title: 'Table header separated from its rows', values: { document: 'handbook', ocr: 'none', chunking: 'fixed', chunkSize: 30, overlap: 0 }, node: 'chunk',
      symptom: 'Retrieved chunk contains "London 250 GBP" but not what the number means (or vice versa).', cause: 'Fixed-size boundary falls inside the table and there is no overlap.', fix: 'Use layout-aware chunking (keeps tables whole) or add overlap / larger chunks.' },
    { id: 'nolayout', title: 'Layout chunking silently falls back', values: { document: 'handbook', ocr: 'ocr', chunking: 'layout', chunkSize: 40 }, node: 'chunk',
      symptom: 'Warning: no structure to chunk on.', cause: 'OCR output has no markdown headings; layout-aware chunking needs the layout model.', fix: 'Set extraction to Layout model → markdown.' },
  ],

  challenge: {
    task: 'Make the scanned approval matrix answerable from a single chunk while keeping chunks small (≤ 120 tokens) and avoiding warnings.',
    condition: 'Document = scanned matrix, chunk size ≤ 120, answer completeness = complete, no warn/error steps.',
    hint: 'First get text out of the image, then keep the table together with its header.',
    check: (p, res) => p.document === 'scanned' && Number(p.chunkSize) <= 120 && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.metrics.some(m => m.label === 'Answer completeness' && m.value === 'complete'),
    solution: ['Extraction: Layout model → markdown (OCR alone also reads the page but flattens structure).', 'Chunking: layout-aware so the "Approval thresholds" section and its table stay together.', 'Chunk size: 80–120 tokens.'],
    solutionValues: { document: 'scanned', ocr: 'layout', chunking: 'layout', chunkSize: 100, overlap: 0 },
  },

  quiz: [
    { q: 'An indexer processes 500 scanned PDFs with no errors, but RAG answers never cite them. What is the most likely cause?', options: ['The vector dimensions are too small', 'The PDFs have no text layer and OCR/layout extraction is not configured', 'The semantic ranker is off', 'Overlap is set to 0'], answer: 1, why: 'Image-only PDFs produce empty content without OCR. Indexers report success, so check content length after ingestion.' },
    { q: 'Answers about a pricing table are often wrong: the retrieved chunk has the values but not the column headers. Which change helps most?', options: ['Reduce top-k to 1', 'Layout-aware chunking that keeps tables intact, or more overlap', 'Switch to keyword search', 'Use a larger embedding model'], answer: 1, why: 'The problem is where the text is cut. Structure-aware chunking (or overlap) keeps headers and values together.' },
    { q: 'You embed whole 100-page manuals as single documents. What goes wrong?', options: ['Nothing; larger inputs give better vectors', 'Inputs exceed the embedding model limit (errors or truncation), and retrieval returns huge, unfocused passages', 'BM25 stops working', 'Index projections are required for keyword search'], answer: 1, why: 'Embedding models have an input token limit and one vector cannot represent 100 pages well. Chunk first.' },
  ],

  recap: 'Ingestion for RAG: extract (OCR or layout for scanned files, or you index empty documents), chunk (respect the embedding input limit; keep related facts together with overlap or layout-aware splitting), embed, and index each chunk with its parent and page. Test with real questions and check that the answer lands in one chunk.',
};
