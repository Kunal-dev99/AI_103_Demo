// 2.2.3 Integrate agent tools, including APIs, knowledge stores, search, content understanding, and custom functions
// Lab: Agent tool workbench.
import { rng, round, step, metric } from '../src/engine/util.js';
const fmt = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Tool catalogue. `type` is the tool type as it appears in an agent definition (illustrative shape).
const TOOLS = {
  openapi: { label: 'OpenAPI tool: Orders API', type: 'openapi', clear: 'Look up a customer order by order ID or list orders for a customer and date range. Returns status, items, carrier.', vague: 'Company data API.' },
  search: { label: 'Azure AI Search tool: hr-policies index', type: 'azure_ai_search', clear: 'Search the official HR policy index (leave, benefits, expenses). Use for any company policy question.', vague: 'Search documents.' },
  file: { label: 'File search: vector store "team-uploads"', type: 'file_search', clear: 'Search files that users uploaded in this thread (drafts, notes). Not authoritative policy.', vague: 'Search documents.' },
  cu: { label: 'Content Understanding analyzer (wrapped as a function)', type: 'function', clear: 'Extract fields (parties, renewal date, notice period) from an uploaded contract using a Content Understanding analyzer.', vague: 'Process a file.' },
  func: { label: 'Azure Functions tool: estimate_shipping', type: 'azure_function', clear: 'Estimate shipping cost and days for a parcel. Inputs: weightKg (number), destinationCity (string).', vague: 'Shipping helper.' },
  mcp: { label: 'MCP server: tickets (remote)', type: 'mcp', clear: 'Create, update and query IT incident tickets in the ticketing system.', vague: 'Ticket stuff.' },
  code: { label: 'Code interpreter', type: 'code_interpreter', clear: 'Run Python in a sandbox to analyse uploaded CSV/Excel files and produce charts.', vague: 'Run code.' },
};

// Requests the learner can send. `want` = tools that can answer it, in preference order.
const REQUESTS = {
  policy: { label: '"How many days of parental leave do we get?"', want: ['search', 'file'], args: { query: 'parental leave entitlement days' } },
  order: { label: '"What is the status of order 4417?"', want: ['openapi'], args: { orderId: '4417' } },
  history: { label: '"List every order Contoso placed this year."', want: ['openapi'], args: { customer: 'Contoso', from: '2026-01-01' } },
  contract: { label: '"When does the uploaded supplier contract renew?"', want: ['cu', 'code', 'file'], args: { fileId: 'assistant-file-7Qk', analyzerId: 'contract-fields' } },
  shipping: { label: '"Estimate shipping for a 12 kg parcel to Lyon."', want: ['func'], args: { weightKg: 12, destinationCity: 'Lyon' } },
  ticket: { label: '"Open a P2 ticket: VPN down in the Leeds office."', want: ['mcp'], args: { priority: 'P2', title: 'VPN down - Leeds office' } },
  chart: { label: '"Chart monthly revenue from the attached sales.csv."', want: ['code'], args: { fileId: 'assistant-file-3Ab' } },
};

const enabled = (p, k) => !!(p && p['t_' + k]);

function chooseTool(p, req) {
  // With vague descriptions the model cannot tell the two document stores apart and picks the first "search" it sees.
  const attached = Object.keys(TOOLS).filter(k => enabled(p, k));
  if (p.descriptions === 'vague' && p.request === 'policy' && enabled(p, 'file')) return { tool: 'file', reason: 'Both tools are described as "Search documents." The model picked file_search, which only holds thread uploads.', ambiguous: true, attached };
  if (p.descriptions === 'vague' && p.request === 'contract' && enabled(p, 'code') && enabled(p, 'cu')) return { tool: 'code', reason: '"Process a file" vs "Run code": the model tried to parse the PDF in code interpreter instead of the analyzer.', ambiguous: true, attached };
  const tool = req.want.find(k => enabled(p, k));
  return { tool: tool || null, reason: tool ? `Description of ${TOOLS[tool].type} matches the request intent.` : 'No attached tool matches this request.', ambiguous: false, attached };
}

