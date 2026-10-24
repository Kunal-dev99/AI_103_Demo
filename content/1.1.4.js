// 1.1.4 Choose appropriate memory, tool, and knowledge integration services for agent solutions
// Lab: Agent context wiring bench.
import { step, metric, estTokens } from '../src/engine/util.js';

const INSTRUCTIONS = 'You are the Contoso Retail order assistant. Answer only from tools, memory or retrieved policy. Cite policy sources. Ask before changing anything.';
const PRIOR = [
  { role: 'user', text: 'Hi, my order number is 1182.' },
  { role: 'assistant', text: 'Thanks. I can see order 1182 (2 items, shipping Thursday). How can I help?' },
];

// Each turn needs one capability. needs: thread | memory | knowledge | action | mcp | web
const TURNS = {
  recall: { label: 'Same chat: "What order number did I give you earlier?"', text: 'What order number did I give you earlier?', needs: 'thread',
    good: 'You told me your order number is 1182.', bad: 'I don\'t have any earlier messages from you in this conversation. Could you share your order number?' },
  pref: { label: 'New chat next week: "Send me updates the way I prefer."', text: 'Can you send me delivery updates the way I prefer?', needs: 'memory',
    good: 'Sure: I\'ll send updates by SMS, as you asked last time.', bad: 'How would you like to receive updates: email, SMS or app notification?' },
  policy: { label: '"Can I return opened headphones?"', text: 'Can I return headphones I\'ve already opened?', needs: 'knowledge',
    good: 'Yes, within 30 days if all accessories are included; a 10% restocking fee applies to opened audio products [returns-policy.pdf, §4.2].', bad: 'Most retailers accept returns within 30 days.' },
  action: { label: '"Change delivery address for order 1182 to 4 Elm St."', text: 'Please change the delivery address for order 1182 to 4 Elm St.', needs: 'action',
    good: 'Done: order 1182 will now be delivered to 4 Elm St. (confirmation CHG-5531).', bad: 'I\'m unable to change orders. Please contact customer service.' },
  partner: { label: '"Open a ticket with the courier about my parcel."', text: 'Open a ticket with the courier: parcel for 1182 shows no movement for 3 days.', needs: 'mcp',
    good: 'I opened courier ticket FWD-88213; they will reply within one business day.', bad: 'I can\'t contact the courier directly.' },
  news: { label: '"Are there courier strikes this week?"', text: 'Are there any courier strikes this week that could delay my parcel?', needs: 'web',
    good: 'Recent news reports a regional courier strike planned for Friday (source: news site, retrieved today); your parcel may be delayed by a day.', bad: 'I don\'t have information about current events.' },
};

