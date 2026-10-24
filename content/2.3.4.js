// 2.3.4 Orchestrate multiple models, flows, or hybrid LLM and rules engines
// Lab: Hybrid model router.
import { step, metric, pct, round } from '../src/engine/util.js';

// slm / llm: [correct?, confidence]. kw = what deterministic rules can see.
const INPUTS = {
  reset_pw: { label: '"I forgot my password, please reset it."', intent: 'password_reset', kw: 'password', slm: [true, 0.93], llm: [true, 0.97] },
  order_status: { label: '"Where is order 5521?"', intent: 'order_status', kw: 'order', slm: [true, 0.9], llm: [true, 0.96] },
  reschedule: { label: '"Could you move my Thursday demo to next week? Thanks, Priya"', intent: 'reschedule', kw: null, slm: [true, 0.86], llm: [true, 0.95] },
  complaint: { label: '"Third failure this month. I lost a week of work; refund the shipping or I am calling my lawyer."', intent: 'legal_escalation', kw: 'escalation', slm: [false, 0.55], llm: [true, 0.9] },
  contract: { label: '"Does clause 14.2 of our MSA allow termination for convenience?"', intent: 'contract_question', kw: 'contract', slm: [false, 0.62], llm: [false, 0.82] },
  pii: { label: '"My card 4111 1111 1111 1111 was charged twice for one order."', intent: 'billing_dispute', kw: 'pii', slm: [true, 0.88], llm: [true, 0.95] },
  vague: { label: '"It\'s broken again."', intent: 'unclear', kw: null, slm: [false, 0.4], llm: [true, 0.85] },
};

// Relative cost units and latency (ms) — illustrative assumptions of this lab, not prices.
const COST = { rules: 0.01, slm: 1, llm: 10, specialist: 14, human: 20 };
const LAT = { rules: 20, slm: 300, llm: 1500, specialist: 2200, human: 300000 };
const ROUTER = { keyword: { cost: 0, lat: 5 }, slm: { cost: 1, lat: 250 }, llm: { cost: 10, lat: 1200 } };

