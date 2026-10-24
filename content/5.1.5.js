// 5.1.5 Connect retrieval pipelines directly to workflows and agent tools
// Lab: Agent retrieval wiring console.
import { step, metric, words, round } from '../src/engine/util.js';

// Toy indexes. group_ids drives security trimming. `a` = the sentence an agent would answer with.
const HR = [
  { id: 'hr-001', title: 'Parental leave policy', groups: ['all-staff'], text: 'Employees receive 20 weeks of paid parental leave after birth or adoption.', a: 'You get 20 weeks of paid parental leave.' },
  { id: 'hr-002', title: 'Contractor holiday terms', groups: ['contractors', 'hr'], text: 'Contractors accrue holiday at 2 days per month worked. Holiday is unpaid unless the contract says otherwise.', a: 'Contractors accrue 2 days of holiday per month worked, unpaid unless the contract says otherwise.' },
  { id: 'hr-003', title: 'Salary bands 2026 (confidential)', groups: ['hr'], text: 'Salary band for level L5: 78,000 to 96,000 GBP. Bands are reviewed each April.', a: 'The L5 salary band is 78,000 to 96,000 GBP.' },
  { id: 'hr-004', title: 'Annual leave policy', groups: ['all-staff'], text: 'Employees accrue 25 days of annual leave per year plus public holidays.', a: 'Employees get 25 days of annual leave plus public holidays.' },
  { id: 'hr-005', title: 'Performance review cycle', groups: ['all-staff'], text: 'Reviews happen twice a year. Salary changes follow the April review.', a: '' },
  { id: 'hr-006', title: 'Disciplinary case notes (restricted)', groups: ['hr'], text: 'Case 2026-14: notes on leave misuse investigation for an employee in Sales.', a: '' },
];
const FIN = [
  { id: 'fin-001', title: 'Expense policy', groups: ['all-staff'], text: 'Submit expenses within 30 days with receipts.', a: '' },
  { id: 'fin-002', title: 'Invoice approval', groups: ['all-staff'], text: 'Invoices above 10,000 need two approvers.', a: '' },
];
const INDEXES = {
  'hr-policies': { exists: true, vector: true, docs: HR },
  'finance-docs': { exists: true, vector: false, docs: FIN },
  'hr-policies-v1': { exists: false, docs: [] },
};
const USERS = {
  alice: { label: 'Alice (HR partner)', groups: ['all-staff', 'hr'] },
  bob: { label: 'Bob (engineer)', groups: ['all-staff'] },
  carol: { label: 'Carol (contractor)', groups: ['contractors'] },
};
const QUESTIONS = {
  parental: { text: 'How many weeks of parental leave do I get?', target: 'hr-001' },
  paraphrase: { text: 'Can I take time off when my baby arrives?', target: 'hr-001' },
  contractor: { text: 'How much holiday do contractors get?', target: 'hr-002' },
  salary: { text: 'What is the salary band for L5?', target: 'hr-003' },
};
// Toy semantic expansion used by vector / hybrid query types (stands in for embeddings).
const SYN = { baby: ['parental', 'birth', 'adoption'], arrives: ['birth'], time: ['leave'], off: ['leave', 'holiday'], pay: ['salary'], holiday: ['leave'] };
const STOP = new Set(['how', 'many', 'of', 'do', 'i', 'get', 'can', 'take', 'when', 'my', 'what', 'is', 'the', 'for', 'much', 'a']);

const QUERY_TYPES = {
  simple: { label: 'simple (keyword)', vector: false },
  semantic: { label: 'semantic', vector: false },
  vector: { label: 'vector', vector: true },
  vector_semantic_hybrid: { label: 'vector_semantic_hybrid', vector: true },
};

function score(q, d, useVec) {
  let qw = words(q).filter(w => !STOP.has(w));
  if (useVec) qw = qw.concat(...qw.map(w => SYN[w] || []));
  const dw = new Set(words(d.title + ' ' + d.text));
  const hits = qw.filter(w => dw.has(w)).length;
  return qw.length ? hits / qw.length : 0;
}

