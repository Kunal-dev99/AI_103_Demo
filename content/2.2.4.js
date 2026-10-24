// 2.2.4 Implement orchestrated multi-agent solutions
// Lab: Multi-agent orchestrator.
import { step, metric } from '../src/engine/util.js';
const fmt = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const AGENTS = {
  billing: { label: 'Billing agent', desc: 'Refunds, invoices, charges.' },
  logistics: { label: 'Logistics agent', desc: 'Shipping, returns, delivery addresses.' },
  research: { label: 'Research agent', desc: 'Gathers facts from search and web sources.' },
  writer: { label: 'Writer agent', desc: 'Drafts customer-facing text.' },
  reviewer: { label: 'Compliance reviewer', desc: 'Checks drafts against policy and legal rules; approves or requests changes.' },
};

const PATTERNS = {
  sequential: { label: 'Sequential (pipeline)', fit: { refund: 2, launch: 5, supplier: 2 } },
  concurrent: { label: 'Concurrent (fan-out / fan-in)', fit: { refund: 1, launch: 2, supplier: 5 } },
  handoff: { label: 'Handoff (triage routes control)', fit: { refund: 5, launch: 2, supplier: 1 } },
  groupchat: { label: 'Group chat (manager picks speaker)', fit: { refund: 2, launch: 4, supplier: 3 } },
  magentic: { label: 'Magentic (planner + task ledger)', fit: { refund: 2, launch: 3, supplier: 3 } },
  connected: { label: 'Connected agents (agent-as-tool)', fit: { refund: 4, launch: 3, supplier: 4 } },
};

const TASKS = {
  refund: { label: 'Customer: "My laptop arrived damaged. Refund me and send the replacement to my new address."', needs: ['billing', 'logistics'] },
  launch: { label: 'Marketing: "Write a launch brief for the new headset, checked by compliance."', needs: ['research', 'writer', 'reviewer'] },
  supplier: { label: 'Procurement: "Independent risk assessments of supplier Adatum (finance, market, legal)."', needs: ['research', 'billing', 'reviewer'] },
};

const OUT = {
  refund: { billing: 'Refund of €899 approved for order 4417 (damaged on arrival).', logistics: 'Replacement shipped to 12 Harbour Rd, Leeds; return label emailed.' },
  launch: { research: 'Key facts: 30h battery, ANC, ships 3 Nov, price TBC.', writer: 'Draft brief: "Meet the Contoso H2: 30 hours of quiet."', reviewer: 'Approved after removing the unverified "best in class" claim.' },
  supplier: { research: 'Market view: stable demand; recommend APPROVE.', billing: 'Finance view: two late filings; recommend REJECT pending audit.', reviewer: 'Legal view: contract terms acceptable; APPROVE with indemnity clause.' },
};

