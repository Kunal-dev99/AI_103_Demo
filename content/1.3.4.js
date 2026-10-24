// 1.3.4 Configure security, including managed identity, private networking, keyless credentials, and role policies
// Lab: Keyless access and network configurator.
import { step, metric } from '../src/engine/util.js';

const FOUNDRY_ROLES = {
  none: { label: 'No role', data: false },
  reader: { label: 'Reader', data: false, note: 'Control plane read only; no data actions.' },
  contributor: { label: 'Cognitive Services Contributor', data: false, note: 'Manages the resource (and can list keys) but has no data action to call models with Entra ID.', excessive: true },
  openaiUser: { label: 'Cognitive Services OpenAI User', data: true, note: 'Data-plane inference on Azure OpenAI deployments. Least privilege for chat/embeddings.' },
  aiUser: { label: 'Azure AI User', data: true, note: 'Data-plane access to Foundry resources and projects (models, agents). Use when the app also uses Foundry Agent Service.' },
};
const SEARCH_ROLES = {
  none: 'No role',
  serviceContributor: 'Search Service Contributor',
  indexDataReader: 'Search Index Data Reader',
};

function callPath(p) {
  const steps = [];
  const hops = [];
  const entra = p.authMode === 'entra';
  const inAzure = p.hostEnv === 'appService';
  const fail = (node, title, detail, data, http) => {
    steps.push(step(node, title, detail, data, 'error'));
    hops.push({ label: title, tone: 'error', note: http });
    return finish(p, steps, hops, false, data);
  };

  // 1. Client + credential
  let principal = 'API key (no identity)';
  if (entra) {
    if (!inAzure) principal = 'Your developer account (AzureCliCredential via az login)';
    else if (p.identity === 'none') {
      return fail('app', 'DefaultAzureCredential failed to retrieve a token', 'Running in App Service with no managed identity: EnvironmentCredential and ManagedIdentityCredential are unavailable and there is no developer login on the server. Every credential in the chain fails.',
        { exception: 'CredentialUnavailableError / ClientAuthenticationError', chainTried: ['EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential', 'AzureCliCredential', '…'] }, 'no token');
    } else if (p.identity === 'user' && !p.clientIdSet) {
      return fail('app', 'Managed identity not found', 'The app has only a user-assigned managed identity, but AZURE_CLIENT_ID is not set (and no client ID is passed to the credential), so the token request does not say which identity to use.',
        { identity: 'user-assigned', AZURE_CLIENT_ID: null, fix: 'set AZURE_CLIENT_ID or ManagedIdentityCredential(client_id=...)' }, 'no token');
    } else principal = p.identity === 'system' ? 'System-assigned managed identity of the web app' : 'User-assigned managed identity (AZURE_CLIENT_ID set)';
    steps.push(step('app', 'Credential resolved', `DefaultAzureCredential picked: ${principal}. No secret is stored in configuration.`, { credential: inAzure ? 'ManagedIdentityCredential' : 'AzureCliCredential', principal }));
  } else {
    steps.push(step('app', 'Client created with API key', 'The key is read from configuration and sent in the api-key header. Anyone with the key can call the resource; rotation is manual.', { header: 'api-key', identity: 'none' }, 'warn'));
  }
  hops.push({ label: entra ? `Token from ${inAzure ? 'managed identity' : 'developer login'}` : 'API key from config', tone: entra ? 'ok' : 'warn' });

  // 2. DNS
  const privateIp = p.network === 'private' && inAzure && p.vnetIntegration && p.privateDns;
  const fqdn = 'contoso-ai.services.ai.azure.com';
  steps.push(step('dns', 'DNS resolution', p.network === 'private'
    ? privateIp ? `${fqdn} → CNAME *.privatelink.* → 10.10.2.5 (private endpoint) via the private DNS zone linked to the VNet.`
      : !inAzure ? `${fqdn} resolves to the public IP: your laptop is not on the VNet and cannot use the private DNS zone.`
        : !p.vnetIntegration ? `${fqdn} resolves to the public IP: the web app has no VNet integration, so it uses public DNS and egress.`
          : `${fqdn} resolves to the public IP: no private DNS zone (privatelink.*) is linked to the VNet, so the private endpoint is never used.`
    : `${fqdn} → public IP.`,
  { fqdn, resolved: privateIp ? '10.10.2.5' : '20.x.x.x (public)', privateDnsZone: p.privateDns ? 'linked' : 'none' },
  p.network === 'private' && !privateIp ? 'warn' : 'ok'));

  // 3. Network rules on the Foundry resource
  if (p.network === 'private' && !privateIp) {
    return fail('net', '403: public access is disabled', 'The resource only accepts traffic through its private endpoint. The request arrived over the public internet and was rejected before authentication.',
      { httpStatus: 403, message: 'Public access is disabled. Please configure private endpoint. (wording may vary)', publicNetworkAccess: 'Disabled' }, '403 network');
  }
  if (p.network === 'selected' && inAzure && !p.vnetIntegration) {
    return fail('net', '403: caller not in allowed networks', 'Selected networks allow the corporate IP range and the app subnet. Without VNet integration the web app calls from a shared outbound IP that is not on the list.',
      { httpStatus: 403, networkAcls: { defaultAction: 'Deny', ipRules: ['corporate range'], virtualNetworkRules: ['app-subnet'] } }, '403 firewall');
  }
  steps.push(step('net', 'Network access allowed', p.network === 'public' ? 'Public network access is enabled for all networks: reachable from anywhere on the internet (authentication still required).' : p.network === 'selected' ? 'Caller is inside the allowed networks.' : 'Traffic arrived through the private endpoint.',
    { publicNetworkAccess: p.network === 'private' ? 'Disabled' : 'Enabled', defaultAction: p.network === 'public' ? 'Allow' : 'Deny' }, p.network === 'public' ? 'warn' : 'ok'));
  hops.push({ label: p.network === 'private' ? 'Private endpoint' : p.network === 'selected' ? 'Firewall: allowed network' : 'Public internet', tone: p.network === 'public' ? 'warn' : 'ok' });

  // 4. Authentication
  if (!entra && p.disableLocalAuth) {
    return fail('token', '401/403: key-based authentication disabled', 'disableLocalAuth = true on the resource, so API keys are rejected. Only Microsoft Entra ID tokens are accepted.',
      { httpStatus: '401/403 (illustrative)', disableLocalAuth: true }, 'key rejected');
  }
  steps.push(step('token', entra ? 'Entra ID token validated' : 'API key accepted', entra ? 'Bearer token for scope https://cognitiveservices.azure.com/.default (Foundry project endpoints use https://ai.azure.com/.default). Issued to the principal above.' : 'Local (key) auth is still enabled on this resource.',
    { scheme: entra ? 'Bearer' : 'api-key', disableLocalAuth: p.disableLocalAuth }, entra ? 'ok' : 'warn'));

  // 5. Authorization (RBAC data plane) only applies to Entra callers
  const fr = FOUNDRY_ROLES[p.foundryRole];
  if (entra) {
    if (!fr.data) {
      return fail('authz', '403: principal lacks data action', `The principal has "${fr.label}" on the resource. ${fr.note || 'It grants no data actions.'} Calling a model requires a data action such as Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action.`,
        { httpStatus: 403, code: 'PermissionDenied', principal, assignedRole: fr.label, requiredRoleExamples: ['Cognitive Services OpenAI User', 'Azure AI User'] }, '403 RBAC');
    }
    steps.push(step('authz', 'RBAC check passed', `"${fr.label}" grants the needed data action. ${fr.note}`, { role: fr.label, scope: 'Foundry resource' }));
    hops.push({ label: `RBAC: ${fr.label}`, tone: 'ok' });
  } else {
    steps.push(step('authz', 'No RBAC check for API keys', 'A key grants full data-plane access to the resource; role assignments are not evaluated.', { rbacEvaluated: false }, 'warn'));
    hops.push({ label: 'Key = full access', tone: 'warn' });
  }

  steps.push(step('model', 'Chat completion returned', 'Model deployment answered 200 OK.', { httpStatus: 200 }));
  hops.push({ label: 'Model 200 OK', tone: 'ok' });

  // 6. Azure AI Search call (RAG)
  if (entra) {
    if (p.searchAuth === 'keysOnly') {
      return fail('search', '403 from Azure AI Search', 'The search service API access control is "API keys" only, so bearer tokens are rejected. Enable role-based access (RBAC only, or both).',
        { httpStatus: '401/403 (illustrative)', authOptions: 'apiKeyOnly' }, 'search 403');
    }
    if (p.searchRole !== 'indexDataReader') {
      return fail('search', '403 from Azure AI Search', `The principal has "${SEARCH_ROLES[p.searchRole]}" on the search service. Querying an index needs Search Index Data Reader (or Contributor). Search Service Contributor manages indexes but cannot query them.`,
        { httpStatus: 403, assignedRole: SEARCH_ROLES[p.searchRole], required: 'Search Index Data Reader' }, 'search 403');
    }
  } else if (p.searchAuth === 'rbacOnly') {
    return fail('search', '403 from Azure AI Search', 'The search service accepts only Entra ID (RBAC only), so the query key is rejected.', { httpStatus: 403, authOptions: 'RBAC only' }, 'search 403');
  }
  steps.push(step('search', 'Search query succeeded', entra ? 'Token accepted; Search Index Data Reader allows queries.' : 'Query key accepted.', { auth: entra ? 'Bearer' : 'api-key' }, entra ? 'ok' : 'warn'));
  hops.push({ label: 'Search 200 OK', tone: 'ok' });
  return finish(p, steps, hops, true, null);
}

