// 2.2.6 Integrate monitoring into deployed agents, evaluate agent behavior, and perform error analysis
// Lab: Agent monitoring and error-analysis console.
import { rng, hash, step, metric, pct } from '../src/engine/util.js';

const VERSIONS = {
  v1: { label: 'Travel agent v1 (baseline)', cause: 'rate_limit' },
  v2: { label: 'Travel agent v2 (14 Oct release)', cause: 'schema_mismatch' },
  v3: { label: 'Travel agent v3 (18 Oct release)', cause: 'prompt_regression' },
  v4: { label: 'Travel agent v4 (21 Oct infra change)', cause: 'permission' },
};
const CAUSES = {
  rate_limit: 'Model deployment throttling (429) under load',
  schema_mismatch: 'Tool schema and tool implementation disagree on parameter names',
  prompt_regression: 'Instructions regression: agent no longer follows policy',
  permission: 'Knowledge tool lost permission to the search index',
  model_quality: 'Model is not capable enough for the task',
};
const INTENTS = ['book_trip', 'policy_q', 'change_booking', 'book_trip', 'policy_q', 'smalltalk'];
const TOOL_FOR = { book_trip: 'book_flight', change_booking: 'change_booking', policy_q: 'search_travel_policy', smalltalk: null };
const BATCH = 40;

// Deterministic batch of production runs for a version.
function makeBatch(version) {
  const r = rng('batch|' + version);
  const runs = [];
  for (let i = 0; i < BATCH; i++) {
    const intent = INTENTS[Math.floor(r() * INTENTS.length)];
    const run = { id: `run_${String(i + 1).padStart(3, '0')}`, intent, tool: TOOL_FOR[intent], error: null, toolOk: true, adherent: true, intentScore: 4 + (r() < 0.6 ? 1 : 0), latency: 1800 + Math.round(r() * 2200), tokens: 1400 + Math.round(r() * 1600) };
    const x = r();
    if (version === 'v1' && x < 0.06) { run.error = '429 Too Many Requests (retried)'; run.latency += 6000; }
    if (version === 'v2' && intent === 'book_trip' && x < 0.85) { run.error = '400 tool error: missing required parameter "travel_date"'; run.toolOk = false; run.intentScore = 2; }
    if (version === 'v3' && (intent === 'change_booking' || intent === 'policy_q') && x < 0.6) { run.adherent = false; }
    if (version === 'v4' && intent === 'policy_q') { run.error = '403 Forbidden from search index'; run.intentScore = 2; run.toolOk = false; }
    runs.push(run);
  }
  return runs;
}

