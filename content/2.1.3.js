// 2.1.3 Design workflows, tool-augmented flows, and multistep reasoning pipelines
// Lab: Workflow designer.
import { round, step, metric } from '../src/engine/util.js';

const REQUESTS = {
  refund: { label: 'Refund: "I was charged twice for order 1042"', category: 'refund', needs: ['get_order', 'create_refund'], goal: 'Refund the duplicate charge' },
  status: { label: 'Status: "Where is order 2210?"', category: 'status', needs: ['get_order'], goal: 'Report delivery status' },
  multi: { label: 'Multi-part: "Compare my last 3 orders, refund the damaged one, email me a summary"', category: 'multi', needs: ['list_orders', 'get_order', 'get_order', 'get_order', 'create_refund', 'send_email'], goal: 'Compare, refund, email' },
  complaint: { label: 'Complaint: "Your courier was rude, I want to speak to a manager"', category: 'complaint', needs: ['create_ticket'], goal: 'Escalate to a human' },
};

const PATTERNS = {
  single: 'Single prompt (no tools)',
  chain: 'Deterministic chain: classify → branch → tools → summarize',
  tools: 'Tool-augmented loop (model chooses tools)',
  plan: 'Plan-and-execute (planner + executor + replanner)',
};

// Which tools each fixed branch of the chain runs.
const BRANCH_TOOLS = { refund: ['get_order', 'create_refund'], status: ['get_order'], escalate: ['create_ticket'] };

