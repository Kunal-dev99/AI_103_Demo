// 2.2.2 Build agents that integrate retrieval, function-calling, and conversation memory
// Lab: Helpdesk agent conversation simulator.
import { step, metric, estTokens } from '../src/engine/util.js';

const KB = {
  wifi: { id: 'KB-112', title: 'Wi-Fi drops on corporate laptops', text: 'Most drops are caused by an outdated Wi-Fi driver. Update via Company Portal > Drivers.' },
  driver: { id: 'KB-087', title: 'Updating drivers', text: 'Open Company Portal, choose Drivers, install the latest Intel Wireless package, restart.' },
};

// Scripted conversation. needs: facts the turn depends on, and where they were first said.
const TURNS = [
  { n: 1, user: "Hi, I'm Dana from Finance. My laptop LT-4471 keeps dropping Wi-Fi.", kb: 'wifi', fn: { name: 'get_device_status', args: { device_id: 'LT-4471' } }, facts: { device: 'LT-4471', name: 'Dana (Finance)' } },
  { n: 2, user: 'What does the knowledge base say about updating drivers?', kb: 'driver' },
  { n: 3, user: 'Tried it, still broken.' },
  { n: 4, user: 'OK, please open a ticket.', needs: ['device'], fn: { name: 'create_ticket', args: { device_id: '{device}', summary: 'Wi-Fi drops after driver update', priority: 'normal' } }, facts: { ticket: 'INC-20931' } },
  { n: 5, user: 'Make it high priority, I have month-end close tomorrow.', needs: ['ticket'], fn: { name: 'update_ticket', args: { ticket_id: '{ticket}', priority: 'high' } } },
  { n: 6, user: 'Any update on my ticket?', needs: ['ticket'], fn: { name: 'get_ticket', args: { ticket_id: '{ticket}' } }, newSessionCandidate: true },
];
// The message index (in the thread) where each fact first appears: T1 user = 0, T4 assistant = 7.
const FACT_SOURCE = { device: 0, ticket: 7, name: 0 };
const WINDOWS = { all: Infinity, auto: Infinity, last_4: 4, last_2: 2 };

