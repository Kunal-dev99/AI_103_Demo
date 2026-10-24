// 1.2.1 Design Azure infrastructure for AI apps and agent-based solutions
// Lab: Foundry infrastructure designer.
import { step, metric } from '../src/engine/util.js';

// Region availability is ILLUSTRATIVE. Real availability differs per model, deployment type and feature:
// always check the model availability tables and region lists in the docs.
const REGIONS = {
  regionA: { label: 'Region A (model + all features available)', model: true, semantic: true },
  regionB: { label: 'Region B (chosen model/deployment type not offered)', model: false, semantic: true },
  regionC: { label: 'Region C (semantic ranker not offered)', model: true, semantic: false },
};

function design(p) {
  const steps = [];
  const checks = [];
  const add = (area, rule, status, note, node) => { checks.push({ area, rule, status, note }); steps.push(step(node, `${area}: ${rule}`, note, { status }, status === 'pass' ? 'ok' : status === 'fail' ? 'error' : status === 'info' ? 'info' : 'warn')); };
  const reg = REGIONS[p.region];

  // Requirements summary
  steps.push(step('app', 'Requirements', `RAG over documents: ${p.reqRag ? 'yes' : 'no'} · Hosted agent: ${p.reqAgent ? 'yes' : 'no'} · Private networking only: ${p.reqPrivate ? 'yes' : 'no'} · ${reg.label}.`,
    { reqRag: p.reqRag, reqAgent: p.reqAgent, reqPrivate: p.reqPrivate, region: p.region }, 'info'));

  // Foundry
  if (!p.foundry) add('Foundry', 'Foundry resource + project', 'fail', 'No Foundry resource: there is nowhere to deploy models or create agents. Create a Foundry resource (Microsoft.CognitiveServices/accounts, kind AIServices) with at least one project.', 'foundry');
  else add('Foundry', 'Foundry resource + project', 'pass', 'Foundry resource with a project: model deployments, agents, evaluations and connections live here.', 'foundry');
  // Region
  if (!reg.model) add('Region', 'Model available in region', 'fail', 'The model/deployment type you need is not offered here (illustrative). Choose another region, or a deployment type whose availability covers this region, after checking the model availability table.', 'region');
  else add('Region', 'Model available in region', 'pass', 'Model and deployment type available (in this simulation).', 'region');
  // Search
  if (p.reqRag && !p.search) add('Retrieval', 'Azure AI Search for RAG', 'fail', 'RAG is required but there is no search service to index documents.', 'search');
  else if (p.search) {
    if (p.reqRag && !reg.semantic) add('Retrieval', 'Semantic ranker in region', 'warn', 'Hybrid search works, but the semantic ranker is not offered in this region (illustrative): relevance will be lower.', 'search');
    else add('Retrieval', 'Azure AI Search for RAG', p.reqRag || (p.reqAgent && p.agentSetup === 'standard') ? 'pass' : 'info', p.reqRag ? 'Search service with hybrid + semantic ranking.' : 'Search provisioned (used by the standard agent setup or future RAG).', 'search');
  }
  // Storage
  if (p.reqRag && !p.storage) add('Data', 'Storage for source documents', 'warn', 'Where do the source documents live? Indexers usually pull from Blob Storage / ADLS.', 'storage');
  else if (p.storage) add('Data', 'Storage account', 'pass', 'Blob Storage for source documents and agent files.', 'storage');
  // Agent setup
  if (p.reqAgent) {
    if (!p.foundry) { /* already failed */ } else if (p.agentSetup === 'standard') {
      const missing = [!p.storage && 'Storage', !p.cosmos && 'Cosmos DB', !p.search && 'Azure AI Search'].filter(Boolean);
      if (missing.length) add('Agents', 'Standard setup resources', 'fail', `Standard agent setup keeps conversations, files and vector stores in your own resources. Missing: ${missing.join(', ')}.`, 'cosmos');
      else add('Agents', 'Standard setup resources', 'pass', 'Conversations in your Cosmos DB, files in your Storage, vector stores in your Search: your data, your keys, your network.', 'cosmos');
    } else {
      if (p.reqPrivate) add('Agents', 'Agent data in a private network', 'fail', 'Basic setup uses Microsoft-managed storage for agent state. A network-secured agent needs the standard setup with your own resources and network injection (bring-your-own VNet).', 'cosmos');
      else add('Agents', 'Basic setup', 'pass', 'Quickest start: agent state stored in Microsoft-managed resources.', 'cosmos');
    }
  } else if (p.cosmos) add('Agents', 'Cosmos DB without a use', 'warn', 'Cosmos DB is provisioned but nothing in the requirements uses it (it is for standard agent setup).', 'cosmos');
  // Network
  if (p.reqPrivate && p.network === 'public') add('Network', 'Private networking', 'fail', 'Public network access is enabled on Foundry/Search/Storage. Requirement says data-plane traffic must stay on private endpoints.', 'net');
  else if (p.network === 'private') {
    add('Network', 'Private endpoints', 'pass', 'VNet with private endpoints for Foundry, Search, Storage (and Key Vault, Cosmos DB); public network access disabled; private DNS zones linked.', 'net');
    if (p.hosting !== 'none') add('Network', 'App tier reaches private endpoints', 'info', `${p.hosting === 'appService' ? 'App Service' : 'Container Apps'} needs VNet integration (or an internal environment) to resolve and reach the private endpoints.`, 'net');
  } else add('Network', 'Public endpoints', 'info', 'Public endpoints with Entra ID auth. Acceptable when private networking is not required; consider IP rules.', 'net');
  // Identity
  if (p.auth === 'keys') add('Identity', 'Keyless authentication', 'fail', 'API keys pasted into app settings: anyone with config access can call the services, and keys must be rotated by hand. Use managed identity + RBAC (or at minimum Key Vault references).', 'identity');
  else if (p.auth === 'keysKv') {
    if (!p.keyvault) add('Identity', 'Key Vault references', 'fail', 'App settings reference Key Vault secrets, but no Key Vault is provisioned.', 'kv');
    else add('Identity', 'Keyless authentication', 'warn', 'Keys are in Key Vault (better), but keyless managed identity removes secrets altogether.', 'identity');
  } else add('Identity', 'Managed identity + RBAC', 'pass', 'App identity gets data-plane roles: Azure AI User (or Cognitive Services OpenAI User) on Foundry, Search Index Data Reader on Search, Storage Blob Data Reader on Storage. Search and Foundry identities get the roles they need for indexing and agents.', 'identity');
  if (p.keyvault && p.auth === 'mi') add('Identity', 'Key Vault', 'info', 'Still useful for third-party secrets (for example an external API key behind an OpenAPI tool).', 'kv');
  // Monitoring
  if (!p.appInsights) add('Operations', 'Tracing and monitoring', 'warn', 'No Application Insights connected to the Foundry project: no traces of agent runs, tool calls or token usage.', 'monitor');
  else add('Operations', 'Tracing and monitoring', 'pass', 'Application Insights (Log Analytics workspace) connected for traces, metrics and evaluations.', 'monitor');
  // Hosting
  if (p.hosting === 'none') add('App tier', 'Hosting for the user-facing app', 'warn', 'Nothing hosts the web front end / API that calls the agent.', 'app');
  else add('App tier', 'Hosting', 'pass', `${p.hosting === 'appService' ? 'App Service' : 'Azure Container Apps'} with a system-assigned managed identity.`, 'app');

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const bom = [
    p.foundry && ['Foundry resource + project', 'Microsoft.CognitiveServices/accounts (kind AIServices) + /projects'],
    p.search && ['Azure AI Search', 'Microsoft.Search/searchServices'],
    p.storage && ['Storage account', 'Microsoft.Storage/storageAccounts'],
    p.cosmos && ['Cosmos DB (agent threads)', 'Microsoft.DocumentDB/databaseAccounts'],
    p.keyvault && ['Key Vault', 'Microsoft.KeyVault/vaults'],
    p.appInsights && ['Application Insights + Log Analytics', 'Microsoft.Insights/components'],
    p.network === 'private' && ['VNet, subnets, private endpoints, private DNS zones', 'Microsoft.Network/*'],
    p.hosting !== 'none' && [p.hosting === 'appService' ? 'App Service plan + web app' : 'Container Apps environment + app', p.hosting === 'appService' ? 'Microsoft.Web/sites' : 'Microsoft.App/containerApps'],
  ].filter(Boolean);
  const bicep = [
    "// Illustrative Bicep sketch, not a complete template. Check current API versions.",
    "resource foundry 'Microsoft.CognitiveServices/accounts@<api-version>' = {",
    "  name: 'contoso-foundry'",
    "  location: location",
    "  kind: 'AIServices'",
    "  identity: { type: 'SystemAssigned' }",
    "  properties: {",
    "    allowProjectManagement: true",
    `    publicNetworkAccess: '${p.network === 'private' ? 'Disabled' : 'Enabled'}'`,
    `    disableLocalAuth: ${p.auth === 'mi'}`,
    "  }",
    "}",
    "resource project 'Microsoft.CognitiveServices/accounts/projects@<api-version>' = { parent: foundry, name: 'support-agent' /* ... */ }",
    p.search ? "resource search 'Microsoft.Search/searchServices@<api-version>' = { /* sku, publicNetworkAccess, authOptions */ }" : '',
    p.network === 'private' ? "// private endpoints: foundry (account), search (searchService), storage (blob), cosmos (Sql), keyvault (vault)" : '',
  ].filter(Boolean).join('\n');

  return {
    steps,
    output: [
      { type: 'table', title: 'Design review', columns: ['Area', 'Check', 'Result', 'Why'], rows: checks.map(c => [c.area, c.rule, c.status.toUpperCase(), c.note]), tones: checks.map(c => (c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'error' : c.status === 'warn' ? 'warn' : 'info')) },
      { type: 'kv', title: 'Bill of materials', items: bom.length ? bom : [['(nothing)', '—']] },
      { type: 'code', title: 'Infrastructure as code (sketch)', lang: 'bicep', text: bicep },
      { type: 'alert', tone: fails ? 'error' : warns ? 'warn' : 'ok', text: fails ? `${fails} blocking gap(s): this design does not meet the requirements.` : warns ? `Design meets the hard requirements with ${warns} caveat(s).` : 'Design meets every requirement.' },
    ],
    metrics: [
      metric('Checks passed', `${checks.filter(c => c.status === 'pass').length}/${checks.filter(c => c.status !== 'info').length}`, 'computed'),
      metric('Blocking gaps', String(fails), 'computed'),
      metric('Resources', String(bom.length), 'computed'),
    ],
    summary: `${bom.length} resources, ${fails} gap(s), ${warns} caveat(s)${p.reqPrivate ? ', private' : ''}`,
  };
}

