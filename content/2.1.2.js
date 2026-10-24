// 2.1.2 Implement retrieval-augmented generation (RAG) in an application
// Lab: RAG pipeline bench.
import { rng, round, step, metric, words } from '../src/engine/util.js';

// Toy BM25 stand-in: share of the query's content words that appear verbatim in the text
// (standard analyzer style: lowercase, no stemming, no synonyms).
const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'can', 'does', 'do', 'have', 'should', 'if', 'my', 'is', 'there', 'at', 'to', 'a', 'an', 'of', 'i', 'long', 'say', 'much', 'many']);
const contentWords = t => [...new Set(words(t))].filter(w => w.length > 1 && !STOP.has(w));
const kwScore = (q, t) => { const Q = contentWords(q); const T = new Set(words(t)); return Q.length ? Q.filter(w => T.has(w)).length / Q.length : 0; };

// Toy knowledge base: an employee handbook. Each sentence has "topics" that stand in for embedding semantics.
const SECTIONS = [
  { id: 'travel', title: 'Travel', sents: [
    { id: 't1', text: 'Employees must book flights through the Contoso travel portal.', topics: ['travel', 'booking', 'flight'] },
    { id: 't2', text: 'Economy class is required for flights under 6 hours.', topics: ['travel', 'flight', 'class'] },
    { id: 't3', text: 'Business class is allowed for flights over 6 hours with manager approval.', topics: ['travel', 'flight', 'class', 'approval'] },
  ] },
  { id: 'expenses', title: 'Expenses', sents: [
    { id: 'e1', text: 'Submit expense claims within 30 days of the purchase date.', topics: ['expense', 'deadline', 'claim'] },
    { id: 'e2', text: 'Policy EXP-25: receipts are required for any single expense above 25 EUR.', topics: ['expense', 'receipt'] },
    { id: 'e3', text: 'Late claims need written approval from a finance director.', topics: ['expense', 'deadline', 'approval', 'claim'] },
  ] },
  { id: 'remote', title: 'Remote work', sents: [
    { id: 'r1', text: 'Staff may work remotely up to three days per week.', topics: ['remote', 'schedule'] },
    { id: 'r2', text: 'A home-office allowance of 300 EUR is paid once per year.', topics: ['remote', 'allowance', 'expense'] },
  ] },
  { id: 'security', title: 'Device security', sents: [
    { id: 's1', text: 'Laptops must use BitLocker encryption.', topics: ['security', 'device'] },
    { id: 's2', text: 'Report lost or stolen devices to the service desk within 24 hours.', topics: ['security', 'device', 'lost', 'report'] },
  ] },
  { id: 'leave', title: 'Leave', sents: [
    { id: 'l1', text: 'Full-time employees receive 25 days of annual leave.', topics: ['leave', 'days'] },
    { id: 'l2', text: 'Up to 5 unused leave days can be carried over to the next year.', topics: ['leave', 'carryover', 'days'] },
  ] },
];

const QUERIES = {
  q1: { text: 'How long do I have to submit an expense claim?', topics: ['expense', 'deadline', 'claim'], needs: ['e1'],
    answer: 'Submit claims within 30 days of the purchase date{e1}; later claims need written approval from a finance director{e3}.', fabricated: 'You have 90 days to submit an expense claim.' },
  q2: { text: 'Can I fly business class to Singapore (a 13-hour flight)?', topics: ['travel', 'flight', 'class', 'approval'], needs: ['t3'],
    answer: 'Yes, business class is allowed for flights over 6 hours, but you need manager approval{t3}.', fabricated: 'No, business class is never allowed.' },
  q3: { text: 'What should I do if I lose my laptop?', topics: ['security', 'device', 'lost', 'report'], needs: ['s2'],
    answer: 'Report the lost device to the service desk within 24 hours{s2}.', fabricated: 'Buy a replacement and claim it as an expense.' },
  q4: { text: 'How much holiday can I roll forward?', topics: ['leave', 'carryover', 'days'], needs: ['l2'],
    answer: 'You can carry over up to 5 unused leave days to the next year{l2}.', fabricated: 'You can roll forward all unused holiday.' },
  q5: { text: 'What does policy EXP-25 say?', topics: ['policy'], needs: ['e2'],
    answer: 'EXP-25 requires receipts for any single expense above 25 EUR{e2}.', fabricated: 'EXP-25 covers parking reimbursements.' },
  q6: { text: 'Is there a parking allowance at the Leeds office?', topics: ['parking', 'allowance', 'office'], needs: [],
    answer: 'The handbook does not cover parking allowances, so I cannot answer that from the sources.', fabricated: 'Yes, Leeds staff receive a 50 EUR monthly parking allowance.' },
};