function run(p) {
  const steps = [];
  const user = USERS[p.user] || USERS.bob;
  const qd = QUESTIONS[p.question] || QUESTIONS.parental;
  const qt = QUERY_TYPES[p.queryType] || QUERY_TYPES.simple;
  const idx = INDEXES[p.indexName];
  const topK = Math.max(1, Math.round(Number(p.topK) || 3));
  const filter = p.securityFilter ? `group_ids/any(g: search.in(g, '${user.groups.join(',')}'))` : null;
  const ctx = { user, qd, qt, idx, topK, filter, results: [], answer: '', cited: [], leaked: [] };

  steps.push(step('user', 'User asks', `${user.label}: "${qd.text}"`, { userGroups: user.groups }, 'info'));
  const via = p.target === 'workflow' ? 'Workflow step calls Azure AI Search directly' : p.target === 'agentic' ? 'Agent calls the knowledge base (agentic retrieval)' : 'Agent decides to call the Azure AI Search tool';
  const callArgs = p.target === 'agentic'
    ? { knowledgeBase: 'hr-kb', knowledgeSource: p.indexName, subqueries: qd.text.split(/ and |\? /).map(s => s.replace('?', '').trim()).filter(Boolean) }
    : { index: p.indexName, query: qd.text, query_type: p.queryType, top_k: topK, filter };
  steps.push(step('agent', via, p.target === 'agentic' ? 'The planner rewrites the question into focused subqueries, runs them in parallel (semantic ranking applies) and merges grounding data with references. Preview feature in this simulation; check current docs.' : p.target === 'workflow' ? 'Deterministic: every request runs the search, then passes results to the model step. No model decision about whether to retrieve.' : 'The model chose the tool because the instructions say to answer HR questions from the HR index.', callArgs));

  // Connection / auth
  if (p.auth === 'noRole') {
    steps.push(step('connection', 'Search call rejected (403)', 'The project connection uses Microsoft Entra ID, but the identity making the call (the Foundry project managed identity) has no Search Index Data Reader role on the search service. The tool returns an error to the agent.', { httpStatus: 403, auth: 'Entra ID', missingRole: 'Search Index Data Reader' }, 'error'));
    ctx.answer = 'I could not reach the HR knowledge base right now, so I cannot answer reliably.';
    return finish(p, steps, ctx);
  }
  steps.push(step('connection', 'Connection authorised', p.auth === 'key' ? 'API key stored in the project connection. Works, but keys are shared secrets; prefer Entra ID + Search Index Data Reader.' : 'Keyless: project managed identity holds Search Index Data Reader.', { auth: p.auth === 'key' ? 'api-key' : 'Entra ID (managed identity)' }, p.auth === 'key' ? 'warn' : 'ok'));

  // Index
  if (!idx || !idx.exists) {
    steps.push(step('index', 'Index not found (404)', `No index named "${p.indexName}" exists on the connected search service (renamed or deleted after a reindex).`, { httpStatus: 404, index: p.indexName }, 'error'));
    ctx.answer = 'Sorry, I could not search the knowledge base.';
    return finish(p, steps, ctx);
  }
  if (qt.vector && !idx.vector) {
    steps.push(step('index', 'Query type not supported by this index', `query_type ${p.queryType} needs a vector field and vectorizer; "${p.indexName}" has neither.`, { httpStatus: 400, vectorFields: 0 }, 'error'));
    ctx.answer = 'Sorry, the search tool failed.';
    return finish(p, steps, ctx);
  }
  steps.push(step('index', 'Index resolved', `"${p.indexName}" • ${idx.docs.length} documents • vector: ${idx.vector ? 'yes' : 'no'}.`, { index: p.indexName, documents: idx.docs.length }, 'ok'));

  // Search
  const pool = idx.docs.filter(d => !p.securityFilter || d.groups.some(g => user.groups.includes(g)));
  const scored = pool.map(d => ({ d, s: score(qd.text, d, qt.vector || p.target === 'agentic') })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.d.id.localeCompare(b.d.id));
  ctx.results = scored.slice(0, topK);
  steps.push(step('search', `Retrieved ${ctx.results.length} document(s)`, `${filter ? `Security filter applied (${pool.length}/${idx.docs.length} documents visible to ${user.label.split(' ')[0]}). ` : 'No security filter: every document is a candidate. '}Top: ${ctx.results.map(x => x.d.id).join(', ') || 'none'}.`,
    { filter, results: ctx.results.map(x => ({ id: x.d.id, title: x.d.title, score: round(x.s, 2), group_ids: x.d.groups })) }, ctx.results.length ? 'ok' : 'warn'));

  // Security check
  ctx.leaked = ctx.results.filter(x => !x.d.groups.some(g => user.groups.includes(g))).map(x => x.d);
  if (ctx.leaked.length) {
    steps.push(step('security', 'Documents leaked to an unauthorised user', `${ctx.leaked.map(d => `${d.id} "${d.title}"`).join(', ')} returned to ${user.label}, who is not in ${[...new Set(ctx.leaked.flatMap(d => d.groups))].join('/')}. The model now has the content in its context and can repeat it.`,
      { user: p.user, userGroups: user.groups, leaked: ctx.leaked.map(d => ({ id: d.id, group_ids: d.groups })) }, 'error'));
  } else {
    steps.push(step('security', p.securityFilter ? 'Security trimming OK' : 'No leak this time (no filter in place)', p.securityFilter ? 'Only documents whose group_ids intersect the user\'s groups were eligible.' : 'Nothing restricted happened to rank for this question, but the configuration would leak on other questions.', { filter }, p.securityFilter ? 'ok' : 'warn'));
  }

  // Answer
  const hit = ctx.results.find(x => x.d.id === qd.target);
  if (hit && hit.d.a) {
    ctx.answer = hit.d.a + (p.citations ? ` [${hit.d.id}: ${hit.d.title}]` : '');
    ctx.cited = p.citations ? [hit.d] : [];
    steps.push(step('answer', p.citations ? 'Grounded answer with citation' : 'Answer without citation', p.citations ? `Answer cites ${hit.d.id}.` : 'Retrieved content was used, but the instructions do not require citations, so the user cannot verify the source.', { citations: ctx.cited.map(d => d.id) }, p.citations ? (ctx.leaked.length ? 'error' : 'ok') : 'warn'));
  } else {
    ctx.answer = 'I could not find that in the documents available to you.';
    const restricted = qd.target === 'hr-003' && p.securityFilter && !user.groups.includes('hr');
    steps.push(step('answer', restricted ? 'Correct refusal' : 'No grounded answer', restricted ? 'The restricted document was trimmed by the security filter, so the agent says it cannot find it. This is the desired behaviour.' : `The document that answers this question (${qd.target}) was not retrieved: ${p.indexName !== 'hr-policies' ? 'wrong index connected' : qt.vector ? `top_k ${topK} too low or not visible to this user` : 'keyword query cannot match the paraphrase; try a vector or hybrid query type'}.`,
      { expected: qd.target, retrieved: ctx.results.map(x => x.d.id) }, restricted ? 'ok' : 'warn'));
  }
  return finish(p, steps, ctx);
}

