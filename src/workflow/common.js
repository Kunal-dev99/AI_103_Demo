// Shared steps for the guided Azure workflows. DOM-free: also run by tools/validate.mjs.
//
// A step: { id, title, why, fields: [...], action, run(state, values) => outcome, hint, docs }
// An outcome: { ok, logs: [{ kind: 'cmd'|'out'|'err'|'info', text }], resources?: [...], set?: {...}, error?: { title, fix } }
// Commands, IDs and API shapes are illustrative: they show the shape of the real workflow,
// not a byte-exact copy. Every workflow page links to Microsoft Learn for the real steps.

export const DOCS = {
  cuQuickstart: { name: 'Content Understanding: quickstarts', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
  foundryResource: { name: 'Create a Microsoft Foundry resource', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/' },
  rbac: { name: 'Role-based access for Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/authentication' },
  serviceBus: { name: 'Service Bus dead-letter queues', url: 'https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues' },
  blobAuth: { name: 'Authorize access to blob data', url: 'https://learn.microsoft.com/en-us/azure/storage/blobs/authorize-data-operations-portal' },
};

export const REGIONS = [
  ['westus', 'West US', true],
  ['swedencentral', 'Sweden Central', true],
  ['australiaeast', 'Australia East', true],
  ['brazilsouth', 'Brazil South', false],
];
const regionOk = r => (REGIONS.find(x => x[0] === r) || [])[2];
const TAKEN_NAMES = ['contoso-ai', 'docai', 'foundry'];

export const ok = (logs, extra = {}) => ({ ok: true, logs, ...extra });
export const fail = (logs, title, fix) => ({ ok: false, logs, error: { title, fix } });
export const cmd = text => ({ kind: 'cmd', text });
export const out = text => ({ kind: 'out', text });
export const err = text => ({ kind: 'err', text });
export const info = text => ({ kind: 'info', text });

export function stepCreateResource() {
  return {
    id: 'resource',
    title: 'Create a Microsoft Foundry resource',
    why: 'Content Understanding runs inside a Microsoft Foundry resource (Foundry Tools). Everything else — model deployments, analyzers, access — hangs off this resource, so pick its region with care.',
    fields: [
      { id: 'rg', label: 'Resource group', type: 'text', default: 'rg-docai-lab', help: 'A container for everything you create in this lab.' },
      { id: 'name', label: 'Resource name', type: 'text', default: 'docai-lab-01', help: 'Becomes part of your endpoint, so it must be globally unique: letters, numbers and hyphens.' },
      { id: 'region', label: 'Region', type: 'select', options: REGIONS.map(([v, l, s]) => [v, `${l}${s ? '' : ' (Content Understanding not available in this lab)'}`]), default: 'swedencentral',
        help: 'Content Understanding is only offered in some regions. The list here is illustrative; check the current region list in the docs.' },
    ],
    action: 'Create resource',
    run(state, v) {
      const logs = [cmd(`az group create --name ${v.rg} --location ${v.region}`), out(`{ "name": "${v.rg}", "properties": { "provisioningState": "Succeeded" } }`)];
      if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(v.name)) {
        logs.push(cmd(`az cognitiveservices account create --name ${v.name} --kind AIServices ...`), err('(InvalidResourceName) The name can contain only letters, numbers and hyphens, 3–64 characters, and cannot start or end with a hyphen.'));
        return fail(logs, 'Invalid resource name', 'Use 3–64 letters, numbers or hyphens, e.g. docai-lab-01.');
      }
      if (TAKEN_NAMES.includes(v.name.toLowerCase())) {
        logs.push(cmd(`az cognitiveservices account create --name ${v.name} --kind AIServices ...`), err(`(CustomDomainInUse) The subdomain name '${v.name}' is not available as it's already used by another resource.`));
        return fail(logs, 'Name already taken', 'The name becomes a public subdomain, so it must be unique across Azure. Add a suffix, e.g. docai-lab-01.');
      }
      logs.push(
        cmd(`az cognitiveservices account create --name ${v.name} --resource-group ${v.rg} --kind AIServices --sku S0 --location ${v.region} --custom-domain ${v.name}`),
        out(`{ "name": "${v.name}", "kind": "AIServices", "location": "${v.region}",\n  "properties": { "endpoint": "https://${v.name}.services.ai.azure.com/", "provisioningState": "Succeeded" } }`));
      if (!regionOk(v.region)) logs.push(info(`Created, but Content Understanding is not available in ${v.region} in this lab: analyze calls will fail later.`));
      return ok(logs, {
        set: { rg: v.rg, name: v.name, region: v.region, regionOk: regionOk(v.region), endpoint: `https://${v.name}.services.ai.azure.com/` },
        resources: [{ id: 'rg', type: 'Resource group', name: v.rg }, { id: 'res', type: 'Foundry resource', name: v.name, meta: v.region, parent: 'rg' }],
      });
    },
    docs: [DOCS.foundryResource],
  };
}

export function stepAccess() {
  return {
    id: 'access',
    title: 'Grant access (keyless, with Microsoft Entra ID)',
    why: 'Production apps should not use API keys. Give the identity that will call the service a data-plane role on the resource, then authenticate with DefaultAzureCredential.',
    fields: [
      { id: 'who', label: 'Who calls the service?', type: 'select', options: [['user', 'You (signed in with az login) — for testing'], ['mi', "The app's managed identity — for production"]], default: 'user' },
      { id: 'role', label: 'Role to assign on the Foundry resource', type: 'select', options: [['', 'Choose a role…'], ['cog-user', 'Cognitive Services User'], ['reader', 'Reader'], ['contributor', 'Contributor'], ['none', 'No role (use an API key instead)']], default: '', required: true,
        help: 'Management roles (Reader, Contributor) let you see or change the resource. Calling the analyzer needs a data-plane role.' },
    ],
    action: 'Assign role',
    run(state, v) {
      const assignee = v.who === 'mi' ? `<principal-id of app identity>` : '<your user object id>';
      const roleName = { 'cog-user': 'Cognitive Services User', reader: 'Reader', contributor: 'Contributor' }[v.role];
      const logs = [];
      if (v.role === 'none') {
        logs.push(info('No role assigned. The app would read an API key from configuration instead.'), info('Works, but keys can leak and must be rotated; many organisations disable key auth (disableLocalAuth = true).'));
        return ok(logs, { set: { role: 'none', who: v.who } });
      }
      logs.push(cmd(`az role assignment create --role "${roleName}" --assignee ${assignee} --scope /subscriptions/<sub>/resourceGroups/${state.rg}/providers/Microsoft.CognitiveServices/accounts/${state.name}`),
        out(`{ "roleDefinitionName": "${roleName}", "principalType": "${v.who === 'mi' ? 'ServicePrincipal' : 'User'}" }`));
      if (v.role !== 'cog-user') logs.push(info(`Assigned — but ${roleName} is a management-plane role. It will not authorize analyze calls.`));
      return ok(logs, { set: { role: v.role, who: v.who }, resources: [{ id: 'role', type: 'Role assignment', name: roleName, meta: v.who === 'mi' ? 'managed identity' : 'you', parent: 'res' }] });
    },
    hint: 'Calling an analyzer is a data-plane operation.',
    docs: [DOCS.rbac],
  };
}

export function stepModels() {
  return {
    id: 'models',
    title: 'Connect model deployments',
    why: 'Content Understanding uses generative and embedding models for field extraction, classification and descriptions. You deploy them in the same Foundry resource and tell Content Understanding which deployments to use by default.',
    fields: [
      { id: 'chat', label: 'Chat model deployment', type: 'select', options: [['', 'Choose…'], ['gpt-4.1', 'gpt-4.1'], ['gpt-4.1-mini', 'gpt-4.1-mini'], ['none', 'Skip — do not deploy a model']], default: '', required: true },
      { id: 'embed', label: 'Embedding model deployment', type: 'select', options: [['text-embedding-3-large', 'text-embedding-3-large'], ['none', 'Skip']], default: 'text-embedding-3-large' },
      { id: 'defaults', label: 'Set these as Content Understanding defaults', type: 'toggle', default: true },
    ],
    action: 'Deploy and connect',
    run(state, v) {
      const logs = [];
      const resources = [];
      for (const [kind, model] of [['chat', v.chat], ['embedding', v.embed]]) {
        if (model === 'none') { logs.push(info(`No ${kind} model deployed.`)); continue; }
        logs.push(cmd(`az cognitiveservices account deployment create --name ${state.name} --deployment-name ${model} --model-name ${model} --sku-name GlobalStandard --sku-capacity 10`),
          out(`{ "name": "${model}", "properties": { "provisioningState": "Succeeded" } }`));
        resources.push({ id: `dep-${kind}`, type: 'Model deployment', name: model, parent: 'res' });
      }
      if (v.defaults && (v.chat !== 'none' || v.embed !== 'none')) {
        logs.push(cmd(`PATCH ${state.endpoint}contentunderstanding/defaults?api-version=<version>`), out(`{ "modelDeployments": { ${v.chat !== 'none' ? `"${v.chat}": "${v.chat}"` : ''}${v.chat !== 'none' && v.embed !== 'none' ? ', ' : ''}${v.embed !== 'none' ? `"${v.embed}": "${v.embed}"` : ''} } }`));
      }
      return ok(logs, { set: { chat: v.chat, embed: v.embed, defaults: !!v.defaults }, resources });
    },
    hint: 'Analyzers that extract or generate fields need a chat model.',
    docs: [DOCS.cuQuickstart],
  };
}

// Common pre-flight checks before any analyze call. Returns a failure outcome or null.
export function preflight(state, logs, { needsModel = true } = {}) {
  if (!state.regionOk) {
    logs.push(err(`(UnsupportedRegion) Content Understanding is not available in region '${state.region}'.`));
    return fail(logs, 'Region not supported', 'Go back to step 1 and create the resource in a supported region.');
  }
  if (state.role === 'reader' || state.role === 'contributor') {
    logs.push(err('(PermissionDenied) The principal does not have permission to perform action Microsoft.CognitiveServices/accounts/ContentUnderstanding/analyzers/analyze/action. HTTP 403'));
    return fail(logs, '403 — wrong role', 'Reader and Contributor are management roles. Go back to the access step and assign Cognitive Services User (a data-plane role).');
  }
  if (needsModel && (state.chat === 'none' || !state.defaults)) {
    logs.push(err('(ModelDeploymentNotFound) No default chat model deployment is configured for Content Understanding.'));
    return fail(logs, 'No model connected', 'Go back to "Connect model deployments", deploy a chat model and set it as the default.');
  }
  return null;
}

export const authLine = state => (state.role === 'none' ? 'Ocp-Apim-Subscription-Key: <key from Key Vault>' : 'Authorization: Bearer <token from DefaultAzureCredential>');
