// 2.1.5 Integrate generative workflows into applications by using Foundry SDKs and connectors
// Lab: SDK integration sandbox.
import { round, step, metric } from '../src/engine/util.js';

const INTEGRATIONS = {
  openai: { label: 'Chat: OpenAI client from AIProjectClient', needs: null, tool: null, base: 2.5 },
  agent_search: { label: 'Agent + Azure AI Search tool (project connection)', needs: 'AzureAISearch', tool: 'azure_ai_search', base: 5 },
  agent_sharepoint: { label: 'Agent + SharePoint tool (project connection)', needs: 'SharePoint', tool: 'sharepoint_grounding', base: 6 },
  agent_logicapps: { label: 'Agent + Logic Apps workflow (OpenAPI tool)', needs: null, tool: 'openapi:create_ticket', base: 6 },
};

// Connections that exist in the simulated Foundry project.
const CONNECTIONS = {
  'contoso-search': { type: 'AzureAISearch', exists: true, label: 'contoso-search (Azure AI Search)' },
  'hr-sharepoint': { type: 'SharePoint', exists: true, label: 'hr-sharepoint (SharePoint)' },
  'old-search': { type: 'AzureAISearch', exists: false, label: 'old-search (deleted last sprint)' },
};

function codeFor(p) {
  const it = p.integration;
  const aio = p.callStyle === 'async';
  const L = [];
  L.push(`# Illustrative ${aio ? 'async ' : ''}FastAPI handler. Check the azure-ai-projects / azure-ai-agents reference for exact signatures in your SDK version.`);
  L.push(aio ? 'from azure.ai.projects.aio import AIProjectClient\nfrom azure.identity.aio import DefaultAzureCredential' : 'from azure.ai.projects import AIProjectClient\nfrom azure.identity import DefaultAzureCredential');
  if (p.reuse) L.push(`\nproject = AIProjectClient(endpoint=os.environ["PROJECT_ENDPOINT"], credential=DefaultAzureCredential())  # created once at startup`);
  L.push(`\n@app.post("/ask")\n${p.callStyle === 'sync' ? 'def' : 'async def'} ask(req: AskRequest):`);
  if (!p.reuse) L.push('    project = AIProjectClient(endpoint=os.environ["PROJECT_ENDPOINT"], credential=DefaultAzureCredential())  # new client per request!');
  const aw = aio ? 'await ' : '';
  if (it === 'openai') {
    L.push(`    client = ${aw}project.get_openai_client()`);
    L.push(`    resp = ${aw}client.chat.completions.create(model=os.environ["MODEL_DEPLOYMENT_NAME"], messages=[...]${p.stream !== 'off' ? ', stream=True' : ''})`);
  } else {
    if (INTEGRATIONS[it].needs) {
      L.push(`    conn = ${aw}project.connections.get("${p.connection}")`);
      L.push(it === 'agent_search' ? '    tool = AzureAISearchTool(index_connection_id=conn.id, index_name="handbook-index")' : '    tool = SharepointTool(connection_id=conn.id)');
    } else {
      L.push('    tool = OpenApiTool(name="tickets", spec=logic_app_openapi_spec, auth=OpenApiManagedAuthDetails(...))');
    }
    L.push(p.reuse ? '    agent = AGENT  # created once at startup with create_agent(model=..., instructions=..., tools=tool.definitions)' : `    agent = ${aw}project.agents.create_agent(model=DEPLOYMENT, name="helper", instructions="...", tools=tool.definitions${it === 'agent_search' ? ', tool_resources=tool.resources' : ''})  # new agent every request!`);
    L.push(`    thread = ${aw}project.agents.threads.create()`);
    L.push(`    ${aw}project.agents.messages.create(thread_id=thread.id, role="user", content=req.question)`);
    L.push(p.stream !== 'off' ? `    stream = ${aw}project.agents.runs.stream(thread_id=thread.id, agent_id=agent.id)` : `    run = ${aw}project.agents.runs.create_and_process(thread_id=thread.id, agent_id=agent.id)`);
  }
  if (p.stream === 'handled') L.push(`    return StreamingResponse(forward_deltas(${it === 'openai' ? 'resp' : 'stream'}), media_type="text/event-stream")`);
  else if (p.stream === 'unhandled') L.push(`    return {"answer": ${it === 'openai' ? 'resp.choices[0].message.content' : 'stream.text'}}  # BUG: stream object, not a completed response`);
  else L.push(`    return {"answer": ${it === 'openai' ? 'resp.choices[0].message.content' : 'last_assistant_message(thread.id)'}}`);
  return L.join('\n');
}