function finish(p, steps, ctx) {
  const toolName = p.target === 'workflow' ? 'search_step' : p.target === 'agentic' ? 'knowledge_base_retrieve' : 'azure_ai_search';
  const output = [
    { type: 'chat', title: 'Conversation trace (simulated)', turns: [
      { role: 'user', text: ctx.qd.text, meta: ctx.user.label },
      { role: p.target === 'workflow' ? 'system' : 'assistant', text: `${p.target === 'workflow' ? 'workflow →' : 'tool call →'} ${toolName}(${p.target === 'agentic' ? `kb="hr-kb"` : `index="${p.indexName}", query_type="${p.queryType}", top_k=${ctx.topK}`}${ctx.filter ? ', filter=…' : ''})` },
      { role: 'tool', text: ctx.results.length ? ctx.results.map(x => `[${x.d.id}] ${x.d.title}: ${x.d.text}`).join('\n') : steps.some(s => s.status === 'error' && s.node !== 'security' && s.node !== 'answer') ? `error: ${steps.at(-1).title}` : '0 results', meta: ctx.filter ? 'security-trimmed' : 'no filter' },
      { role: 'assistant', text: ctx.answer || '(no answer)' },
    ] },
  ];
  if (ctx.idx && ctx.idx.exists) {
    output.push({ type: 'table', title: `Documents in ${p.indexName} and visibility for ${ctx.user.label}`, columns: ['id', 'Title', 'group_ids', 'User may see', 'Retrieved'],
      rows: ctx.idx.docs.map(d => [d.id, d.title, d.groups.join(', '), d.groups.some(g => ctx.user.groups.includes(g)) ? 'yes' : 'no', ctx.results.some(x => x.d.id === d.id) ? 'yes' : '']),
      tones: ctx.idx.docs.map(d => { const r = ctx.results.some(x => x.d.id === d.id); const ok = d.groups.some(g => ctx.user.groups.includes(g)); return r && !ok ? 'error' : r ? 'ok' : 'muted'; }) });
  }
  output.push({ type: 'code', lang: 'python', title: p.target === 'workflow' ? 'Workflow step (illustrative)' : p.target === 'agentic' ? 'Agentic retrieval wiring (illustrative, preview APIs change)' : 'Agent with Azure AI Search tool (illustrative; check SDK version)', text:
    p.target === 'workflow'
      ? `results = search_client.search(\n    search_text=question,\n    query_type="${p.queryType.includes('semantic') ? 'semantic' : 'simple'}",\n    top=${ctx.topK},\n    filter=${ctx.filter ? `f"group_ids/any(g: search.in(g, '{','.join(user_groups)}'))"` : 'None'},\n)\ncontext = format_with_ids(results)\nanswer = model_step(question, context)  # next workflow node`
      : p.target === 'agentic'
        ? `# Knowledge base over a knowledge source that points at the "${p.indexName}" index\n# (Azure AI Search agentic retrieval / Foundry IQ). Names are illustrative.\nresult = kb_client.retrieve(messages=[{"role": "user", "content": question}],\n                            filter_add_on=${ctx.filter ? '"group_ids/any(...)"' : 'None'})\n# result.response -> grounding text, result.references -> citations`
        : `from azure.ai.agents.models import AzureAISearchTool, AzureAISearchQueryType\nsearch_tool = AzureAISearchTool(\n    index_connection_id=conn.id,          # project connection to the search service\n    index_name="${p.indexName}",\n    query_type=AzureAISearchQueryType.${p.queryType.toUpperCase()},\n    top_k=${ctx.topK},\n    filter=${ctx.filter ? `"${ctx.filter}"` : '""'},\n)\nagent = agents_client.create_agent(model="gpt-4.1", name="hr-helper",\n    instructions="Answer only from the HR index.${p.citations ? ' Always cite sources.' : ''}",\n    tools=search_tool.definitions, tool_resources=search_tool.resources)` });
  if (ctx.leaked.length) output.push({ type: 'alert', tone: 'error', text: 'Data exposure: restricted documents reached the model for a user who is not allowed to read them. Apply a security filter (or document-level permissions) on every request.' });
  const grounded = ctx.cited.length > 0 && !ctx.leaked.length;
  return {
    steps, output,
    metrics: [
      metric('Grounded answer', grounded ? 'yes' : 'no', 'computed', 'Answer cites the document that contains it, with no leak.'),
      metric('Documents retrieved', String(ctx.results.length), 'computed'),
      metric('Restricted documents leaked', String(ctx.leaked.length), 'computed'),
      metric('Model decides when to retrieve', p.target === 'workflow' ? 'no (always retrieves)' : 'yes', 'computed', 'Tool use is model-driven; workflow steps are deterministic.'),
      metric('Relative latency', p.target === 'agentic' ? 'highest (query planning + subqueries)' : p.queryType === 'vector_semantic_hybrid' ? 'medium' : 'lower', 'estimate', 'Qualitative: planning and semantic ranking add round trips. Measure in your own environment.'),
    ],
    summary: steps.some(s => s.status === 'error') ? `${steps.find(s => s.status === 'error').title}` : `${p.target} • ${p.queryType} • ${grounded ? 'grounded + cited' : 'not grounded'}`,
  };
}

