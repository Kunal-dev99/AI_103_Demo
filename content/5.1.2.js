// 5.1.2 Configure semantic search, hybrid search, and vector search for grounding
// Lab: Search mode comparator.
import { round, step, metric, words, hasError } from '../src/engine/util.js';

// Toy index. `vec` = hand-written 6-dimension "embeddings" over concept axes:
// [travel, expense, security, hr-leave, hardware, finance-approval]. Real embeddings have
// hundreds or thousands of dimensions; six are enough to see why paraphrases match.
const AXES = ['travel', 'expense', 'security', 'leave', 'hardware', 'approval'];
const DOCS = [
  { id: 'fin-01', title: 'Travel expense reimbursement', category: 'Finance', year: 2025, text: 'Claim ground transport such as rideshare and airport transfers through the expense portal within 30 days. Attach the receipt to every line item.', vec: [0.8, 0.6, 0, 0, 0, 0.05] },
  { id: 'fin-02', title: 'Expense portal user guide', category: 'Finance', year: 2024, text: 'Log in to the expense portal, create a report, add line items and submit it for manager approval.', vec: [0.1, 0.8, 0, 0, 0.1, 0.2] },
  { id: 'trv-01', title: 'Corporate travel booking', category: 'Travel', year: 2025, text: 'Book flights and hotels through the travel desk. Economy class applies to flights under six hours.', vec: [0.9, 0.1, 0, 0, 0, 0] },
  { id: 'fin-03', title: 'Taxi vouchers discontinued', category: 'Finance', year: 2023, text: 'Paper taxi vouchers were discontinued in 2023. Taxi vouchers issued before then are no longer accepted.', vec: [0.5, 0.1, 0, 0, 0, 0.5] },
  { id: 'it-01', title: 'KB ERR-4471: laptop fails to boot after BIOS update', category: 'IT', year: 2026, text: 'Error ERR-4471 appears when a BIOS update is interrupted. Hold the power button for 30 seconds and reconnect the charger.', vec: [0, 0, 0.1, 0, 0.9, 0] },
  { id: 'it-02', title: 'Device will not power on', category: 'IT', year: 2025, text: 'If your device does not start, check the charger light, perform a hard reset and contact the service desk.', vec: [0, 0, 0, 0, 0.95, 0] },
  { id: 'it-03', title: 'Password reset', category: 'IT', year: 2025, text: 'Reset your password from the self-service portal. Multifactor authentication is required.', vec: [0, 0, 0.95, 0, 0.1, 0] },
  { id: 'hr-01', title: 'Annual leave policy', category: 'HR', year: 2024, text: 'Employees accrue 25 days of annual leave per year. Request time off in the HR portal.', vec: [0.1, 0, 0, 0.95, 0, 0] },
  { id: 'hr-02', title: 'Parental leave', category: 'HR', year: 2025, text: 'Birth and adoptive parents receive 20 weeks of paid parental leave.', vec: [0, 0.1, 0, 0.9, 0, 0] },
  { id: 'fin-04', title: 'Supplier invoice approval', category: 'Finance', year: 2026, text: 'Supplier invoices above 10,000 require two approvers in the finance system.', vec: [0, 0.3, 0, 0, 0, 0.9] },
  { id: 'it-04', title: 'Firmware error code reference', category: 'IT', year: 2024, text: 'Lists firmware error codes in the ERR-44xx range and the team that owns each code.', vec: [0, 0, 0.2, 0, 0.6, 0.1] },
  { id: 'it-05', title: 'Phishing awareness', category: 'IT', year: 2023, text: 'Report suspicious emails with the Report button. Never share your password.', vec: [0, 0, 0.9, 0, 0.1, 0] },
];

