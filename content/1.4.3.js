// 1.4.3 Implement auditing through trace logging, provenance metadata, and approval workflows
// Lab: Audit trail explorer.
import { hash, step, metric } from '../src/engine/util.js';

const USER = 'dana.ruiz@contoso.com';
const RETENTION_DAYS = { '30d': 30, '90d': 90, '1y': 365, '7y': 2555 };
const REQUIREMENTS = {
  internal: { label: 'Internal tool (basic accountability)', minDays: 30, required: ['who', 'sources', 'correlate', 'retained'] },
  regulated: { label: 'Regulated HR decision (full audit)', minDays: 365, required: ['who', 'model', 'prompt', 'sources', 'approval', 'retained', 'privacy', 'correlate'] },
};
const QUESTIONS = {
  who: 'Who made the request?',
  model: 'Which model and version produced the decision?',
  prompt: 'Which prompt / agent instructions version was used?',
  sources: 'Which data sources informed the answer?',
  approval: 'Was the sensitive action approved by someone other than the requester?',
  retained: 'Are records kept as long as required?',
  privacy: 'Is personal data protected in the trail?',
  correlate: 'Can every step be correlated end to end (one trace ID, durable store)?',
};

function audit(p) {
  const req = REQUIREMENTS[p.requirement] || REQUIREMENTS.internal;
  const steps = [];
  const traceId = 'a3f9' + hash(`${p.userId}|${p.approval}`).toString(16).padStart(8, '0') + '…';
  const uid = p.userId === 'raw' ? USER : p.userId === 'hashed' ? 'sha256:' + hash(USER + '|salt').toString(16) + '… (illustrative)' : null;
  const contentShown = p.captureContent ? (p.redact ? 'Move employee [PERSON] ([ID]) to salary band 7' : 'Move employee Alex Chen (E-4411) to salary band 7') : null;

  steps.push(step('user', 'Request', 'An HR partner asks the HR agent: "Move employee Alex Chen (E-4411) to salary band 7." The agent will read policy, look up the employee, and call a sensitive write tool.', { requester: USER, channel: 'Teams' }, 'info'));

  const answered = {};
  if (p.tracing === 'none') {
    steps.push(step('agent', 'No trace emitted', 'Tracing is not configured: no spans, no attributes, no correlation. The salary change happened, but there is no record of how or why.', { spans: 0 }, 'error'));
    Object.keys(QUESTIONS).forEach(k => { answered[k] = false; });
    return finish(p, req, steps, answered, [], uid, traceId);
  }

  const spans = [];
  const S = (name, start, end, lane, attrs, tone = 'ok') => spans.push({ name, start, end, lane, attrs, tone });
  S('invoke_agent hr-assistant', 0, 6.4, 0, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'hr-assistant', ...(uid ? { 'enduser.id': uid } : {}), ...(p.recPrompt ? { 'app.agent.instructions_version': 'hr-assistant-instructions@v14 (custom attribute)' } : {}) });
  steps.push(step('agent', 'Root span: invoke_agent', `Trace ${traceId} started. ${uid ? `enduser.id = ${p.userId === 'raw' ? 'plain e-mail address' : 'pseudonymous hash'}.` : 'No user identifier recorded.'}${p.recPrompt ? ' Agent instructions version recorded.' : ''}`,
    { trace_id: traceId, 'enduser.id': uid, instructionsVersion: p.recPrompt ? 'v14' : null }, uid ? (p.userId === 'raw' ? 'warn' : 'ok') : 'warn'));

  const modelAttrs = { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'hr-gpt-deployment', ...(p.recModel ? { 'gen_ai.response.model': 'gpt-4o-2024-11-20 (illustrative)' } : {}), 'gen_ai.usage.input_tokens': 1834, 'gen_ai.usage.output_tokens': 212, ...(contentShown ? { 'gen_ai.input.messages': contentShown } : {}) };
  S('chat (plan)', 0.1, 1.4, 1, modelAttrs);
  steps.push(step('model', 'Model call span', p.recModel ? 'Deployment name and the exact model version that responded are recorded.' : 'Only the deployment name is recorded. Deployments can be upgraded to a new model version, so the deployment name alone does not prove which model made the decision.',
    modelAttrs, p.recModel ? (p.captureContent && !p.redact ? 'warn' : 'ok') : 'warn'));

  const srcAttrs = p.recSources ? { 'app.retrieval.index': 'hr-policies', 'app.retrieval.index_version': '2026-10-20T04:00Z', 'app.retrieval.doc_ids': ['pay-bands-2026.pdf#p3', 'promotion-policy.pdf#p1'] } : {};
  S('search hr-policies', 1.4, 1.9, 1, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'azure_ai_search', ...srcAttrs });
  steps.push(step('retrieval', 'Retrieval span', p.recSources ? 'Index name, index refresh time and the cited document IDs are attached as span attributes: the answer can be traced back to its sources.' : 'The search call is traced, but which documents were returned is not recorded.', srcAttrs, p.recSources ? 'ok' : 'warn'));

  S('get_employee', 1.9, 2.3, 1, { 'gen_ai.tool.name': 'get_employee', 'app.tool.effect': 'read' });

  let approvalStatus = 'ok', approvalText;
  if (p.approval === 'none') {
    approvalStatus = p.requirement === 'regulated' ? 'error' : 'warn';
    approvalText = 'update_salary_band ran without any approval step. Nobody but the requester was involved in a pay change.';
  } else if (p.approval === 'self') {
    approvalStatus = p.requirement === 'regulated' ? 'error' : 'warn';
    approvalText = 'An approval was recorded, but the approver is the requester. Segregation of duties is not met.';
    S('approval (self)', 2.3, 2.9, 1, { 'app.approval.approver': uid || '(unknown)', 'app.approval.decision': 'approved' }, 'warn');
  } else {
    approvalText = 'Agent paused; an approval request went to the employee\'s manager, who approved with a justification. The approval record carries the same trace ID.';
    S('approval (manager)', 2.3, 5.1, 1, { 'app.approval.approver': p.userId === 'raw' ? 'm.okafor@contoso.com' : 'sha256:7c1e… (illustrative)', 'app.approval.decision': 'approved', 'app.approval.justification': 'Annual review outcome', 'app.approval.ticket': 'HR-20931' });
  }
  steps.push(step('approval', p.approval === 'manager' ? 'Approval gate: manager approved' : p.approval === 'self' ? 'Approval gate: self-approved' : 'No approval gate', approvalText, { approval: p.approval }, approvalStatus));

  const wStart = p.approval === 'manager' ? 5.1 : p.approval === 'self' ? 2.9 : 2.3;
  S('update_salary_band', wStart, wStart + 0.5, 1, { 'gen_ai.tool.name': 'update_salary_band', 'app.tool.effect': 'write', 'app.tool.sensitivity': 'high' }, approvalStatus === 'ok' ? 'ok' : 'error');
  S('chat (final answer)', wStart + 0.5, 6.4, 1, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'hr-gpt-deployment' });
  steps.push(step('write', 'Sensitive write executed', 'update_salary_band(employee="E-4411", band=7) committed. The span is linked to the approval (if any) by trace ID.', { tool: 'update_salary_band', effect: 'write' }, approvalStatus === 'ok' ? 'ok' : 'warn'));

  const durable = p.tracing === 'appInsights';
  steps.push(step('store', durable ? `Exported to Application Insights (retention ${p.retention})` : 'Printed to console only', durable ? `Spans are queryable in Application Insights / Log Analytics and visible in the Foundry tracing view. Retention ${p.retention}${RETENTION_DAYS[p.retention] < req.minDays ? `, shorter than the ${req.minDays}-day requirement` : ''}.` : 'Console exporter is fine for debugging but the records vanish with the process: nothing an auditor can query later.',
    { exporter: durable ? 'Azure Monitor (OTLP)' : 'console', retentionDays: durable ? RETENTION_DAYS[p.retention] : 0 }, durable && RETENTION_DAYS[p.retention] >= req.minDays ? 'ok' : 'warn'));

  answered.who = !!uid;
  answered.model = p.recModel;
  answered.prompt = p.recPrompt;
  answered.sources = p.recSources;
  answered.approval = p.approval === 'manager';
  answered.retained = durable && RETENTION_DAYS[p.retention] >= req.minDays;
  answered.privacy = p.userId !== 'raw' && (!p.captureContent || p.redact);
  answered.correlate = durable;
  return finish(p, req, steps, answered, spans, uid, traceId);
}

