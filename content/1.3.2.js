// 1.3.2 Monitor model performance, drift, safety events, and grounding quality
// Lab: Production model monitor.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

const WEEKS = 8;

// Healthy baseline for a RAG assistant in production (illustrative values on the evaluator scales).
const BASE = { groundedness: 4.4, relevance: 4.3, safety: 2, latency: 2400, drift: 0.06, tokens: 310 };
// Per-signal noise at a 10% evaluation sampling rate.
const SD = { groundedness: 0.08, relevance: 0.08, safety: 0.6, latency: 150, drift: 0.02, tokens: 10 };

const INCIDENTS = {
  none: { label: 'No incident (healthy baseline)', effect: {} },
  modelVersion: { label: 'Model version auto-upgraded', effect: { groundedness: -0.6, relevance: -0.1, latency: -300, tokens: 130 }, version: true,
    story: 'The deployment was set to auto-update and moved to a newer model version. Answers got longer and more often added unsupported detail.' },
  indexStale: { label: 'Search index stopped refreshing', effect: { groundedness: -1.0, relevance: -0.6 },
    story: 'The indexer started failing silently. Policies changed but the index still serves last month\'s documents, so answers cite stale or missing content.' },
  inputDrift: { label: 'New user population (input drift)', effect: { drift: 0.32, relevance: -0.7, groundedness: -0.25, tokens: 40 },
    story: 'A new market launched. Users ask about products and in phrasing the assistant was never tested on.' },
  jailbreakWave: { label: 'Coordinated jailbreak attempts', effect: { safety: 11, drift: 0.08 },
    story: 'A forum post shared a jailbreak prompt. Many users try it; content filters and prompt shields annotate the attempts.' },
  latency: { label: 'Downstream tool latency regression', effect: { latency: 3600 },
    story: 'A tool the assistant calls (order-status API) slowed down after a release. Model quality is unchanged.' },
};

const SIGNALS = [
  { id: 'groundedness', label: 'Groundedness (1–5)', node: 'eval', dir: -1, needsJudge: true },
  { id: 'relevance', label: 'Relevance (1–5)', node: 'eval', dir: -1, needsJudge: true },
  { id: 'safety', label: 'Safety events / 1k req', node: 'safety', dir: 1 },
  { id: 'latency', label: 'p95 latency (ms)', node: 'traces', dir: 1 },
  { id: 'drift', label: 'Input drift score (0–1)', node: 'drift', dir: 1 },
  { id: 'tokens', label: 'Output tokens / response', node: 'traces', dir: 0 },
];

function thresholdOf(p, id) {
  return { groundedness: p.qualityThreshold, relevance: p.qualityThreshold, safety: p.safetyThreshold, latency: p.latencyThreshold, drift: p.driftThreshold }[id];
}

