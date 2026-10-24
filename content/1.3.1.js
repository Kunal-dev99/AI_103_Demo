// 1.3.1 Manage quotas, scaling, rate limits, and cost footprints for model and agent workloads
// Lab: Quota and throttling simulator.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

const MINUTES = 10;
// Illustrative ratio used by this simulation: requests-per-minute limit = 6 per 1,000 TPM.
// This matches the ratio documented for many Azure OpenAI chat models at the time of writing,
// but it varies by model and can change. Check the quota documentation.
const RPM_PER_K_TPM = 6;

const TYPES = {
  standard: { label: 'Standard (regional, pay-per-token)', ptu: false, noise: 1 },
  globalStandard: { label: 'Global Standard (pay-per-token, global routing)', ptu: false, noise: 0.8 },
  ptu: { label: 'Provisioned throughput (PTU, reserved capacity)', ptu: true, noise: 0.5 },
};

const RETRY = {
  none: 'No retry (surface 429 to the user)',
  immediate: 'Immediate retry, up to 3 times',
  backoff: 'Exponential backoff with jitter',
  retryAfter: 'Honour Retry-After header, then backoff',
};

function simulate(p) {
  const t = TYPES[p.deploymentType] || TYPES.standard;
  const r = rng(`${p.deploymentType}|${p.tpm}|${p.rpm}|${p.prompt}|${p.maxTokens}|${p.burst}|${p.agentSteps}`);
  const steps = [];
  const deployments = clamp(Math.round(p.deployments), 1, 3);
  const perDeployK = clamp(p.tpm, 1, 2000);
  const needQuotaK = p.multiRegion ? perDeployK : perDeployK * deployments;

  // 1. Quota allocation (control plane)
  if (needQuotaK > p.regionQuota) {
    steps.push(step('quota', 'Deployment rejected: insufficient quota',
      `You asked for ${deployments} deployment(s) × ${perDeployK}K TPM = ${needQuotaK}K TPM in one region, but only ${p.regionQuota}K TPM of quota is available for this model in this subscription and region. In Azure this surfaces as an InsufficientQuota error when you create or scale the deployment.`,
      { requestedKTPM: needQuotaK, availableKTPM: p.regionQuota, multiRegion: p.multiRegion, code: 'InsufficientQuota (illustrative)' }, 'error'));
    return {
      steps,
      output: [{ type: 'alert', tone: 'error', text: 'No traffic was served: the deployments could not be created. Lower the TPM per deployment, spread deployments across regions, or request a quota increase.' }],
      metrics: [metric('Quota requested vs available', `${needQuotaK}K / ${p.regionQuota}K TPM`, 'computed')],
      summary: `Rejected: ${needQuotaK}K TPM requested, ${p.regionQuota}K available`,
    };
  }
  steps.push(step('quota', 'Quota allocated', `${deployments} deployment(s) of ${perDeployK}K TPM${p.multiRegion ? ' in separate regions (each draws on its own regional quota)' : ' in one region'}. ${needQuotaK}K of ${p.regionQuota}K TPM quota used.${t.ptu ? ' (Real PTU deployments are sized in PTUs, with their own quota; throughput per PTU depends on model and prompt/completion mix. This simulation expresses PTU capacity as equivalent K tokens/min.)' : ''}`,
    { deployments, tpmPerDeployment: perDeployK * 1000, rpmPerDeployment: perDeployK * RPM_PER_K_TPM, regionQuotaKTPM: p.regionQuota, deploymentType: t.label }));

  // 2. Demand shaping
  const callsPerMin = p.rpm * p.agentSteps;
  // The rate limiter estimates a request's cost at admission time from prompt tokens + max_tokens,
  // not from the completion the model eventually produces.
  const admitCost = p.prompt + p.maxTokens;
  const actualCompletion = Math.min(p.completion, p.maxTokens);
  const billedPerCall = p.prompt + actualCompletion;
  steps.push(step('client', 'Workload profile', `${p.rpm} user requests/min × ${p.agentSteps} model call(s) per request = ${callsPerMin} calls/min. Each call is counted by the limiter as ~${admitCost} tokens (prompt + max_tokens) even though it only produces ~${actualCompletion} completion tokens.`,
    { userRequestsPerMin: p.rpm, modelCallsPerRequest: p.agentSteps, callsPerMin, limiterTokensPerCall: admitCost, billedTokensPerCall: billedPerCall, burst: p.burst ? 'minute 3–4 at 2.5×' : 'none' },
    p.maxTokens > actualCompletion * 4 ? 'warn' : 'info'));

  // 3. Minute-by-minute simulation
  const capTokens = perDeployK * 1000 * deployments;
  const capReq = perDeployK * RPM_PER_K_TPM * deployments;
  const capCalls = t.ptu ? Math.floor(capTokens / billedPerCall) : Math.min(capReq, Math.floor(capTokens / admitCost));
  let carry = 0;
  const rows = [];
  let served = 0, failed = 0, throttled = 0, wasted = 0, totalDemand = 0;
  for (let m = 0; m < MINUTES; m++) {
    const burstMul = p.burst && (m === 3 || m === 4) ? 2.5 : 1;
    const jitter = 1 + (r() - 0.5) * 0.2 * t.noise;
    const fresh = Math.round(callsPerMin * burstMul * jitter);
    totalDemand += fresh;
    let demand = fresh + carry;
    let ok = Math.min(demand, capCalls);
    let rejected = demand - ok;
    let lost = 0, next = 0, extra429 = 0;
    if (rejected > 0) {
      throttled += rejected;
      if (p.retry === 'none') { lost = rejected; }
      else if (p.retry === 'immediate') {
        // Immediate retries land in the same window and are throttled again, inflating 429 counts.
        extra429 = rejected * 3; wasted += extra429; lost = rejected;
      } else if (p.retry === 'backoff') {
        // Backoff spreads retries into later windows; some give up after max attempts.
        next = Math.round(rejected * 0.85); lost = rejected - next; extra429 = Math.round(rejected * 0.4); wasted += extra429;
      } else {
        next = rejected; // Retry-After says exactly when capacity frees up.
      }
    }
    if (m === MINUTES - 1) { lost += next; next = 0; }
    carry = next;
    served += ok; failed += lost;
    rows.push({ m: m + 1, demand, ok, rejected, lost, carry: next, extra429, util: ok / Math.max(1, capCalls) });
  }
  const totalAttempts = served + throttled + wasted;
  const successRate = totalDemand ? served / totalDemand : 1;
  const rate429 = totalAttempts ? (throttled + wasted) / totalAttempts : 0;
  const peakUtil = Math.max(...rows.map(x => x.demand / Math.max(1, capCalls)));

  steps.push(step('limiter', t.ptu ? 'Provisioned capacity check' : 'Rate limiter (TPM / RPM)',
    t.ptu
      ? `PTU deployments are limited by utilisation of the reserved capacity, measured on actual tokens. In this simulation that allows ~${capCalls} calls/min. Above 100% utilisation the service returns 429 with a retry-after hint.`
      : `Effective limit: min(RPM ${capReq}, TPM ${capTokens.toLocaleString('en-US')} ÷ ${admitCost} tokens/call) = ${capCalls} calls/min. Real limits are also enforced over short windows (seconds), so bursts throttle earlier than a per-minute average suggests.`,
    { capacityCallsPerMin: capCalls, peakDemandRatio: round(peakUtil, 2), throttledFirstAttempts: throttled, extra429FromRetries: wasted },
    throttled === 0 ? 'ok' : 'warn'));

  steps.push(step('apim', deployments > 1 ? 'Load balancing across deployments' : 'Single deployment',
    deployments > 1 ? `A gateway (for example Azure API Management with a backend pool and circuit breaker) spreads calls across ${deployments} deployments, so capacity adds up.` : 'All calls go to one deployment. Adding deployments (ideally in other regions) or a PTU deployment with spillover to pay-per-token raises the ceiling.',
    { backends: deployments, policy: deployments > 1 ? 'round-robin + retry on 429 (illustrative)' : 'none' }, deployments > 1 ? 'ok' : 'info'));

  const retryStatus = p.retry === 'immediate' && throttled > 0 ? 'error' : p.retry === 'none' && throttled > 0 ? 'warn' : 'ok';
  steps.push(step('retry', `Client retry: ${RETRY[p.retry]}`,
    p.retry === 'immediate' && throttled > 0 ? `Retry storm: ${wasted} extra 429 responses because retries hit the same exhausted window. Immediate retries make throttling worse and waste client time.`
      : p.retry === 'none' && throttled > 0 ? `${throttled} calls got 429 and were returned to the user as failures.`
        : p.retry === 'backoff' ? 'Backoff with jitter spreads retries into later windows; a few calls exhaust their attempts.'
          : p.retry === 'retryAfter' ? 'Retries wait exactly as long as the service asks (Retry-After / retry-after-ms), so nearly every throttled call succeeds later.' : 'No throttling happened, so retries were not needed.',
    { policy: p.retry, failedAfterRetries: failed }, retryStatus));

  const status = successRate >= 0.99 ? 'ok' : successRate >= 0.9 ? 'warn' : 'error';
  steps.push(step('model', 'Served traffic', `${served}/${totalDemand} calls succeeded (${round(successRate * 100, 1)}%). ${failed} failed after retries.`,
    { served, failed, successRate: round(successRate, 3) }, status));

  // Cost footprint (relative units only)
  const tokensBilled = served * billedPerCall;
  const paygUnits = round(tokensBilled / 100000, 1);
  const ptuUnits = round(capTokens / 10000, 1);
  steps.push(step('cost', 'Cost footprint (relative)', t.ptu
    ? `PTU is billed for reserved capacity whether or not you use it: ${ptuUnits} relative units for this window. Average utilisation ${round(served / (capCalls * MINUTES) * 100)}%.`
    : `Pay-per-token bills actual prompt + completion tokens: ~${tokensBilled.toLocaleString('en-US')} tokens → ${paygUnits} relative units. Throttled calls are not billed, but immediate retries still cost client time.`,
    { model: t.ptu ? 'reserved' : 'consumption', tokensBilled, relativeUnits: t.ptu ? ptuUnits : paygUnits }, 'info'));

  const output = [
    { type: 'bars', title: 'Demand per minute as a share of capacity (line = 100%)', threshold: 0.5,
      items: rows.map(x => ({ label: `min ${x.m}`, value: clamp(x.demand / Math.max(1, capCalls) / 2, 0, 1), note: `${x.demand} calls vs ${capCalls} capacity`, tone: x.rejected ? (x.lost ? 'error' : 'warn') : 'ok' })) },
    { type: 'table', title: 'Minute-by-minute outcome', columns: ['Minute', 'Calls offered (incl. retries carried in)', 'Served', '429 (first attempt)', 'Extra 429 from retries', 'Carried to next minute', 'Failed'],
      rows: rows.map(x => [String(x.m), String(x.demand), String(x.ok), String(x.rejected), String(x.extra429), String(x.carry), String(x.lost)]),
      tones: rows.map(x => x.lost ? 'error' : x.rejected ? 'warn' : 'ok') },
    { type: 'timeline', title: 'One throttled call, as seen by the client (illustrative)', unit: 's',
      items: throttled === 0 ? [{ label: 'call → 200 OK', start: 0, end: 2, tone: 'ok' }]
        : p.retry === 'none' ? [{ label: 'call → 429', start: 0, end: 0.3, tone: 'error' }, { label: 'error shown to user', start: 0.3, end: 0.6, tone: 'error', lane: 1 }]
          : p.retry === 'immediate' ? [0, 1, 2, 3].map(i => ({ label: i < 3 ? `attempt ${i + 1} → 429` : 'attempt 4 → 429, give up', start: i * 0.35, end: i * 0.35 + 0.3, tone: 'error' }))
            : p.retry === 'backoff' ? [{ label: 'attempt 1 → 429', start: 0, end: 0.3, tone: 'warn' }, { label: 'wait 2s ± jitter', start: 0.3, end: 2.3, tone: 'muted', lane: 1 }, { label: 'attempt 2 → 429', start: 2.3, end: 2.6, tone: 'warn' }, { label: 'wait 4s ± jitter', start: 2.6, end: 6.6, tone: 'muted', lane: 1 }, { label: 'attempt 3 → 200', start: 6.6, end: 8.6, tone: 'ok' }]
              : [{ label: 'attempt 1 → 429 (retry-after: 5)', start: 0, end: 0.3, tone: 'warn' }, { label: 'wait as instructed', start: 0.3, end: 5.3, tone: 'muted', lane: 1 }, { label: 'attempt 2 → 200', start: 5.3, end: 7.3, tone: 'ok' }] },
    { type: 'kv', title: 'Capacity maths (this simulation)', items: [
      ['Limiter cost per call', `${p.prompt} prompt + ${p.maxTokens} max_tokens = ${admitCost} tokens`],
      ['Billed per call', `${p.prompt} + ${actualCompletion} = ${billedPerCall} tokens`],
      ['Capacity', `${capCalls} calls/min across ${deployments} deployment(s)`],
      ['Peak demand', `${round(peakUtil * 100)}% of capacity`],
    ] },
  ];
  if (p.maxTokens > actualCompletion * 4) output.push({ type: 'alert', tone: 'warn', text: `max_tokens (${p.maxTokens}) is far above the typical completion (${actualCompletion}). The limiter reserves the full max_tokens per call, so you hit 429s with quota that is mostly unused. Set max_tokens close to what you actually need.` });
  if (failed) output.push({ type: 'alert', tone: status === 'error' ? 'error' : 'warn', text: `${failed} calls failed. Options: honour Retry-After, add deployments behind a gateway, raise TPM (if quota allows), cut tokens per call, or move steady traffic to PTU.` });

  return {
    steps, output,
    metrics: [
      metric('Success rate', `${round(successRate * 100, 1)}%`, 'computed', 'Served / offered calls over the 10 simulated minutes.'),
      metric('429 share of attempts', `${round(rate429 * 100, 1)}%`, 'computed'),
      metric('Capacity', `${capCalls} calls/min`, 'computed', `RPM ratio of ${RPM_PER_K_TPM} per 1K TPM is an illustrative assumption; check the docs for your model.`),
      metric('Cost footprint', t.ptu ? `${ptuUnits} units (reserved)` : `${paygUnits} units (consumption)`, 'estimate', 'Relative units only, not currency. Pay-per-token scales with tokens billed; PTU scales with reserved capacity. See the Azure OpenAI pricing page for real prices.'),
    ],
    summary: `${t.label.split(' (')[0]} ×${deployments}, ${perDeployK}K TPM, ${p.retry}: ${round(successRate * 100, 1)}% served, ${failed} failed`,
  };
}