function analyse(p) {
  const v = VERSIONS[p.version] ? p.version : 'v1';
  const runs = makeBatch(v);
  const steps = [];
  const sampling = Number(p.sampling);
  const sampled = runs.map(run => (hash(run.id + v) % 1000) / 1000 < sampling);
  const failing = run => run.error || !run.adherent;

  steps.push(step('agent', `${BATCH} production runs of ${VERSIONS[v].label}`, 'Users report "the agent got worse". Find out what happened and why.', { runs: BATCH, intents: [...new Set(runs.map(r => r.intent))] }, 'info'));

  if (p.telemetry === 'none') {
    steps.push(step('otel', 'No telemetry: nothing was traced', 'The agent ran without OpenTelemetry instrumentation or exporter. There are no spans, no token counts, no errors to query, only user complaints.', { exporter: null }, 'error'));
    return finish(p, v, runs, sampled, steps, null);
  }
  steps.push(step('otel', p.telemetry === 'console' ? 'Spans exported to console only' : 'Traces exported to Application Insights', p.telemetry === 'console'
    ? 'Console exporter is fine on a dev box, but production spans scattered across instance logs cannot be queried as one batch. Analysis below uses what one instance printed (the first 10 runs).'
    : 'Agent, model and tool spans (OpenTelemetry GenAI conventions) land in the Application Insights resource connected to the Foundry project.', { exporter: p.telemetry, contentRecording: p.contentRecording, samplingRatio: sampling }, p.telemetry === 'console' ? 'warn' : 'ok'));
  if (p.telemetry === 'console') for (let i = 10; i < BATCH; i++) sampled[i] = false;

  const cap = runs.filter((_, i) => sampled[i]);
  const capFail = cap.filter(failing);
  const errSpans = cap.filter(r => r.error);
  steps.push(step('appinsights', `${cap.length}/${BATCH} runs captured; ${errSpans.length} with error spans`, sampling < 1 ? `Head sampling at ${pct(sampling)} drops traces before you know whether they failed. Tail-based or error-biased sampling keeps failures.` : 'Every run captured.', { captured: cap.length, errorSpans: errSpans.length, sampleErrors: [...new Set(errSpans.map(r => r.error))] }, capFail.length < 5 && runs.filter(failing).length >= 5 ? 'warn' : 'ok'));

  // Evaluators run over captured conversations (thread data), independent of content recording.
  const ev = [];
  if (p.ev_intent) ev.push({ name: 'IntentResolution', pass: cap.filter(r => r.intentScore >= 3).length / Math.max(1, cap.length) });
  if (p.ev_tool) { const withTool = cap.filter(r => r.tool); ev.push({ name: 'ToolCallAccuracy', pass: withTool.filter(r => r.toolOk).length / Math.max(1, withTool.length) }); }
  if (p.ev_task) ev.push({ name: 'TaskAdherence', pass: cap.filter(r => r.adherent).length / Math.max(1, cap.length) });
  steps.push(step('evaluators', ev.length ? `Ran ${ev.length} agent evaluator(s)` : 'No agent evaluators configured', ev.length ? ev.map(e => `${e.name}: ${pct(e.pass)} pass`).join(' • ') : 'Only operational signals (errors, latency, tokens) are available. Silent quality failures stay invisible.', { evaluators: ev.map(e => ({ name: e.name, passRate: Math.round(e.pass * 100) / 100 })) }, ev.length ? 'ok' : 'warn'));

  // Failure clustering
  const label = r => {
    if (p.groupBy === 'intent') return r.intent;
    if (p.groupBy === 'evaluator') return !r.toolOk && p.ev_tool ? 'ToolCallAccuracy fail' : !r.adherent && p.ev_task ? 'TaskAdherence fail' : r.intentScore < 3 && p.ev_intent ? 'IntentResolution fail' : r.error ? 'operational error only' : 'unlabelled';
    return r.error ? r.error.replace(/ \(.*\)/, '').replace(/"[^"]+"/, p.contentRecording || p.ev_tool ? '$&' : '"<redacted>"') : !r.adherent && p.ev_task ? 'no error: policy violation (evaluator)' : 'no error recorded';
  };
  const visibleFail = capFail.filter(r => r.error || (p.ev_task && !r.adherent));
  const clusters = {};
  for (const r of visibleFail) { const k = label(r); clusters[k] = clusters[k] || { n: 0, runs: [] }; clusters[k].n++; clusters[k].runs.push(r.id); }
  const clusterRows = Object.entries(clusters).sort((a, b) => b[1].n - a[1].n);
  steps.push(step('clusters', `${visibleFail.length} visible failures in ${clusterRows.length} cluster(s)`, clusterRows.length ? clusterRows.map(([k, c]) => `${k} (${c.n})`).join(' • ') : 'No failures visible with the current signals.', { groupBy: p.groupBy, clusters: Object.fromEntries(clusterRows.map(([k, c]) => [k, c.n])) }, 'info'));

  // Evidence for each cause given the configured signals
  const truth = VERSIONS[v].cause;
  const evidence = {
    rate_limit: errSpans.some(r => /429/.test(r.error)),
    schema_mismatch: errSpans.some(r => /travel_date/.test(r.error)) && (p.contentRecording || p.ev_tool),
    prompt_regression: p.ev_task && cap.some(r => !r.adherent),
    permission: errSpans.some(r => /403/.test(r.error)),
    model_quality: false,
  };
  const enoughData = capFail.length >= 5 || truth === 'rate_limit';
  let verdict;
  if (p.hypothesis === truth && evidence[truth] && enoughData) {
    verdict = step('verdict', 'Root cause confirmed by evidence', `${CAUSES[truth]}. ${hintFor(truth)}`, { hypothesis: p.hypothesis, evidence: true }, 'ok');
  } else if (p.hypothesis === truth) {
    verdict = step('verdict', 'Right guess, but not provable with current signals', missingFor(truth, p, enoughData), { hypothesis: p.hypothesis, evidence: false }, 'warn');
  } else {
    verdict = step('verdict', 'Evidence does not support this hypothesis', `Nothing in the captured traces or evaluator results points to "${CAUSES[p.hypothesis]}". Look at the largest failure cluster and which signal revealed it.`, { hypothesis: p.hypothesis, evidence: false }, 'warn');
  }
  steps.push(verdict);
  return finish(p, v, runs, sampled, steps, { ev, clusterRows, cap, capFail });
}