function integrate(p) {
  const it = INTEGRATIONS[p.integration] || INTEGRATIONS.openai;
  const steps = [];
  const tl = [];
  let t = 0;
  const span = (label, d, lane, tone = 'info') => { tl.push({ label, start: round(t, 2), end: round(t + d, 2), lane, tone }); t += d; };
  const users = Number(p.users) || 1;

  steps.push(step('handler', 'POST /ask', `${users} concurrent user(s) • ${p.callStyle === 'async' ? 'async def + .aio clients' : p.callStyle === 'syncInAsync' ? 'async def calling SYNC SDK methods' : 'sync def (worker threads)'}`, { route: '/ask', concurrency: users }, 'info'));

  // Client creation
  if (!p.reuse) { span('new AIProjectClient + token', 0.6, 'App', 'warn'); }
  steps.push(step('project', p.reuse ? 'AIProjectClient reused' : 'AIProjectClient created per request', p.reuse ? 'One client (and credential token cache) per process.' : 'Every request builds a client and fetches a new Entra token: extra latency and connection churn. Create it once at startup.',
    { endpoint: 'https://contoso-ai.services.ai.azure.com/api/projects/support', credential: 'DefaultAzureCredential' }, p.reuse ? 'ok' : 'warn'));

  // Connection
  if (it.needs) {
    const c = CONNECTIONS[p.connection];
    span('connections.get', 0.2, 'Foundry');
    if (!c || !c.exists) {
      steps.push(step('connection', 'Connection not found', `No connection named "${p.connection}" exists in the project. It was deleted (or never created in this environment).`, { httpStatus: 404, error: 'ResourceNotFound', available: Object.entries(CONNECTIONS).filter(([, v]) => v.exists).map(([k]) => k) }, 'error'));
      return wrap(p, it, steps, tl, t);
    }
    if (c.type !== it.needs) {
      steps.push(step('connection', 'Wrong connection type', `"${p.connection}" is a ${c.type} connection but this tool needs a ${it.needs} connection.`, { connection: p.connection, type: c.type, expected: it.needs }, 'error'));
      return wrap(p, it, steps, tl, t);
    }
    steps.push(step('connection', `Connection "${p.connection}" resolved`, `${c.type} connection; the tool references it by connection id, so no secrets live in app code.`, { id: `/subscriptions/…/projects/support/connections/${p.connection}`, type: c.type }));
  } else {
    steps.push(step('connection', 'No connection needed', it.tool ? 'The Logic Apps workflow is called through an OpenAPI tool with managed-identity auth.' : 'Chat goes straight to the model deployment through the project.', null, 'skip'));
  }

  // SharePoint identity rule
  if (p.integration === 'agent_sharepoint' && p.auth === 'app') {
    steps.push(step('tool', 'SharePoint tool rejected app-only identity', 'The SharePoint tool works on behalf of the signed-in user (identity passthrough), so results respect that user\'s SharePoint permissions. A managed-identity-only call is not supported (check the docs for current auth options).', { auth: 'app-only', required: 'user (on-behalf-of)' }, 'error'));
    return wrap(p, it, steps, tl, t);
  }

  // Model / agent call
  if (p.integration === 'openai') {
    span('chat.completions', it.base, 'Model');
    steps.push(step('model', 'Chat completion', 'get_openai_client() returns an OpenAI client already pointed at the project\'s resource with Entra auth.', { model: 'MODEL_DEPLOYMENT_NAME' }));
  } else {
    if (!p.reuse) span('create_agent', 0.5, 'Foundry', 'warn');
    span('threads.create + messages.create', 0.4, 'Foundry');
    steps.push(step('model', p.reuse ? 'Thread and message created (agent reused)' : 'Agent, thread and message created per request', p.reuse ? 'The agent was created once at startup; each conversation gets its own thread.' : 'Creating the agent inside the handler adds a new agent definition per request (clutter, latency). Create it once and reuse its id; create a thread per conversation.', { tools: [it.tool], agent: p.reuse ? 'reused by id' : 'new per request' }, p.reuse ? 'ok' : 'warn'));
    span(it.tool, 1.2, 'Tool', p.downstream === 'fail' ? 'error' : 'ok');
    if (p.downstream === 'fail') {
      steps.push(step('tool', `${it.tool} failed downstream`, p.integration === 'agent_logicapps' ? 'The Logic Apps workflow returned HTTP 502 (a connector inside it failed). The run step ends with a tool error and the agent apologises or retries.' : p.integration === 'agent_search' ? 'Azure AI Search returned 503 (service busy / replica restart). The run step fails.' : 'SharePoint returned 503. The run step fails.',
        { run_step: { type: 'tool_calls', status: 'failed', last_error: { code: 'tool_error', message: 'Downstream returned 5xx' } } }, 'error'));
      return wrap(p, it, steps, tl, t);
    }
    steps.push(step('tool', `${it.tool} ✓`, 'Tool call executed by the Agent Service; results are added to the run as tool outputs with citations.', { run_step: { type: 'tool_calls', status: 'completed' } }));
    span('run (model turns)', it.base - 1.5, 'Model');
  }

  // Concurrency effect
  const perReq = t;
  let p95 = perReq;
  if (p.callStyle === 'syncInAsync') p95 = perReq * users;
  if (p.callStyle === 'syncInAsync' && users > 1) {
    const st = p95 > 30 ? 'error' : 'warn';
    steps.push(step('handler', st === 'error' ? 'Requests time out under load' : 'Event loop blocked', `Sync SDK calls inside async def block the event loop, so ${users} requests run one after another (~${round(p95, 1)} s for the last user)${st === 'error' ? ', beyond a 30 s gateway timeout' : ''}. Use the .aio clients with await, or a sync def handler.`, { estimatedWorstLatencySec: round(p95, 1), concurrency: users }, st));
    if (st === 'error') return wrap(p, it, steps, tl, t, p95);
  }

  // Streaming
  if (p.stream === 'unhandled') {
    steps.push(step('stream', 'Handler crashed on the stream object', `With streaming on, the SDK returns an iterator of events, not a completed response. Reading ${p.integration === 'openai' ? 'resp.choices' : 'the final text'} directly raises an AttributeError → HTTP 500.`, { error: p.integration === 'openai' ? "AttributeError: 'Stream' object has no attribute 'choices'" : 'AttributeError on stream object (illustrative)' }, 'error'));
    return wrap(p, it, steps, tl, t, p95);
  }
  steps.push(step('stream', p.stream === 'handled' ? 'Deltas streamed to the browser' : 'Full response returned', p.stream === 'handled' ? 'Each delta is forwarded as a server-sent event; first tokens appear quickly.' : 'User waits for the whole answer before seeing anything.', { stream: p.stream }, 'ok'));
  return wrap(p, it, steps, tl, t, p95);
}

