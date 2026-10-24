// 2.2.1 Define agent roles, goals, conversation-tracking approach, and tool schemas
// Lab: Agent definition builder.
import { step, metric, words } from '../src/engine/util.js';

const GOOD_INSTRUCTIONS = `You are Contoso Travel's booking assistant for employees.
Goal: help employees find and book policy-compliant flights.
Always search before booking. Ask for any missing origin, destination or date.
Never book a flight unless the user explicitly confirms.`;

const SEARCH = { type: 'function', function: { name: 'search_flights', description: 'Search available flights between two airports on a given date. Use when the user wants to find or compare flights.',
  parameters: { type: 'object', properties: {
    origin: { type: 'string', description: 'Departure airport IATA code, e.g. SEA' },
    destination: { type: 'string', description: 'Arrival airport IATA code, e.g. LHR' },
    date: { type: 'string', description: 'Departure date, YYYY-MM-DD' } }, required: ['origin', 'destination', 'date'] } } };
const BOOK = { type: 'function', function: { name: 'book_flight', description: 'Book (reserve) one specific flight by its flight id. Only call after the user explicitly confirms.',
  parameters: { type: 'object', properties: {
    flight_id: { type: 'string', description: 'Flight id returned by search_flights, e.g. BA48' },
    confirmed: { type: 'boolean', description: 'True only if the user explicitly confirmed the booking' } }, required: ['flight_id', 'confirmed'] } } };
const POLICY = { type: 'function', function: { name: 'get_travel_policy', description: 'Look up Contoso travel policy rules such as baggage allowance, cabin class or per-diem limits.',
  parameters: { type: 'object', properties: { topic: { type: 'string', enum: ['baggage', 'cabin_class', 'per_diem'], description: 'Policy topic' } }, required: ['topic'] } } };