function routeOne(p, key, strategy) {
  const inp = INPUTS[key];
  const chain = [];
  const issues = [];
  let cost = 0, lat = 0, correct = false, handler = null;
  const use = (h, label, tone = 'info', note) => { cost += COST[h]; lat += LAT[h]; chain.push({ label, tone, note }); };

  // Deterministic pre-processing
  if (inp.kw === 'pii') {
    if (p.piiPrecheck && strategy !== 'none') { use('rules', 'Rules: PII redaction (card number → ****1111)', 'ok', 'regex + Luhn check'); }
    else if (strategy !== 'rules_only') issues.push({ status: 'warn', node: 'rules', title: 'Card number sent to the model and logs', detail: 'No deterministic PII redaction ran before the model call; the full PAN is now in prompts, traces and possibly model logs.' });
  }

  const callModel = (tier) => {
    // tier: 'slm' | 'llm'. Returns [correct, conf] or null when the call fails.
    if (tier === 'slm' && !p.slmDeployed) { issues.push({ status: 'error', node: 'slm', title: 'SLM deployment not found (404)', detail: 'The route targets a small-model deployment name that does not exist in the Foundry project.' }); chain.push({ label: 'SLM: DeploymentNotFound', tone: 'error' }); return null; }
    if (tier === 'llm' && p.llmStatus === 'throttled') {
      if (p.onThrottle === 'fail') { issues.push({ status: 'error', node: 'llm', title: 'LLM throttled (429), no fallback', detail: 'The large-model deployment is over its rate limit and the orchestrator has no fallback path.' }); chain.push({ label: 'LLM: 429 Too Many Requests', tone: 'error' }); return null; }
      if (p.onThrottle === 'queue_human') { chain.push({ label: 'LLM 429 → queued for a human agent', tone: 'warn' }); issues.push({ status: 'warn', node: 'llm', title: 'Throttled: handed to human queue', detail: 'Safe, but the customer waits for a person.' }); handler = 'human'; cost += COST.human; lat += LAT.human; return [true, 1]; }
      chain.push({ label: 'LLM 429 → fallback to SLM', tone: 'warn' }); issues.push({ status: 'warn', node: 'llm', title: 'Throttled: degraded to SLM', detail: 'Fallback keeps the service up but answers hard cases with a weaker model.' });
      return callModel('slm');
    }
    use(tier, tier === 'slm' ? `SLM answers (confidence ${inp.slm[1]})` : `LLM answers (confidence ${inp.llm[1]})`, 'info');
    handler = tier;
    return tier === 'slm' ? inp.slm : inp.llm;
  };

  const rulesMatch = () => {
    if (inp.kw === 'password') return 'self-service reset flow';
    if (inp.kw === 'order') return 'order API lookup (regex order id)';
    if (inp.kw === 'escalation' && p.escalationRules) return 'escalation rule (legal/repeat-failure keywords)';
    if (inp.kw === 'escalation') return 'refund rule ("refund" keyword)';
    if (inp.kw === 'contract') return 'contract keyword rule';
    return null;
  };
  const toSpecialist = () => {
    if (!p.specialistFlow) return false;
    use('specialist', 'Specialist flow: contract RAG (Azure AI Search over MSAs + LLM with citations)', 'ok');
    handler = 'specialist'; correct = true; return true;
  };
  const escalateHuman = () => { const r = callModel('llm'); if (r) { correct = r[0]; chain.push({ label: 'Hand off to human with LLM summary', tone: 'ok' }); } };

  if (strategy === 'llm_only') {
    const r = callModel('llm'); if (r) correct = r[0];
  } else if (strategy === 'rules_only') {
    const m = rulesMatch();
    if (m && inp.kw !== 'contract' && !(inp.kw === 'escalation' && !p.escalationRules)) { use('rules', `Rules: ${m}`, 'ok'); handler = 'rules'; correct = true; }
    else { use('rules', m ? `Rules: ${m}` : 'Rules: no match → canned fallback', 'warn'); handler = 'rules'; correct = false; }
  } else if (strategy === 'router') {
    const rt = ROUTER[p.routerType];
    cost += rt.cost; lat += rt.lat;
    // What the router decides
    let route;
    if (p.routerType === 'keyword') route = inp.kw === 'password' || inp.kw === 'order' ? 'rules' : inp.kw === 'contract' ? 'specialist' : inp.kw === 'escalation' && p.escalationRules ? 'llm' : 'slm';
    else if (p.routerType === 'slm') route = { password_reset: 'rules', order_status: 'rules', reschedule: 'slm', legal_escalation: 'llm', contract_question: 'specialist', billing_dispute: 'slm', unclear: 'slm' }[inp.intent];
    else route = { password_reset: 'rules', order_status: 'rules', reschedule: 'slm', legal_escalation: 'llm', contract_question: 'specialist', billing_dispute: 'slm', unclear: 'llm' }[inp.intent];
    chain.push({ label: `${p.routerType === 'keyword' ? 'Keyword' : p.routerType.toUpperCase()} router → ${route}`, tone: 'info', note: `intent ${inp.intent}` });
    if (route === 'rules') { use('rules', `Rules: ${rulesMatch()}`, 'ok'); handler = 'rules'; correct = true; }
    else if (route === 'specialist') { if (!toSpecialist()) { const r = callModel('llm'); if (r) correct = r[0]; } }
    else if (route === 'llm') { if (inp.intent === 'legal_escalation') escalateHuman(); else { const r = callModel('llm'); if (r) correct = r[0]; } }
    else { const r = callModel('slm'); if (r) correct = r[0]; }
  } else { // cascade
    const m = rulesMatch();
    if (inp.kw === 'password' || inp.kw === 'order') { use('rules', `Stage 1 rules: ${m}`, 'ok'); handler = 'rules'; correct = true; }
    else if (inp.kw === 'escalation' && p.escalationRules) { use('rules', `Stage 1 rules: ${m}`, 'ok'); escalateHuman(); }
    else if (inp.kw === 'contract' && p.specialistFlow) { use('rules', 'Stage 1 rules: contract keyword → specialist', 'ok'); toSpecialist(); }
    else {
      chain.push({ label: 'Stage 1 rules: no deterministic match', tone: 'muted' });
      const r = callModel('slm');
      if (r) {
        if (r[1] >= Number(p.threshold) || handler === 'human') { correct = r[0]; chain.push({ label: `Stage 2: accept SLM (conf ${r[1]} ≥ ${p.threshold})`, tone: r[0] ? 'ok' : 'error' }); }
        else { chain.push({ label: `Stage 2: conf ${r[1]} < ${p.threshold} → escalate`, tone: 'warn' }); const r2 = callModel('llm'); if (r2) correct = r2[0]; }
      }
    }
  }

  const failed = issues.some(i => i.status === 'error');
  if (failed) correct = false;
  return { key, chain, handler, correct, cost: round(cost, 2), lat, issues };
}

