// 2.3.2 Implement model reflection, chain-of-thought evaluations, and self-critique loops
// Lab: Reflection and self-critique loop.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

// type: factual (needs grounding/verification), completeness, format, style, reasoning (only visible if steps are evaluated)
const TASKS = {
  policy_email: {
    label: 'Customer reply grounded in the refund policy',
    verifier: 'Policy lookup tool (Azure AI Search over the refund policy)',
    tokens: 320,
    lines: [
      { d: null, text: 'Hi Sam,' },
      { d: 'tone', bad: 'Sorry about that!! Stuff happens lol.', good: 'I am sorry your order arrived damaged.' },
      { d: 'window', bad: 'You can return it within 30 days for a full refund.', good: 'You can return it within 14 days of delivery for a full refund.' },
      { d: 'promise', bad: 'We will also send the replacement by free express shipping.', good: 'The replacement ships with standard delivery.' },
      { d: 'order', bad: 'Your refund is being processed.', good: 'Your refund for order 4417 is being processed.' },
      { d: 'next', bad: 'Thanks.', good: 'Please use the prepaid label attached; reply here if anything is unclear.' },
    ],
    defects: {
      window: { type: 'factual', w: 0.3, desc: 'States a 30-day return window; policy says 14 days.' },
      promise: { type: 'factual', w: 0.2, desc: 'Promises free express shipping, which the policy does not offer.' },
      order: { type: 'completeness', w: 0.15, desc: 'Missing the order number.' },
      tone: { type: 'style', w: 0.15, desc: 'Tone too casual for a complaint.' },
      next: { type: 'completeness', w: 0.15, desc: 'No clear next step for the customer.' },
    },
  },
  sql: {
    label: 'SQL for "revenue per customer since 1 Sept"',
    verifier: 'Execute against a test database and compare with expected rows',
    tokens: 220,
    lines: [
      { d: 'star', bad: 'SELECT *, SUM(o.total) AS revenue', good: 'SELECT c.customer_id, c.name, SUM(o.total) AS revenue' },
      { d: null, text: 'FROM orders o' },
      { d: 'join', bad: 'JOIN customers c ON o.customer_name = c.name', good: 'JOIN customers c ON o.customer_id = c.customer_id' },
      { d: 'filter', bad: "WHERE o.order_date > '2026-09-01'", good: "WHERE o.order_date >= '2026-09-01'" },
      { d: 'group', bad: '-- (no GROUP BY)', good: 'GROUP BY c.customer_id, c.name' },
    ],
    defects: {
      join: { type: 'factual', w: 0.3, desc: 'Joins on customer name instead of the key: duplicate names merge revenue.' },
      filter: { type: 'factual', w: 0.2, desc: 'Uses > instead of >=, so 1 September is excluded.' },
      group: { type: 'format', w: 0.3, desc: 'Aggregate without GROUP BY: the query fails to run.' },
      star: { type: 'style', w: 0.1, desc: 'SELECT * with an aggregate returns unneeded / invalid columns.' },
    },
  },
  math: {
    label: 'Price quote: 6 licences at €40, 15% volume discount from 5 licences, plus 20% VAT',
    verifier: 'Calculator / code execution on each numeric step',
    tokens: 260,
    lines: [
      { d: 'arith', bad: 'Step 1: 6 × €40 = €220', good: 'Step 1: 6 × €40 = €240' },
      { d: 'unjustified', bad: 'Step 2: Apply the 15% discount.', good: 'Step 2: 6 ≥ 5, so the 15% volume discount applies: €240 × 0.85 = €204' },
      { d: null, text: 'Step 3: Add 20% VAT.' },
      { d: 'units', bad: 'Total: 244.8', good: 'Total: €244.80 (incl. VAT)' },
    ],
    defects: {
      arith: { type: 'factual', w: 0.4, desc: 'Arithmetic slip in step 1 (6 × 40 is 240).' },
      unjustified: { type: 'reasoning', w: 0.3, desc: 'Applies the discount without checking the quantity threshold. Correct here by luck; wrong for 3 licences.' },
      units: { type: 'format', w: 0.15, desc: 'Total lacks currency, rounding and VAT label.' },
    },
  },
};