export default {
  id: '1.3.1',
  lab: 'Quota and throttling simulator',
  services: [
    { name: 'Azure OpenAI quotas and limits', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/quotas-limits' },
    { name: 'Manage Azure OpenAI quota', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/quota' },
    { name: 'Provisioned throughput', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/provisioned-throughput' },
    { name: 'Plan and manage costs for Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/costs-plan-manage' },
  ],
  prereqs: ['1.2.2', '1.2.3'],
  next: ['1.3.2', '2.3.3'],

  concept: {
    plain: 'Every model deployment has a speed limit: how many tokens and requests it accepts per minute. Your subscription also has a total allowance (quota) per model and region that all deployments share. When traffic exceeds the limit, the service answers "429 Too Many Requests" instead of a result. Good apps size the limit to the workload, keep each request lean, wait politely before retrying, and spread load over several deployments. Cost follows the same numbers: pay-per-token bills what you use, reserved capacity bills what you reserve.',
    technical: 'Azure OpenAI in Foundry assigns quota in tokens per minute (TPM) per model, per region, per subscription; each deployment is allocated part of it, and a requests-per-minute (RPM) limit is derived from TPM. At admission the limiter estimates a request from prompt tokens plus max_tokens, so an oversized max_tokens consumes quota without producing output. Limits are evaluated over short windows, so bursts throttle earlier than averages imply. 429 responses include retry-after / retry-after-ms headers; clients should honour them and use exponential backoff with jitter (the OpenAI SDK retries automatically, configurable via max_retries). Standard and Global Standard deployments bill per token; Provisioned (PTU) deployments reserve capacity billed hourly or by reservation and throttle on utilisation. Scale out with multiple deployments/regions behind Azure API Management, or use PTU with spillover to pay-per-token. Agent workloads multiply model calls per user request.',
    useCase: 'A retail support agent makes 3 model calls per customer message (plan, tool call, answer). On Black Friday traffic triples. The team lowers max_tokens from 4,000 to 600, moves steady weekday load to a PTU deployment, spills bursts to two Global Standard deployments behind API Management, and makes the client honour Retry-After, so customers see slower answers instead of errors.',
    terms: [
      ['TPM / RPM', 'Tokens and requests per minute a deployment accepts. RPM is derived from the TPM you assign.'],
      ['Quota', 'Total TPM available to a subscription for a model in a region, shared by all its deployments.'],
      ['429 + Retry-After', 'Throttling response telling the client how long to wait before retrying.'],
      ['PTU', 'Provisioned throughput units: reserved model capacity with predictable latency, billed for what you reserve.'],
      ['Spillover', 'Sending traffic that exceeds a provisioned deployment to a pay-per-token deployment.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'client', label: p ? `App / agent (${p.agentSteps} call(s) per request)` : 'App / agent', col: 0, row: 1, kind: 'app', detail: 'Generates model calls. Agents make several calls per user turn, multiplying load.' },
          { id: 'retry', label: p ? `Retry policy: ${p.retry}` : 'Retry policy', col: 1, row: 2, kind: 'code', detail: 'What the client does after a 429: give up, retry immediately (bad), back off, or wait for Retry-After.' },
          { id: 'apim', label: p && p.deployments > 1 ? `Gateway → ${p.deployments} deployments` : 'Gateway (optional)', col: 1, row: 0.5, kind: 'compute', disabled: p && p.deployments < 2, detail: 'Distributes calls across deployments and regions.' },
          { id: 'limiter', label: 'Rate limiter', col: 2, row: 1, kind: 'policy', detail: 'Admits or rejects each call against TPM/RPM (or PTU utilisation) over short windows.', substeps: ['Estimate tokens = prompt + max_tokens', 'Check RPM window', 'Check TPM window', 'Admit or 429 + Retry-After'] },
          { id: 'model', label: 'Model deployment', col: 3, row: 1, kind: 'ai', detail: 'Runs inference for admitted calls.' },
          { id: 'quota', label: 'Subscription quota', col: 2, row: 0, kind: 'policy', detail: 'Regional TPM pool per model. Deployments draw from it.' },
          { id: 'cost', label: 'Cost footprint', col: 4, row: 1, kind: 'data', detail: 'Pay-per-token: tokens billed. PTU: capacity reserved.' },
        ],
        edges: [['client', 'apim'], ['client', 'limiter', 'call'], ['apim', 'limiter'], ['limiter', 'retry', '429'], ['retry', 'limiter', 'retry'], ['limiter', 'model', 'admit'], ['quota', 'limiter', 'limits'], ['model', 'cost', 'tokens']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'client', label: 'Container App (agent API)', col: 0, row: 1, kind: 'app', detail: 'Calls the model through the gateway using managed identity.' },
          { id: 'apim', label: 'Azure API Management (AI gateway)', col: 1, row: 1, kind: 'compute', disabled: p && p.deployments < 2, detail: 'Backend pool across deployments/regions, circuit breaker on 429, token-limit and token-metric policies.' },
          { id: 'limiter', label: p ? `${TYPES[p.deploymentType].label}` : 'Deployment type', col: 2, row: 1, kind: 'policy', detail: 'Deployment type determines how limits and billing work.' },
          { id: 'model', label: p ? `Deployment(s): ${p.deployments} × ${p.tpm}K TPM` : 'Model deployments', col: 3, row: 1, kind: 'ai', detail: 'Model deployments in a Foundry resource (one or more regions).' },
          { id: 'quota', label: 'Quotas page (Foundry portal)', col: 2, row: 0, kind: 'policy', detail: 'Shows TPM quota per model/region and lets you request increases.' },
          { id: 'retry', label: 'SDK retry settings', col: 0, row: 2, kind: 'code', detail: 'OpenAI client max_retries / your own backoff policy.' },
          { id: 'cost', label: 'Cost Management + Azure Monitor', col: 4, row: 1, kind: 'data', detail: 'Budgets, token usage metrics, PTU utilisation and 429 counts.' },
        ],
        edges: [['client', 'apim'], ['apim', 'limiter'], ['limiter', 'model'], ['quota', 'model', 'allocates'], ['client', 'retry'], ['model', 'cost', 'metrics']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'client', label: 'client = AzureOpenAI(azure_endpoint=..., azure_ad_token_provider=tp, max_retries=0)', col: 0, row: 0, kind: 'code', detail: 'Illustrative. The OpenAI SDK retries 429s itself by default; set max_retries explicitly when you own the policy.' },
          { id: 'limiter', label: `client.chat.completions.create(model=deployment, messages=..., max_tokens=${p ? p.maxTokens : 800})`, col: 0, row: 1, kind: 'code', detail: 'max_tokens counts towards the limiter estimate at admission.' },
          { id: 'retry', label: 'except RateLimitError as e: wait = e.response.headers.get("retry-after-ms")', col: 0, row: 2, kind: 'code', detail: 'Honour the server hint; fall back to exponential backoff with jitter.' },
          { id: 'apim', label: 'APIM: <backend pool> + <retry condition="429"> + llm-token-limit', col: 0, row: 3, kind: 'code', detail: 'Gateway policies (names illustrative; see APIM AI gateway docs).' },
          { id: 'model', label: 'az cognitiveservices account deployment create --sku-capacity <K TPM>', col: 0, row: 4, kind: 'code', detail: 'Capacity is set per deployment in units of 1K TPM for Standard SKUs.' },
          { id: 'quota', label: 'az cognitiveservices usage list --location <region>', col: 0, row: 5, kind: 'code', detail: 'Check remaining quota before scaling.' },
          { id: 'cost', label: 'Azure Monitor: ProcessedPromptTokens, GeneratedTokens, ProvisionedManagedUtilization', col: 0, row: 6, kind: 'code', detail: 'Metric names are illustrative; check the Azure OpenAI monitoring reference.' },
        ],
        edges: [['client', 'limiter'], ['limiter', 'retry'], ['retry', 'apim'], ['apim', 'model'], ['model', 'quota'], ['model', 'cost']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'deploymentType', label: 'Deployment type', type: 'select', options: Object.entries(TYPES).map(([v, x]) => [v, x.label]), default: 'standard' },
      { id: 'tpm', label: 'TPM per deployment (thousands)', type: 'range', min: 10, max: 300, step: 10, default: 100 },
      { id: 'deployments', label: 'Number of deployments behind gateway', type: 'range', min: 1, max: 3, step: 1, default: 1 },
      { id: 'multiRegion', label: 'Deployments in different regions', type: 'toggle', default: false, help: 'Quota is per region, so separate regions each have their own pool.' },
      { id: 'regionQuota', label: 'Available regional quota (thousands TPM)', type: 'range', min: 50, max: 500, step: 10, default: 150, help: 'Illustrative. Your real quota is shown on the Foundry quotas page.' },
      { id: 'rpm', label: 'User requests per minute', type: 'range', min: 5, max: 300, step: 5, default: 40 },
      { id: 'agentSteps', label: 'Model calls per user request (agent loop)', type: 'range', min: 1, max: 6, step: 1, default: 1 },
      { id: 'prompt', label: 'Avg prompt tokens', type: 'range', min: 200, max: 8000, step: 100, default: 1200 },
      { id: 'completion', label: 'Avg completion tokens actually produced', type: 'range', min: 50, max: 2000, step: 50, default: 250 },
      { id: 'maxTokens', label: 'max_tokens on each call', type: 'range', min: 100, max: 4000, step: 100, default: 800 },
      { id: 'retry', label: 'Client retry policy', type: 'select', options: Object.entries(RETRY), default: 'backoff' },
      { id: 'burst', label: 'Traffic burst at minutes 4–5', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Steady chat app, comfortable headroom', values: { rpm: 20, burst: false, tpm: 80, retry: 'retryAfter' } },
      { label: 'Agent loop with 4 calls per request', values: { agentSteps: 4, rpm: 30, tpm: 100 } },
      { label: 'Oversized max_tokens', values: { maxTokens: 4000, completion: 200, tpm: 50, rpm: 40 } },
      { label: 'PTU for steady high volume', values: { deploymentType: 'ptu', tpm: 200, regionQuota: 300, rpm: 100, burst: false } },
    ],
    run: simulate,
  },

  compare: {
    suggestions: [
      'Run with max_tokens 4000 and then 400 (same completion length) and compare capacity in calls/min.',
      'Keep the burst on and compare retry policies: none, immediate, backoff, Retry-After.',
      'Compare 1 deployment vs 3 deployments in different regions at the same TPM each.',
      'Compare Standard vs PTU for 100 requests/min with no burst and look at the cost footprint and utilisation.',
    ],
  },

  debug: [
    { id: 'maxtokens', title: '429s while token usage graphs look low', values: { maxTokens: 4000, completion: 200, tpm: 50, rpm: 40, retry: 'none', burst: false }, node: 'limiter',
      symptom: 'Frequent 429s even though billed tokens are a fraction of the TPM limit.', cause: 'The limiter counts prompt + max_tokens at admission. max_tokens 4000 reserves far more than the ~200 tokens actually produced.', fix: 'Set max_tokens close to the real completion length (e.g. 300–400) and add a retry policy.' },
    { id: 'storm', title: 'Retry storm during a burst', values: { retry: 'immediate', burst: true, rpm: 60, tpm: 50 }, node: 'retry',
      symptom: 'Huge number of extra 429s and many failed calls during the burst.', cause: 'Immediate retries land in the same exhausted window and are rejected again.', fix: 'Honour Retry-After (or exponential backoff with jitter) so retries arrive when capacity is free.' },
    { id: 'quota', title: 'Deployment creation fails', values: { deployments: 3, tpm: 100, multiRegion: false, regionQuota: 150 }, node: 'quota',
      symptom: 'InsufficientQuota: no traffic served at all.', cause: '3 × 100K TPM in one region exceeds the 150K regional quota for this model.', fix: 'Put deployments in different regions (each has its own quota), lower TPM per deployment, or request a quota increase.' },
    { id: 'agent', title: 'Agent rollout overwhelms the deployment', values: { agentSteps: 5, rpm: 40, tpm: 50, retry: 'backoff' }, node: 'client',
      symptom: 'Success rate collapses after switching from a single-call chatbot to an agent.', cause: 'Each user request now makes 5 model calls, so load is 5× higher with the same quota.', fix: 'Budget TPM for calls per request: raise TPM, add deployments, trim prompt tokens, or reduce agent iterations.' },
  ],

  challenge: {
    task: 'An agent makes 2 model calls per request at 40 requests/min with the burst on. Serve at least 99% of calls with no more than 80K TPM per deployment and without using immediate retries.',
    condition: 'agentSteps = 2, rpm = 40, burst on, TPM per deployment ≤ 80, retry ≠ immediate, success rate ≥ 99%.',
    hint: 'Three levers work together: tokens counted per call, number of deployments, and how retries are timed.',
    check: (p, res) => p.agentSteps === 2 && p.rpm === 40 && p.burst && p.tpm <= 80 && p.retry !== 'immediate'
      && res.steps.some(s => s.title === 'Served traffic' && s.data && s.data.successRate >= 0.99),
    solution: [
      'Set Model calls per request = 2 and User requests per minute = 40, burst on.',
      'Lower max_tokens to 400: completions are ~250 tokens, so the limiter no longer over-reserves.',
      'Use 3 deployments in different regions behind the gateway at 80K TPM each (one region would exceed the regional quota).',
      'Set the retry policy to honour Retry-After so burst overflow is served in the following minutes.',
    ],
    solutionValues: { agentSteps: 2, rpm: 40, burst: true, tpm: 80, deployments: 3, multiRegion: true, maxTokens: 400, retry: 'retryAfter' },
  },

  quiz: [
    { q: 'Your app gets 429s, yet Azure Monitor shows generated tokens far below the deployment TPM. Prompts are ~800 tokens and max_tokens is 4096 while answers average 150 tokens. What should you change first?', options: ['Request a quota increase', 'Lower max_tokens to match real completions', 'Switch to a smaller model', 'Disable streaming'], answer: 1, why: 'The limiter estimates prompt + max_tokens at admission. An oversized max_tokens consumes rate-limit capacity without producing output.' },
    { q: 'You need predictable latency for a high, steady volume and can tolerate paying for unused capacity at night. Bursts above that should still be served. Which design fits?', options: ['One Standard deployment with a higher TPM', 'A provisioned (PTU) deployment with spillover to a pay-per-token deployment', 'Several Standard deployments in the same region', 'Immediate client retries'], answer: 1, why: 'PTU gives reserved capacity and predictable latency; spillover to Standard/Global Standard absorbs bursts.' },
    { q: 'A client receives a 429 with a retry-after-ms header. What is the recommended behaviour?', options: ['Retry immediately up to 10 times', 'Wait at least the indicated time, then retry with backoff and jitter', 'Fail the request and alert on-call', 'Increase max_tokens to reduce the number of calls'], answer: 1, why: 'Honouring the server hint and backing off avoids retry storms and usually succeeds once the window frees.' },
    { q: 'You try to create three 100K TPM deployments of the same model in one region and get InsufficientQuota. Regional quota is 150K TPM. Which change does NOT require a quota increase?', options: ['Create the deployments in three different regions', 'Raise TPM on one deployment to 300K', 'Use one region and the same capacity', 'Add a fourth deployment'], answer: 0, why: 'Quota is per subscription, model and region, so spreading deployments across regions draws on separate pools.' },
  ],

  recap: 'Quota is a per-region TPM pool; deployments draw from it and derive RPM. The limiter counts prompt + max_tokens, so right-size max_tokens. Honour Retry-After with backoff, scale out with more deployments/regions behind a gateway, and choose pay-per-token for spiky load or PTU for steady high volume. Agents multiply calls per request: budget for it.',
};