function monitor(p) {
  const inc = INCIDENTS[p.incident] || INCIDENTS.none;
  const r = rng(`${p.incident}|${p.incidentWeek}|${p.sampleRate}`);
  const steps = [];
  const noiseMul = Math.sqrt(10 / clamp(p.sampleRate, 1, 100));
  const judge = p.judgeModel !== 'none';

  steps.push(step('app', 'Production traffic', `A RAG support assistant serves ~50,000 requests per week for ${WEEKS} weeks. ${p.incident === 'none' ? 'No incident injected.' : `Hidden incident starts in week ${p.incidentWeek}. Your job: notice it and diagnose it.`}`,
    { weeks: WEEKS, requestsPerWeek: 50000, incidentInjected: p.incident !== 'none' }, 'info'));

  if (!p.appInsights) {
    steps.push(step('traces', 'No telemetry collected', 'No Application Insights resource is connected to the Foundry project, so traces, token usage, latency and evaluation results are never stored. The monitoring dashboard is empty and no alert can fire.',
      { applicationInsights: null, tracesStored: 0 }, 'error'));
    return {
      steps,
      output: [{ type: 'alert', tone: 'error', text: 'Nothing to monitor. Connect Application Insights to the Foundry project (and instrument the app with OpenTelemetry tracing) before you can see quality, safety or latency signals.' }],
      metrics: [metric('Signals available', '0/6', 'computed')],
      summary: 'No telemetry: Application Insights not connected',
    };
  }

  // Generate weekly series
  const series = {};
  for (const s of SIGNALS) {
    series[s.id] = [];
    for (let w = 1; w <= WEEKS; w++) {
      const active = p.incident !== 'none' && w >= p.incidentWeek;
      const sd = s.id === 'latency' || s.id === 'tokens' || s.id === 'safety' ? SD[s.id] : SD[s.id] * noiseMul;
      let v = BASE[s.id] + (r() - 0.5) * 2 * sd * 1.6 + (active ? (inc.effect[s.id] || 0) : 0);
      if (s.id === 'groundedness' || s.id === 'relevance') v = clamp(v, 1, 5);
      if (s.id === 'drift') v = clamp(v, 0, 1);
      if (s.id === 'safety') v = Math.max(0, v);
      series[s.id].push(s.needsJudge && !judge ? null : round(v, s.id === 'latency' || s.id === 'tokens' ? 0 : 2));
    }
  }

  steps.push(step('traces', 'Traces collected (OpenTelemetry → Application Insights)', `Each request is a trace with model, deployment, token usage and latency. Model version seen in traces: ${inc.version ? `v1 until week ${p.incidentWeek - 1}, then v2` : 'v1 throughout'}.`,
    { spansPerRequest: '4–7 (illustrative)', modelVersion: inc.version ? ['v1', 'v2'] : ['v1'], p95LatencyMs: series.latency, outputTokensPerResponse: series.tokens }));

  const evaluated = Math.round(50000 * p.sampleRate / 100);
  steps.push(step('eval', judge ? 'Continuous evaluation on sampled traces' : 'Quality evaluators skipped',
    judge ? `${evaluated.toLocaleString('en-US')} traces/week (${p.sampleRate}%) scored by AI-assisted groundedness and relevance evaluators using the ${p.judgeModel} judge deployment.${p.sampleRate < 5 ? ' Very small samples make weekly means noisy.' : ''}`
      : 'Groundedness and relevance are AI-assisted evaluators: they need a judge model deployment. None is configured, so these signals are blank.',
    { sampled: evaluated, evaluators: judge ? ['groundedness', 'relevance'] : [], groundedness: series.groundedness, relevance: series.relevance },
    judge ? (p.sampleRate < 5 ? 'warn' : 'ok') : 'warn'));

  steps.push(step('safety', 'Safety signals', 'Content filter annotations and prompt-shield detections per 1,000 requests, aggregated weekly.', { safetyEventsPer1k: series.safety }));
  steps.push(step('drift', 'Input drift', 'Compares this week\'s query topic/embedding distribution with the evaluation baseline (a toy divergence score in this simulation).', { driftScore: series.drift }));

  // Alerts
  const alerts = [];
  for (const s of SIGNALS) {
    const th = thresholdOf(p, s.id);
    if (th === undefined) continue;
    series[s.id].forEach((v, i) => {
      if (v == null) return;
      if ((s.dir < 0 && v < th) || (s.dir > 0 && v > th)) alerts.push({ week: i + 1, signal: s.id, value: v, threshold: th });
    });
  }
  const preIncident = p.incident === 'none' ? alerts : alerts.filter(a => a.week < p.incidentWeek);
  const postIncident = p.incident === 'none' ? [] : alerts.filter(a => a.week >= p.incidentWeek);
  const firstDetect = postIncident.length ? Math.min(...postIncident.map(a => a.week)) : null;
  const lag = firstDetect == null ? null : firstDetect - p.incidentWeek;
  const missed = p.incident !== 'none' && firstDetect == null;
  steps.push(step('alerts', missed ? 'Incident not detected' : alerts.length ? `${alerts.length} alert(s) fired` : 'No alerts',
    missed ? `Something changed in week ${p.incidentWeek}, but no alert rule crossed its threshold${!judge ? ' (quality signals are blank without a judge model)' : ''}. Users notice before you do.`
      : `${postIncident.length} alert(s) after the incident${firstDetect != null ? ` (first in week ${firstDetect}, lag ${lag} week(s))` : ''}; ${preIncident.length} false alarm(s)${preIncident.length && p.sampleRate < 5 ? ': low sampling makes weekly means noisy' : ''}.`,
    { alerts, falseAlarms: preIncident.length, detectionLagWeeks: lag },
    missed || preIncident.length > 1 ? 'warn' : preIncident.length ? 'warn' : 'ok'));

  // Triage
  let triageStatus = 'info', triageText;
  if (p.diagnosis === 'none') triageText = alerts.length ? 'Alerts are firing. Compare which signals moved together and pick a diagnosis.' : 'Nothing to triage yet.';
  else if (p.diagnosis === p.incident) { triageStatus = 'ok'; triageText = `Correct. ${inc.story}`; }
  else {
    triageStatus = 'warn';
    triageText = `Not quite. Look at which signals moved: ${p.incident === 'none' ? 'nothing actually changed; you may be reacting to noise.' : SIGNALS.filter(s => INCIDENTS[p.incident].effect[s.id]).map(s => s.label).join(', ') + ' changed.'}`;
  }
  steps.push(step('triage', 'Diagnosis', triageText, { yourDiagnosis: p.diagnosis, matches: p.diagnosis === p.incident }, triageStatus));

  const alertKey = new Set(alerts.map(a => `${a.signal}|${a.week}`));
  const weekCols = Array.from({ length: WEEKS }, (_, i) => `W${i + 1}`);
  const output = [
    { type: 'table', title: 'Weekly monitoring dashboard (red = alert threshold crossed)', columns: ['Signal', 'Threshold', ...weekCols],
      rows: SIGNALS.map(s => [s.label, thresholdOf(p, s.id) === undefined ? '—' : `${s.dir < 0 ? '<' : '>'} ${thresholdOf(p, s.id)}`, ...series[s.id].map(v => v == null ? '—' : String(v))]),
      tones: SIGNALS.map(s => alerts.some(a => a.signal === s.id) ? 'error' : series[s.id][0] == null ? 'warn' : 'ok') },
    { type: 'grid', title: 'Alert heatmap (rows = signals, columns = weeks)', cols: WEEKS,
      cells: SIGNALS.flatMap(s => series[s.id].map((v, i) => ({ v: v == null ? '—' : v, tone: alertKey.has(`${s.id}|${i + 1}`) ? 'error' : v == null ? 'muted' : 'ok', label: `${s.label} W${i + 1}` }))),
      caption: `Rows: ${SIGNALS.map(s => s.label).join(' · ')}` },
  ];
  if (judge) output.push({ type: 'bars', title: 'Groundedness by week (line = your threshold)', threshold: p.qualityThreshold / 5,
    items: series.groundedness.map((v, i) => ({ label: `W${i + 1}`, value: v / 5, note: String(v), tone: v < p.qualityThreshold ? 'error' : 'ok' })) });
  if (alerts.length) output.push({ type: 'json', title: 'First alert payload (Azure Monitor-style, abridged, illustrative)', data: {
    alertRule: `rag-${alerts[0].signal}-threshold`, severity: alerts[0].signal === 'safety' ? 'Sev1' : 'Sev2', signalType: 'Log search',
    condition: { metric: alerts[0].signal, operator: SIGNALS.find(s => s.id === alerts[0].signal).dir < 0 ? 'LessThan' : 'GreaterThan', threshold: alerts[0].threshold, observed: alerts[0].value }, window: `week ${alerts[0].week}` } });
  if (missed) output.push({ type: 'alert', tone: 'warn', text: 'An incident is hidden in this data but no alert fired. Check thresholds, the judge model and the sampling rate.' });
  if (p.diagnosis !== 'none' && p.diagnosis === p.incident && p.incident !== 'none') output.push({ type: 'alert', tone: 'ok', text: inc.story });

  return {
    steps, output,
    metrics: [
      metric('Detection lag', lag == null ? (missed ? 'missed' : 'n/a') : `${lag} week(s)`, 'computed'),
      metric('False alarms', String(preIncident.length), 'computed', 'Alerts before the incident (or any alert when there is no incident).'),
      metric('Signals available', `${SIGNALS.filter(s => series[s.id][0] != null).length}/${SIGNALS.length}`, 'computed'),
      metric('Evaluation cost', p.sampleRate <= 10 ? 'low' : p.sampleRate <= 30 ? 'moderate' : 'high', 'estimate', 'AI-assisted evaluators call a judge model per sampled trace, so cost grows roughly linearly with sampling rate. No prices are implied.'),
    ],
    summary: `${inc.label}: ${missed ? 'missed' : lag != null ? `detected, lag ${lag}w` : 'no incident'}, ${preIncident.length} false alarm(s), sampling ${p.sampleRate}%`,
  };
}