// Probability that the critic flags a defect of a given type.
function detectP(p, type) {
  if (p.critic === 'none') return 0;
  const sep = p.critic === 'separate';
  const spec = p.rubric === 'specific';
  if (type === 'factual') return p.verifier ? 0.95 : sep ? (spec ? 0.55 : 0.2) : (spec ? 0.35 : 0.1);
  if (type === 'reasoning') return p.cotEval === 'steps' ? (sep ? 0.85 : 0.6) : 0.05;
  if (type === 'style') return spec ? (sep ? 0.85 : 0.75) : (sep ? 0.5 : 0.45);
  return spec ? (sep ? 0.9 : 0.75) : (sep ? 0.4 : 0.3);
}

function loop(p) {
  const task = TASKS[p.task] || TASKS.policy_email;
  const r = rng(`${p.task}|${p.critic}|${p.rubric}|${p.verifier}|${p.cotEval}|${p.generator}|${p.history}`);
  const steps = [];
  const maxIter = clamp(Math.round(Number(p.iterations) || 0), 0, 6);
  const remaining = new Set(Object.keys(task.defects));
  const defects = { ...task.defects, verbose: { type: 'style', w: 0.1, desc: 'Revision added padding and hedging (over-editing).' } };
  const foundAt = {}, fixedAt = {};
  const fixP = p.generator === 'large' ? 0.9 : 0.6;
  const score = () => clamp(round(5 - 4 * [...remaining].reduce((a, k) => a + defects[k].w, 0), 2), 1, 5);
  const bias = p.critic === 'self' ? 0.8 : p.critic === 'separate' ? 0.25 : 0;
  const judge = s => p.critic === 'none' ? null : clamp(round(s + bias + (p.rubric === 'vague' ? 0.3 : 0), 2), 1, 5);
  const history = [];
  let tokens = task.tokens, ctx = task.tokens;

  const s0 = score();
  history.push({ iter: 0, trueScore: s0, judgeScore: judge(s0), remaining: remaining.size, tokens });
  steps.push(step('draft', 'Initial draft generated', `${p.generator === 'large' ? 'Large' : 'Small'} generator, ~${task.tokens} tokens. ${remaining.size} hidden defects (known only to this lab).`, { defects: [...remaining] }, 'info'));

  let stoppedEarly = false;
  for (let it = 1; it <= maxIter; it++) {
    const prev = history.at(-1);
    if (prev.judgeScore != null && prev.judgeScore >= Number(p.stopThreshold)) { stoppedEarly = true; steps.push(step('judge', `Stop: judge score ${prev.judgeScore} ≥ threshold ${p.stopThreshold}`, `Loop ended before iteration ${it}.`, { judgeScore: prev.judgeScore, trueScore: prev.trueScore }, prev.trueScore < 4 ? 'warn' : 'ok')); break; }
    // Critique
    const critiqueTok = 220 + (p.cotEval === 'steps' ? 160 : 0) + (p.rubric === 'specific' ? 80 : 0);
    const flagged = [...remaining].filter(k => r() < detectP(p, defects[k].type));
    flagged.forEach(k => { if (!(k in foundAt)) foundAt[k] = it; });
    if (p.verifier) steps.push(step('verifier', `Iteration ${it}: external check`, `${task.verifier}. Verifiers give objective feedback that self-reflection alone cannot.`, { flaggedByVerifier: flagged.filter(k => defects[k].type === 'factual') }, 'info'));
    steps.push(step('critic', `Iteration ${it}: critique flagged ${flagged.length} issue(s)`, p.critic === 'none' ? 'No critic: the "revision" is a blind re-generation.' : flagged.map(k => defects[k].desc).join(' • ') || 'Critic found nothing to fix.', { critic: p.critic, rubric: p.rubric, cotEval: p.cotEval, flagged }, p.critic === 'none' ? 'warn' : 'info'));
    // Revise
    const fixed = flagged.filter(() => r() < fixP);
    fixed.forEach(k => { remaining.delete(k); fixedAt[k] = it; });
    let regressed = null;
    if (r() < (p.critic === 'self' ? 0.18 : 0.08) * (p.rubric === 'vague' ? 1.6 : 1) * (p.generator === 'small' ? 1.4 : 1) && !remaining.has('verbose')) { remaining.add('verbose'); regressed = 'verbose'; foundAt.verbose = foundAt.verbose || null; }
    const reviseTok = task.tokens + (p.history === 'full' ? ctx : 150);
    tokens += critiqueTok + reviseTok;
    ctx += critiqueTok + task.tokens;
    const s = score();
    history.push({ iter: it, trueScore: s, judgeScore: judge(s), remaining: remaining.size, tokens });
    steps.push(step('revise', `Iteration ${it}: revised (${fixed.length} fixed${regressed ? ', 1 new issue' : ''})`, `Reference score ${prev.trueScore} → ${s}.${flagged.length > fixed.length ? ` The reviser did not apply ${flagged.length - fixed.length} flagged fix(es)${p.generator === 'small' ? ' (more common with a small generator)' : ''}.` : ''}${regressed ? ' The revision added padding: self-critique can over-edit.' : ''}`, { fixed, regressed, cumulativeTokens: tokens }, regressed ? 'warn' : 'ok'));
  }

  const final = history.at(-1);
  // Diminishing returns
  const gains = history.slice(1).map((h, i) => round(h.trueScore - history[i].trueScore, 2));
  const flatTail = gains.length >= 3 && gains.slice(-2).every(g => g <= 0.05);
  if (flatTail) steps.push(step('judge', 'Diminishing returns', `The last two iterations improved the true score by ${gains.slice(-2).join(' and ')} while tokens grew to ~${tokens} (${round(tokens / task.tokens, 1)}× the first draft). Cap iterations or stop on a threshold.`, { gains }, 'warn'));
  if (p.critic !== 'none' && final.judgeScore - final.trueScore >= 0.7) steps.push(step('judge', 'Judge over-rates the output', `Judge says ${final.judgeScore}, the reference rubric says ${final.trueScore}. A model grading its own work tends to be lenient; use a separate judge and a specific rubric.`, { judge: final.judgeScore, reference: final.trueScore }, 'warn'));
  if (remaining.has('unjustified')) steps.push(step('critic', 'Reasoning flaw not detected', p.cotEval === 'steps' ? 'Step evaluation ran but did not flag the unchecked threshold this time.' : 'Only the final answer was evaluated, and it happens to be correct. Evaluating the stated reasoning steps would expose the unchecked assumption.', { cotEval: p.cotEval }, 'warn'));

  const brokenSql = p.task === 'sql' && remaining.has('group');
  const wrongPolicy = p.task === 'policy_email' && (remaining.has('window') || remaining.has('promise'));
  steps.push(step('final', brokenSql ? 'Final SQL fails to execute' : wrongPolicy ? 'Final email still misstates policy' : 'Final output accepted', `${remaining.size} defect(s) remain: ${[...remaining].map(k => defects[k].desc).join(' ') || 'none'}`, { trueScore: final.trueScore, judgeScore: final.judgeScore, iterations: history.length - 1 }, brokenSql ? 'error' : wrongPolicy || final.trueScore < 4 ? 'warn' : 'ok'));

  const render = set => task.lines.map(l => l.d ? (set.has(l.d) ? l.bad : l.good) : l.text).join('\n') + (set.has('verbose') ? '\n(…plus two extra paragraphs of hedging and repetition)' : '');
  const allKeys = Object.keys(defects).filter(k => k in task.defects || k in fixedAt || remaining.has(k));
  return {
    steps,
    output: [
      { type: 'table', title: 'Iterations', columns: ['Iteration', 'Judge score', 'Reference score', 'Defects left', 'Cumulative tokens (est.)'],
        rows: history.map(h => [String(h.iter), h.judgeScore == null ? '—' : h.judgeScore.toFixed(2), h.trueScore.toFixed(2), String(h.remaining), String(h.tokens)]),
        tones: history.map(h => h.trueScore >= 4.5 ? 'ok' : h.trueScore >= 3.5 ? 'warn' : 'error') },
      { type: 'bars', title: 'Reference score by iteration (1–5)', threshold: Number(p.stopThreshold) / 5, items: history.map(h => ({ label: `iter ${h.iter}`, value: h.trueScore, max: 5, note: h.judgeScore == null ? '' : `judge ${h.judgeScore}`, tone: h.trueScore >= 4.5 ? 'ok' : h.trueScore >= 3.5 ? 'warn' : 'error' })) },
      { type: 'diff', title: 'First draft → final', before: render(new Set(Object.keys(task.defects))), after: render(remaining) },
      { type: 'table', title: 'Defect ledger (hidden reference, for learning)', columns: ['Defect', 'Type', 'Found at', 'Fixed at'], rows: allKeys.map(k => [defects[k].desc, defects[k].type, foundAt[k] ? `iter ${foundAt[k]}` : '—', fixedAt[k] ? `iter ${fixedAt[k]}` : remaining.has(k) ? 'open' : '—']), tones: allKeys.map(k => remaining.has(k) ? 'warn' : 'ok') },
    ],
    metrics: [
      metric('Reference score', `${final.trueScore.toFixed(2)} / 5`, 'computed', 'Computed from the defects this lab planted.'),
      metric('Judge score', final.judgeScore == null ? '—' : `${final.judgeScore.toFixed(2)} / 5`, 'computed'),
      metric('Iterations run', String(history.length - 1), 'computed'),
      metric('Token cost vs single draft', `~${round(tokens / task.tokens, 1)}×`, 'estimate', 'Fixed per-call token sizes; full-history mode re-sends earlier drafts and critiques each round.'),
    ],
    summary: `${p.task} • ${p.critic}/${p.rubric}${p.verifier ? '+verifier' : ''} • ${history.length - 1} iter • ref ${final.trueScore} • ~${round(tokens / task.tokens, 1)}× tokens`,
  };
}

