// Guided Azure workflow: build a custom Content Understanding analyzer that extracts invoice fields.
import { stepCreateResource, stepAccess, stepModels, preflight, authLine, ok, fail, cmd, out, err, info, DOCS } from './common.js';

const DEFAULT_SCHEMA = `VendorName: string extract "Company that issued the invoice"
InvoiceTotal: number extract "Grand total including tax"
DueDate: date extract "Date payment is due"
CostCentre: string extract "Internal cost centre code, e.g. CC-1042"
Category: string classify [goods|services|mixed] "What was purchased"`;

// Parse "Name: type method [a|b] "description"" lines into a field map.
function parseSchema(text) {
  const fields = {}, errors = [];
  String(text).split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const m = line.match(/^([A-Za-z][\w]*)\s*:\s*(\w+)\s+(\w+)(?:\s*\[([^\]]*)\])?(?:\s*"([^"]*)")?\s*$/);
    if (!m) { errors.push(`line ${i + 1}: expected  Name: type method ["description"]`); return; }
    const [, name, type, method, cats, desc] = m;
    if (!['string', 'number', 'date', 'boolean', 'integer'].includes(type)) errors.push(`${name}: unknown type "${type}"`);
    if (!['extract', 'classify', 'generate'].includes(method)) errors.push(`${name}: unknown method "${method}"`);
    if (method === 'classify' && !cats) errors.push(`${name}: classify needs categories, e.g. [goods|services]`);
    if (fields[name]) errors.push(`${name}: duplicate field`);
    fields[name] = { type, method, ...(cats ? { enum: cats.split('|').map(s => s.trim()) } : {}), ...(desc ? { description: desc } : {}) };
  });
  return { fields, errors };
}