function finish(p, req, steps, answered, spans, uid, traceId) {
  const reqd = req.required;
  const gaps = reqd.filter(k => !answered[k]);
  const critical = gaps.filter(k => ['correlate', 'approval'].includes(k) && p.requirement === 'regulated');
  steps.push(step('audit', gaps.length ? `Audit review: ${gaps.length} gap(s)` : 'Audit review passed', gaps.length ? gaps.map(k => QUESTIONS[k]).join(' · ') : `All ${reqd.length} questions required for "${req.label}" can be answered from the trail.`,
    { requirement: p.requirement, answered: Object.fromEntries(reqd.map(k => [k, !!answered[k]])) }, !gaps.length ? 'ok' : (critical.length && p.tracing !== 'none' ? 'warn' : p.tracing === 'none' ? 'error' : 'warn')));

  const output = [];
  if (spans.length) {
    output.push({ type: 'timeline', title: `Trace ${traceId}`, unit: 's', items: spans.map(s => ({ label: s.name, start: s.start, end: s.end, lane: s.lane, tone: s.tone })) });
    output.push({ type: 'table', title: 'Spans and provenance attributes', columns: ['Span', 'Key attributes'], rows: spans.map(s => [s.name, Object.entries(s.attrs).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('; ')]), tones: spans.map(s => s.tone) });
    const model = spans.find(s => s.name === 'chat (plan)');
    output.push({ type: 'json', title: 'Model span as exported (abridged; GenAI semantic-convention names plus app.* custom attributes, illustrative)', data: { name: model.name, trace_id: traceId, parent: 'invoke_agent hr-assistant', attributes: model.attrs } });
  }
  output.push({ type: 'table', title: `Auditor checklist for "${req.label}"`, columns: ['Question', 'Required', 'Answerable from trail'],
    rows: Object.entries(QUESTIONS).map(([k, q]) => [q, req.required.includes(k) ? 'yes' : 'no', answered[k] ? 'yes' : 'NO']),
    tones: Object.keys(QUESTIONS).map(k => answered[k] ? 'ok' : req.required.includes(k) ? 'error' : 'warn') });
  if (p.userId === 'raw' || (p.captureContent && !p.redact)) output.push({ type: 'alert', tone: 'warn', text: 'The trail itself now holds personal data (e-mail address and/or employee name in prompt content). Use pseudonymous user IDs, redact content, or disable content capture, and restrict who can read the logs.' });

  const n = req.required.length - gaps.length;
  return {
    steps, output,
    metrics: [
      metric('Audit questions answered', `${n}/${req.required.length}`, 'computed'),
      metric('Spans recorded', String(spans.length), 'computed'),
      metric('Personal data in trail', p.tracing === 'none' ? 'n/a' : answered.privacy ? 'protected' : 'exposed', 'computed'),
      metric('Storage footprint', p.captureContent ? 'higher' : 'lower', 'estimate', 'Capturing full prompt/response content multiplies log volume (and ingestion/retention cost) compared with metadata-only spans. Relative only.'),
    ],
    summary: `${p.tracing} · approval ${p.approval} · ${n}/${req.required.length} audit questions answered`,
  };
}