// Chunk sizes. tokens = tokens per chunk this simulation assumes (real chunks carry surrounding text).
const CHUNKING = {
  small: { label: 'Small (~128 tokens, 1 sentence)', tokens: 128, group: 1, dilution: 1 },
  medium: { label: 'Medium (~512 tokens, 2 sentences)', tokens: 512, group: 2, dilution: 0.92 },
  large: { label: 'Large (~1,500 tokens, whole section)', tokens: 1500, group: 99, dilution: 0.8 },
};

const MODES = {
  keyword: 'Keyword (BM25 full text)',
  vector: 'Vector (embeddings)',
  hybrid: 'Hybrid (BM25 + vector, RRF)',
  semantic: 'Hybrid + semantic ranker',
};

function buildChunks(size) {
  const c = CHUNKING[size] || CHUNKING.medium;
  const chunks = [];
  for (const s of SECTIONS) {
    for (let i = 0; i < s.sents.length; i += c.group) {
      const sents = s.sents.slice(i, i + c.group);
      chunks.push({ id: `handbook.pdf#${s.id}-${chunks.filter(x => x.section === s.id).length + 1}`, section: s.id, title: s.title, sents, text: sents.map(x => x.text).join(' ') });
    }
  }
  return chunks;
}

const jacc = (a, b) => { const A = new Set(a), B = new Set(b); let n = 0; for (const x of A) if (B.has(x)) n++; return A.size + B.size - n ? n / (A.size + B.size - n) : 0; };