const fmt = arr => JSON.stringify(arr, null, 2);
const DEFAULT_TOOLS = fmt([SEARCH, BOOK]);
const WITH_POLICY = fmt([SEARCH, BOOK, POLICY]);
const VAGUE = fmt([
  { type: 'function', function: { name: 'flights_tool', description: 'Handles flights.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'flights_tool_2', description: 'Handles flights.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
]);
const MALFORMED = fmt([SEARCH]).replace('"required": [', '"required": ["passenger", ').replace('"type": "string",\n            "description": "Departure date', '"type": "date",\n            "description": "Departure date');

// Test utterances. ctx = needs the previous turn (search results) to resolve.
const UTTERANCES = [
  { id: 'u1', text: 'Find flights from SEA to LHR on 2026-11-03', intent: ['search', 'find', 'flight', 'available'], expect: 'search_flights' },
  { id: 'u2', text: 'Book flight BA48 for me — yes, I confirm.', intent: ['book', 'reserve', 'flight', 'confirm'], expect: 'book_flight' },
  { id: 'u3', text: 'What is the baggage allowance for economy?', intent: ['policy', 'baggage', 'allowance', 'rule'], expect: 'get_travel_policy|none' },
  { id: 'u4', text: 'Find me something to Paris next week', intent: ['search', 'find', 'flight'], expect: 'search_flights' },
  { id: 'u5', text: 'Book the second one, I confirm.', intent: ['book', 'reserve', 'flight', 'confirm'], expect: 'book_flight', ctx: true },
];
const PREV_RESULTS = ['BA48', 'VS2', 'AA6135'];

const norm = w => w.replace(/(ing|s)$/, '');
const VALID_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

function validateTools(text) {
  const errors = [], warnings = [];
  let tools;
  try { tools = JSON.parse(text); } catch (e) { return { errors: [`Not valid JSON: ${String(e.message).slice(0, 90)}`], warnings, tools: [] }; }
  if (!Array.isArray(tools)) return { errors: ['Tool definitions must be a JSON array.'], warnings, tools: [] };
  const names = new Set();
  const ok = [];
  tools.forEach((t, i) => {
    const f = t && (t.function || t);
    const where = `tools[${i}]`;
    if (!f || typeof f !== 'object') { errors.push(`${where}: not an object`); return; }
    if (t.type && t.type !== 'function') warnings.push(`${where}: type "${t.type}" is not a function tool (ignored here)`);
    if (!f.name || !/^[a-zA-Z0-9_-]{1,64}$/.test(f.name)) { errors.push(`${where}: name missing or invalid (letters, digits, _ and -, max 64)`); return; }
    if (names.has(f.name)) errors.push(`${where}: duplicate name ${f.name}`);
    names.add(f.name);
    if (!f.description) errors.push(`${f.name}: description missing — the model chooses tools by their descriptions`);
    else if (f.description.length < 25) warnings.push(`${f.name}: description "${f.description}" is too vague to choose between tools`);
    const ps = f.parameters;
    if (!ps || ps.type !== 'object' || typeof ps.properties !== 'object' || !ps.properties) { errors.push(`${f.name}: parameters must be a JSON Schema object with "properties"`); return; }
    for (const [k, v] of Object.entries(ps.properties)) {
      if (!v || !VALID_TYPES.includes(v.type)) errors.push(`${f.name}.${k}: invalid JSON Schema type "${v && v.type}"${v && v.type === 'date' ? ' (use "string" with a format/description)' : ''}`);
      if (v && !v.description) warnings.push(`${f.name}.${k}: no description — the model has to guess what to put here`);
    }
    for (const r of ps.required || []) if (!(r in ps.properties)) errors.push(`${f.name}: required field "${r}" is not defined in properties`);
    ok.push(f);
  });
  return { errors, warnings, tools: ok };
}

function selectTool(u, tools, choice) {
  if (choice === 'none') return { tool: null, scores: {} };
  const scores = {};
  for (const t of tools) {
    const vocab = new Set([...t.name.split(/[_-]/), ...words(t.description)].map(norm));
    scores[t.name] = u.intent.filter(w => vocab.has(norm(w))).length / u.intent.length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!best.length) return { tool: null, scores };
  const tie = best.length > 1 && best[0][1] === best[1][1] && best[0][1] > 0;
  if (best[0][1] < 0.25 && choice !== 'required') return { tool: null, scores };
  return { tool: best[0][0], scores, tie };
}

function extractArgs(u, tool, p) {
  const codes = (u.text.match(/\b[A-Z]{3}\b/g) || []);
  const args = {}, missing = [];
  const props = tool.parameters.properties;
  for (const k of Object.keys(props)) {
    let v;
    if (k === 'origin') v = codes[0];
    else if (k === 'destination') v = codes[1] || (u.text.match(/to ([A-Z][a-z]+)/) || [])[1];
    else if (k === 'date') v = (u.text.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    else if (k === 'flight_id' || k === 'id') {
      v = (u.text.match(/\b[A-Z]{2}\d{1,4}\b/) || [])[0];
      if (!v && u.ctx && p.tracking !== 'stateless') v = PREV_RESULTS[1];
    } else if (k === 'confirmed') v = /confirm|yes/i.test(u.text) ? true : undefined;
    else if (k === 'topic') v = /baggage/.test(u.text) ? 'baggage' : undefined;
    else if (k === 'query') v = u.text;
    if (v === undefined) missing.push(k); else args[k] = v;
  }
  const required = tool.parameters.required || [];
  return { args, missingRequired: missing.filter(k => required.includes(k)) };
}

function build(p) {
  const steps = [];
  const instr = String(p.instructions || '');
  const lc = instr.toLowerCase();
  const checks = {
    role: /you are|your role/.test(lc), goal: /goal|help|objective/.test(lc),
    clarify: /\bask\b|clarif/.test(lc), guardrail: /never|do not|don't|only .*confirm/.test(lc),
  };
  const missingI = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  steps.push(step('role', missingI.length ? 'Instructions are incomplete' : 'Role, goal and rules defined', missingI.length ? `Missing: ${missingI.join(', ')}. ${!checks.clarify ? 'Without "ask for missing details" the model tends to invent arguments. ' : ''}${!checks.guardrail ? 'Without a confirmation rule it may book without consent.' : ''}` : 'Instructions state who the agent is, what it is for, when to ask, and what it must never do.',
    { checks, length: instr.length }, missingI.length ? 'warn' : 'ok'));

  const v = validateTools(p.tools);
  if (v.errors.length) {
    steps.push(step('schema', 'Tool schema rejected', v.errors.join(' • '), { errors: v.errors }, 'error'));
    return finish(p, steps, v, [], checks);
  }
  steps.push(step('schema', `${v.tools.length} tool(s) valid`, v.warnings.length ? v.warnings.join(' • ') : 'Names, descriptions, typed parameters with descriptions, and consistent required lists.', { tools: v.tools.map(t => t.name), warnings: v.warnings }, v.warnings.length ? 'warn' : 'ok'));

  const trackDetail = { stateless: 'Each request is independent; nothing from earlier turns is sent.', client: 'Your app keeps the message list and re-sends it each turn (you own storage, trimming and cost).', thread: 'Conversation state is kept server-side (thread / conversation) in Foundry Agent Service; you send only the new message plus the id.' }[p.tracking];
  steps.push(step('tracking', `Conversation tracking: ${p.tracking}`, trackDetail, { approach: p.tracking }, p.tracking === 'stateless' ? 'warn' : 'ok'));

  const rows = [];
  for (const u of UTTERANCES) {
    const sel = selectTool(u, v.tools, p.toolChoice);
    const expected = u.expect.includes('get_travel_policy') ? (v.tools.some(t => t.name === 'get_travel_policy') ? 'get_travel_policy' : null) : u.expect;
    let outcome, status;
    const tool = v.tools.find(t => t.name === sel.tool);
    let args = {};
    if (sel.tie) { outcome = `ambiguous: ${Object.keys(sel.scores).join(' vs ')} scored the same`; status = 'warn'; }
    else if ((sel.tool || null) !== expected) {
      outcome = sel.tool ? `wrong tool (expected ${expected || 'no tool'})` : p.toolChoice === 'none' ? 'tool_choice=none: answered without tools' : `no tool chosen (expected ${expected})`;
      status = 'warn';
    } else if (tool) {
      const ex = extractArgs(u, tool, p);
      args = ex.args;
      if (ex.missingRequired.length) {
        if (u.ctx && p.tracking === 'stateless') { outcome = `cannot resolve "the second one": no conversation history (${ex.missingRequired.join(', ')} missing)`; status = 'warn'; }
        else if (checks.clarify) { outcome = `asks the user for ${ex.missingRequired.join(', ')}`; status = 'ok'; }
        else { outcome = `invents ${ex.missingRequired.join(', ')} (hallucinated arguments)`; status = 'warn'; }
      } else { outcome = 'correct call'; status = 'ok'; }
    } else { outcome = 'answers directly (no tool needed)'; status = 'ok'; }
    rows.push({ u, sel: sel.tool, args, outcome, status });
  }
  const correct = rows.filter(r => r.status === 'ok').length;
  steps.push(step('select', `Tool selection: ${correct}/${rows.length} correct`, rows.filter(r => r.status !== 'ok').map(r => `${r.u.id}: ${r.outcome}`).join(' • ') || 'Every test utterance handled as intended.',
    { tool_choice: p.toolChoice, results: rows.map(r => ({ utterance: r.u.text, tool: r.sel, outcome: r.outcome })) }, correct === rows.length ? 'ok' : 'warn'));
  const argIssues = rows.filter(r => /invents|cannot resolve/.test(r.outcome));
  steps.push(step('args', argIssues.length ? 'Argument problems' : 'Arguments well-formed', argIssues.length ? argIssues.map(r => `${r.u.id}: ${r.outcome}`).join(' • ') : 'Required arguments were present, asked for, or resolved from history.', { calls: rows.filter(r => r.sel).map(r => ({ name: r.sel, arguments: r.args })) }, argIssues.length ? 'warn' : 'ok'));
  steps.push(step('agent', 'Agent definition ready', `Model deployment + instructions + ${v.tools.length} tool(s) + ${p.tracking} tracking.`, null, 'ok'));
  return finish(p, steps, v, rows, checks);
}

function finish(p, steps, v, rows, checks) {
  const output = [];
  const err = steps.find(s => s.status === 'error');
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}: ${err.detail}` });
  if (rows.length) {
    output.push({ type: 'table', title: 'Test utterances → tool selection', columns: ['Utterance', 'Tool chosen', 'Arguments', 'Outcome'],
      rows: rows.map(r => [r.u.text, r.sel || '—', Object.keys(r.args).length ? JSON.stringify(r.args) : '—', r.outcome]), tones: rows.map(r => (r.status === 'ok' ? 'ok' : 'warn')) });
    const turns = [{ role: 'user', text: 'Find flights from SEA to LHR on 2026-11-03' }, { role: 'tool', text: `search_flights → ${PREV_RESULTS.join(', ')}`, meta: 'tool output' }, { role: 'assistant', text: `I found ${PREV_RESULTS.join(', ')}. Which one should I book?` }, { role: 'user', text: 'Book the second one, I confirm.' }];
    const u5 = rows.find(r => r.u.id === 'u5');
    turns.push({ role: 'assistant', text: u5.status === 'ok' ? `Calling book_flight(flight_id="${u5.args.flight_id}", confirmed=true)` : 'Which flight do you mean? (no earlier context available)', meta: p.tracking });
    output.push({ type: 'chat', title: `Multi-turn check (${p.tracking})`, turns });
  }
  output.push({ type: 'json', title: 'Agent definition (illustrative create_agent payload)', data: {
    model: 'gpt-4o', name: 'travel-booker', instructions: String(p.instructions || '').slice(0, 160) + (String(p.instructions || '').length > 160 ? '…' : ''),
    tools: v.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description } })), tool_choice: p.toolChoice,
    conversation: p.tracking === 'thread' ? 'thread / conversation id (server-side)' : p.tracking === 'client' ? 'client-managed message list' : 'none' } });
  const correct = rows.filter(r => r.status === 'ok').length;
  return {
    steps, output,
    metrics: [
      metric('Schema errors', String(v.errors.length), 'computed'),
      metric('Schema warnings', String(v.warnings.length), 'computed'),
      metric('Utterances handled correctly', rows.length ? `${correct}/${rows.length}` : '—', 'computed', 'Toy selector: overlap between utterance intent words and tool name + description.'),
      metric('Instruction checks', `${Object.values(checks).filter(Boolean).length}/4`, 'computed', 'role, goal, clarify, guardrail'),
    ],
    summary: err ? 'Schema rejected' : `${v.tools.length} tools, ${p.tracking}, tool_choice ${p.toolChoice}: ${correct}/${rows.length} correct`,
  };
}

const nodes = (p, L) => [
  { id: 'role', label: L.role, col: 0, row: 0, kind: 'policy', detail: 'Instructions: role, goals, when to ask clarifying questions, hard rules (e.g. never book without confirmation).' },
  { id: 'schema', label: L.schema, col: 0, row: 2, kind: 'code', detail: 'Function tools: unique name, clear description (when to use it), JSON Schema parameters with types, descriptions, enums and required fields.' },
  { id: 'tracking', label: L.tracking, col: 1, row: 1, kind: 'store', badge: p ? p.tracking : undefined, detail: 'Stateless, client-managed history, or server-side threads/conversations in Foundry Agent Service.' },
  { id: 'agent', label: L.agent, col: 2, row: 1, kind: 'ai', detail: 'The agent = model deployment + instructions + tools (+ tool_choice) + conversation approach.' },
  { id: 'select', label: L.select, col: 3, row: 0.5, kind: 'compute', badge: p ? `tool_choice=${p.toolChoice}` : undefined, detail: 'At run time the model reads tool names and descriptions to decide whether and which tool to call.' },
  { id: 'args', label: L.args, col: 3, row: 2, kind: 'data', detail: 'The model fills arguments from the conversation. Missing required values should trigger a clarifying question, not a guess.' },
];

export default {
  id: '2.2.1',
  lab: 'Agent definition builder',
  services: [
    { name: 'Foundry Agent Service overview', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview' },
    { name: 'Function calling tool for agents', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/function-calling' },
    { name: 'Threads, runs and messages', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/threads-runs-messages' },
  ],
  prereqs: ['1.1.4', '2.1.3'],
  next: ['2.2.2', '2.2.3', '1.4.4'],

  concept: {
    plain: 'Defining an agent is like writing a job description. You say who it is and what it is for, what it must never do, which tools it may use and exactly what each tool needs, and how it remembers the conversation so far. The model picks tools by reading their names and descriptions, so vague descriptions lead to wrong choices, and missing parameter details lead to made-up values.',
    technical: 'In Foundry Agent Service an agent combines a model deployment, instructions (system prompt with role, goals, constraints), tools (function tools defined by JSON Schema, plus built-in tools such as file search, Azure AI Search or code interpreter) and tool_choice (auto, required, none or a specific function). Conversation tracking can be stateless, client-managed message history, or server-side threads/conversations that persist messages and run state. Tool schemas need a valid name, a description that says when to use the tool, typed parameters with descriptions/enums, and a required list consistent with the properties.',
    useCase: 'A travel-booking agent for employees: instructions require searching before booking and explicit confirmation; search_flights, book_flight and get_travel_policy are function tools with IATA-code and date descriptions; conversations are tracked in server-side threads so "book the second one" resolves to the flight listed earlier.',
    terms: [
      ['Instructions', 'Agent system prompt: role, goals, constraints, escalation and clarification rules.'],
      ['Function tool', 'A function the agent may call, described by name, description and JSON Schema parameters.'],
      ['tool_choice', 'auto (model decides), required (must call a tool), none (no tools) or a forced function.'],
      ['Thread / conversation', 'Server-side store of messages for one conversation, referenced by id.'],
      ['Required fields', 'Parameters the model must supply; if unknown, it should ask rather than guess.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: nodes(p, { role: 'Who am I, what for, what never', schema: 'What tools, what inputs', tracking: 'How I remember', agent: 'Agent', select: 'Pick a tool', args: 'Fill arguments' }),
        edges: [['role', 'agent'], ['schema', 'agent'], ['tracking', 'agent'], ['agent', 'select'], ['select', 'args']],
      }),
      architectural: p => ({
        nodes: nodes(p, { role: 'Instructions', schema: 'Function tool definitions (JSON Schema)', tracking: p && p.tracking === 'thread' ? 'Agent Service threads / conversations' : p && p.tracking === 'client' ? 'App database (message history)' : 'No state', agent: 'Foundry Agent Service: agent (gpt-4o)', select: 'Run: model decides tool_calls', args: 'Your code executes the function' }),
        edges: [['role', 'agent'], ['schema', 'agent'], ['tracking', 'agent', 'history'], ['agent', 'select'], ['select', 'args', 'requires_action']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'role', label: 'instructions = """You are … Goal: … Ask for missing … Never …"""', col: 0, row: 0, kind: 'code', detail: 'Keep rules explicit and testable.' },
          { id: 'schema', label: 'functions = FunctionTool({search_flights, book_flight, …})  # or JSON tool definitions', col: 0, row: 1, kind: 'code', detail: 'azure-ai-agents can derive schemas from Python functions with docstrings; illustrative.' },
          { id: 'agent', label: 'agent = project.agents.create_agent(model="gpt-4o", name="travel-booker", instructions=instructions, tools=functions.definitions)', col: 0, row: 2, kind: 'code', detail: 'Illustrative; check your SDK version.' },
          { id: 'tracking', label: p && p.tracking === 'thread' ? 'thread = project.agents.threads.create()  # one per conversation' : p && p.tracking === 'client' ? 'history.append(msg); send(history)' : 'send([msg])  # no history', col: 0, row: 3, kind: 'code', detail: 'Server-side threads keep history for you.' },
          { id: 'select', label: `runs.create(thread_id, agent_id, tool_choice="${p ? p.toolChoice : 'auto'}")`, col: 0, row: 4, kind: 'code', detail: 'Run status requires_action when the model requests tool calls.' },
          { id: 'args', label: 'json.loads(tool_call.function.arguments) → validate → execute', col: 0, row: 5, kind: 'code', detail: 'Always validate arguments before executing.' },
        ],
        edges: [['role', 'agent'], ['schema', 'agent'], ['agent', 'tracking'], ['tracking', 'select'], ['select', 'args']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'instructions', label: 'Instructions (role, goals, rules)', type: 'textarea', default: GOOD_INSTRUCTIONS },
      { id: 'tools', label: 'Tool definitions (JSON)', type: 'textarea', default: DEFAULT_TOOLS },
      { id: 'tracking', label: 'Conversation tracking', type: 'select', options: [['stateless', 'Stateless (no history)'], ['client', 'Client-managed history'], ['thread', 'Server-side thread / conversation']], default: 'stateless' },
      { id: 'toolChoice', label: 'tool_choice', type: 'select', options: [['auto', 'auto'], ['required', 'required'], ['none', 'none']], default: 'auto' },
    ],
    samples: [
      { label: 'Thread-based tracking', values: { tracking: 'thread' } },
      { label: 'With a travel-policy tool', values: { tracking: 'thread', tools: WITH_POLICY } },
      { label: 'Vague tool descriptions', values: { tracking: 'thread', tools: VAGUE } },
      { label: 'Minimal instructions', values: { tracking: 'thread', instructions: 'Help with flights.' } },
      { label: 'tool_choice = required', values: { tracking: 'thread', toolChoice: 'required' } },
    ],
    run: build,
  },

  compare: {
    suggestions: [
      'Run with stateless, client-managed and thread tracking; compare the "book the second one" turn.',
      'Run the default tools and the vague tools; compare selection accuracy.',
      'Run tool_choice auto vs required on the baggage question.',
      'Remove the "Ask for missing…" sentence from the instructions and compare the Paris utterance.',
    ],
  },

  debug: [
    { id: 'malformed', title: 'Agent creation rejects the tools', values: { tools: MALFORMED, tracking: 'thread' }, node: 'schema',
      symptom: 'Schema rejected: invalid type "date" and required field "passenger" not in properties.', cause: 'Malformed JSON Schema: "date" is not a JSON Schema type and required lists an undefined property.', fix: 'Use "type": "string" with a date description/format and keep required ⊆ properties (load the default tool JSON).' },
    { id: 'json', title: 'Tool JSON does not parse', values: { tools: DEFAULT_TOOLS.slice(0, -3), tracking: 'thread' }, node: 'schema',
      symptom: 'Not valid JSON.', cause: 'Truncated / malformed JSON (missing closing brackets).', fix: 'Fix the JSON (reload the default tool definitions).' },
    { id: 'vague', title: 'Agent calls the wrong function', values: { tools: VAGUE, tracking: 'thread' }, node: 'select',
      symptom: 'Both tools score the same; selection is ambiguous.', cause: 'Descriptions like "Handles flights." do not say when to use each tool.', fix: 'Write descriptions that state what the tool does and when to call it (reload the default tools).' },
    { id: 'stateless', title: '"Book the second one" fails', values: { tracking: 'stateless' }, node: 'tracking',
      symptom: 'The agent cannot tell which flight the user means.', cause: 'No conversation tracking: earlier search results are not available.', fix: 'Use server-side threads (or client-managed history).' },
    { id: 'invent', title: 'Agent invents a departure airport', values: { tracking: 'thread', instructions: 'You are a travel assistant. Never book without confirmation.' }, node: 'args',
      symptom: '"Find me something to Paris next week" calls search_flights with a made-up origin and date.', cause: 'Instructions lack "ask for missing details" so the model fills required fields with guesses.', fix: 'Add an explicit rule to ask for missing origin, destination or date.' },
    { id: 'required', title: 'Policy question triggers a flight search', values: { tracking: 'thread', toolChoice: 'required' }, node: 'select',
      symptom: 'Baggage question forced into a tool call.', cause: 'tool_choice=required makes the model call some tool even when none fits.', fix: 'Use tool_choice=auto.' },
  ],

  challenge: {
    task: 'Define an agent that handles all five test utterances correctly and answers the baggage question through a dedicated policy tool.',
    condition: '5/5 utterances correct, get_travel_policy is chosen for the baggage question, no schema errors or warnings.',
    hint: 'Add a well-described get_travel_policy tool with an enum topic, and make sure "the second one" can be resolved.',
    check: (p, res) => !res.steps.some(s => s.status === 'error' || s.status === 'warn') && res.metrics[2].value === '5/5' && /get_travel_policy/.test(p.tools),
    solution: ['Load the "With a travel-policy tool" sample (adds get_travel_policy with an enum topic).', 'Conversation tracking: server-side thread.', 'tool_choice: auto.', 'Keep instructions with role, goal, "ask for missing…" and "never book unless confirmed". Run.'],
    solutionValues: { tools: WITH_POLICY, tracking: 'thread', toolChoice: 'auto', instructions: GOOD_INSTRUCTIONS },
  },

  quiz: [
    { q: 'Your agent has two tools, both described as "Handles orders." It often calls the wrong one. What is the best fix?', options: ['Set tool_choice=required', 'Rewrite each description to say what the tool does and when to use it', 'Use a larger model', 'Merge both tools'], answer: 1, why: 'Models select tools from names and descriptions. Clear, distinct descriptions are the primary lever.' },
    { q: 'Users say "book the second one" after a search, but the agent asks which flight they mean. Every request is sent with only the latest message. What should you change?', options: ['Add more tools', 'Track the conversation with a server-side thread/conversation (or send history)', 'Lower the temperature', 'Make flight_id optional'], answer: 1, why: 'The reference needs earlier turns. Threads keep history server-side.' },
    { q: 'Creating an agent fails because a parameter has "type": "date". What should it be?', options: ['"datetime"', '"string" with a description or format such as YYYY-MM-DD', '"object"', 'Remove the type'], answer: 1, why: 'JSON Schema has no "date" type; dates are strings with a format/description.' },
    { q: 'A required argument is unknown from the conversation. What behaviour should your instructions produce?', options: ['Guess a sensible default', 'Ask the user a clarifying question before calling the tool', 'Call the tool with null', 'Skip the tool silently'], answer: 1, why: 'Asking prevents hallucinated arguments and wrong side effects.' },
  ],

  recap: 'An agent definition is instructions (role, goals, ask-when-missing, never-do rules) + well-formed tool schemas (clear names and descriptions, typed parameters with descriptions, required ⊆ properties) + tool_choice + a conversation-tracking approach. Test it against representative utterances, including multi-turn references, before you build on it.',
};
