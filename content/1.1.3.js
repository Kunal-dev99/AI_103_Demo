// 1.1.3 Choose an appropriate method for retrieval and indexing
// Lab: Retrieval method chooser (toy index you can query).
import { rng, round, step, metric, words, estTokens, coverage } from '../src/engine/util.js';

// Toy corpus: one long service manual split into sections, plus short KB articles.
// concepts = a stand-in for an embedding: texts that share concepts are "close" in vector space,
// even when they share no words (including across languages).
const SECTIONS = [
  { id: 'm1', doc: 'manual', title: 'PX-220 Service Manual – Overheating', text: 'Thermal protection trips when the motor exceeds rated temperature during long duty cycles. Clean the intake filter and check coolant flow.', concepts: ['overheat', 'temperature', 'maintenance', 'pump'] },
  { id: 'm2', doc: 'manual', title: 'PX-220 Service Manual – Error codes', table: true, text: 'PX-220 codes. Code | Meaning | Fix\nE-4012 | Seal pressure loss | Replace shaft seal kit SK-77\nE-4020 | Sensor fault | Reseat sensor cable', concepts: ['errorcode', 'pump', 'seal', 'pressure'],
    halves: [
      { text: 'PX-220 codes. Code | Meaning | Fix\nE-4012 | Seal pressure loss |', concepts: ['errorcode', 'pump', 'pressure'] },
      { text: 'Replace shaft seal kit SK-77\nE-4020 | Sensor fault | Reseat sensor cable', concepts: ['seal', 'repair', 'sensor'] },
    ] },
  { id: 'm3', doc: 'manual', title: 'PX-220 Service Manual – Restart procedure', text: 'To restart the unit, isolate power, wait 30 seconds, then hold the reset button for 5 seconds until the status light is green.', concepts: ['restart', 'pump', 'procedure'] },
  { id: 'm4', doc: 'manual', title: 'PX-220 Service Manual – Warranty', text: 'The warranty covers parts and labour for 24 months from installation when serviced by an approved technician.', concepts: ['warranty', 'policy'] },
  { id: 'k1', doc: 'kb-118', title: 'KB-118 Fitting seal kit SK-77', text: 'Fixing a leaking shaft seal: drain the housing, remove the impeller, fit the SK-77 kit and torque the bolts to specification.', concepts: ['seal', 'leak', 'repair', 'pump'] },
  { id: 'k2', doc: 'kb-204', title: 'KB-204 Why machines run hot on long shifts', text: 'Heat build-up on extended runs is usually caused by blocked air intakes or low coolant. Schedule cleaning every 200 operating hours.', concepts: ['overheat', 'temperature', 'maintenance'] },
  { id: 'k3', doc: 'kb-031', title: 'KB-031 PX-110 error E-4012', text: 'On the older PX-110 model this code means a firmware mismatch after a controller swap. Update the controller firmware.', concepts: ['errorcode', 'pump', 'firmware'] },
  { id: 'k4', doc: 'kb-009', title: 'KB-009 Lockout / tagout before maintenance', text: 'Always isolate and lock out electrical supply before opening any housing. Tag the isolator with your name and date.', concepts: ['safety', 'procedure', 'maintenance'] },
];

const QUERIES = {
  id: { label: 'Exact identifier: "E-4012 PX-220"', text: 'E-4012 PX-220', concepts: ['errorcode', 'pump'], relevant: ['m2'] },
  paraphrase: { label: 'Paraphrase: "why does the machine get so hot after running all day"', text: 'why does the machine get so hot after running all day', concepts: ['overheat', 'temperature'], relevant: ['m1', 'k2'] },
  multilingual: { label: 'Spanish: "¿Cómo reinicio la bomba?"', text: '¿Cómo reinicio la bomba?', concepts: ['restart', 'pump'], relevant: ['m3'] },
  mixed: { label: 'Mixed: "E-4012 keeps coming back, how do I fix the leak"', text: 'E-4012 keeps coming back, how do I fix the leak', concepts: ['errorcode', 'seal', 'leak', 'repair'], relevant: ['m2', 'k1'] },
};