function simulate(p) {
  const steps = [];
  const turns = [];
  const grid = [];
  const nTurns = Math.max(1, Math.min(6, Number(p.turns) || 6));
  const memory = {};
  let thread = []; // message labels in the current thread
  let threadNo = 1;
  let tokens = 0, toolCalls = 0, correct = 0;
  const lost = new Set();

  steps.push(step('thread', 'Thread created', `Agent "helpdesk" with ${p.retrieval === 'none' ? 'no knowledge tool' : p.retrieval === 'file' ? 'file search (vector store)' : 'Azure AI Search tool'}${p.functions ? ' + 3 function tools' : ''}. Truncation: ${p.truncation}.`, { thread_id: 'thread_1', truncation_strategy: p.truncation === 'auto' ? { type: 'auto' } : p.truncation === 'all' ? null : { type: 'last_messages', last_messages: WINDOWS[p.truncation] } }, 'info'));

  for (const t of TURNS.slice(0, nTurns)) {
    if (t.newSessionCandidate && p.newSession) {
      thread = []; threadNo++;
      steps.push(step('thread', 'Next day: new thread', 'The user returns in a new session. A new thread starts empty; only long-term memory (if any) carries over.', { thread_id: `thread_${threadNo}`, longTermMemory: p.longTerm ? memory : 'disabled' }, 'info'));
      turns.push({ role: 'system', text: '— next day, new session —' });
    }
    thread.push(`T${t.n}u`);
    // What the model sees this run: window over thread + long-term memory.
    const w = WINDOWS[p.truncation] ?? Infinity;
    const visible = thread.slice(Math.max(0, thread.length - w));
    const visibleIdx = new Set(visible.map(l => (l.startsWith(`T`) ? l : '')));
    grid.push({ turn: t.n, thread: [...thread], visible: new Set(visible), threadNo });
    turns.push({ role: 'user', text: t.user, meta: `turn ${t.n}` });
    tokens += estTokens(visible.join(' ')) * 60 + (p.longTerm ? 40 : 0);

    // Resolve needed facts
    const resolve = f => {
      const srcIdx = FACT_SOURCE[f];
      const srcLabel = srcIdx % 2 === 0 ? `T${srcIdx / 2 + 1}u` : `T${(srcIdx - 1) / 2 + 1}a`;
      if (visibleIdx.has(srcLabel)) return { value: TURNS.find(x => x.facts && x.facts[f]).facts[f], via: 'thread' };
      if (p.longTerm && memory[f]) return { value: memory[f], via: 'memory' };
      return null;
    };
    const missing = (t.needs || []).filter(f => !resolve(f) || (f === 'ticket' && !memory.__ticketCreated));
    const turnSteps = [];
    let ok = true;
    let answer = '';

    // Retrieval
    if (t.kb) {
      if (p.retrieval === 'none') {
        turnSteps.push(step('retrieval', `T${t.n}: no knowledge tool`, 'The agent answers from general model knowledge; nothing cites the company KB.', null, 'warn'));
        answer += 'Generally, try restarting your router or forgetting the network. ';
        ok = false;
      } else if (p.retrieval === 'search_noaccess') {
        turnSteps.push(step('retrieval', `T${t.n}: knowledge search forbidden`, 'The Azure AI Search tool call failed with 403: the identity used by the project connection lacks "Search Index Data Reader" on the index.', { tool: 'azure_ai_search', status: 'failed', error: 'Forbidden' }, 'error'));
        answer += 'I could not reach the knowledge base right now. ';
        ok = false;
      } else {
        const a = KB[t.kb];
        turnSteps.push(step('retrieval', `T${t.n}: retrieved ${a.id}`, `${p.retrieval === 'file' ? 'file_search over the vector store' : 'azure_ai_search over the KB index'} returned "${a.title}".`, { run_step: { type: 'tool_calls', tool: p.retrieval === 'file' ? 'file_search' : 'azure_ai_search', citation: a.id } }));
        answer += `${a.text} [${a.id}] `;
      }
    }

    // Function calling
    if (t.fn) {
      if (!p.functions) {
        turnSteps.push(step('function', `T${t.n}: no function tools`, `The agent cannot call ${t.fn.name}; it can only describe what you should do.`, null, 'warn'));
        answer += t.fn.name === 'get_device_status' ? 'I can\'t check your device from here. ' : 'Please open a ticket in the IT portal yourself. ';
        ok = false;
      } else if (missing.length) {
        const why = missing.map(f => (f === 'ticket' && !memory.__ticketCreated ? 'no ticket was created earlier in this conversation' : p.truncation !== 'all' && p.truncation !== 'auto' && !(t.newSessionCandidate && p.newSession) ? `${f} was said ${f === 'device' ? 'in turn 1' : 'in turn 4'} and has been truncated out of the window` : `${f} is not in this new thread`)).join('; ');
        turnSteps.push(step('memory', `T${t.n}: lost context`, `Needed ${missing.join(', ')} for ${t.fn.name}, but ${why}${p.longTerm ? '' : ' and there is no long-term memory'}. The agent has to ask again (or worse, guess).`, { needed: missing, visibleMessages: visible }, 'warn'));
        missing.forEach(m => lost.add(m));
        answer += `Sorry, what is your ${missing[0] === 'device' ? 'device ID' : 'ticket number'}? `;
        ok = false;
      } else {
        const args = JSON.parse(JSON.stringify(t.fn.args).replace('{device}', (resolve('device') || {}).value || '').replace('{ticket}', (resolve('ticket') || {}).value || ''));
        const via = (t.needs || []).map(f => `${f} from ${resolve(f).via}`).join(', ');
        toolCalls++;
        if (p.submit === 'forget') {
          turnSteps.push(step('run', `T${t.n}: run stuck in requires_action`, `The run requested ${t.fn.name}(${JSON.stringify(args)}) but the app never called submit_tool_outputs. The run waits, then expires; no reply is produced.`, { run: { status: 'requires_action', required_action: { type: 'submit_tool_outputs', tool_calls: [{ id: 'call_1', function: { name: t.fn.name, arguments: JSON.stringify(args) } }] } } }, 'error'));
          turns.push({ role: 'assistant', text: '(no reply — run expired)', meta: 'expired' });
          steps.push(...turnSteps);
          break;
        }
        let output;
        if (t.fn.name === 'get_device_status' && p.deviceApi === 'forbidden') {
          output = { error: '403 Forbidden: the function\'s app registration lacks permission to read managed devices' };
          turnSteps.push(step('function', `T${t.n}: ${t.fn.name} returned an error`, 'Your function ran, but its downstream device-management API refused the call. The error is submitted as the tool output, and the agent tells the user it could not check the device.', { tool_output: output }, 'warn'));
          answer += 'I could not read your device status (permission error on our side). ';
          ok = false;
        } else {
          output = t.fn.name === 'get_device_status' ? { device_id: args.device_id, wifi_driver: '22.40 (outdated)', last_seen: 'today' }
            : t.fn.name === 'create_ticket' ? { ticket_id: 'INC-20931', status: 'new' }
              : t.fn.name === 'update_ticket' ? { ticket_id: args.ticket_id, priority: 'high' } : { ticket_id: args.ticket_id, status: 'assigned', engineer: 'Sam' };
          turnSteps.push(step('function', `T${t.n}: ${t.fn.name} ✓`, `requires_action → app ran ${t.fn.name}(${JSON.stringify(args)})${via ? ` [${via}]` : ''} → submit_tool_outputs → run continues.`, { tool_call: { name: t.fn.name, arguments: args }, tool_output: output }));
          if (t.fn.name === 'create_ticket') memory.__ticketCreated = true;
          answer += t.fn.name === 'get_device_status' ? `Your Wi-Fi driver is outdated (22.40). ` : t.fn.name === 'create_ticket' ? `Ticket ${output.ticket_id} created for ${args.device_id}. ` : t.fn.name === 'update_ticket' ? `${args.ticket_id} is now high priority. ` : `${args.ticket_id} is assigned to Sam. `;
        }
        turns.push({ role: 'tool', text: `${t.fn.name} → ${JSON.stringify(output)}`, meta: 'tool output' });
      }
    }
    if (!t.kb && !t.fn) answer = 'Sorry to hear that. If the driver update did not help, I can open a ticket for you.';

    // Long-term memory write
    if (p.longTerm && t.facts) {
      for (const [k, v] of Object.entries(t.facts)) if (k !== 'ticket' || memory.__ticketCreated) memory[k] = v;
      turnSteps.push(step('memory', `T${t.n}: memory updated`, `Stored ${Object.keys(t.facts).filter(k => memory[k]).join(', ')} for this user.`, { memory: Object.fromEntries(Object.entries(memory).filter(([k]) => !k.startsWith('__'))) }, 'info'));
    }
    thread.push(`T${t.n}a`);
    turns.push({ role: 'assistant', text: answer.trim(), meta: ok ? `turn ${t.n} ✓` : `turn ${t.n} ✗` });
    if (ok) correct++;
    turnSteps.push(step('answer', `T${t.n}: ${ok ? 'resolved' : 'not fully resolved'}`, answer.trim(), { messagesInWindow: visible.length, messagesInThread: thread.length }, ok ? 'ok' : 'warn'));
    steps.push(...turnSteps);
    if (turnSteps.some(s => s.status === 'error')) break;
  }

  const err = steps.find(s => s.status === 'error');
  const cols = 12;
  const cells = [];
  for (const g of grid) {
    for (let i = 0; i < cols; i++) {
      const lab = g.thread[i];
      cells.push(lab ? { label: lab, v: g.visible.has(lab) ? 1 : 0, tone: g.visible.has(lab) ? 'ok' : 'muted' } : { label: '', tone: '' });
    }
  }
  const output = [
    { type: 'chat', title: 'Conversation', turns },
    { type: 'grid', title: 'Context window per turn (rows = turns, cells = thread messages)', cols, cells, caption: 'Green: sent to the model this turn. Grey: still stored in the thread but truncated out of the window. A new thread starts a new row from the left.' },
  ];
  if (p.longTerm) output.push({ type: 'kv', title: 'Long-term memory (end of conversation)', items: Object.entries(memory).filter(([k]) => !k.startsWith('__')) });
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}. ${err.detail}` });
  else if (lost.size) output.push({ type: 'alert', tone: 'warn', text: `The agent forgot: ${[...lost].join(', ')}. Widen the window, use auto truncation, or add long-term memory for facts that must survive.` });
  const played = turns.filter(x => x.role === 'assistant').length;
  return {
    steps, output,
    metrics: [
      metric('Turns resolved', `${correct}/${nTurns}`, 'computed'),
      metric('Facts forgotten', lost.size ? [...lost].join(', ') : 'none', 'computed'),
      metric('Function calls', String(toolCalls), 'computed'),
      metric('Context tokens (all turns)', `~${tokens.toLocaleString()}`, 'estimate', 'Assumes ~60 tokens per message sent; real threads also include instructions, tool definitions and retrieved chunks.'),
    ],
    summary: err ? `Failed: ${err.title}` : `${p.truncation}${p.longTerm ? ' + memory' : ''}${p.newSession ? ', new session' : ''}: ${correct}/${nTurns} turns, ${played} replies, forgot ${lost.size ? [...lost].join('/') : 'nothing'}`,
  };
}

const nodes = (p, L) => [
  { id: 'thread', label: L.thread, col: 0, row: 1, kind: 'store', badge: p ? p.truncation : undefined, detail: 'Thread/conversation: the stored message history. Truncation decides how much of it each run sends to the model.' },
  { id: 'run', label: L.run, col: 1, row: 1, kind: 'compute', detail: 'A run executes the agent on the thread: queued → in_progress → requires_action (function calls) → completed / failed / expired.', substeps: ['Model turn', 'Tool calls (run steps)', 'requires_action → submit_tool_outputs', 'Message created'] },
  { id: 'retrieval', label: L.retrieval, col: 2, row: 0, kind: 'store', disabled: p && p.retrieval === 'none', badge: p ? p.retrieval : undefined, detail: 'Knowledge tool executed by the service (file search over a vector store, or Azure AI Search via a project connection). Results carry citations.' },
  { id: 'function', label: L.function, col: 2, row: 2, kind: 'external', disabled: p && !p.functions, detail: 'Function tools run in YOUR code: the run pauses with requires_action, you execute and submit outputs (errors included).' },
  { id: 'memory', label: L.memory, col: 3, row: 2, kind: 'data', badge: p ? (p.longTerm ? 'long-term on' : 'thread only') : undefined, detail: 'Short-term memory = messages in the window. Long-term memory = extracted facts stored outside the thread (Foundry agent memory or your own store) and injected in later sessions.' },
  { id: 'answer', label: L.answer, col: 4, row: 1, kind: 'ai', detail: 'Assistant message appended to the thread, with citations and tool results.' },
];

export default {
  id: '2.2.2',
  lab: 'Helpdesk agent conversation simulator',
  services: [
    { name: 'Threads, runs and messages in Foundry Agent Service', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/threads-runs-messages' },
    { name: 'Function calling for agents', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/function-calling' },
    { name: 'File search and Azure AI Search tools', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/azure-ai-search' },
  ],
  prereqs: ['2.2.1', '2.1.2'],
  next: ['2.2.3', '2.2.6', '1.1.4'],

  concept: {
    plain: 'A useful assistant does three things at once: looks things up in your documents, takes actions through your systems (check a device, open a ticket), and remembers what you already told it. Memory has limits: only part of a long chat is sent to the model each time, and a new chat starts empty unless important facts are saved separately.',
    technical: 'In Foundry Agent Service a run executes an agent against a thread (conversation). Knowledge tools (file_search, Azure AI Search) run inside the service and return citations. Function tools pause the run with status requires_action; the app executes the functions and calls submit_tool_outputs (including error payloads) so the run can continue. Each run sends a window of thread messages to the model, controlled by a truncation strategy (auto or last_messages). Facts that must survive truncation or new sessions belong in long-term memory: Foundry agent memory (preview) or your own store (e.g. Cosmos DB) injected into instructions or messages.',
    useCase: 'An IT helpdesk agent in Teams searches the KB (Azure AI Search tool), checks the user\'s laptop through a get_device_status function backed by device management APIs, opens and updates tickets, and remembers the user\'s device and open ticket number across days so "any update on my ticket?" works the next morning.',
    terms: [
      ['Run', 'One execution of an agent on a thread; may include several tool-call steps.'],
      ['requires_action', 'Run status meaning the model wants your function outputs before it can continue.'],
      ['submit_tool_outputs', 'Call that returns function results (or errors) to a waiting run.'],
      ['Truncation strategy', 'How many thread messages each run sends: auto or last_messages N.'],
      ['Long-term memory', 'Facts persisted outside the thread and reused across sessions.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: nodes(p, { thread: 'Conversation so far', run: 'Agent thinks', retrieval: 'Look it up (KB)', function: 'Do something (your API)', memory: 'Remember facts', answer: 'Reply' }),
        edges: [['thread', 'run', 'window'], ['run', 'retrieval'], ['run', 'function'], ['memory', 'run'], ['retrieval', 'answer'], ['function', 'answer'], ['answer', 'memory']],
      }),
      architectural: p => ({
        nodes: nodes(p, { thread: 'Agent Service thread', run: 'Agent run (gpt-4o)', retrieval: p && p.retrieval === 'file' ? 'Vector store (file search)' : 'Azure AI Search index (connection)', function: 'Azure Functions → device mgmt / ticketing APIs', memory: p && p.longTerm ? 'Long-term memory store' : 'No long-term store', answer: 'Teams bot' }),
        edges: [['thread', 'run'], ['run', 'retrieval', 'tool call'], ['run', 'function', 'requires_action'], ['memory', 'run', 'inject facts'], ['retrieval', 'answer'], ['function', 'answer', 'tool outputs'], ['answer', 'memory']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'thread', label: 'project.agents.messages.create(thread_id, role="user", content=text)', col: 0, row: 0, kind: 'code', detail: 'Append the user message to the thread. Illustrative names.' },
          { id: 'run', label: `run = project.agents.runs.create(thread_id, agent_id${p && p.truncation.startsWith('last') ? `, truncation_strategy={"type":"last_messages","last_messages":${WINDOWS[p.truncation]}}` : ''})`, col: 0, row: 1, kind: 'code', detail: 'Poll the run status (or use create_and_process / streaming).' },
          { id: 'function', label: 'if run.status == "requires_action": outputs = [run_fn(c) for c in calls]', col: 0, row: 2, kind: 'code', disabled: p && !p.functions, detail: 'Execute requested functions; catch exceptions and return them as output text.' },
          { id: 'retrieval', label: p && p.retrieval === 'file' ? 'FileSearchTool(vector_store_ids=[vs.id])' : 'AzureAISearchTool(index_connection_id=conn.id, index_name="it-kb")', col: 0, row: 3, kind: 'code', disabled: p && p.retrieval === 'none', detail: 'Knowledge tool configured on the agent; runs inside the service.' },
          { id: 'answer', label: p && p.submit === 'forget' ? '# BUG: submit_tool_outputs never called' : 'project.agents.runs.submit_tool_outputs(thread_id, run.id, tool_outputs=outputs)', col: 0, row: 4, kind: 'code', detail: 'Without this the run waits and eventually expires.' },
          { id: 'memory', label: p && p.longTerm ? 'memory.upsert(user_id, extract_facts(messages))' : '# no long-term memory', col: 0, row: 5, kind: 'code', detail: 'Persist durable facts (device id, open ticket) per user.' },
        ],
        edges: [['thread', 'run'], ['run', 'function'], ['run', 'retrieval'], ['function', 'answer'], ['answer', 'memory']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'turns', label: 'Turns to play', type: 'range', min: 1, max: 6, step: 1, default: 6 },
      { id: 'retrieval', label: 'Knowledge tool', type: 'select', options: [['search', 'Azure AI Search tool (connection)'], ['file', 'File search (vector store)'], ['search_noaccess', 'Azure AI Search, identity lacks Search Index Data Reader'], ['none', 'None']], default: 'search' },
      { id: 'functions', label: 'Function tools (device status, tickets)', type: 'toggle', default: true },
      { id: 'submit', label: 'App submits tool outputs', type: 'select', options: [['submit', 'Yes (submit_tool_outputs)'], ['forget', 'No (bug)']], default: 'submit' },
      { id: 'deviceApi', label: 'Device-management API behind get_device_status', type: 'select', options: [['ok', 'Healthy'], ['forbidden', '403: app lacks permission']], default: 'ok' },
      { id: 'truncation', label: 'Truncation strategy', type: 'select', options: [['auto', 'auto'], ['all', 'none (send everything)'], ['last_4', 'last_messages = 4'], ['last_2', 'last_messages = 2']], default: 'auto' },
      { id: 'newSession', label: 'Turn 6 happens next day in a new thread', type: 'toggle', default: true },
      { id: 'longTerm', label: 'Long-term memory store', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Same thread all the way', values: { newSession: false } },
      { label: 'Tight window (last 2 messages)', values: { truncation: 'last_2', newSession: false } },
      { label: 'Long-term memory on', values: { longTerm: true } },
      { label: 'File search instead of AI Search', values: { retrieval: 'file', newSession: false } },
      { label: 'No tools at all', values: { retrieval: 'none', functions: false, newSession: false } },
    ],
    run: simulate,
  },

  compare: {
    suggestions: [
      'Run with truncation auto, last_4 and last_2 (same thread) and compare which facts are forgotten.',
      'Run with the new-session toggle on, with long-term memory off then on.',
      'Compare context tokens for "none (send everything)" vs last_4 + long-term memory.',
    ],
  },

  debug: [
    { id: 'expired', title: 'Agent never answers after the first message', values: { submit: 'forget' }, node: 'run',
      symptom: 'Run stays in requires_action, then expires; no assistant message.', cause: 'The app never calls submit_tool_outputs for the requested function call.', fix: 'Handle requires_action: execute the functions and submit their outputs.' },
    { id: 'window', title: 'Agent asks for the device ID again', values: { truncation: 'last_2', newSession: false }, node: 'memory',
      symptom: 'In turn 4 the agent asks "what is your device ID?" although the user said it in turn 1.', cause: 'last_messages=2 truncates turn 1 out of the context window.', fix: 'Use auto truncation, a wider window, or long-term memory for key facts.' },
    { id: 'session', title: '"Any update on my ticket?" fails next day', values: { newSession: true, longTerm: false }, node: 'memory',
      symptom: 'Agent asks for the ticket number in the new session.', cause: 'A new thread starts empty; nothing persisted the ticket id.', fix: 'Enable long-term memory (or reuse the thread for the same user).' },
    { id: 'searchrbac', title: 'KB answers fail with "could not reach the knowledge base"', values: { retrieval: 'search_noaccess', newSession: false }, node: 'retrieval',
      symptom: 'azure_ai_search tool call fails with 403.', cause: 'The identity behind the project connection lacks Search Index Data Reader on the index.', fix: 'Grant the role (select the working Azure AI Search option).' },
    { id: 'device403', title: 'Device check always "permission error"', values: { deviceApi: 'forbidden', newSession: false }, node: 'function',
      symptom: 'get_device_status returns 403; agent apologises.', cause: 'Downstream permission problem in your function\'s backend, not in the agent.', fix: 'Grant the function\'s identity the device-read permission (set the API to Healthy). Keep returning errors as tool outputs so the agent can explain.' },
    { id: 'notools', title: 'Generic answers and no tickets', values: { retrieval: 'none', functions: false, newSession: false }, node: 'retrieval',
      symptom: 'Advice about home routers; tickets never created.', cause: 'No knowledge or function tools on the agent.', fix: 'Add a knowledge tool and the function tools.' },
  ],

  challenge: {
    task: 'Keep context small (last_messages = 4) yet resolve all six turns, including the next-day question in a new thread.',
    condition: 'Truncation last_4, new-session toggle on, 6/6 turns resolved, no errors.',
    hint: 'The device ID from turn 1 and the ticket from turn 4 must survive both truncation and a new thread.',
    check: (p, res) => p.truncation === 'last_4' && p.newSession && Number(p.turns) === 6 && res.metrics[0].value === '6/6' && !res.steps.some(s => s.status === 'error'),
    solution: ['Truncation: last_messages = 4; keep 6 turns and the new-session toggle on.', 'Turn on long-term memory so the device ID and ticket ID are stored as facts.', 'Keep Azure AI Search (with access) and function tools on; submit tool outputs; device API healthy.', 'Run: memory supplies the device in turn 4 and the ticket in turn 6.'],
    solutionValues: { truncation: 'last_4', newSession: true, longTerm: true, turns: 6, retrieval: 'search', functions: true, submit: 'submit', deviceApi: 'ok' },
  },

  quiz: [
    { q: 'An agent run stays in "requires_action" and later expires. What is missing in the app?', options: ['A larger model', 'Executing the requested functions and calling submit_tool_outputs', 'A vector store', 'A new thread per message'], answer: 1, why: 'Function tools run in your code; the run waits for your outputs.' },
    { q: 'With truncation last_messages=2, the agent forgets the device ID given at the start of the chat. Which change keeps costs low and the fact available?', options: ['Send the entire history every turn forever', 'Store key facts in long-term memory and inject them', 'Disable truncation and tools', 'Start a new thread per turn'], answer: 1, why: 'Long-term memory keeps durable facts without resending the whole conversation.' },
    { q: 'A user returns the next day in a new session and asks about "my ticket". What enables the agent to answer without asking again?', options: ['A bigger context window', 'Long-term memory (or reusing the user\'s thread)', 'tool_choice=required', 'A higher temperature'], answer: 1, why: 'A new thread starts empty; facts must be persisted outside it.' },
    { q: 'Your get_device_status function gets a 403 from its backend. What should it return to the agent?', options: ['Nothing; let the run time out', 'An error payload as the tool output so the agent can explain', 'A fake healthy status', 'Raise an exception that crashes the app'], answer: 1, why: 'Submitting the error lets the run complete and the agent respond honestly.' },
  ],

  recap: 'A capable agent combines knowledge tools (with citations), function tools (requires_action → run → submit_tool_outputs, errors included) and memory: a thread for the current conversation, a truncation strategy that bounds cost, and long-term memory for facts that must survive truncation and new sessions.',
};