function wrap(p, it, steps, tl, t, p95 = t) {
  const err = steps.find(s => s.status === 'error');
  const output = [
    { type: 'code', title: 'Generated handler (illustrative)', lang: 'python', text: codeFor(p) },
    { type: 'flow', title: 'Call sequence', items: steps.map(s => ({ label: s.title, tone: s.status === 'error' ? 'error' : s.status === 'warn' ? 'warn' : s.status === 'ok' ? 'ok' : 'info' })) },
  ];
  if (tl.length) output.push({ type: 'timeline', title: 'One request (illustrative durations)', unit: 's', items: tl });
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}. ${err.detail}` });
  return {
    steps, output,
    metrics: [
      metric('Steps OK', `${steps.filter(s => s.status === 'ok').length}/${steps.length}`, 'computed'),
      metric('Single-request latency', `~${round(t, 1)} s`, 'estimate', 'Illustrative per-call durations, not measurements.'),
      metric('Worst-case latency under load', `~${round(p95, 1)} s`, 'estimate', 'Sync calls in an async handler serialise requests; async or threaded handlers overlap them.'),
      metric('Time to first token', p.stream === 'handled' ? 'low' : 'full answer time', 'estimate', 'Streaming shows the first delta well before the run completes.'),
    ],
    summary: err ? `Failed: ${err.title}` : `${it.label} • ${p.callStyle} • stream ${p.stream} • ~${round(p95, 1)} s worst case`,
  };
}

const nodes = (p, L) => [
  { id: 'handler', label: L.handler, col: 0, row: 1, kind: 'app', badge: p ? p.callStyle : undefined, detail: 'Your web API endpoint. Choose async clients (azure.ai.projects.aio) in async handlers.' },
  { id: 'project', label: L.project, col: 1, row: 1, kind: 'code', badge: p ? (p.reuse ? 'singleton' : 'per request') : undefined, detail: 'AIProjectClient(endpoint, credential) — entry point to models, agents, connections, evaluations and telemetry in a Foundry project.' },
  { id: 'connection', label: L.connection, col: 2, row: 0, kind: 'store', disabled: p && !INTEGRATIONS[p.integration].needs, detail: 'Project connections store how to reach external resources (Azure AI Search, SharePoint, Fabric, Bing…). Tools reference them by id.' },
  { id: 'model', label: L.model, col: 2, row: 2, kind: 'ai', detail: 'Either a direct chat call (OpenAI client from the project) or an agent run in Foundry Agent Service.' },
  { id: 'tool', label: L.tool, col: 3, row: 1, kind: 'external', disabled: p && p.integration === 'openai', detail: 'Connector-backed tool: Azure AI Search, SharePoint (user identity passthrough), Logic Apps via OpenAPI, etc.' },
  { id: 'stream', label: L.stream, col: 4, row: 1, kind: 'app', badge: p ? p.stream : undefined, detail: 'Return JSON, or iterate the stream and forward deltas as server-sent events.' },
];

export default {
  id: '2.1.5',
  lab: 'SDK integration sandbox',
  services: [
    { name: 'Foundry SDK overview (azure-ai-projects)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/sdk-overview' },
    { name: 'Foundry Agent Service tools', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/overview' },
    { name: 'Connections in Foundry projects', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/connections-add' },
  ],
  prereqs: ['2.1.6', '2.1.1'],
  next: ['2.2.3', '2.3.3'],

  concept: {
    plain: 'To put a generative feature into your app you call the Foundry SDK from your own code — usually a web API. One client object gives you access to models, agents and the project\'s saved connections to other services such as a search index or SharePoint. How you call it matters: reuse the client, don\'t block your web server while waiting, and handle streamed answers properly.',
    technical: 'azure-ai-projects provides AIProjectClient (sync and .aio async) bound to a project endpoint and a TokenCredential. From it you obtain an authenticated OpenAI client (get_openai_client in current versions), the agents client (azure-ai-agents: agents, threads, messages, runs, run steps) and project connections. Connector-backed tools such as AzureAISearchTool, SharepointTool, Bing grounding or OpenApiTool reference a connection id instead of secrets. Integration concerns: client lifetime, async vs sync in the web framework, streaming iterators, tool and downstream errors, and agent/thread lifecycle. Exact method names vary between SDK versions — the code here is illustrative.',
    useCase: 'An internal HR portal (FastAPI on Azure Container Apps) exposes /ask. It reuses one async AIProjectClient, runs a Foundry agent whose SharePoint tool searches the HR site on behalf of the signed-in employee, opens IT tickets through a Logic Apps workflow exposed as an OpenAPI tool, and streams the answer to the browser.',
    terms: [
      ['AIProjectClient', 'Entry-point client for a Foundry project (models, agents, connections, evaluations, telemetry).'],
      ['Connection', 'Project-level reference to an external resource and its auth, used by tools by connection id.'],
      ['.aio client', 'Async variant of an Azure SDK client, used with await in async web frameworks.'],
      ['Run step', 'One step of an agent run (message creation or tool calls) with status and errors.'],
      ['Identity passthrough', 'Tool calls made with the end user\'s identity (on-behalf-of), e.g. the SharePoint tool.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: nodes(p, { handler: 'Your web API', project: 'Foundry project client', connection: 'Saved connection', model: 'Model or agent', tool: 'Connected tool', stream: 'Answer to the user' }),
        edges: [['handler', 'project'], ['project', 'connection'], ['project', 'model'], ['connection', 'tool'], ['model', 'tool'], ['model', 'stream'], ['tool', 'stream']],
      }),
      architectural: p => ({
        nodes: nodes(p, { handler: 'Container Apps (FastAPI) + managed identity', project: 'Foundry project endpoint', connection: p && INTEGRATIONS[p.integration].needs ? `Connection: ${p.connection}` : 'Project connections', model: p && p.integration === 'openai' ? 'Model deployment' : 'Foundry Agent Service', tool: p ? { openai: 'Tool (unused)', agent_search: 'Azure AI Search', agent_sharepoint: 'SharePoint Online', agent_logicapps: 'Logic Apps workflow' }[p.integration] : 'Tool', stream: 'Browser (SSE)' }),
        edges: [['handler', 'project', 'Entra token'], ['project', 'connection'], ['project', 'model'], ['connection', 'tool', 'auth'], ['model', 'tool', 'tool call'], ['model', 'stream'], ['tool', 'stream']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'project', label: `${p && p.callStyle === 'async' ? 'azure.ai.projects.aio.' : ''}AIProjectClient(endpoint, credential)`, col: 0, row: 0, kind: 'code', detail: 'Create once at startup and share.' },
          { id: 'handler', label: `${p && p.callStyle === 'sync' ? 'def' : 'async def'} ask(req)`, col: 0, row: 1, kind: 'code', detail: 'Async handlers must await async clients.' },
          { id: 'connection', label: 'conn = project.connections.get(NAME)', col: 0, row: 2, kind: 'code', disabled: p && !INTEGRATIONS[p.integration].needs, detail: 'Fails with 404 if the connection name does not exist in this project.' },
          { id: 'model', label: p && p.integration === 'openai' ? 'project.get_openai_client().chat.completions.create(...)' : 'project.agents.runs.create_and_process(thread_id, agent_id)', col: 0, row: 3, kind: 'code', detail: 'Illustrative method names; check your SDK version.' },
          { id: 'tool', label: p ? { openai: '# no tool', agent_search: 'AzureAISearchTool(index_connection_id=conn.id, index_name=...)', agent_sharepoint: 'SharepointTool(connection_id=conn.id)', agent_logicapps: 'OpenApiTool(spec=logic_app_spec, auth=managed identity)' }[p.integration] : 'tool', col: 0, row: 4, kind: 'code', detail: 'Tool definitions passed to create_agent.' },
          { id: 'stream', label: p && p.stream === 'handled' ? 'StreamingResponse(forward_deltas(stream))' : 'return {"answer": ...}', col: 0, row: 5, kind: 'code', detail: 'Iterate streams; never index into them as if complete.' },
        ],
        edges: [['project', 'handler'], ['handler', 'connection'], ['connection', 'tool'], ['tool', 'model'], ['model', 'stream']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'integration', label: 'Integration', type: 'select', options: Object.entries(INTEGRATIONS).map(([v, i]) => [v, i.label]), default: 'openai' },
      { id: 'connection', label: 'Connection name used in code', type: 'select', options: Object.entries(CONNECTIONS).map(([v, c]) => [v, c.label]), default: 'contoso-search' },
      { id: 'auth', label: 'Identity for tool calls', type: 'select', options: [['user', 'Signed-in user (on-behalf-of)'], ['app', 'App managed identity only']], default: 'user' },
      { id: 'callStyle', label: 'Handler style', type: 'select', options: [['async', 'async def + .aio client (await)'], ['syncInAsync', 'async def + sync client'], ['sync', 'sync def (threaded)']], default: 'async' },
      { id: 'stream', label: 'Streaming', type: 'select', options: [['off', 'Off'], ['handled', 'On, iterate and forward deltas'], ['unhandled', 'On, but code reads it as a full response']], default: 'off' },
      { id: 'reuse', label: 'Create AIProjectClient (and agent) once, reuse across requests', type: 'toggle', default: true },
      { id: 'users', label: 'Concurrent users', type: 'range', min: 1, max: 30, step: 1, default: 5 },
      { id: 'downstream', label: 'Downstream service health', type: 'select', options: [['ok', 'Healthy'], ['fail', 'Returns 5xx']], default: 'ok' },
    ],
    samples: [
      { label: 'Agent with Azure AI Search', values: { integration: 'agent_search', connection: 'contoso-search' } },
      { label: 'SharePoint agent, streamed', values: { integration: 'agent_sharepoint', connection: 'hr-sharepoint', stream: 'handled' } },
      { label: 'Logic Apps ticket tool', values: { integration: 'agent_logicapps' } },
      { label: 'Chat, new client every request', values: { reuse: false } },
    ],
    run: integrate,
  },

  compare: {
    suggestions: [
      'Run Chat with 20 users as "async + .aio" and then "async + sync client"; compare worst-case latency.',
      'Run the SharePoint agent with streaming off and handled; compare time to first token.',
      'Run the Azure AI Search agent with reuse on and off and compare single-request latency and the generated code.',
    ],
  },

  debug: [
    { id: 'conn404', title: 'Agent fails right after deployment to test', values: { integration: 'agent_search', connection: 'old-search' }, node: 'connection',
      symptom: 'ResourceNotFound when resolving the connection.', cause: 'The code references a connection that was deleted / not created in this project.', fix: 'Use the existing connection (contoso-search) and read the name from configuration per environment.' },
    { id: 'conntype', title: 'SharePoint agent configured with the search connection', values: { integration: 'agent_sharepoint', connection: 'contoso-search' }, node: 'connection',
      symptom: 'Wrong connection type error.', cause: 'SharepointTool needs a SharePoint connection, not Azure AI Search.', fix: 'Select hr-sharepoint.' },
    { id: 'obo', title: 'SharePoint tool fails from the background job', values: { integration: 'agent_sharepoint', connection: 'hr-sharepoint', auth: 'app' }, node: 'tool',
      symptom: 'Tool rejected the app-only identity.', cause: 'The SharePoint tool uses the end user\'s identity so results respect SharePoint permissions.', fix: 'Call it in a user context (on-behalf-of the signed-in user).' },
    { id: 'block', title: 'API times out at lunchtime peak', values: { callStyle: 'syncInAsync', users: 20, integration: 'agent_search', connection: 'contoso-search' }, node: 'handler',
      symptom: 'Latency grows with concurrent users; gateway timeouts.', cause: 'Sync SDK calls inside async def block the event loop, serialising requests.', fix: 'Use the .aio client with await (or make the handler sync so the server uses threads).' },
    { id: 'stream500', title: 'HTTP 500 after enabling streaming', values: { stream: 'unhandled' }, node: 'stream',
      symptom: "AttributeError: 'Stream' object has no attribute 'choices'.", cause: 'stream=True returns an event iterator; the code still reads it as a completed response.', fix: 'Iterate the stream and forward deltas (or turn streaming off).' },
    { id: 'perreq', title: 'Hundreds of identical agents appear in the project', values: { integration: 'agent_search', connection: 'contoso-search', reuse: false }, node: 'model',
      symptom: 'Every request creates a new agent definition and a new client; latency is higher.', cause: 'Client and agent are created inside the handler instead of once at startup.', fix: 'Create AIProjectClient and the agent once and reuse them; create only a thread per conversation.' },
    { id: 'logic502', title: 'Ticket creation fails intermittently', values: { integration: 'agent_logicapps', downstream: 'fail' }, node: 'tool',
      symptom: 'Run step failed with a tool error; HTTP 502 from the workflow.', cause: 'Downstream failure inside the Logic Apps workflow.', fix: 'Fix the workflow (here: set downstream to Healthy); in production add retries and a graceful message.' },
  ],

  challenge: {
    task: 'Ship the SharePoint-grounded HR agent for 20 concurrent users with streaming, with no warnings or errors.',
    condition: 'Integration = SharePoint agent, users ≥ 20, streaming handled, no warn or error steps.',
    hint: 'Check the connection type, whose identity the tool uses, and how the handler waits for the SDK.',
    check: (p, res) => p.integration === 'agent_sharepoint' && Number(p.users) >= 20 && p.stream === 'handled' && !res.steps.some(s => s.status === 'error' || s.status === 'warn'),
    solution: ['Integration: Agent + SharePoint tool; connection hr-sharepoint.', 'Identity: signed-in user (on-behalf-of).', 'Handler: async def + .aio client; reuse the AIProjectClient.', 'Streaming: on, iterate and forward deltas. Set users to 20 and run.'],
    solutionValues: { integration: 'agent_sharepoint', connection: 'hr-sharepoint', auth: 'user', callStyle: 'async', stream: 'handled', reuse: true, users: 20, downstream: 'ok' },
  },

  quiz: [
    { q: 'Your FastAPI "async def" endpoint calls the sync AIProjectClient and latency grows linearly with concurrent users. What is the best fix?', options: ['Increase the model deployment capacity', 'Use the azure.ai.projects.aio client and await its calls', 'Enable streaming', 'Create a new client per request'], answer: 1, why: 'Blocking calls inside the event loop serialise requests. Async clients let requests overlap.' },
    { q: 'An agent must search an Azure AI Search index without embedding keys in code. How should the tool reference the index?', options: ['Paste the admin key into the agent instructions', 'Use a project connection and pass its connection id to AzureAISearchTool', 'Store the key in an environment variable read by the model', 'Use a SharePoint connection'], answer: 1, why: 'Tools reference project connections by id; the connection holds the auth configuration.' },
    { q: 'After enabling stream=True, the endpoint returns HTTP 500 with "Stream object has no attribute choices". What changed?', options: ['The deployment was renamed', 'The SDK now returns an iterator of chunks that must be consumed', 'The token expired', 'The content filter blocked output'], answer: 1, why: 'Streaming responses are iterables of deltas; forward them or aggregate them.' },
    { q: 'An HR agent uses the SharePoint tool. Employees should only see documents they are allowed to open. What makes this work?', options: ['Give the app identity Owner on the SharePoint site', 'The tool uses the signed-in user\'s identity (on-behalf-of)', 'Filter results in the agent instructions', 'Copy documents to Blob Storage'], answer: 1, why: 'Identity passthrough enforces each user\'s existing SharePoint permissions.' },
  ],

  recap: 'Integrate through one long-lived AIProjectClient: get an OpenAI client for direct calls, or run agents whose tools reference project connections instead of secrets. Match async clients to async handlers, consume streams correctly, create agents once and threads per conversation, respect connector identity rules, and handle downstream tool failures gracefully.',
};