const STOP = new Set(['the', 'and', 'how', 'does', 'get', 'so', 'do', 'all', 'after', 'why', 'keeps', 'coming', 'back', 'la', 'is', 'a', 'of', 'to', 'on', 'or', 'for', 'when', 'any', 'with', 'your', 'from', 'by', 'then', 'until', 'i']);
const terms = t => words(t).filter(w => !STOP.has(w));
const jac = (a, b) => { const A = new Set(a), B = new Set(b); let n = 0; for (const x of A) if (B.has(x)) n++; return A.size + B.size ? n / (A.size + B.size - n) : 0; };

function buildUnits(chunking) {
  if (chunking === 'none') {
    const byDoc = {};
    for (const s of SECTIONS) {
      const u = byDoc[s.doc] || (byDoc[s.doc] = { id: s.doc, title: s.doc === 'manual' ? 'PX-220 Service Manual (whole document)' : s.title, text: '', concepts: [], sections: [] });
      u.text += (u.text ? '\n' : '') + `${s.title}. ${s.text}`;
      u.concepts.push(...s.concepts);
      u.sections.push(s.id);
    }
    return Object.values(byDoc).map(u => ({ ...u, concepts: [...new Set(u.concepts)] }));
  }
  const out = [];
  for (const s of SECTIONS) {
    if (chunking === 'fixed' && s.halves) {
      s.halves.forEach((h, i) => out.push({ id: `${s.id}#${i + 1}`, title: `${s.title} (chunk ${i + 1}/2)`, text: `${i === 0 ? s.title + '. ' : ''}${h.text}`, concepts: h.concepts, sections: [s.id], split: true }));
    } else out.push({ id: s.id, title: s.title, text: `${s.title}. ${s.text}`, concepts: s.concepts, sections: [s.id] });
  }
  return out;
}