function orchestrate(p) {
  const task = TASKS[p.task] || TASKS.refund;
  const pat = PATTERNS[p.pattern] || PATTERNS.handoff;
  const steps = [];
  const turns = [{ role: 'user', text: task.label }];
  const avail = Object.keys(AGENTS).filter(k => p['a_' + k]);
  const missing = task.needs.filter(k => !avail.includes(k));
  const msgs = []; // { from, to, text, tokens }
  let ctx = 350; // tokens of initial context (instructions + request)
  let totalTokens = 0;
  const send = (from, to, text, own = 220) => {
    // full = every agent receives the whole transcript so far; summary = a bounded hand-over note
    const inTok = p.contextPolicy === 'full' ? ctx : Math.min(ctx, 600);
    ctx += own;
    totalTokens += inTok + own;
    msgs.push({ from, to, text, inTok });
  };

  steps.push(step('orchestrator', `Orchestration: ${pat.label}`, `${avail.length} specialist(s) registered: ${avail.map(k => AGENTS[k].label).join(', ') || 'none'}. Max rounds ${p.maxRounds}.`, { pattern: p.pattern, specialists: avail, maxRounds: p.maxRounds, contextPolicy: p.contextPolicy }, 'info'));

  if (missing.length) {
    const status = ['handoff', 'connected', 'sequential'].includes(p.pattern) ? 'error' : 'warn';
    steps.push(step('specialists', `Missing specialist: ${missing.map(k => AGENTS[k].label).join(', ')}`, p.pattern === 'handoff' ? 'Triage tries to hand off to an agent that is not in the handoff graph; the orchestration cannot route the sub-task.' : p.pattern === 'connected' ? 'The orchestrator agent has no connected-agent tool for this capability, so it either refuses or improvises an answer itself.' : 'Part of the task has no owner; the orchestration produces an incomplete result.', { required: task.needs, registered: avail, missing }, status));
    if (status === 'error') return finish(p, task, steps, turns, msgs, totalTokens, { resolved: false });
  }

  const present = task.needs.filter(k => avail.includes(k));
  let resolved = true, conflict = false, loop = false;

  if (p.pattern === 'sequential') {
    let prev = 'orchestrator';
    present.forEach(k => { send(prev, k, `Input from ${prev}`); turns.push({ role: `agent:${k}`, text: OUT[p.task][k] }); prev = k; });
    steps.push(step('specialists', 'Agents ran in fixed order', `${present.map(k => AGENTS[k].label).join(' → ')}. Each step receives the previous output.`, { order: present }, 'ok'));
    if (p.task === 'supplier') { conflict = true; steps.push(step('aggregate', 'Later agents overwrote earlier opinions', 'Sequential chaining is a poor fit for independent assessments: each assessor sees and is biased by the previous one, and the last opinion wins.', { lastWriter: present.at(-1) }, 'warn')); }
  } else if (p.pattern === 'concurrent') {
    present.forEach(k => { send('orchestrator', k, 'Same input to all'); turns.push({ role: `agent:${k}`, text: OUT[p.task][k] }); });
    steps.push(step('specialists', `Fan-out to ${present.length} agents in parallel`, 'All agents receive the same input and work independently; wall-clock time ≈ the slowest agent.', { parallel: present }, 'ok'));
    if (p.task === 'refund' || p.task === 'launch') { steps.push(step('aggregate', 'Dependent steps ran in parallel', p.task === 'launch' ? 'The writer drafted before research finished and the reviewer reviewed nothing. Concurrency suits independent sub-tasks, not dependent ones.' : 'Refund and shipping ran in parallel, which is fine, but nobody told the customer one consistent answer.', null, 'warn')); resolved = p.task === 'refund'; }
    if (p.task === 'supplier') {
      if (p.aggregator === 'merge') { send('aggregator', 'orchestrator', 'Merged recommendation'); steps.push(step('aggregate', 'Aggregator reconciled opinions', 'Two APPROVE, one REJECT with a concrete finding. Aggregated: CONDITIONAL APPROVE pending finance audit, with every dissent recorded.', { votes: { approve: 2, reject: 1 }, decision: 'conditional approve' }, 'ok')); turns.push({ role: 'agent:aggregator', text: 'Conditional approve: finance audit required before signing; add indemnity clause.' }); }
      else { conflict = true; steps.push(step('aggregate', 'Conflicting outputs returned unmerged', 'Market and legal say APPROVE, finance says REJECT. With no aggregator the caller receives three contradictory answers.', { votes: { approve: 2, reject: 1 } }, 'warn')); }
    }
  } else if (p.pattern === 'handoff') {
    let cur = 'triage';
    send('user', 'triage', task.label);
    if (p.handoffRule === 'ambiguous' && p.task === 'refund') {
      // overlapping descriptions -> billing and logistics bounce the case
      let i = 0;
      while (i < p.maxRounds) { const nxt = i % 2 === 0 ? 'billing' : 'logistics'; send(cur, nxt, 'handoff'); turns.push({ role: `agent:${nxt}`, text: nxt === 'billing' ? 'This involves a return, handing to logistics.' : 'This involves a refund, handing to billing.' }); cur = nxt; i++; }
      loop = true; resolved = false;
      steps.push(step('specialists', `Handoff loop: ${p.maxRounds} handoffs, no progress`, 'Both agents\' handoff descriptions claim "refunds and returns", so each decides the other owns the case. The run stops at max rounds without an answer.', { handoffs: msgs.slice(1).map(m => `${m.from}→${m.to}`) }, 'error'));
    } else {
      present.forEach(k => { send(cur, k, 'handoff'); turns.push({ role: `agent:${k}`, text: OUT[p.task][k] }); send(k, 'triage', 'return to triage'); });
      steps.push(step('specialists', 'Triage handed off to each owner, control returned after each', `Handoff path: triage → ${present.join(' → triage → ')} → triage.`, { handoffs: msgs.map(m => `${m.from}→${m.to}`) }, p.task === 'refund' ? 'ok' : 'warn'));
      if (p.task !== 'refund') { resolved = p.task === 'launch'; steps.push(step('aggregate', 'Handoff is a weak fit here', p.task === 'supplier' ? 'Handoff passes control to one agent at a time; independent opinions are not compared or merged.' : 'Works, but the review loop (writer ↔ reviewer) is awkward with one owner at a time.', null, 'warn')); if (p.task === 'supplier') conflict = true; }
    }
  } else if (p.pattern === 'groupchat' || p.pattern === 'magentic') {
    const rounds = p.pattern === 'magentic' ? 2 + present.length * 2 : 1 + present.length * 2;
    if (p.pattern === 'magentic') { send('orchestrator', 'orchestrator', 'Task ledger: facts, plan; progress ledger'); steps.push(step('orchestrator', 'Manager built a task ledger and plan', 'Magentic manager records facts, guesses and a plan, then tracks progress and re-plans when stalled.', { plan: present.map((k, i) => `${i + 1}. ${AGENTS[k].label}`) }, 'info')); }
    const used = Math.min(rounds, p.maxRounds);
    for (let i = 0; i < used; i++) { const k = present[i % present.length]; send('orchestrator', k, 'speak'); if (i < present.length) turns.push({ role: `agent:${k}`, text: OUT[p.task][k] }); }
    const needsReviewer = p.task !== 'refund';
    if (rounds > p.maxRounds) { resolved = false; steps.push(step('specialists', `Stopped at max rounds (${p.maxRounds}) before termination`, `This conversation needs ~${rounds} turns to reach the termination condition${needsReviewer ? ' (reviewer says APPROVED)' : ''}.`, { neededRounds: rounds, maxRounds: p.maxRounds }, 'error')); }
    else if (needsReviewer && !avail.includes('reviewer')) { resolved = false; steps.push(step('specialists', 'No agent can satisfy the termination condition', 'The chat terminates when the reviewer approves, but no reviewer is present.', null, 'warn')); }
    else steps.push(step('specialists', `Converged in ${rounds} turns`, 'Manager selected the next speaker each turn until the termination condition was met.', { turns: rounds }, 'ok'));
    if (p.task === 'supplier') { conflict = true; steps.push(step('aggregate', 'Opinions influenced each other', 'In a shared chat later agents see earlier opinions (anchoring); acceptable for collaboration, weaker for independent assessments.', null, 'warn')); }
    if (p.pattern === 'magentic' && p.task === 'refund') steps.push(step('aggregate', 'Planner overhead for a routine case', 'Magentic suits open-ended problems; for a known routing problem it adds planning turns and tokens.', null, 'info'));
  } else if (p.pattern === 'connected') {
    present.forEach(k => { send('orchestrator', k, 'tool call'); send(k, 'orchestrator', 'tool result', 120); turns.push({ role: `agent:${k}`, text: OUT[p.task][k] }); });
    steps.push(step('specialists', 'Main agent called specialists as tools', 'Each connected agent runs, returns its result to the main agent, which composes the reply. Sub-agents never talk to the user directly.', { calls: present }, 'ok'));
    if (p.task === 'supplier') { send('orchestrator', 'orchestrator', 'reconcile'); steps.push(step('aggregate', 'Main agent reconciled the three opinions', 'The main agent sees all tool results and can explain the disagreement.', { decision: 'conditional approve' }, 'ok')); }
  }

  const budget = 6000;
  if (totalTokens > budget && p.contextPolicy === 'full') steps.push(step('context', `Context bloat: ~${fmt(totalTokens)} tokens processed`, `Every agent received the full growing transcript. Above ~${fmt(budget)} tokens (budget chosen for this lab) cost and latency rise and instructions get diluted.`, { totalTokens, policy: 'full transcript' }, 'warn'));
  else steps.push(step('context', `Context handled: ~${fmt(totalTokens)} tokens processed`, p.contextPolicy === 'summary' ? 'Agents receive a bounded hand-over summary instead of the full transcript.' : 'Transcript stayed small enough.', { totalTokens, policy: p.contextPolicy }, 'ok'));

  return finish(p, task, steps, turns, msgs, totalTokens, { resolved, conflict, loop });
}