function simulate(p) {
  const t = TURNS[p.turn];
  const steps = [];
  const context = [['System instructions', 'agent definition', estTokens(INSTRUCTIONS)]];
  const chat = [];
  let answered = false;
  let failure = null;

  // Tool definitions are sent to the model on every turn
  const toolDefs = [];
  if (p.knowledge === 'fileSearch') toolDefs.push('file_search');
  if (p.knowledge === 'aiSearch') toolDefs.push('azure_ai_search');
  if (p.knowledge === 'foundryIQ') toolDefs.push('knowledge base (Foundry IQ)');
  if (p.fnTool) toolDefs.push('function: change_address');
  if (p.openApiTool) toolDefs.push('openapi: orders-api');
  if (p.mcpTool) toolDefs.push('mcp: courier-helpdesk');
  if (p.bing) toolDefs.push('bing_grounding');
  if (toolDefs.length) context.push(['Tool definitions', toolDefs.join(', '), toolDefs.length * 90]);
  steps.push(step('user', 'Turn received', `"${t.text}"`, { conversation: p.conversation, toolsAvailable: toolDefs }, 'info'));

  // 1. Conversation state
  if (p.conversation === 'persist') {
    if (p.turn === 'pref') {
      steps.push(step('thread', 'New conversation', 'This is a new session a week later, so the previous conversation is not attached. Conversation history only covers the current conversation.', { conversation: 'conv_new', priorItems: 0 }, 'info'));
    } else {
      context.push(['Conversation history', 'Agent Service conversation (server-side)', PRIOR.reduce((a, m) => a + estTokens(m.text), 0)]);
      chat.push(...PRIOR.map(m => ({ ...m, meta: 'earlier in this conversation' })));
      steps.push(step('thread', 'Conversation history loaded', 'The app reuses the same conversation ID, so Agent Service supplies earlier messages to the model automatically.', { conversation: 'conv_7f3a (reused)', priorItems: PRIOR.length }));
    }
  } else if (p.conversation === 'client') {
    if (p.turn !== 'pref') {
      context.push(['Conversation history', 'resent by the app (last N turns)', PRIOR.reduce((a, m) => a + estTokens(m.text), 0)]);
      chat.push(...PRIOR.map(m => ({ ...m, meta: 'resent by client' })));
    }
    steps.push(step('thread', 'Client-managed history', 'Your app stores and resends recent turns with each request (Responses / chat completions style). Works, but you own storage, truncation and token growth.', { strategy: 'client', priorItems: p.turn === 'pref' ? 0 : PRIOR.length }, 'info'));
  } else {
    steps.push(step('thread', 'New conversation every request', 'Each request starts an empty conversation, so the model sees only the current message.', { conversation: 'new each call', priorItems: 0 }, p.turn === 'recall' ? 'warn' : 'info'));
  }
  if (t.needs === 'thread') {
    if (p.conversation !== 'new') answered = true; else failure = { node: 'thread', title: 'No conversation history', detail: 'The earlier message with the order number is not in context. Reuse the conversation ID (or resend history).' };
  }

  // 2. Long-term memory
  if (p.ltm) {
    context.push(['Long-term memory', 'memory store: user profile facts', 18]);
    steps.push(step('memory', 'Memory recalled', 'Facts extracted from earlier sessions for this user are injected: "prefers SMS updates", "lives in UK". (Agent memory is a preview capability; check availability and data-retention settings.)', { scope: 'user:anna@contoso', items: ['preferred_channel = SMS', 'country = UK'] }));
  } else {
    steps.push(step('memory', 'No long-term memory', 'Nothing persists across conversations except what your own app stores.', null, t.needs === 'memory' ? 'warn' : 'skip'));
  }
  if (t.needs === 'memory') {
    if (p.ltm) answered = true; else failure = { node: 'memory', title: 'Preference forgotten', detail: 'A new conversation has no history; without a long-term memory store (or your own profile lookup) the preference is lost.' };
  }

  // 3. Knowledge
  if (t.needs === 'knowledge') {
    if (p.knowledge === 'none') {
      failure = { node: 'knowledge', title: 'Ungrounded answer', detail: 'No knowledge tool is attached, so the model answers from general training data: no citation, and the restocking fee is missing.' };
    } else if ((p.knowledge === 'aiSearch' || p.knowledge === 'foundryIQ') && !p.searchRole) {
      steps.push(step('knowledge', 'Search call forbidden (403)', 'The project connection uses Microsoft Entra ID, but the project\'s managed identity has no "Search Index Data Reader" role on the search service.', { tool: p.knowledge, httpStatus: 403, missingRole: 'Search Index Data Reader' }, 'error'));
      failure = { node: 'knowledge', title: 'Retrieval failed', detail: 'The tool call failed, so the agent has no policy text to ground on.', already: true };
    } else {
      const src = { fileSearch: 'vector store from uploaded returns-policy.pdf', aiSearch: 'Azure AI Search index "policies" (hybrid + semantic)', foundryIQ: 'Foundry IQ knowledge base "customer-policies" (agentic retrieval)' }[p.knowledge];
      const chunk = '§4.2 Opened audio products may be returned within 30 days with all accessories. A 10% restocking fee applies.';
      context.push(['Retrieved chunks', src, estTokens(chunk) * 3]);
      chat.push({ role: 'tool', text: chunk, meta: src });
      steps.push(step('knowledge', 'Policy retrieved', `Retrieved 3 chunks from ${src}.`, { tool: p.knowledge, topChunk: chunk }));
      answered = true;
    }
  } else if (p.knowledge !== 'none') {
    steps.push(step('knowledge', 'Knowledge tool available, not used', 'The model decided this turn does not need retrieval. The tool definition still costs a few tokens.', { tool: p.knowledge }, 'skip'));
  }

  // 4. Action tools
  if (t.needs === 'action') {
    if (p.openApiTool) {
      chat.push({ role: 'tool', text: 'PATCH /orders/1182/address → 200 {"confirmation":"CHG-5531"}', meta: 'OpenAPI tool, called by Agent Service' });
      steps.push(step('tools', 'OpenAPI tool called', 'Agent Service calls the orders API directly from its OpenAPI spec, authenticating with the configured connection (anonymous, API key or managed identity).', { tool: 'openapi: orders-api', operation: 'updateAddress', status: 200 }));
      answered = true;
    } else if (p.fnTool) {
      chat.push({ role: 'tool', text: 'change_address(order_id="1182", address="4 Elm St.") → {"confirmation":"CHG-5531"}', meta: 'function tool, executed by your app' });
      steps.push(step('tools', 'Function tool requested', 'The run pauses with a required action; your code executes change_address and submits the output, then the run continues.', { tool: 'function: change_address', arguments: { order_id: '1182', address: '4 Elm St.' } }));
      answered = true;
    } else {
      failure = { node: 'tools', title: 'No action tool', detail: 'Nothing lets the agent change an order. Add a function tool (your code executes) or an OpenAPI tool (service calls the API).' };
    }
  }
  if (t.needs === 'mcp') {
    if (p.mcpTool) {
      chat.push({ role: 'tool', text: 'courier-helpdesk.create_ticket(ref="1182", issue="no movement 3 days") → FWD-88213', meta: 'remote MCP server' });
      steps.push(step('tools', p.mcpApproval ? 'MCP call approved, then executed' : 'MCP tool called', `The agent discovers tools exposed by the courier's remote MCP server and calls create_ticket.${p.mcpApproval ? ' The run first paused for approval; your app showed the call to a human, who approved it.' : ' No approval was required: make sure you trust this server.'}`,
        { server: 'https://mcp.courier.example/', tool: 'create_ticket', requireApproval: p.mcpApproval }, p.mcpApproval ? 'ok' : 'info'));
      answered = true;
    } else if (p.fnTool || p.openApiTool) {
      failure = { node: 'tools', title: 'Wrong tool type', detail: 'Your function/OpenAPI tools only cover the orders API. The courier exposes its helpdesk as an MCP server; add an MCP tool pointing at it.' };
    } else {
      failure = { node: 'tools', title: 'No tool for the courier', detail: 'Add an MCP tool for the courier helpdesk server.' };
    }
  }
  // 5. Web grounding
  if (t.needs === 'web') {
    if (p.bing) {
      chat.push({ role: 'tool', text: 'Grounding with Bing Search: 3 recent news results about courier strikes', meta: 'web' });
      steps.push(step('web', 'Web grounding used', 'Grounding with Bing Search returns fresh public results. Follow its display requirements (show citations/links) and note that queries leave the Azure compliance boundary; check the terms.', { tool: 'bing_grounding', results: 3 }));
      answered = true;
    } else {
      failure = { node: 'web', title: 'No current information', detail: 'Training data and internal policies cannot answer a question about this week\'s news. Add Grounding with Bing Search.' };
    }
  }

  context.push(['User message', 'current turn', estTokens(t.text)]);
  if (failure && !failure.already) steps.push(step(failure.node, failure.title, failure.detail, { needed: t.needs }, 'error'));
  const answer = answered && !failure ? t.good : t.bad;
  steps.push(step('model', answered && !failure ? 'Grounded answer generated' : 'Answer generated without what it needed', answered && !failure ? 'The model had the required context and responded.' : 'The model responded anyway: this is how missing context turns into unhelpful or made-up answers.', { contextSegments: context.length }, answered && !failure ? 'ok' : 'warn'));
  chat.push({ role: 'user', text: t.text });
  // Reorder so the user turn comes before tool calls
  const prior = chat.filter(m => m.meta && /earlier|resent/.test(m.meta));
  const tools = chat.filter(m => m.role === 'tool');
  const turns = [...prior, { role: 'user', text: t.text }, ...tools, { role: 'assistant', text: answer, meta: answered && !failure ? 'ok' : 'missing context' }];
  const total = context.reduce((a, c) => a + c[2], 0);

  return {
    steps,
    output: [
      { type: 'chat', title: 'What happened on this turn', turns },
      { type: 'table', title: 'What the model actually sees (context window)', columns: ['Segment', 'Source', '≈Tokens'], rows: context.map(c => [c[0], c[1], String(c[2])]) },
      { type: 'alert', tone: answered && !failure ? 'ok' : 'error', text: answered && !failure ? `Needed capability "${t.needs}" was wired in.` : `Needed capability "${t.needs}" was missing or failing. ${failure ? failure.detail : ''}` },
    ],
    metrics: [
      metric('Turn handled', answered && !failure ? 'yes' : 'no', 'computed'),
      metric('Tools attached', String(toolDefs.length), 'computed'),
      metric('Context size', `≈${total} tokens`, 'estimate', '4-characters-per-token heuristic; tool definitions assumed ≈90 tokens each.'),
    ],
    summary: `${p.turn}: ${answered && !failure ? 'handled' : 'failed'} (${toolDefs.length} tools, ${p.conversation} history${p.ltm ? ', memory' : ''})`,
  };
}