function callPayload(p, toolKey, req) {
  const t = TOOLS[toolKey];
  switch (toolKey) {
    case 'openapi': return { type: 'openapi', name: p.request === 'history' ? 'orders_listOrders' : 'orders_getOrder', arguments: p.request === 'history' ? { customer: 'Contoso', from: '2026-01-01', ...(p.shaping === 'paged' ? { top: 25, fields: 'id,status,total' } : {}) } : { orderId: '4417' }, auth: p.openapiAuth };
    case 'search': return { type: 'azure_ai_search', index_name: p.searchIndex, query: req.args.query, query_type: 'vector_semantic_hybrid', top_k: 5 };
    case 'file': return { type: 'file_search', vector_store_ids: ['vs_team_uploads'], query: req.args.query || 'renewal date' };
    case 'cu': return { type: 'function', name: 'analyze_contract', arguments: JSON.stringify({ fileId: 'assistant-file-7Qk', analyzerId: 'contract-fields' }) };
    case 'func': return { type: 'azure_function', name: 'estimate_shipping', input_queue: 'shipping-in', output_queue: 'shipping-out', arguments: { weightKg: 12, destinationCity: 'Lyon' } };
    case 'mcp': return { type: 'mcp', server_label: 'tickets', tool: 'create_ticket', require_approval: p.mcpApproval, arguments: { priority: 'P2', title: 'VPN down - Leeds office' } };
    case 'code': return { type: 'code_interpreter', input: p.request === 'chart' ? "df = pd.read_csv('sales.csv')\ndf.groupby('month').revenue.sum().plot()" : "import pypdf  # attempt to read contract text" };
    default: return { type: t.type };
  }
}