function posture(p) {
  const fr = FOUNDRY_ROLES[p.foundryRole];
  return [
    ['Keyless auth (Entra ID)', p.authMode === 'entra'],
    ['Local auth disabled on Foundry resource', p.disableLocalAuth],
    ['Managed identity (no secrets in config)', p.authMode === 'entra' && p.hostEnv === 'appService' && p.identity !== 'none'],
    ['Least-privilege data roles', p.authMode === 'entra' && fr.data && p.searchRole === 'indexDataReader'],
    ['Public network access disabled (private endpoint)', p.network === 'private'],
    ['Search: RBAC only', p.searchAuth === 'rbacOnly'],
  ];
}

function finish(p, steps, hops, success, errData) {
  const checks = posture(p);
  const score = checks.filter(c => c[1]).length;
  steps.push(step('posture', `Security posture ${score}/${checks.length}`, checks.filter(c => !c[1]).map(c => 'Missing: ' + c[0]).join('; ') || 'All hardening controls in place.', Object.fromEntries(checks), score === checks.length ? 'ok' : 'info'));
  const output = [
    { type: 'flow', title: 'Call path: web app → Foundry model → Azure AI Search', items: hops },
    { type: 'kv', title: 'Hardening checklist', items: checks.map(([k, v]) => [k, v ? 'yes' : 'no']) },
  ];
  if (errData) output.push({ type: 'json', title: 'Error seen by the app (simulated)', data: errData });
  output.push({ type: 'code', lang: 'python', title: 'Client code for this configuration (illustrative)', text: p.authMode === 'entra'
    ? `from azure.identity import DefaultAzureCredential, get_bearer_token_provider\nfrom openai import AzureOpenAI\nfrom azure.search.documents import SearchClient\n\ncred = DefaultAzureCredential()  # ${p.identity === 'user' ? 'reads AZURE_CLIENT_ID for the user-assigned identity' : 'managed identity in Azure, az login locally'}\ntp = get_bearer_token_provider(cred, "https://cognitiveservices.azure.com/.default")\nllm = AzureOpenAI(azure_endpoint=ENDPOINT, azure_ad_token_provider=tp, api_version=API_VERSION)\nsearch = SearchClient(SEARCH_ENDPOINT, "hr-policies", cred)`
    : `import os\nfrom openai import AzureOpenAI\nfrom azure.core.credentials import AzureKeyCredential\nfrom azure.search.documents import SearchClient\n\nllm = AzureOpenAI(azure_endpoint=ENDPOINT, api_key=os.environ["AOAI_KEY"], api_version=API_VERSION)  # secret to store and rotate\nsearch = SearchClient(SEARCH_ENDPOINT, "hr-policies", AzureKeyCredential(os.environ["SEARCH_KEY"]))` });
  output.push({ type: 'code', lang: 'bicep', title: 'Resource settings (illustrative Bicep fragment)', text: `properties: {\n  disableLocalAuth: ${p.disableLocalAuth}\n  publicNetworkAccess: '${p.network === 'private' ? 'Disabled' : 'Enabled'}'\n  networkAcls: { defaultAction: '${p.network === 'public' ? 'Allow' : 'Deny'}' }\n}\n// roleAssignment: ${FOUNDRY_ROLES[p.foundryRole].label} → ${p.identity === 'none' ? '(no identity)' : p.identity + '-assigned identity'}\n// search authOptions: ${p.searchAuth}` });
  output.unshift({ type: 'alert', tone: success ? (score === checks.length ? 'ok' : 'warn') : 'error', text: success ? (score === checks.length ? 'Call succeeded with a fully hardened, keyless, private configuration.' : `Call succeeded, but ${checks.length - score} hardening control(s) are missing.`) : 'The call failed. Read the failing hop, then change the matching control.' });
  return {
    steps, output,
    metrics: [
      metric('End-to-end call', success ? 'success' : 'failed', 'computed'),
      metric('Posture score', `${score}/${checks.length}`, 'computed', 'Count of hardening controls in place in this lab\'s checklist.'),
      metric('Secrets to manage', p.authMode === 'entra' ? (p.hostEnv === 'appService' ? '0' : '0 (developer login)') : '2 keys', 'computed'),
    ],
    summary: `${p.authMode === 'entra' ? 'Entra' : 'API key'} · ${p.network} · ${FOUNDRY_ROLES[p.foundryRole].label}: ${success ? 'OK' : 'FAILED'} · posture ${score}/${checks.length}`,
  };
}