const N = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.3.2',
  lab: 'Reflection and self-critique loop',
  services: [
    { name: 'Evaluate generative AI apps (Microsoft Foundry)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/observability' },
    { name: 'Custom and AI-assisted evaluators (azure-ai-evaluation)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/evaluate-sdk' },
    { name: 'Reasoning models in Azure OpenAI', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/reasoning' },
  ],
  prereqs: ['2.3.1', '2.1.4'],
  next: ['2.3.4', '1.4.2'],

  concept: {
    plain: 'A reflection loop asks a model to check its own (or another model\'s) work against a list of criteria and then fix what it finds. It helps most when the checker has real feedback (a test, a lookup, a calculator) and a clear checklist. It costs extra calls each round, improvements shrink quickly, and a model grading itself tends to be too generous.',
    technical: 'Pattern: generate → critique against a rubric (LLM-as-judge, same or separate model) → revise, repeated until a judge threshold or max iterations. External verifiers (tool calls, code execution, retrieval) provide grounded feedback. Chain-of-thought evaluation scores the visible reasoning steps or rationale the app asks for, not just the final answer; reasoning models\' internal reasoning tokens are not returned, so you evaluate requested step summaries or structured rationales instead. Track per-iteration scores and tokens; use separate judges and calibrated rubrics (e.g., custom evaluators in azure-ai-evaluation) to avoid self-preference bias.',
    useCase: 'A support team drafts replies with a small model, critiques them with a separate judge model against a policy rubric, and checks every factual claim with an Azure AI Search policy lookup. Two iterations fix most issues; a third rarely helps, so the loop is capped and anything still below threshold goes to a human.',
    terms: [
      ['Reflection / self-critique', 'The model reviews an output against criteria and produces feedback used for revision.'],
      ['LLM-as-judge', 'A model scoring outputs with a rubric; needs calibration against human labels.'],
      ['Self-preference bias', 'Models tend to rate their own outputs higher than an independent judge would.'],
      ['External verifier', 'Objective check outside the model: tests, execution, retrieval, calculators.'],
      ['Chain-of-thought evaluation', 'Scoring the visible reasoning steps (validity, justification), not only the final answer.'],
      ['Diminishing returns', 'Each extra iteration costs about as much but fixes less.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          N('draft', 'Generate draft', 0, 1, 'First attempt from the generator model.', { kind: 'ai', badge: p ? p.generator : undefined }),
          N('critic', 'Critique vs rubric', 1, 0.3, 'Lists concrete problems against the rubric; optionally evaluates reasoning steps.', { kind: 'policy', badge: p ? `${p.critic} • ${p.rubric}` : undefined, substeps: ['Read output', 'Check each rubric item', 'Check reasoning steps', 'Return issues'] }),
          N('verifier', 'External verifier', 1, 1.7, 'Tool-based checks: run SQL, look up policy, calculate.', { kind: 'compute', disabled: p && !p.verifier }),
          N('revise', 'Revise', 2, 1, 'Fix only the flagged issues; keep the rest.', { kind: 'ai' }),
          N('judge', 'Judge + stop rule', 3, 1, 'Score; stop at threshold or max iterations.', { kind: 'policy', badge: p ? `≥${p.stopThreshold} or ${p.iterations} iters` : undefined }),
          N('final', 'Final output', 4, 1, 'Accepted, or routed to a human if still below threshold.'),
        ],
        edges: [['draft', 'critic'], ['draft', 'verifier'], ['critic', 'revise'], ['verifier', 'revise'], ['revise', 'judge'], ['judge', 'critic', 'again'], ['judge', 'final', 'stop']],
      }),
      architectural: p => ({
        nodes: [
          N('draft', `Generator deployment (${p && p.generator === 'small' ? 'small model' : 'large model'})`, 0, 1, 'Foundry model deployment.', { kind: 'ai' }),
          N('critic', p && p.critic === 'separate' ? 'Judge deployment (different model)' : 'Same deployment as critic', 1, 0.3, 'Separate judge reduces self-preference bias.', { kind: 'ai', disabled: p && p.critic === 'none' }),
          N('verifier', 'Tools: Azure AI Search / SQL sandbox / code interpreter', 1, 1.7, 'Grounded feedback.', { kind: 'external', disabled: p && !p.verifier }),
          N('revise', 'Orchestrator (Agent Framework workflow or app code)', 2, 1, 'Holds the loop, history policy and limits.', { kind: 'compute' }),
          N('judge', 'Evaluators (azure-ai-evaluation custom rubric)', 3, 1, 'Same rubric offline and online.', { kind: 'policy' }),
          N('final', 'App Insights traces per iteration', 4, 1, 'Score + tokens per iteration for tuning the cap.', { kind: 'data' }),
        ],
        edges: [['draft', 'revise'], ['revise', 'critic'], ['revise', 'verifier'], ['revise', 'judge'], ['judge', 'final']],
      }),
      implementation: p => ({
        nodes: [
          N('draft', 'draft = llm(GEN_PROMPT, task)', 0, 0, 'Ask for a short, structured rationale if you plan to evaluate steps.', { kind: 'code' }),
          N('critic', `issues = judge(RUBRIC_${p && p.rubric === 'specific' ? 'CHECKLIST' : 'VAGUE'}, draft${p && p.cotEval === 'steps' ? ', steps=draft.rationale' : ''})  # JSON list`, 0, 1, 'Return structured issues, not prose.', { kind: 'code' }),
          N('verifier', 'facts = run_checks(draft)  # execute SQL / lookup / calc', 0, 2, 'Feed objective results into the critique.', { kind: 'code', disabled: p && !p.verifier }),
          N('revise', `draft = llm(REVISE_PROMPT, draft, issues${p && p.history === 'full' ? ', history' : ''})`, 1, 0.5, 'Full history grows tokens every round.', { kind: 'code' }),
          N('judge', `for i in range(${p ? p.iterations : 2}): ... if score >= ${p ? p.stopThreshold : 4.5}: break`, 1, 1.5, 'Hard cap + threshold.', { kind: 'code' }),
          N('final', 'log(iteration=i, score=score, tokens=usage.total_tokens)', 1, 2.5, 'Measure where returns flatten.', { kind: 'code' }),
        ],
        edges: [['draft', 'critic'], ['verifier', 'critic'], ['critic', 'revise'], ['revise', 'judge'], ['judge', 'final']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'task', label: 'Task', type: 'select', options: Object.entries(TASKS).map(([k, t]) => [k, t.label]), default: 'policy_email' },
      { id: 'generator', label: 'Generator model', type: 'select', options: [['small', 'Small model'], ['large', 'Large model']], default: 'small' },
      { id: 'critic', label: 'Critic', type: 'select', options: [['none', 'None (blind retry)'], ['self', 'Same model critiques itself'], ['separate', 'Separate judge model']], default: 'self' },
      { id: 'rubric', label: 'Rubric', type: 'select', options: [['vague', 'Vague ("make it better")'], ['specific', 'Specific checklist']], default: 'vague' },
      { id: 'verifier', label: 'External verifier (tool feedback)', type: 'toggle', default: false },
      { id: 'cotEval', label: 'Evaluate', type: 'select', options: [['final_only', 'Final answer only'], ['steps', 'Reasoning steps + final answer']], default: 'final_only' },
      { id: 'iterations', label: 'Max iterations', type: 'range', min: 0, max: 6, step: 1, default: 2 },
      { id: 'stopThreshold', label: 'Stop when judge score ≥', type: 'range', min: 3, max: 5, step: 0.25, default: 4.5 },
      { id: 'history', label: 'Context passed to reviser', type: 'select', options: [['last', 'Last draft + issues'], ['full', 'Full history']], default: 'last' },
    ],
    samples: [
      { label: 'Self-critique, vague rubric', values: { task: 'policy_email' } },
      { label: 'Separate judge + checklist + policy lookup', values: { task: 'policy_email', critic: 'separate', rubric: 'specific', verifier: true, iterations: 3 } },
      { label: 'SQL, self-critique with execution feedback', values: { task: 'sql', critic: 'self', rubric: 'specific', verifier: true, iterations: 3 } },
      { label: 'Price quote, steps evaluated', values: { task: 'math', critic: 'separate', rubric: 'specific', cotEval: 'steps', verifier: true, iterations: 3 } },
      { label: 'Six iterations, full history', values: { task: 'policy_email', critic: 'separate', rubric: 'specific', iterations: 6, stopThreshold: 5, history: 'full' } },
    ],
    run: loop,
  },

  compare: {
    suggestions: [
      'Run the policy email with Self vs Separate judge (same rubric) and compare judge score against reference score.',
      'Run SQL with and without the external verifier and compare which defects are found.',
      'Run the price quote with "Final answer only" and "Reasoning steps + final answer" and look for the unjustified step.',
      'Run 2 vs 6 iterations with full history and compare token cost against score gain.',
    ],
  },

  debug: [
    { id: 'blind', title: 'Revisions do not improve anything', values: { task: 'policy_email', critic: 'none', iterations: 3 }, node: 'critic',
      symptom: 'Score stays flat across iterations.', cause: 'No critic: each "revision" is just another sample with no feedback.', fix: 'Add a critic (preferably a separate judge with a specific rubric).' },
    { id: 'lenient', title: 'Loop stops early with wrong facts', values: { task: 'policy_email', critic: 'self', rubric: 'vague', stopThreshold: 3.5, iterations: 3 }, node: 'judge',
      symptom: 'Judge score passes the threshold but the email still states a 30-day window.', cause: 'Self-grading with a vague rubric over-rates the output (self-preference bias).', fix: 'Use a separate judge, a specific rubric, and the policy lookup verifier.' },
    { id: 'sqlbroken', title: 'Final SQL does not run', values: { task: 'sql', critic: 'self', rubric: 'vague', iterations: 1 }, node: 'final',
      symptom: 'Query fails: aggregate without GROUP BY.', cause: 'Critique without execution feedback misses structural errors.', fix: 'Enable the external verifier (execute against a test DB) with a specific rubric and a separate judge.' },
    { id: 'cot', title: 'Correct total, flawed reasoning', values: { task: 'math', critic: 'separate', rubric: 'specific', verifier: true, cotEval: 'final_only', iterations: 3 }, node: 'critic',
      symptom: 'Reviewer later finds the discount was applied without checking the threshold.', cause: 'Only the final answer was evaluated; the unjustified step is invisible.', fix: 'Evaluate the reasoning steps (ask for a structured rationale and score it).' },
    { id: 'diminishing', title: 'Expensive loop, little gain', values: { task: 'policy_email', critic: 'separate', rubric: 'specific', verifier: true, iterations: 6, stopThreshold: 5, history: 'full' }, node: 'judge',
      symptom: 'Tokens grow many-fold while the score barely moves after iteration 2–3.', cause: 'No effective stop rule; full history inflates every call.', fix: 'Cap at 2–3 iterations, stop at a realistic threshold (e.g., 4.5) and pass only the last draft + issues. If one defect survives every round, a stronger generator helps more than more rounds.' },
  ],

  challenge: {
    task: 'Get the SQL task to a reference score of at least 4.5 in no more than 3 iterations, with no warnings or errors.',
    condition: 'Task = SQL, iterations ≤ 3, reference score ≥ 4.5, no warn or error steps.',
    hint: 'What kind of feedback catches a query that does not run or joins on the wrong key?',
    check: (p, res) => p.task === 'sql' && Number(p.iterations) <= 3 && parseFloat(res.metrics[0].value) >= 4.5 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Choose the SQL task.', 'Use a separate judge model with a specific checklist rubric.', 'Turn on the external verifier (execute against a test DB).', 'Use the large generator, 3 iterations, threshold 4.5, last draft + issues.'],
    solutionValues: { task: 'sql', critic: 'separate', rubric: 'specific', verifier: true, generator: 'large', iterations: 3, stopThreshold: 4.5, history: 'last', cotEval: 'final_only' },
  },

  quiz: [
    { q: 'Your self-critique loop reports a judge score of 4.8 but human reviewers rate outputs around 3.5. What is the best change?', options: ['Raise the stop threshold to 5', 'Use a separate judge model with a specific, calibrated rubric', 'Add more iterations', 'Increase temperature'], answer: 1, why: 'Self-grading tends to be lenient; an independent judge and a calibrated rubric align scores with humans.' },
    { q: 'A code-generation loop often produces SQL that does not run. Which addition gives the most reliable improvement?', options: ['A vaguer rubric', 'Executing the query in a sandbox and feeding errors into the critique', 'Longer system prompt', 'Full history to the reviser'], answer: 1, why: 'External verification (execution) provides objective feedback that reflection alone misses.' },
    { q: 'You use a reasoning model and want to evaluate its reasoning quality. What can you evaluate?', options: ['The hidden reasoning tokens returned by the API', 'A structured rationale or step summary the app asks the model to output', 'Nothing; reasoning cannot be evaluated', 'Only the token count'], answer: 1, why: 'Internal reasoning tokens are not returned; ask for a visible rationale or summary and score its steps.' },
    { q: 'After iteration 2, each extra round adds ~40% tokens but under 0.05 score. What should you do?', options: ['Cap iterations at 2–3 and route remaining low scores to humans', 'Keep 6 iterations for safety', 'Remove the judge', 'Switch to full history'], answer: 0, why: 'Measure gain per iteration and stop when returns flatten; escalate the remainder.' },
  ],

  recap: 'Reflection works when feedback is concrete: a specific rubric, a separate judge, and external verifiers. Evaluate reasoning steps you ask the model to show, not hidden reasoning. Track score and tokens per iteration, stop at a threshold or a small cap, and send what still fails to a human.',
};