function rag(p) {
  const q = QUERIES[p.query] || QUERIES.q1;
  const ch = CHUNKING[p.chunk] || CHUNKING.medium;
  const r = rng(`${p.query}|${p.mode}|${p.chunk}`);
  const k = Number(p.topK) || 0;
  const steps = [];
  const chunks = buildChunks(p.chunk);

  steps.push(step('query', 'User question', q.text, { query: q.text, mode: p.mode, top: k }, 'info'));

  // Embedding the query (vector modes)
  const usesVector = p.mode !== 'keyword';
  if (usesVector) {
    if (p.embed === 'mismatch') {
      steps.push(step('embed', 'Query vector rejected', 'The index was built with text-embedding-3-large (3072 dimensions) but the app embeds queries with text-embedding-ada-002 (1536). Azure AI Search rejects a vector query whose dimensions differ from the field definition.',
        { httpStatus: 400, error: { message: "The 'contentVector' field has 3072 dimensions but the query vector has 1536 (illustrative wording)." } }, 'error'));
      return done(p, q, ch, steps, [], null, 0);
    }
    steps.push(step('embed', 'Query embedded', 'Same embedding model as the index (text-embedding-3-large). Could also be done by the index vectorizer (integrated vectorization).', { model: 'text-embedding-3-large', dimensions: 3072 }));
  } else {
    steps.push(step('embed', 'No embedding needed', 'Keyword mode uses the inverted index only.', null, 'skip'));
  }

  // Search
  if (!p.rbac) {
    steps.push(step('search', 'Search call forbidden', 'The app identity has no data-plane role on the search service and API keys are disabled.', { httpStatus: 403, fix: 'Assign "Search Index Data Reader" to the app\'s managed identity' }, 'error'));
    return done(p, q, ch, steps, [], null, 0);
  }
  const scored = chunks.map(c => {
    const kw = Math.max(...c.sents.map(s => kwScore(q.text, s.text)));
    const vec = Math.max(...c.sents.map(s => jacc(q.topics, s.topics))) * ch.dilution + r() * 0.08;
    return { ...c, kw: round(kw, 3), vec: round(vec, 3) };
  });
  const rankBy = key => [...scored].sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id)).map(c => c.id);
  const kwRank = rankBy('kw'), vecRank = rankBy('vec');
  for (const c of scored) {
    c.rrf = round((c.kw > 0 ? 1 / (60 + kwRank.indexOf(c.id) + 1) : 0) + 1 / (60 + vecRank.indexOf(c.id) + 1), 4); // BM25 only returns matching docs
    c.sem = round(Math.max(...c.sents.map(s => jacc(q.topics, s.topics))) * 3 + c.kw, 3); // reranker sees the text itself
  }
  const key = { keyword: 'kw', vector: 'vec', hybrid: 'rrf', semantic: 'sem' }[p.mode] || 'rrf';
  const ranked = [...scored].sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id)).filter(c => p.mode !== 'keyword' || c.kw > 0);
  const top = ranked.slice(0, k);
  steps.push(step('search', `Retrieved ${top.length} chunk(s)`, `${MODES[p.mode]} over ${chunks.length} chunks (${ch.label}).${p.mode === 'keyword' && ranked.length < k ? ' Keyword search found fewer matches than k: no shared words.' : ''}`,
    { results: top.map(c => ({ id: c.id, score: c[key] })) }, top.length ? 'ok' : 'warn'));

  // Relevance check
  const neededSet = new Set(q.needs);
  const coveredIds = new Set(top.flatMap(c => c.sents.map(s => s.id)));
  const covered = q.needs.filter(id => coveredIds.has(id));
  const relevant = top.filter(c => c.sents.some(s => jacc(q.topics, s.topics) >= 0.3 || neededSet.has(s.id)));
  const precision = top.length ? relevant.length / top.length : 0;
  const recall = q.needs.length ? covered.length / q.needs.length : 1;
  const ctxTokens = top.length * ch.tokens;
  if (q.needs.length && !covered.length) {
    steps.push(step('rank', 'Answer evidence not retrieved', `None of the top ${k} chunks contain the sentence that answers the question. ${k <= 1 ? 'k is very low.' : p.mode === 'keyword' ? 'The question uses different words than the document (vocabulary mismatch).' : 'Try another retrieval mode or chunk size.'}`, { needed: q.needs, retrieved: [...coveredIds] }, 'warn'));
  } else if (precision < 0.35 && top.length >= 5) {
    steps.push(step('rank', 'Mostly irrelevant context', `Only ${relevant.length}/${top.length} chunks are on-topic. Noise costs tokens and can distract the model.`, { precision: round(precision, 2) }, 'warn'));
  } else {
    steps.push(step('rank', 'Evidence present', q.needs.length ? `Answer evidence found (${covered.length}/${q.needs.length}). Precision ${round(precision, 2)}.` : 'The corpus has no answer for this question; retrieved chunks are only loosely related.', { precision: round(precision, 2), recall }, q.needs.length ? 'ok' : 'info'));
  }

  // Prompt assembly
  const prompt = (p.strict ? 'Answer ONLY from the sources below. If the answer is not in the sources, say you do not know.' : 'You are a helpful HR assistant.') +
    (p.cite ? ' Cite sources as [doc N].' : '') + '\n\nSources:\n' + top.map((c, i) => `[doc ${i + 1}] (${c.id}) ${c.text}`).join('\n') + `\n\nQuestion: ${q.text}`;
  const totalTokens = ctxTokens + 300;
  if (totalTokens > p.budget) {
    steps.push(step('prompt', 'Prompt exceeds the context budget', `${top.length} × ${ch.tokens} tokens of sources + ~300 for instructions = ~${totalTokens} tokens, above your ${p.budget}-token budget. The chat call would be rejected or the app must drop chunks.`,
      { estimatedTokens: totalTokens, budget: p.budget, httpStatus: 400, code: 'context_length_exceeded' }, 'error'));
    return done(p, q, ch, steps, top, prompt, ctxTokens);
  }
  steps.push(step('prompt', 'Grounded prompt assembled', `~${totalTokens} tokens. ${p.strict ? 'Strict grounding instruction.' : 'No grounding instruction.'} ${p.cite ? 'Citations requested.' : 'No citation format.'}`, { systemPrompt: prompt.split('\n')[0], sources: top.length }, p.strict ? 'ok' : 'warn'));

  // Generation
  let answer, grounded, status, title;
  const docIndex = id => top.findIndex(c => c.sents.some(s => s.id === id)) + 1;
  const fill = txt => txt.replace(/\{(\w+)\}/g, (_, id) => (p.cite && docIndex(id) ? ` [doc ${docIndex(id)}]` : ''));
  if (!q.needs.length || !covered.length) {
    if (p.strict) { answer = 'I could not find that in the handbook sources provided.'; grounded = true; status = q.needs.length ? 'warn' : 'ok'; title = q.needs.length ? 'Model declined (evidence missing)' : 'Model correctly declined'; }
    else { answer = q.fabricated; grounded = false; status = 'warn'; title = 'Ungrounded answer (fabrication)'; }
    if (!q.needs.length && p.strict) answer = q.answer.replace(/\{\w+\}/g, '');
  } else {
    // Drop clauses whose evidence was not retrieved.
    answer = fill(q.answer.split(';').filter(part => { const m = part.match(/\{(\w+)\}/); return !m || coveredIds.has(m[1]); }).join(';'));
    grounded = true; status = p.cite ? 'ok' : 'warn'; title = p.cite ? 'Grounded answer with citations' : 'Grounded answer, no citations';
  }
  steps.push(step('answer', title, grounded ? (p.cite || !covered.length ? 'Every claim is supported by a retrieved chunk.' : 'Correct, but users cannot verify it: no citations were requested.') : 'Without retrieved evidence or a grounding instruction, the model answered from its own guesswork.', { answer, grounded }, status));
  return done(p, q, ch, steps, top, prompt, ctxTokens, answer, grounded, precision, recall, covered.length);
}