function runRouter(p) {
  const steps = [];
  const sel = INPUTS[p.input] ? p.input : 'reschedule';
  const one = routeOne(p, sel, p.strategy);
  const inp = INPUTS[sel];

  steps.push(step('input', 'Request received', inp.label, { expectedIntent: inp.intent }, 'info'));
  steps.push(step('router', `Strategy: ${{ llm_only: 'LLM for everything', rules_only: 'Rules engine only', router: `Router (${p.routerType})`, cascade: `Cascade (threshold ${p.threshold})` }[p.strategy]}`, one.chain.map(c => c.label).join(' → '), { chain: one.chain.map(c => c.label) }, 'info'));
  for (const i of one.issues) steps.push(step(i.node, i.title, i.detail, null, i.status));
  const hard = sel === 'complaint' || sel === 'contract';
  const resStatus = one.issues.some(i => i.status === 'error') ? 'error' : one.correct ? 'ok' : hard ? 'error' : 'warn';
  const why = { complaint: 'A legal threat was handled as a routine refund by an automated path. It should reach a human with context.', contract: 'The answer about clause 14.2 was generated without the contract text: a confident fabrication.', vague: 'The request was too vague; the handler guessed instead of asking a clarifying question.', reschedule: 'No rule covers this request, so it fell through to a canned reply.', pii: 'The deterministic rule could redact the card number but cannot resolve the dispute.' }[sel] || 'Wrong handler for this request.';
  steps.push(step(one.handler === 'specialist' ? 'specialist' : one.handler === 'rules' ? 'rules' : one.handler === 'slm' ? 'slm' : 'llm', one.correct ? `Handled correctly by ${one.handler}` : 'Wrong or unsafe outcome', one.correct ? `Relative cost ${one.cost} units, ~${one.lat} ms (illustrative).` : why, { handler: one.handler, correct: one.correct, cost: one.cost, latencyMs: one.lat }, resStatus));

  // Aggregate across the whole traffic mix, for all strategies with the same toggles.
  const keys = Object.keys(INPUTS);
  const agg = strat => { const rs = keys.map(k => routeOne(p, k, strat)); return { rs, acc: rs.filter(r => r.correct).length, cost: round(rs.reduce((a, r) => a + r.cost, 0), 2), lat: Math.round(rs.reduce((a, r) => a + r.lat, 0) / rs.length) }; };
  const strategies = { llm_only: 'LLM only', rules_only: 'Rules only', router: `Router (${p.routerType})`, cascade: 'Cascade' };
  const all = Object.fromEntries(Object.keys(strategies).map(s => [s, agg(s)]));
  const mine = all[p.strategy];
  const baseCost = COST.llm * keys.length; // healthy LLM-only baseline, independent of throttling
  steps.push(step('mix', `Traffic mix: ${mine.acc}/${keys.length} correct at ${pct(mine.cost / baseCost)} of LLM-only cost`, 'Same configuration applied to all seven sample requests.', { accuracy: `${mine.acc}/${keys.length}`, relativeCost: round(mine.cost / baseCost, 2), avgLatencyMs: mine.lat }, mine.acc < keys.length - 1 ? 'warn' : 'ok'));

  return {
    steps,
    output: [
      { type: 'flow', title: `Route taken for ${inp.label}`, items: [{ label: 'Request', tone: 'info' }, ...one.chain, { label: one.correct ? 'Correct outcome' : 'Wrong / unsafe outcome', tone: one.correct ? 'ok' : 'error' }] },
      { type: 'table', title: 'Whole traffic mix with this configuration', columns: ['Request', 'Final handler', 'Correct', 'Cost units', '~Latency ms'], rows: mine.rs.map(r => [INPUTS[r.key].label, r.handler || '—', r.correct ? 'yes' : 'no', String(r.cost), String(r.lat)]), tones: mine.rs.map(r => r.correct ? 'ok' : 'error') },
      { type: 'bars', title: 'Accuracy on the mix by strategy (same toggles)', items: Object.entries(all).map(([k, a]) => ({ label: strategies[k], value: a.acc / keys.length, note: `${a.acc}/${keys.length}`, tone: k === p.strategy ? 'info' : 'muted' })) },
      { type: 'bars', title: 'Relative cost vs LLM-only (estimate)', items: Object.entries(all).map(([k, a]) => ({ label: strategies[k], value: a.cost / baseCost, max: Math.max(1.5, ...Object.values(all).map(x => x.cost / baseCost)), note: `${pct(a.cost / baseCost)}`, tone: k === p.strategy ? 'info' : 'muted' })) },
    ],
    metrics: [
      metric('Mix accuracy', `${mine.acc}/${keys.length}`, 'computed'),
      metric('Relative cost vs LLM-only', pct(mine.cost / baseCost), 'estimate', 'Cost units assume rules ≈ 0, SLM = 1, LLM = 10, specialist RAG = 14, human agent = 20 per request. Real ratios depend on models and token counts; check current pricing.'),
      metric('Average latency', `~${mine.lat} ms`, 'estimate', 'Assumed per-handler latencies (rules 20 ms, SLM 300 ms, LLM 1.5 s, specialist 2.2 s, human queue ~5 min).'),
      metric('This request', one.correct ? 'correct' : 'wrong', 'computed'),
    ],
    summary: `${p.strategy}${p.strategy === 'cascade' ? '@' + p.threshold : p.strategy === 'router' ? '/' + p.routerType : ''} • mix ${mine.acc}/${keys.length} • cost ${pct(mine.cost / baseCost)} of LLM-only`,
  };
}