export default {
  title: 'Build a custom field analyzer in Azure',
  intro: 'Create a Content Understanding analyzer with your own field schema, then use it on a supplier invoice.',
  goal: 'Typed invoice fields — including a company-specific cost centre — each with confidence and its source location.',
  steps: [
    stepCreateResource(),
    stepAccess(),
    stepModels(),
    {
      id: 'schema',
      title: 'Define the field schema',
      why: 'Each field has a name, a type, a method (extract what is printed, classify into categories, or generate a value) and a description. The description is what the analyzer uses to find the right value, so make it specific.',
      fields: [
        { id: 'base', label: 'Base analyzer', type: 'select', options: [['prebuilt-document', 'prebuilt-document (illustrative ID)'], ['prebuilt-audio', 'prebuilt-audio (illustrative ID)']], default: 'prebuilt-document', help: 'Your analyzer builds on a base analyzer for the input type.' },
        { id: 'schema', label: 'Fields (one per line)', type: 'textarea', rows: 7, default: DEFAULT_SCHEMA },
        { id: 'grounding', label: 'Return source location and confidence for each field', type: 'toggle', default: true },
      ],
      action: 'Validate schema',
      run(state, v) {
        const { fields, errors } = parseSchema(v.schema);
        const logs = [info(`${Object.keys(fields).length} field(s) parsed.`)];
        if (errors.length) { errors.forEach(e => logs.push(err(e))); return fail(logs, 'Schema has errors', errors[0]); }
        const body = { baseAnalyzerId: v.base, config: { estimateFieldSourceAndConfidence: !!v.grounding, returnDetails: true }, fieldSchema: { fields } };
        logs.push(out(JSON.stringify(body, null, 2)), info('Shape is illustrative; check the analyzer reference for your API version.'));
        return ok(logs, { set: { base: v.base, fields, grounding: !!v.grounding } });
      },
    },
    {
      id: 'create',
      title: 'Create the analyzer',
      why: 'You create an analyzer once with an ID of your choice, then call it by that ID. Creation is asynchronous; IDs must be unique in the resource.',
      fields: [
        { id: 'analyzerId', label: 'Analyzer ID', type: 'text', default: 'invoice-fields', help: 'In this lab, an analyzer called "invoice-fields" already exists in the resource.' },
        { id: 'replace', label: 'Replace it if it already exists', type: 'toggle', default: false },
      ],
      action: 'PUT analyzer',
      run(state, v) {
        const logs = [cmd(`PUT ${state.endpoint}contentunderstanding/analyzers/${v.analyzerId}?api-version=<version>${v.replace ? '&allowReplace=true' : ''}\n${authLine(state)}\n{ "baseAnalyzerId": "${state.base}", "fieldSchema": { … ${Object.keys(state.fields).length} fields … } }`)];
        const pf = preflight(state, logs);
        if (pf) return pf;
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(v.analyzerId)) { logs.push(err('(InvalidAnalyzerId) Use letters, numbers, dots, hyphens or underscores.')); return fail(logs, 'Invalid analyzer ID', 'Use something like invoice-fields-v2.'); }
        if (v.analyzerId === 'invoice-fields' && !v.replace) {
          logs.push(err(`(Conflict) An analyzer with ID '${v.analyzerId}' already exists. HTTP 409`));
          return fail(logs, '409 — analyzer ID already exists', 'Pick a new ID (e.g. invoice-fields-v2) or explicitly allow replacing the existing analyzer.');
        }
        if (state.base === 'prebuilt-audio') logs.push(info('Created on an audio base analyzer — it will not read PDF invoices.'));
        logs.push(out('HTTP 201 Created\nOperation-Location: …/analyzers/' + v.analyzerId + '/operations/…'), out('{ "status": "Succeeded" }'));
        return ok(logs, { set: { analyzerId: v.analyzerId }, resources: [{ id: 'analyzer', type: 'Analyzer', name: v.analyzerId, meta: `${Object.keys(state.fields).length} fields`, parent: 'res' }] });
      },
    },
    {
      id: 'analyze',
      title: 'Analyze an invoice and check the fields',
      why: 'Call your analyzer by ID. Each field comes back with a value, a confidence and (if enabled) where on the page it was found. Low confidence goes to human review.',
      fields: [
        { id: 'threshold', label: 'Your review threshold', type: 'select', options: [['0.8', 'Review anything below 0.80'], ['0', 'Accept everything (no review)']], default: '0.8' },
      ],
      action: 'Analyze invoice',
      run(state, v) {
        const logs = [cmd(`POST ${state.endpoint}contentunderstanding/analyzers/${state.analyzerId}:analyze?api-version=<version>\n{ "url": "https://stdocailab.blob.core.windows.net/inbox/INV-10442.pdf?<sas>" }`)];
        if (state.base === 'prebuilt-audio') { logs.push(err('(UnsupportedContent) The analyzer expects audio input but received application/pdf. HTTP 400')); return fail(logs, 'Wrong base analyzer', 'Go back to the schema step, choose the document base analyzer and recreate the analyzer.'); }
        logs.push(out('HTTP 202 Accepted'), out('{ "status": "Succeeded" }'));
        const values = { VendorName: ['Contoso Supplies Ltd', 0.97, 'D(1,0.6,0.5,3.1,0.8)'], InvoiceTotal: [288.0, 0.95, 'D(1,5.2,6.9,6.9,7.1)'], DueDate: ['2026-10-14', 0.93, 'D(1,5.2,1.6,6.4,1.8)'], CostCentre: ['CC-1042', 0.71, 'D(1,0.6,2.9,1.9,3.1)'], Category: ['goods', 0.88, null] };
        const result = {};
        for (const [name, f] of Object.entries(state.fields)) {
          const known = values[name];
          const value = known ? known[0] : null;
          result[name] = { type: f.type, value, confidence: known ? known[1] : 0, ...(state.grounding && known && known[2] ? { source: known[2] } : {}) };
        }
        logs.push(out(JSON.stringify({ result: { contents: [{ fields: result }] } }, null, 2)));
        const low = Object.entries(result).filter(([, r]) => r.confidence < Number(v.threshold));
        if (!state.grounding) {
          logs.push(info('No source locations returned, so reviewers cannot see where each value came from.'));
          return fail(logs, 'Fields have no evidence', 'Go back to the schema step and turn on source location and confidence.');
        }
        if (Number(v.threshold) === 0) {
          logs.push(info('Everything auto-accepted, including CostCentre at 0.71.'));
          return fail(logs, 'Uncertain values posted without review', 'Keep a review threshold so low-confidence values (CostCentre 0.71) go to a person.');
        }
        logs.push(info(low.length ? `${low.map(([n]) => n).join(', ')} below ${v.threshold}: send to the review queue; the rest can be accepted.` : 'All fields above threshold.'));
        return ok(logs, { resources: [{ id: 'result', type: 'Result', name: 'INV-10442.json', meta: `${Object.keys(result).length} fields`, parent: 'analyzer' }] });
      },
    },
  ],
  solution: { resource: {}, access: { role: 'cog-user' }, models: { chat: 'gpt-4.1-mini' }, schema: {}, create: { analyzerId: 'invoice-fields-v2' }, analyze: {} },
  docs: [DOCS.cuQuickstart],
};