function runWorkflow(p) {
  const req = REQUESTS[p.request] || REQUESTS.refund;
  const steps = [];
  const timeline = [];
  let t = 0, llmCalls = 0, tokens = 0, iterations = 0;
  const done = [];
  const llm = (label, ctx, lane = 'LLM') => { llmCalls++; const d = round(0.8 + ctx / 4000, 2); tokens += ctx; timeline.push({ label, start: round(t, 2), end: round(t + d, 2), lane, tone: 'info' }); t += d; };
  let failuresLeft = p.failure === 'timeout' ? 1 : p.failure === 'persistent' ? Infinity : 0;
  const callTool = name => {
    // Only the order API is affected by the injected failure.
    let attempts = 0;
    while (true) {
      attempts++;
      const failing = (name === 'get_order' || name === 'list_orders') && failuresLeft > 0;
      const d = failing ? 1.5 : 0.3;
      timeline.push({ label: `${name}${failing ? ' ✗' : ''}`, start: round(t, 2), end: round(t + d, 2), lane: 'Tools', tone: failing ? 'error' : 'ok' });
      t += d;
      if (!failing) return { ok: true, attempts };
      failuresLeft--;
      if (attempts > Number(p.retries)) return { ok: false, attempts };
    }
  };

  steps.push(step('input', 'Request received', req.label, { goal: req.goal, toolsNeeded: req.needs }, 'info'));

  if (p.pattern === 'single') {
    llm('answer', 900);
    steps.push(step('summarize', 'One-shot answer without tools', 'The model cannot read order data or issue refunds. It writes a plausible but unverified reply ("Your refund is on its way!") — an action it never performed.', { toolCalls: 0 }, 'warn'));
    return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
  }

  if (p.pattern === 'chain') {
    // 1. Classify
    llm('classify', 600);
    if (!p.structured && (req.category === 'multi' || req.category === 'complaint')) {
      steps.push(step('classify', 'Classifier output could not be parsed', 'Free-text classifier replied "This is mostly a refund but also a status question…" instead of one label. json.loads() fails and the chain has no route.', { raw: 'This is mostly a refund but also…', expected: '{"category": "refund|status|complaint"}' }, 'error'));
      return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
    }
    const label = req.category === 'multi' ? 'refund' : req.category;
    steps.push(step('classify', `Classified as "${label}"`, p.structured ? 'Structured output (JSON schema with an enum of categories) guarantees a parseable label.' : 'Free-text label happened to parse for this simple request.',
      { category: label, response_format: p.structured ? 'json_schema' : 'text' }, req.category === 'multi' ? 'warn' : 'ok'));
    // 2. Branch
    let branch = BRANCH_TOOLS[label] ? label : null;
    if (!branch) {
      if (!p.fallback) {
        steps.push(step('branch', `No branch for "${label}"`, 'The router has refund and status branches only and no default route. The request is dropped with an unhandled-case exception.', { routes: Object.keys(BRANCH_TOOLS).filter(b => b !== 'escalate'), category: label }, 'error'));
        return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
      }
      branch = 'escalate';
    }
    steps.push(step('branch', `Route → ${branch}`, branch === 'escalate' ? 'Default branch: hand off to a human queue.' : `Fixed branch runs: ${BRANCH_TOOLS[branch].join(', ')}.`, { branch }, 'ok'));
    // 3. Tools
    for (const name of BRANCH_TOOLS[branch]) {
      const res = callTool(name);
      if (!res.ok) {
        steps.push(step('tool', `${name} failed`, p.failure === 'persistent' ? 'Order API returns HTTP 500 on every attempt. Retries cannot fix a persistent downstream fault; the chain stops and should surface a graceful error.' : `Order API timed out and retries = ${p.retries}. A single retry would have recovered from this transient error.`, { tool: name, attempts: res.attempts, error: p.failure === 'persistent' ? 'HTTP 500' : 'timeout' }, 'error'));
        return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
      }
      done.push(name);
      steps.push(step('tool', `${name} ✓`, res.attempts > 1 ? `Succeeded on attempt ${res.attempts} (retry with backoff).` : 'Succeeded.', { tool: name, attempts: res.attempts }, res.attempts > 1 ? 'info' : 'ok'));
    }
    // 4. Summarize
    llm('summarize', 900);
    const partial = req.needs.filter(n => !done.includes(n)).length;
    steps.push(step('summarize', partial ? 'Partial result' : 'Reply composed', partial ? `The chain handled only the refund part. A fixed chain cannot decompose a multi-part request (${done.length}/${req.needs.length} required actions).` : 'Summarizer turns tool results into the customer reply.', { completed: done }, partial ? 'warn' : 'ok'));
    return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
  }

  // Tool loop or plan-and-execute
  const limit = Number(p.maxIter) || 0; // 0 = no guard
  const hardStop = 25;
  const queue = [...req.needs];
  if (p.pattern === 'plan') {
    llm('plan', 1200);
    steps.push(step('reason', 'Plan created', `Planner produced ${queue.length} step(s): ${queue.join(' → ')}.`, { plan: queue.map((s, i) => ({ step: i + 1, action: s })) }, 'ok'));
  } else {
    steps.push(step('reason', 'Agent loop started', 'Each iteration: model sees the history, picks a tool (or answers), app runs the tool and appends the result.', { tools: ['list_orders', 'get_order', 'create_refund', 'send_email', 'create_ticket'] }, 'info'));
  }
  let ctx = 1200;
  while (queue.length) {
    iterations++;
    if ((limit && iterations > limit) || iterations > hardStop) break;
    const name = queue[0];
    if (p.pattern === 'tools') { llm(`choose ${name}`, ctx); ctx += 450; } // history grows every turn
    else { t += 0.05; }
    const res = callTool(name);
    if (res.ok) {
      done.push(queue.shift());
      if (p.pattern === 'tools') ctx += 250;
    } else if (p.pattern === 'plan') {
      llm('replan', 900);
      // Replanner keeps the step, records the failure, tries again next iteration.
    }
    if (!res.ok && iterations === 1) steps.push(step('tool', `${name} failed (attempts: ${res.attempts})`, p.failure === 'persistent' ? 'Order API keeps returning HTTP 500. The model keeps re-requesting the same tool.' : 'Transient timeout with no retries; the error is fed back and the model tries again next iteration.', { error: p.failure }, 'warn'));
  }
  const stoppedByGuard = queue.length && limit && iterations > limit;
  const runaway = queue.length && iterations > hardStop;
  if (runaway) {
    steps.push(step('guard', 'Runaway loop', `No iteration limit is set. The loop kept calling a failing tool for ${hardStop}+ iterations (stopped here by the simulator), burning ~${tokens.toLocaleString()} tokens.`, { iterations, maxIterations: 'none' }, 'error'));
  } else if (stoppedByGuard) {
    steps.push(step('guard', 'Stopped by iteration limit', `Hit max ${limit} iterations with ${queue.length} action(s) left: ${queue.join(', ')}. ${p.failure === 'persistent' ? 'The guard did its job: the downstream API is broken; return a graceful "try later" message.' : 'The limit is too low for this task.'}`, { iterations: limit, remaining: queue }, 'warn'));
  } else {
    steps.push(step('tool', `Executed ${done.length} tool call(s)`, `${done.join(' → ')} in ${iterations} iteration(s).`, { calls: done }, 'ok'));
    steps.push(step('guard', 'Within limits', `${iterations} iteration(s) used${limit ? ` of ${limit}` : ' (no guard set!)'}.`, { iterations, maxIterations: limit || 'none' }, limit ? 'ok' : 'warn'));
  }
  if (!runaway) {
    llm('final answer', ctx);
    const complete = !queue.length;
    steps.push(step('summarize', complete ? 'Final answer' : 'Partial answer', complete ? `All ${req.needs.length} required action(s) completed.` : `${done.length}/${req.needs.length} actions completed; the reply must say what is still pending.`, { completed: done, pending: queue }, complete ? 'ok' : 'warn'));
  }
  return finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t);
}