function hintFor(c) {
  return { rate_limit: 'Small cluster, retried successfully: raise TPM quota or add backoff, not a release bug.', schema_mismatch: 'Tool spans show 400s and the arguments use "date" while the function requires "travel_date". Align the tool definition with the implementation and add a contract test.', prompt_regression: 'No exceptions at all: TaskAdherence shows the agent offering refunds outside policy after the instructions were trimmed. Restore the constraints and add the evaluator to the release gate.', permission: 'All policy questions fail with 403 after the identity change. Re-assign Search Index Data Reader to the new identity.', model_quality: '' }[c];
}
function missingFor(c, p, enough) {
  if (!enough) return 'Too few failing traces were captured to be sure. Increase sampling (or keep errors with tail-based sampling).';
  if (c === 'schema_mismatch') return 'You can see 400 errors on book_flight, but argument values are redacted and no tool-call evaluator ran. Enable content recording in a controlled environment or run ToolCallAccuracy.';
  if (c === 'prompt_regression') return 'There are no errors to cluster. Only a TaskAdherence-style evaluator detects an agent that answers fluently but breaks policy.';
  return 'Signals are insufficient.';
}

function finish(p, v, runs, sampled, steps, a) {
  const cells = runs.map((r, i) => ({ label: r.id.slice(4), tone: !a || !sampled[i] ? 'muted' : r.error ? 'error' : (!r.adherent && p.ev_task) || (!r.toolOk && p.ev_tool) ? 'warn' : 'ok', v: !a || !sampled[i] ? '·' : r.error ? '✕' : (!r.adherent && p.ev_task) ? '!' : '✓' }));
  const output = [{ type: 'grid', title: 'Batch of runs (✕ error span, ! evaluator failure, · not captured)', cols: 10, cells, caption: `${VERSIONS[v].label}. Grey cells were not traced.` }];
  if (!a) {
    output.push({ type: 'alert', tone: 'error', text: 'Without telemetry the only evidence is anecdotal. Instrument the agent (OpenTelemetry → Application Insights) before you can analyse anything.' });
    return { steps, output, metrics: [metric('Runs captured', `0/${BATCH}`, 'computed')], summary: `${v}: no telemetry` };
  }
  output.push({ type: 'table', title: `Failure clusters (grouped by ${p.groupBy})`, columns: ['Cluster', 'Runs', 'Examples'], rows: a.clusterRows.length ? a.clusterRows.map(([k, c]) => [k, String(c.n), c.runs.slice(0, 3).join(', ')]) : [['(none visible)', '0', '—']], tones: a.clusterRows.length ? a.clusterRows.map(([k]) => /error|fail|40|violation/.test(k) ? 'error' : 'warn') : ['muted'] });
  if (a.ev.length) output.push({ type: 'bars', title: 'Agent evaluator pass rate (captured runs)', threshold: 0.9, items: a.ev.map(e => ({ label: e.name, value: e.pass, tone: e.pass >= 0.9 ? 'ok' : e.pass >= 0.75 ? 'warn' : 'error', note: pct(e.pass) })) });
  const ex = a.capFail[0] || a.cap[0];
  if (ex) output.push({ type: 'json', title: `Example trace ${ex.id} (abridged spans, illustrative attributes)`, data: [
    { name: 'invoke_agent travel-agent', 'gen_ai.operation.name': 'invoke_agent', durationMs: ex.latency, status: ex.error ? 'ERROR' : 'OK' },
    { name: 'chat gpt-4.1', 'gen_ai.usage.input_tokens': Math.round(ex.tokens * 0.8), 'gen_ai.usage.output_tokens': Math.round(ex.tokens * 0.2), ...(p.contentRecording ? { 'gen_ai.input.messages': '[{"role":"user","content":"Book me to Lisbon on 3 Nov"}]' } : {}) },
    ...(ex.tool ? [{ name: `execute_tool ${ex.tool}`, status: ex.error ? 'ERROR' : 'OK', ...(ex.error ? { 'error.type': ex.error } : {}), ...(p.contentRecording ? { 'gen_ai.tool.call.arguments': v === 'v2' && ex.intent === 'book_trip' ? '{"destination":"LIS","date":"2026-11-03"}' : '{"query":"…"}' } : { 'gen_ai.tool.call.arguments': '<not recorded>' }) }] : []),
  ] });
  const verdict = steps.at(-1);
  output.push({ type: 'alert', tone: verdict.status === 'ok' ? 'ok' : 'warn', text: verdict.status === 'ok' ? `Root cause: ${CAUSES[VERSIONS[v].cause]}.` : 'Root cause not confirmed yet. Change the signals you collect or your hypothesis.' });
  const avgLat = Math.round(a.cap.reduce((s, r) => s + r.latency, 0) / Math.max(1, a.cap.length));
  return {
    steps, output,
    metrics: [
      metric('Runs captured', `${a.cap.length}/${BATCH}`, 'computed'),
      metric('Failure rate (captured, visible)', pct(a.capFail.filter(r => r.error || (p.ev_task && !r.adherent)).length / Math.max(1, a.cap.length)), 'computed'),
      metric('Mean run latency', `~${(avgLat / 1000).toFixed(1)} s`, 'estimate', 'Synthetic latencies generated for this batch; not a measurement.'),
      metric('Hypothesis', verdict.status === 'ok' ? 'confirmed' : 'not confirmed', 'computed'),
    ],
    summary: `${v} • ${p.telemetry} • sampling ${pct(Number(p.sampling))} • ${a.ev.length} evaluator(s) • ${verdict.status === 'ok' ? 'root cause found' : 'unconfirmed'}`,
  };
}