function bm25(units, query) {
  const q = [...new Set(terms(query))];
  const docs = units.map(u => terms(u.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  return units.map((u, i) => {
    const d = docs[i];
    let s = 0;
    for (const t of q) {
      const tf = d.filter(w => w === t).length;
      if (!tf) continue;
      const n = docs.filter(x => x.includes(t)).length;
      const idf = Math.log(1 + (units.length - n + 0.5) / (n + 0.5));
      s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    return round(s, 3);
  });
}

const rankOf = scores => { const idx = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a] || a - b); const r = []; idx.forEach((i, k) => { r[i] = scores[i] > 0 ? k + 1 : Infinity; }); return r; };

function retrieve(p) {
  const q = QUERIES[p.query];
  const units = buildUnits(p.chunking);
  const r = rng(`${p.query}|${p.chunking}`);
  const kw = bm25(units, q.text);
  const vec = units.map(u => round(jac(q.concepts, u.concepts) * (u.concepts.length > 6 ? 0.55 : 1) + r() * 0.01, 3));
  const kwRank = rankOf(kw), vecRank = rankOf(vec);
  const rrf = units.map((u, i) => round((kwRank[i] < Infinity ? 1 / (60 + kwRank[i]) : 0) + (vecRank[i] < Infinity ? 1 / (60 + vecRank[i]) : 0), 4));
  let base;
  if (p.method === 'keyword') base = kw;
  else if (p.method === 'vector') base = vec;
  else base = rrf;
  let final = base;
  if (p.method === 'semantic') {
    // Simulated L2 re-ranker: re-scores the top 50 (all units here) on meaning + exact-term evidence.
    const idTokens = words(q.text).filter(w => /\d/.test(w));
    final = units.map((u, i) => base[i] > 0 ? round(0.55 * jac(q.concepts, u.concepts) * (u.concepts.length > 6 ? 0.6 : 1) + 0.3 * coverage(q.text, u.text) + (idTokens.length && idTokens.every(t => words(u.text).includes(t)) && words(u.text).some(w => /220/.test(w)) ? 0.3 : 0) + 0.15 * (rrf[i] * 30), 3) : 0);
  }
  const order = units.map((u, i) => i).filter(i => final[i] > 0).sort((a, b) => final[b] - final[a] || a - b);
  const top = order.slice(0, p.topK).map(i => ({ u: units[i], i }));
  return { q, units, kw, vec, rrf, final, top };
}

function runLab(p) {
  const steps = [];
  const q = QUERIES[p.query];
  const units = buildUnits(p.chunking);
  // 1. Chunking
  const chunkMsg = { none: 'Whole documents indexed as single items: the 4-section manual becomes one large chunk.', fixed: 'Fixed-size chunks with overlap (in this toy corpus the error-code table straddles a chunk boundary and is split).', layout: 'Layout/heading-aware chunks: each section and table stays intact (for example using Document Intelligence layout markdown + a heading-based split).' }[p.chunking];
  steps.push(step('corpus', 'Chunking', `${SECTIONS.length} source sections → ${units.length} index items. ${chunkMsg}`, { chunking: p.chunking, items: units.map(u => u.id) }, p.chunking === 'none' ? 'warn' : 'ok'));
  // 2. Ingestion
  const freshness = { static: 'rarely (monthly)', hourly: 'hourly', seconds: 'within seconds of a change' }[p.freshness];
  if (p.ingestion === 'indexer') {
    const late = p.freshness === 'seconds';
    steps.push(step('ingest', late ? 'Indexer schedule cannot meet freshness target' : 'Integrated vectorization (indexer + skillset)',
      late ? 'Indexers run on a schedule (intervals of minutes, not seconds) or on demand. For changes that must be searchable within seconds, push documents with the push API from your app or an event-driven function.' : 'A data-source indexer pulls content, a skillset splits text and calls an embedding skill, and the index holds a vectorizer so queries can be vectorized by the service. Least code; runs on a schedule.',
      { pattern: 'indexer + skillset (Text Split + Azure OpenAI Embedding) + index vectorizer', freshnessTarget: freshness }, late ? 'warn' : 'ok'));
  } else {
    steps.push(step('ingest', 'Push API from your code', `Your code chunks, embeds and uploads documents (SearchClient.upload_documents / merge_or_upload). Fresh ${freshness}. You own retries, batching and deletes.${p.freshness === 'static' ? ' For a rarely changing corpus an indexer would be less code to maintain.' : ''}`,
      { pattern: 'push API', freshnessTarget: freshness }, p.freshness === 'static' ? 'info' : 'ok'));
  }
  // 3. Index schema / query vectorization
  const usesVectors = p.method !== 'keyword';
  if (usesVectors && p.queryModel === 'different') {
    steps.push(step('index', 'Vector query rejected', 'The index field contentVector was built with text-embedding-3-large (3072 dimensions) but the query vector came from text-embedding-3-small (1536). The service rejects a dimension mismatch; even same-size vectors from different models are not comparable.',
      { field: 'contentVector', fieldDimensions: 3072, queryDimensions: 1536, httpStatus: 400 }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Queries must be embedded with the same model (and dimensions) as the indexed vectors. Use the index vectorizer or the same embedding deployment in your code.' }], metrics: [], summary: `${p.method}: vector dimension mismatch` };
  }
  steps.push(step('index', 'Index schema', usesVectors ? 'Searchable text field (BM25) + vector field (HNSW) with a vector profile; semantic configuration names the title and content fields.' : 'Searchable text field only (BM25). No vectors needed for keyword search.',
    { fields: ['id (key)', 'title (searchable)', 'content (searchable)', ...(usesVectors ? ['contentVector (Collection(Edm.Single), 3072 dims)'] : []), 'doc (filterable)'], semanticConfiguration: p.method === 'semantic' ? 'default' : null }));
  // 4. Query
  const { kw, vec, rrf, final, top } = retrieve(p);
  const methodLabel = { keyword: 'Keyword (BM25)', vector: 'Vector (HNSW, cosine)', hybrid: 'Hybrid (BM25 + vector, RRF)', semantic: 'Hybrid + semantic ranker' }[p.method];
  steps.push(step('query', `Query: ${methodLabel}`, `"${q.text}" → ${top.length} result(s) at top=${p.topK}.`, { search: p.method === 'vector' ? null : q.text, vectorQueries: usesVectors ? [{ kind: p.ingestion === 'indexer' ? 'text' : 'vector', fields: 'contentVector', k: 50 }] : [], queryType: p.method === 'semantic' ? 'semantic' : 'simple', top: p.topK }));
  // 5. Ranking quality
  const hitSections = new Set(top.flatMap(t => t.u.sections));
  const found = q.relevant.filter(id => hitSections.has(id));
  const recall = found.length / q.relevant.length;
  const top1 = top.length && top[0].u.sections.some(s => q.relevant.includes(s));
  const firstRel = top.findIndex(t => t.u.sections.some(s => q.relevant.includes(s)));
  const mrr = firstRel >= 0 ? 1 / (firstRel + 1) : 0;
  const tokens = top.reduce((a, t) => a + estTokens(t.u.text), 0);
  const issues = [];
  if (recall < 1) issues.push(`missed ${q.relevant.length - found.length} relevant section(s)`);
  if (!top1) issues.push(`top result is not relevant (${top.length ? top[0].u.title : 'no results'})`);
  if (p.chunking === 'none' && top.some(t => t.u.sections.length > 1)) issues.push('a whole multi-section document was returned: the answer is buried and costs more tokens');
  const splitHit = top.find(t => t.u.split) ;
  if (splitHit && !top.some(t => t.u.split && t.u !== splitHit.u)) issues.push('the error-code table was split: the retrieved chunk lacks the other half (code or fix)');
  steps.push(step('rank', issues.length ? 'Relevance problems' : 'Relevant results ranked first', issues.length ? issues.join('; ') + '.' : `All ${q.relevant.length} relevant section(s) retrieved and the top result is relevant.`,
    { relevant: q.relevant, retrieved: top.map(t => t.u.id), recallAtK: round(recall, 2), mrr: round(mrr, 2) }, issues.length ? 'warn' : 'ok'));
  steps.push(step('results', 'Grounding context assembled', `${top.length} chunk(s), ≈${tokens} tokens (4-chars-per-token heuristic) passed to the model.`, { chunks: top.map(t => t.u.id), approxTokens: tokens }, 'info'));

  const rows = top.map(({ u, i }, k) => [String(k + 1), u.title, String(kw[i]), String(vec[i]), p.method === 'hybrid' || p.method === 'semantic' ? String(rrf[i]) : '—', p.method === 'semantic' ? String(final[i]) : '—', u.sections.some(s => q.relevant.includes(s)) ? 'yes' : 'no']);
  return {
    steps,
    output: [
      { type: 'table', title: `Top ${p.topK}: ${methodLabel}`, columns: ['#', 'Chunk', 'BM25', 'Vector sim', 'RRF', 'Semantic', 'Relevant?'], rows, tones: top.map(t => (t.u.sections.some(s => q.relevant.includes(s)) ? 'ok' : 'warn')) },
      { type: 'bars', title: 'Retrieval quality for this query', items: [{ label: `Recall@${p.topK}`, value: recall, tone: recall === 1 ? 'ok' : 'warn' }, { label: 'MRR', value: mrr, tone: mrr === 1 ? 'ok' : 'warn' }], threshold: 1 },
      { type: 'json', title: 'Search request body (illustrative REST shape)', data: { search: p.method === 'vector' ? '*' : q.text, vectorQueries: usesVectors ? [{ kind: p.ingestion === 'indexer' ? 'text' : 'vector', ...(p.ingestion === 'indexer' ? { text: q.text } : { vector: '[3072 floats from your embedding call]' }), fields: 'contentVector', k: 50 }] : undefined, queryType: p.method === 'semantic' ? 'semantic' : undefined, semanticConfiguration: p.method === 'semantic' ? 'default' : undefined, top: p.topK } },
      ...(issues.length ? [{ type: 'alert', tone: 'warn', text: issues.join('. ') + '.' }] : []),
    ],
    metrics: [
      metric(`Recall@${p.topK}`, `${found.length}/${q.relevant.length}`, 'computed', 'Relevant sections retrieved in the top K of this toy index.'),
      metric('Top-1 relevant', top1 ? 'yes' : 'no', 'computed'),
      metric('MRR', String(round(mrr, 2)), 'computed', 'Reciprocal rank of the first relevant result.'),
      metric('Context size', `≈${tokens} tokens`, 'estimate', '4 characters per token heuristic, not a tokenizer.'),
    ],
    summary: `${methodLabel} / ${p.chunking} chunks: recall ${found.length}/${q.relevant.length}, top-1 ${top1 ? 'ok' : 'wrong'}`,
  };
}

const allQueriesPass = p => Object.keys(QUERIES).every(k => {
  const r = runLab({ ...p, query: k });
  return !r.steps.some(s => s.status === 'error' || s.status === 'warn');
});

export default {
  id: '1.1.3',
  lab: 'Retrieval method chooser',
  services: [
    { name: 'Azure AI Search: hybrid search', url: 'https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview' },
    { name: 'Azure AI Search: semantic ranking', url: 'https://learn.microsoft.com/en-us/azure/search/semantic-search-overview' },
    { name: 'Integrated vectorization', url: 'https://learn.microsoft.com/en-us/azure/search/vector-search-integrated-vectorization' },
    { name: 'Chunk large documents for RAG', url: 'https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents' },
  ],
  prereqs: ['1.1.2'],
  next: ['5.1.1', '5.1.2', '2.1.2'],

  concept: {
    plain: 'Keyword search finds exact words, so it is great for part numbers and error codes but misses questions phrased differently. Vector search finds text with similar meaning, even in another language, but can blur look-alike identifiers. Hybrid search runs both and merges the lists; a semantic re-ranker then re-reads the best candidates to put the most useful one first. How you cut documents into chunks, and how you keep the index up to date, matter as much as the search method.',
    technical: 'Azure AI Search supports full-text (BM25) search, vector search (HNSW or exhaustive KNN over embedding fields), hybrid queries that fuse both result sets with Reciprocal Rank Fusion, and an optional semantic ranker that re-scores the top 50 results with a language-understanding model. Chunking strategy (fixed-size with overlap vs structure-aware using layout) controls what a vector represents. Ingestion is either pull (indexers + skillsets; integrated vectorization adds chunking and embedding skills plus a vectorizer for query-time embedding) or push (your code calls the documents API). Query vectors must come from the same embedding model and dimensions as the indexed field.',
    useCase: 'A manufacturer\'s field-service assistant must answer "E-4012 on PX-220" (exact codes), "why does it overheat after long shifts" (paraphrase) and Spanish questions from technicians. Hybrid + semantic ranking over layout-aware chunks handles all three; an indexer refreshes manuals nightly, while urgent service bulletins are pushed within seconds.',
    terms: [
      ['BM25', 'Keyword relevance scoring based on term frequency and rarity.'],
      ['Vector search', 'Nearest-neighbour search over embeddings; matches meaning rather than words.'],
      ['RRF', 'Reciprocal Rank Fusion: merges ranked lists by summing 1/(k + rank).'],
      ['Semantic ranker', 'Re-ranks the top results of a query with a language model and can return captions/answers.'],
      ['Integrated vectorization', 'Indexer + skillset that chunks and embeds content, plus a vectorizer that embeds query text at search time.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'corpus', label: p ? `Chunk: ${p.chunking}` : 'Chunking', col: 0, row: 1, kind: 'data', detail: 'Decide what a retrievable unit is: whole doc, fixed-size chunk, or layout-aware section.', substeps: ['Extract text', 'Split', 'Overlap', 'Attach metadata'] },
          { id: 'ingest', label: p ? (p.ingestion === 'indexer' ? 'Pull: indexer' : 'Push API') : 'Ingest', col: 1, row: 1, kind: 'compute', detail: 'Pull (scheduled indexer + skillset) or push (your code). Drives freshness and how much code you own.' },
          { id: 'index', label: 'Index', col: 2, row: 1, kind: 'store', detail: 'Text fields for BM25, vector fields for similarity, semantic configuration.' },
          { id: 'query', label: p ? `Query: ${p.method}` : 'Query', col: 3, row: 0, kind: 'app', detail: 'Keyword, vector, or hybrid (both, fused with RRF).', substeps: ['BM25 list', 'Vector list', 'RRF fusion'] },
          { id: 'rank', label: 'Semantic re-rank', col: 3, row: 2, kind: 'ai', disabled: p && p.method !== 'semantic', detail: 'Re-scores the top 50 by meaning; adds captions/answers.' },
          { id: 'results', label: 'Top-K → model', col: 4, row: 1, kind: 'ai', detail: 'The chunks that become grounding context.' },
        ],
        edges: [['corpus', 'ingest'], ['ingest', 'index'], ['index', 'query'], ['query', 'rank'], ['query', 'results'], ['rank', 'results']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'corpus', label: 'Blob Storage / SharePoint', col: 0, row: 1, kind: 'store', detail: 'Source documents.' },
          { id: 'ingest', label: p && p.ingestion === 'push' ? 'Function app (push)' : 'Indexer + skillset', col: 1, row: 1, kind: 'compute', detail: 'Pull: indexer runs Text Split + embedding skill. Push: your function chunks, embeds and uploads.' },
          { id: 'embed', label: 'Embedding deployment (Foundry)', col: 1, row: 2.5, kind: 'ai', disabled: p && p.method === 'keyword', detail: 'Same model must embed documents and queries.' },
          { id: 'index', label: 'Azure AI Search index', col: 2, row: 1, kind: 'store', detail: 'Text + vector fields, vectorizer, semantic config.' },
          { id: 'query', label: 'App / agent tool', col: 3, row: 1, kind: 'app', detail: 'Sends the query (text and/or vector).' },
          { id: 'rank', label: 'Semantic ranker', col: 2, row: 2.5, kind: 'ai', disabled: p && p.method !== 'semantic', detail: 'Built into Azure AI Search (billing/tier requirements apply; check the docs).' },
          { id: 'results', label: 'Chat model', col: 4, row: 1, kind: 'ai', detail: 'Answers from retrieved chunks.' },
        ],
        edges: [['corpus', 'ingest'], ['ingest', 'embed', 'embed chunks'], ['ingest', 'index', 'upload'], ['query', 'index', 'search'], ['index', 'rank'], ['query', 'results', 'context']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'corpus', label: 'SplitSkill(text_split_mode="pages", maximum_page_length=..., page_overlap_length=...)', col: 0, row: 0, kind: 'code', detail: 'Illustrative skill config for fixed-size chunking; layout-aware chunking uses the Document Layout skill.' },
          { id: 'ingest', label: p && p.ingestion === 'push' ? 'search_client.merge_or_upload_documents(batch)' : 'indexer_client.create_or_update_indexer(indexer)', col: 0, row: 1, kind: 'code', detail: 'azure-search-documents. Push vs pull.' },
          { id: 'index', label: 'SearchField("contentVector", Collection(Edm.Single), vector_search_dimensions=3072, vector_search_profile_name="hnsw")', col: 0, row: 2, kind: 'code', detail: 'Illustrative vector field definition.' },
          { id: 'query', label: p && p.method !== 'keyword' ? 'search(search_text=q, vector_queries=[VectorizableTextQuery(text=q, fields="contentVector", k_nearest_neighbors=50)])' : 'search(search_text=q)', col: 0, row: 3, kind: 'code', detail: 'VectorizableTextQuery needs a vectorizer on the index; otherwise send VectorizedQuery(vector=...).' },
          { id: 'rank', label: 'query_type="semantic", semantic_configuration_name="default"', col: 0, row: 4, kind: 'code', disabled: p && p.method !== 'semantic', detail: 'Turns on semantic ranking for the query.' },
          { id: 'results', label: `top=${p ? p.topK : 3}`, col: 0, row: 5, kind: 'code', detail: 'How many chunks reach the prompt.' },
        ],
        edges: [['corpus', 'ingest'], ['ingest', 'index'], ['index', 'query'], ['query', 'rank'], ['rank', 'results']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'query', label: 'Query', type: 'select', options: Object.entries(QUERIES).map(([v, q]) => [v, q.label]), default: 'id' },
      { id: 'method', label: 'Retrieval method', type: 'select', options: [['keyword', 'Keyword (BM25)'], ['vector', 'Vector'], ['hybrid', 'Hybrid (RRF)'], ['semantic', 'Hybrid + semantic ranker']], default: 'vector' },
      { id: 'chunking', label: 'Chunking', type: 'select', options: [['none', 'None (whole documents)'], ['fixed', 'Fixed-size with overlap'], ['layout', 'Layout / heading-aware']], default: 'fixed' },
      { id: 'topK', label: 'Top K', type: 'range', min: 1, max: 5, step: 1, default: 3 },
      { id: 'ingestion', label: 'Ingestion', type: 'select', options: [['indexer', 'Pull: indexer + integrated vectorization'], ['push', 'Push API from your code']], default: 'indexer' },
      { id: 'freshness', label: 'Freshness requirement', type: 'select', options: [['static', 'Rarely changes'], ['hourly', 'Hourly is fine'], ['seconds', 'Searchable within seconds']], default: 'hourly' },
      { id: 'queryModel', label: 'Query embedding model', type: 'select', options: [['same', 'Same as index (vectorizer)'], ['different', 'Different embedding model']], default: 'same' },
    ],
    samples: [
      { label: 'Error code, keyword only', values: { query: 'id', method: 'keyword', chunking: 'layout' } },
      { label: 'Paraphrase, keyword only', values: { query: 'paraphrase', method: 'keyword', chunking: 'layout' } },
      { label: 'Spanish question, vector', values: { query: 'multilingual', method: 'vector', chunking: 'layout' } },
      { label: 'Mixed query, hybrid + semantic', values: { query: 'mixed', method: 'semantic', chunking: 'layout' } },
    ],
    run: runLab,
  },

  compare: {
    suggestions: [
      'Query = exact identifier: run keyword, vector, hybrid and hybrid + semantic and compare the top-1 result.',
      'Query = paraphrase: compare keyword vs vector recall.',
      'Query = mixed with hybrid: compare chunking fixed vs layout and watch the split-table warning.',
    ],
  },

  debug: [
    { id: 'id-vector', title: 'Assistant describes the wrong pump model', values: { query: 'id', method: 'vector', chunking: 'layout' }, node: 'rank',
      symptom: 'Top result is the PX-110 article, not the PX-220 error table.', cause: 'Embeddings capture "error code on a pump" but blur exact identifiers; a look-alike article wins.', fix: 'Use hybrid (BM25 catches the exact tokens) with the semantic ranker.' },
    { id: 'paraphrase-kw', title: 'Paraphrased question misses the manual', values: { query: 'paraphrase', method: 'keyword', chunking: 'layout' }, node: 'query',
      symptom: 'Recall below 100%: the overheating manual section is never retrieved.', cause: 'The question shares no keywords with "thermal protection trips… rated temperature".', fix: 'Add vectors: hybrid or hybrid + semantic.' },
    { id: 'dims', title: 'Vector query returns HTTP 400', values: { method: 'hybrid', queryModel: 'different' }, node: 'index',
      symptom: 'Search fails with a dimension mismatch.', cause: 'Query was embedded with a different model than the indexed vectors.', fix: 'Use the same embedding model (ideally the index vectorizer) for queries.' },
    { id: 'whole-doc', title: 'Answers are vague and expensive', values: { query: 'multilingual', method: 'hybrid', chunking: 'none' }, node: 'corpus',
      symptom: 'The whole manual is returned as one chunk; context is large.', cause: 'No chunking: one vector represents four unrelated sections and the answer is buried.', fix: 'Use layout-aware chunking.' },
    { id: 'freshness', title: 'New safety bulletins are not searchable for minutes', values: { freshness: 'seconds', ingestion: 'indexer' }, node: 'ingest',
      symptom: 'Warning: indexer schedule cannot meet the freshness target.', cause: 'Indexers run on a schedule or on demand, not per change.', fix: 'Switch ingestion to the push API.' },
    { id: 'split-table', title: 'Answer gives the code but not the fix', values: { query: 'id', method: 'semantic', chunking: 'fixed', topK: 1 }, node: 'corpus',
      symptom: 'Warning: the error-code table was split across chunks.', cause: 'Fixed-size chunking cut the table row away from its fix column.', fix: 'Use layout-aware chunking so tables stay intact.' },
  ],

  challenge: {
    task: 'Find one index + query configuration that serves every query type (exact ID, paraphrase, Spanish, mixed) with all relevant sections retrieved, a relevant top result, and no warnings, while keeping hourly freshness.',
    condition: 'For all four queries: no warn/error steps (recall 100%, top-1 relevant, no split/whole-doc issues), freshness = hourly.',
    hint: 'Combine the strengths of keyword and vector search, then let a re-ranker order them. Chunk by structure.',
    check: (p, res) => p.freshness === 'hourly' && !res.steps.some(s => s.status === 'error' || s.status === 'warn') && allQueriesPass(p),
    solution: ['Method: Hybrid + semantic ranker.', 'Chunking: Layout / heading-aware.', 'Top K: 3.', 'Ingestion: indexer with integrated vectorization (hourly is within an indexer schedule); query model: same as index.', 'Switch through all four queries: each run is clean.'],
    solutionValues: { method: 'semantic', chunking: 'layout', topK: 3, ingestion: 'indexer', freshness: 'hourly', queryModel: 'same' },
  },

  quiz: [
    { q: 'Users search a parts catalogue by exact SKUs ("PS-07-B") and by descriptions ("cable that connects two switches"). Which approach fits?', options: ['Keyword only', 'Vector only', 'Hybrid search, optionally with the semantic ranker', 'Increase top K to 50'], answer: 2, why: 'BM25 matches exact identifiers, vectors match descriptions; RRF fuses both and the semantic ranker orders the best first.' },
    { q: 'Policy documents change monthly and live in Blob Storage. You want the least custom code. Which ingestion method?', options: ['Push API with a custom function', 'Indexer with integrated vectorization', 'Paste documents into the system prompt', 'Agent file search for 1M docs'], answer: 1, why: 'A scheduled indexer with chunking and embedding skills handles pull, chunking and vectors with minimal code.' },
    { q: 'After switching your app to a new embedding model, vector queries fail with a dimension error. What is the fix?', options: ['Turn on the semantic ranker', 'Re-embed the index with the new model (or keep the old model for queries)', 'Lower top K', 'Use BM25 only forever'], answer: 1, why: 'Index and query vectors must come from the same model and dimension.' },
    { q: 'RAG answers cite the right manual but miss the specific steps; each chunk is an entire 80-page PDF. What should change first?', options: ['Chunking strategy', 'Model temperature', 'Search SKU', 'Number of replicas'], answer: 0, why: 'Whole-document chunks dilute embeddings and bury the answer; split by structure into focused chunks.' },
  ],

  recap: 'Pick retrieval by query type: BM25 for exact terms, vectors for meaning and other languages, hybrid (RRF) to get both, and the semantic ranker to put the best chunk first. Chunk by structure, embed queries with the same model as the index, and choose pull (indexer, integrated vectorization) or push ingestion based on freshness and how much code you want to own.',
};