export default {
  id: '1.3.2',
  lab: 'Production model monitor',
  services: [
    { name: 'Monitor generative AI applications (Foundry observability)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/monitor-applications' },
    { name: 'Observability in generative AI', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/observability' },
    { name: 'Monitor Azure OpenAI', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/monitor-openai' },
    { name: 'Azure Monitor alerts', url: 'https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-overview' },
  ],
  prereqs: ['1.3.1', '2.1.4'],
  next: ['1.3.3', '2.3.3', '2.2.6'],

  concept: {
    plain: 'A model that worked on launch day can quietly get worse: the questions people ask change, the documents it relies on go out of date, a model update changes its style, or attackers start probing it. Monitoring means continuously measuring a few health signals on real traffic (are answers grounded and relevant? how many safety events? how fast?) and alerting when a signal crosses a line, so you find problems before users do and can tell which part broke.',
    technical: 'In Microsoft Foundry, apps are instrumented with OpenTelemetry tracing that exports to the Application Insights resource connected to the project. Traces carry model/deployment, token usage and latency. Continuous evaluation runs AI-assisted evaluators (groundedness, relevance, coherence) and safety evaluators over a sample of production traces using a judge model deployment, and results appear in the Foundry monitoring dashboards and Log Analytics. Content filter annotations and prompt-shield detections provide safety-event counts. Drift is detected by comparing input distributions (topics, embeddings, languages) against a baseline. Azure Monitor alert rules on metrics or log queries notify on threshold breaches. Sampling rate trades evaluation cost against signal noise. Pinning model versions (or controlling auto-update) avoids silent behaviour changes.',
    useCase: 'An insurer runs a claims-help assistant. Week 5 groundedness drops from 4.4 to 3.4 while relevance also falls; token counts and model version are unchanged and drift is flat. The on-call engineer reads the pattern as a retrieval problem, checks the indexer and finds it has been failing since a storage permission change.',
    terms: [
      ['Groundedness', 'Whether the response is supported by the retrieved context. AI-assisted evaluator, typically scored 1–5.'],
      ['Drift', 'A change in the distribution of inputs (or outputs) compared with the baseline the system was evaluated on.'],
      ['Continuous evaluation', 'Running evaluators on a sample of live traces on a schedule, rather than only before release.'],
      ['Safety event', 'A content-filter or prompt-shield annotation (e.g. jailbreak detected, violence medium) on a request or response.'],
      ['Detection lag', 'Time between a problem starting and an alert firing.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'app', label: 'Live traffic', col: 0, row: 1, kind: 'user', detail: 'Real user requests to the assistant.' },
          { id: 'traces', label: p && !p.appInsights ? 'Traces (not stored!)' : 'Traces', col: 1, row: 1, kind: 'data', badge: p && !p.appInsights ? 'off' : undefined, detail: 'Per-request record: model, version, tokens, latency, tool calls.' },
          { id: 'eval', label: p ? `Quality evaluators (${p.sampleRate}% sample)` : 'Quality evaluators', col: 2, row: 0, kind: 'ai', disabled: p && p.judgeModel === 'none', detail: 'Groundedness and relevance scored by a judge model on sampled traces.', substeps: ['Sample traces', 'Call judge model', 'Score 1–5 + reason', 'Aggregate weekly'] },
          { id: 'safety', label: 'Safety signals', col: 2, row: 1, kind: 'policy', detail: 'Content filter and prompt shield annotations, safety evaluators.' },
          { id: 'drift', label: 'Drift detector', col: 2, row: 2, kind: 'compute', detail: 'Compares input distribution with baseline.' },
          { id: 'alerts', label: 'Alert rules', col: 3, row: 1, kind: 'policy', detail: 'Thresholds per signal; fire notifications.' },
          { id: 'triage', label: 'Triage / diagnosis', col: 4, row: 1, kind: 'user', detail: 'Read which signals moved together to find the root cause.' },
        ],
        edges: [['app', 'traces'], ['traces', 'eval'], ['traces', 'safety'], ['traces', 'drift'], ['eval', 'alerts'], ['safety', 'alerts'], ['drift', 'alerts'], ['alerts', 'triage']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'app', label: 'App / agent (OpenTelemetry instrumented)', col: 0, row: 1, kind: 'app', detail: 'Uses Foundry/OpenAI SDK tracing instrumentation.' },
          { id: 'traces', label: 'Application Insights (connected to Foundry project)', col: 1, row: 1, kind: 'store', disabled: p && !p.appInsights, detail: 'Stores traces; backed by a Log Analytics workspace.' },
          { id: 'eval', label: p ? `Continuous evaluation (judge: ${p.judgeModel})` : 'Continuous evaluation', col: 2, row: 0, kind: 'ai', disabled: p && p.judgeModel === 'none', detail: 'Scheduled evaluation of sampled traces in the Foundry project.' },
          { id: 'safety', label: 'Content Safety annotations', col: 2, row: 1, kind: 'policy', detail: 'Filter results on prompts and completions.' },
          { id: 'drift', label: 'Log Analytics query (drift)', col: 2, row: 2, kind: 'compute', detail: 'KQL comparing topic/embedding buckets week over week (custom).' },
          { id: 'alerts', label: 'Azure Monitor alert rules + action group', col: 3, row: 1, kind: 'policy', detail: 'Metric or log-search alerts route to email/Teams/ITSM.' },
          { id: 'triage', label: 'Foundry monitoring dashboard / workbook', col: 4, row: 1, kind: 'app', detail: 'Where on-call compares signals.' },
        ],
        edges: [['app', 'traces', 'OTLP'], ['traces', 'eval'], ['traces', 'safety'], ['traces', 'drift'], ['eval', 'alerts'], ['safety', 'alerts'], ['drift', 'alerts'], ['alerts', 'triage']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'app', label: 'configure_azure_monitor(connection_string=project_app_insights_conn)', col: 0, row: 0, kind: 'code', detail: 'azure-monitor-opentelemetry. In Foundry you can fetch the connection string from the project (illustrative).' },
          { id: 'traces', label: 'OpenAIInstrumentor().instrument()  # gen_ai.* spans', col: 0, row: 1, kind: 'code', detail: 'Emits GenAI semantic-convention spans (model, tokens, latency). Package names vary; illustrative.' },
          { id: 'eval', label: `GroundednessEvaluator(model_config=judge)  # sample ${p ? p.sampleRate : 10}%`, col: 0, row: 2, kind: 'code', detail: 'azure-ai-evaluation evaluator; continuous evaluation schedules are configured in the Foundry project.' },
          { id: 'safety', label: 'prompt_filter_results / content_filter_results', col: 0, row: 3, kind: 'code', detail: 'Annotations returned with each response; log them as span attributes.' },
          { id: 'drift', label: 'KQL: compare topic distribution, this week vs baseline', col: 0, row: 4, kind: 'code', detail: 'Custom query in Log Analytics.' },
          { id: 'alerts', label: `az monitor scheduled-query create ... threshold ${p ? p.qualityThreshold : 4}`, col: 0, row: 5, kind: 'code', detail: 'Log-search alert on evaluation results (illustrative).' },
          { id: 'triage', label: 'Workbook: signals side by side', col: 0, row: 6, kind: 'code', detail: 'Compare correlated movements.' },
        ],
        edges: [['app', 'traces'], ['traces', 'eval'], ['traces', 'safety'], ['traces', 'drift'], ['eval', 'alerts'], ['alerts', 'triage']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'incident', label: 'Hidden incident to inject', type: 'select', options: Object.entries(INCIDENTS).map(([v, x]) => [v, x.label]), default: 'modelVersion', help: 'In a real system you would not know this. Inject one, then try to detect and diagnose it.' },
      { id: 'incidentWeek', label: 'Incident starts in week', type: 'range', min: 2, max: 7, step: 1, default: 5 },
      { id: 'appInsights', label: 'Application Insights connected to project', type: 'toggle', default: true },
      { id: 'judgeModel', label: 'Judge model for AI-assisted evaluators', type: 'select', options: [['gpt-4o-mini', 'gpt-4o-mini deployment'], ['gpt-4o', 'gpt-4o deployment'], ['none', 'None configured']], default: 'gpt-4o-mini' },
      { id: 'sampleRate', label: 'Evaluation sampling rate (%)', type: 'range', min: 1, max: 100, step: 1, default: 10 },
      { id: 'qualityThreshold', label: 'Alert if groundedness / relevance below', type: 'range', min: 3, max: 4.5, step: 0.1, default: 3.6 },
      { id: 'safetyThreshold', label: 'Alert if safety events per 1k above', type: 'range', min: 2, max: 20, step: 1, default: 6 },
      { id: 'latencyThreshold', label: 'Alert if p95 latency above (ms)', type: 'range', min: 2000, max: 10000, step: 250, default: 5000 },
      { id: 'driftThreshold', label: 'Alert if drift score above', type: 'range', min: 0.1, max: 0.6, step: 0.05, default: 0.25 },
      { id: 'diagnosis', label: 'Your diagnosis', type: 'select', options: [['none', 'Not diagnosed yet'], ...Object.entries(INCIDENTS).filter(([k]) => k !== 'none').map(([v, x]) => [v, x.label])], default: 'none' },
    ],
    samples: [
      { label: 'Healthy baseline', values: { incident: 'none' } },
      { label: 'Stale index from week 4', values: { incident: 'indexStale', incidentWeek: 4 } },
      { label: 'Jailbreak wave', values: { incident: 'jailbreakWave', incidentWeek: 3 } },
      { label: 'New market (input drift)', values: { incident: 'inputDrift', incidentWeek: 6 } },
      { label: 'Tool latency regression', values: { incident: 'latency', incidentWeek: 5 } },
    ],
    run: monitor,
  },

  compare: {
    suggestions: [
      'Inject the stale index and the model upgrade in turn: which signals move in each case, and which stay flat?',
      'Run the healthy baseline at 1% and at 20% sampling and compare false alarms.',
      'Raise the groundedness threshold from 3.6 to 4.2 with the model-upgrade incident and compare detection lag and false alarms.',
    ],
  },

  debug: [
    { id: 'noai', title: 'Dashboard is completely empty', values: { appInsights: false }, node: 'traces',
      symptom: 'No traces, no evaluation results, no alerts.', cause: 'No Application Insights resource is connected to the Foundry project, so telemetry has nowhere to go.', fix: 'Connect Application Insights to the project and instrument the app (turn the toggle on).' },
    { id: 'nojudge', title: 'Groundedness never alerts', values: { incident: 'indexStale', judgeModel: 'none' }, node: 'eval',
      symptom: 'Users complain about wrong answers, but groundedness and relevance columns are blank.', cause: 'AI-assisted evaluators need a judge model deployment; none is configured.', fix: 'Configure a judge model (e.g. gpt-4o-mini) for continuous evaluation.' },
    { id: 'noise', title: 'Alerts every week with nothing wrong', values: { incident: 'none', sampleRate: 1, qualityThreshold: 4.3 }, node: 'alerts',
      symptom: 'Frequent groundedness alerts that on-call cannot reproduce.', cause: 'At 1% sampling, weekly means are noisy, and the threshold sits too close to the healthy baseline.', fix: 'Raise sampling to ~10–20% and set the threshold with headroom below the baseline (e.g. 3.6–3.8).' },
    { id: 'loose', title: 'Model upgrade goes unnoticed', values: { incident: 'modelVersion', qualityThreshold: 3.2 }, node: 'alerts',
      symptom: 'Answers became longer and less grounded after week 5, but no alert fired.', cause: 'The quality threshold is too loose to catch a 0.6-point drop.', fix: 'Tighten the groundedness threshold (≈4.0) and pin model versions or control auto-update.' },
    { id: 'misdiag', title: 'Wrong root cause', values: { incident: 'indexStale', diagnosis: 'modelVersion' }, node: 'triage',
      symptom: 'Team rolls back the model, but groundedness stays low.', cause: 'Model version and token counts did not change; groundedness and relevance fell together, which points at retrieval.', fix: 'Set the diagnosis to the stale index and check indexer health.' },
  ],

  challenge: {
    task: 'The deployment silently auto-upgrades its model version in week 5. Configure monitoring so the change is detected in week 5 itself, with zero false alarms, at no more than 20% sampling, and correctly diagnosed.',
    condition: 'incident = model version auto-upgraded, start week 5, sampling ≤ 20%, detection lag 0, false alarms 0, diagnosis correct.',
    hint: 'The upgrade lowers groundedness by about 0.6 from a 4.4 baseline. With the default threshold of 3.6 it is missed. How much headroom does noise at your sampling rate need?',
    check: (p, res) => {
      const a = res.steps.find(s => s.node === 'alerts');
      const t = res.steps.find(s => s.node === 'triage');
      return p.incident === 'modelVersion' && p.incidentWeek === 5 && p.sampleRate <= 20 && !!a && a.data.detectionLagWeeks === 0 && a.data.falseAlarms === 0 && !!t && t.data.matches;
    },
    solution: ['Incident: Model version auto-upgraded, week 5.', 'Keep a judge model (gpt-4o-mini) and sampling at 10%.', 'Set the quality threshold to 4.0: below the noisy healthy band (~4.3–4.5) but above the degraded level (~3.8).', 'Diagnose: groundedness fell while output tokens per response jumped and traces show a new model version → model upgrade. Pin the version and evaluate upgrades before switching.'],
    solutionValues: { incident: 'modelVersion', incidentWeek: 5, judgeModel: 'gpt-4o-mini', sampleRate: 10, qualityThreshold: 4, appInsights: true, diagnosis: 'modelVersion' },
  },

  quiz: [
    { q: 'Groundedness falls from 4.4 to 3.4 in one week. Relevance also drops; drift, token counts and model version are unchanged. What should you check first?', options: ['Roll back the model version', 'Indexer and data freshness of the retrieval index', 'Increase TPM quota', 'Tighten the content filter'], answer: 1, why: 'Quality fell with no change in model, style or inputs, which points at retrieval: the model is answering from stale or missing context.' },
    { q: 'You enable continuous evaluation but groundedness results never appear, while latency and token metrics do. What is the most likely cause?', options: ['Application Insights is not connected', 'No judge model deployment is configured for the AI-assisted evaluators', 'The sampling rate is 10%', 'Prompt shields are disabled'], answer: 1, why: 'Traces are flowing (latency appears), but AI-assisted evaluators need a model to act as judge.' },
    { q: 'Your groundedness alert fires most weeks even though spot checks look fine. Evaluation samples 1% of traffic and the threshold is 4.3 with a baseline of 4.4. What do you change?', options: ['Disable the alert', 'Increase sampling and leave headroom between threshold and baseline', 'Switch to a larger chat model', 'Lower the safety threshold'], answer: 1, why: 'Small samples make weekly means noisy; a threshold right under the baseline turns noise into alerts.' },
    { q: 'After a silent change in answer style, you discover the deployment moved to a newer model version. How do you prevent unnoticed changes in future?', options: ['Pin the model version / control auto-update and evaluate new versions before switching', 'Increase max_tokens', 'Use API keys instead of Entra ID', 'Reduce sampling rate'], answer: 0, why: 'Controlling version upgrades and evaluating before rollout avoids silent behaviour drift.' },
  ],

  recap: 'Instrument with OpenTelemetry into the project\'s Application Insights, run continuous evaluation with a judge model on a sensible sample, track safety events, latency and input drift, and alert with thresholds that leave headroom. Diagnose by which signals move together: quality-only drops point at retrieval, drift plus relevance at new inputs, style plus tokens at a model change.',
};