function finish(p, task, steps, turns, msgs, totalTokens, st) {
  const err = steps.some(s => s.status === 'error');
  const ok = !err && st.resolved && !st.conflict;
  steps.push(step('result', err ? 'Orchestration failed' : ok ? 'Task resolved' : 'Task partly resolved', err ? 'See the failing step.' : ok ? 'One consistent answer returned to the user.' : 'The result needs a human to reconcile or finish it.', { resolved: ok }, err ? 'error' : ok ? 'ok' : 'warn'));
  const fit = (PATTERNS[p.pattern] || PATTERNS.handoff).fit[p.task] || 0;
  const unique = [...new Set(msgs.flatMap(m => [m.from, m.to]))];
  return {
    steps,
    output: [
      { type: 'chat', title: 'Agent transcript (simulated)', turns: turns.slice(0, 14) },
      { type: 'table', title: 'Message trace between agents', columns: ['#', 'From', 'To', 'Input tokens (est.)'], rows: msgs.slice(0, 16).map((m, i) => [String(i + 1), m.from, m.to, String(m.inTok)]), tones: msgs.slice(0, 16).map(m => (st.loop && m.from !== 'user' ? 'error' : 'ok')) },
      { type: 'bars', title: 'Pattern fit for this task (conceptual 1-5)', items: Object.entries(PATTERNS).map(([k, v]) => ({ label: v.label, value: v.fit[p.task] || 0, max: 5, tone: k === p.pattern ? 'info' : 'muted' })) },
      { type: 'alert', tone: err ? 'error' : ok ? 'ok' : 'warn', text: err ? 'The orchestration did not produce an answer.' : ok ? 'Resolved with a single, consistent answer.' : 'An answer was produced, but it has conflicts or gaps.' },
    ],
    metrics: [
      metric('Agent messages', String(msgs.length), 'computed'),
      metric('Agents involved', String(unique.filter(a => a !== 'user').length), 'computed'),
      metric('Tokens processed', `~${fmt(totalTokens)}`, 'estimate', 'Fixed per-message sizes in this simulation; full-transcript policy re-sends all prior messages to every agent.'),
      metric('Pattern fit', `${fit}/5`, 'estimate', 'Teaching judgement for this task, not a measured score.'),
    ],
    summary: `${(PATTERNS[p.pattern] || {}).label} on ${p.task}: ${err ? 'failed' : ok ? 'resolved' : 'partial'} • ${msgs.length} msgs • ~${totalTokens} tok`,
  };
}

