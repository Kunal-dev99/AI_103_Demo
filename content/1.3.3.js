// 1.3.3 Monitor data ingestion quality, search index health, and relevance performance
// Lab: Search index health monitor.
import { rng, round, step, metric } from '../src/engine/util.js';

// Blob container contents for this simulation. Since the last successful run:
// 10 new, 6 updated, 4 deleted documents.
const SOURCE = { total: 120, scanned: 12, specialKeys: 7, added: 10, updated: 6, deleted: 4 };

// Test query set with the document type each query's best answer lives in.
const QUERIES = [
  { q: 'parental leave entitlement', target: 'normal' },
  { q: 'travel expense limit 2026', target: 'updated' },
  { q: 'remote work equipment allowance', target: 'new' },
  { q: 'signed safety inspection form', target: 'scanned' },
  { q: 'company car policy', target: 'deleted', note: 'Policy was retired; the correct answer is the replacement mobility policy.' },
  { q: "Q&A: contractor's onboarding checklist", target: 'specialKey' },
];

const SKILL_P95 = { fast: 5, slow: 45, verySlow: 120 };

function healthCheck(p) {
  const r = rng(`${p.storageRole}|${p.fieldMapping}|${p.skillLatency}|${p.skillTimeout}|${p.embedding}|${p.schedule}`);
  const steps = [];
  const errors = [], warnings = [];
  const maxFailed = Number(p.maxFailedItems);

  steps.push(step('source', 'Data source scanned', `Blob container "hr-policies": ${SOURCE.total} documents (${SOURCE.scanned} scanned PDFs). Since the last successful run: ${SOURCE.added} new, ${SOURCE.updated} updated, ${SOURCE.deleted} deleted. In this simulation the run re-processes all documents (as after an indexer reset), so every document passes through the skillset.`,
    { container: 'hr-policies', ...SOURCE, changeDetection: 'LastModified (blob default)', deletionDetection: p.softDelete ? 'NativeBlobSoftDeleteDeletionDetectionPolicy' : 'none' }, 'info'));

  // Freshness from schedule
  const pendingShare = { PT15M: 0, PT1H: 0.1, P1D: 0.5, none: 1 }[p.schedule];
  const pendingChanges = Math.round((SOURCE.added + SOURCE.updated) * pendingShare);

  // Auth
  if (p.storageRole === 'none') {
    steps.push(step('auth', 'Indexer cannot read the container', 'The search service\'s managed identity has no data-plane role on the storage account. Blob listing returns 403 AuthorizationPermissionMismatch. Every scheduled run fails, and the index keeps serving whatever it had from the last successful run.',
      { httpStatus: 403, code: 'AuthorizationPermissionMismatch', identity: 'search service system-assigned MI', requiredRole: 'Storage Blob Data Reader' }, 'error'));
    return {
      steps,
      output: [
        { type: 'json', title: 'GET /indexers/hr-policies-indexer/status (abridged, simulated shape)', data: { status: 'running', lastResult: { status: 'transientFailure', errorMessage: 'Error with data source: 403 AuthorizationPermissionMismatch (illustrative)', itemsProcessed: 0, itemsFailed: 0 } } },
        { type: 'alert', tone: 'error', text: 'Nothing new is ingested. Assign Storage Blob Data Reader to the search service\'s managed identity on the storage account (or container).' },
      ],
      metrics: [metric('Documents ingested this run', '0', 'computed')],
      summary: 'Indexer blocked: 403 on storage',
    };
  }
  steps.push(step('auth', 'Indexer connected to storage', p.storageRole === 'reader' ? 'Search service managed identity has Storage Blob Data Reader: keyless data source connection (ResourceId=...).' : 'Connected with a storage account key in the connection string. It works, but the key must be rotated and stored securely; prefer managed identity.',
    { auth: p.storageRole === 'reader' ? 'managed identity' : 'account key' }, p.storageRole === 'reader' ? 'ok' : 'warn'));

  // Field mappings (validated at run start)
  if (p.fieldMapping === 'missingTarget') {
    steps.push(step('map', 'Indexer run failed at validation', 'A field mapping targets "title", but the index schema calls that field "docTitle". The indexer refuses to run until mappings match index fields.',
      { fieldMappings: [{ sourceFieldName: 'metadata_storage_name', targetFieldName: 'title' }], indexFields: ['id', 'docTitle', 'content', 'contentVector', 'lastModified'] }, 'error'));
    return {
      steps,
      output: [
        { type: 'json', title: 'Indexer status (abridged, simulated)', data: { lastResult: { status: 'error', errorMessage: "Field mapping specifies target field 'title' that doesn't exist in the index (illustrative wording)", itemsProcessed: 0, itemsFailed: 0 } } },
        { type: 'diff', title: 'Fix the indexer definition', before: '"fieldMappings": [{ "sourceFieldName": "metadata_storage_name", "targetFieldName": "title" }]', after: '"fieldMappings": [{ "sourceFieldName": "metadata_storage_name", "targetFieldName": "docTitle" }]' },
      ],
      metrics: [metric('Documents ingested this run', '0', 'computed')],
      summary: 'Indexer error: field mapping target missing',
    };
  }

  // Document cracking
  const toProcess = SOURCE.total;
  let noText = 0;
  if (!p.ocr) { noText = SOURCE.scanned; for (let i = 0; i < 3; i++) warnings.push({ key: `scan-${i + 1}.pdf`, message: 'Document has no extracted text content (image-only PDF, no OCR skill)' }); }
  steps.push(step('crack', 'Document cracking', `${toProcess} documents cracked. ${p.ocr ? 'OCR skill extracts text from scanned PDFs (imageAction: generateNormalizedImages).' : `${SOURCE.scanned} scanned PDFs produced empty content because no OCR skill is configured.`}`,
    { cracked: toProcess, emptyContent: noText, imageAction: p.ocr ? 'generateNormalizedImages' : 'none' }, p.ocr ? 'ok' : 'warn'));

  // Skillset: custom Web API skill + embedding skill
  const p95 = SKILL_P95[p.skillLatency];
  let skillFailed = 0;
  if (p95 > p.skillTimeout) {
    const share = p95 > p.skillTimeout * 2 ? 0.6 : 0.3;
    skillFailed = Math.round(toProcess * share);
    for (let i = 0; i < 3; i++) errors.push({ key: `policy-${String(Math.floor(r() * 900) + 100)}.pdf`, statusCode: 504, name: '#Microsoft.Skills.Custom.WebApiSkill.pii-redact', message: `Web API skill request timed out after ${p.skillTimeout}s` });
  }
  let embedFailed = 0, embedMissing = 0;
  if (p.embedding === 'wrongName') {
    embedFailed = toProcess;
    errors.push({ key: '(all documents)', statusCode: 404, name: '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill', message: "DeploymentNotFound: deployment 'text-embed-prod' does not exist (illustrative)" });
  } else if (p.embedding === 'throttled') {
    embedMissing = Math.round(toProcess * 0.15);
    warnings.push({ key: '(18 documents)', message: 'AzureOpenAIEmbeddingSkill: 429 Too Many Requests after retries; vector not generated' });
  }
  const skillStatus = skillFailed || embedFailed ? 'error' : embedMissing ? 'warn' : 'ok';
  steps.push(step('skills', 'Skillset execution', [
    `Custom PII-redaction Web API skill p95 ≈ ${p95}s vs timeout ${p.skillTimeout}s${skillFailed ? ` → ${skillFailed} documents timed out` : ' → OK'}.`,
    p.embedding === 'wrongName' ? 'Embedding skill points to a deployment name that does not exist → every document fails.' : p.embedding === 'throttled' ? `Embedding deployment is throttled: ${embedMissing} documents indexed without vectors.` : 'Embedding skill generated vectors for all chunks.',
  ].join(' '), { webApiSkill: { p95Seconds: p95, timeoutSeconds: p.skillTimeout, failed: skillFailed }, embeddingSkill: { status: p.embedding, failed: embedFailed, missingVectors: embedMissing } }, skillStatus === 'error' ? 'warn' : skillStatus));

  // Field mapping: key encoding
  let keyFailed = 0;
  if (p.fieldMapping === 'keyNotEncoded') {
    keyFailed = SOURCE.specialKeys;
    errors.push({ key: "Q&A contractor's onboarding.docx", statusCode: 400, name: 'document key', message: 'Invalid document key: keys can only contain letters, digits, underscore, dash or equal sign (use base64Encode mapping function)' });
  }
  steps.push(step('map', 'Field mappings', p.fieldMapping === 'keyNotEncoded' ? `metadata_storage_path is used as the key without base64Encode. ${keyFailed} blob names contain characters not allowed in keys and fail.` : 'Key mapped with base64Encode; title, content, vector and lastModified mapped.',
    { keyMapping: p.fieldMapping === 'keyNotEncoded' ? 'metadata_storage_path (raw)' : 'metadata_storage_path → base64Encode' }, keyFailed ? 'warn' : 'ok'));

  // Indexer run outcome
  const failedItems = Math.min(toProcess, Math.max(skillFailed, embedFailed) + keyFailed);
  const exceeded = maxFailed !== -1 && failedItems > maxFailed;
  const runStatus = exceeded ? 'transientFailure' : 'success';
  steps.push(step('run', exceeded ? 'Indexer run failed: too many failed items' : failedItems ? 'Run "succeeded" with failed items ignored' : 'Indexer run succeeded',
    exceeded ? `${failedItems} items failed, maxFailedItems = ${maxFailed}. The run stops and reports failure, so this batch of changes is not reliably applied (simplified here as: no changes applied).`
      : failedItems ? `maxFailedItems = ${maxFailed === -1 ? '-1 (unlimited)' : maxFailed} lets the run report success while ${failedItems} documents are silently missing from the index. Monitor itemsFailed, not just status.`
        : `All ${toProcess} items processed${warnings.length ? ` with ${warnings.length} warning group(s)` : ''}.`,
    { status: runStatus, itemsProcessed: toProcess, itemsFailed: failedItems, maxFailedItems: maxFailed, errors: errors.length, warnings: warnings.length },
    exceeded ? 'error' : failedItems ? 'warn' : warnings.length ? 'warn' : 'ok'));

  // Index state
  const applied = !exceeded;
  const missing = applied ? failedItems : 0;
  const pendingNew = applied ? Math.round(SOURCE.added * pendingShare) : SOURCE.added;
  const pendingUpd = applied ? Math.round(SOURCE.updated * pendingShare) : SOURCE.updated;
  const orphans = p.softDelete && applied ? 0 : SOURCE.deleted;
  const docCount = Math.max(0, SOURCE.total - pendingNew - missing) + orphans;
  const coverage = Math.max(0, (SOURCE.total - missing - pendingNew) / SOURCE.total);
  steps.push(step('index', 'Index health', `documentCount ${docCount}. Missing (failed): ${missing}. New docs not yet indexed (schedule ${p.schedule}): ${pendingNew}. Stale versions: ${pendingUpd}. Orphans of deleted blobs: ${orphans}.${embedMissing ? ` Without vectors: ${embedMissing}.` : ''}`,
    { documentCount: docCount, missing, pendingNew, staleVersions: pendingUpd, orphans, withoutVectors: embedMissing, emptyContent: noText, schedule: p.schedule },
    missing || orphans || pendingNew || pendingUpd || noText ? 'warn' : 'ok'));

  // Relevance test set
  const rows = QUERIES.map((qq, i) => {
    let s = 0.82 + (p.semantic ? 0.1 : 0) + (r() - 0.5) * 0.04, why = 'best document ranked top';
    const vecLoss = (embedFailed && applied) || (embedMissing && i % 3 === 0);
    if (qq.target === 'updated' && pendingUpd) { s = 0.4; why = 'old version of the policy ranked top (stale)'; }
    if (qq.target === 'new' && pendingNew) { s = 0; why = 'document not in index yet'; }
    if (qq.target === 'new' && !applied) { s = 0; why = 'run failed; document not in index'; }
    if (qq.target === 'scanned' && noText) { s = 0.05; why = 'scanned form has no text content'; }
    if (qq.target === 'deleted' && orphans) { s = 0.3; why = 'retired policy (deleted blob) still ranks top'; }
    if (qq.target === 'specialKey' && keyFailed) { s = 0; why = 'document failed on key encoding'; }
    if (applied && skillFailed && (qq.target === 'new' || qq.target === 'updated' || qq.target === 'normal') && i % 2 === 0) { s = Math.min(s, 0.2); why = 'document failed in the custom skill'; }
    if (s > 0.3 && vecLoss) { s -= 0.25; why += '; keyword-only (no vector)'; }
    if (applied && missing >= SOURCE.total && qq.target !== 'deleted') { s = 0; why = 'every document failed this run; nothing current is searchable'; }
    return { q: qq.q, score: round(Math.max(0, Math.min(1, s)), 2), why };
  });
  const meanRel = rows.reduce((a, x) => a + x.score, 0) / rows.length;
  steps.push(step('query', 'Relevance test set', `Mean relevance@5 (toy NDCG-style score) over ${rows.length} judged queries: ${meanRel.toFixed(2)}.${p.semantic ? ' Semantic ranker reranks the top results.' : ''}`,
    { queries: rows }, meanRel >= 0.8 ? 'ok' : meanRel >= 0.6 ? 'warn' : 'warn'));

  const output = [
    { type: 'kv', title: 'Index statistics', items: [
      ['documentCount', String(docCount)], ['Coverage of source', `${round(coverage * 100)}%`], ['Stale versions', String(pendingUpd)],
      ['Orphans (deleted in source)', String(orphans)], ['Empty-content docs', String(noText)], ['Docs without vectors', String(embedFailed && applied ? SOURCE.total - missing : embedMissing)],
    ] },
    { type: 'bars', title: 'Relevance per test query (line = 0.8 target)', threshold: 0.8,
      items: rows.map(x => ({ label: x.q, value: x.score, note: x.why, tone: x.score >= 0.8 ? 'ok' : x.score >= 0.5 ? 'warn' : 'error' })) },
    { type: 'json', title: 'GET /indexers/hr-policies-indexer/status (abridged, simulated shape)', data: {
      status: 'running',
      lastResult: { status: runStatus, errorMessage: exceeded ? 'Exceeded maxFailedItems (illustrative)' : null, itemsProcessed: toProcess, itemsFailed: failedItems, errors: errors.slice(0, 4), warnings: warnings.slice(0, 4) },
      limits: { maxRunTime: 'service-dependent', maxDocumentExtractionSize: 'tier-dependent (see docs)' },
    } },
    { type: 'table', title: 'Indexer execution history (last 5 runs, simulated)', columns: ['Run', 'Status', 'Processed', 'Failed', 'Warnings'],
      rows: [4, 3, 2, 1, 0].map(k => k === 0 ? ['now', runStatus, String(toProcess), String(failedItems), String(warnings.length)] : [`-${k}`, 'success', String(Math.round(4 + r() * 6)), '0', '0']),
      tones: [4, 3, 2, 1, 0].map(k => k === 0 ? (exceeded ? 'error' : failedItems || warnings.length ? 'warn' : 'ok') : 'ok') },
  ];
  if (maxFailed === -1 && failedItems) output.push({ type: 'alert', tone: 'warn', text: `Silent data loss: the run shows "success" but ${failedItems} documents are not searchable. Alert on itemsFailed, or keep maxFailedItems at 0 and fix the cause.` });

  return {
    steps, output,
    metrics: [
      metric('Mean relevance@5', meanRel.toFixed(2), 'computed', 'Toy graded-relevance score over 6 judged queries in this simulation.'),
      metric('Source coverage', `${round(coverage * 100)}%`, 'computed'),
      metric('Items failed (last run)', String(failedItems), 'computed'),
      metric('Freshness lag', { PT15M: '≤15 min', PT1H: '≤1 h', P1D: '≤1 day', none: 'unbounded' }[p.schedule], 'estimate', 'Worst-case delay between a blob change and the index, given the indexer schedule (ignores run duration).'),
    ],
    summary: `run ${runStatus}, failed ${failedItems}, coverage ${round(coverage * 100)}%, orphans ${orphans}, relevance ${meanRel.toFixed(2)}`,
  };
}