function finish(p, req, steps, timeline, done, llmCalls, tokens, iterations, t) {
  const err = steps.find(s => s.status === 'error');
  const completed = req.needs.filter((n, i) => done.filter(d => d === n).length > req.needs.slice(0, i).filter(x => x === n).length).length;
  const output = [
    { type: 'flow', title: 'Executed path', items: steps.slice(1).map(s => ({ label: s.title, tone: s.status === 'error' ? 'error' : s.status === 'warn' ? 'warn' : s.status === 'ok' ? 'ok' : 'info' })) },
  ];
  if (timeline.length) output.push({ type: 'timeline', title: 'Trace (illustrative durations)', unit: 's', items: timeline });
  output.push({ type: 'table', title: 'Required actions', columns: ['Action', 'Status'], rows: req.needs.map((n, i) => [n, i < completed ? 'done' : 'not done']), tones: req.needs.map((n, i) => (i < completed ? 'ok' : 'warn')) });
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}. ${err.detail}` });
  else if (p.pattern === 'single') output.push({ type: 'alert', tone: 'warn', text: 'The reply claims actions that never happened. Anything that needs data or side effects requires tools.' });
  return {
    steps, output,
    metrics: [
      metric('Actions completed', `${completed}/${req.needs.length}`, 'computed'),
      metric('LLM calls', String(llmCalls), 'computed'),
      metric('Prompt tokens (all calls)', `~${tokens.toLocaleString()}`, 'estimate', 'Simulator assumes a fixed size per call; in the tool loop the history grows each iteration.'),
      metric('Wall time', `~${round(t, 1)} s`, 'estimate', 'Illustrative per-call durations (LLM ~1 s+, tool ~0.3 s, timeouts 1.5 s). Not measured.'),
    ],
    summary: `${PATTERNS[p.pattern]} on "${req.category}": ${err ? 'FAILED' : `${completed}/${req.needs.length} actions`}, ${llmCalls} LLM call(s)`,
  };
}

const nodes = (p, L) => [
  { id: 'input', label: L.input, col: 0, row: 1, kind: 'user', detail: 'User request entering the workflow.' },
  { id: 'classify', label: L.classify, col: 1, row: 0, kind: 'ai', disabled: p && p.pattern !== 'chain', badge: p && p.pattern === 'chain' ? (p.structured ? 'JSON schema' : 'free text') : undefined, detail: 'An LLM step that outputs one label. Use structured outputs (JSON schema with an enum) so code can branch on it.' },
  { id: 'branch', label: L.branch, col: 2, row: 0, kind: 'compute', disabled: p && p.pattern !== 'chain', badge: p && p.pattern === 'chain' ? (p.fallback ? '+ default' : 'no default') : undefined, detail: 'Deterministic routing in code. Every branch, including "none of the above", needs a route.' },
  { id: 'reason', label: L.reason, col: 1, row: 2, kind: 'ai', disabled: p && !(p.pattern === 'tools' || p.pattern === 'plan'), detail: 'Tool loop: the model decides the next tool each turn. Plan-and-execute: a planner writes the steps once, an executor runs them, a replanner reacts to failures.', substeps: ['Plan / choose tool', 'Execute', 'Observe result', 'Replan or finish'] },
  { id: 'tool', label: L.tool, col: 3, row: 1, kind: 'external', disabled: p && p.pattern === 'single', badge: p && p.failure !== 'none' ? `${p.failure}, retries ${p.retries}` : undefined, detail: 'Functions/APIs the workflow can call. Wrap with timeouts, retries with backoff for transient errors, and idempotency for side effects (refunds!).' },
  { id: 'guard', label: L.guard, col: 2, row: 2, kind: 'policy', disabled: p && !(p.pattern === 'tools' || p.pattern === 'plan'), badge: p && (p.pattern === 'tools' || p.pattern === 'plan') ? (Number(p.maxIter) ? `max ${p.maxIter}` : 'no limit') : undefined, detail: 'Max iterations / token budget / timeout so a confused or failing loop cannot run forever.' },
  { id: 'summarize', label: L.summarize, col: 4, row: 1, kind: 'ai', detail: 'Turns results into the final reply; must report partial completion honestly.' },
];

export default {
  id: '2.1.3',
  lab: 'Workflow designer',
  services: [
    { name: 'Microsoft Agent Framework workflows', url: 'https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/overview' },
    { name: 'Function calling with Azure OpenAI', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/function-calling' },
    { name: 'Structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
  ],
  prereqs: ['2.1.1'],
  next: ['2.2.1', '2.2.5', '2.3.4'],

  concept: {
    plain: 'Real requests often need more than one model call: decide what kind of request it is, look something up, take an action, then write the reply. You can wire these steps as a fixed recipe (predictable, but rigid), let the model pick tools one at a time (flexible, but needs limits), or have it write a plan first and then carry it out. Every design also needs a plan for when a tool fails.',
    technical: 'Generative workflows combine LLM steps with deterministic code. Patterns: prompt chaining with structured-output classification and code-based routing; tool-augmented loops using function calling (the model emits tool_calls, the app executes them and returns results until the model answers); and plan-and-execute pipelines with a planner, executor and replanner. Production designs add explicit default branches, retries with backoff for transient faults, idempotent side effects, iteration/token guards, and tracing of every step. Microsoft Agent Framework workflows and Foundry Agent Service provide these building blocks.',
    useCase: 'An e-commerce support assistant classifies messages: simple status questions go through a cheap fixed chain (get_order → reply), complaints route to a human queue, and multi-part requests go to a plan-and-execute pipeline that lists orders, compares them, issues one refund and emails a summary — with retries on the flaky order API and a max-iteration guard.',
    terms: [
      ['Prompt chain', 'Fixed sequence of LLM and code steps; output of one feeds the next.'],
      ['Tool call', 'Model output requesting a function with JSON arguments; your code runs it and returns the result.'],
      ['Plan-and-execute', 'A planner LLM writes steps up front; an executor runs them; a replanner adjusts on failure.'],
      ['Iteration guard', 'Upper bound on loop turns, tokens or time to stop runaway loops.'],
      ['Default branch', 'Route taken when no specific branch matches, typically human escalation.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: nodes(p, { input: 'Request', classify: 'Classify', branch: 'Branch', reason: 'Plan / choose next tool', tool: 'Call tool', guard: 'Loop guard', summarize: 'Reply' }),
        edges: [['input', 'classify'], ['classify', 'branch'], ['branch', 'tool'], ['input', 'reason'], ['reason', 'tool'], ['tool', 'reason', 'result'], ['reason', 'guard'], ['tool', 'summarize'], ['guard', 'summarize']],
      }),
      architectural: p => ({
        nodes: nodes(p, { input: 'Web chat / API', classify: 'Classifier deployment (SLM)', branch: 'Workflow router (Agent Framework / Functions)', reason: 'Reasoning deployment (gpt-4o / o-series)', tool: 'Order API, Refund API, Email (Logic Apps)', guard: 'Policy: limits + tracing (App Insights)', summarize: 'Response deployment' }),
        edges: [['input', 'classify'], ['classify', 'branch', 'label'], ['branch', 'tool'], ['input', 'reason'], ['reason', 'tool', 'tool_calls'], ['tool', 'reason', 'outputs'], ['reason', 'guard'], ['tool', 'summarize'], ['guard', 'summarize']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'input', label: 'msg = req.json["message"]', col: 0, row: 0, kind: 'code', detail: 'Entry point.' },
          { id: 'classify', label: 'label = client.chat.completions.create(..., response_format={"type":"json_schema", ...})', col: 0, row: 1, kind: 'code', disabled: p && p.pattern !== 'chain', detail: 'Enum-constrained JSON makes branching safe. Illustrative call.' },
          { id: 'branch', label: 'match label: case "refund": … case _: escalate()', col: 0, row: 2, kind: 'code', disabled: p && p.pattern !== 'chain', detail: 'Always include the default case.' },
          { id: 'reason', label: 'while resp has tool_calls: run them, append role="tool" messages', col: 0, row: 3, kind: 'code', disabled: p && !(p.pattern === 'tools' || p.pattern === 'plan'), detail: 'Standard function-calling loop.' },
          { id: 'tool', label: `@retry(stop=stop_after_attempt(${p ? Number(p.retries) + 1 : 2}), wait=wait_exponential())  def get_order(id): …`, col: 0, row: 4, kind: 'code', detail: 'Retry transient faults only (timeouts, 429, 503). Do not blindly retry non-idempotent calls.' },
          { id: 'guard', label: `if iterations >= ${p && Number(p.maxIter) ? p.maxIter : 'MAX_ITER'}: break`, col: 0, row: 5, kind: 'code', disabled: p && !(p.pattern === 'tools' || p.pattern === 'plan'), detail: 'Also cap tokens and wall time.' },
          { id: 'summarize', label: 'return compose_reply(results, pending)', col: 0, row: 6, kind: 'code', detail: 'Report pending work honestly.' },
        ],
        edges: [['input', 'classify'], ['classify', 'branch'], ['branch', 'tool'], ['input', 'reason'], ['reason', 'tool'], ['reason', 'guard'], ['guard', 'summarize'], ['tool', 'summarize']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'pattern', label: 'Workflow pattern', type: 'select', options: Object.entries(PATTERNS), default: 'chain' },
      { id: 'request', label: 'Incoming request', type: 'select', options: Object.entries(REQUESTS).map(([v, r]) => [v, r.label]), default: 'refund' },
      { id: 'structured', label: 'Classifier uses structured output (JSON schema)', type: 'toggle', default: true },
      { id: 'fallback', label: 'Router has a default (escalate) branch', type: 'toggle', default: true },
      { id: 'failure', label: 'Order API behaviour', type: 'select', options: [['none', 'Healthy'], ['timeout', 'One transient timeout'], ['persistent', 'Persistent HTTP 500']], default: 'none' },
      { id: 'retries', label: 'Retries per tool call', type: 'range', min: 0, max: 3, step: 1, default: 1 },
      { id: 'maxIter', label: 'Max loop iterations (0 = no limit)', type: 'range', min: 0, max: 12, step: 1, default: 8 },
    ],
    samples: [
      { label: 'Status question through the fixed chain', values: { request: 'status' } },
      { label: 'Multi-part request through the fixed chain', values: { request: 'multi' } },
      { label: 'Multi-part request, plan-and-execute', values: { request: 'multi', pattern: 'plan' } },
      { label: 'Multi-part request, tool loop', values: { request: 'multi', pattern: 'tools' } },
      { label: 'Single prompt pretending to refund', values: { pattern: 'single' } },
    ],
    run: runWorkflow,
  },

  compare: {
    suggestions: [
      'Run the multi-part request with the chain, the tool loop and plan-and-execute; compare actions completed, LLM calls and tokens.',
      'Set Order API to "One transient timeout" and compare retries 0 vs 1 in the chain.',
      'Set a persistent HTTP 500 in the tool loop and compare max iterations 0 vs 6.',
    ],
  },

  debug: [
    { id: 'nobranch', title: 'Complaints crash the router', values: { request: 'complaint', fallback: false, pattern: 'chain' }, node: 'branch',
      symptom: '"No branch for complaint" — request dropped.', cause: 'Missing branch: the router only knows refund and status and has no default route.', fix: 'Add a default branch that escalates to a human (turn the default branch on).' },
    { id: 'parse', title: 'Classifier output breaks json.loads', values: { request: 'multi', structured: false, pattern: 'chain' }, node: 'classify',
      symptom: 'The chain fails right after classification on mixed requests.', cause: 'Malformed data: the classifier returns prose instead of a single JSON label.', fix: 'Use structured outputs with a JSON schema enum (and handle multi-part requests with a planner).' },
    { id: 'noretry', title: 'Occasional failures on a flaky API', values: { failure: 'timeout', retries: 0, pattern: 'chain' }, node: 'tool',
      symptom: 'get_order fails about as often as the API times out.', cause: 'Transient downstream error with zero retries.', fix: 'Retry transient errors with exponential backoff (retries = 1–2).' },
    { id: 'runaway', title: 'Token bill spikes during an outage', values: { pattern: 'tools', failure: 'persistent', maxIter: 0 }, node: 'guard',
      symptom: 'The agent loop never ends while the order API is down.', cause: 'No iteration guard: the model keeps re-calling the failing tool.', fix: 'Set a max-iterations limit (e.g. 6–8) and return a graceful partial answer.' },
    { id: 'tight', title: 'Multi-part requests always end half-done', values: { pattern: 'tools', request: 'multi', maxIter: 3 }, node: 'guard',
      symptom: 'Stopped by iteration limit with actions pending.', cause: 'Guard set lower than the task needs (6 tool calls).', fix: 'Raise max iterations (≥ 7) or use plan-and-execute.' },
  ],

  challenge: {
    task: 'Fully complete the multi-part request while the order API has one transient timeout, using a bounded loop.',
    condition: 'Request = multi-part, Order API = one transient timeout, 6/6 actions done, no error steps, max iterations between 1 and 10.',
    hint: 'A fixed chain cannot decompose the request. Retries handle transient faults inside a single iteration.',
    check: (p, res) => p.request === 'multi' && p.failure === 'timeout' && Number(p.maxIter) >= 1 && Number(p.maxIter) <= 10 && !res.steps.some(s => s.status === 'error') && res.metrics[0].value === '6/6',
    solution: ['Pattern: plan-and-execute (or the tool loop).', 'Request: multi-part; Order API: one transient timeout.', 'Retries per tool call: 1, so the timeout is absorbed without spending an iteration.', 'Max iterations: 8. Run and check 6/6 actions.'],
    solutionValues: { pattern: 'plan', request: 'multi', failure: 'timeout', retries: 1, maxIter: 8, structured: true, fallback: true },
  },

  quiz: [
    { q: 'Your chain classifies tickets and then branches in code. New ticket types sometimes crash the router. What is the most robust fix?', options: ['Raise the classifier temperature', 'Constrain the classifier with a JSON schema enum and add a default branch', 'Retry the classifier until it returns a known label', 'Remove classification and use a single prompt'], answer: 1, why: 'Structured output guarantees a parseable label; a default branch handles anything unexpected.' },
    { q: 'A tool-calling agent keeps calling a failing API during an outage and token usage spikes. Which control prevents this?', options: ['Larger context window', 'Max iteration / token guard with graceful fallback', 'More retries per tool call', 'A higher max_tokens'], answer: 1, why: 'Retries do not fix persistent faults; a loop guard bounds the damage and lets you return a partial answer.' },
    { q: 'Requests like "compare my last 3 orders, refund the damaged one and email me" fail in a fixed classify→branch chain. Which design fits best?', options: ['Add more branches for every combination', 'Plan-and-execute or a tool-augmented loop', 'A bigger classifier model', 'Disable tool calls'], answer: 1, why: 'Open-ended, multi-step requests need dynamic decomposition, which planners and tool loops provide.' },
    { q: 'You add retries to all tool calls. Which tool needs extra care before retrying?', options: ['get_order', 'list_orders', 'create_refund', 'All read-only tools'], answer: 2, why: 'Side-effecting calls must be idempotent (e.g. an idempotency key) or a retry may refund twice.' },
  ],

  recap: 'Pick the simplest workflow that works: fixed chains for predictable requests (with structured classification and a default branch), tool loops or plan-and-execute for open-ended ones. Retry transient faults, keep side effects idempotent, cap iterations and tokens, trace every step, and make partial completion explicit.',
};
