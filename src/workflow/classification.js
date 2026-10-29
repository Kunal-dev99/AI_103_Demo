// Guided Azure workflow: classify and split a mixed PDF with Content Understanding, then route via Service Bus.
import { stepCreateResource, stepAccess, stepModels, preflight, authLine, ok, fail, cmd, out, err, info, DOCS } from './common.js';

const DEFAULT_CATEGORIES = `invoice: "A supplier bill asking for payment, with an amount due"
credit_note: "A supplier document that reduces an amount owed; often says CREDIT NOTE"
delivery_note: "Lists goods delivered, no prices or totals"`;

function parseCategories(text) {
  const cats = {}, errors = [];
  String(text).split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^([a-z][\w]*)\s*:\s*"([^"]*)"\s*$/i);
    if (!m) { errors.push(`line ${i + 1}: expected  name: "description"`); return; }
    if (m[2].length < 12) errors.push(`${m[1]}: description too vague — say what makes it different`);
    cats[m[1]] = { description: m[2] };
  });
  return { cats, errors };
}

export default {
  title: 'Classify, split and route in Azure',
  intro: 'Set up a classifier for a mixed inbox, split a multi-document scan, and route each part through Service Bus with a dead-letter queue.',
  goal: 'Every document in a combined scan is classified, split out and delivered to the right queue — and nothing is lost when a downstream system is down.',
  steps: [
    stepCreateResource(),
    stepAccess(),
    stepModels(),
    {
      id: 'categories',
      title: 'Define the categories',
      why: 'The classifier picks among the categories you describe. Clear descriptions matter, and an "other" category catches documents that fit none — otherwise they are forced into the closest wrong one.',
      fields: [
        { id: 'cats', label: 'Categories (name: "description")', type: 'textarea', rows: 5, default: DEFAULT_CATEGORIES },
        { id: 'other', label: 'Add an "other" category for anything that fits none', type: 'toggle', default: false },
        { id: 'split', label: 'Split a file into separate documents (segment by category)', type: 'toggle', default: false },
      ],
      action: 'Validate categories',
      run(state, v) {
        const { cats, errors } = parseCategories(v.cats);
        const logs = [info(`${Object.keys(cats).length} categories${v.other ? ' + other' : ''}; splitting ${v.split ? 'on' : 'off'}.`)];
        if (errors.length) { errors.forEach(e => logs.push(err(e))); return fail(logs, 'Category definitions need work', errors[0]); }
        if (v.other) cats.other = { description: 'Anything that is none of the above' };
        logs.push(out(JSON.stringify({ baseAnalyzerId: 'prebuilt-document', config: { enableSegment: !!v.split, contentCategories: cats } }, null, 2)), info('Property names are illustrative; check the classification docs for your API version.'));
        return ok(logs, { set: { cats, split: !!v.split, other: !!v.other } });
      },
    },
    {
      id: 'create',
      title: 'Create the classifier analyzer',
      why: 'Like any analyzer, you create it once by ID and then call it.',
      fields: [{ id: 'analyzerId', label: 'Analyzer ID', type: 'text', default: 'inbox-classifier' }],
      action: 'PUT analyzer',
      run(state, v) {
        const logs = [cmd(`PUT ${state.endpoint}contentunderstanding/analyzers/${v.analyzerId}?api-version=<version>\n${authLine(state)}\n{ "config": { "enableSegment": ${state.split}, "contentCategories": { ${Object.keys(state.cats).join(', ')} } } }`)];
        const pf = preflight(state, logs);
        if (pf) return pf;
        logs.push(out('HTTP 201 Created'), out('{ "status": "Succeeded" }'));
        return ok(logs, { set: { analyzerId: v.analyzerId }, resources: [{ id: 'analyzer', type: 'Analyzer', name: v.analyzerId, meta: `${Object.keys(state.cats).length} categories`, parent: 'res' }] });
      },
    },
    {
      id: 'analyze',
      title: 'Analyze a mixed scan',
      why: 'The test file is one PDF holding an invoice (pages 1–2), a delivery note (page 3) and a landlord letter (page 4).',
      fields: [],
      action: 'Analyze scan-0917.pdf',
      run(state) {
        const logs = [cmd(`POST ${state.endpoint}contentunderstanding/analyzers/${state.analyzerId}:analyze?api-version=<version>\n{ "url": "https://stdocailab.blob.core.windows.net/inbox/scan-0917.pdf?<sas>" }`), out('HTTP 202 Accepted'), out('{ "status": "Succeeded" }')];
        if (!state.split) {
          logs.push(out('{ "contents": [ { "category": "invoice", "startPageNumber": 1, "endPageNumber": 4 } ] }'),
            info('The whole 4-page file is one "invoice": the delivery note and the letter are buried inside it.'));
          return fail(logs, 'Documents are not separated', 'Go back to "Define the categories" and turn on splitting.');
        }
        const letter = state.other ? 'other' : 'invoice';
        logs.push(out(`{ "contents": [\n  { "category": "invoice", "startPageNumber": 1, "endPageNumber": 2 },\n  { "category": "delivery_note", "startPageNumber": 3, "endPageNumber": 3 },\n  { "category": "${letter}", "startPageNumber": 4, "endPageNumber": 4 } ] }`));
        if (!state.other) {
          logs.push(info('Page 4 is a letter from a landlord, but with no "other" category it was forced into "invoice" — it would be sent to Accounts Payable.'));
          return fail(logs, 'Letter misclassified as an invoice', 'Go back to "Define the categories" and add an "other" category.');
        }
        return ok(logs, { set: { segments: 3 } });
      },
    },
    {
      id: 'route',
      title: 'Route each document through Service Bus',
      why: 'Send each segment to a queue per destination. Consumers use peek-lock: if the downstream system is down, the message is retried and, after the maximum delivery count, moved to the dead-letter queue instead of being lost.',
      fields: [
        { id: 'policy', label: 'Delivery handling', type: 'select', options: [['', 'Choose…'], ['peeklock', 'Peek-lock with retries, dead-letter after max delivery count'], ['receivedelete', 'Receive-and-delete (remove as soon as read)']], default: '', required: true },
      ],
      action: 'Create queues and send',
      run(state, v) {
        const logs = [cmd('az servicebus namespace create --name sb-docai-lab --resource-group ' + state.rg + ' --sku Standard'),
          cmd('az servicebus queue create --namespace-name sb-docai-lab --name ap-invoices --max-delivery-count 10'),
          cmd('az servicebus queue create --namespace-name sb-docai-lab --name purchasing --max-delivery-count 10'),
          cmd('az servicebus queue create --namespace-name sb-docai-lab --name triage --max-delivery-count 10'),
          out('3 queues created'), info('The ERP behind ap-invoices is down for maintenance during this test.')];
        const resources = [{ id: 'sb', type: 'Service Bus namespace', name: 'sb-docai-lab', parent: 'rg' }, { id: 'q1', type: 'Queue', name: 'ap-invoices', parent: 'sb' }, { id: 'q2', type: 'Queue', name: 'purchasing', parent: 'sb' }, { id: 'q3', type: 'Queue', name: 'triage', parent: 'sb' }];
        if (v.policy === 'receivedelete') {
          logs.push(out('purchasing: delivered · triage: delivered'), err('ap-invoices: consumer read the invoice, ERP returned 503, message already removed — invoice lost'));
          return fail(logs, 'An invoice was lost', 'Use peek-lock so a failed delivery is retried and then dead-lettered, never silently dropped.');
        }
        logs.push(out('purchasing: delivered · triage: delivered'), out('ap-invoices: ERP 503 → retry 1…10 → moved to ap-invoices/$deadletterqueue'), info('Alert on the dead-letter queue and resubmit once the ERP is back.'));
        return ok(logs, { resources: [...resources, { id: 'dlq', type: 'Dead-letter queue', name: 'ap-invoices/$deadletterqueue', meta: '1 message', parent: 'q1' }] });
      },
      docs: [DOCS.serviceBus],
    },
  ],
  solution: { resource: {}, access: { role: 'cog-user' }, models: { chat: 'gpt-4.1-mini' }, categories: { other: true, split: true }, create: {}, analyze: {}, route: { policy: 'peeklock' } },
  docs: [DOCS.cuQuickstart, DOCS.serviceBus],
};