// Toy "embedding model": maps words (including synonyms the documents never use) to concept axes.
const LEXICON = {
  travel: ['taxi', 'cab', 'uber', 'rideshare', 'airport', 'flight', 'flights', 'hotel', 'hotels', 'trip', 'travel', 'transport', 'ride'],
  expense: ['reimburse', 'reimbursed', 'reimbursement', 'expense', 'expenses', 'claim', 'refund', 'paid', 'money', 'receipt', 'cost', 'back'],
  security: ['password', 'mfa', 'login', 'phishing', 'locked', 'security', 'hacked', 'scam', 'suspicious'],
  leave: ['leave', 'holiday', 'holidays', 'vacation', 'off', 'parental', 'maternity', 'paternity', 'baby'],
  hardware: ['laptop', 'computer', 'pc', 'device', 'boot', 'start', 'power', 'turn', 'screen', 'bios', 'charger', 'dead', 'err'],
  approval: ['invoice', 'invoices', 'supplier', 'vendor', 'approval', 'approver', 'approvers', 'budget', 'sign'],
};
const STOP = new Set(['how', 'do', 'the', 'to', 'for', 'a', 'an', 'my', 'i', 'get', 'will', 'not', 'is', 'it', 'what', 'can', 'of', 'in', 'on', 'and', 'won\'t', 'does', 'me', 'after']);

const FILTERS = {
  none: { label: 'No filter', fn: () => true },
  finance: { label: "category eq 'Finance'", fn: d => d.category === 'Finance' },
  it: { label: "category eq 'IT'", fn: d => d.category === 'IT' },
  future: { label: 'year ge 2027', fn: d => d.year >= 2027 },
};

const terms = text => words(text).filter(w => !STOP.has(w) && w.length > 1);

function embedQuery(q) {
  const v = AXES.map(() => 0);
  let hits = 0;
  for (const w of terms(q)) AXES.forEach((a, i) => { if (LEXICON[a].includes(w)) { v[i] += 1; hits++; } });
  return { v, hits };
}
const norm = v => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const cosine = (a, b) => { const n = norm(a) * norm(b); return n ? a.reduce((s, x, i) => s + x * b[i], 0) / n : 0; };

