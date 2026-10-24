// 1.2.3 Configure model and agent deployments
// Lab: Model + agent deployment configurator.
import { step, metric, estTokens } from '../src/engine/util.js';

// Model versions. Lifecycle status here is set FOR THIS SIMULATION; real deprecation/retirement
// dates are published in the model retirement tables and change over time.
const MODELS = {
  'gpt-4.1': { label: 'gpt-4.1 (2025-04-14)', name: 'gpt-4.1', version: '2025-04-14', status: 'GA', family: 'gpt-4.1', reasoning: false },
  'gpt-4.1-mini': { label: 'gpt-4.1-mini (2025-04-14)', name: 'gpt-4.1-mini', version: '2025-04-14', status: 'GA', family: 'gpt-4.1-mini', reasoning: false },
  'o4-mini': { label: 'o4-mini (2025-04-16)', name: 'o4-mini', version: '2025-04-16', status: 'GA', family: 'o4-mini', reasoning: true },
  'gpt-4o-old': { label: 'gpt-4o (2024-05-13), deprecated in this simulation', name: 'gpt-4o', version: '2024-05-13', status: 'deprecated', family: 'gpt-4o', reasoning: false },
};

const ROLES = {
  owner: { label: 'Cognitive Services Contributor / Azure AI Account Owner (control plane)', deploy: true, agents: true },
  aiUser: { label: 'Azure AI User (data plane only)', deploy: false, agents: true },
  reader: { label: 'Reader', deploy: false, agents: false },
};

const FILTERS = {
  default: { label: 'Default (Microsoft.DefaultV2)', approval: false },
  strict: { label: 'Custom: stricter thresholds + prompt shields', approval: false },
  annotate: { label: 'Custom: annotate only (filtering off)', approval: true },
};