const N = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.2.4',
  lab: 'Multi-agent orchestrator',
  services: [
    { name: 'Microsoft Agent Framework: orchestrations', url: 'https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview' },
    { name: 'Foundry Agent Service: connected agents', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/connected-agents' },
    { name: 'AI agent orchestration patterns (Azure Architecture Center)', url: 'https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns' },
  ],
  prereqs: ['2.2.1', '2.2.3', '2.1.3'],
  next: ['2.2.5', '2.2.6'],

  concept: {
    plain: 'Instead of one agent that does everything, you build a team of focused agents and decide how they cooperate: one after another, all at once, passing the case along, talking in a moderated group, or a lead agent calling others like tools. The right pattern depends on whether the sub-tasks depend on each other, need independent opinions, or need a specialist to take over the conversation.',
    technical: 'Microsoft Agent Framework provides orchestration patterns (sequential, concurrent, handoff, group chat and Magentic) built on its workflow runtime, and Foundry Agent Service supports connected agents, where a main agent invokes sub-agents as tools, plus declarative multi-agent workflows. Design decisions include agent instructions and handoff descriptions, termination conditions and max rounds, how context is passed (full transcript vs summary), and how concurrent results are aggregated. Failure modes include handoff loops, missing specialists, contradictory results and growing context cost.',
    useCase: 'A retailer runs a triage agent that hands refund cases to a billing agent and address changes to a logistics agent, while procurement runs three assessors concurrently (finance, market, legal) and an aggregator agent writes a single recommendation with dissent recorded.',
    terms: [
      ['Handoff', 'An agent transfers control of the conversation to another agent based on handoff descriptions.'],
      ['Concurrent (fan-out/fan-in)', 'Same input sent to several agents in parallel; results are aggregated.'],
      ['Group chat manager', 'Selects the next speaker each turn and checks the termination condition.'],
      ['Magentic', 'Planner-led pattern: a manager keeps a task ledger and progress ledger and re-plans dynamically.'],
      ['Connected agents', 'Foundry Agent Service feature where a main agent calls other agents as tools.'],
      ['Termination condition', 'Rule that ends an orchestration: approval keyword, max rounds, or a goal check.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          N('user', 'User / caller', 0, 1.5, 'Submits the task.', { kind: 'user' }),
          N('orchestrator', p ? (PATTERNS[p.pattern] || {}).label || 'Orchestrator' : 'Orchestrator', 1, 1.5, 'Decides who acts next: fixed order, fan-out, handoff, manager selection, planner, or tool calls.', { kind: 'ai', substeps: ['Receive task', 'Choose next agent(s)', 'Pass context', 'Check termination'] }),
          N('triage', 'Triage agent', 1, 3, 'Entry agent for handoff: classifies and routes.', { kind: 'ai', disabled: p && p.pattern !== 'handoff' }),
          N('specialists', 'Specialist agents', 2.5, 1.5, 'Focused agents with narrow instructions and tools.', { kind: 'ai', badge: p ? `${Object.keys(AGENTS).filter(k => p['a_' + k]).length} agents` : undefined }),
          N('billing', 'Billing', 2.5, 0, AGENTS.billing.desc, { disabled: p && !p.a_billing }),
          N('logistics', 'Logistics', 3.5, 0, AGENTS.logistics.desc, { disabled: p && !p.a_logistics }),
          N('research', 'Research', 2.5, 3, AGENTS.research.desc, { disabled: p && !p.a_research }),
          N('writer', 'Writer', 3.5, 3, AGENTS.writer.desc, { disabled: p && !p.a_writer }),
          N('reviewer', 'Reviewer', 4.5, 3, AGENTS.reviewer.desc, { disabled: p && !p.a_reviewer }),
          N('aggregate', 'Aggregate / reconcile', 4, 1.5, 'Merges or chooses between results; records disagreement.', { disabled: p && p.pattern === 'concurrent' && p.aggregator !== 'merge' }),
          N('context', 'Shared context', 2.5, 4, 'What each agent sees: full transcript or a summary.', { kind: 'data', badge: p ? p.contextPolicy : undefined }),
          N('result', 'Final answer', 5, 1.5, 'One consistent response to the user.'),
        ],
        edges: [['user', 'orchestrator'], ['orchestrator', 'triage'], ['orchestrator', 'specialists'], ['specialists', 'billing'], ['specialists', 'logistics'], ['specialists', 'research'], ['specialists', 'writer'], ['specialists', 'reviewer'], ['specialists', 'aggregate'], ['context', 'specialists'], ['aggregate', 'result']],
      }),
      architectural: p => ({
        nodes: [
          N('user', 'Client app / Teams', 0, 1.5, 'Front end calling the orchestration.', { kind: 'app' }),
          N('orchestrator', p && p.pattern === 'connected' ? 'Foundry main agent' : 'Agent Framework workflow (Container Apps / Functions)', 1, 1.5, p && p.pattern === 'connected' ? 'Main agent in Foundry Agent Service with connected agents as tools.' : 'Your code hosts the orchestration; agents are backed by Foundry model deployments or Foundry agents.', { kind: 'compute' }),
          N('triage', 'Triage agent (Foundry)', 1, 3, 'Small, fast model is often enough for routing.', { kind: 'ai', disabled: p && p.pattern !== 'handoff' }),
          N('specialists', 'Specialist agents (Foundry Agent Service)', 2.5, 1.5, 'Each has its own instructions, tools and identity.', { kind: 'ai' }),
          N('billing', 'Billing tools (payments API)', 2.5, 0, 'OpenAPI/function tools.', { kind: 'external', disabled: p && !p.a_billing }),
          N('logistics', 'Logistics tools (WMS API)', 3.5, 0, 'OpenAPI/function tools.', { kind: 'external', disabled: p && !p.a_logistics }),
          N('research', 'Azure AI Search / Bing grounding', 2.5, 3, 'Knowledge tools.', { kind: 'store', disabled: p && !p.a_research }),
          N('writer', 'Model deployment (writer)', 3.5, 3, 'Chat model deployment.', { kind: 'ai', disabled: p && !p.a_writer }),
          N('reviewer', 'Model + policy index (reviewer)', 4.5, 3, 'Grounded on policy documents.', { kind: 'policy', disabled: p && !p.a_reviewer }),
          N('aggregate', 'Aggregator agent', 4, 1.5, 'Optional agent that merges concurrent results.', { kind: 'ai' }),
          N('context', 'Thread / state store (Cosmos DB)', 2.5, 4, 'Conversation and workflow state; checkpoints.', { kind: 'store' }),
          N('result', 'Application Insights traces', 5, 1.5, 'Each agent invocation is a span: see who did what.', { kind: 'data' }),
        ],
        edges: [['user', 'orchestrator'], ['orchestrator', 'triage'], ['orchestrator', 'specialists'], ['specialists', 'billing'], ['specialists', 'logistics'], ['specialists', 'research'], ['specialists', 'writer'], ['specialists', 'reviewer'], ['specialists', 'aggregate'], ['specialists', 'context'], ['aggregate', 'result']],
      }),
      implementation: p => {
        const builder = { sequential: 'SequentialBuilder().participants([...]).build()', concurrent: `ConcurrentBuilder().participants([...])${p && p.aggregator === 'merge' ? '.with_aggregator(merge_fn)' : ''}.build()`, handoff: 'HandoffBuilder(participants=[triage, billing, logistics]).set_coordinator(triage).build()', groupchat: `GroupChatBuilder().set_manager(...).participants([...]).with_max_rounds(${p ? p.maxRounds : 8})`, magentic: 'MagenticBuilder().participants(...).with_standard_manager(chat_client=...).build()', connected: 'ConnectedAgentTool(id=billing.id, name="billing", description=...)' };
        return {
          nodes: [
            N('user', 'chat_client = AzureAIAgentClient(credential=DefaultAzureCredential())', 0, 0, 'Agent Framework client backed by a Foundry project (illustrative name).', { kind: 'code' }),
            N('specialists', 'billing = chat_client.create_agent(name="billing", instructions=..., tools=[...])', 0, 1, 'One agent per specialty; keep instructions narrow.', { kind: 'code' }),
            N('triage', 'triage handoff descriptions: "billing: refunds/charges", "logistics: shipping/address"', 0, 2, 'Non-overlapping descriptions prevent loops.', { kind: 'code', badge: p ? p.handoffRule : undefined }),
            N('orchestrator', `workflow = ${p ? builder[p.pattern] : builder.handoff}`, 1, 0.5, 'Illustrative Agent Framework builder call; names follow the Python package but check the current API reference.', { kind: 'code' }),
            N('aggregate', 'def merge_fn(results): ... # vote / reconcile', 1, 1.5, 'Custom aggregator for concurrent results.', { kind: 'code' }),
            N('context', 'context policy: pass summary instead of full history', 1, 2.5, 'E.g., a summarising step or message filter between agents.', { kind: 'code' }),
            N('result', 'async for event in workflow.run_stream(task): ...', 2, 1.5, 'Stream events (agent updates, outputs) to log and display.', { kind: 'code' }),
          ],
          edges: [['user', 'specialists'], ['specialists', 'orchestrator'], ['triage', 'orchestrator'], ['orchestrator', 'aggregate'], ['context', 'orchestrator'], ['orchestrator', 'result']],
        };
      },
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([v, t]) => [v, t.label]), default: 'refund' },
      { id: 'pattern', label: 'Orchestration pattern', type: 'select', options: Object.entries(PATTERNS).map(([v, t]) => [v, t.label]), default: 'handoff' },
      { id: 'a_billing', label: 'Billing agent registered', type: 'toggle', default: true },
      { id: 'a_logistics', label: 'Logistics agent registered', type: 'toggle', default: true },
      { id: 'a_research', label: 'Research agent registered', type: 'toggle', default: true },
      { id: 'a_writer', label: 'Writer agent registered', type: 'toggle', default: true },
      { id: 'a_reviewer', label: 'Compliance reviewer registered', type: 'toggle', default: true },
      { id: 'handoffRule', label: 'Handoff descriptions', type: 'select', options: [['explicit', 'Explicit, non-overlapping + return to triage'], ['ambiguous', 'Overlapping ("refunds and returns" on both)']], default: 'explicit' },
      { id: 'maxRounds', label: 'Max rounds / handoffs', type: 'range', min: 2, max: 12, step: 1, default: 8 },
      { id: 'contextPolicy', label: 'Context passed between agents', type: 'select', options: [['full', 'Full transcript'], ['summary', 'Bounded summary']], default: 'full' },
      { id: 'aggregator', label: 'Concurrent result aggregation', type: 'select', options: [['none', 'None (return all)'], ['merge', 'Aggregator reconciles']], default: 'none' },
    ],
    samples: [
      { label: 'Refund via handoff', values: { task: 'refund', pattern: 'handoff' } },
      { label: 'Launch brief via sequential pipeline', values: { task: 'launch', pattern: 'sequential' } },
      { label: 'Supplier risk via concurrent + aggregator', values: { task: 'supplier', pattern: 'concurrent', aggregator: 'merge', contextPolicy: 'summary' } },
      { label: 'Launch brief via group chat', values: { task: 'launch', pattern: 'groupchat', maxRounds: 10 } },
      { label: 'Refund via connected agents', values: { task: 'refund', pattern: 'connected' } },
    ],
    run: orchestrate,
  },

  compare: {
    suggestions: [
      'Run the supplier assessment as sequential, concurrent (no aggregator) and concurrent with aggregator; compare conflicts and the final decision.',
      'Run the launch brief as group chat with Full transcript, then Bounded summary; compare tokens processed.',
      'Run the refund with explicit and with overlapping handoff descriptions and compare the message trace.',
    ],
  },

  debug: [
    { id: 'loop', title: 'Customer bounced between agents', values: { task: 'refund', pattern: 'handoff', handoffRule: 'ambiguous' }, node: 'triage',
      symptom: 'Billing and logistics keep handing the case to each other until max rounds.', cause: 'Both handoff descriptions claim the same responsibilities, so each agent defers to the other.', fix: 'Use explicit, non-overlapping handoff descriptions and route back to triage after each specialist.' },
    { id: 'missing', title: 'Refund never processed', values: { task: 'refund', pattern: 'handoff', a_billing: false, handoffRule: 'explicit' }, node: 'specialists',
      symptom: 'Run fails: no agent available for the billing sub-task.', cause: 'The billing specialist is not registered in the orchestration.', fix: 'Register the billing agent (toggle it on).' },
    { id: 'conflict', title: 'Three contradictory recommendations', values: { task: 'supplier', pattern: 'concurrent', aggregator: 'none' }, node: 'aggregate',
      symptom: 'Caller receives APPROVE, REJECT and APPROVE with no decision.', cause: 'Concurrent fan-out without an aggregation step.', fix: 'Add an aggregator that reconciles results and records dissent.' },
    { id: 'bloat', title: 'Group chat is slow and expensive', values: { task: 'launch', pattern: 'magentic', contextPolicy: 'full', maxRounds: 12 }, node: 'context',
      symptom: 'Tokens processed far above budget; responses slow.', cause: 'Every turn re-sends the full transcript to the next agent.', fix: 'Pass a bounded summary between agents (and consider a simpler pattern for well-defined tasks).' },
    { id: 'rounds', title: 'Group chat stops before approval', values: { task: 'launch', pattern: 'groupchat', maxRounds: 4 }, node: 'orchestrator',
      symptom: 'Run ends at max rounds; reviewer never approved.', cause: 'Max rounds is lower than the turns needed to reach the termination condition.', fix: 'Raise max rounds (e.g., 8) or simplify the conversation.' },
  ],

  challenge: {
    task: 'Produce a single, reconciled supplier risk recommendation using independent parallel assessments, with no warnings.',
    condition: 'Task = supplier assessment, pattern = concurrent, and the run has no warn or error steps.',
    hint: 'Parallel opinions need someone to reconcile them, and context should not grow unchecked.',
    check: (p, res) => p.task === 'supplier' && p.pattern === 'concurrent' && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Choose the supplier assessment task and the Concurrent pattern.', 'Make sure research, billing (finance) and the reviewer (legal) are registered.', 'Set aggregation to "Aggregator reconciles".', 'Set context to Bounded summary if tokens exceed the budget, then run.'],
    solutionValues: { task: 'supplier', pattern: 'concurrent', aggregator: 'merge', contextPolicy: 'summary', a_research: true, a_billing: true, a_reviewer: true },
  },

  quiz: [
    { q: 'You need three independent assessments (finance, market, legal) of the same supplier, combined into one decision. Which pattern fits best?', options: ['Sequential', 'Concurrent with an aggregator', 'Handoff', 'A single agent with three prompts in a row'], answer: 1, why: 'Independent sub-tasks on the same input fit fan-out/fan-in; an aggregator reconciles the results.' },
    { q: 'In a handoff orchestration, customers bounce between two agents until the run stops. What is the most likely cause?', options: ['Temperature too low', 'Overlapping handoff descriptions so neither agent believes it owns the case', 'Too few max rounds', 'Missing Application Insights'], answer: 1, why: 'Agents route based on handoff descriptions; overlapping scopes cause ping-pong. Clear ownership and returning to triage fix it.' },
    { q: 'A main Foundry agent should call a billing agent and a shipping agent and then answer the user itself. Which feature matches?', options: ['Connected agents (agent-as-tool)', 'Group chat with a round-robin manager', 'Code interpreter', 'File search'], answer: 0, why: 'Connected agents let a main agent invoke sub-agents as tools and compose the final reply.' },
    { q: 'A group chat orchestration costs far more tokens than expected as conversations grow. What should you change first?', options: ['Pass a bounded summary between agents instead of the full transcript', 'Add more agents', 'Increase max rounds', 'Use a reasoning model for every agent'], answer: 0, why: 'Full-transcript sharing grows roughly quadratically in tokens processed; summaries or filtered context bound it.' },
  ],

  recap: 'Match the pattern to the task shape: sequential for dependent steps, concurrent + aggregator for independent opinions, handoff for routing ownership, group chat or Magentic for collaborative or open-ended work, connected agents for a lead agent using specialists as tools. Define clear ownership, termination and context policies to avoid loops, gaps, conflicts and bloat.',
};
