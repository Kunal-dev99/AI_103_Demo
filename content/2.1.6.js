// 2.1.6 Configure an application to connect to a Foundry project
// Lab: Project connection wizard.
import { step, metric } from '../src/engine/util.js';

// The simulated Azure estate.
const ESTATE = {
  resource: 'contoso-ai',
  projects: ['support', 'hr-assistant'],
  deployments: ['gpt-4o', 'text-embedding-3-large'],
  connections: ['contoso-search', 'hr-sharepoint'],
};
const GOOD_ENV = 'PROJECT_ENDPOINT=https://contoso-ai.services.ai.azure.com/api/projects/support\nMODEL_DEPLOYMENT_NAME=gpt-4o';
const ENDPOINT_RE = /^https:\/\/([a-z0-9-]+)\.services\.ai\.azure\.com\/api\/projects\/([A-Za-z0-9_-]+)\/?$/;

function parseEnv(text) {
  const env = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

function diagnoseEndpoint(ep) {
  if (!ep) return { ok: false, why: 'PROJECT_ENDPOINT is not set.', fix: 'Copy the project endpoint from the Foundry portal (project Overview page).' };
  if (ep.includes(';')) return { ok: false, why: 'This is a legacy hub-based project connection string (region;subscription;resource group;project). Current Foundry projects use an HTTPS project endpoint.', fix: 'Use https://<resource>.services.ai.azure.com/api/projects/<project>.' };
  if (/openai\.azure\.com/.test(ep)) return { ok: false, why: 'This is the Azure OpenAI endpoint of the resource. It serves model inference only; AIProjectClient needs the project endpoint.', fix: 'Use the .services.ai.azure.com/api/projects/<project> endpoint.' };
  if (/^http:\/\//.test(ep)) return { ok: false, why: 'Endpoint must use HTTPS.', fix: 'Use https://.' };
  if (/services\.ai\.azure\.com\/?$/.test(ep)) return { ok: false, why: 'Resource endpoint without the /api/projects/<project> path. The client cannot tell which project to use.', fix: 'Append /api/projects/<project-name>.' };
  const m = ep.match(ENDPOINT_RE);
  if (!m) return { ok: false, why: `"${ep}" does not match https://<resource>.services.ai.azure.com/api/projects/<project>.`, fix: 'Copy the endpoint exactly from the portal.' };
  if (m[1] !== ESTATE.resource) return { ok: false, dns: true, why: `No Foundry resource named "${m[1]}" (DNS lookup fails).`, fix: `Resource name is "${ESTATE.resource}".` };
  if (!ESTATE.projects.includes(m[2])) return { ok: false, notFound: true, why: `Project "${m[2]}" does not exist under ${ESTATE.resource} (HTTP 404).`, fix: `Existing projects: ${ESTATE.projects.join(', ')}.` };
  return { ok: true, resource: m[1], project: m[2] };
}

function connect(p) {
  const env = parseEnv(p.env);
  const steps = [];
  const checks = [];
  const add = (name, ok, note) => checks.push([name, ok === true ? 'pass' : ok === 'warn' ? 'warn' : ok === null ? 'not run' : 'FAIL', note]);
  const fin = () => finish(p, env, steps, checks);
  const where = p.runtime === 'local' ? 'developer laptop' : 'Azure Container Apps';

  // 1. Configuration
  const d = diagnoseEndpoint(env.PROJECT_ENDPOINT);
  if (!d.ok) {
    steps.push(step('config', 'PROJECT_ENDPOINT invalid', d.why, { PROJECT_ENDPOINT: env.PROJECT_ENDPOINT || null, expectedFormat: 'https://<resource>.services.ai.azure.com/api/projects/<project>', fix: d.fix }, 'error'));
    add('Endpoint format', false, d.why); return fin();
  }
  steps.push(step('config', 'Configuration loaded', `Resource "${d.resource}", project "${d.project}". ${Object.keys(env).length} variable(s) read.`, { env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, /KEY|SECRET/i.test(k) ? '***' : v])) }));
  add('Endpoint format', true, `${d.resource} / ${d.project}`);
  if (Object.keys(env).some(k => /API_KEY|SECRET/i.test(k))) add('No secrets in config', 'warn', 'Key or secret found in environment; prefer keyless Entra auth.');

  // 2. Credential
  let identity;
  if (p.credential === 'key') {
    steps.push(step('credential', 'API key not accepted', 'AIProjectClient requires a Microsoft Entra TokenCredential. Keys can only call some model endpoints directly, and many organisations disable key (local) auth entirely.', { error: 'TypeError / unsupported credential (illustrative)', fix: 'Use DefaultAzureCredential' }, 'error'));
    add('Credential', false, 'API key'); return fin();
  }
  if (p.runtime === 'local') {
    if (p.credential === 'mi') {
      steps.push(step('credential', 'ManagedIdentityCredential unavailable', 'There is no managed identity endpoint on a developer laptop.', { error: 'CredentialUnavailableError: ManagedIdentityCredential authentication unavailable' }, 'error'));
      add('Credential', false, 'MI on laptop'); return fin();
    }
    if (p.tenant === 'other') {
      steps.push(step('credential', 'Token from the wrong tenant', 'AzureCliCredential returned a token for the tenant you last logged into with az login, not the tenant that owns the Foundry resource.', { httpStatus: 401, error: 'InvalidAuthenticationTokenTenant (illustrative)', fix: 'az login --tenant <resource tenant id>, or set AZURE_TENANT_ID' }, 'error'));
      add('Credential', false, 'wrong tenant'); return fin();
    }
    identity = 'your user account (AzureCliCredential via DefaultAzureCredential)';
  } else {
    if (p.identity === 'none') {
      steps.push(step('credential', 'No identity in Azure', 'DefaultAzureCredential tried environment, workload identity and managed identity — none available on this container app.', { error: 'DefaultAzureCredential failed to retrieve a token from the included credentials.' }, 'error'));
      add('Credential', false, 'no managed identity'); return fin();
    }
    if (p.identity === 'user' && !env.AZURE_CLIENT_ID) {
      steps.push(step('credential', 'User-assigned identity not selected', 'The app has a user-assigned managed identity but AZURE_CLIENT_ID is not set, so DefaultAzureCredential does not know which identity to use.', { missing: 'AZURE_CLIENT_ID', fix: 'Set AZURE_CLIENT_ID to the identity\'s client ID (or pass managed_identity_client_id)' }, 'error'));
      add('Credential', false, 'AZURE_CLIENT_ID missing'); return fin();
    }
    identity = p.identity === 'user' ? `user-assigned managed identity (${env.AZURE_CLIENT_ID})` : 'system-assigned managed identity';
  }
  steps.push(step('credential', 'Token acquired', `Signed in as ${identity}. Scope: https://ai.azure.com/.default (illustrative).`, { identity, runtime: where }));
  add('Credential', true, identity);

  // 3. Network
  if (p.network === 'private') {
    const reachable = p.runtime === 'aca' && p.vnet;
    if (!reachable) {
      steps.push(step('network', 'Blocked by network rules', `Public network access is disabled on the Foundry resource and the ${where} is not reaching it through the private endpoint.`, { httpStatus: 403, error: 'Public access is disabled. Please configure private endpoint. (illustrative)', fix: p.runtime === 'local' ? 'Connect through VPN/jump box in the VNet, or test from the deployed app' : 'Enable VNet integration with private DNS for privatelink.services.ai.azure.com' }, 'error'));
      add('Network path', false, 'public access disabled'); return fin();
    }
    steps.push(step('network', 'Private endpoint reached', 'DNS resolves to the private IP via the private DNS zone.', { network: 'private endpoint' }));
    add('Network path', true, 'private endpoint');
  } else {
    steps.push(step('network', 'Public endpoint reachable', 'Resource accepts public traffic (consider private endpoints for production).', { network: 'public' }, 'ok'));
    add('Network path', true, 'public');
  }

  // 4. RBAC
  if (p.role !== 'aiuser') {
    steps.push(step('rbac', 'Authenticated but not authorized', `The identity has "${p.role === 'contributor' ? 'Contributor' : p.role === 'reader' ? 'Reader' : 'no role'}" on the project. ${p.role === 'contributor' ? 'Contributor manages resources (control plane) but grants no data actions such as calling agents or models.' : 'It cannot use project data-plane operations.'}`,
      { httpStatus: 403, error: 'PermissionDenied: principal does not have access to perform the data action (illustrative)', fix: 'Assign "Azure AI User" on the project (or resource) to this identity' }, 'error'));
    add('RBAC', false, p.role); return fin();
  }
  steps.push(step('rbac', 'Data-plane role present', '"Azure AI User" grants the data actions needed to use models, agents and connections in the project.', { role: 'Azure AI User', scope: `${d.resource}/projects/${d.project}` }));
  add('RBAC', true, 'Azure AI User');

  // 5. Project calls
  steps.push(step('project', 'Connected to project', `Listed ${ESTATE.deployments.length} deployments and ${ESTATE.connections.length} connections.`, { deployments: ESTATE.deployments, connections: ESTATE.connections }));
  add('Project reachable', true, `${ESTATE.deployments.length} deployments`);

  // 6. Test call
  const dep = env.MODEL_DEPLOYMENT_NAME;
  if (!dep || !ESTATE.deployments.includes(dep)) {
    steps.push(step('test', 'Test call failed', dep ? `MODEL_DEPLOYMENT_NAME="${dep}" is not a deployment in this project.` : 'MODEL_DEPLOYMENT_NAME is not set.', { httpStatus: 404, error: 'DeploymentNotFound', available: ESTATE.deployments }, 'error'));
    add('Test chat call', false, dep || 'missing'); return fin();
  }
  steps.push(step('test', 'Test chat call succeeded', `get_openai_client().chat.completions.create(model="${dep}", …) returned a reply.`, { reply: 'pong', model: dep }));
  add('Test chat call', true, dep);
  return fin();
}