export default {
  id: '1.4.3',
  lab: 'Audit trail explorer',
  services: [
    { name: 'Trace agents and apps in Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/trace-agents-sdk' },
    { name: 'Tracing concepts (OpenTelemetry, GenAI conventions)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/trace' },
    { name: 'Log Analytics data retention', url: 'https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-retention-configure' },
    { name: 'Responsible AI for Foundry Agent Service', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/agents/transparency-note' },
  ],
  prereqs: ['1.3.2'],
  next: ['1.4.4', '2.2.5', '2.3.3'],

  concept: {
    plain: 'When an AI system takes an action that matters (changing someone\'s pay, approving a refund), you must be able to explain it later: who asked, which model and instructions were used, what information it relied on, who approved it, and in what order things happened. An audit trail is the record that answers those questions. It has to be complete, kept long enough, linked together, and must not itself leak personal data.',
    technical: 'Foundry apps and agents emit OpenTelemetry traces (GenAI semantic conventions: invoke_agent, chat, execute_tool spans with gen_ai.request.model, gen_ai.response.model, token usage) exported to the project\'s Application Insights. Provenance is added as span attributes: response model version, prompt/agent-instructions version, retrieval index and cited document IDs, and a pseudonymous end-user ID. Message content capture is opt-in because it can contain personal data; redact it or leave it off. Human approval for sensitive tool calls (for example via Foundry Agent Service tool approval or a workflow step) is recorded with approver, decision and justification, correlated by trace ID, and must respect segregation of duties. Retention is configured on the Log Analytics workspace (with archive or export for long-term needs).',
    useCase: 'An HR agent can change salary bands. For regulatory audits, each change must show the requester (pseudonymous ID), the model version and agent instructions version, the policy pages retrieved, and a manager\'s approval, retained for at least a year. The team adds span attributes for provenance, routes the write tool through a manager approval step, redacts prompt content, and sets workspace retention plus archive.',
    terms: [
      ['Trace / span', 'A trace is one end-to-end request; spans are its timed steps (model call, tool call, approval) sharing one trace ID.'],
      ['Provenance metadata', 'Attributes that say where an output came from: model version, prompt version, data sources.'],
      ['Approval workflow', 'A gate that pauses a sensitive action until an authorised person approves it, with the decision recorded.'],
      ['Segregation of duties', 'The person requesting a sensitive change must not be the one approving it.'],
      ['Pseudonymous ID', 'A stable, non-reversible identifier (e.g. salted hash) that links actions to a user without storing their identity in logs.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'user', label: 'Requester', col: 0, row: 1, kind: 'user', detail: 'Person asking the agent to act.' },
          { id: 'agent', label: 'Agent run (root span)', col: 1, row: 1, kind: 'app', detail: 'One trace ID ties every step together.' },
          { id: 'model', label: p && p.recModel ? 'Model call + version' : 'Model call', col: 2, row: 0, kind: 'ai', detail: 'Which model/version decided?' },
          { id: 'retrieval', label: p && p.recSources ? 'Retrieval + doc IDs' : 'Retrieval', col: 2, row: 1, kind: 'store', detail: 'Which sources informed the answer?' },
          { id: 'approval', label: p ? `Approval: ${p.approval}` : 'Approval', col: 3, row: 0.5, kind: 'policy', detail: 'Human decision before the sensitive action.' },
          { id: 'write', label: 'Sensitive write tool', col: 3, row: 1.5, kind: 'compute', detail: 'The action that must be justified.' },
          { id: 'store', label: p ? `Trail store (${p.tracing})` : 'Trail store', col: 4, row: 1, kind: 'store', detail: 'Durable, queryable, retained, access-controlled.' },
          { id: 'audit', label: 'Auditor', col: 4, row: 2, kind: 'user', detail: 'Asks the audit questions months later.' },
        ],
        edges: [['user', 'agent'], ['agent', 'model'], ['agent', 'retrieval'], ['model', 'approval'], ['approval', 'write'], ['write', 'store'], ['model', 'store'], ['retrieval', 'store'], ['store', 'audit']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'user', label: 'Teams / web front end', col: 0, row: 1, kind: 'app', detail: 'Authenticated user (Entra ID).' },
          { id: 'agent', label: 'Foundry Agent Service agent', col: 1, row: 1, kind: 'app', detail: 'Instrumented with OpenTelemetry.' },
          { id: 'model', label: 'Model deployment', col: 2, row: 0, kind: 'ai', detail: 'Deployment name ≠ model version if auto-upgrade is on.' },
          { id: 'retrieval', label: 'Azure AI Search', col: 2, row: 1, kind: 'store', detail: 'Policy index.' },
          { id: 'approval', label: 'Approval step (tool approval / Logic App / workflow)', col: 3, row: 0.5, kind: 'policy', disabled: p && p.approval === 'none', detail: 'Routes the request to an approver and records the decision.' },
          { id: 'write', label: 'HR system API (OpenAPI tool)', col: 3, row: 1.5, kind: 'external', detail: 'Called with the agent\'s identity after approval.' },
          { id: 'store', label: p && p.tracing === 'appInsights' ? `Application Insights + Log Analytics (${p.retention})` : 'No durable store', col: 4, row: 1, kind: 'store', disabled: p && p.tracing !== 'appInsights', detail: 'Retention configured on the workspace; archive/export for long-term.' },
          { id: 'audit', label: 'Foundry tracing view / KQL / workbooks', col: 4, row: 2, kind: 'app', detail: 'Auditors query by trace ID or user ID; access controlled by RBAC.' },
        ],
        edges: [['user', 'agent'], ['agent', 'model'], ['agent', 'retrieval'], ['agent', 'approval'], ['approval', 'write'], ['agent', 'store', 'OTLP'], ['store', 'audit']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'store', label: p && p.tracing === 'appInsights' ? 'configure_azure_monitor(connection_string=...)' : p && p.tracing === 'console' ? 'ConsoleSpanExporter()' : '# no tracing configured', col: 0, row: 0, kind: 'code', detail: 'azure-monitor-opentelemetry exporter (illustrative).' },
          { id: 'agent', label: 'with tracer.start_as_current_span("invoke_agent hr-assistant") as span:', col: 0, row: 1, kind: 'code', detail: 'Agent SDK instrumentation creates these automatically; custom spans add business context.' },
          { id: 'user', label: `span.set_attribute("enduser.id", ${p && p.userId === 'hashed' ? 'sha256(salt + upn)' : p && p.userId === 'raw' ? 'upn' : 'None'})`, col: 0, row: 2, kind: 'code', detail: 'Prefer pseudonymous IDs.' },
          { id: 'model', label: `span.set_attribute("app.agent.instructions_version", "v14")  # ${p && p.recPrompt ? 'on' : 'off'}`, col: 0, row: 3, kind: 'code', detail: 'Custom attribute; gen_ai.response.model comes from the response.' },
          { id: 'retrieval', label: 'span.set_attribute("app.retrieval.doc_ids", [d.id for d in hits])', col: 0, row: 4, kind: 'code', detail: 'Custom provenance attribute.' },
          { id: 'approval', label: 'if tool.sensitivity == "high": await request_approval(approver=manager_of(user))', col: 0, row: 5, kind: 'code', detail: 'Illustrative; Foundry Agent Service supports approval for some tool types (e.g. MCP require_approval).' },
          { id: 'write', label: 'update_salary_band(...)  # runs only after approval', col: 0, row: 6, kind: 'code', detail: 'Write tool.' },
          { id: 'audit', label: 'KQL: dependencies | where operation_Id == "<trace id>"', col: 0, row: 7, kind: 'code', detail: 'Reconstruct the run from Application Insights.' },
        ],
        edges: [['store', 'agent'], ['agent', 'user'], ['user', 'model'], ['model', 'retrieval'], ['retrieval', 'approval'], ['approval', 'write'], ['write', 'audit']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'requirement', label: 'Audit requirement', type: 'select', options: Object.entries(REQUIREMENTS).map(([v, r]) => [v, r.label]), default: 'regulated' },
      { id: 'tracing', label: 'Trace exporter', type: 'select', options: [['none', 'None'], ['console', 'Console (local debugging)'], ['appInsights', 'Application Insights (project-connected)']], default: 'appInsights' },
      { id: 'userId', label: 'User identifier on spans', type: 'select', options: [['none', 'None'], ['raw', 'E-mail address (raw)'], ['hashed', 'Pseudonymous hash']], default: 'raw' },
      { id: 'captureContent', label: 'Capture prompt/response content', type: 'toggle', default: true },
      { id: 'redact', label: 'Redact PII in captured content', type: 'toggle', default: false },
      { id: 'recModel', label: 'Record model version (gen_ai.response.model)', type: 'toggle', default: false },
      { id: 'recPrompt', label: 'Record agent instructions / prompt version', type: 'toggle', default: false },
      { id: 'recSources', label: 'Record retrieved document IDs', type: 'toggle', default: true },
      { id: 'approval', label: 'Approval for update_salary_band', type: 'select', options: [['none', 'None'], ['self', 'Requester approves'], ['manager', 'Manager approves (separate person)']], default: 'manager' },
      { id: 'retention', label: 'Log retention', type: 'select', options: [['30d', '30 days'], ['90d', '90 days'], ['1y', '1 year'], ['7y', '7 years (with archive)']], default: '90d' },
    ],
    samples: [
      { label: 'Regulated, partial provenance', values: {} },
      { label: 'Internal tool, minimal tracing', values: { requirement: 'internal', recModel: false, recPrompt: false, approval: 'none' } },
      { label: 'Console-only tracing', values: { tracing: 'console' } },
      { label: 'Fully auditable', values: { userId: 'hashed', redact: true, recModel: true, recPrompt: true, retention: '1y' } },
    ],
    run: audit,
  },

  compare: {
    suggestions: [
      'Compare approval = none, requester approves, manager approves under the regulated requirement.',
      'Compare raw vs hashed user IDs with content capture on and off: which settings protect personal data?',
      'Compare Console vs Application Insights exporters: what can an auditor still answer?',
    ],
  },

  debug: [
    { id: 'notrace', title: 'Auditor asks why a salary changed; nothing is logged', values: { tracing: 'none' }, node: 'agent',
      symptom: 'No trace exists for the agent run.', cause: 'No exporter is configured, so spans are never emitted or stored.', fix: 'Configure tracing to Application Insights connected to the Foundry project.' },
    { id: 'console', title: 'Traces visible in dev, gone in production', values: { tracing: 'console' }, node: 'store',
      symptom: 'Developers saw spans in the terminal, but auditors find nothing.', cause: 'Console exporter output is not durable or queryable.', fix: 'Export to Application Insights (Azure Monitor) and set retention.' },
    { id: 'noapproval', title: 'Pay change executed with no approval', values: { approval: 'none' }, node: 'approval',
      symptom: 'Trail shows update_salary_band ran directly after the model call.', cause: 'The sensitive write tool has no approval gate.', fix: 'Require manager approval before update_salary_band and record the decision.' },
    { id: 'self', title: 'Approval recorded, audit still fails', values: { approval: 'self' }, node: 'approval',
      symptom: 'Approver equals requester.', cause: 'Segregation of duties is violated: a self-approval is not independent oversight.', fix: 'Route approval to a different authorised person (manager).' },
    { id: 'version', title: 'Cannot tell which model made a decision', values: { recModel: false }, node: 'model',
      symptom: 'Spans show only the deployment name; the deployment was upgraded last month.', cause: 'The response model version is not recorded.', fix: 'Record gen_ai.response.model (model + version) on model spans.' },
    { id: 'pii', title: 'Audit log becomes a privacy risk', values: { userId: 'raw', captureContent: true, redact: false }, node: 'store',
      symptom: 'Logs contain e-mail addresses and employee names in prompt content.', cause: 'Raw user IDs and unredacted content capture.', fix: 'Use pseudonymous IDs and redact (or disable) content capture.' },
  ],

  challenge: {
    task: 'Make the trail fully auditable for the regulated requirement: all 8 audit questions answerable, with personal data protected.',
    condition: 'Requirement = regulated, audit review passes (8/8).',
    hint: 'Walk the checklist: identity, model, prompt, sources, independent approval, retention, privacy, correlation.',
    check: (p, res) => p.requirement === 'regulated' && res.metrics.some(m => m.label === 'Audit questions answered' && m.value === '8/8'),
    solution: ['Exporter: Application Insights.', 'User identifier: pseudonymous hash; keep content capture but turn on PII redaction (or disable capture).', 'Record model version, agent instructions version and retrieved document IDs.', 'Approval: manager approves.', 'Retention: 1 year or more.'],
    solutionValues: { requirement: 'regulated', tracing: 'appInsights', userId: 'hashed', captureContent: true, redact: true, recModel: true, recPrompt: true, recSources: true, approval: 'manager', retention: '1y' },
  },

  quiz: [
    { q: 'Months after an agent approved a refund, you must prove which model version made the decision. The deployment has auto-upgrade enabled. What should spans have recorded?', options: ['Only the deployment name', 'gen_ai.response.model (model and version) on the model span', 'The API key used', 'Token count only'], answer: 1, why: 'Deployment names stay the same across upgrades; the response model attribute identifies the version actually used.' },
    { q: 'Compliance requires human oversight of salary changes. The agent asks the requester to confirm before writing. Is this sufficient?', options: ['Yes, any confirmation counts', 'No: approval must come from a different authorised person and be recorded', 'Yes, if the model is GPT-4 class', 'No: agents can never perform writes'], answer: 1, why: 'Segregation of duties means the requester cannot be the approver; the decision must be recorded and linked to the trace.' },
    { q: 'You need audit trails without storing users\' identities in logs. What do you record?', options: ['Nothing about the user', 'A pseudonymous user ID (e.g. salted hash) and redacted content', 'The user\'s e-mail in every span', 'The user\'s access token'], answer: 1, why: 'A pseudonymous ID keeps accountability (linkable) while limiting personal data exposure.' },
    { q: 'Developers rely on a console exporter for traces. What breaks for audits?', options: ['Nothing', 'Records are not durable or queryable, so later investigation is impossible', 'Spans lose their trace IDs', 'Token usage is not counted'], answer: 1, why: 'Audits need a durable, access-controlled store with retention, such as Application Insights / Log Analytics.' },
  ],

  recap: 'An audit trail answers who, which model and prompt version, which data, who approved, and when, from one correlated trace in a durable store with adequate retention. Add provenance attributes to spans, gate sensitive tools behind independent approval recorded with the trace, and protect personal data with pseudonymous IDs and redaction.',
};