export default {
  id: '1.3.4',
  lab: 'Keyless access and network configurator',
  services: [
    { name: 'Role-based access control for Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/rbac-azure-ai-foundry' },
    { name: 'Configure Azure OpenAI with managed identities', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/managed-identity' },
    { name: 'Disable local authentication for Azure AI services', url: 'https://learn.microsoft.com/en-us/azure/ai-services/disable-local-auth' },
    { name: 'Configure private link for Microsoft Foundry', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/configure-private-link' },
    { name: 'Azure AI Search: connect using roles', url: 'https://learn.microsoft.com/en-us/azure/search/search-security-rbac' },
  ],
  prereqs: ['1.2.1'],
  next: ['1.3.3', '2.1.6'],

  concept: {
    plain: 'Two questions protect an AI service: who is calling, and from where. Instead of sharing a password-like API key, the app proves its identity with a managed identity that Azure creates and rotates for it, and gets only the permissions it needs. Instead of exposing the service to the whole internet, you give it a private address inside your network. Each layer fails in a recognisable way: no identity means no token, the wrong role means 403, missing private DNS means the request goes to the public address and is refused.',
    technical: 'Microsoft Foundry resources (and Azure AI Search, Storage) support Microsoft Entra ID auth. Apps use DefaultAzureCredential, which resolves to ManagedIdentityCredential in Azure (system-assigned, or user-assigned selected via AZURE_CLIENT_ID) and to developer credentials locally. Tokens are requested for https://cognitiveservices.azure.com/.default (or https://ai.azure.com/.default for Foundry project endpoints). Data-plane access needs data-action roles: Cognitive Services OpenAI User for inference, Azure AI User for Foundry project/agent operations, Search Index Data Reader for queries, Storage Blob Data Reader for blobs; control-plane roles such as Contributor do not grant them. Setting disableLocalAuth rejects API keys. Private endpoints plus publicNetworkAccess: Disabled restrict traffic to the VNet; callers need VNet integration and a linked private DNS zone (privatelink.*) to resolve the private IP.',
    useCase: 'A bank deploys an HR assistant on App Service. It enables a system-assigned managed identity, assigns Cognitive Services OpenAI User on the Foundry resource and Search Index Data Reader on the search service, sets disableLocalAuth, creates private endpoints with private DNS zones, integrates the web app with the VNet and disables public network access. No keys exist in configuration, and the services are not reachable from the internet.',
    terms: [
      ['Managed identity', 'An Entra ID identity Azure manages for a resource. System-assigned lives and dies with the resource; user-assigned is standalone and can be shared.'],
      ['DefaultAzureCredential', 'Credential chain that tries environment, workload identity, managed identity, then developer tools, so the same code works locally and in Azure.'],
      ['Data action', 'Permission to use a resource\'s data (call a model, query an index), distinct from managing the resource.'],
      ['disableLocalAuth', 'Resource property that turns off key-based authentication.'],
      ['Private endpoint + private DNS zone', 'A private IP for the service in your VNet, plus DNS records so its hostname resolves to that IP.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'app', label: p ? (p.authMode === 'entra' ? 'App with identity' : 'App with API key') : 'App', col: 0, row: 1, kind: 'app', detail: 'Who is calling?' },
          { id: 'dns', label: 'Name resolution', col: 1, row: 0, kind: 'compute', detail: 'Which IP does the hostname resolve to: public or private endpoint?' },
          { id: 'net', label: 'Network rules', col: 1, row: 1, kind: 'policy', detail: 'Is this network allowed to reach the resource?' },
          { id: 'token', label: 'Authentication', col: 2, row: 1, kind: 'policy', detail: 'Valid token (or key, if allowed)?' },
          { id: 'authz', label: 'Authorization (RBAC)', col: 3, row: 1, kind: 'policy', disabled: p && p.authMode !== 'entra', detail: 'Does the principal have the needed data action?' },
          { id: 'model', label: 'Model', col: 4, row: 0.5, kind: 'ai', detail: 'Inference happens only after all checks pass.' },
          { id: 'search', label: 'Search index', col: 4, row: 1.5, kind: 'store', detail: 'Same checks repeat for every downstream service.' },
          { id: 'posture', label: 'Posture checklist', col: 2, row: 2.5, kind: 'data', detail: 'Hardening controls in place.' },
        ],
        edges: [['app', 'dns'], ['dns', 'net'], ['app', 'net'], ['net', 'token'], ['token', 'authz'], ['authz', 'model'], ['authz', 'search']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'app', label: p ? (p.hostEnv === 'local' ? 'Developer laptop (az login)' : `App Service (${p.identity === 'none' ? 'no identity' : p.identity + '-assigned MI'})`) : 'App Service', col: 0, row: 1, kind: 'app', detail: 'Hosts the RAG web app.' },
          { id: 'dns', label: p && p.privateDns ? 'Private DNS zones (privatelink.*) linked' : 'Public DNS only', col: 1, row: 0, kind: 'compute', detail: 'privatelink.cognitiveservices.azure.com / privatelink.openai.azure.com / privatelink.services.ai.azure.com, privatelink.search.windows.net.' },
          { id: 'net', label: p ? `VNet: integration ${p.vnetIntegration ? 'on' : 'off'}, network ${p.network}` : 'VNet + private endpoints', col: 1, row: 1, kind: 'policy', detail: 'Web app VNet integration subnet and private endpoint subnet.' },
          { id: 'token', label: 'Microsoft Entra ID', col: 2, row: 0, kind: 'external', detail: 'Issues tokens to the managed identity.' },
          { id: 'authz', label: p ? `Role: ${FOUNDRY_ROLES[p.foundryRole].label}` : 'Role assignments', col: 2, row: 1, kind: 'policy', detail: 'Azure RBAC on the Foundry resource and search service.' },
          { id: 'model', label: p ? `Foundry resource (local auth ${p.disableLocalAuth ? 'off' : 'on'})` : 'Foundry resource', col: 3, row: 0.5, kind: 'ai', detail: 'Model deployments and projects.' },
          { id: 'search', label: p ? `Azure AI Search (${p.searchAuth})` : 'Azure AI Search', col: 3, row: 1.5, kind: 'store', detail: 'Index queried by the app.' },
          { id: 'posture', label: 'Azure Policy / Defender for Cloud', col: 4, row: 1, kind: 'data', detail: 'Policies can enforce disableLocalAuth and private access across subscriptions.' },
        ],
        edges: [['app', 'dns'], ['app', 'net'], ['app', 'token', 'token'], ['net', 'model'], ['net', 'search'], ['authz', 'model'], ['authz', 'search'], ['posture', 'model', 'audit']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'app', label: p && p.authMode === 'apiKey' ? 'AzureOpenAI(api_key=os.environ["AOAI_KEY"])' : 'cred = DefaultAzureCredential()', col: 0, row: 0, kind: 'code', detail: 'azure-identity.' },
          { id: 'token', label: 'get_bearer_token_provider(cred, "https://cognitiveservices.azure.com/.default")', col: 0, row: 1, kind: 'code', detail: 'Token provider for the OpenAI client.' },
          { id: 'authz', label: 'az role assignment create --role "Cognitive Services OpenAI User" --assignee <principalId> --scope <resourceId>', col: 0, row: 2, kind: 'code', detail: 'Role propagation can take a few minutes.' },
          { id: 'model', label: 'az resource update ... --set properties.disableLocalAuth=true', col: 0, row: 3, kind: 'code', detail: 'Illustrative; usually set in Bicep/Terraform.' },
          { id: 'net', label: 'az network private-endpoint create ... --group-id account', col: 0, row: 4, kind: 'code', detail: 'Plus publicNetworkAccess Disabled.' },
          { id: 'dns', label: 'az network private-dns zone create -n privatelink.cognitiveservices.azure.com + vnet link', col: 0, row: 5, kind: 'code', detail: 'Zone names depend on endpoint type; check the private link docs.' },
          { id: 'search', label: 'az search service update --auth-options aadOrApiKey | --disable-local-auth', col: 0, row: 6, kind: 'code', detail: 'Enable RBAC on the search service (illustrative flags).' },
          { id: 'posture', label: 'Azure Policy: "Azure AI Services resources should have key access disabled"', col: 0, row: 7, kind: 'code', detail: 'Built-in policy names may change.' },
        ],
        edges: [['app', 'token'], ['token', 'authz'], ['authz', 'model'], ['model', 'net'], ['net', 'dns'], ['dns', 'search'], ['search', 'posture']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'hostEnv', label: 'Where the code runs', type: 'select', options: [['appService', 'Azure App Service'], ['local', 'Developer laptop (az login)']], default: 'appService' },
      { id: 'authMode', label: 'Authentication', type: 'select', options: [['apiKey', 'API keys'], ['entra', 'Microsoft Entra ID (DefaultAzureCredential)']], default: 'apiKey' },
      { id: 'identity', label: 'Managed identity on the web app', type: 'select', options: [['none', 'None'], ['system', 'System-assigned'], ['user', 'User-assigned']], default: 'none' },
      { id: 'clientIdSet', label: 'AZURE_CLIENT_ID app setting set', type: 'toggle', default: false, help: 'Needed when only a user-assigned identity is attached.' },
      { id: 'foundryRole', label: 'Role on Foundry resource', type: 'select', options: Object.entries(FOUNDRY_ROLES).map(([v, r]) => [v, r.label]), default: 'none' },
      { id: 'searchRole', label: 'Role on Azure AI Search', type: 'select', options: Object.entries(SEARCH_ROLES), default: 'none' },
      { id: 'searchAuth', label: 'Search API access control', type: 'select', options: [['keysOnly', 'API keys only'], ['both', 'Both (RBAC and keys)'], ['rbacOnly', 'RBAC only']], default: 'both' },
      { id: 'disableLocalAuth', label: 'disableLocalAuth on Foundry resource', type: 'toggle', default: false },
      { id: 'network', label: 'Foundry & Search network access', type: 'select', options: [['public', 'All networks (public)'], ['selected', 'Selected networks (firewall)'], ['private', 'Private endpoint only (public disabled)']], default: 'public' },
      { id: 'vnetIntegration', label: 'Web app VNet integration', type: 'toggle', default: false },
      { id: 'privateDns', label: 'Private DNS zones linked to VNet', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'Quick start: API keys, public', values: {} },
      { label: 'Keyless with system-assigned identity', values: { authMode: 'entra', identity: 'system', foundryRole: 'openaiUser', searchRole: 'indexDataReader' } },
      { label: 'Fully private + keyless', values: { authMode: 'entra', identity: 'system', foundryRole: 'openaiUser', searchRole: 'indexDataReader', searchAuth: 'rbacOnly', disableLocalAuth: true, network: 'private', vnetIntegration: true, privateDns: true } },
      { label: 'Developer laptop against private resource', values: { hostEnv: 'local', authMode: 'entra', foundryRole: 'openaiUser', searchRole: 'indexDataReader', network: 'private' } },
    ],
    run: callPath,
  },

  compare: {
    suggestions: [
      'Compare API key vs Entra ID with disableLocalAuth on: where does each request stop?',
      'Run the fully private sample, then turn off Private DNS zones only: what changes in the DNS hop?',
      'Compare Cognitive Services Contributor vs Cognitive Services OpenAI User on the same identity.',
    ],
  },

  debug: [
    { id: 'keyoff', title: 'App breaks after a security baseline is applied', values: { authMode: 'apiKey', disableLocalAuth: true }, node: 'token',
      symptom: '401/403 on every model call, nothing changed in the code.', cause: 'A policy set disableLocalAuth = true; API keys are no longer accepted.', fix: 'Move the app to Entra ID: enable a managed identity, assign Cognitive Services OpenAI User, use DefaultAzureCredential.' },
    { id: 'nomi', title: 'DefaultAzureCredential fails in App Service', values: { authMode: 'entra', identity: 'none', foundryRole: 'openaiUser' }, node: 'app',
      symptom: 'ClientAuthenticationError: DefaultAzureCredential failed to retrieve a token. Works on the developer laptop.', cause: 'Locally it uses az login; in App Service there is no managed identity to fall back on.', fix: 'Enable a system-assigned managed identity on the web app (and give it the data role).' },
    { id: 'uami', title: 'User-assigned identity not picked up', values: { authMode: 'entra', identity: 'user', clientIdSet: false, foundryRole: 'openaiUser', searchRole: 'indexDataReader' }, node: 'app',
      symptom: 'Token acquisition fails although an identity is attached.', cause: 'With only a user-assigned identity, the credential must be told which client ID to use.', fix: 'Set the AZURE_CLIENT_ID app setting (or pass the client ID to the credential).' },
    { id: 'role', title: '403 PermissionDenied with an Owner-like role', values: { authMode: 'entra', identity: 'system', foundryRole: 'contributor' }, node: 'authz',
      symptom: '403: principal does not have access to the chat/completions data action.', cause: 'Cognitive Services Contributor is a control-plane role; it has no data actions for inference.', fix: 'Assign Cognitive Services OpenAI User (or Azure AI User) to the identity.' },
    { id: 'dns', title: 'Private endpoint created but calls still fail', values: { authMode: 'entra', identity: 'system', foundryRole: 'openaiUser', searchRole: 'indexDataReader', network: 'private', vnetIntegration: true, privateDns: false }, node: 'dns',
      symptom: '403 "Public access is disabled" from inside the VNet.', cause: 'No private DNS zone is linked, so the hostname resolves to the public IP and traffic never uses the private endpoint.', fix: 'Create the privatelink DNS zone(s) and link them to the VNet.' },
    { id: 'search', title: 'Model works, search fails', values: { authMode: 'entra', identity: 'system', foundryRole: 'openaiUser', searchRole: 'serviceContributor', searchAuth: 'both' }, node: 'search',
      symptom: '403 on search queries while chat completions succeed.', cause: 'Search Service Contributor manages the service but cannot query index data.', fix: 'Assign Search Index Data Reader to the identity on the search service.' },
  ],

  challenge: {
    task: 'Make the App Service call path succeed end to end with every hardening control in place (posture 6/6), using least-privilege roles.',
    condition: 'Host = App Service, call succeeds through model and search, posture score 6/6.',
    hint: 'Work hop by hop: identity → token → network (VNet integration + DNS) → RBAC on both services.',
    check: (p, res) => p.hostEnv === 'appService' && res.steps.some(s => s.node === 'search' && s.status === 'ok') && res.steps.some(s => s.node === 'posture' && s.status === 'ok'),
    solution: ['Authentication: Entra ID; managed identity: system-assigned.', 'Roles: Cognitive Services OpenAI User on Foundry, Search Index Data Reader on Search.', 'Search API access control: RBAC only; disableLocalAuth on.', 'Network: private endpoint only, VNet integration on, private DNS zones linked.'],
    solutionValues: { hostEnv: 'appService', authMode: 'entra', identity: 'system', foundryRole: 'openaiUser', searchRole: 'indexDataReader', searchAuth: 'rbacOnly', disableLocalAuth: true, network: 'private', vnetIntegration: true, privateDns: true },
  },

  quiz: [
    { q: 'Your web app uses DefaultAzureCredential and gets 403 PermissionDenied calling chat completions. Its managed identity has Contributor on the Foundry resource. What do you change?', options: ['Assign Cognitive Services OpenAI User to the identity', 'Switch to API keys', 'Grant Owner on the subscription', 'Disable the private endpoint'], answer: 0, why: 'Contributor is control plane; inference needs a data-action role such as Cognitive Services OpenAI User (or Azure AI User).' },
    { q: 'After you add a private endpoint and disable public access, the VNet-integrated app gets "public access is disabled" errors. What is missing?', options: ['A private DNS zone linked to the VNet so the hostname resolves to the private IP', 'disableLocalAuth', 'A user-assigned identity', 'A higher TPM quota'], answer: 0, why: 'Without the privatelink DNS zone, name resolution returns the public IP and traffic bypasses the private endpoint.' },
    { q: 'You must guarantee that nobody can call the Foundry resource with a shared secret. Which setting enforces this?', options: ['Rotate keys monthly', 'Set disableLocalAuth to true', 'Store keys in Key Vault', 'Use selected networks'], answer: 1, why: 'disableLocalAuth rejects key-based authentication entirely; Key Vault and rotation still leave keys usable.' },
    { q: 'An app runs with only a user-assigned managed identity and token acquisition fails. What is the usual fix?', options: ['Set AZURE_CLIENT_ID to the identity\'s client ID', 'Add a system-assigned identity with no roles', 'Use AzureCliCredential', 'Assign Search Index Data Reader'], answer: 0, why: 'DefaultAzureCredential needs the client ID to select a user-assigned identity.' },
  ],

  recap: 'Prefer keyless: managed identity + DefaultAzureCredential + data-plane roles (Cognitive Services OpenAI User or Azure AI User, Search Index Data Reader, Storage Blob Data Reader), then disableLocalAuth. For network isolation, add private endpoints, link privatelink DNS zones, integrate callers with the VNet and disable public access. Read failures by hop: no token, 403 network, 403 RBAC.',
};