function finish(p, env, steps, checks) {
  const err = steps.find(s => s.status === 'error');
  const output = [];
  output.push({ type: 'table', title: 'Connection checklist', columns: ['Check', 'Result', 'Detail'], rows: checks, tones: checks.map(c => (c[1] === 'pass' ? 'ok' : c[1] === 'warn' ? 'warn' : 'error')) });
  if (err) output.push({ type: 'alert', tone: 'error', text: `${err.title}: ${err.detail}${err.data && err.data.fix ? ' Fix: ' + err.data.fix : ''}` });
  else output.push({ type: 'alert', tone: 'ok', text: 'The app can reach the project, authenticate keylessly and call a model deployment (simulated).' });
  const cred = p.credential === 'mi' ? `ManagedIdentityCredential(${p.identity === 'user' ? 'client_id=os.environ["AZURE_CLIENT_ID"]' : ''})` : p.credential === 'key' ? 'AzureKeyCredential(os.environ["API_KEY"])  # not supported here' : 'DefaultAzureCredential()';
  output.push({ type: 'code', title: 'Client setup (illustrative)', lang: 'python', text:
`import os
from azure.identity import ${p.credential === 'mi' ? 'ManagedIdentityCredential' : 'DefaultAzureCredential'}
from azure.ai.projects import AIProjectClient

project = AIProjectClient(
    endpoint=os.environ["PROJECT_ENDPOINT"],
    credential=${cred},
)
client = project.get_openai_client()   # method name varies by SDK version
print(client.chat.completions.create(model=os.environ["MODEL_DEPLOYMENT_NAME"],
      messages=[{"role": "user", "content": "ping"}]).choices[0].message.content)` });
  output.push({ type: 'kv', title: 'Parsed environment', items: Object.entries(env).map(([k, v]) => [k, /KEY|SECRET/i.test(k) ? '***' : v]) });
  const passed = checks.filter(c => c[1] === 'pass').length;
  return {
    steps, output,
    metrics: [
      metric('Checks passed', `${passed}/6`, 'computed', 'Endpoint, credential, network, RBAC, project, test call.'),
      metric('Secrets in config', Object.keys(env).some(k => /API_KEY|SECRET/i.test(k)) ? 'yes' : 'none', 'computed'),
      metric('Auth mode', p.credential === 'key' ? 'key' : 'keyless (Entra ID)', 'computed'),
    ],
    summary: err ? `Failed at ${err.node}: ${err.title}` : `Connected from ${p.runtime === 'local' ? 'laptop' : 'Container Apps'} via ${p.credential} (${p.network})`,
  };
}