const N = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.3.4',
  lab: 'Hybrid model router',
  services: [
    { name: 'Model router for Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-router' },
    { name: 'Microsoft Agent Framework workflows', url: 'https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/overview' },
    { name: 'Azure AI Language: conversational language understanding / PII detection', url: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview' },
  ],
  prereqs: ['1.1.1', '2.1.3', '2.3.1'],
  next: ['1.3.1', '2.2.4'],

  concept: {
    plain: 'Not every request needs the biggest model. Simple, predictable requests (password resets, order lookups) are best handled by fixed rules; routine language tasks by a small, cheap model; hard or risky ones by a large model or a human; and domain questions by a specialist flow with the right documents. A router or cascade decides who handles what, trading cost and speed against accuracy and safety.',
    technical: 'Hybrid orchestration combines a deterministic rules engine (regex, keyword and policy rules, PII redaction, escalation rules), small language models, large language models and specialist flows (e.g., RAG over Azure AI Search). Routing options: an intent router (keyword, classifier/SLM, or LLM), Foundry model router (a deployable model that picks an underlying model per prompt), or a confidence cascade that tries a cheaper tier first and escalates below a threshold. Production concerns include fallback on 429 throttling, missing deployments, calibrated confidence thresholds, and keeping safety rules deterministic and first in line.',
    useCase: 'A telco support assistant handles 50,000 messages a day: rules resolve password resets and order lookups, a small model handles routine rescheduling and billing questions, ambiguous or angry messages escalate to a large model and then a human, and contract questions go to a RAG flow over signed MSAs. Card numbers are redacted by rules before any model sees them.',
    terms: [
      ['Rules engine', 'Deterministic logic (regex, keyword, policy) that is cheap, fast, auditable but brittle.'],
      ['Router', 'Component that picks the handler for a request: keyword rules, a classifier/SLM, or an LLM.'],
      ['Cascade', 'Try the cheapest capable tier first; escalate when confidence is below a threshold.'],
      ['Specialist flow', 'A purpose-built pipeline (e.g., RAG with citations) for one domain.'],
      ['Model router (Foundry)', 'A deployable model that routes each prompt to a suitable underlying chat model.'],
      ['Fallback', 'What happens when a tier is unavailable: degrade, queue, or fail.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          N('input', 'Incoming request', 0, 1.5, 'User message plus metadata.', { kind: 'user' }),
          N('rules', 'Rules engine', 1, 0.5, 'PII redaction, escalation rules, deterministic intents.', { kind: 'policy', badge: p ? [p.piiPrecheck && 'PII', p.escalationRules && 'escalation'].filter(Boolean).join('+') || 'basic' : undefined, substeps: ['Redact PII', 'Match deterministic intents', 'Apply escalation rules'] }),
          N('router', p && p.strategy === 'cascade' ? 'Confidence cascade' : 'Router', 1, 2, 'Chooses the handler, or escalates by confidence.', { kind: 'compute', badge: p ? (p.strategy === 'cascade' ? `≥ ${p.threshold}` : p.strategy === 'router' ? p.routerType : p.strategy) : undefined }),
          N('slm', 'Small model', 2.5, 0.5, 'Cheap and fast; good at routine classification and short answers.', { kind: 'ai', disabled: p && !p.slmDeployed }),
          N('llm', 'Large model', 2.5, 1.5, 'Better on ambiguous, multi-issue or sensitive requests.', { kind: 'ai', badge: p && p.llmStatus === 'throttled' ? '429' : undefined }),
          N('specialist', 'Specialist RAG flow', 2.5, 2.5, 'Domain documents + citations.', { kind: 'store', disabled: p && !p.specialistFlow }),
          N('mix', 'Outcome + metrics', 4, 1.5, 'Accuracy, cost and latency across the traffic mix.', { kind: 'data' }),
        ],
        edges: [['input', 'rules'], ['rules', 'router'], ['input', 'router'], ['router', 'slm'], ['router', 'llm'], ['router', 'specialist'], ['slm', 'llm', 'low confidence'], ['slm', 'mix'], ['llm', 'mix'], ['specialist', 'mix'], ['rules', 'mix', 'deterministic']],
      }),
      architectural: p => ({
        nodes: [
          N('input', 'API Management (front door)', 0, 1.5, 'Auth, quotas, request logging.', { kind: 'app' }),
          N('rules', 'Rules service (Functions) + Azure AI Language PII', 1, 0.5, 'Deterministic, versioned rules; PII detection/redaction.', { kind: 'policy' }),
          N('router', 'Orchestrator (Agent Framework workflow / app code)', 1, 2, 'Routing table, thresholds, fallbacks in config.', { kind: 'compute' }),
          N('slm', 'Foundry deployment: small model', 2.5, 0.5, 'E.g., a Phi or mini model deployment.', { kind: 'ai', disabled: p && !p.slmDeployed }),
          N('llm', 'Foundry deployment: large model (or model router)', 2.5, 1.5, 'Rate-limited by TPM/RPM quota.', { kind: 'ai' }),
          N('specialist', 'Azure AI Search + LLM (contract RAG)', 2.5, 2.5, 'Index of signed MSAs with security trimming.', { kind: 'store', disabled: p && !p.specialistFlow }),
          N('mix', 'Application Insights', 4, 1.5, 'Route, handler, confidence, tokens per request.', { kind: 'data' }),
        ],
        edges: [['input', 'rules'], ['rules', 'router'], ['router', 'slm'], ['router', 'llm'], ['router', 'specialist'], ['router', 'mix']],
      }),
      implementation: p => ({
        nodes: [
          N('rules', 'text = redact_pii(text) if PII_RULES else text', 0, 0, 'Deterministic first.', { kind: 'code', disabled: p && !p.piiPrecheck }),
          N('input', 'if m := match_rules(text): return run_flow(m)', 0, 1, 'Password reset, order lookup, escalation keywords.', { kind: 'code' }),
          N('router', p && p.strategy === 'cascade' ? `r = slm(text); if r.confidence < ${p.threshold}: r = llm(text)` : p && p.strategy === 'router' ? `route = ${p.routerType}_router(text)  # → rules | slm | llm | specialist` : 'r = llm(text)', 0, 2, 'Confidence from a calibrated classifier score or structured self-report; calibrate on labelled data.', { kind: 'code' }),
          N('slm', 'slm = client.chat.completions.create(model="slm-deployment", ...)', 1, 0.5, 'Deployment names must exist in the project.', { kind: 'code', disabled: p && !p.slmDeployed }),
          N('llm', `except RateLimitError: ${p ? { fail: 'raise', fallback_slm: 'r = slm(text)', queue_human: 'enqueue_for_agent(text)' }[p.onThrottle] : 'r = slm(text)'}`, 1, 1.5, 'Explicit fallback on 429.', { kind: 'code' }),
          N('specialist', 'answer = contract_rag(text, index="msa-contracts")', 1, 2.5, 'Grounded, cited answer.', { kind: 'code', disabled: p && !p.specialistFlow }),
          N('mix', 'log(route, handler, confidence, usage)', 2, 1.5, 'Feed routing analytics.', { kind: 'code' }),
        ],
        edges: [['rules', 'input'], ['input', 'router'], ['router', 'slm'], ['router', 'llm'], ['router', 'specialist'], ['llm', 'mix']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'input', label: 'Request to trace', type: 'select', options: Object.entries(INPUTS).map(([k, x]) => [k, x.label]), default: 'reschedule' },
      { id: 'strategy', label: 'Orchestration strategy', type: 'select', options: [['llm_only', 'LLM for everything'], ['rules_only', 'Rules engine only'], ['router', 'Intent router'], ['cascade', 'Rules → SLM → LLM cascade']], default: 'llm_only' },
      { id: 'routerType', label: 'Router type (intent router)', type: 'select', options: [['keyword', 'Keyword rules'], ['slm', 'SLM classifier'], ['llm', 'LLM classifier']], default: 'slm' },
      { id: 'threshold', label: 'Cascade escalation threshold', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.7 },
      { id: 'piiPrecheck', label: 'Rules: redact PII before any model', type: 'toggle', default: false },
      { id: 'escalationRules', label: 'Rules: legal / repeat-failure escalation', type: 'toggle', default: false },
      { id: 'specialistFlow', label: 'Specialist contract RAG flow available', type: 'toggle', default: false },
      { id: 'slmDeployed', label: 'SLM deployment exists', type: 'toggle', default: true },
      { id: 'llmStatus', label: 'LLM deployment status', type: 'select', options: [['ok', 'Healthy'], ['throttled', 'Throttled (429)']], default: 'ok' },
      { id: 'onThrottle', label: 'On LLM 429', type: 'select', options: [['fail', 'Fail the request'], ['fallback_slm', 'Fall back to SLM'], ['queue_human', 'Queue for human']], default: 'fail' },
    ],
    samples: [
      { label: 'LLM for everything', values: { strategy: 'llm_only' } },
      { label: 'Rules only', values: { strategy: 'rules_only', input: 'reset_pw' } },
      { label: 'SLM-classifier router with all rules', values: { strategy: 'router', routerType: 'slm', piiPrecheck: true, escalationRules: true, specialistFlow: true, input: 'contract' } },
      { label: 'Cascade on a vague message', values: { strategy: 'cascade', threshold: 0.8, input: 'vague', piiPrecheck: true } },
      { label: 'Throttled LLM with human queue', values: { strategy: 'cascade', input: 'complaint', escalationRules: true, llmStatus: 'throttled', onThrottle: 'queue_human' } },
    ],
    run: runRouter,
  },

  compare: {
    suggestions: [
      'Run the cascade at thresholds 0.5, 0.8 and 0.95 and compare mix accuracy and relative cost.',
      'Compare the intent router with keyword, SLM and LLM classifiers on the vague message.',
      'Trace the contract question with and without the specialist flow; compare correctness under LLM-only and cascade.',
    ],
  },

  debug: [
    { id: 'legal', title: 'Legal threat answered by a bot', values: { strategy: 'cascade', input: 'complaint', threshold: 0.5, escalationRules: false }, node: 'router',
      symptom: 'The angry complaint got an automated refund reply.', cause: 'The SLM\'s 0.55 confidence passes a 0.5 threshold and no escalation rule catches legal keywords.', fix: 'Raise the threshold to ≥ 0.8 and enable the legal/repeat-failure escalation rule.' },
    { id: 'fabricate', title: 'Confident wrong answer about a contract clause', values: { strategy: 'llm_only', input: 'contract', specialistFlow: false }, node: 'specialist',
      symptom: 'A fluent answer about clause 14.2 that does not match the MSA.', cause: 'No model has the contract text; the LLM answers from general knowledge.', fix: 'Enable the specialist contract RAG flow and route contract questions to it (router or cascade strategy).' },
    { id: 'pii', title: 'Card number in model prompts', values: { strategy: 'cascade', input: 'pii', piiPrecheck: false }, node: 'rules',
      symptom: 'Full card number visible in traces.', cause: 'No deterministic redaction before the model call.', fix: 'Enable PII redaction in the rules stage.' },
    { id: 'nodeploy', title: 'Routine requests fail with 404', values: { strategy: 'cascade', input: 'reschedule', slmDeployed: false }, node: 'slm',
      symptom: 'DeploymentNotFound for every SLM-tier request.', cause: 'The orchestrator references an SLM deployment that does not exist.', fix: 'Create the SLM deployment (toggle it on) or correct the deployment name.' },
    { id: 'throttle', title: 'Outage during peak', values: { strategy: 'llm_only', input: 'vague', llmStatus: 'throttled', onThrottle: 'fail' }, node: 'llm',
      symptom: 'Requests fail with 429 and users see errors.', cause: 'All traffic depends on one rate-limited deployment with no fallback.', fix: 'Add a fallback (SLM or human queue) and move routine traffic to cheaper tiers.' },
    { id: 'rulesonly', title: 'Most requests get a canned reply', values: { strategy: 'rules_only', input: 'reschedule' }, node: 'rules',
      symptom: '"Sorry, I did not understand" for natural-language requests.', cause: 'Rules only cover predictable patterns.', fix: 'Use a cascade so unmatched requests go to the SLM and escalate to the LLM.' },
  ],

  challenge: {
    task: 'Handle the whole seven-request mix correctly for at most 60% of the LLM-only cost, with no warnings or errors for the traced request.',
    condition: 'LLM deployment healthy, mix accuracy 7/7, relative cost ≤ 60% of LLM-only, and no warn or error steps.',
    hint: 'Put deterministic rules first, send routine language work to the small model, and escalate only when confidence is low or the domain needs documents.',
    check: (p, res) => p.llmStatus === 'ok' && res.metrics[0].value === '7/7' && parseInt(res.metrics[1].value, 10) <= 60 && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Choose the Rules → SLM → LLM cascade.', 'Enable PII redaction and the escalation rule.', 'Enable the specialist contract RAG flow.', 'Set the threshold to 0.8 (0.55 and 0.62 confidence answers escalate; 0.86+ are accepted). Result: 7/7 at about half the LLM-only cost.'],
    solutionValues: { strategy: 'cascade', threshold: 0.8, piiPrecheck: true, escalationRules: true, specialistFlow: true, slmDeployed: true, llmStatus: 'ok', input: 'reschedule' },
  },

  quiz: [
    { q: '70% of your traffic is password resets and order lookups with fixed formats. What is the most cost-effective handling?', options: ['Send everything to the largest model', 'Deterministic rules/flows for those intents, models for the rest', 'A reasoning model with high effort', 'Fine-tune a model for password resets'], answer: 1, why: 'Predictable requests are cheapest, fastest and most auditable as rules; save models for language-heavy work.' },
    { q: 'A cascade accepts small-model answers above 0.5 confidence, and some angry legal complaints receive automated replies. What should you change?', options: ['Lower the threshold to 0.4', 'Raise the threshold and add a deterministic escalation rule for legal/complaint signals', 'Remove the small model', 'Increase max tokens'], answer: 1, why: 'Thresholds must be calibrated, and safety-critical routing should not depend on model confidence alone.' },
    { q: 'Questions about specific contract clauses get fluent but wrong answers from the LLM. What is the right orchestration change?', options: ['Use a bigger LLM', 'Route contract questions to a specialist RAG flow over the contracts', 'Set temperature to 0', 'Use the rules engine to answer'], answer: 1, why: 'The model lacks the documents; a grounded specialist flow with citations fixes the cause.' },
    { q: 'Your single LLM deployment returns 429 at peak. Which design keeps service available safely?', options: ['Retry immediately in a tight loop', 'Explicit fallback (smaller model for routine requests, human queue for risky ones) plus routing cheap traffic away from the LLM', 'Disable rate limits', 'Return a generic error'], answer: 1, why: 'Fallback paths and offloading routine traffic reduce dependence on the throttled tier.' },
  ],

  recap: 'Use rules for what is predictable and safety-critical (PII, escalations), small models for routine language tasks, large models for hard or ambiguous cases, and specialist flows where documents are needed. Route by intent or cascade by calibrated confidence, plan fallbacks for throttling and missing deployments, and measure accuracy, cost and latency across the real traffic mix.',
};
