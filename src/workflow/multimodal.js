// Guided Azure workflow: analyze a customer call recording with Content Understanding.
import { stepCreateResource, stepAccess, stepModels, preflight, authLine, ok, fail, cmd, out, err, info, DOCS } from './common.js';

export default {
  title: 'Analyze a call recording in Azure',
  intro: 'Upload a customer call to Blob Storage, let the Foundry resource read it with its managed identity, and extract who promised what, grounded to the moment it was said.',
  goal: 'A refund amount and the speaker who promised it, each with the time range in the recording where it was said.',
  steps: [
    stepCreateResource(),
    stepAccess(),
    stepModels(),
    {
      id: 'storage',
      title: 'Store the recording and let the service read it',
      why: 'Media files are usually large, so the service reads them from Blob Storage. Instead of SAS tokens you can let the Foundry resource\'s managed identity read the container — that identity needs the Storage Blob Data Reader role on the storage account.',
      fields: [
        { id: 'identity', label: 'Enable a system-assigned managed identity on the Foundry resource', type: 'toggle', default: false },
        { id: 'storageRole', label: 'Role for that identity on the storage account', type: 'select', options: [['', 'Choose…'], ['blob-reader', 'Storage Blob Data Reader'], ['reader', 'Reader'], ['none', 'None']], default: '', required: true },
      ],
      action: 'Upload and grant',
      run(state, v) {
        const logs = [cmd(`az storage account create --name stdocailab --resource-group ${state.rg} --location ${state.region} --sku Standard_LRS`),
          cmd('az storage blob upload --account-name stdocailab --container-name calls --name call-0193.wav --file ./call-0193.wav --auth-mode login'), out('{ "etag": "…", "lastModified": "…" }')];
        const resources = [{ id: 'st', type: 'Storage account', name: 'stdocailab', parent: 'rg' }, { id: 'wav', type: 'Blob', name: 'calls/call-0193.wav', meta: '92 s, 2 speakers', parent: 'st' }];
        if (v.identity) {
          logs.push(cmd(`az cognitiveservices account identity assign --name ${state.name} --resource-group ${state.rg}`), out('{ "type": "SystemAssigned", "principalId": "…" }'));
          resources.push({ id: 'mi', type: 'Managed identity', name: `${state.name} (system)`, parent: 'res' });
        }
        if (v.identity && v.storageRole !== 'none') {
          const r = v.storageRole === 'blob-reader' ? 'Storage Blob Data Reader' : 'Reader';
          logs.push(cmd(`az role assignment create --role "${r}" --assignee <foundry-identity-principal-id> --scope <storage-account-id>`), out(`{ "roleDefinitionName": "${r}" }`));
          if (r === 'Reader') logs.push(info('Reader is a management role: it does not let the identity read blob contents.'));
        }
        return ok(logs, { set: { canRead: v.identity && v.storageRole === 'blob-reader' }, resources });
      },
      docs: [DOCS.blobAuth],
    },
    {
      id: 'configure',
      title: 'Configure the audio analyzer',
      why: 'Speech is transcribed in the locale you set, and speaker diarization labels who said what. Fields you define (extract, classify or generate) are filled from the transcript and can be grounded to time ranges.',
      fields: [
        { id: 'locale', label: 'Spoken language (locale)', type: 'select', options: [['', 'Choose…'], ['en-US', 'en-US'], ['es-ES', 'es-ES']], default: '', required: true, help: 'The customer and agent speak English.' },
        { id: 'diarization', label: 'Speaker diarization (who said what)', type: 'toggle', default: false },
        { id: 'grounding', label: 'Return time ranges and confidence for fields', type: 'toggle', default: true },
      ],
      action: 'Create analyzer',
      run(state, v) {
        const logs = [cmd(`PUT ${state.endpoint}contentunderstanding/analyzers/claims-audio?api-version=<version>\n${authLine(state)}\n{ "baseAnalyzerId": "prebuilt-audio", "config": { "locales": ["${v.locale}"], "enableSpeakerDiarization": ${!!v.diarization}, "estimateFieldSourceAndConfidence": ${!!v.grounding} },\n  "fieldSchema": { "fields": { "RefundAmount": { "type": "number", "method": "extract" }, "RefundPromisedBy": { "type": "string", "method": "generate" } } } }`), info('Analyzer ID and property names are illustrative.')];
        const pf = preflight(state, logs);
        if (pf) return pf;
        logs.push(out('HTTP 201 Created'), out('{ "status": "Succeeded" }'));
        return ok(logs, { set: { locale: v.locale, diarization: !!v.diarization, grounding: !!v.grounding }, resources: [{ id: 'analyzer', type: 'Analyzer', name: 'claims-audio', meta: `${v.locale}${v.diarization ? ', diarization' : ''}`, parent: 'res' }] });
      },
    },
    {
      id: 'analyze',
      title: 'Analyze the call and check the answer',
      why: 'The service downloads the recording with its identity, transcribes it, segments it by speaker and fills your fields.',
      fields: [],
      action: 'Analyze call-0193.wav',
      run(state) {
        const logs = [cmd(`POST ${state.endpoint}contentunderstanding/analyzers/claims-audio:analyze?api-version=<version>\n{ "url": "https://stdocailab.blob.core.windows.net/calls/call-0193.wav" }`)];
        if (!state.canRead) {
          logs.push(err('(InvalidContentSourceUrl) Could not download content: 403 AuthorizationPermissionMismatch from storage.'));
          return fail(logs, "Service can't read the recording", 'Go back to the storage step: enable the managed identity and give it Storage Blob Data Reader.');
        }
        logs.push(out('HTTP 202 Accepted'), out('{ "status": "Succeeded" }'));
        if (state.locale !== 'en-US') {
          logs.push(out('{ "transcript": "… que pasa el paquete PX cuatro ocho … reembolso …" , "fields": { "RefundAmount": null, "RefundPromisedBy": null } }'), info('English speech decoded as Spanish: the transcript is garbled and the fields are empty.'));
          return fail(logs, 'Wrong locale', 'Go back to the analyzer step and set the locale to en-US.');
        }
        if (!state.diarization) {
          logs.push(out('{ "fields": { "RefundAmount": { "value": 120, "source": "T(59.2,71.5)" }, "RefundPromisedBy": { "value": "Unattributed" } } }'), info('Without diarization the transcript has no speakers, so nobody can say who made the promise.'));
          return fail(logs, 'Speaker unknown', 'Go back to the analyzer step and turn on speaker diarization.');
        }
        if (!state.grounding) {
          logs.push(out('{ "fields": { "RefundAmount": { "value": 120 }, "RefundPromisedBy": { "value": "Speaker 1 (agent)" } } }'), info('Correct values, but no time ranges: compliance cannot jump to the moment it was said.'));
          return fail(logs, 'No evidence', 'Go back to the analyzer step and turn on time ranges and confidence.');
        }
        logs.push(out('{ "fields": {\n  "RefundAmount": { "value": 120, "confidence": 0.94, "source": "T(59.2,71.5)" },\n  "RefundPromisedBy": { "value": "Speaker 1 (agent)", "confidence": 0.9, "source": "T(59.2,71.5)" } } }'), info('Agent (Speaker 1) promised £120 at 00:59–01:11. Compliance can play exactly that part of the call.'));
        return ok(logs, { resources: [{ id: 'result', type: 'Result', name: 'call-0193.json', meta: 'grounded', parent: 'analyzer' }] });
      },
    },
  ],
  solution: { resource: {}, access: { role: 'cog-user' }, models: { chat: 'gpt-4.1-mini' }, storage: { identity: true, storageRole: 'blob-reader' }, configure: { locale: 'en-US', diarization: true }, analyze: {} },
  docs: [DOCS.cuQuickstart, DOCS.blobAuth],
};