export default {
  id: '5.1.5',
  lab: 'Agent retrieval wiring console',
  services: [
    { name: 'Azure AI Search tool for Foundry agents', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/azure-ai-search' },
    { name: 'Agentic retrieval in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-overview' },
    { name: 'Security filters for trimming results', url: 'https://learn.microsoft.com/en-us/azure/search/search-security-trimming-for-azure-search' },
  ],
  prereqs: ['5.1.2', '2.2.1'],
  next: ['2.2.2', '2.2.3', '1.3.4'],

  concept: {
    plain: 'An index is only useful once something asks it questions. You can give an agent a search tool (the model decides when to look things up), put a search step in a workflow (it always looks things up), or use agentic retrieval that splits a complex question into smaller searches. Either way you choose which index, how to search it, how many results to return, and which documents this particular user is allowed to see.',
    technical: 'In Foundry Agent Service, the Azure AI Search tool uses a project connection to the search service plus index_name, query_type (simple, semantic, vector, vector_simple_hybrid, vector_semantic_hybrid), top_k and an OData filter; results come back as tool output the model cites. Agentic retrieval (knowledge bases/knowledge sources in Azure AI Search, surfaced in Foundry) plans subqueries and returns grounding data with references. Workflows call the index directly with azure-search-documents. Access uses Entra ID (Search Index Data Reader for the calling identity) or keys; per-user security trimming uses a filter on a group_ids collection (or document-level permission features) built from the user\'s identity on every request.',
    useCase: 'An HR assistant in Teams answers policy questions for employees, contractors and HR partners from one index. Confidential salary bands are tagged group_ids = hr, and the app builds a group filter from the signed-in user\'s Entra ID groups so the agent can never retrieve them for an engineer.',
    terms: [
      ['Project connection', 'Stored, governed link from a Foundry project to a resource such as Azure AI Search (Entra ID or key).'],
      ['query_type', 'How the tool queries the index: keyword, semantic, vector or hybrid variants.'],
      ['top_k', 'Number of results passed back to the model; too low drops evidence, too high adds noise and tokens.'],
      ['Security trimming', 'Filtering results per user (e.g. group_ids/any(g: search.in(g, ...))) so unauthorised documents never reach the model.'],
      ['Agentic retrieval', 'LLM-assisted query planning over a knowledge base: decomposes questions, runs subqueries, merges results with references.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'user', label: p ? USERS[p.user].label : 'User', col: 0, row: 1, kind: 'user', detail: 'Signed-in user; their groups decide what they may see.' },
          { id: 'agent', label: p ? { tool: 'Agent + search tool', agentic: 'Agent + knowledge base', workflow: 'Workflow search step' }[p.target] : 'Agent', col: 1, row: 1, kind: 'ai', detail: 'Decides (tool) or always (workflow) retrieves.' },
          { id: 'connection', label: 'Connection + auth', col: 2, row: 0, kind: 'policy', detail: 'Which service and which identity.', badge: p && p.auth === 'noRole' ? 'no role' : undefined },
          { id: 'index', label: p ? `Index: ${p.indexName}` : 'Index', col: 2, row: 2, kind: 'data', detail: 'Must exist and support the query type.' },
          { id: 'search', label: p ? `Search ${p.queryType}, top ${p.topK}` : 'Search', col: 3, row: 1, detail: 'Ranks candidates after the filter.' },
          { id: 'security', label: 'Security trimming', col: 3, row: 2, kind: 'policy', disabled: p ? !p.securityFilter : false, detail: 'Per-user group filter applied on every request.' },
          { id: 'answer', label: 'Answer + citations', col: 4, row: 1, detail: 'Grounded only if it cites retrieved content.' },
        ],
        edges: [['user', 'agent'], ['agent', 'connection'], ['connection', 'index'], ['index', 'search'], ['security', 'search', 'filter'], ['search', 'answer']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'user', label: 'Teams / web app (Entra ID sign-in)', col: 0, row: 1, kind: 'app', detail: 'Gets the user\'s group claims to build the filter.' },
          { id: 'agent', label: p && p.target === 'workflow' ? 'Workflow (Foundry workflow / Logic App)' : 'Foundry Agent Service agent', col: 1, row: 1, kind: 'compute', detail: 'Runs in a Foundry project.' },
          { id: 'connection', label: 'Project connection → Azure AI Search', col: 2, row: 0, kind: 'policy', detail: 'Entra ID: grant the project managed identity Search Index Data Reader (Search Service Contributor only if it must manage indexes).' },
          { id: 'index', label: `Azure AI Search: ${p ? p.indexName : 'hr-policies'}`, col: 3, row: 0, kind: 'data', detail: 'group_ids is a filterable Collection(Edm.String).' },
          { id: 'search', label: p && p.target === 'agentic' ? 'Knowledge base (agentic retrieval)' : 'Search query', col: 3, row: 2, kind: 'ai', detail: 'Agentic retrieval uses an LLM for query planning and the semantic ranker.' },
          { id: 'security', label: 'Entra ID groups', col: 0, row: 3, kind: 'policy', detail: 'Source of truth for group_ids values.' },
          { id: 'answer', label: 'Model deployment (Azure OpenAI in Foundry)', col: 4, row: 1, kind: 'ai', detail: 'Generates the answer from tool output.' },
        ],
        edges: [['user', 'agent'], ['agent', 'connection'], ['connection', 'index'], ['index', 'search'], ['search', 'agent', 'results'], ['agent', 'answer'], ['security', 'user']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'connection', label: 'conn = project_client.connections.get("hr-search")', col: 0, row: 0, kind: 'code', detail: 'azure-ai-projects AIProjectClient(endpoint, DefaultAzureCredential()).' },
          { id: 'security', label: `flt = ${p && p.securityFilter ? '"group_ids/any(g: search.in(g, \'" + ",".join(user_groups) + "\'))"' : 'None  # no trimming'}`, col: 0, row: 1, kind: 'code', detail: 'Built per request from the signed-in user.' },
          { id: 'index', label: `AzureAISearchTool(index_connection_id=conn.id, index_name="${p ? p.indexName : 'hr-policies'}", …)`, col: 0, row: 2, kind: 'code', detail: 'azure-ai-agents. Illustrative; check parameter names for your version.' },
          { id: 'search', label: `  query_type=${p ? p.queryType : 'simple'}, top_k=${p ? p.topK : 3}, filter=flt`, col: 0, row: 3, kind: 'code', detail: 'Tool configuration.' },
          { id: 'agent', label: 'agents_client.runs.create_and_process(thread_id, agent_id)', col: 0, row: 4, kind: 'code', detail: 'The run includes tool calls and outputs; inspect run steps for retrieved docs.' },
          { id: 'answer', label: 'message.content[0].text.annotations  # url/file citations', col: 0, row: 5, kind: 'code', detail: 'Render citations to the user.' },
          { id: 'user', label: 'user_groups = token_claims["groups"]', col: 1, row: 1, kind: 'code', detail: 'From Entra ID token (or Graph lookup for large group counts).' },
        ],
        edges: [['connection', 'index'], ['user', 'security'], ['security', 'search'], ['index', 'search'], ['search', 'agent'], ['agent', 'answer']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'target', label: 'Retrieval wired into', type: 'select', options: [['tool', 'Agent: Azure AI Search tool'], ['agentic', 'Agent: knowledge base (agentic retrieval)'], ['workflow', 'Workflow: search step']], default: 'tool' },
      { id: 'auth', label: 'Connection authentication', type: 'select', options: [['mi', 'Entra ID, project identity has Search Index Data Reader'], ['noRole', 'Entra ID, no role assigned'], ['key', 'API key in connection']], default: 'mi' },
      { id: 'indexName', label: 'index_name', type: 'select', options: [['hr-policies', 'hr-policies'], ['hr-policies-v1', 'hr-policies-v1 (deleted)'], ['finance-docs', 'finance-docs']], default: 'hr-policies' },
      { id: 'queryType', label: 'query_type', type: 'select', options: Object.entries(QUERY_TYPES).map(([v, q]) => [v, q.label]), default: 'simple' },
      { id: 'topK', label: 'top_k', type: 'range', min: 1, max: 6, step: 1, default: 3 },
      { id: 'securityFilter', label: 'Per-user security filter', type: 'toggle', default: true },
      { id: 'citations', label: 'Instructions require citations', type: 'toggle', default: true },
      { id: 'user', label: 'Signed-in user', type: 'select', options: Object.entries(USERS).map(([v, u]) => [v, u.label]), default: 'bob' },
      { id: 'question', label: 'Question', type: 'select', options: Object.entries(QUESTIONS).map(([v, q]) => [v, q.text]), default: 'parental' },
    ],
    samples: [
      { label: 'Engineer asks about parental leave', values: { user: 'bob', question: 'parental' } },
      { label: 'Engineer asks for salary bands (trimmed)', values: { user: 'bob', question: 'salary', securityFilter: true } },
      { label: 'HR partner asks for salary bands', values: { user: 'alice', question: 'salary' } },
      { label: 'Paraphrase with hybrid query', values: { user: 'bob', question: 'paraphrase', queryType: 'vector_semantic_hybrid' } },
      { label: 'Workflow step for a contractor', values: { target: 'workflow', user: 'carol', question: 'contractor' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Ask the salary question as Bob with the security filter on, then off. Compare "Restricted documents leaked".',
      'Ask the paraphrased parental-leave question with query_type simple, then vector_semantic_hybrid.',
      'Run the same question through the search tool, agentic retrieval and a workflow step and compare "Model decides when to retrieve" and latency.',
    ],
  },

  debug: [
    { id: 'rbac', title: 'Agent says the knowledge base is unreachable', values: { auth: 'noRole' }, node: 'connection',
      symptom: 'Tool call fails with 403; the agent apologises.', cause: 'The project managed identity has no data-plane role on the search service.', fix: 'Assign Search Index Data Reader to the identity used by the connection (or use a key connection temporarily).' },
    { id: 'wrongindex', title: 'Tool returns 404 after a reindex', values: { indexName: 'hr-policies-v1' }, node: 'index',
      symptom: 'Index not found.', cause: 'The agent still points at an index name that was deleted/renamed.', fix: 'Update index_name to the live index (use an index alias in production so agents survive reindexing).' },
    { id: 'wrongcontent', title: 'Agent cannot find obvious HR answers', values: { indexName: 'finance-docs', question: 'parental' }, node: 'index',
      symptom: 'Search runs but results are about expenses; agent says it cannot find the answer.', cause: 'Connected to the wrong index.', fix: 'Set index_name to hr-policies.' },
    { id: 'leak', title: 'Engineer receives salary bands', values: { user: 'bob', question: 'salary', securityFilter: false }, node: 'security',
      symptom: 'Confidential document appears in tool output and in the answer.', cause: 'No per-user security filter: every document is a candidate for every user.', fix: 'Apply the group_ids filter built from the signed-in user on every request.' },
    { id: 'vecwrong', title: 'Vector query type on a keyword-only index', values: { indexName: 'finance-docs', queryType: 'vector' }, node: 'index',
      symptom: 'Tool error 400.', cause: 'The index has no vector field/vectorizer.', fix: 'Use simple or semantic for that index, or add vectors.' },
    { id: 'paraphrase', title: 'Paraphrased question finds nothing', values: { user: 'bob', question: 'paraphrase', queryType: 'simple' }, node: 'search',
      symptom: 'No grounded answer although the policy exists.', cause: 'Keyword query cannot match "baby arrives" to "parental leave".', fix: 'Use a vector or hybrid query type.' },
  ],

  challenge: {
    task: 'Bob asks "Can I take time off when my baby arrives?". Return a cited answer from the HR index with security trimming on and at most 3 results passed to the model.',
    condition: 'User = Bob, question = paraphrase, security filter on, top_k ≤ 3, Grounded answer = yes, no warn/error steps.',
    hint: 'The words in the question are not the words in the policy. Also check how the connection authenticates.',
    check: (p, res) => p.user === 'bob' && p.question === 'paraphrase' && p.securityFilter && Number(p.topK) <= 3 && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.metrics.some(m => m.label === 'Grounded answer' && m.value === 'yes'),
    solution: ['Keep index_name hr-policies and Entra ID auth with Search Index Data Reader.', 'Set query_type to vector or vector_semantic_hybrid so the paraphrase matches "parental leave".', 'Keep the security filter on and top_k at 3.', 'Keep "require citations" on.'],
    solutionValues: { target: 'tool', auth: 'mi', indexName: 'hr-policies', queryType: 'vector_semantic_hybrid', topK: 3, securityFilter: true, citations: true, user: 'bob', question: 'paraphrase' },
  },

  quiz: [
    { q: 'Engineers should never see HR-only documents, but one index serves everyone. What do you implement?', options: ['A separate agent instruction "do not reveal HR documents"', 'A per-request security filter on group_ids built from the user\'s Entra ID groups', 'A lower top_k', 'The semantic ranker'], answer: 1, why: 'Instructions are not access control. Trim results at query time so restricted content never reaches the model.' },
    { q: 'Your Foundry agent\'s search tool fails with 403 after you switched the connection from key to Entra ID. What is missing?', options: ['Search Index Data Reader for the identity the connection uses', 'Cognitive Services OpenAI User on the search service', 'A semantic configuration', 'A new index'], answer: 0, why: 'Querying an index with Entra ID needs a data-plane role such as Search Index Data Reader.' },
    { q: 'Every request in a compliance pipeline must retrieve policy text before the model writes anything, with no model discretion. Which wiring fits best?', options: ['Agent with a search tool and optional use', 'A workflow step that always calls search and passes results to the model step', 'No retrieval; rely on the model', 'Code interpreter tool'], answer: 1, why: 'Workflows make retrieval deterministic; tools let the model decide whether to call them.' },
    { q: 'Users ask multi-part questions ("compare parental leave and contractor holiday") and single searches miss half. Which option is designed for this?', options: ['Raise top_k to 50', 'Agentic retrieval with query planning into subqueries', 'Disable the security filter', 'Keyword-only search'], answer: 1, why: 'Agentic retrieval decomposes complex questions into focused subqueries and merges the grounded results.' },
  ],

  recap: 'Wire retrieval as an agent tool (model-driven), a knowledge base with agentic retrieval (planned subqueries), or a workflow step (deterministic). Configure the connection with Entra ID and Search Index Data Reader, the right index name (aliases help), a query type the index supports, a sensible top_k, citations, and a per-user security filter on every request.',
};