function deploy(p) {
  const steps = [];
  const m = MODELS[p.model];
  const role = ROLES[p.role];
  const name = String(p.deploymentName || '').trim();
  const stop = (out, summary) => ({ steps, output: out, metrics: [metric('Stages passed', `${steps.filter(s => s.status === 'ok').length}/${steps.length}`, 'computed')], summary });

  // 1. Authorization
  if (!role.deploy) {
    steps.push(step('auth', 'Deployment write forbidden (403)', `${role.label} cannot perform Microsoft.CognitiveServices/accounts/deployments/write. Creating deployments is a control-plane action.`, { httpStatus: 403, code: 'AuthorizationFailed', action: 'Microsoft.CognitiveServices/accounts/deployments/write' }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Ask for a role that can create deployments on the Foundry resource (for example Cognitive Services Contributor or Azure AI Account Owner), or have your pipeline identity create it.' }], 'Blocked: no permission to create deployments');
  }
  steps.push(step('auth', 'Caller authorized', `${role.label}: can create deployments on the Foundry resource.`, { role: role.label }));

  // 2. Deployment name
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(name)) {
    steps.push(step('deployment', 'Invalid deployment name', `"${name}" is not a valid name in this simulation (use 2–64 letters, digits, '-', '_' or '.'; check the docs for the exact rule).`, { deploymentName: name }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Fix the deployment name. Remember: apps and agents call the deployment name, not the model name.' }], 'Invalid deployment name');
  }

  // 3. Model version
  if (m.status === 'deprecated') {
    steps.push(step('model', 'Model version not available for new deployments', `${m.name} ${m.version} is deprecated in this simulation: existing deployments keep running until retirement, but new deployments are refused.`, { model: m.name, version: m.version, lifecycle: 'deprecated' }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Pick a current GA version. Check the model retirements page for real dates.' }], `${m.name} ${m.version}: deprecated`);
  }
  const upgradeText = {
    OnceNewDefaultVersionAvailable: 'Upgrades automatically when a new default version is published: easy, but behaviour can change under you. Re-run evaluations after upgrades.',
    OnceCurrentVersionExpired: 'Stays on this version until it is retired, then upgrades to the default. Predictable until retirement.',
    NoAutoUpgrade: 'Pinned. When this version is retired, the deployment stops serving unless you upgrade it yourself.',
  }[p.upgrade];
  steps.push(step('model', `Model ${m.name} version ${m.version}`, `Version upgrade policy: ${p.upgrade}. ${upgradeText}`, { format: 'OpenAI', name: m.name, version: m.version, versionUpgradeOption: p.upgrade }, p.upgrade === 'NoAutoUpgrade' ? 'warn' : 'ok'));

  // 4. Quota
  if (p.capacity > p.quota) {
    steps.push(step('quota', 'Insufficient quota', `Requested ${p.capacity}K TPM but only ${p.quota}K TPM of ${m.family} quota remains for this subscription and region (simulated). Lower capacity, free quota from another deployment, or request more.`, { requested: `${p.capacity}K TPM`, available: `${p.quota}K TPM`, code: 'InsufficientQuota' }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Quota is per subscription, region, model and deployment type. Check Management center → Quota.' }], `Quota exceeded (${p.capacity}K > ${p.quota}K)`);
  }
  steps.push(step('quota', 'Capacity allocated', `${p.capacity}K TPM assigned (simulated quota left: ${p.quota - p.capacity}K). Requests-per-minute limits scale with TPM.`, { sku: { name: 'GlobalStandard', capacity: p.capacity } }));

  // 5. Content filter
  const f = FILTERS[p.filter];
  if (f.approval && !p.filterApproved) {
    steps.push(step('filter', 'Content filter configuration rejected', 'Turning filtering off (annotate only) requires approval for modified content filtering. Without it you can only make filters stricter or use the default.', { raiPolicyName: 'annotate-only', approved: false }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Use the default or a stricter custom filter, or apply for modified content filtering first.' }], 'Content filter needs approval');
  }
  steps.push(step('filter', 'Content filter attached', `${f.label}.`, { raiPolicyName: p.filter === 'default' ? 'Microsoft.DefaultV2' : `custom-${p.filter}` }, p.filter === 'annotate' ? 'warn' : 'ok'));
  steps.push(step('deployment', 'Deployment created', `Deployment "${name}" is serving ${m.name} ${m.version}.`, { name, provisioningState: 'Succeeded' }));

  // 6. Agent
  if (!role.agents) {
    steps.push(step('agent', 'Agent creation forbidden', 'Reader cannot create agents.', null, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: 'Grant Azure AI User on the project.' }], 'Agent creation forbidden');
  }
  const agentModel = String(p.agentModel || '').trim();
  if (agentModel !== name) {
    const looksLikeModel = Object.values(MODELS).some(x => x.name === agentModel);
    steps.push(step('agent', 'Agent references an unknown deployment', `The agent's model is "${agentModel}", but the project only has a deployment named "${name}".${looksLikeModel ? ' That is a model name: agents and SDK calls use the deployment name.' : ''}`, { agentModel, deployments: [name], code: 'DeploymentNotFound (illustrative)' }, 'error'));
    return stop([{ type: 'alert', tone: 'error', text: `Set the agent model to "${name}".` }], 'Agent: deployment not found');
  }
  const instr = String(p.instructions || '').trim();
  const agentDef = { name: 'returns-assistant', model: agentModel, instructions: instr || '(empty)', tools: p.tool === 'none' ? [] : [{ type: p.tool }] };
  if (!instr) steps.push(step('agent', 'Agent created without instructions', 'With no instructions the agent has no role, scope or tone; behaviour is generic and hard to evaluate.', agentDef, 'warn'));
  else if (estTokens(instr) < 12) steps.push(step('agent', 'Agent created with thin instructions', 'Instructions are very short: state the role, scope, tools to use, and what to refuse.', agentDef, 'warn'));
  else steps.push(step('agent', 'Agent created', `Agent "returns-assistant" → deployment "${name}" with ${p.tool === 'none' ? 'no tools' : p.tool}.`, agentDef));

  // 7. Smoke test
  const toolNote = { none: 'Answered from instructions only.', file_search: 'Called file_search over the attached vector store and cited returns-policy.pdf.', code_interpreter: 'Ran Python in the sandbox to compute the refund.', function: 'Run paused with requires_action; the test harness executed get_order and submitted the output.' }[p.tool];
  const tested = p.tool !== 'none';
  steps.push(step('test', tested ? 'Smoke test passed' : 'Smoke test: no tool exercised', `Test prompt: "Can I return order 1182?" ${toolNote}`, { latencyClass: m.reasoning ? 'slower (reasoning tokens)' : 'normal', toolCalls: tested ? 1 : 0 }, tested ? 'ok' : 'info'));

  return {
    steps,
    output: [
      { type: 'json', title: 'Model deployment (illustrative ARM shape)', data: { name, sku: { name: 'GlobalStandard', capacity: p.capacity }, properties: { model: { format: 'OpenAI', name: m.name, version: m.version }, versionUpgradeOption: p.upgrade, raiPolicyName: p.filter === 'default' ? 'Microsoft.DefaultV2' : `custom-${p.filter}` } } },
      { type: 'json', title: 'Agent definition (illustrative)', data: agentDef },
      { type: 'code', title: 'Same thing in code (illustrative; check SDK reference for exact names)', lang: 'python', text: [
        'from azure.ai.projects import AIProjectClient',
        'from azure.identity import DefaultAzureCredential',
        'project = AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=DefaultAzureCredential())',
        `agent = project.agents.create_agent(model="${agentModel}",  # deployment name, not model name`,
        '    name="returns-assistant",',
        `    instructions=${JSON.stringify(instr.slice(0, 60) + (instr.length > 60 ? '…' : ''))},`,
        `    tools=${p.tool === 'none' ? '[]' : `[...${p.tool} tool definition...]`})`,
      ].join('\n') },
      { type: 'chat', title: 'Smoke test', turns: [{ role: 'user', text: 'Can I return order 1182?' }, ...(tested ? [{ role: 'tool', text: toolNote, meta: p.tool }] : []), { role: 'assistant', text: tested ? 'Yes. Order 1182 was delivered 12 days ago, within the 30-day window [returns-policy.pdf].' : 'Most items can be returned within 30 days.' }] },
    ],
    metrics: [
      metric('Stages passed', `${steps.filter(s => s.status === 'ok').length}/${steps.length}`, 'computed'),
      metric('Quota headroom', `${p.quota - p.capacity}K TPM`, 'computed', 'Simulated remaining quota after this deployment.'),
      metric('Instruction size', `≈${estTokens(instr)} tokens`, 'estimate', '4-characters-per-token heuristic.'),
    ],
    summary: `${name}: ${m.name} ${m.version}, ${p.capacity}K TPM, ${p.upgrade}, agent tools=${p.tool}`,
  };
}

export default {
  id: '1.2.3',
  lab: 'Model and agent deployment configurator',
  services: [
    { name: 'Create and manage model deployments', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/create-resource' },
    { name: 'Model versions and upgrade policies', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/model-versions' },
    { name: 'Configure content filters', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/content-filters' },
    { name: 'Quickstart: create an agent', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/quickstart' },
  ],
  prereqs: ['1.2.2'],
  next: ['1.2.4', '1.3.1', '2.2.1'],

  concept: {
    plain: 'A model deployment is a named, configured copy of a model you can call: which model and version, how it upgrades, how much throughput it gets and which safety filter applies. An agent is then defined on top: its instructions, the deployment it uses and the tools it may call. Most deployment failures are boring and predictable: no permission, not enough quota, an old version, or an agent pointing at a name that does not exist.',
    technical: 'Deployments (Microsoft.CognitiveServices/accounts/deployments) specify model format/name/version, a SKU (deployment type) with capacity (TPM units for standard types, PTUs for provisioned), versionUpgradeOption (OnceNewDefaultVersionAvailable, OnceCurrentVersionExpired, NoAutoUpgrade) and a raiPolicyName for content filtering. Creating them is a control-plane action requiring roles such as Cognitive Services Contributor; Azure AI User covers data-plane work such as building agents. Quota is per subscription, region, model and deployment type. An agent in Foundry Agent Service references the deployment name in its model field, plus instructions and tool definitions.',
    useCase: 'A platform team deploys "chat-prod" (gpt-4.1-mini, 100K TPM, OnceCurrentVersionExpired, default content filter) through a pipeline identity with Cognitive Services Contributor; app developers with Azure AI User create a returns agent that references "chat-prod" and uses file search over the returns policy.',
    terms: [
      ['Deployment name', 'The name your code and agents call; independent of the model name.'],
      ['Version upgrade option', 'How a deployment moves to newer model versions: auto on new default, at expiry, or never.'],
      ['TPM capacity', 'Tokens-per-minute throughput assigned to a deployment from your quota.'],
      ['raiPolicyName', 'The content filter configuration attached to a deployment.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'auth', label: 'Who deploys?', col: 0, row: 1, kind: 'policy', badge: p ? (ROLES[p.role].deploy ? 'allowed' : 'denied') : undefined, detail: 'Control-plane role needed to create deployments.' },
          { id: 'model', label: p ? `Model: ${MODELS[p.model].label}` : 'Model + version', col: 1, row: 0, kind: 'ai', detail: 'Pick a GA version and an upgrade policy.' },
          { id: 'quota', label: p ? `Capacity: ${p.capacity}K TPM` : 'Capacity', col: 1, row: 1, kind: 'compute', detail: 'Taken from your quota.' },
          { id: 'filter', label: 'Content filter', col: 1, row: 2, kind: 'policy', detail: 'Default or custom RAI policy.' },
          { id: 'deployment', label: p ? `Deployment "${p.deploymentName}"` : 'Deployment', col: 2, row: 1, kind: 'ai', detail: 'The callable name.' },
          { id: 'agent', label: 'Agent definition', col: 3, row: 1, kind: 'app', detail: 'Instructions + deployment name + tools.', substeps: ['Instructions', 'Model = deployment name', 'Tools'] },
          { id: 'test', label: 'Smoke test', col: 4, row: 1, kind: 'user', detail: 'One prompt that exercises the tool.' },
        ],
        edges: [['auth', 'model'], ['model', 'deployment'], ['quota', 'deployment'], ['filter', 'deployment'], ['deployment', 'agent'], ['agent', 'test']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'auth', label: 'Deployer identity (Entra ID)', col: 0, row: 1, kind: 'policy', detail: p ? ROLES[p.role].label : 'Role assignment on the Foundry resource.' },
          { id: 'quota', label: 'Subscription quota (region × model × type)', col: 1, row: 0, kind: 'policy', detail: 'Shared by all deployments of that model/type in the region.' },
          { id: 'deployment', label: 'Foundry resource → deployment', col: 1, row: 1.5, kind: 'ai', detail: 'Model, version, SKU, capacity, RAI policy.' },
          { id: 'filter', label: 'RAI policy', col: 1, row: 3, kind: 'policy', detail: 'Content filtering on prompts and completions.' },
          { id: 'agent', label: 'Foundry project → Agent Service', col: 2, row: 1.5, kind: 'compute', detail: 'Agent references the deployment by name.' },
          { id: 'model', label: 'Model catalog / lifecycle', col: 0, row: 3, kind: 'data', detail: 'GA, deprecated and retired versions.' },
          { id: 'test', label: 'Test client', col: 3, row: 1.5, kind: 'app', detail: 'Calls the agent.' },
        ],
        edges: [['auth', 'deployment', 'create'], ['quota', 'deployment'], ['filter', 'deployment'], ['model', 'deployment'], ['deployment', 'agent', 'model: name'], ['test', 'agent']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'auth', label: 'az role assignment list --assignee <you> --scope <foundry-resource>', col: 0, row: 0, kind: 'code', detail: 'Check you have a deployment-capable role.' },
          { id: 'model', label: `model: { format: 'OpenAI', name: '${p ? MODELS[p.model].name : 'gpt-4.1'}', version: '${p ? MODELS[p.model].version : '2025-04-14'}' }`, col: 0, row: 1, kind: 'code', detail: 'Bicep/ARM model block.' },
          { id: 'quota', label: `sku: { name: 'GlobalStandard', capacity: ${p ? p.capacity : 50} }`, col: 0, row: 2, kind: 'code', detail: 'Capacity in thousands of TPM for standard types.' },
          { id: 'filter', label: `versionUpgradeOption: '${p ? p.upgrade : 'OnceCurrentVersionExpired'}', raiPolicyName: '...'`, col: 0, row: 3, kind: 'code', detail: 'Upgrade policy and content filter.' },
          { id: 'deployment', label: `resource dep 'Microsoft.CognitiveServices/accounts/deployments@<api>' = { name: '${p ? p.deploymentName : 'chat-prod'}' ... }`, col: 0, row: 4, kind: 'code', detail: 'Illustrative Bicep.' },
          { id: 'agent', label: `project.agents.create_agent(model="${p ? p.agentModel : 'chat-prod'}", instructions=..., tools=[...])`, col: 0, row: 5, kind: 'code', detail: 'Illustrative SDK call.' },
          { id: 'test', label: 'run agent with a test prompt; assert a tool call happened', col: 0, row: 6, kind: 'code', detail: 'Cheap check before promoting.' },
        ],
        edges: [['auth', 'model'], ['model', 'quota'], ['quota', 'filter'], ['filter', 'deployment'], ['deployment', 'agent'], ['agent', 'test']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'role', label: 'Your role on the Foundry resource', type: 'select', options: Object.entries(ROLES).map(([v, r]) => [v, r.label]), default: 'owner' },
      { id: 'model', label: 'Model and version', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-4.1' },
      { id: 'upgrade', label: 'Version upgrade policy', type: 'select', options: [['OnceNewDefaultVersionAvailable', 'Auto-upgrade when new default is available'], ['OnceCurrentVersionExpired', 'Upgrade when current version expires'], ['NoAutoUpgrade', 'No auto-upgrade (pinned)']], default: 'OnceCurrentVersionExpired' },
      { id: 'deploymentName', label: 'Deployment name', type: 'text', default: 'chat-prod' },
      { id: 'capacity', label: 'Capacity (K TPM)', type: 'range', min: 10, max: 300, step: 10, default: 50 },
      { id: 'quota', label: 'Remaining quota (K TPM, simulated)', type: 'number', min: 0, max: 1000, step: 10, default: 150, help: 'Real quota depends on subscription, region, model and deployment type.' },
      { id: 'filter', label: 'Content filter', type: 'select', options: Object.entries(FILTERS).map(([v, f]) => [v, f.label]), default: 'default' },
      { id: 'filterApproved', label: 'Modified content filtering approved', type: 'toggle', default: false },
      { id: 'agentModel', label: 'Agent: model (deployment name)', type: 'text', default: 'chat-prod' },
      { id: 'instructions', label: 'Agent: instructions', type: 'textarea', default: 'You are the Contoso returns assistant. Answer return and refund questions using the returns policy. Cite the policy section. Do not promise refunds outside policy; offer a human handover instead.' },
      { id: 'tool', label: 'Agent: tool', type: 'select', options: [['none', 'None'], ['file_search', 'File search'], ['code_interpreter', 'Code interpreter'], ['function', 'Function (get_order)']], default: 'none' },
    ],
    samples: [
      { label: 'Production chat deployment + agent', values: { model: 'gpt-4.1-mini', capacity: 100, tool: 'file_search' } },
      { label: 'Reasoning model, pinned', values: { model: 'o4-mini', upgrade: 'NoAutoUpgrade', deploymentName: 'reasoner', agentModel: 'reasoner', tool: 'code_interpreter' } },
      { label: 'Agent pointing at model name', values: { agentModel: 'gpt-4.1' } },
      { label: 'Over-quota request', values: { capacity: 250 } },
    ],
    run: deploy,
  },

  compare: {
    suggestions: [
      'Compare the three version upgrade policies on gpt-4.1 and read the trade-off in the model step.',
      'Run with capacity 100 then 200 (quota 150) and compare.',
      'Compare tool = none vs file_search and look at the smoke test answer.',
    ],
  },

  debug: [
    { id: 'name', title: 'Agent fails: deployment not found', values: { agentModel: 'gpt-4.1' }, node: 'agent',
      symptom: 'Error: the agent references "gpt-4.1" but the deployment is "chat-prod".', cause: 'The model name was used where the deployment name is required.', fix: 'Set Agent model to the deployment name (chat-prod).' },
    { id: 'quota', title: 'Deployment fails with InsufficientQuota', values: { capacity: 250, quota: 150 }, node: 'quota',
      symptom: 'Requested 250K TPM, 150K available.', cause: 'Quota is shared per subscription/region/model/type.', fix: 'Lower capacity to ≤150 (or free/request quota).' },
    { id: 'deprecated', title: 'Cannot deploy the version the old app used', values: { model: 'gpt-4o-old' }, node: 'model',
      symptom: 'New deployment refused for a deprecated version.', cause: 'Deprecated versions cannot be newly deployed.', fix: 'Choose a current GA model/version and re-evaluate.' },
    { id: 'rbac', title: 'Developer gets 403 creating a deployment', values: { role: 'aiUser' }, node: 'auth',
      symptom: 'AuthorizationFailed on deployments/write.', cause: 'Azure AI User is a data-plane role; deployments are control-plane resources.', fix: 'Use an identity with Cognitive Services Contributor / Azure AI Account Owner.' },
    { id: 'filter', title: 'Custom content filter rejected', values: { filter: 'annotate', filterApproved: false }, node: 'filter',
      symptom: 'Annotate-only configuration rejected.', cause: 'Turning filtering off requires approval for modified content filtering.', fix: 'Use the default or a stricter filter (or get approval).' },
    { id: 'pinned', title: 'Pinned deployment will stop at retirement', values: { upgrade: 'NoAutoUpgrade' }, node: 'model',
      symptom: 'Warning on the model step.', cause: 'NoAutoUpgrade deployments stop serving when the version retires.', fix: 'Use OnceCurrentVersionExpired (or plan a manual upgrade with evaluation).' },
  ],

  challenge: {
    task: 'Ship a cost-efficient returns agent: gpt-4.1-mini, as much capacity as quota allows, an upgrade policy that will not stop serving at retirement, and a tool that grounds answers in the policy document.',
    condition: 'Model gpt-4.1-mini, capacity = remaining quota, upgrade policy is not NoAutoUpgrade, tool = file_search, and no warn/error steps.',
    hint: 'Capacity can equal quota but not exceed it. The agent must reference the deployment name.',
    check: (p, res) => p.model === 'gpt-4.1-mini' && p.capacity === p.quota && p.upgrade !== 'NoAutoUpgrade' && p.tool === 'file_search' && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Role: Cognitive Services Contributor / Azure AI Account Owner.', 'Model: gpt-4.1-mini; upgrade: OnceCurrentVersionExpired.', 'Capacity 150 with quota 150.', 'Content filter: default.', 'Agent model: chat-prod; tool: file search; keep the instructions.'],
    solutionValues: { role: 'owner', model: 'gpt-4.1-mini', upgrade: 'OnceCurrentVersionExpired', deploymentName: 'chat-prod', capacity: 150, quota: 150, filter: 'default', agentModel: 'chat-prod', tool: 'file_search' },
  },

  quiz: [
    { q: 'Your code calls model="gpt-4.1" and gets "deployment not found", but the portal shows gpt-4.1 deployed as "support-chat". What do you change?', options: ['Redeploy with more TPM', 'Use model="support-chat"', 'Switch to NoAutoUpgrade', 'Assign Reader'], answer: 1, why: 'Calls and agents reference the deployment name, not the model name.' },
    { q: 'A regulated app must not change model behaviour without a test cycle, but must not stop serving unexpectedly. Which upgrade option is the best compromise?', options: ['OnceNewDefaultVersionAvailable', 'OnceCurrentVersionExpired, with an upgrade evaluated before retirement', 'NoAutoUpgrade and forget about it', 'Delete and recreate weekly'], answer: 1, why: 'It stays on the tested version until expiry and still upgrades rather than stopping; plan your own evaluated upgrade before then.' },
    { q: 'A developer with Azure AI User can build agents but gets 403 creating a deployment. Why?', options: ['Quota exceeded', 'Deployments are control-plane resources needing a role such as Cognitive Services Contributor', 'Content filter blocked it', 'Region mismatch'], answer: 1, why: 'Azure AI User grants data-plane actions; deployments/write is control plane.' },
  ],

  recap: 'Configure a deployment with a GA model version, an upgrade policy you can live with, capacity within quota and the right content filter, created by an identity with control-plane rights. Then define the agent with clear instructions, the deployment name (not the model name) and the tools it needs, and smoke-test a tool call before promoting.',
};