const nodes = (p, L) => [
  { id: 'config', label: L.config, col: 0, row: 1, kind: 'data', detail: 'PROJECT_ENDPOINT = https://<resource>.services.ai.azure.com/api/projects/<project>; MODEL_DEPLOYMENT_NAME; AZURE_CLIENT_ID for a user-assigned identity.' },
  { id: 'credential', label: L.credential, col: 1, row: 0, kind: 'policy', badge: p ? p.credential : undefined, detail: 'DefaultAzureCredential: Azure CLI / VS Code sign-in locally, managed identity in Azure. Same code in both places.', substeps: ['EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential', 'AzureCliCredential / dev tools'] },
  { id: 'network', label: L.network, col: 1, row: 2, kind: 'compute', badge: p ? p.network : undefined, detail: 'Public endpoint, or private endpoint + private DNS when public network access is disabled.' },
  { id: 'rbac', label: L.rbac, col: 2, row: 1, kind: 'policy', badge: p ? { aiuser: 'Azure AI User', contributor: 'Contributor', reader: 'Reader', none: 'none' }[p.role] : undefined, detail: 'Data-plane role such as "Azure AI User" at project or resource scope. Owner/Contributor alone do not grant data actions.' },
  { id: 'project', label: L.project, col: 3, row: 1, kind: 'ai', detail: 'Foundry project: deployments, connections, agents, evaluations.' },
  { id: 'test', label: L.test, col: 4, row: 1, kind: 'app', detail: 'Smoke test: one small chat call with the configured deployment name.' },
];