// BM25 over title + text, k1 = 1.2, b = 0.75. No stemming (like the standard analyzer).
function bm25(q, docs) {
  const toks = docs.map(d => terms(d.title + ' ' + d.text));
  const avgdl = toks.reduce((a, t) => a + t.length, 0) / Math.max(1, toks.length);
  const N = DOCS.length;
  const qt = [...new Set(terms(q))];
  return docs.map((d, i) => {
    let s = 0;
    for (const t of qt) {
      const n = DOCS.filter(x => terms(x.title + ' ' + x.text).includes(t)).length;
      if (!n) continue;
      const tf = toks[i].filter(x => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (tf * 2.2) / (tf + 1.2 * (1 - 0.75 + 0.75 * toks[i].length / avgdl));
    }
    return { d, score: s };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

function vectorRank(qv, docs) {
  return docs.map(d => ({ d, score: cosine(qv, d.vec) })).filter(x => x.score > 0.05).sort((a, b) => b.score - a.score);
}

// Reciprocal rank fusion with k = 60.
function rrf(lists) {
  const m = new Map();
  for (const list of lists) list.forEach((x, i) => { const e = m.get(x.d.id) || { d: x.d, score: 0 }; e.score += 1 / (60 + i + 1); m.set(x.d.id, e); });
  return [...m.values()].sort((a, b) => b.score - a.score);
}

// Simulated semantic ranker: re-scores the top results 0..4 from query/passage relevance and
// extracts the best sentence as a caption. This is a stand-in for a cross-encoder, not the real model.
function semanticRerank(q, qv, list) {
  return list.map(x => {
    const sentences = x.d.text.split(/(?<=\.)\s+/);
    const qset = new Set(terms(q));
    const best = sentences.map(s => ({ s, c: terms(s).filter(w => qset.has(w)).length + cosine(qv, x.d.vec) })).sort((a, b) => b.c - a.c)[0];
    const lexical = [...qset].filter(w => terms(x.d.title + ' ' + x.d.text).includes(w)).length / Math.max(1, qset.size);
    const rerankerScore = round(4 * (0.7 * cosine(qv, x.d.vec) + 0.3 * lexical), 2);
    return { ...x, rerankerScore, caption: best ? best.s : '' };
  }).sort((a, b) => b.rerankerScore - a.rerankerScore);
}

function search(p) {
  const steps = [];
  const q = String(p.query || '').trim();
  const k = Math.max(1, Math.round(Number(p.k) || 3));
  if (!q) {
    steps.push(step('query', 'Empty query', 'search="" with no vector query returns everything unranked. Enter a question.', { search: '' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Type a query to compare retrieval modes.' }], metrics: [], summary: 'Empty query' };
  }
  const filter = FILTERS[p.filter] || FILTERS.none;
  const pool = DOCS.filter(filter.fn);
  const { v: qv, hits } = embedQuery(q);
  steps.push(step('query', 'Query received', `"${q}" • mode ${p.mode}${p.semantic ? ' + semantic ranker' : ''} • top ${k}${p.filter !== 'none' ? ` • $filter=${filter.label}` : ''}`,
    { search: p.mode === 'vector' ? null : q, vectorQueries: p.mode === 'keyword' ? null : [{ kind: 'text', text: q, fields: 'contentVector', k: 50 }], filter: p.filter === 'none' ? null : filter.label, queryType: p.semantic ? 'semantic' : 'simple', top: k }, 'info'));

  // Validate configuration
  const needsVector = p.mode !== 'keyword';
  if (needsVector && !p.vectorField) {
    steps.push(step('index', 'Vector query rejected', "The index has no vector field named contentVector. A vectorQueries request against it returns HTTP 400.", { httpStatus: 400, field: 'contentVector', exists: false }, 'error'));
    return done(p, steps, {});
  }
  if (needsVector && !p.vectorizer) {
    steps.push(step('vector', 'No vectorizer for text-to-vector', 'The query sends text (kind: "text") but the vector profile has no vectorizer, so the service cannot embed it. Either configure an Azure OpenAI vectorizer or embed the query yourself and send kind: "vector".', { httpStatus: 400, vectorizer: null }, 'error'));
    return done(p, steps, {});
  }
  if (p.semantic && !p.semanticConfig) {
    steps.push(step('semantic', 'Semantic query rejected', 'queryType=semantic needs a semantic configuration (title, content and keyword fields) in the index, referenced by name or set as the default. None exists.', { httpStatus: 400, semanticConfiguration: null }, 'error'));
    return done(p, steps, {});
  }
  steps.push(step('index', 'Filter applied', `${pool.length}/${DOCS.length} documents pass the filter.`, { filter: filter.label, remaining: pool.map(d => d.id) }, pool.length ? 'ok' : 'warn'));
  if (!pool.length) {
    steps.push(step('semantic', 'No results', 'The filter excluded every document before ranking. Nothing to ground on; an agent would have to say it does not know (or worse, answer without sources).', { count: 0 }, 'warn'));
    return done(p, steps, { kw: [], vec: [], hyb: [], final: [], qv, hits });
  }

  const kw = bm25(q, pool);
  const vec = vectorRank(qv, pool);
  const hyb = rrf([kw, vec]);
  steps.push(step('keyword', 'Keyword (BM25) ranking', kw.length ? `${kw.length} documents contain query terms. Top: ${kw[0].d.id} (${round(kw[0].score, 2)}).` : 'No document contains the exact query terms.',
    { analyzer: 'standard (no stemming in this simulation)', terms: [...new Set(terms(q))], top: kw.slice(0, 5).map(x => ({ id: x.d.id, bm25: round(x.score, 3) })) }, p.mode === 'vector' ? 'skip' : kw.length ? 'ok' : 'warn'));
  steps.push(step('vector', 'Vector (cosine, HNSW) ranking', hits ? `Query embedded onto ${AXES.filter((a, i) => qv[i]).join(', ')}. Top: ${vec.length ? vec[0].d.id + ' (' + round(vec[0].score, 3) + ')' : 'none'}.` : 'Query words are outside this toy embedding\'s vocabulary, so similarities are near zero.',
    { queryVector: qv.map(x => round(x / (norm(qv) || 1), 2)), top: vec.slice(0, 5).map(x => ({ id: x.d.id, cosine: round(x.score, 3) })) }, p.mode === 'keyword' ? 'skip' : vec.length ? 'ok' : 'warn'));
  const idToken = (q.match(/\b[A-Za-z]{2,}-?\d{3,}\b/) || [])[0];
  if (p.mode === 'vector' && idToken && kw.length && vec.length && kw[0].d.id !== vec[0].d.id) {
    steps.push(step('vector', 'Exact identifier lost in vector space', `"${idToken}" is a rare identifier. The embedding only captures that it is "hardware-ish", so ${vec[0].d.id} outranks ${kw[0].d.id}, the document that actually contains the code. BM25 would have ranked it first.`,
      { identifier: idToken, keywordTop: kw[0].d.id, vectorTop: vec[0].d.id }, 'warn'));
  }
  if (p.mode === 'hybrid') steps.push(step('fusion', 'Hybrid: reciprocal rank fusion', hyb.length ? `Each document scores Σ 1/(60 + rank) across the keyword and vector lists. Top: ${hyb[0].d.id} (${round(hyb[0].score, 4)}).` : 'Both lists are empty, so there is nothing to fuse.',
    { k: 60, top: hyb.slice(0, 5).map(x => ({ id: x.d.id, rrf: round(x.score, 4) })) }, hyb.length ? 'ok' : 'warn'));

  let base = p.mode === 'keyword' ? kw : p.mode === 'vector' ? vec : hyb;
  let final = base;
  if (p.semantic) {
    final = semanticRerank(q, qv, base.slice(0, 50));
    const moved = base[0] && final[0] && base[0].d.id !== final[0].d.id;
    steps.push(step('semantic', 'Semantic ranker re-scored the top results', `Re-ranked ${Math.min(50, base.length)} results (rerankerScore 0–4) and extracted captions.${moved ? ` New #1: ${final[0].d.id} (was ${base[0].d.id}).` : ''} It only re-orders what the first stage retrieved.`,
      { rerankerScores: final.slice(0, 5).map(x => ({ id: x.d.id, score: x.rerankerScore })), captions: final.slice(0, 2).map(x => x.caption) }));
  } else {
    steps.push(step('semantic', 'Semantic ranker off', 'Results are returned in first-stage order with no captions or answers.', null, 'skip'));
  }
  if (!final.length) steps.at(-1).status = 'warn';
  return done(p, steps, { kw, vec, hyb, final, qv, hits });
}

function done(p, steps, r) {
  const k = Math.max(1, Math.round(Number(p.k) || 3));
  const output = [];
  if (!r.final) {
    output.push({ type: 'alert', tone: 'error', text: 'The query was rejected before ranking. Fix the index or query configuration.' });
    return { steps, output, metrics: [], summary: `Rejected: ${steps.at(-1).title}` };
  }
  const top = r.final.slice(0, k);
  const col = (list, fmt) => Array.from({ length: k }, (_, i) => list[i] ? `${list[i].d.id} (${fmt(list[i])})` : '—');
  const kwCol = col(r.kw, x => round(x.score, 2));
  const vecCol = col(r.vec, x => round(x.score, 2));
  const hybCol = col(r.hyb, x => round(x.score, 4));
  output.push({ type: 'table', title: 'Side by side: same query, three retrieval modes (score in brackets)', columns: ['Rank', 'Keyword BM25', 'Vector cosine', 'Hybrid RRF'],
    rows: Array.from({ length: k }, (_, i) => [String(i + 1), kwCol[i], vecCol[i], hybCol[i]]) });
  if (top.length) {
    output.push({ type: 'table', title: `Returned to the app (${p.mode}${p.semantic ? ' + semantic' : ''})`, columns: ['#', 'id', 'Title', p.semantic ? 'rerankerScore' : 'Score', p.semantic ? 'Caption' : 'Category'],
      rows: top.map((x, i) => [String(i + 1), x.d.id, x.d.title, String(p.semantic ? x.rerankerScore : round(x.score, 4)), p.semantic ? x.caption : x.d.category]) });
    output.push({ type: 'bars', title: 'Query vs document similarity (cosine, toy 6-dim embeddings)', items: r.vec.slice(0, 6).map(x => ({ label: x.d.id, value: round(x.score, 3), max: 1 })) });
    if (p.semantic && top[0].rerankerScore >= 2.5) output.push({ type: 'alert', tone: 'ok', text: `Semantic answer (simulated): "${top[0].caption}" — ${top[0].d.id}` });
  } else {
    output.push({ type: 'alert', tone: 'warn', text: 'No results. Check the filter and whether the query terms or meaning exist in the index.' });
  }
  output.push({ type: 'json', title: 'Search request body (illustrative)', data: {
    search: p.mode === 'vector' ? '*' : p.query,
    vectorQueries: p.mode === 'keyword' ? undefined : [{ kind: 'text', text: p.query, fields: 'contentVector', k: 50 }],
    filter: p.filter === 'none' ? undefined : FILTERS[p.filter].label,
    queryType: p.semantic ? 'semantic' : 'simple', semanticConfiguration: p.semantic ? 'kb-semantic' : undefined,
    captions: p.semantic ? 'extractive' : undefined, answers: p.semantic ? 'extractive' : undefined, top: k,
  } });
  const overlapKV = r.kw.slice(0, k).filter(x => r.vec.slice(0, k).some(y => y.d.id === x.d.id)).length;
  return {
    steps, output,
    metrics: [
      metric('Top result', top[0] ? top[0].d.id : 'none', 'computed'),
      metric('Keyword ∩ vector in top k', `${overlapKV}/${k}`, 'computed', 'How many documents both modes agree on. Low agreement is where hybrid helps.'),
      metric('Query terms known to toy embedding', String(r.hits || 0), 'computed', 'Real embedding models cover far more vocabulary; this shows why out-of-vocabulary IDs suit keyword search.'),
      metric('Relative query cost', p.semantic ? 'higher (semantic ranker billed per query)' : p.mode === 'keyword' ? 'lowest' : 'medium (query embedding call)', 'estimate', 'Semantic ranker and query-time vectorization add cost/latency. Check current pricing; nothing is reproduced here.'),
    ],
    summary: `${p.mode}${p.semantic ? '+semantic' : ''}: #1 ${top[0] ? top[0].d.id : 'none'} (${top.length} results)`,
  };
}

export default {
  id: '5.1.2',
  lab: 'Search mode comparator',
  services: [
    { name: 'Hybrid search in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview' },
    { name: 'Vector search in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/vector-search-overview' },
    { name: 'Semantic ranking in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/semantic-search-overview' },
  ],
  prereqs: ['5.1.1', '1.1.3'],
  next: ['5.1.5', '2.1.2'],

  concept: {
    plain: 'Keyword search finds documents that contain your exact words, so it is great for error codes and product IDs but misses paraphrases. Vector search compares meaning, so "get my taxi money back" can find a page about "ground transport reimbursement", but it is weak on exact codes. Hybrid search runs both and merges the lists. A semantic ranker then re-reads the best results and moves the most relevant to the top, with a highlighted caption.',
    technical: 'Azure AI Search full-text queries use BM25 over analyzed searchable fields. Vector queries (vectorQueries, kind "vector" or "text" with a vectorizer) run approximate nearest-neighbour (HNSW) or exhaustive KNN over a vector field with fixed dimensions. A hybrid request contains both search and vectorQueries; results are merged with Reciprocal Rank Fusion. queryType=semantic applies a semantic ranker (cross-encoder) to the top 50 results using a semantic configuration (title, content, keyword fields) and can return extractive captions and answers. Filters ($filter on filterable fields) restrict the candidate set.',
    useCase: 'An employee help agent grounds answers on an IT, HR and finance knowledge base. Users paste error codes like ERR-4471 and also ask vague questions like "my laptop is dead". Hybrid retrieval with semantic ranking gives the model the right passages for both, and a category filter keeps HR questions on HR content.',
    terms: [
      ['BM25', 'Term-frequency/inverse-document-frequency scoring used for full-text search.'],
      ['Cosine similarity', 'Angle-based similarity between two embedding vectors; 1 = same direction.'],
      ['RRF', 'Reciprocal Rank Fusion: score = Σ 1/(k + rank) across result lists; robust to different score scales.'],
      ['Semantic ranker', 'Re-ranks the top results with a language model and can return captions and answers; needs a semantic configuration.'],
      ['Vectorizer', 'Index setting that embeds text queries at query time with a configured model.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'query', label: p ? `Query: "${String(p.query).slice(0, 28)}"` : 'Query', col: 0, row: 1, kind: 'user', detail: 'One user question, sent to one or more retrieval paths.' },
          { id: 'index', label: 'Filter', col: 1, row: 1, detail: 'Optional $filter narrows the candidate set before ranking.', badge: p && p.filter !== 'none' ? FILTERS[p.filter].label : undefined },
          { id: 'keyword', label: 'Keyword (BM25)', col: 2, row: 0, disabled: p ? p.mode === 'vector' : false, detail: 'Exact terms. Strong for IDs, codes, names.' },
          { id: 'vector', label: 'Vector (meaning)', col: 2, row: 2, disabled: p ? p.mode === 'keyword' : false, detail: 'Nearest neighbours in embedding space. Strong for paraphrases.' },
          { id: 'fusion', label: 'Hybrid fusion (RRF)', col: 3, row: 1, disabled: p ? p.mode !== 'hybrid' : false, detail: 'Merges both ranked lists by rank, not raw score.' },
          { id: 'semantic', label: 'Semantic ranker', col: 4, row: 1, disabled: p ? !p.semantic : false, detail: 'Re-orders top results and extracts captions/answers.', substeps: ['Take top 50', 'Cross-encoder score 0–4', 'Captions', 'Answers'] },
        ],
        edges: [['query', 'index'], ['index', 'keyword'], ['index', 'vector'], ['keyword', 'fusion'], ['vector', 'fusion'], ['fusion', 'semantic']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'query', label: 'App / agent', col: 0, row: 1, kind: 'app', detail: 'Calls the search endpoint with Search Index Data Reader (managed identity) or a query key.' },
          { id: 'index', label: 'Azure AI Search index kb', col: 1, row: 1, kind: 'data', detail: 'Searchable text fields, filterable category/year, vector field contentVector, semantic configuration.', badge: p && !p.vectorField ? 'no vector field' : undefined },
          { id: 'vector', label: 'Azure OpenAI embedding (vectorizer)', col: 2, row: 2, kind: 'ai', disabled: p ? !p.vectorizer : false, detail: 'Embeds text queries at query time. The search service needs permission to call the deployment.' },
          { id: 'keyword', label: 'Inverted index', col: 2, row: 0, kind: 'store', detail: 'Built from analyzed searchable fields.' },
          { id: 'fusion', label: 'Ranking (BM25 / HNSW / RRF)', col: 3, row: 1, kind: 'compute', detail: 'Runs inside the search service.' },
          { id: 'semantic', label: 'Semantic ranker', col: 4, row: 1, kind: 'ai', disabled: p ? !p.semantic : false, detail: 'Enabled on the service (plan-dependent); configured per index via semantic configurations.' },
        ],
        edges: [['query', 'index'], ['index', 'keyword'], ['index', 'vector'], ['keyword', 'fusion'], ['vector', 'fusion'], ['fusion', 'semantic'], ['semantic', 'query', 'results']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'query', label: 'client = SearchClient(endpoint, "kb", DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'azure-search-documents.' },
          { id: 'vector', label: 'vq = VectorizableTextQuery(text=q, k_nearest_neighbors=50, fields="contentVector")', col: 0, row: 1, kind: 'code', disabled: p ? p.mode === 'keyword' : false, detail: 'Text query embedded by the index vectorizer. Use VectorizedQuery to send your own vector.' },
          { id: 'keyword', label: `client.search(search_text=${p && p.mode === 'vector' ? 'None' : 'q'}, vector_queries=${p && p.mode === 'keyword' ? 'None' : '[vq]'}, top=${p ? p.k : 3}`, col: 0, row: 2, kind: 'code', detail: 'Both search_text and vector_queries → hybrid.' },
          { id: 'index', label: `  filter=${p && p.filter !== 'none' ? `"${FILTERS[p.filter].label}"` : 'None'},`, col: 0, row: 3, kind: 'code', detail: 'OData filter on filterable fields.' },
          { id: 'semantic', label: `  query_type=${p && p.semantic ? '"semantic", semantic_configuration_name="kb-semantic", query_caption="extractive"' : '"simple"'})`, col: 0, row: 4, kind: 'code', detail: 'Read @search.reranker_score and captions from results. Parameter names illustrative; check your SDK version.' },
          { id: 'fusion', label: 'for r in results: r["@search.score"], r["@search.reranker_score"]', col: 0, row: 5, kind: 'code', detail: 'Hybrid @search.score is the RRF score.' },
        ],
        edges: [['query', 'vector'], ['vector', 'keyword'], ['keyword', 'index'], ['index', 'semantic'], ['semantic', 'fusion']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'query', label: 'Query', type: 'text', default: 'How do I get reimbursed for a taxi to the airport?' },
      { id: 'mode', label: 'Retrieval mode', type: 'select', options: [['keyword', 'Keyword (BM25)'], ['vector', 'Vector'], ['hybrid', 'Hybrid (keyword + vector, RRF)']], default: 'keyword' },
      { id: 'semantic', label: 'Semantic ranker (queryType=semantic)', type: 'toggle', default: false },
      { id: 'k', label: 'Top k', type: 'range', min: 1, max: 6, step: 1, default: 3 },
      { id: 'filter', label: '$filter', type: 'select', options: Object.entries(FILTERS).map(([v, f]) => [v, f.label]), default: 'none' },
      { id: 'semanticConfig', label: 'Index has a semantic configuration', type: 'toggle', default: true },
      { id: 'vectorField', label: 'Index has vector field contentVector', type: 'toggle', default: true },
      { id: 'vectorizer', label: 'Vector profile has a vectorizer', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Paraphrase, keyword only', values: { query: 'How do I get reimbursed for a taxi to the airport?', mode: 'keyword' } },
      { label: 'Paraphrase, hybrid + semantic', values: { query: 'How do I get reimbursed for a taxi to the airport?', mode: 'hybrid', semantic: true } },
      { label: 'Exact error code, vector only', values: { query: 'ERR-4471', mode: 'vector' } },
      { label: 'Exact error code, keyword', values: { query: 'ERR-4471', mode: 'keyword' } },
      { label: 'Vague hardware question, hybrid', values: { query: 'my computer is dead and will not turn on', mode: 'hybrid', semantic: true } },
    ],
    run: search,
  },

  compare: {
    suggestions: [
      'Run "ERR-4471" in keyword mode, then vector mode: the exact code wins in BM25 but is nearly invisible to the embedding.',
      'Run the taxi question in keyword, vector and hybrid modes: keyword promotes the "taxi vouchers" trap, vector finds the reimbursement policy.',
      'Run the hybrid taxi query with and without the semantic ranker and compare #1 and captions.',
    ],
  },

  debug: [
    { id: 'semcfg', title: 'Semantic query returns 400', values: { mode: 'hybrid', semantic: true, semanticConfig: false }, node: 'semantic',
      symptom: 'HTTP 400 as soon as queryType=semantic is set.', cause: 'The index has no semantic configuration to tell the ranker which fields are title/content/keywords.', fix: 'Add a semantic configuration to the index (and reference it or make it default).' },
    { id: 'novec', title: 'Vector query against a text-only index', values: { mode: 'vector', vectorField: false }, node: 'index',
      symptom: 'HTTP 400: unknown vector field.', cause: 'The index was created without a vector field (or with a different name).', fix: 'Add a vector field with dimensions matching your embedding model and re-index; or use keyword mode.' },
    { id: 'novectorizer', title: 'Text vector query fails', values: { mode: 'hybrid', vectorizer: false }, node: 'vector',
      symptom: 'HTTP 400 for kind "text" vector queries.', cause: 'No vectorizer is configured on the vector profile, so the service cannot embed the query.', fix: 'Configure an Azure OpenAI vectorizer on the profile, or embed the query in your code and send a raw vector.' },
    { id: 'filter', title: 'Agent says it found nothing', values: { mode: 'hybrid', filter: 'future' }, node: 'index',
      symptom: 'Zero results for an obviously covered question.', cause: 'The filter (year ge 2027) excludes every document before ranking.', fix: 'Remove or correct the filter. Log the filter your code builds per request.' },
    { id: 'idvector', title: 'Error code lookup returns the wrong article', values: { query: 'ERR-4471', mode: 'vector' }, node: 'vector',
      symptom: 'The KB article titled with the exact code is not the top hit, or other hardware articles tie with it.', cause: 'Embeddings capture meaning, not rare identifiers. Unsuitable retrieval mode for exact-match queries.', fix: 'Use hybrid (or keyword) so BM25 can match the code.' },
  ],

  challenge: {
    task: 'Make the taxi reimbursement question return the reimbursement policy (fin-01) at rank 1 with a semantic caption, restricted to Finance content.',
    condition: 'Query mentions taxi, $filter = Finance, semantic ranker on, rank 1 = fin-01, no errors.',
    hint: 'Keyword mode alone favours the doc that repeats "taxi". Combine meaning and terms, then re-rank.',
    check: (p, res) => /taxi/i.test(p.query) && p.filter === 'finance' && p.semantic && !hasError(res) && res.metrics.some(m => m.label === 'Top result' && m.value === 'fin-01'),
    solution: ['Keep the taxi query.', 'Set $filter to category eq \'Finance\'.', 'Choose Hybrid so vector similarity can lift fin-01 above the "taxi vouchers" doc.', 'Turn on the semantic ranker (the index has a semantic configuration).'],
    solutionValues: { query: 'How do I get reimbursed for a taxi to the airport?', mode: 'hybrid', semantic: true, filter: 'finance', semanticConfig: true, vectorField: true, vectorizer: true, k: 3 },
  },

  quiz: [
    { q: 'Support engineers search for exact part numbers such as "PS-07-B", and customers ask vague questions. Which configuration gives the best grounding for both?', options: ['Vector-only search', 'Keyword-only search', 'Hybrid search (keyword + vector) with semantic ranking', 'Semantic ranking without a full-text or vector query'], answer: 2, why: 'BM25 matches rare exact tokens; vectors match paraphrases. RRF merges both, and the semantic ranker improves the top of the list.' },
    { q: 'You enable queryType=semantic and get HTTP 400. Full-text queries still work. What do you check first?', options: ['Vector dimensions', 'Whether the index has a semantic configuration (and the service has semantic ranker enabled)', 'The indexer schedule', 'The analyzer on the key field'], answer: 1, why: 'Semantic ranking needs a semantic configuration that names the title, content and keyword fields; it must also be available on the service.' },
    { q: 'Your app sends vectorQueries with kind "text" and gets an error, but sending a precomputed vector works. Why?', options: ['Text queries are not supported in hybrid mode', 'No vectorizer is defined on the vector profile', 'The index needs a semantic configuration', 'The query is too long for BM25'], answer: 1, why: 'Integrated vectorization at query time relies on a vectorizer (e.g. Azure OpenAI) on the vector search profile.' },
    { q: 'The semantic ranker is on, but the right document never appears. What is the most likely reason?', options: ['The semantic ranker only re-orders the first-stage results; the document was not retrieved by BM25/vector', 'Captions are disabled', 'top is set too high', 'RRF uses k = 60'], answer: 0, why: 'Semantic ranking improves precision of the top results; it does not improve recall. Fix first-stage retrieval (hybrid, filters, chunking).' },
  ],

  recap: 'Keyword (BM25) wins on exact terms, vector wins on meaning, hybrid merges them with RRF, and the semantic ranker re-orders the top results and adds captions. Each needs index support: vector fields and a vectorizer for vector queries, a semantic configuration for semantic ranking, filterable fields for filters. Check filters when results vanish.',
};