const N = (id, label, col, row, detail, extra = {}) => ({ id, label, col, row, detail, ...extra });

export default {
  id: '2.2.6',
  lab: 'Agent monitoring and error-analysis console',
  services: [
    { name: 'Trace agents with OpenTelemetry in Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/metrics' },
    { name: 'Agent evaluators (intent resolution, tool call accuracy, task adherence)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-evaluators/agent-evaluators' },
    { name: 'Evaluate AI agents locally with the Azure AI Evaluation SDK', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/agent-evaluate-sdk' },
  ],
  prereqs: ['2.2.2', '2.1.4', '2.3.3'],
  next: ['1.3.2', '1.4.2'],

  concept: {
    plain: 'Once an agent is live you need to see what it actually did: which tools it called, what failed, how long it took, and whether its answers followed your rules. Traces show the mechanics; evaluators judge the behaviour. Error analysis means grouping failed runs, finding the biggest cluster, and proving its cause with evidence instead of guessing.',
    technical: 'Instrument agents with OpenTelemetry (GenAI semantic conventions: invoke_agent, chat, execute_tool spans with gen_ai.* attributes) and export to the Application Insights resource connected to the Foundry project (e.g., azure-monitor-opentelemetry configure_azure_monitor). Message content recording is opt-in for privacy. Sampling decides which runs are kept. Agent evaluators in azure-ai-evaluation (IntentResolutionEvaluator, ToolCallAccuracyEvaluator, TaskAdherenceEvaluator) score conversations, including thread data converted from Foundry Agent Service, and can run continuously or in CI. Error analysis clusters failures by error type, intent or evaluator and checks hypotheses against evidence.',
    useCase: 'After three releases of a corporate travel agent, users complain. The team queries Application Insights for failed execute_tool spans, runs agent evaluators on a sample of threads, finds that v2 broke the booking tool contract and v3 silently stopped following refund policy, and adds both checks to the release pipeline.',
    terms: [
      ['Span', 'One timed operation in a trace (agent invocation, model call, tool call) with attributes and status.'],
      ['Content recording', 'Opt-in capture of prompts, completions and tool arguments in spans; useful for debugging, sensitive for privacy.'],
      ['Sampling', 'Keeping only a share of traces. Head sampling decides up front; tail sampling can keep all errors.'],
      ['Intent resolution', 'Evaluator: did the agent correctly identify and address what the user wanted?'],
      ['Tool call accuracy', 'Evaluator: were the right tools called with correct arguments?'],
      ['Task adherence', 'Evaluator: did the response follow the assigned task and instructions/policy?'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          N('agent', 'Deployed agent runs', 0, 1.5, 'Real user conversations: the raw material for analysis.', { kind: 'ai', badge: p ? p.version : undefined }),
          N('otel', 'Instrumentation', 1, 0.75, 'OpenTelemetry spans for agent, model and tool calls.', { kind: 'code', badge: p ? p.telemetry : undefined, substeps: ['Create spans', 'Add gen_ai attributes', 'Optionally record content', 'Export'] }),
          N('appinsights', 'Trace store', 2, 0.75, 'Queryable traces with errors, latency, tokens.', { kind: 'store', disabled: p && p.telemetry === 'none', badge: p ? `sample ${pct(Number(p.sampling))}` : undefined }),
          N('evaluators', 'Agent evaluators', 1, 2.25, 'Judge behaviour: intent resolution, tool-call accuracy, task adherence.', { kind: 'policy' }),
          N('clusters', 'Cluster failures', 3, 1.5, 'Group by error type, intent or evaluator to find the biggest problem.', { badge: p ? p.groupBy : undefined }),
          N('verdict', 'Root cause + fix', 4, 1.5, 'Hypothesis confirmed by evidence; fix and add a regression check.', { kind: 'user' }),
        ],
        edges: [['agent', 'otel'], ['otel', 'appinsights'], ['agent', 'evaluators'], ['appinsights', 'clusters'], ['evaluators', 'clusters'], ['clusters', 'verdict']],
      }),
      architectural: p => ({
        nodes: [
          N('agent', 'Foundry Agent Service + app (Container Apps)', 0, 1.5, 'The agent and the code that calls it both emit spans.', { kind: 'compute' }),
          N('otel', 'OpenTelemetry SDK + Azure Monitor exporter', 1, 0.75, `Exporter: ${p ? p.telemetry : 'appinsights'}. Content recording ${p && p.contentRecording ? 'on' : 'off'}.`, { kind: 'code' }),
          N('appinsights', 'Application Insights (connected to Foundry project)', 2, 0.75, 'Foundry portal tracing views read from here; KQL for custom analysis.', { kind: 'store', disabled: p && p.telemetry !== 'appinsights' }),
          N('evaluators', 'Evaluation runs (Foundry / azure-ai-evaluation)', 1, 2.25, 'Batch or continuous evaluation over sampled threads; results in the Foundry project.', { kind: 'ai' }),
          N('clusters', 'Azure Monitor workbook / KQL', 3, 1.5, 'Failure clustering and dashboards; alerts on evaluator pass rates.', { kind: 'app' }),
          N('verdict', 'Release pipeline gate', 4, 1.5, 'Evaluators and contract tests block regressions.', { kind: 'policy' }),
        ],
        edges: [['agent', 'otel'], ['otel', 'appinsights'], ['agent', 'evaluators'], ['appinsights', 'clusters'], ['evaluators', 'clusters'], ['clusters', 'verdict']],
      }),
      implementation: p => ({
        nodes: [
          N('otel', 'configure_azure_monitor(connection_string=project.telemetry.get_application_insights_connection_string())', 0, 0, 'Illustrative; method names vary by SDK version.', { kind: 'code' }),
          N('agent', `os.environ["AZURE_TRACING_GEN_AI_CONTENT_RECORDING_ENABLED"] = "${p && p.contentRecording ? 'true' : 'false'}"`, 0, 1, 'Content recording switch for Azure AI SDK tracing (check current docs for the variable name).', { kind: 'code' }),
          N('appinsights', `sampler = TraceIdRatioBased(${p ? p.sampling : 1})`, 0, 2, 'Head sampling: cheap but can drop failures.', { kind: 'code' }),
          N('evaluators', `evaluators = {${[p && p.ev_intent ? '"intent": IntentResolutionEvaluator(model_config)' : null, p && p.ev_tool ? '"tool": ToolCallAccuracyEvaluator(model_config)' : null, p && p.ev_task ? '"task": TaskAdherenceEvaluator(model_config)' : null].filter(Boolean).join(', ') || ''}}`, 1, 0.5, 'azure-ai-evaluation agent evaluators (AI-assisted, need a judge model config).', { kind: 'code' }),
          N('clusters', 'dependencies | where success == false | summarize count() by name, resultCode', 1, 1.5, 'KQL over Application Insights to cluster failing tool calls (illustrative).', { kind: 'code' }),
          N('verdict', 'evaluate(data="threads.jsonl", evaluators=evaluators)', 1, 2.5, 'Batch evaluation over converted agent threads (illustrative).', { kind: 'code' }),
        ],
        edges: [['otel', 'agent'], ['agent', 'appinsights'], ['evaluators', 'verdict'], ['appinsights', 'clusters']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'version', label: 'Deployed agent version', type: 'select', options: Object.entries(VERSIONS).map(([k, x]) => [k, x.label]), default: 'v1' },
      { id: 'telemetry', label: 'Trace exporter', type: 'select', options: [['none', 'None'], ['console', 'Console (dev)'], ['appinsights', 'Application Insights']], default: 'appinsights' },
      { id: 'contentRecording', label: 'Record message content and tool arguments', type: 'toggle', default: false, help: 'Off by default for privacy.' },
      { id: 'sampling', label: 'Trace sampling ratio', type: 'range', min: 0.1, max: 1, step: 0.1, default: 1 },
      { id: 'ev_intent', label: 'Evaluator: Intent resolution', type: 'toggle', default: true },
      { id: 'ev_tool', label: 'Evaluator: Tool call accuracy', type: 'toggle', default: false },
      { id: 'ev_task', label: 'Evaluator: Task adherence', type: 'toggle', default: false },
      { id: 'groupBy', label: 'Cluster failures by', type: 'select', options: [['error_type', 'Error type'], ['intent', 'User intent'], ['evaluator', 'Failing evaluator']], default: 'error_type' },
      { id: 'hypothesis', label: 'Your root-cause hypothesis', type: 'select', options: Object.entries(CAUSES).map(([k, x]) => [k, x]), default: 'rate_limit' },
    ],
    samples: [
      { label: 'Baseline v1', values: { version: 'v1' } },
      { label: 'v2 with tool-call evaluator', values: { version: 'v2', ev_tool: true, hypothesis: 'schema_mismatch' } },
      { label: 'v3 with only intent resolution', values: { version: 'v3' } },
      { label: 'v4 grouped by intent', values: { version: 'v4', groupBy: 'intent', hypothesis: 'permission' } },
    ],
    run: analyse,
  },

  compare: {
    suggestions: [
      'Run v3 with only Intent resolution, then add Task adherence; compare visible failures.',
      'Run v2 at sampling 1.0 and 0.2; compare how many failing traces are captured.',
      'Run v4 grouped by error type, then by intent; which grouping makes the cause obvious faster?',
    ],
  },

  debug: [
    { id: 'notrace', title: 'Nothing to analyse', values: { version: 'v2', telemetry: 'none' }, node: 'otel',
      symptom: 'Users complain but there are no traces or errors to query.', cause: 'The agent is not instrumented or has no exporter.', fix: 'Export OpenTelemetry traces to Application Insights connected to the Foundry project.' },
    { id: 'console', title: 'Only a handful of runs visible', values: { version: 'v4', telemetry: 'console', hypothesis: 'permission' }, node: 'appinsights',
      symptom: 'Analysis covers 10 runs from one instance.', cause: 'Console exporter is a development tool; production spans are not centralised.', fix: 'Switch the exporter to Application Insights.' },
    { id: 'sampling', title: 'Failures disappear at low sampling', values: { version: 'v2', sampling: 0.1, ev_tool: true, hypothesis: 'schema_mismatch' }, node: 'appinsights',
      symptom: 'Too few failing traces to confirm the cause.', cause: 'Head sampling drops most traces before you know they failed.', fix: 'Raise sampling (here: 1.0), or in production keep all error traces with tail-based sampling.' },
    { id: 'silent', title: '"No errors" but users say the agent breaks policy', values: { version: 'v3', hypothesis: 'prompt_regression' }, node: 'evaluators',
      symptom: 'Zero error spans; complaints continue.', cause: 'The failure is behavioural, not operational. Only a task-adherence evaluator detects it.', fix: 'Enable the Task adherence evaluator.' },
    { id: 'redacted', title: 'Tool fails with 400 but cause unclear', values: { version: 'v2', contentRecording: false, ev_tool: false, hypothesis: 'schema_mismatch' }, node: 'clusters',
      symptom: 'Cluster shows book_flight 400 errors with redacted parameter names.', cause: 'No content recording and no tool-call evaluator: you cannot see which arguments were sent.', fix: 'Enable Tool call accuracy (or content recording in a controlled environment).' },
    { id: 'wrong', title: 'Blaming the model', values: { version: 'v4', hypothesis: 'model_quality' }, node: 'verdict',
      symptom: 'Hypothesis not supported by evidence.', cause: 'Every failing run is a policy question with a 403 from the search tool: an infrastructure problem.', fix: 'Set the hypothesis to the permission problem (and fix the role assignment).' },
  ],

  challenge: {
    task: 'Agent v3 has no errors in its traces, yet customers complain. Confirm the root cause with evidence.',
    condition: 'Version = v3, the verdict step confirms the hypothesis, and the run has no warn or error steps.',
    hint: 'Operational telemetry is clean. Which signal measures whether the agent follows its instructions?',
    check: (p, res) => p.version === 'v3' && res.steps.some(s => s.node === 'verdict' && s.status === 'ok') && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Select v3 and keep Application Insights with sampling 1.0.', 'Enable the Task adherence evaluator.', 'Group by Failing evaluator to see the cluster.', 'Set the hypothesis to "Instructions regression" and run.'],
    solutionValues: { version: 'v3', telemetry: 'appinsights', sampling: 1, ev_task: true, ev_intent: true, groupBy: 'evaluator', hypothesis: 'prompt_regression' },
  },

  quiz: [
    { q: 'A deployed agent shows no errors in Application Insights, but users report it promises refunds that policy forbids. What should you add?', options: ['Higher trace sampling', 'A task adherence evaluator over sampled conversations', 'Content recording only', 'A larger model'], answer: 1, why: 'Behavioural failures do not raise exceptions. Task adherence evaluates whether responses follow instructions and policy.' },
    { q: 'You need prompts and tool arguments in traces to debug a tool error, but production data is sensitive. What is the best approach?', options: ['Always enable content recording in production', 'Keep content recording off in production; enable it in a controlled environment or rely on evaluators over approved data', 'Disable tracing entirely', 'Log prompts to a public storage account'], answer: 1, why: 'Content recording is opt-in for privacy; use it deliberately, with access controls, or use other evidence.' },
    { q: 'With 10% head sampling you rarely capture the failing runs of a rare error. What helps most?', options: ['Tail-based / error-biased sampling that keeps failed traces', 'Lowering sampling further', 'Removing evaluators', 'Switching to the console exporter'], answer: 0, why: 'Head sampling decides before the outcome is known; tail sampling keeps interesting (failed or slow) traces.' },
    { q: 'Failing runs cluster on execute_tool book_flight with HTTP 400 "missing travel_date" right after a release. What is the most likely root cause?', options: ['Rate limiting', 'Tool definition and implementation disagree on parameter names', 'Search index permissions', 'Model temperature'], answer: 1, why: 'A 400 for a missing required parameter after a release points to a contract mismatch between the tool schema the model sees and the API.' },
  ],

  recap: 'Instrument agents with OpenTelemetry and export to Application Insights, sample so failures survive, record content only deliberately, and run agent evaluators (intent resolution, tool call accuracy, task adherence) to catch silent failures. Cluster failures, test hypotheses against evidence, then turn the fix into a regression check.',
};