export default {
  id: '2.1.6',
  lab: 'Project connection wizard',
  services: [
    { name: 'Foundry SDK: connect to a project', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/develop/sdk-overview' },
    { name: 'Role-based access control in Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/rbac-azure-ai-foundry' },
    { name: 'DefaultAzureCredential (Azure Identity for Python)', url: 'https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.defaultazurecredential' },
  ],
  prereqs: ['1.2.1', '1.3.4'],
  next: ['2.1.5', '2.1.1'],

  concept: {
    plain: 'Your app needs three things to talk to a Foundry project: the right address (the project endpoint), a way to prove who it is (a credential), and permission to do the work (a role). On your laptop it signs in as you; in Azure it signs in as its managed identity — the same code works in both if you use DefaultAzureCredential. If the project is locked to a private network, the app must also be inside that network.',
    technical: 'Create AIProjectClient(endpoint=PROJECT_ENDPOINT, credential=TokenCredential). The endpoint format is https://<foundry-resource>.services.ai.azure.com/api/projects/<project-name> (hub-based connection strings are legacy). DefaultAzureCredential resolves to environment/workload identity/managed identity in Azure and Azure CLI or developer tool sign-in locally; user-assigned identities need AZURE_CLIENT_ID. Authorization is Azure RBAC on the data plane (e.g. "Azure AI User" on the project). When public network access is disabled, traffic must arrive through a private endpoint with privatelink DNS. Keep configuration in environment variables or App Configuration, not code.',
    useCase: 'A team develops locally with az login against the "support" project, then deploys to Azure Container Apps with a user-assigned managed identity granted "Azure AI User". Production disables public network access, so the container app uses VNet integration and private DNS. The same code and environment-variable names work in both places.',
    terms: [
      ['Project endpoint', 'https://<resource>.services.ai.azure.com/api/projects/<project>: the address AIProjectClient needs.'],
      ['DefaultAzureCredential', 'Credential chain that picks the right sign-in method for the environment.'],
      ['Managed identity', 'Azure-managed identity for a compute resource; system-assigned or user-assigned (needs AZURE_CLIENT_ID).'],
      ['Azure AI User', 'Built-in data-plane role for using a Foundry project (models, agents) without managing it.'],
      ['Private endpoint', 'Private IP for the resource inside a VNet; requires matching private DNS.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: nodes(p, { config: 'Address (endpoint)', credential: 'Who am I?', network: 'Can I reach it?', rbac: 'Am I allowed?', project: 'Foundry project', test: 'Test call' }),
        edges: [['config', 'credential'], ['config', 'network'], ['credential', 'rbac', 'token'], ['network', 'rbac'], ['rbac', 'project'], ['project', 'test']],
      }),
      architectural: p => ({
        nodes: nodes(p, { config: p && p.runtime === 'aca' ? 'Container App env vars' : '.env on laptop', credential: p && p.runtime === 'aca' ? `Managed identity (${p.identity})` : 'az login (developer)', network: p && p.network === 'private' ? 'Private endpoint + DNS' : 'Public endpoint', rbac: 'Microsoft Entra ID + Azure RBAC', project: `Foundry resource ${ESTATE.resource} / project`, test: 'Model deployment' }),
        edges: [['config', 'credential'], ['config', 'network', 'HTTPS'], ['credential', 'rbac', 'token'], ['network', 'rbac'], ['rbac', 'project'], ['project', 'test']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'config', label: 'endpoint = os.environ["PROJECT_ENDPOINT"]', col: 0, row: 0, kind: 'code', detail: 'Never hard-code; one value per environment.' },
          { id: 'credential', label: p && p.credential === 'mi' ? 'cred = ManagedIdentityCredential(client_id=...)' : 'cred = DefaultAzureCredential()', col: 0, row: 1, kind: 'code', detail: 'Use DefaultAzureCredential for portability between laptop and Azure.' },
          { id: 'network', label: '# nslookup contoso-ai.services.ai.azure.com → private IP?', col: 0, row: 2, kind: 'code', detail: 'Check DNS resolution when private endpoints are used.' },
          { id: 'rbac', label: 'az role assignment create --role "Azure AI User" --assignee <principal> --scope <project id>', col: 0, row: 3, kind: 'code', detail: 'Grant the identity a data-plane role.' },
          { id: 'project', label: 'project = AIProjectClient(endpoint=endpoint, credential=cred)', col: 0, row: 4, kind: 'code', detail: 'Entry point to the project.' },
          { id: 'test', label: 'project.get_openai_client().chat.completions.create(model=DEPLOYMENT, ...)', col: 0, row: 5, kind: 'code', detail: 'Illustrative smoke test.' },
        ],
        edges: [['config', 'credential'], ['credential', 'network'], ['network', 'rbac'], ['rbac', 'project'], ['project', 'test']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'env', label: 'Environment variables (.env / app settings)', type: 'textarea', default: GOOD_ENV },
      { id: 'runtime', label: 'Where the app runs', type: 'select', options: [['local', 'Developer laptop (az login)'], ['aca', 'Azure Container Apps']], default: 'local' },
      { id: 'credential', label: 'Credential in code', type: 'select', options: [['default', 'DefaultAzureCredential'], ['mi', 'ManagedIdentityCredential'], ['key', 'API key']], default: 'default' },
      { id: 'identity', label: 'Managed identity on the app (Azure only)', type: 'select', options: [['system', 'System-assigned'], ['user', 'User-assigned'], ['none', 'None']], default: 'system' },
      { id: 'tenant', label: 'az login tenant (laptop only)', type: 'select', options: [['same', 'Resource tenant'], ['other', 'A different tenant']], default: 'same' },
      { id: 'role', label: 'Role of the calling identity on the project', type: 'select', options: [['aiuser', 'Azure AI User'], ['contributor', 'Contributor'], ['reader', 'Reader'], ['none', 'None']], default: 'aiuser' },
      { id: 'network', label: 'Foundry resource network access', type: 'select', options: [['public', 'Public network access enabled'], ['private', 'Disabled (private endpoint only)']], default: 'public' },
      { id: 'vnet', label: 'App has VNet integration + private DNS', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Azure OpenAI endpoint by mistake', values: { env: 'PROJECT_ENDPOINT=https://contoso-ai.openai.azure.com/\nMODEL_DEPLOYMENT_NAME=gpt-4o' } },
      { label: 'Legacy hub connection string', values: { env: 'PROJECT_ENDPOINT=eastus.api.azureml.ms;0000-sub;rg-ai;support\nMODEL_DEPLOYMENT_NAME=gpt-4o' } },
      { label: 'Container Apps, system identity', values: { runtime: 'aca', identity: 'system' } },
      { label: 'Container Apps, private network', values: { runtime: 'aca', network: 'private', vnet: true } },
    ],
    run: connect,
  },

  compare: {
    suggestions: [
      'Run the same configuration on the laptop and in Container Apps; compare which identity is used.',
      'Try the resource endpoint, the Azure OpenAI endpoint and the project endpoint and compare the diagnostics.',
      'Switch the role between Contributor and Azure AI User and compare the RBAC step.',
    ],
  },

  debug: [
    { id: 'format', title: 'Client raises on the first call', values: { env: 'PROJECT_ENDPOINT=https://contoso-ai.services.ai.azure.com\nMODEL_DEPLOYMENT_NAME=gpt-4o' }, node: 'config',
      symptom: 'Endpoint rejected / 404 on project operations.', cause: 'Resource endpoint without /api/projects/<project>.', fix: 'Set PROJECT_ENDPOINT=https://contoso-ai.services.ai.azure.com/api/projects/support.' },
    { id: 'contrib', title: 'Owner of the resource group still gets 403', values: { role: 'contributor' }, node: 'rbac',
      symptom: 'PermissionDenied on project data actions.', cause: 'Contributor is a control-plane role; it does not include data actions.', fix: 'Assign "Azure AI User" to the identity on the project.' },
    { id: 'key', title: 'Key-based client setup fails', values: { credential: 'key', env: GOOD_ENV + '\nAPI_KEY=abc123' }, node: 'credential',
      symptom: 'The project client refuses the key credential.', cause: 'AIProjectClient requires Entra ID tokens; keys are not supported for project operations (and are often disabled).', fix: 'Use DefaultAzureCredential and remove the key from configuration.' },
    { id: 'tenant', title: 'Works for a colleague, 401 for you', values: { tenant: 'other' }, node: 'credential',
      symptom: 'InvalidAuthenticationTokenTenant.', cause: 'az login is signed in to a different tenant.', fix: 'az login --tenant <resource tenant> (set tenant to the resource tenant).' },
    { id: 'uami', title: 'Deployed app cannot get a token', values: { runtime: 'aca', identity: 'user' }, node: 'credential',
      symptom: 'DefaultAzureCredential fails in Container Apps only.', cause: 'User-assigned identity without AZURE_CLIENT_ID.', fix: 'Add AZURE_CLIENT_ID=<client id> to the app settings.' },
    { id: 'private', title: 'Laptop can no longer reach the project', values: { network: 'private' }, node: 'network',
      symptom: '403 "Public access is disabled".', cause: 'Public network access was disabled; the laptop is outside the VNet.', fix: 'Test from the deployed app with VNet integration + private DNS (runtime Azure, VNet on), or via VPN.' },
    { id: 'deploy', title: 'Connected, but the smoke test fails', values: { env: 'PROJECT_ENDPOINT=https://contoso-ai.services.ai.azure.com/api/projects/support\nMODEL_DEPLOYMENT_NAME=gpt-4o-prod' }, node: 'test',
      symptom: 'DeploymentNotFound for gpt-4o-prod.', cause: 'Deployment name from another environment.', fix: 'MODEL_DEPLOYMENT_NAME=gpt-4o.' },
  ],

  challenge: {
    task: 'Production setup: run in Container Apps with a user-assigned managed identity against a project with public network access disabled, passing all 6 checks with no secrets in config.',
    condition: 'Runtime = Container Apps, identity = user-assigned, network = private, 6/6 checks passed, no secrets in config.',
    hint: 'A user-assigned identity must be named in configuration, and a private-only resource needs a network path.',
    check: (p, res) => p.runtime === 'aca' && p.identity === 'user' && p.network === 'private' && res.metrics[0].value === '6/6' && res.metrics[1].value === 'none',
    solution: ['Runtime: Azure Container Apps; identity: user-assigned.', 'Add AZURE_CLIENT_ID=<identity client id> to the environment variables.', 'Network: private endpoint only; turn on VNet integration + private DNS.', 'Role: Azure AI User; credential: DefaultAzureCredential. Run.'],
    solutionValues: { runtime: 'aca', identity: 'user', network: 'private', vnet: true, role: 'aiuser', credential: 'default', tenant: 'same', env: GOOD_ENV + '\nAZURE_CLIENT_ID=11111111-2222-3333-4444-555555555555' },
  },

  quiz: [
    { q: 'Which value should you pass as the endpoint to AIProjectClient?', options: ['https://contoso-ai.openai.azure.com/', 'https://contoso-ai.services.ai.azure.com/api/projects/support', 'eastus.api.azureml.ms;<sub>;<rg>;support', 'https://contoso-ai.services.ai.azure.com'], answer: 1, why: 'Current Foundry projects use the /api/projects/<project> endpoint on the .services.ai.azure.com host.' },
    { q: 'An app in Container Apps uses DefaultAzureCredential and a user-assigned managed identity, but token acquisition fails. What is the most likely missing setting?', options: ['AZURE_OPENAI_API_KEY', 'AZURE_CLIENT_ID', 'PROJECT_NAME', 'AZURE_SUBSCRIPTION_ID'], answer: 1, why: 'DefaultAzureCredential needs AZURE_CLIENT_ID to pick a user-assigned identity.' },
    { q: 'The app\'s identity has Contributor on the resource group and gets 403 when calling an agent. What should you assign?', options: ['Owner', 'Azure AI User on the project', 'Reader', 'Storage Blob Data Reader'], answer: 1, why: 'Data-plane operations need a data role such as Azure AI User; Contributor is control plane.' },
    { q: 'After the security team disables public network access on the Foundry resource, developers get 403 from their laptops while the deployed app works. Why?', options: ['Their tokens expired', 'Only callers coming through the private endpoint (VNet) are allowed', 'The deployment was deleted', 'Laptops need an API key'], answer: 1, why: 'With public access disabled, traffic must arrive via the private endpoint.' },
  ],

  recap: 'Connecting = endpoint + identity + permission + network. Use the project endpoint (https://<resource>.services.ai.azure.com/api/projects/<project>), DefaultAzureCredential (with AZURE_CLIENT_ID for user-assigned identities), a data-plane role such as Azure AI User, and a private network path when public access is off. Keep values in configuration, never keys in code, and smoke-test with a real deployment name.',
};