const dis = (p, cond) => (p ? !cond : false);

export default {
  id: '1.2.1',
  lab: 'Foundry infrastructure designer',
  services: [
    { name: 'Plan and manage Foundry resources', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/architecture' },
    { name: 'Agent Service environment setup (basic vs standard)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/environment-setup' },
    { name: 'Configure private link for Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/configure-private-link' },
    { name: 'Baseline Foundry chat reference architecture', url: 'https://learn.microsoft.com/en-us/azure/architecture/ai-ml/architecture/baseline-azure-ai-foundry-chat' },
  ],
  prereqs: ['1.1.2'],
  next: ['1.2.2', '1.3.4', '1.2.4'],

  concept: {
    plain: 'Before writing code you decide which Azure resources the solution needs and how they connect: where models and agents live, where documents are stored and searched, how secrets are avoided, how traffic stays private, how you watch what happens, and where the app itself runs. Each requirement (private network, RAG, agents) adds or changes resources, and missing one shows up later as a blocked security review or a broken feature.',
    technical: 'A Microsoft Foundry resource (Microsoft.CognitiveServices/accounts, kind AIServices) hosts projects, model deployments and Agent Service. RAG adds Azure AI Search and a Storage account. Agent Service has a basic setup (Microsoft-managed storage) and a standard setup where conversations, files and vector stores live in your own Cosmos DB, Storage and Azure AI Search; network-secured agents use the standard setup with network injection into your VNet. Private networking means private endpoints and private DNS zones for each service plus VNet-integrated hosting (App Service or Container Apps). Prefer managed identity with RBAC (disableLocalAuth) over keys; connect Application Insights for tracing. Check region availability for models and features.',
    useCase: 'A bank builds an internal policy agent: Foundry resource and project, standard agent setup with its own Cosmos DB, Storage and Azure AI Search, all behind private endpoints in a hub-spoke VNet, Container Apps for the chat API with managed identity, Key Vault only for a third-party API key, and Application Insights for traces, all deployed from Bicep.',
    terms: [
      ['Foundry resource', 'The Azure resource (kind AIServices) that hosts projects, deployments and Foundry Tools.'],
      ['Standard agent setup', 'Agent Service mode using your own Cosmos DB, Storage and Azure AI Search for agent state.'],
      ['Private endpoint', 'A private IP in your VNet for a PaaS service; combined with disabling public network access.'],
      ['Managed identity', 'An Entra ID identity for an Azure resource, used for keyless RBAC-based access.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'app', label: 'Requirements → app tier', col: 0, row: 1.5, kind: 'user', detail: 'RAG? Agents? Private only? Region?' },
          { id: 'foundry', label: 'AI platform', col: 1, row: 0.5, kind: 'ai', detail: 'Models, agents, evaluations.' },
          { id: 'search', label: 'Retrieval', col: 2, row: 0, kind: 'store', disabled: dis(p, p && p.search), detail: 'Indexes for grounding.' },
          { id: 'storage', label: 'Data', col: 2, row: 1, kind: 'store', disabled: dis(p, p && p.storage), detail: 'Source documents and files.' },
          { id: 'cosmos', label: 'Agent state', col: 2, row: 2, kind: 'store', disabled: dis(p, p && p.cosmos), detail: 'Conversations (standard setup).' },
          { id: 'identity', label: 'Identity', col: 1, row: 2.5, kind: 'policy', detail: 'Who can call what: managed identity + RBAC.' },
          { id: 'net', label: 'Network boundary', col: 3, row: 1, kind: 'policy', badge: p ? p.network : undefined, detail: 'Public vs private endpoints.' },
          { id: 'monitor', label: 'Observability', col: 3, row: 2.5, kind: 'app', disabled: dis(p, p && p.appInsights), detail: 'Traces, metrics, evaluations.' },
          { id: 'region', label: 'Region', col: 3, row: 0, kind: 'policy', detail: 'Model and feature availability.' },
          { id: 'kv', label: 'Secrets', col: 0, row: 3, kind: 'policy', disabled: dis(p, p && p.keyvault), detail: 'Only for secrets you cannot remove.' },
        ],
        edges: [['app', 'foundry'], ['foundry', 'search'], ['foundry', 'storage'], ['foundry', 'cosmos'], ['identity', 'foundry'], ['net', 'search'], ['foundry', 'monitor'], ['region', 'foundry'], ['kv', 'app']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'app', label: p ? (p.hosting === 'appService' ? 'App Service (MI)' : p.hosting === 'containerApps' ? 'Container Apps (MI)' : 'No app tier') : 'App hosting', col: 0, row: 1.5, kind: 'compute', disabled: p && p.hosting === 'none', detail: 'Calls the project endpoint with its managed identity.' },
          { id: 'foundry', label: 'Foundry resource / project', col: 1, row: 1.5, kind: 'ai', disabled: dis(p, p && p.foundry), badge: p ? p.agentSetup : undefined, detail: 'Model deployments, Agent Service, connections.' },
          { id: 'search', label: 'Azure AI Search', col: 2, row: 0, kind: 'store', disabled: dis(p, p && p.search), detail: 'Index; vector stores in standard setup.' },
          { id: 'storage', label: 'Storage account', col: 2, row: 1, kind: 'store', disabled: dis(p, p && p.storage), detail: 'Docs and agent files.' },
          { id: 'cosmos', label: 'Cosmos DB', col: 2, row: 2, kind: 'store', disabled: dis(p, p && p.cosmos), detail: 'Agent conversations in standard setup.' },
          { id: 'kv', label: 'Key Vault', col: 2, row: 3, kind: 'policy', disabled: dis(p, p && p.keyvault), detail: 'Third-party secrets.' },
          { id: 'monitor', label: 'App Insights + Log Analytics', col: 1, row: 3, kind: 'app', disabled: dis(p, p && p.appInsights), detail: 'Connected to the project for tracing.' },
          { id: 'net', label: p && p.network === 'private' ? 'VNet + private endpoints + DNS' : 'Public endpoints', col: 3, row: 1, kind: 'policy', detail: 'Private: each PaaS service gets a private endpoint; public access disabled.' },
          { id: 'identity', label: 'Microsoft Entra ID (RBAC)', col: 0, row: 3, kind: 'policy', badge: p ? p.auth : undefined, detail: 'Role assignments for app, project and search identities.' },
          { id: 'region', label: p ? REGIONS[p.region].label : 'Region', col: 1, row: 0, kind: 'policy', detail: 'Illustrative availability.' },
        ],
        edges: [['app', 'foundry', 'agents / inference'], ['foundry', 'search'], ['foundry', 'storage'], ['foundry', 'cosmos'], ['app', 'kv'], ['foundry', 'monitor', 'traces'], ['search', 'net'], ['storage', 'net'], ['cosmos', 'net'], ['identity', 'app'], ['region', 'foundry']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'foundry', label: "az cognitiveservices account create --kind AIServices ... ; project create", col: 0, row: 0, kind: 'code', detail: 'Illustrative CLI; in practice use Bicep/Terraform.' },
          { id: 'region', label: 'az cognitiveservices model list --location <region>', col: 0, row: 1, kind: 'code', detail: 'Illustrative check of model availability for a region.' },
          { id: 'net', label: p && p.network === 'private' ? 'publicNetworkAccess: Disabled + privateEndpoints[...]' : "publicNetworkAccess: 'Enabled'", col: 0, row: 2, kind: 'code', detail: 'Per-resource network setting.' },
          { id: 'identity', label: 'az role assignment create --role "Azure AI User" --assignee <app-mi> --scope <foundry>', col: 0, row: 3, kind: 'code', detail: 'Plus Search Index Data Reader, Storage Blob Data Reader.' },
          { id: 'cosmos', label: p && p.agentSetup === 'standard' ? 'capabilityHost: { threadStorageConnections, storageConnections, vectorStoreConnections }' : '(basic setup: no capability host connections)', col: 0, row: 4, kind: 'code', detail: 'Illustrative: standard setup wires your Cosmos DB, Storage and Search via connections on a capability host.' },
          { id: 'monitor', label: 'project connection → Application Insights', col: 0, row: 5, kind: 'code', detail: 'Enables tracing in the Foundry portal.' },
          { id: 'app', label: 'DefaultAzureCredential() in app code', col: 0, row: 6, kind: 'code', detail: 'Picks up the managed identity at runtime.' },
        ],
        edges: [['foundry', 'region'], ['foundry', 'net'], ['net', 'identity'], ['identity', 'cosmos'], ['cosmos', 'monitor'], ['monitor', 'app']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'reqRag', label: 'Requirement: RAG over company documents', type: 'toggle', default: true },
      { id: 'reqAgent', label: 'Requirement: hosted agents (Agent Service)', type: 'toggle', default: false },
      { id: 'reqPrivate', label: 'Requirement: private networking only', type: 'toggle', default: false },
      { id: 'region', label: 'Region', type: 'select', options: Object.entries(REGIONS).map(([v, r]) => [v, r.label]), default: 'regionA', help: 'Availability here is illustrative. Check the model and feature availability tables for real regions.' },
      { id: 'foundry', label: 'Foundry resource + project', type: 'toggle', default: true },
      { id: 'search', label: 'Azure AI Search', type: 'toggle', default: true },
      { id: 'storage', label: 'Storage account', type: 'toggle', default: true },
      { id: 'cosmos', label: 'Cosmos DB', type: 'toggle', default: false },
      { id: 'keyvault', label: 'Key Vault', type: 'toggle', default: false },
      { id: 'appInsights', label: 'Application Insights', type: 'toggle', default: false },
      { id: 'agentSetup', label: 'Agent setup', type: 'select', options: [['basic', 'Basic (Microsoft-managed storage)'], ['standard', 'Standard (your Cosmos DB, Storage, Search)']], default: 'basic' },
      { id: 'network', label: 'Network', type: 'select', options: [['public', 'Public endpoints'], ['private', 'VNet + private endpoints']], default: 'public' },
      { id: 'auth', label: 'App authentication', type: 'select', options: [['mi', 'Managed identity + RBAC'], ['keysKv', 'API keys via Key Vault references'], ['keys', 'API keys in app settings']], default: 'mi' },
      { id: 'hosting', label: 'App hosting', type: 'select', options: [['appService', 'App Service'], ['containerApps', 'Container Apps'], ['none', 'None']], default: 'appService' },
    ],
    samples: [
      { label: 'Simple public RAG app', values: { appInsights: true } },
      { label: 'Private agent, basic setup', values: { reqAgent: true, reqPrivate: true, network: 'private', agentSetup: 'basic', appInsights: true } },
      { label: 'Enterprise private agent', values: { reqAgent: true, reqPrivate: true, network: 'private', agentSetup: 'standard', cosmos: true, appInsights: true, hosting: 'containerApps' } },
      { label: 'Keys in app settings', values: { auth: 'keys' } },
    ],
    run: design,
  },

  compare: {
    suggestions: [
      'With private networking and agents required, compare basic vs standard agent setup.',
      'Compare auth = keys in app settings vs Key Vault references vs managed identity.',
      'Switch region A → C with RAG on and watch the semantic ranker caveat.',
    ],
  },

  debug: [
    { id: 'public', title: 'Security review rejects the design', values: { reqPrivate: true, network: 'public' }, node: 'net',
      symptom: 'FAIL: public network access enabled.', cause: 'Private networking is required but services keep public endpoints.', fix: 'Network: VNet + private endpoints.' },
    { id: 'basic-private', title: 'Agent cannot be network-secured', values: { reqAgent: true, reqPrivate: true, network: 'private', agentSetup: 'basic' }, node: 'cosmos',
      symptom: 'FAIL: agent data in a private network.', cause: 'Basic setup stores agent state in Microsoft-managed resources.', fix: 'Agent setup: Standard, and add Cosmos DB (Storage and Search too).' },
    { id: 'standard-missing', title: 'Standard agent setup fails to provision', values: { reqAgent: true, agentSetup: 'standard', cosmos: false }, node: 'cosmos',
      symptom: 'FAIL: missing Cosmos DB.', cause: 'Standard setup needs your own Cosmos DB, Storage and Azure AI Search.', fix: 'Turn on Cosmos DB.' },
    { id: 'region', title: 'Model deployment fails in chosen region', values: { region: 'regionB' }, node: 'region',
      symptom: 'FAIL: model not available in region.', cause: 'Model/deployment-type availability varies by region.', fix: 'Pick Region A (in real life: check the availability table).' },
    { id: 'kv-missing', title: 'App cannot resolve its secrets', values: { auth: 'keysKv', keyvault: false }, node: 'kv',
      symptom: 'FAIL: Key Vault references but no Key Vault.', cause: 'Settings point to secrets in a vault that does not exist.', fix: 'Use managed identity (preferred) or add Key Vault.' },
    { id: 'no-search', title: 'RAG has nothing to query', values: { reqRag: true, search: false }, node: 'search',
      symptom: 'FAIL: Azure AI Search for RAG.', cause: 'No search service provisioned.', fix: 'Turn on Azure AI Search.' },
  ],

  challenge: {
    task: 'Design infrastructure for a private, agent-based RAG solution that passes review with zero failures and zero warnings.',
    condition: 'Requirements RAG + agents + private networking all on; no FAIL or WARN in the design review.',
    hint: 'Private agents need the standard setup and its three resources; keyless identity and monitoring avoid the remaining warnings.',
    check: (p, res) => p.reqRag && p.reqAgent && p.reqPrivate && !res.steps.some(s => s.status === 'error' || s.status === 'warn'),
    solution: ['Turn on all three requirements; Region A.', 'Foundry, Search, Storage, Cosmos DB on; agent setup Standard.', 'Network: VNet + private endpoints.', 'Auth: managed identity + RBAC.', 'Application Insights on; hosting Container Apps or App Service.'],
    solutionValues: { reqRag: true, reqAgent: true, reqPrivate: true, region: 'regionA', foundry: true, search: true, storage: true, cosmos: true, keyvault: true, appInsights: true, agentSetup: 'standard', network: 'private', auth: 'mi', hosting: 'containerApps' },
  },

  quiz: [
    { q: 'Compliance requires agent conversation data to stay in resources you own, reachable only over private endpoints. Which setup?', options: ['Basic agent setup with public endpoints', 'Standard agent setup with your own Cosmos DB, Storage and Azure AI Search, network-injected into your VNet', 'Store conversations in browser local storage', 'Key Vault only'], answer: 1, why: 'Standard setup keeps agent state in your resources; with network injection and private endpoints it stays private.' },
    { q: 'Your web app calls Foundry and Azure AI Search. How should it authenticate?', options: ['Admin keys in app settings', 'Managed identity with RBAC roles such as Azure AI User and Search Index Data Reader', 'A shared personal account', 'Anonymous access'], answer: 1, why: 'Managed identity removes secrets; RBAC grants least-privilege data-plane access.' },
    { q: 'After enabling private endpoints, the App Service app cannot reach Foundry. What is most likely missing?', options: ['A larger model', 'VNet integration for the app and private DNS zone links', 'Semantic ranker', 'A second Foundry project'], answer: 1, why: 'The app must be in (or integrated with) the VNet and resolve private DNS names to reach private endpoints.' },
  ],

  recap: 'Start from requirements: a Foundry resource and project always; Azure AI Search and Storage for RAG; standard agent setup (Cosmos DB, Storage, Search) for owned or private agent data; private endpoints plus VNet-integrated hosting for private networking; managed identity and RBAC instead of keys; Application Insights for tracing; and a region where your models and features are offered.',
};