function done(p, q, ch, steps, top, prompt, ctxTokens, answer, grounded, precision = 0, recall = 0, nCovered = 0) {
  const output = [];
  if (answer) output.push({ type: 'chat', title: 'Answer', turns: [{ role: 'user', text: q.text }, { role: 'assistant', text: answer, meta: grounded ? 'grounded' : 'UNGROUNDED' }] });
  const err = steps.find(s => s.status === 'error');
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}: ${err.detail}` });
  else if (grounded === false) output.push({ type: 'alert', tone: 'warn', text: 'This answer is not supported by any source. Turn on the strict grounding instruction and fix retrieval.' });
  if (top.length) {
    output.push({ type: 'table', title: 'Retrieved chunks (rank order)', columns: ['#', 'Chunk id', 'BM25 match', 'Vector sim', 'Contains answer?'],
      rows: top.map((c, i) => [String(i + 1), c.id, c.kw.toFixed(2), c.vec.toFixed(2), c.sents.some(s => q.needs.includes(s.id)) ? 'yes' : 'no']),
      tones: top.map(c => (c.sents.some(s => q.needs.includes(s.id)) ? 'ok' : '')) });
  }
  if (prompt) output.push({ type: 'code', title: 'Assembled prompt (what the model sees)', lang: 'text', text: prompt });
  output.push({ type: 'bars', title: 'Retrieval quality', items: [
    { label: 'Recall (answer evidence found)', value: round(recall, 2), tone: recall === 1 ? 'ok' : 'warn' },
    { label: 'Precision (on-topic chunks)', value: round(precision, 2), tone: precision >= 0.5 ? 'ok' : 'warn' },
    { label: 'Context used vs budget', value: Math.min(1, round(ctxTokens / Math.max(1, p.budget), 2)), tone: ctxTokens + 300 > p.budget ? 'error' : 'info' },
  ] });
  return {
    steps, output,
    metrics: [
      metric('Evidence recall', q.needs.length ? `${nCovered}/${q.needs.length}` : 'n/a (no answer in corpus)', 'computed'),
      metric('Precision@k', top.length ? round(precision, 2).toString() : '—', 'computed', 'On-topic chunks / retrieved chunks, judged by the simulator.'),
      metric('Source tokens', `~${ctxTokens}`, 'estimate', `Assumes ~${ch.tokens} tokens per chunk at this chunk size.`),
      metric('Grounded', grounded == null ? '—' : grounded ? 'yes' : 'no', 'computed'),
    ],
    summary: err ? `Failed: ${err.title}` : `${MODES[p.mode]}, k=${p.topK}, ${p.chunk}: ${grounded ? 'grounded' : 'ungrounded'}, recall ${round(recall, 2)}`,
  };
}

const VIEW = (p, L) => [
  { id: 'query', label: L.query, col: 0, row: 1, kind: 'user', detail: 'The user question, optionally rewritten for search (query rewriting is a common improvement).' },
  { id: 'embed', label: L.embed, col: 1, row: 0, kind: 'ai', disabled: p && p.mode === 'keyword', badge: p && p.embed === 'mismatch' ? 'dim mismatch' : undefined, detail: 'Converts the question to a vector with the SAME embedding model used to build the index.' },
  { id: 'search', label: L.search, col: 1, row: 2, kind: 'store', badge: p ? p.mode : undefined, detail: 'Azure AI Search index: keyword (BM25), vector (HNSW), hybrid (merged with Reciprocal Rank Fusion) and optional semantic ranker.', substeps: ['BM25 query', 'Vector kNN query', 'RRF merge', 'Semantic rerank (optional)'] },
  { id: 'rank', label: L.rank, col: 2, row: 1, kind: 'compute', badge: p ? `k=${p.topK}` : undefined, detail: 'Choose top-k chunks. Too few misses evidence, too many adds noise and tokens.' },
  { id: 'prompt', label: L.prompt, col: 3, row: 1, kind: 'code', detail: 'System instructions + numbered sources + question. Grounding and citation instructions live here.' },
  { id: 'answer', label: L.answer, col: 4, row: 1, kind: 'ai', detail: 'The chat model writes an answer that should only use the sources and cite them.' },
];

export default {
  id: '2.1.2',
  lab: 'RAG pipeline bench',
  services: [
    { name: 'RAG in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/retrieval-augmented-generation-overview' },
    { name: 'Hybrid search', url: 'https://learn.microsoft.com/en-us/azure/search/hybrid-search-overview' },
    { name: 'Azure OpenAI On Your Data / grounding', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/use-your-data' },
  ],
  prereqs: ['1.1.3', '2.1.1'],
  next: ['5.1.2', '2.1.4', '2.2.2'],

  concept: {
    plain: 'A language model does not know your company handbook. Retrieval-augmented generation (RAG) fixes that by first searching your documents for the passages that answer the question, pasting them into the prompt, and telling the model to answer only from them and say where each fact came from. If the search finds the wrong passages, even a great model gives a wrong or made-up answer.',
    technical: 'A RAG app chunks and indexes content (Azure AI Search with text and vector fields), embeds the query with the same embedding model, runs keyword (BM25), vector (HNSW kNN) or hybrid retrieval fused with Reciprocal Rank Fusion, optionally reranks with the semantic ranker, selects top-k chunks within a token budget, and builds a grounded prompt with numbered sources and citation instructions for a chat model. Quality depends on chunk size, k, retrieval mode and the grounding instruction; it is measured with retrieval metrics and groundedness evaluators.',
    useCase: 'An HR assistant in Teams answers policy questions from a 300-page handbook indexed in Azure AI Search. Hybrid retrieval with the semantic ranker returns 3–5 chunks; the gpt-4o deployment answers with [doc N] citations, and questions the handbook does not cover get "I don\'t know" instead of an invented policy.',
    terms: [
      ['Chunk', 'A slice of a document (often a few hundred tokens) indexed and retrieved as a unit.'],
      ['Hybrid search', 'Keyword and vector queries run in parallel and merged with Reciprocal Rank Fusion (RRF).'],
      ['Semantic ranker', 'Optional Azure AI Search reranker that rescores the top results using language understanding.'],
      ['top-k', 'How many chunks go into the prompt. Trade-off between recall and noise/cost.'],
      ['Grounding', 'Constraining the answer to the provided sources, with citations, and declining when evidence is missing.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: VIEW(p, { query: 'Question', embed: 'Turn into vector', search: 'Search the documents', rank: 'Keep best k passages', prompt: 'Build grounded prompt', answer: 'Answer with citations' }),
        edges: [['query', 'embed'], ['query', 'search'], ['embed', 'search'], ['search', 'rank'], ['rank', 'prompt'], ['prompt', 'answer']],
      }),
      architectural: p => ({
        nodes: VIEW(p, { query: 'Web app / Teams bot', embed: 'Embedding deployment (text-embedding-3-large)', search: 'Azure AI Search index', rank: 'App orchestration code', prompt: 'Prompt template', answer: 'Chat deployment (gpt-4o)' }),
        edges: [['query', 'embed', 'embed'], ['query', 'search', 'search'], ['embed', 'search', 'vector'], ['search', 'rank', 'results'], ['rank', 'prompt'], ['prompt', 'answer', 'chat']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'query', label: 'q = request.json["question"]', col: 0, row: 0, kind: 'code', detail: 'Incoming question.' },
          { id: 'embed', label: 'VectorizableTextQuery(text=q, k_nearest_neighbors=50, fields="contentVector")', col: 0, row: 1, kind: 'code', disabled: p && p.mode === 'keyword', detail: 'Lets the index vectorizer embed the query with the index\'s own model (avoids dimension mismatch). Illustrative; see azure-search-documents docs.' },
          { id: 'search', label: `search_client.search(${p && p.mode === 'vector' ? 'None' : 'q'}, vector_queries=[…]${p && p.mode === 'semantic' ? ', query_type="semantic"' : ''}, top=${p ? p.topK : 3})`, col: 0, row: 2, kind: 'code', detail: 'SearchClient from azure-search-documents with DefaultAzureCredential.' },
          { id: 'rank', label: 'sources = [f"[doc {i+1}] {r[\'content\']}" for i, r in enumerate(results)]', col: 0, row: 3, kind: 'code', detail: 'Number the sources so the model can cite them.' },
          { id: 'prompt', label: `messages = [{"role":"system","content": GROUNDING${p && p.cite ? ' + CITE' : ''}}, …]`, col: 0, row: 4, kind: 'code', detail: 'System prompt with grounding rules.' },
          { id: 'answer', label: 'client.chat.completions.create(model=CHAT_DEPLOYMENT, messages=messages)', col: 0, row: 5, kind: 'code', detail: 'OpenAI client against the Foundry resource.' },
        ],
        edges: [['query', 'embed'], ['embed', 'search'], ['search', 'rank'], ['rank', 'prompt'], ['prompt', 'answer']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'query', label: 'Question', type: 'select', options: Object.entries(QUERIES).map(([v, q]) => [v, q.text]), default: 'q1' },
      { id: 'mode', label: 'Retrieval mode', type: 'select', options: Object.entries(MODES), default: 'hybrid' },
      { id: 'topK', label: 'top-k chunks', type: 'range', min: 0, max: 10, step: 1, default: 3 },
      { id: 'chunk', label: 'Chunk size', type: 'select', options: Object.entries(CHUNKING).map(([v, c]) => [v, c.label]), default: 'medium' },
      { id: 'budget', label: 'Token budget for the prompt', type: 'range', min: 1000, max: 16000, step: 500, default: 4000, help: 'Your own cap, kept well inside the chat model\'s context window.' },
      { id: 'strict', label: 'Strict grounding instruction', type: 'toggle', default: true },
      { id: 'cite', label: 'Ask for [doc N] citations', type: 'toggle', default: true },
      { id: 'embed', label: 'Query embedding model', type: 'select', options: [['match', 'Same as index (text-embedding-3-large)'], ['mismatch', 'Different (text-embedding-ada-002)']], default: 'match' },
      { id: 'rbac', label: 'App identity has Search Index Data Reader', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Synonym question with keyword only', values: { query: 'q4', mode: 'keyword' } },
      { label: 'Same question with vector search', values: { query: 'q4', mode: 'vector' } },
      { label: 'Exact policy code (keyword wins)', values: { query: 'q5', mode: 'vector', chunk: 'small' } },
      { label: 'Question not in the corpus, no grounding', values: { query: 'q6', strict: false } },
      { label: 'Large chunks, k=8', values: { chunk: 'large', topK: 8 } },
    ],
    run: rag,
  },

  compare: {
    suggestions: [
      'Ask "holiday … roll forward" with keyword, vector, hybrid and semantic modes and compare recall.',
      'Ask "policy EXP-25" with vector vs hybrid: exact codes favour keyword matching.',
      'Run the parking question with strict grounding on, then off, and compare the answers.',
      'Keep k=5 and switch chunk size small → large; compare source tokens and precision.',
    ],
  },

  debug: [
    { id: 'k0', title: 'Bot says "I could not find that" for everything', values: { topK: 0 }, node: 'rank',
      symptom: 'No sources in the prompt; every answer is a polite refusal.', cause: 'top-k was set to 0 by a configuration typo, so retrieval returns nothing even though the index is healthy.', fix: 'Set top-k to 3–5.' },
    { id: 'codes', title: 'Exact policy code not found', values: { query: 'q5', mode: 'vector', chunk: 'small' }, node: 'search',
      symptom: 'The answer to "policy EXP-25" is missing although the policy exists.', cause: 'Pure vector search is weak at exact identifiers; embeddings do not preserve codes well.', fix: 'Use hybrid retrieval so BM25 matches the exact code.' },
    { id: 'overflow', title: 'Requests fail once k is raised', values: { chunk: 'large', topK: 8, budget: 4000 }, node: 'prompt',
      symptom: 'context_length_exceeded when building the prompt.', cause: '8 large chunks (~1,500 tokens each) exceed the token budget.', fix: 'Use smaller chunks or a lower k (e.g. medium, k=3–5), or raise the budget only if the model window allows.' },
    { id: 'fabricate', title: 'Bot invents a parking allowance', values: { query: 'q6', strict: false }, node: 'answer',
      symptom: 'Confident answer with no citation and no supporting source.', cause: 'No grounding instruction: the model fills the gap from priors.', fix: 'Turn on the strict grounding instruction so it declines when sources lack the answer.' },
    { id: 'dims', title: 'Vector queries return 400', values: { embed: 'mismatch', mode: 'hybrid' }, node: 'embed',
      symptom: 'Vector dimension mismatch error from the search service.', cause: 'Query embedded with a different model than the index (1536 vs 3072 dimensions).', fix: 'Embed queries with the same model as the index, or use the index vectorizer.' },
    { id: 'rbac', title: '403 from the search service in production', values: { rbac: false }, node: 'search',
      symptom: 'Forbidden on every query.', cause: 'Managed identity lacks a data-plane role on Azure AI Search.', fix: 'Assign "Search Index Data Reader" to the app identity.' },
    { id: 'vocab', title: 'Keyword search cannot find synonyms', values: { query: 'q4', mode: 'keyword' }, node: 'search',
      symptom: 'No relevant chunks for "holiday … roll forward".', cause: 'The handbook says "leave … carried over"; BM25 needs shared words.', fix: 'Use vector or hybrid retrieval.' },
  ],

  challenge: {
    task: 'Answer "What should I do if I lose my laptop?" with a grounded, cited answer while spending no more than 1,000 source tokens.',
    condition: 'Question = lost laptop, final answer grounded with citations, no warn/error steps, source tokens ≤ 1,000.',
    hint: 'Keyword search struggles with "lose" vs "lost". Smaller chunks cost fewer tokens.',
    check: (p, res) => p.query === 'q3' && !res.steps.some(s => s.status === 'error' || s.status === 'warn') && res.steps.some(s => s.title === 'Grounded answer with citations') && Number(p.topK) * (CHUNKING[p.chunk] || CHUNKING.medium).tokens <= 1000,
    solution: ['Select the lost-laptop question.', 'Use hybrid (or hybrid + semantic) retrieval.', 'Choose small chunks and k=3 (~384 source tokens).', 'Keep strict grounding and citations on. Run.'],
    solutionValues: { query: 'q3', mode: 'hybrid', chunk: 'small', topK: 3, strict: true, cite: true, embed: 'match', rbac: true, budget: 4000 },
  },

  quiz: [
    { q: 'Users ask "How much holiday can I roll forward?" but the handbook says "unused leave days can be carried over". Keyword search returns nothing useful. What should you change first?', options: ['Increase max_tokens', 'Switch to hybrid or vector retrieval', 'Lower the temperature', 'Use a larger chat model'], answer: 1, why: 'This is a vocabulary mismatch. Vector (semantic) similarity matches meaning; hybrid keeps keyword strengths too.' },
    { q: 'Your RAG bot sometimes answers questions the documents do not cover with plausible but invented policies. Which change best addresses this?', options: ['Raise top-k to 20', 'Add a grounding instruction to answer only from sources and decline otherwise, and evaluate groundedness', 'Disable citations', 'Switch to keyword search'], answer: 1, why: 'Fabrication on uncovered questions is fixed by grounding instructions plus groundedness evaluation, not more noise in the prompt.' },
    { q: 'After switching the index to a new embedding model, all vector queries fail with a dimension mismatch. What is the cause?', options: ['The semantic ranker is disabled', 'Queries are still embedded with the old model', 'top-k is too high', 'The chat deployment was deleted'], answer: 1, why: 'Query vectors must come from the same embedding model (same dimensions) as the indexed vectors.' },
    { q: 'Raising k from 3 to 10 with ~1,500-token chunks made answers slower and occasionally caused context errors. Best fix?', options: ['Use smaller chunks and/or a reranker with a lower k', 'Remove the system prompt', 'Use keyword search only', 'Increase temperature'], answer: 0, why: 'Smaller, better-ranked chunks keep recall while cutting tokens and noise.' },
  ],

  recap: 'RAG quality is decided before the model writes a word: same embedding model as the index, the right retrieval mode (hybrid + semantic ranker is a strong default), a chunk size and k that capture the evidence within a token budget, and a prompt that demands grounded, cited answers and permits "I don\'t know".',
};
