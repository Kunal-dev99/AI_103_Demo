// Guided Azure workflow: ingest a scanned document with a Content Understanding analyzer.
import { stepCreateResource, stepAccess, stepModels, preflight, authLine, ok, fail, cmd, out, err, info, DOCS } from './common.js';

export default {
  title: 'Analyze a scanned report in Azure',
  intro: 'The steps you would follow in your own subscription to turn a scanned two-column report into markdown for a RAG index.',
  goal: 'Markdown of the report, with headings and the table intact, ready for chunking.',
  steps: [
    stepCreateResource(),
    stepAccess(),
    stepModels(),
    {
      id: 'source',
      title: 'Make the document reachable',
      why: 'The service downloads the file from a URL you give it (or you send the bytes). A private blob URL without a token or a granted identity cannot be read.',
      fields: [
        { id: 'how', label: 'How will the service get the file?', type: 'select', options: [['', 'Choose…'], ['sas', 'Blob URL with a short-lived read-only SAS token'], ['private', 'Plain private blob URL (no token)'], ['bytes', 'Send the file bytes in the request body']], default: '', required: true },
      ],
      action: 'Prepare input',
      run(state, v) {
        const url = 'https://stdocailab.blob.core.windows.net/inbox/q3-report.pdf';
        if (v.how === 'sas') return ok([cmd('az storage blob generate-sas --account-name stdocailab --container-name inbox --name q3-report.pdf --permissions r --expiry <+1h> --as-user --auth-mode login'), out(`${url}?sv=…&sig=…`)], { set: { source: 'sas' }, resources: [{ id: 'blob', type: 'Blob', name: 'inbox/q3-report.pdf', meta: 'SAS, read-only, 1 h', parent: 'rg' }] });
        if (v.how === 'bytes') return ok([info('The app will read q3-report.pdf and send it as application/octet-stream.')], { set: { source: 'bytes' } });
        return ok([info(`Using ${url}`), info('No token, and the Foundry resource has no access to this storage account.')], { set: { source: 'private' }, resources: [{ id: 'blob', type: 'Blob', name: 'inbox/q3-report.pdf', meta: 'private', parent: 'rg' }] });
      },
      docs: [DOCS.blobAuth],
    },
    {
      id: 'analyze',
      title: 'Call the analyzer',
      why: 'Choose an analyzer that does layout analysis, so columns, headings and tables survive. The call is asynchronous: you get an Operation-Location URL back.',
      fields: [
        { id: 'analyzer', label: 'Analyzer', type: 'select', options: [['', 'Choose…'], ['prebuilt-document', 'prebuilt-document — OCR + layout + markdown (illustrative ID)'], ['prebuilt-read', 'prebuilt-read — OCR text only (illustrative ID)']], default: '', required: true },
      ],
      action: 'POST analyze',
      run(state, v) {
        const logs = [cmd(`POST ${state.endpoint}contentunderstanding/analyzers/${v.analyzer}:analyze?api-version=<version>\n${authLine(state)}\n{ "url": "${state.source === 'bytes' ? '(binary body)' : 'https://stdocailab.blob.core.windows.net/inbox/q3-report.pdf'}" }`)];
        const pf = preflight(state, logs);
        if (pf) return pf;
        if (state.source === 'private') {
          logs.push(err('(InvalidContentSourceUrl) Could not download content from the provided URL. HTTP 400'));
          return fail(logs, "Can't read the file", 'Go back to "Make the document reachable" and use a SAS URL (or send the bytes, or grant the resource\'s managed identity Storage Blob Data Reader).');
        }
        logs.push(out('HTTP 202 Accepted\nOperation-Location: …/analyzerResults/7f3c…?api-version=<version>'));
        return ok(logs, { set: { analyzer: v.analyzer } });
      },
    },
    {
      id: 'poll',
      title: 'Poll for the result and read it',
      why: 'Poll the Operation-Location until the status is Succeeded, then read the markdown and the structured content.',
      fields: [
        { id: 'interval', label: 'Polling interval', type: 'select', options: [['2', 'Every 2 seconds, honour Retry-After'], ['0', 'As fast as possible in a tight loop']], default: '2' },
      ],
      action: 'GET result',
      run(state, v) {
        const logs = [cmd('GET …/analyzerResults/7f3c…?api-version=<version>')];
        if (v.interval === '0') {
          logs.push(out('{ "status": "Running" }'), err('HTTP 429 Too Many Requests — Retry-After: 2'));
          return fail(logs, 'Throttled', 'Poll at a sensible interval and honour the Retry-After header.');
        }
        logs.push(out('{ "status": "Running" }'), info('… 2 s …'), out('{ "status": "Succeeded" }'));
        if (state.analyzer === 'prebuilt-read') {
          logs.push(out('{ "result": { "contents": [ { "kind": "document",\n  "markdown": "Quarterly Operations Review\\n1. Warehouse throughput\\n2. Returns processing\\nThroughput rose 12% after\\nReturns fell to 3.1% of …" } ] } }'),
            info('Text only: the columns are interleaved and the table is flattened. That is not good enough for RAG.'));
          return fail(logs, 'Wrong analyzer for this goal', 'Go back to "Call the analyzer" and choose the layout-capable document analyzer.');
        }
        logs.push(out('{ "result": { "analyzerId": "prebuilt-document", "contents": [ { "kind": "document",\n  "markdown": "# Quarterly Operations Review\\n## 1. Warehouse throughput\\nThroughput rose 12% after the new sorter …\\n## 2. Returns processing\\n…\\n| Site | Orders | Returns |\\n| --- | --- | --- |\\n| Leeds | 41,200 | 1,180 |",\n  "pages": [ … ], "tables": [ { "rowCount": 3, "columnCount": 3 } ] } ] } }'),
          info('Headings, column order and the table are intact. Next: split the markdown into chunks and index it.'));
        return ok(logs, { resources: [{ id: 'result', type: 'Result', name: 'q3-report.md', meta: 'markdown', parent: 'res' }] });
      },
    },
  ],
  solution: { resource: {}, access: { role: 'cog-user' }, models: { chat: 'gpt-4.1-mini' }, source: { how: 'sas' }, analyze: { analyzer: 'prebuilt-document' }, poll: {} },
  docs: [DOCS.cuQuickstart, DOCS.foundryResource],
};