const allTurnsPass = p => Object.keys(TURNS).every(k => !simulate({ ...p, turn: k }).steps.some(s => s.status === 'error'));

const off = (p, cond) => (p ? !cond : false);

export default {
  id: '1.1.4',
  lab: 'Agent context wiring bench',
  services: [
    { name: 'Foundry Agent Service: tools overview', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/overview' },
    { name: 'Azure AI Search tool for agents', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/azure-ai-search' },
    { name: 'Connect agents to MCP servers', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/model-context-protocol' },
    { name: 'Grounding with Bing Search', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-grounding' },
  ],
  prereqs: ['1.1.2', '1.1.3'],
  next: ['2.2.1', '2.2.2', '2.2.3'],

  concept: {
    plain: 'An agent only knows what is in front of the model on each turn. Short-term memory (the conversation) lets it remember what you said a minute ago. Long-term memory lets it remember you next week. Knowledge tools let it look things up in your documents, action tools let it change things in other systems, and web grounding lets it see today\'s news. Pick each one for the gap it fills: wiring the wrong one leaves the agent guessing.',
    technical: 'In Foundry Agent Service, conversation state is held server-side when the app reuses a conversation/thread ID (or the app resends history itself). Long-term memory (preview) extracts and recalls user facts across sessions. Knowledge integrations include the file search tool (managed vector store), the Azure AI Search tool (project connection to an existing index; the project identity needs Search Index Data Reader) and Foundry IQ knowledge bases. Action tools include function tools (the run returns a required action; your code executes and submits outputs), OpenAPI tools (the service calls the API from a spec with anonymous, key or managed-identity auth) and MCP tools (remote MCP servers, with optional approval). Grounding with Bing Search adds current web results with display requirements.',
    useCase: 'A retail support agent reuses the conversation for each chat, remembers a customer\'s preferred contact channel across visits, answers return questions from an Azure AI Search index of policies, changes delivery addresses through the orders OpenAPI tool, opens courier tickets through the courier\'s MCP server (with approval), and checks news for strikes via Bing grounding.',
    terms: [
      ['Conversation / thread', 'Server-side message history for one session; reuse its ID to keep context.'],
      ['Long-term memory', 'Facts about a user stored and recalled across conversations (preview in Foundry).'],
      ['Function tool', 'A tool schema the model can call; your code runs it and returns the result.'],
      ['OpenAPI tool', 'The agent service calls a REST API described by an OpenAPI spec.'],
      ['MCP tool', 'Connects the agent to tools exposed by a Model Context Protocol server.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'user', label: 'User turn', col: 0, row: 1.5, kind: 'user', detail: 'The new message.' },
          { id: 'thread', label: p ? `Conversation: ${p.conversation}` : 'Short-term memory', col: 1, row: 0, kind: 'data', detail: 'Earlier messages in this session.' },
          { id: 'memory', label: 'Long-term memory', col: 1, row: 1, kind: 'data', disabled: off(p, p && p.ltm), detail: 'User facts across sessions.' },
          { id: 'knowledge', label: p ? `Knowledge: ${p.knowledge}` : 'Knowledge', col: 1, row: 2, kind: 'store', disabled: off(p, p && p.knowledge !== 'none'), detail: 'Your documents via file search, Azure AI Search or a knowledge base.' },
          { id: 'tools', label: 'Action tools', col: 1, row: 3, kind: 'external', disabled: off(p, p && (p.fnTool || p.openApiTool || p.mcpTool)), detail: 'Function, OpenAPI, MCP.' },
          { id: 'web', label: 'Web grounding', col: 2, row: 3, kind: 'external', disabled: off(p, p && p.bing), detail: 'Current public information.' },
          { id: 'model', label: 'Context window → model', col: 3, row: 1.5, kind: 'ai', detail: 'Everything above, assembled per turn. Missing pieces = guessing.' },
        ],
        edges: [['user', 'model'], ['thread', 'model'], ['memory', 'model'], ['knowledge', 'model'], ['tools', 'model'], ['web', 'model']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'user', label: 'Web chat app', col: 0, row: 1.5, kind: 'app', detail: 'Keeps the conversation ID per browser session.' },
          { id: 'agent', label: 'Foundry Agent Service', col: 1, row: 1.5, kind: 'compute', detail: 'Agent definition: model deployment, instructions, tools.' },
          { id: 'thread', label: 'Conversation store', col: 2, row: 0, kind: 'store', detail: 'Server-side history (standard setup can use your own Cosmos DB).' },
          { id: 'memory', label: 'Memory store (preview)', col: 2, row: 1, kind: 'store', disabled: off(p, p && p.ltm), detail: 'Per-user long-term facts.' },
          { id: 'knowledge', label: p && p.knowledge === 'fileSearch' ? 'Agent vector store' : 'Azure AI Search', col: 3, row: 0, kind: 'store', disabled: off(p, p && p.knowledge !== 'none'), badge: p && p.knowledge !== 'none' && p.knowledge !== 'fileSearch' && !p.searchRole ? 'no RBAC' : undefined, detail: 'Requires Search Index Data Reader for the project identity when using Entra ID auth.' },
          { id: 'tools', label: 'Orders API / courier MCP server', col: 3, row: 2, kind: 'external', disabled: off(p, p && (p.fnTool || p.openApiTool || p.mcpTool)), detail: 'OpenAPI tool calls the API; MCP tool calls the remote server; function tools are executed by your app.' },
          { id: 'web', label: 'Bing Search resource', col: 3, row: 3, kind: 'external', disabled: off(p, p && p.bing), detail: 'Grounding with Bing Search connection.' },
          { id: 'model', label: 'Model deployment', col: 2, row: 3, kind: 'ai', detail: 'Chat model that supports tool calling.' },
        ],
        edges: [['user', 'agent', 'messages'], ['agent', 'thread'], ['agent', 'memory'], ['agent', 'knowledge', 'retrieve'], ['agent', 'tools', 'call'], ['agent', 'web', 'search'], ['agent', 'model', 'inference']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'agent', label: 'agent = project.agents.create_agent(model=DEPLOYMENT, instructions=..., tools=toolset)', col: 0, row: 0, kind: 'code', detail: 'Illustrative azure-ai-projects / azure-ai-agents call; names differ between SDK versions.' },
          { id: 'knowledge', label: p && p.knowledge === 'fileSearch' ? 'FileSearchTool(vector_store_ids=[vs.id])' : 'AzureAISearchTool(index_connection_id=conn_id, index_name="policies")', col: 0, row: 1, kind: 'code', disabled: off(p, p && p.knowledge !== 'none'), detail: 'Illustrative tool constructors from azure-ai-agents.' },
          { id: 'tools', label: 'FunctionTool({change_address}) | OpenApiTool(spec, auth) | McpTool(server_url, allowed_tools)', col: 0, row: 2, kind: 'code', detail: 'Illustrative. Function tools need your code to submit tool outputs.' },
          { id: 'web', label: 'BingGroundingTool(connection_id=bing_conn)', col: 0, row: 3, kind: 'code', disabled: off(p, p && p.bing), detail: 'Illustrative.' },
          { id: 'thread', label: p && p.conversation === 'persist' ? 'reuse conversation_id from session' : p && p.conversation === 'client' ? 'messages = history[-N:] + [new]' : 'create a new conversation per request', col: 0, row: 4, kind: 'code', detail: 'The conversation strategy is an app decision.' },
          { id: 'model', label: 'run = create_and_process(thread_id, agent_id)', col: 0, row: 5, kind: 'code', detail: 'Illustrative: run the agent on the conversation and read the reply.' },
        ],
        edges: [['agent', 'knowledge'], ['agent', 'tools'], ['agent', 'web'], ['thread', 'model']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'turn', label: 'User turn', type: 'select', options: Object.entries(TURNS).map(([v, t]) => [v, t.label]), default: 'recall' },
      { id: 'conversation', label: 'Conversation state', type: 'select', options: [['persist', 'Reuse server-side conversation'], ['new', 'New conversation every request'], ['client', 'App resends last N turns']], default: 'persist' },
      { id: 'ltm', label: 'Long-term memory (preview)', type: 'toggle', default: false },
      { id: 'knowledge', label: 'Knowledge integration', type: 'select', options: [['none', 'None'], ['fileSearch', 'File search tool (uploaded files)'], ['aiSearch', 'Azure AI Search tool (existing index)'], ['foundryIQ', 'Foundry IQ knowledge base']], default: 'none' },
      { id: 'searchRole', label: 'Project identity has Search Index Data Reader', type: 'toggle', default: true },
      { id: 'fnTool', label: 'Function tool: change_address', type: 'toggle', default: false },
      { id: 'openApiTool', label: 'OpenAPI tool: orders API', type: 'toggle', default: false },
      { id: 'mcpTool', label: 'MCP tool: courier helpdesk server', type: 'toggle', default: false },
      { id: 'mcpApproval', label: 'Require approval for MCP calls', type: 'toggle', default: true },
      { id: 'bing', label: 'Grounding with Bing Search', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Policy question with AI Search', values: { turn: 'policy', knowledge: 'aiSearch' } },
      { label: 'Address change via OpenAPI', values: { turn: 'action', openApiTool: true } },
      { label: 'Preference in a new session', values: { turn: 'pref', ltm: true } },
      { label: 'Courier ticket via MCP', values: { turn: 'partner', mcpTool: true } },
    ],
    run: simulate,
  },

  compare: {
    suggestions: [
      'Turn = recall: compare conversation "reuse" vs "new every request" and look at the context table.',
      'Turn = policy: compare file search, Azure AI Search and no knowledge; note the citation.',
      'Turn = action: compare the function tool (your code executes) with the OpenAPI tool (service executes).',
    ],
  },

  debug: [
    { id: 'stateless', title: 'Agent forgets what the user just said', values: { turn: 'recall', conversation: 'new' }, node: 'thread',
      symptom: 'Asks for the order number again.', cause: 'The app creates a new conversation on every request, so no history is in context.', fix: 'Reuse the server-side conversation ID (or resend history).' },
    { id: 'no-ltm', title: 'Preference lost between sessions', values: { turn: 'pref', ltm: false }, node: 'memory',
      symptom: 'Agent asks for the preferred channel again.', cause: 'Conversation history does not span sessions.', fix: 'Turn on long-term memory (or look up a profile store via a tool).' },
    { id: 'rbac', title: 'Search tool returns 403', values: { turn: 'policy', knowledge: 'aiSearch', searchRole: false }, node: 'knowledge',
      symptom: 'Tool call fails; answer has no citation.', cause: 'Project managed identity lacks Search Index Data Reader on the search service.', fix: 'Assign the role (turn on the RBAC toggle).' },
    { id: 'ungrounded', title: 'Generic return policy answer', values: { turn: 'policy', knowledge: 'none' }, node: 'knowledge',
      symptom: '"Most retailers accept returns within 30 days." No fee, no citation.', cause: 'No knowledge integration attached.', fix: 'Attach file search, Azure AI Search or a knowledge base.' },
    { id: 'wrong-tool', title: 'Agent cannot reach the courier', values: { turn: 'partner', openApiTool: true, mcpTool: false }, node: 'tools',
      symptom: 'Error: wrong tool type.', cause: 'The courier exposes an MCP server, not the orders API.', fix: 'Add the MCP tool for the courier helpdesk.' },
    { id: 'no-web', title: 'Agent says it cannot know about strikes', values: { turn: 'news', bing: false }, node: 'web',
      symptom: 'No current information.', cause: 'Neither training data nor internal docs contain this week\'s news.', fix: 'Turn on Grounding with Bing Search.' },
  ],

  challenge: {
    task: 'Wire one agent configuration that handles all six user turns without a single error.',
    condition: 'Running every turn with your settings produces no error step.',
    hint: 'Each turn needs a different capability. One of them depends on a role assignment.',
    check: (p, res) => !res.steps.some(s => s.status === 'error') && allTurnsPass(p),
    solution: ['Conversation: reuse server-side conversation.', 'Long-term memory: on.', 'Knowledge: Azure AI Search (or file search) with the Search Index Data Reader role.', 'Tools: OpenAPI (or function) for orders, MCP for the courier (approval on).', 'Grounding with Bing Search: on.'],
    solutionValues: { conversation: 'persist', ltm: true, knowledge: 'aiSearch', searchRole: true, openApiTool: true, mcpTool: true, mcpApproval: true, bing: true },
  },

  quiz: [
    { q: 'Your agent must call an internal REST API that already has an OpenAPI 3 spec, and you do not want to host extra code to execute calls. Which tool?', options: ['Function tool', 'OpenAPI tool', 'File search', 'Bing grounding'], answer: 1, why: 'The OpenAPI tool lets the service call the API directly from the spec; a function tool requires your code to execute the call.' },
    { q: 'Customers complain the agent forgets their dietary preference when they come back the next day. What addresses this?', options: ['Increase max tokens', 'Long-term memory (or a profile lookup tool)', 'Reuse the same conversation forever for all users', 'Add Bing grounding'], answer: 1, why: 'Conversation history is per session; cross-session facts need a memory store or a profile tool.' },
    { q: 'The Azure AI Search tool returns 403 although the index exists and the connection uses Entra ID. What is the likely fix?', options: ['Regenerate the admin key', 'Grant the project managed identity Search Index Data Reader', 'Switch to file search', 'Lower top K'], answer: 1, why: 'Keyless connections authorize with RBAC; the identity needs a data-plane read role.' },
    { q: 'A partner exposes its ticketing operations as a remote MCP server. How should the agent use them?', options: ['Write a function tool that screen-scrapes their portal', 'Add an MCP tool pointing at the server, with approval for write actions', 'Upload their docs to file search', 'Use Bing grounding'], answer: 1, why: 'MCP tools let the agent discover and call the server\'s tools; approvals add human control over side effects.' },
  ],

  recap: 'Match each gap to an integration: reuse conversations for short-term context, long-term memory for cross-session facts, file search / Azure AI Search / knowledge bases for your documents (with the right RBAC), function, OpenAPI or MCP tools for actions, and Bing grounding for current public information. The context table shows exactly what the model gets.',
};