export default {
  id: '1.3.3',
  lab: 'Search index health monitor',
  services: [
    { name: 'Azure AI Search: monitor indexer status and results', url: 'https://learn.microsoft.com/en-us/azure/search/search-howto-monitor-indexers' },
    { name: 'Troubleshoot common indexer errors and warnings', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-common-errors-warnings' },
    { name: 'Indexer connections using managed identity', url: 'https://learn.microsoft.com/en-us/azure/search/search-howto-managed-identities-data-sources' },
    { name: 'Change and deletion detection for blob indexers', url: 'https://learn.microsoft.com/en-us/azure/search/search-howto-index-changed-deleted-blobs' },
    { name: 'Monitor Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/monitor-azure-cognitive-search' },
  ],
  prereqs: ['1.1.3', '5.1.1'],
  next: ['5.1.2', '5.1.3', '1.3.2'],

  concept: {
    plain: 'A search index is only as good as what reaches it. Files can fail to load, be loaded without their text, arrive late, or linger after they were deleted, and the indexer may still say "success". Monitoring ingestion means checking how many documents were processed or failed and why, whether the index matches the source, and whether a fixed set of test questions still finds the right documents.',
    technical: 'Azure AI Search indexers expose execution history via the indexer status API (lastResult.status, itemsProcessed, itemsFailed, errors[], warnings[]) and Azure Monitor metrics/diagnostic logs. Common failures: data source auth (the search service\'s managed identity needs Storage Blob Data Reader), field mappings that target non-existent index fields, document keys with invalid characters (use the base64Encode mapping function), custom Web API skills exceeding their timeout (configurable, with a documented maximum), embedding skills pointing at a missing or throttled Azure OpenAI deployment, and image-only PDFs without an OCR skill. maxFailedItems decides whether item failures fail the run; -1 hides them. Freshness depends on the schedule and change detection; deletions need a deletion detection policy (e.g. native blob soft delete). Relevance is tracked with a judged query set and a graded metric such as NDCG, with and without semantic ranking.',
    useCase: 'An HR assistant answers from 120 policy documents in Blob Storage. After a storage hardening project, answers about new policies start missing. The index health check shows the indexer has returned 403 for three days; the old travel policy also still ranks top because deletion detection was never configured.',
    terms: [
      ['Indexer', 'Crawler that reads a data source on a schedule, cracks documents, runs a skillset and writes to an index.'],
      ['itemsFailed / maxFailedItems', 'Per-run count of failed documents, and the tolerance above which the run is marked failed.'],
      ['Deletion detection', 'Policy that removes index documents when their source blob is deleted (soft delete or a custom metadata flag).'],
      ['Orphan', 'Index document whose source no longer exists; it can outrank current content.'],
      ['NDCG', 'Normalized discounted cumulative gain: graded relevance metric that rewards relevant results near the top.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'source', label: 'Source documents', col: 0, row: 1, kind: 'store', detail: 'Files in the data source, with adds, updates and deletes.' },
          { id: 'auth', label: 'Connect', col: 1, row: 0, kind: 'policy', badge: p && p.storageRole === 'none' ? '403' : undefined, detail: 'Indexer authenticates to the source.' },
          { id: 'crack', label: p && !p.ocr ? 'Crack (no OCR)' : 'Crack + OCR', col: 1, row: 1, kind: 'compute', detail: 'Extract text and images from files.' },
          { id: 'skills', label: 'Enrich (skills)', col: 2, row: 1, kind: 'ai', detail: 'Custom and built-in skills, embeddings.', substeps: ['OCR / merge', 'Custom Web API skill', 'Chunk', 'Embed'] },
          { id: 'map', label: 'Map fields + key', col: 3, row: 1, kind: 'code', detail: 'Field and output field mappings into the index schema.' },
          { id: 'run', label: p ? `Run status (maxFailedItems ${p.maxFailedItems})` : 'Run status', col: 3, row: 0, kind: 'policy', detail: 'Success, transientFailure or error; per-item errors and warnings.' },
          { id: 'index', label: 'Index', col: 4, row: 1, kind: 'store', detail: 'Document count, freshness, orphans, vectors.' },
          { id: 'query', label: 'Relevance test set', col: 4, row: 2, kind: 'user', detail: 'Judged queries scored with a graded metric.' },
        ],
        edges: [['source', 'auth'], ['auth', 'crack'], ['crack', 'skills'], ['skills', 'map'], ['map', 'index'], ['map', 'run'], ['index', 'query']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'source', label: 'Storage account (Blob, soft delete ' + (p ? (p.softDelete ? 'on' : 'off') : '?') + ')', col: 0, row: 1, kind: 'store', detail: 'Container hr-policies.' },
          { id: 'auth', label: p ? (p.storageRole === 'reader' ? 'Search MI → Storage Blob Data Reader' : p.storageRole === 'key' ? 'Account key in connection string' : 'Search MI: no role') : 'Data source credentials', col: 1, row: 0, kind: 'policy', detail: 'Keyless via managed identity is recommended.' },
          { id: 'crack', label: 'Azure AI Search indexer', col: 1, row: 1, kind: 'compute', detail: `Schedule ${p ? p.schedule : ''}.` },
          { id: 'skills', label: 'Skillset → Function app + Azure OpenAI embeddings', col: 2, row: 1, kind: 'ai', detail: 'Custom WebApiSkill (Azure Function) and AzureOpenAIEmbeddingSkill.' },
          { id: 'map', label: 'Index schema', col: 3, row: 1, kind: 'data', detail: 'id (key), docTitle, content, contentVector, lastModified.' },
          { id: 'run', label: 'Azure Monitor (diagnostic logs, alerts)', col: 3, row: 0, kind: 'policy', detail: 'Alert on failed runs and itemsFailed > 0.' },
          { id: 'index', label: 'Search index', col: 4, row: 1, kind: 'store', detail: 'Serves the RAG app.' },
          { id: 'query', label: p && p.semantic ? 'Query eval (semantic ranker on)' : 'Query eval', col: 4, row: 2, kind: 'app', detail: 'Offline judged query set run after each indexer change.' },
        ],
        edges: [['source', 'auth'], ['auth', 'crack'], ['crack', 'skills'], ['skills', 'map'], ['map', 'index'], ['crack', 'run', 'logs'], ['index', 'query']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'auth', label: 'data_source: credentials.connectionString = "ResourceId=/subscriptions/.../storageAccounts/..."', col: 0, row: 0, kind: 'code', detail: 'Managed-identity connection string format for blob data sources.' },
          { id: 'source', label: p && p.softDelete ? 'dataDeletionDetectionPolicy: NativeBlobSoftDeleteDeletionDetectionPolicy' : 'dataDeletionDetectionPolicy: (none)', col: 0, row: 1, kind: 'code', detail: 'Requires blob soft delete enabled on the storage account.' },
          { id: 'skills', label: `WebApiSkill(uri=..., timeout="PT${p ? p.skillTimeout : 30}S")`, col: 0, row: 2, kind: 'code', detail: 'Custom skill timeout is an ISO 8601 duration; check docs for the maximum.' },
          { id: 'map', label: p && p.fieldMapping === 'keyNotEncoded' ? 'FieldMapping("metadata_storage_path", "id")' : 'FieldMapping("metadata_storage_path", "id", mapping_function=base64Encode)', col: 0, row: 3, kind: 'code', detail: 'Keys must be URL-safe; base64Encode is the usual fix.' },
          { id: 'run', label: `parameters: { maxFailedItems: ${p ? p.maxFailedItems : 0} }`, col: 0, row: 4, kind: 'code', detail: '-1 means unlimited.' },
          { id: 'crack', label: 'status = indexer_client.get_indexer_status("hr-policies-indexer")', col: 0, row: 5, kind: 'code', detail: 'azure-search-documents SearchIndexerClient; inspect last_result.errors / warnings.' },
          { id: 'index', label: 'search_client.get_document_count()', col: 0, row: 6, kind: 'code', detail: 'Compare with the source count.' },
          { id: 'query', label: 'for q in judged_queries: ndcg(search_client.search(q, query_type="semantic"))', col: 0, row: 7, kind: 'code', detail: 'Your own evaluation loop (illustrative).' },
        ],
        edges: [['auth', 'source'], ['source', 'skills'], ['skills', 'map'], ['map', 'run'], ['run', 'crack'], ['crack', 'index'], ['index', 'query']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'storageRole', label: 'Indexer access to storage', type: 'select', options: [['reader', 'Managed identity + Storage Blob Data Reader'], ['key', 'Storage account key'], ['none', 'Managed identity, no role assigned']], default: 'reader' },
      { id: 'fieldMapping', label: 'Field mappings', type: 'select', options: [['correct', 'Correct (key base64Encoded)'], ['keyNotEncoded', 'Key not encoded'], ['missingTarget', 'Mapping targets a field not in the index']], default: 'correct' },
      { id: 'ocr', label: 'OCR skill for scanned PDFs', type: 'toggle', default: true },
      { id: 'skillLatency', label: 'Custom PII skill latency (p95)', type: 'select', options: [['fast', '~5 s'], ['slow', '~45 s'], ['verySlow', '~120 s']], default: 'fast' },
      { id: 'skillTimeout', label: 'Custom skill timeout (s)', type: 'range', min: 30, max: 230, step: 10, default: 30, help: 'Default and maximum timeouts are documented for WebApiSkill; check the current docs.' },
      { id: 'embedding', label: 'Embedding skill deployment', type: 'select', options: [['ok', 'Deployment exists, enough quota'], ['throttled', 'Deployment throttled (low TPM)'], ['wrongName', 'Wrong deployment name']], default: 'ok' },
      { id: 'maxFailedItems', label: 'maxFailedItems', type: 'select', options: [['0', '0 (fail run on any failed item)'], ['10', '10'], ['-1', '-1 (unlimited)']], default: '0' },
      { id: 'schedule', label: 'Indexer schedule', type: 'select', options: [['PT15M', 'Every 15 minutes'], ['PT1H', 'Hourly'], ['P1D', 'Daily'], ['none', 'On demand only']], default: 'P1D' },
      { id: 'softDelete', label: 'Deletion detection (blob soft delete)', type: 'toggle', default: false },
      { id: 'semantic', label: 'Semantic ranker on queries', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Daily schedule, no deletion detection', values: {} },
      { label: 'Healthy: 15-min schedule + soft delete', values: { schedule: 'PT15M', softDelete: true } },
      { label: 'Slow custom skill, failures ignored', values: { skillLatency: 'slow', maxFailedItems: '-1' } },
      { label: 'Scanned PDFs without OCR', values: { ocr: false, schedule: 'PT15M', softDelete: true } },
    ],
    run: healthCheck,
  },

  compare: {
    suggestions: [
      'Run the slow custom skill with maxFailedItems 0 and then -1: compare the run status with the relevance scores.',
      'Compare Daily vs 15-minute schedules with deletion detection off and on.',
      'Compare semantic ranker on and off on the healthy configuration.',
    ],
  },

  debug: [
    { id: 'rbac', title: 'Indexer returns 403 after storage hardening', values: { storageRole: 'none' }, node: 'auth',
      symptom: 'Every run fails with AuthorizationPermissionMismatch; index content stops changing.', cause: 'Shared-key access was disabled and the search service\'s managed identity has no data-plane role on storage.', fix: 'Assign Storage Blob Data Reader to the search service managed identity (Indexer access = managed identity + reader).' },
    { id: 'mapping', title: 'Indexer will not start', values: { fieldMapping: 'missingTarget' }, node: 'map',
      symptom: 'Run fails immediately with zero items processed.', cause: 'A field mapping targets "title", which is not a field in the index schema.', fix: 'Map to the existing field name (docTitle) or add the field to the index.' },
    { id: 'timeout', title: 'Run fails with Web API skill timeouts', values: { skillLatency: 'slow', skillTimeout: 30 }, node: 'skills',
      symptom: 'Many items fail with 504 / timed out; the run is marked failed.', cause: 'The custom PII skill takes ~45 s at p95 but the skill timeout is 30 s.', fix: 'Raise the skill timeout above the p95 (e.g. 60–90 s), reduce batch size, or speed up the function.' },
    { id: 'embed', title: 'No vectors, vector queries return nothing useful', values: { embedding: 'wrongName', maxFailedItems: '-1' }, node: 'skills',
      symptom: 'Run "succeeds" but every item failed in the embedding skill.', cause: 'The embedding skill references a deployment name that does not exist in the Azure OpenAI / Foundry resource.', fix: 'Point the skill at the correct embedding deployment and keep maxFailedItems at 0 so this cannot hide.' },
    { id: 'orphans', title: 'Retired policy still answers questions', values: { softDelete: false, schedule: 'PT15M' }, node: 'index',
      symptom: 'The deleted company-car policy ranks top for "company car policy".', cause: 'No deletion detection policy, so deleted blobs remain in the index as orphans.', fix: 'Enable blob soft delete and NativeBlobSoftDeleteDeletionDetectionPolicy (toggle Deletion detection on), then reset/rerun.' },
  ],

  challenge: {
    task: 'Your custom PII skill is slow (~45 s p95). Get a healthy index: no failed items with maxFailedItems kept at 0, 100% source coverage, no orphans, and mean relevance ≥ 0.85.',
    condition: 'skill latency = ~45 s, maxFailedItems = 0, run succeeds with 0 failed items, coverage 100%, orphans 0, mean relevance ≥ 0.85.',
    hint: 'Fix the timeout first, then look at what the schedule and deletion detection do to freshness and orphans.',
    check: (p, res) => {
      const run = res.steps.find(s => s.node === 'run');
      const idx = res.steps.find(s => s.node === 'index');
      const q = res.steps.find(s => s.node === 'query');
      if (!run || !idx || !q) return false;
      const mean = q.data.queries.reduce((a, x) => a + x.score, 0) / q.data.queries.length;
      return p.skillLatency === 'slow' && p.maxFailedItems === '0' && run.data.itemsFailed === 0 && idx.data.missing === 0 && idx.data.pendingNew === 0 && idx.data.orphans === 0 && mean >= 0.85;
    },
    solution: ['Keep skill latency at ~45 s and maxFailedItems at 0.', 'Raise the custom skill timeout to 90 s (above the p95).', 'Schedule every 15 minutes so new and updated documents are indexed promptly.', 'Turn on deletion detection so the retired policy is removed.', 'Keep OCR and semantic ranker on.'],
    solutionValues: { skillLatency: 'slow', skillTimeout: 90, maxFailedItems: '0', schedule: 'PT15M', softDelete: true, ocr: true, semantic: true, storageRole: 'reader', fieldMapping: 'correct', embedding: 'ok' },
  },

  quiz: [
    { q: 'An indexer shows "success" for every run, but some new documents never appear in search results. maxFailedItems is -1. What should you check?', options: ['Semantic ranker configuration', 'lastResult.itemsFailed and the errors array in indexer status', 'The index replica count', 'The query API version'], answer: 1, why: 'With maxFailedItems -1 item failures do not fail the run; the per-item errors are in the status response.' },
    { q: 'You disabled shared key access on the storage account and the blob indexer now fails with 403. What is the keyless fix?', options: ['Re-enable shared keys', 'Assign Storage Blob Data Reader to the search service managed identity and use a ResourceId connection string', 'Assign Search Index Data Contributor to the storage account', 'Grant Owner on the subscription to the indexer'], answer: 1, why: 'Indexers use the search service identity to read blobs; it needs a data-plane read role on storage.' },
    { q: 'Users still get answers from a policy you deleted from Blob Storage last week. What configuration is missing?', options: ['A deletion detection policy such as native blob soft delete', 'A larger embedding model', 'A semantic configuration', 'A higher maxFailedItems'], answer: 0, why: 'Without deletion detection, indexers never remove documents whose source was deleted.' },
    { q: 'Scanned PDF forms are indexed but searching for their contents finds nothing, and warnings mention empty content. What do you add?', options: ['An OCR skill with image extraction (normalized images)', 'A synonym map', 'A scoring profile', 'More replicas'], answer: 0, why: 'Image-only PDFs need OCR to produce text for the index.' },
  ],

  recap: 'Watch indexer status (itemsProcessed, itemsFailed, errors, warnings), not just the run status; keep maxFailedItems strict or alert on failures. Use managed identity with the right data role, valid field mappings and keys, skill timeouts above real latency, existing embedding deployments, OCR for scans, a schedule that meets freshness needs and deletion detection. Track relevance with a judged query set.',
};