function runBench(p) {
  const req = REQUESTS[p.request] || REQUESTS.policy;
  const r = rng(`${p.request}|${p.descriptions}|${p.shaping}`);
  const steps = [];
  const turns = [{ role: 'user', text: req.label.replace(/"/g, '') }];
  const pick = chooseTool(p, req);

  steps.push(step('user', 'User message added to the thread', req.label, { role: 'user', content: req.label.replace(/"/g, '') }, 'info'));
  steps.push(step('agent', 'Agent run starts', `Model receives instructions + ${pick.attached.length} tool definition(s). Tool descriptions are part of the prompt.`, { tools: pick.attached.map(k => ({ type: TOOLS[k].type, description: p.descriptions === 'clear' ? TOOLS[k].clear : TOOLS[k].vague })) }));

  if (!pick.tool) {
    steps.push(step('select', 'No suitable tool attached', `None of [${req.want.map(k => TOOLS[k].type).join(', ')}] is attached. The model would answer from its training data, which is ungrounded for company-specific facts.`, { needed: req.want.map(k => TOOLS[k].label) }, 'error'));
    turns.push({ role: 'assistant', text: 'I don\'t have access to that information.', meta: 'no tool call' });
    return finish(p, req, steps, turns, null, { ok: false, outTokens: 0, latency: 0 });
  }

  const payload = callPayload(p, pick.tool, req);
  steps.push(step('select', `Model chooses ${TOOLS[pick.tool].type}`, pick.reason, payload, pick.ambiguous ? 'warn' : 'ok'));
  turns.push({ role: 'assistant', text: `tool_call → ${TOOLS[pick.tool].type}`, meta: JSON.stringify(payload.arguments || payload.query || payload.input || '').slice(0, 90) });

  const node = pick.tool;
  let res = { ok: true, outTokens: 0, latency: 0, body: null };

  if (node === 'openapi') {
    if (p.openapiAuth === 'anonymous') {
      steps.push(step('openapi', 'Orders API returned 401 Unauthorized', 'The OpenAPI spec declares no security scheme, so the agent calls the API without credentials. The Orders API requires a key or Entra ID token.', { httpStatus: 401, error: 'Unauthorized', authConfigured: 'anonymous' }, 'error'));
      turns.push({ role: 'tool', text: '401 Unauthorized' });
      return finish(p, req, steps, turns, pick.tool, { ok: false, outTokens: 12, latency: 300 });
    }
    const rows = p.request === 'history' ? (p.shaping === 'paged' ? 25 : 1840) : 1;
    res.outTokens = p.request === 'history' ? (p.shaping === 'paged' ? 900 : 1840 * 62) : 140;
    res.latency = 350 + Math.round(r() * 200) + (rows > 100 ? 2200 : 0);
    res.body = p.request === 'history' ? { totalCount: 1840, returned: rows, value: [{ id: 'SO-30012', status: 'delivered', total: 412.5 }, '…'] } : { id: '4417', status: 'shipped', carrier: 'DHL', eta: '2026-10-27' };
    steps.push(step('openapi', `Orders API 200 OK (${rows} record${rows > 1 ? 's' : ''})`, `Auth: ${p.openapiAuth === 'managed_identity' ? 'managed identity token for the API audience (keyless)' : 'API key stored in a project connection'}.`, { httpStatus: 200, rows, approxOutputTokens: res.outTokens }, 'ok'));
    if (res.outTokens > p.outputBudget) {
      steps.push(step('output', 'Tool output too large for the context budget', `~${fmt(res.outTokens)} tokens (4-chars-per-token heuristic) vs your ${fmt(p.outputBudget)}-token budget for tool results. In this simulation the output is truncated and the answer becomes incomplete; on a real deployment you may also hit the model's context limit or pay for a huge prompt.`, { approxTokens: res.outTokens, budget: p.outputBudget, shaping: p.shaping }, 'error'));
      turns.push({ role: 'tool', text: `[${rows} orders, truncated]` });
      return finish(p, req, steps, turns, pick.tool, { ...res, ok: false });
    }
  } else if (node === 'search') {
    if (!p.searchRbac) {
      steps.push(step('search', 'Azure AI Search returned 403 Forbidden', 'The agent queries the index with the project\'s managed identity (keyless connection), and that identity has no data-plane role on the search service.', { httpStatus: 403, missingRole: 'Search Index Data Reader', scope: 'search service or index' }, 'error'));
      turns.push({ role: 'tool', text: '403 Forbidden' });
      return finish(p, req, steps, turns, pick.tool, { ok: false, outTokens: 10, latency: 250 });
    }
    if (p.searchIndex.trim() !== 'hr-policies') {
      steps.push(step('search', `Index "${p.searchIndex}" not found`, 'The tool configuration references an index name that does not exist on the connected search service (names are case-sensitive and exact).', { httpStatus: 404, requested: p.searchIndex, available: ['hr-policies', 'hr-policies-staging'] }, 'error'));
      turns.push({ role: 'tool', text: '404 index not found' });
      return finish(p, req, steps, turns, pick.tool, { ok: false, outTokens: 10, latency: 250 });
    }
    res = { ok: true, outTokens: 1100, latency: 420 + Math.round(r() * 150), body: { results: [{ title: 'Parental Leave Policy v4', chunk: '…up to 20 weeks of paid parental leave…', score: 0.032, url: 'policies/leave.pdf#p2' }, { title: 'Benefits FAQ', chunk: '…leave can be taken in two blocks…' }] } };
    steps.push(step('search', 'Hybrid query returned 5 chunks', 'Results come back with citations (document + location) that the agent attaches to its answer.', res.body, 'ok'));
  } else if (node === 'file') {
    res = { ok: p.request !== 'policy', outTokens: 700, latency: 380, body: { results: p.request === 'policy' ? [{ file: 'notes-team-offsite.docx', chunk: 'we should ask HR about leave', score: 0.41 }] : [{ file: 'contract.pdf', chunk: 'renews automatically for 12 months…' }] } };
    steps.push(step('file', p.request === 'policy' ? 'File search found only weakly related thread uploads' : 'File search returned chunks', p.request === 'policy' ? 'The vector store holds team uploads, not the policy corpus. The agent may answer from a note that is not authoritative.' : 'Raw text chunks without typed fields.', res.body, p.request === 'policy' ? 'warn' : 'info'));
  } else if (node === 'cu') {
    res = { ok: true, outTokens: 380, latency: 2600 + Math.round(r() * 600), body: { analyzerId: 'contract-fields', fields: { Parties: ['Fabrikam Ltd', 'Contoso plc'], RenewalDate: { value: '2027-03-31', confidence: 0.93 }, NoticePeriodDays: { value: 90, confidence: 0.9 } } } };
    steps.push(step('cu', 'Your function called the Content Understanding analyzer', 'The model emitted a function call; your code (or an Azure Function) ran the analyzer and returned typed fields with confidence.', res.body, 'ok'));
  } else if (node === 'func') {
    const runtime = 18; // seconds incl. cold start, in this simulation
    if (p.toolTimeout < runtime) {
      steps.push(step('func', `Azure Function did not reply within ${p.toolTimeout}s`, `In this simulation the function needs ~${runtime}s on a cold start (it calls a carrier rate API). No message arrived on the output queue in time, so the tool call fails.`, { inputQueue: 'shipping-in', outputQueue: 'shipping-out', waitedSeconds: p.toolTimeout, status: 'timeout' }, 'error'));
      turns.push({ role: 'tool', text: 'timeout' });
      return finish(p, req, steps, turns, pick.tool, { ok: false, outTokens: 8, latency: p.toolTimeout * 1000 });
    }
    res = { ok: true, outTokens: 60, latency: runtime * 1000, body: { costEUR: 31.4, days: 3, carrier: 'Colissimo' } };
    steps.push(step('func', 'Azure Function replied via output queue', `Took ~${runtime}s (cold start) within the ${p.toolTimeout}s wait.`, res.body, 'ok'));
  } else if (node === 'mcp') {
    res = { ok: true, outTokens: 90, latency: 900, body: { ticketId: 'INC-20931', priority: 'P2', state: 'New' } };
    if (p.mcpApproval === 'always') steps.push(step('mcp', 'Run paused: MCP approval requested', 'Run status becomes requires_action. In this simulation an operator approves the create_ticket call and the run resumes.', { status: 'requires_action', type: 'mcp_approval_request', approved: true }, 'info'));
    else steps.push(step('mcp', 'MCP call executed without approval', 'require_approval = never. Acceptable for read-only tools; for a tool that writes (creates tickets) prefer approval or an allow-list.', { require_approval: 'never', tool: 'create_ticket' }, 'warn'));
    steps.push(step('mcp', 'MCP server returned result', 'Remote MCP server executed create_ticket.', res.body, 'ok'));
  } else if (node === 'code') {
    if (p.request === 'contract') {
      res = { ok: false, outTokens: 2200, latency: 4200, body: { stdout: 'Extracted 41 pages of text; no renewal date pattern found' } };
      steps.push(step('code', 'Code interpreter parsed the PDF as plain text', 'It found text but no typed renewal date; the model will guess from raw text. A Content Understanding analyzer gives typed fields with confidence.', res.body, 'warn'));
    } else {
      res = { ok: true, outTokens: 260, latency: 3800, body: { stdout: 'month revenue\\nJan 41200\\n…', files: ['chart.png'] } };
      steps.push(step('code', 'Sandbox executed Python and produced chart.png', 'Code interpreter runs in a sandboxed session; output files are returned as file references.', res.body, 'ok'));
    }
  }

  turns.push({ role: 'tool', text: JSON.stringify(res.body).slice(0, 160) });
  steps.push(step('output', 'Tool output returned to the model', `~${res.outTokens} tokens of tool output appended to the run context.`, { approxTokens: res.outTokens }, res.outTokens > p.outputBudget ? 'warn' : 'ok'));
  return finish(p, req, steps, turns, pick.tool, res);
}

const ANSWERS = {
  policy: 'You get up to 20 weeks of paid parental leave, which can be taken in two blocks [Parental Leave Policy v4, p.2].',
  order: 'Order 4417 has shipped with DHL and is expected on 27 October.',
  history: 'Contoso placed 1,840 orders this year. Here are the 25 most recent with status and total; ask for more pages if you need them.',
  contract: 'The contract renews on 31 March 2027; notice must be given 90 days before (confidence 0.93).',
  shipping: 'Estimated €31.40 with Colissimo, about 3 days to Lyon.',
  ticket: 'Created ticket INC-20931 (P2): VPN down - Leeds office.',
  chart: 'Here is the monthly revenue chart (chart.png). Revenue peaked in March.',
};

function finish(p, req, steps, turns, tool, res) {
  const failed = steps.some(s => s.status === 'error');
  const answer = failed ? 'Sorry, I could not complete that request because a tool call failed.' : res.ok ? ANSWERS[p.request] : 'I found some related notes, but I am not certain this is the official answer.';
  steps.push(step('answer', failed ? 'Agent reports failure' : res.ok ? 'Grounded answer returned' : 'Low-confidence answer returned', answer, { toolUsed: tool ? TOOLS[tool].type : null }, failed ? 'error' : res.ok ? 'ok' : 'warn'));
  turns.push({ role: 'assistant', text: answer });
  const tools = Object.keys(TOOLS);
  return {
    steps,
    output: [
      { type: 'chat', title: 'Thread (simulated run)', turns },
      { type: 'table', title: 'Attached tools as the model sees them', columns: ['Tool', 'Type', 'Description sent to model', 'Attached'],
        rows: tools.map(k => [TOOLS[k].label, TOOLS[k].type, p.descriptions === 'clear' ? TOOLS[k].clear : TOOLS[k].vague, enabled(p, k) ? 'yes' : 'no']),
        tones: tools.map(k => k === tool ? (failed ? 'error' : 'ok') : enabled(p, k) ? 'info' : 'muted') },
      ...(tool ? [{ type: 'json', title: 'Tool call payload (illustrative shape)', data: callPayload(p, tool, req) }] : []),
      { type: 'alert', tone: failed ? 'error' : res.ok ? 'ok' : 'warn', text: failed ? 'Run ended with a tool failure. Check the failing step in the trace.' : res.ok ? 'The right tool was used and its output grounded the answer.' : 'The answer is not reliably grounded: wrong store or wrong tool type for the job.' },
    ],
    metrics: [
      metric('Tool selected', tool ? TOOLS[tool].type : 'none', 'computed'),
      metric('Tool output size', `~${fmt(res.outTokens || 0)} tokens`, 'estimate', '4-characters-per-token heuristic over the simulated payload.'),
      metric('Tool latency', `~${round((res.latency || 0) / 1000, 1)} s`, 'estimate', 'Illustrative values chosen for this simulation; real latency depends on the backend.'),
      metric('Run outcome', failed ? 'failed' : res.ok ? 'grounded' : 'weak', 'computed'),
    ],
    summary: `${p.request}: ${tool ? TOOLS[tool].type : 'no tool'} → ${failed ? 'failed' : res.ok ? 'grounded answer' : 'weak answer'}`,
  };
}

const node = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.2.3',
  lab: 'Agent tool workbench',
  services: [
    { name: 'Foundry Agent Service: tools overview', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/overview' },
    { name: 'OpenAPI specified tools', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/openapi-spec' },
    { name: 'Azure AI Search tool', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/azure-ai-search' },
    { name: 'Model Context Protocol (MCP) tool', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/model-context-protocol' },
  ],
  prereqs: ['2.2.1', '2.2.2', '1.1.4'],
  next: ['2.2.4', '5.1.5', '1.4.4'],

  concept: {
    plain: 'An agent is only as useful as the tools you give it. Each tool is described to the model in words; the model reads the user request, decides which tool fits, and fills in the arguments. Your job is to attach the right tools, describe them clearly, give them credentials and permissions, and keep their outputs small enough to be useful.',
    technical: 'Foundry Agent Service supports built-in tools (Azure AI Search, file search over vector stores, code interpreter, Bing grounding), action tools (OpenAPI 3.0 specified tools with anonymous, API-key connection or managed-identity auth; Azure Functions via storage queues; function calling executed by your code; remote MCP servers with require_approval), and Foundry Tools such as Content Understanding, typically exposed through a function or OpenAPI wrapper. Tool selection is driven by the tool definitions in the prompt; failures surface as tool errors (401/403/404, timeouts) or as oversized outputs that bloat context.',
    useCase: 'A Contoso support agent answers policy questions from an Azure AI Search index, looks up orders through the Orders REST API (OpenAPI tool with managed identity), estimates shipping via an Azure Function, extracts renewal dates from uploaded contracts with a Content Understanding analyzer, and opens IT tickets on a remote MCP server with approval.',
    terms: [
      ['Tool definition', 'Name, description and parameter schema the model reads to decide when and how to call a tool.'],
      ['OpenAPI tool', 'Agent tool generated from an OpenAPI 3.0 spec; each operation becomes a callable function. Auth: anonymous, connection (API key), or managed identity.'],
      ['Azure AI Search tool', 'Built-in knowledge tool that queries an existing index through a project connection and returns cited chunks.'],
      ['File search', 'Built-in tool over a vector store of uploaded files; chunking and embedding are managed for you.'],
      ['MCP tool', 'Connects the agent to a remote Model Context Protocol server; require_approval controls whether calls pause for approval.'],
      ['Tool output budget', 'How much tool output you allow back into context. Large results cost tokens and can push out instructions.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          node('user', 'User request', 0, 1.5, 'The message that the model must map to a tool.'),
          node('agent', 'Agent (model + instructions)', 1, 1.5, 'Reads instructions and tool definitions; produces either a tool call or a final answer.', { kind: 'ai' }),
          node('select', 'Tool choice + arguments', 2, 1.5, 'The model picks a tool by matching the request to tool descriptions and fills arguments from the parameter schema.', { badge: p ? p.descriptions : undefined, substeps: ['Match intent to descriptions', 'Pick tool', 'Fill arguments', 'Emit tool call'] }),
          node('openapi', 'API (OpenAPI)', 3, 0, 'REST operations described by an OpenAPI spec.', { kind: 'external', disabled: p && !p.t_openapi }),
          node('search', 'Search index', 3, 0.75, 'Azure AI Search index (enterprise knowledge).', { kind: 'store', disabled: p && !p.t_search }),
          node('file', 'Vector store', 3, 1.5, 'File search over uploaded files.', { kind: 'store', disabled: p && !p.t_file }),
          node('cu', 'Content Understanding', 3, 2.25, 'Typed field extraction from documents.', { kind: 'ai', disabled: p && !p.t_cu }),
          node('func', 'Custom function', 3, 3, 'Your business logic (Azure Function or client-side function).', { kind: 'compute', disabled: p && !p.t_func }),
          node('mcp', 'MCP server', 3, 3.75, 'Remote tools exposed through MCP.', { kind: 'external', disabled: p && !p.t_mcp }),
          node('code', 'Code interpreter', 3, 4.5, 'Sandboxed Python for data analysis.', { kind: 'compute', disabled: p && !p.t_code }),
          node('output', 'Tool output → context', 4, 1.5, 'Results are appended to the run; size matters.', { badge: p ? `budget ${p.outputBudget}` : undefined }),
          node('answer', 'Grounded answer', 4, 3, 'Final assistant message, ideally with citations.'),
        ],
        edges: [['user', 'agent'], ['agent', 'select'], ['select', 'openapi'], ['select', 'search'], ['select', 'file'], ['select', 'cu'], ['select', 'func'], ['select', 'mcp'], ['select', 'code'], ['openapi', 'output'], ['search', 'output'], ['file', 'output'], ['cu', 'output'], ['func', 'output'], ['mcp', 'output'], ['code', 'output'], ['output', 'answer']],
      }),
      architectural: p => ({
        nodes: [
          node('user', 'Client app', 0, 1.5, 'Calls the agent through the Foundry project endpoint with Entra ID auth.', { kind: 'app' }),
          node('agent', 'Foundry project: agent', 1, 1.5, 'Agent definition (model deployment, instructions, tools) in Foundry Agent Service.', { kind: 'ai' }),
          node('select', 'Agent runtime', 2, 1.5, 'Executes server-side tools; returns requires_action for client-side function calls or MCP approvals.', { kind: 'compute' }),
          node('openapi', 'Orders API (App Service / APIM)', 3, 0, `Auth: ${p ? p.openapiAuth : 'connection'}. Managed identity needs the API to accept Entra tokens for its audience.`, { kind: 'external', disabled: p && !p.t_openapi, badge: p ? p.openapiAuth : undefined }),
          node('search', 'Azure AI Search', 3, 0.75, 'Project connection to the search service. Keyless access needs "Search Index Data Reader" for the project identity.', { kind: 'store', disabled: p && !p.t_search, props: p ? { index: p.searchIndex, rbac: p.searchRbac ? 'Search Index Data Reader' : 'none' } : undefined }),
          node('file', 'Vector store (agent-managed)', 3, 1.5, 'Files uploaded to the project and indexed for file search.', { kind: 'store', disabled: p && !p.t_file }),
          node('cu', 'Content Understanding in Foundry Tools', 3, 2.25, 'Analyzer called by your function code.', { kind: 'ai', disabled: p && !p.t_cu }),
          node('func', 'Azure Functions + Storage queues', 3, 3, 'Agent writes to an input queue; function replies on an output queue.', { kind: 'compute', disabled: p && !p.t_func, badge: p ? `${p.toolTimeout}s` : undefined }),
          node('mcp', 'Remote MCP server', 3, 3.75, 'HTTPS endpoint; headers carry auth; approvals configurable.', { kind: 'external', disabled: p && !p.t_mcp }),
          node('code', 'Code interpreter sandbox', 3, 4.5, 'Isolated session managed by the service.', { kind: 'compute', disabled: p && !p.t_code }),
          node('output', 'Thread / run context', 4, 1.5, 'Messages and tool outputs stored with the conversation.', { kind: 'data' }),
          node('answer', 'Response to client', 4, 3, 'Final message plus annotations (citations, file references).', { kind: 'app' }),
        ],
        edges: [['user', 'agent'], ['agent', 'select'], ['select', 'openapi', 'HTTPS'], ['select', 'search', 'query'], ['select', 'file'], ['select', 'cu', 'function'], ['select', 'func', 'queue'], ['select', 'mcp', 'MCP'], ['select', 'code'], ['select', 'output'], ['output', 'answer']],
      }),
      implementation: p => ({
        nodes: [
          node('user', 'project = AIProjectClient(endpoint, DefaultAzureCredential())', 0, 0, 'azure-ai-projects client; keyless auth.', { kind: 'code' }),
          node('agent', 'agent = project.agents.create_agent(model=..., instructions=..., tools=[...])', 0, 1, 'Illustrative: the exact method names differ between SDK versions (agents client vs. versioned agent definitions). Check the current SDK reference.', { kind: 'code' }),
          node('select', 'tool definitions: OpenApiTool / AzureAISearchTool / FileSearchTool / FunctionTool / McpTool / CodeInterpreterTool', 0, 2, 'Each helper produces a tool definition with a description and schema. Illustrative class names from azure-ai-agents.', { kind: 'code' }),
          node('openapi', `OpenApiTool(name="orders", spec=spec, auth=${p && p.openapiAuth === 'managed_identity' ? 'OpenApiManagedAuthDetails(audience=...)' : p && p.openapiAuth === 'anonymous' ? 'OpenApiAnonymousAuthDetails()' : 'OpenApiConnectionAuthDetails(connection_id)'})`, 1, 0, 'Illustrative auth helper names.', { kind: 'code', disabled: p && !p.t_openapi }),
          node('search', `AzureAISearchTool(index_connection_id=conn, index_name="${p ? p.searchIndex : 'hr-policies'}")`, 1, 1, 'Index name must match exactly.', { kind: 'code', disabled: p && !p.t_search }),
          node('file', 'FileSearchTool(vector_store_ids=[vs.id])', 1, 2, 'Vector store created from uploaded files.', { kind: 'code', disabled: p && !p.t_file }),
          node('cu', 'def analyze_contract(fileId, analyzerId): ... # calls Content Understanding', 1, 3, 'Your function; returned as JSON string tool output.', { kind: 'code', disabled: p && !p.t_cu }),
          node('func', 'AzureFunctionTool(name="estimate_shipping", input_queue=..., output_queue=...)', 2, 0, 'Queue-based binding; mind the wait timeout.', { kind: 'code', disabled: p && !p.t_func }),
          node('mcp', `McpTool(server_label="tickets", server_url=..., require_approval="${p ? p.mcpApproval : 'always'}")`, 2, 1, 'Approve via run requires_action handling.', { kind: 'code', disabled: p && !p.t_mcp }),
          node('code', 'CodeInterpreterTool(file_ids=[csv.id])', 2, 2, 'Sandbox session.', { kind: 'code', disabled: p && !p.t_code }),
          node('output', 'submit_tool_outputs(... output=json.dumps(trimmed_result))', 2, 3, 'For client-side functions: trim/paginate before returning.', { kind: 'code' }),
          node('answer', 'messages = project.agents.messages.list(thread_id)', 3, 1.5, 'Read the final message and annotations.', { kind: 'code' }),
        ],
        edges: [['user', 'agent'], ['select', 'agent'], ['openapi', 'select'], ['search', 'select'], ['file', 'select'], ['cu', 'select'], ['func', 'select'], ['mcp', 'select'], ['code', 'select'], ['agent', 'output'], ['output', 'answer']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'request', label: 'User request', type: 'select', options: Object.entries(REQUESTS).map(([v, r]) => [v, r.label]), default: 'policy' },
      { id: 't_openapi', label: 'Attach: OpenAPI Orders API', type: 'toggle', default: true },
      { id: 't_search', label: 'Attach: Azure AI Search (hr-policies)', type: 'toggle', default: true },
      { id: 't_file', label: 'Attach: File search (team uploads)', type: 'toggle', default: true },
      { id: 't_cu', label: 'Attach: Content Understanding function', type: 'toggle', default: true },
      { id: 't_func', label: 'Attach: Azure Functions estimate_shipping', type: 'toggle', default: true },
      { id: 't_mcp', label: 'Attach: MCP tickets server', type: 'toggle', default: true },
      { id: 't_code', label: 'Attach: Code interpreter', type: 'toggle', default: true },
      { id: 'descriptions', label: 'Tool descriptions', type: 'select', options: [['clear', 'Clear and specific'], ['vague', 'Vague / overlapping']], default: 'clear', help: 'The model selects tools from their descriptions.' },
      { id: 'openapiAuth', label: 'OpenAPI auth', type: 'select', options: [['anonymous', 'Anonymous'], ['connection', 'API key via project connection'], ['managed_identity', 'Managed identity (keyless)']], default: 'connection' },
      { id: 'searchIndex', label: 'Search tool index name', type: 'text', default: 'hr-policies' },
      { id: 'searchRbac', label: 'Project identity has Search Index Data Reader', type: 'toggle', default: true },
      { id: 'toolTimeout', label: 'Azure Function wait timeout (s)', type: 'range', min: 5, max: 60, step: 5, default: 30 },
      { id: 'mcpApproval', label: 'MCP require_approval', type: 'select', options: [['always', 'always'], ['never', 'never']], default: 'always' },
      { id: 'shaping', label: 'OpenAPI result shaping', type: 'select', options: [['raw', 'Return everything'], ['paged', 'Filter fields + page (top 25)']], default: 'raw' },
      { id: 'outputBudget', label: 'Tool output budget (tokens)', type: 'number', min: 500, max: 50000, step: 500, default: 8000 },
    ],
    samples: [
      { label: 'Policy question via Azure AI Search', values: { request: 'policy' } },
      { label: 'Order status via OpenAPI (keyless)', values: { request: 'order', openapiAuth: 'managed_identity' } },
      { label: 'Contract renewal via Content Understanding', values: { request: 'contract' } },
      { label: 'Open a ticket on the MCP server', values: { request: 'ticket', mcpApproval: 'always' } },
      { label: 'Chart a CSV with code interpreter', values: { request: 'chart' } },
    ],
    run: runBench,
  },

  compare: {
    suggestions: [
      'Ask the policy question with clear descriptions, then with vague descriptions, and compare which tool is chosen.',
      'Send the "every order this year" request with Return everything, then with Filter fields + page, and compare tool output size.',
      'Ask for the contract renewal date with the Content Understanding function attached, then detached, and compare the answer quality.',
    ],
  },

  debug: [
    { id: 'auth', title: 'Order lookup fails with 401', values: { request: 'order', openapiAuth: 'anonymous', t_openapi: true }, node: 'openapi',
      symptom: 'The tool call returns 401 Unauthorized; the agent apologises.', cause: 'The OpenAPI tool is configured as anonymous but the API requires credentials.', fix: 'Set OpenAPI auth to an API-key project connection or managed identity (and make sure the API trusts that identity).' },
    { id: 'index', title: 'Search tool: index not found', values: { request: 'policy', searchIndex: 'HR-Policies', searchRbac: true, t_search: true }, node: 'search',
      symptom: '404 from Azure AI Search before any results.', cause: 'The tool references an index name that does not exist (names are exact, lower-case).', fix: 'Set the index name to hr-policies.' },
    { id: 'rbac', title: 'Search tool: 403 Forbidden', values: { request: 'policy', searchRbac: false, searchIndex: 'hr-policies', t_search: true }, node: 'search',
      symptom: '403 when the agent queries the index.', cause: 'Keyless connection, but the project managed identity has no data-plane role on the search service.', fix: 'Assign Search Index Data Reader to the project identity (turn the RBAC toggle on).' },
    { id: 'timeout', title: 'Shipping estimate times out', values: { request: 'shipping', toolTimeout: 10, t_func: true }, node: 'func',
      symptom: 'No reply from the Azure Function; tool call ends in a timeout.', cause: 'Cold start + downstream carrier API take longer than the wait timeout.', fix: 'Raise the wait timeout to at least 20s (and in production, keep the function warm or make it faster).' },
    { id: 'large', title: 'Tool output too large', values: { request: 'history', shaping: 'raw', openapiAuth: 'connection', outputBudget: 8000 }, node: 'output',
      symptom: 'The order history comes back with ~114k tokens and the answer is truncated.', cause: 'The API returns every record and every field; nothing limits what flows back into context.', fix: 'Filter fields and page results (top 25) in the API call, or summarise in your function before returning.' },
    { id: 'vague', title: 'Policy answer comes from a team note', values: { request: 'policy', descriptions: 'vague', t_file: true, t_search: true }, node: 'select',
      symptom: 'The agent cites "notes-team-offsite.docx" instead of the HR policy.', cause: 'Two tools have the same vague description, so the model cannot tell the authoritative index from thread uploads.', fix: 'Write clear, distinct tool descriptions (or detach file search for this agent).' },
    { id: 'missing', title: 'Contract question with no extraction tool', values: { request: 'contract', t_cu: false, t_code: false, t_file: false }, node: 'select',
      symptom: 'The agent says it cannot access the information.', cause: 'No attached tool can read the uploaded contract.', fix: 'Attach the Content Understanding function (preferred for typed fields).' },
  ],

  challenge: {
    task: 'Make the agent answer "List every order Contoso placed this year" through the OpenAPI tool using keyless authentication, with no warnings or errors.',
    condition: 'Request = every order this year, OpenAPI auth = managed identity, the OpenAPI tool is used, and no step is warn or error.',
    hint: 'Two things must change: how the agent authenticates, and how much data comes back.',
    check: (p, res) => p.request === 'history' && p.openapiAuth === 'managed_identity' && res.steps.some(s => s.node === 'openapi' && s.status === 'ok') && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Select the "List every order Contoso placed this year" request.', 'Set OpenAPI auth to Managed identity (keyless).', 'Set result shaping to Filter fields + page (top 25) so the tool output fits the budget.', 'Run: the tool returns 25 rows (~900 tokens) and the answer offers more pages.'],
    solutionValues: { request: 'history', openapiAuth: 'managed_identity', shaping: 'paged', t_openapi: true, outputBudget: 8000 },
  },

  quiz: [
    { q: 'Your agent must answer HR policy questions from an existing Azure AI Search index, using keyless authentication. The tool call returns 403. What is the most likely fix?', options: ['Switch the agent to a larger model', 'Assign the Search Index Data Reader role to the project managed identity', 'Upload the policy PDFs to file search instead', 'Increase the tool output budget'], answer: 1, why: 'Keyless access uses Entra ID; the identity calling the index needs a data-plane role such as Search Index Data Reader.' },
    { q: 'You expose an internal REST API that already has an OpenAPI 3.0 spec and accepts Entra ID tokens. Which tool integration requires the least custom code?', options: ['Function calling with client-side code for every operation', 'OpenAPI tool with managed identity auth', 'Code interpreter calling the API with requests', 'File search over the spec'], answer: 1, why: 'The OpenAPI tool turns each operation into a callable tool and can authenticate with managed identity, without you writing dispatch code.' },
    { q: 'Users upload supplier contracts and ask for renewal dates and notice periods. Answers vary and sometimes guess. What should you add?', options: ['A Content Understanding analyzer with a contract field schema, exposed as a tool', 'Higher temperature', 'Bing grounding', 'A second vector store'], answer: 0, why: 'A Content Understanding analyzer returns typed fields with confidence, which is more reliable than free-text chunks or ad-hoc code parsing.' },
    { q: 'An MCP server exposes a create_ticket tool that writes to production. What is a sensible configuration?', options: ['require_approval = never so runs are fast', 'require_approval = always (or approve specific write tools) and handle the approval request in your app', 'Expose the MCP server publicly without auth', 'Put the tool in the system prompt instead'], answer: 1, why: 'Write actions should pause for approval; your client handles the requires_action approval request before the call runs.' },
  ],

  recap: 'Pick tools that match the job (search for enterprise knowledge, OpenAPI/functions for systems of record, Content Understanding for documents, MCP for external tool servers, code interpreter for analysis), describe them precisely, give them working auth and RBAC, set realistic timeouts, and shape tool outputs so they fit the context.',
};
