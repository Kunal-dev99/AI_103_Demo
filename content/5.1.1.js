// 5.1.1 Ingest and index content, such as documents, images, audio, and video
// Lab: Multimodal indexer console.
import { round, step, metric, hasError } from '../src/engine/util.js';

// Toy blob container. `chars` = characters of text the simulation assumes can be extracted.
// Values are illustrative, chosen to teach; they are not measured from real files.
const FILES = [
  { path: 'policies/travel-policy.pdf', ext: 'pdf', mime: 'application/pdf', kind: 'doc', chars: 18400, in: ['docs', 'mixed'] },
  { path: 'policies/expenses-faq.docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'doc', chars: 9200, in: ['docs', 'mixed'] },
  { path: 'policies/legacy-handbook.wpd', ext: 'wpd', mime: 'application/wordperfect', kind: 'unsupported', chars: 0, in: ['docs', 'mixed'] },
  { path: 'images/taxi-receipt.png', ext: 'png', mime: 'image/png', kind: 'image', chars: 0, ocr: 'NORTHWIND TAXI  Airport transfer  42.50 GBP', caption: 'A printed taxi receipt on a table', in: ['images', 'mixed'] },
  { path: 'images/floor3-plan.jpg', ext: 'jpg', mime: 'image/jpeg', kind: 'image', chars: 0, ocr: 'Floor 3  Fire exit  Assembly point B', caption: 'An office floor plan with exits marked', in: ['images', 'mixed'] },
  { path: 'media/townhall-q3.mp3', ext: 'mp3', mime: 'audio/mpeg', kind: 'audio', chars: 0, minutes: 42, transcriptChars: 31000, in: ['media', 'mixed'] },
  { path: 'media/onboarding.mp4', ext: 'mp4', mime: 'video/mp4', kind: 'video', chars: 0, minutes: 12, transcriptChars: 8800, in: ['media', 'mixed'] },
];

// What changed in the container between the initial run and the incremental run.
const CHANGES = { modified: 'policies/expenses-faq.docx', deleted: 'images/taxi-receipt.png', deletedIn: ['images', 'mixed'], modifiedIn: ['docs', 'mixed'] };

const MODELS = {
  te3small: { label: 'text-embedding-3-small', dims: 1536 },
  te3large: { label: 'text-embedding-3-large', dims: 3072 },
  ada002: { label: 'text-embedding-ada-002', dims: 1536 },
};

const SOURCES = {
  docs: 'Documents (PDF, DOCX, legacy files)',
  images: 'Images (PNG, JPG)',
  media: 'Audio and video (MP3, MP4)',
  mixed: 'Mixed container (all of the above)',
};

function indexSchema(p) {
  const fields = [];
  if (p.keyField !== 'none') fields.push({ name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: false, retrievable: true });
  fields.push(
    { name: 'content', type: 'Edm.String', key: false, searchable: true, filterable: false, retrievable: true },
    { name: 'title', type: 'Edm.String', key: false, searchable: true, filterable: false, retrievable: true },
    { name: 'contentType', type: 'Edm.String', key: p.keyField === 'contentType', searchable: false, filterable: !!p.ctFilterable, retrievable: true },
    { name: 'sourcePath', type: 'Edm.String', key: false, searchable: false, filterable: false, retrievable: true },
    { name: 'lastModified', type: 'Edm.DateTimeOffset', key: false, searchable: false, filterable: true, retrievable: true },
    { name: 'contentVector', type: 'Collection(Edm.Single)', dimensions: Number(p.vectorDims), vectorSearchProfile: 'hnsw-profile', searchable: true, retrievable: false },
  );
  if (p.keyField === 'contentType') fields.find(f => f.name === 'contentType').key = true;
  return fields;
}

function ingest(p) {
  const steps = [];
  const files = FILES.filter(f => f.in.includes(p.source));
  const model = MODELS[p.embModel] || MODELS.te3small;
  const dims = Number(p.vectorDims);
  const maxFailed = p.maxFailed === 'unlimited' ? Infinity : 0;

  // 1. Source container
  steps.push(step('sources', 'Blob container listed', `${files.length} blobs in "${SOURCES[p.source]}".`,
    { container: 'kb-content', blobs: files.map(f => ({ name: f.path, contentType: f.mime })) }, 'info'));

  // 2. Data source connection
  if (p.auth === 'miNoRole') {
    steps.push(step('datasource', 'Data source cannot read the container', 'The search service authenticates with its managed identity, but that identity has no data-plane role on the storage account. Listing blobs returns 403 (AuthorizationPermissionMismatch).',
      { type: 'azureblob', credentials: { connectionString: 'ResourceId=/subscriptions/…/storageAccounts/stkb;' }, identity: 'system-assigned', roleAssignments: [], httpStatus: 403 }, 'error'));
    return finish(p, steps, [], files, { blocked: 'datasource' });
  }
  steps.push(step('datasource', 'Data source connected',
    p.auth === 'mi' ? 'Keyless: the search service managed identity holds Storage Blob Data Reader on the account.' : 'Connected with an account-key connection string. It works, but the secret lives in the data source definition; prefer a managed identity.',
    { type: 'azureblob', container: 'kb-content', auth: p.auth === 'mi' ? 'managed identity (ResourceId connection string)' : 'account key (secret)' }, p.auth === 'mi' ? 'ok' : 'warn'));

  // 3. Index schema
  const schema = indexSchema(p);
  if (p.keyField === 'none') {
    steps.push(step('index', 'Index creation rejected', 'An index must have exactly one key field of type Edm.String. The service rejects the definition (HTTP 400) and the indexer has nowhere to write.',
      { fields: schema.map(f => f.name), keyFields: 0, httpStatus: 400 }, 'error'));
    return finish(p, steps, schema, files, { blocked: 'index' });
  }
  steps.push(step('index', 'Index schema created', `${schema.length} fields. Key: ${p.keyField === 'path' ? 'id (from metadata_storage_path)' : 'contentType'}. Vector field contentVector: ${dims} dimensions, HNSW profile.`,
    { fields: schema.map(f => ({ name: f.name, key: !!f.key, filterable: !!f.filterable, dims: f.dimensions })) },
    p.keyField === 'contentType' ? 'warn' : 'ok'));

  // 4. Indexer: document cracking per blob
  const rows = [];
  const errors = [];
  const warnings = [];
  for (const f of files) {
    const row = { file: f, status: 'indexed', content: 0, note: '' };
    if (f.kind === 'unsupported') {
      if (p.skipUnsupported) { row.status = 'skipped'; row.note = 'Unsupported content type skipped (failOnUnsupportedContentType: false)'; }
      else { row.status = 'failed'; row.note = 'Unsupported content type'; errors.push({ key: f.path, errorMessage: `File '${f.ext}' has an unsupported content type.` }); }
    } else if (f.kind === 'doc') {
      row.content = f.chars; row.note = 'Text and metadata extracted';
    } else if (f.kind === 'image') {
      if (p.imageAction === 'generateNormalizedImages') { row.content = f.ocr.length + f.caption.length; row.note = `OCR: "${f.ocr}" • caption: "${f.caption}"`; }
      else { row.status = 'metadata only'; row.note = 'No normalized images, so OCR and image analysis skills have nothing to read'; warnings.push({ key: f.path, message: 'Image indexed with metadata only.' }); }
    } else { // audio / video
      if (p.media === 'cu') { row.content = f.transcriptChars; row.note = `Transcript + segment descriptions (${f.minutes} min) produced upstream by Content Understanding, indexed as text`; }
      else if (p.skipUnsupported) { row.status = 'metadata only'; row.note = 'Blob indexer does not transcribe media: only file metadata is searchable'; warnings.push({ key: f.path, message: 'Media indexed with metadata only.' }); }
      else { row.status = 'failed'; row.note = 'Media content cannot be cracked by the blob indexer'; errors.push({ key: f.path, errorMessage: `Content type '${f.mime}' is not supported for content extraction.` }); }
    }
    rows.push(row);
  }
  const failed = rows.filter(r => r.status === 'failed').length;
  const metaOnly = rows.filter(r => r.status === 'metadata only').length;
  steps.push(step('indexer', 'Document cracking', `${rows.length - failed - rows.filter(r => r.status === 'skipped').length} cracked, ${metaOnly} metadata only, ${failed} failed, ${rows.filter(r => r.status === 'skipped').length} skipped.`,
    { parameters: { configuration: { dataToExtract: 'contentAndMetadata', imageAction: p.imageAction, failOnUnsupportedContentType: !p.skipUnsupported }, maxFailedItems: p.maxFailed === 'unlimited' ? -1 : 0 }, errors, warnings },
    failed > maxFailed ? 'error' : failed || metaOnly ? 'warn' : 'ok'));
  if (failed > maxFailed) {
    steps.push(step('docs', 'Indexer run stopped', `${failed} item(s) failed and maxFailedItems is 0, so the run status is transientFailure and remaining batches are not committed.`, { status: 'transientFailure', itemsFailed: failed }, 'error'));
    return finish(p, steps, schema, files, { rows, errors, warnings, stopped: true });
  }

  // 5. Skillset: chunk + embed (vector dimension check)
  const toEmbed = rows.filter(r => r.content > 0);
  if (model.dims !== dims) {
    steps.push(step('skillset', 'Vector dimension mismatch', `${model.label} returns ${model.dims}-dimension vectors but contentVector is declared with ${dims}. Every document write fails ("vector dimensions do not match").`,
      { embeddingModel: model.label, modelDims: model.dims, fieldDims: dims, failedWrites: toEmbed.length }, 'error'));
    return finish(p, steps, schema, files, { rows, errors, warnings, dimsMismatch: true });
  }
  steps.push(step('skillset', 'Skills ran: split, OCR/image analysis, embeddings', `${toEmbed.length} documents with text embedded with ${model.label} (${model.dims} dims, matches the index).`,
    { skills: ['#Microsoft.Skills.Text.SplitSkill', p.imageAction === 'generateNormalizedImages' ? '#Microsoft.Skills.Vision.OcrSkill' : null, p.imageAction === 'generateNormalizedImages' ? '#Microsoft.Skills.Vision.ImageAnalysisSkill' : null, '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill'].filter(Boolean) }));

  // 6. Write documents (+ incremental run behaviour)
  let indexed = rows.filter(r => r.status === 'indexed' || r.status === 'metadata only');
  let collisions = 0;
  if (p.keyField === 'contentType') {
    const byKey = new Map();
    for (const r of indexed) byKey.set(r.file.mime, r);
    collisions = indexed.length - byKey.size;
  }
  let stale = 0;
  let reprocessed = [];
  if (p.run === 'incremental') {
    if (CHANGES.modifiedIn.includes(p.source)) reprocessed.push(CHANGES.modified);
    if (CHANGES.deletedIn.includes(p.source)) {
      const r = rows.find(x => x.file.path === CHANGES.deleted);
      if (p.deletion === 'nativeSoftDelete') { if (r) r.status = 'removed'; }
      else { stale = 1; if (r) { r.status = 'stale'; r.note = p.deletion === 'softDeleteColumn' ? 'Blob was deleted, not flagged with IsDeleted metadata: policy never fires' : 'Blob deleted but no deletion detection policy: document stays in the index'; } }
    }
    steps.push(step('docs', 'Incremental run', `Built-in blob change detection (last-modified high-water mark) reprocessed ${reprocessed.length} changed blob(s); unchanged blobs were skipped. ${stale ? 'The deleted blob is still searchable.' : CHANGES.deletedIn.includes(p.source) ? 'Deleted blob removed from the index.' : 'No deletions in this container.'}`,
      { reprocessed, deletionDetectionPolicy: p.deletion === 'none' ? null : p.deletion === 'nativeSoftDelete' ? '#Microsoft.Azure.Search.NativeBlobSoftDeleteDeletionDetectionPolicy' : '#Microsoft.Azure.Search.SoftDeleteColumnDeletionDetectionPolicy', staleDocuments: stale },
      stale ? 'warn' : 'ok'));
  }
  if (p.keyField === 'path' && !p.base64Key) {
    steps.push(step('docs', 'Documents rejected: invalid key', 'metadata_storage_path is a URL containing "/" and ":"; keys may only contain letters, digits, "_", "-" and "=". Without the base64Encode field-mapping function every write fails.',
      { fieldMappings: [{ sourceFieldName: 'metadata_storage_path', targetFieldName: 'id', mappingFunction: null }], failedWrites: indexed.length }, 'error'));
    return finish(p, steps, schema, files, { rows, errors, warnings, badKey: true });
  }
  indexed = rows.filter(r => r.status === 'indexed' || r.status === 'metadata only' || r.status === 'stale');
  const docCount = indexed.length - collisions;
  steps.push(step('docs', collisions ? 'Documents overwrote each other' : 'Documents written', collisions
    ? `Key = contentType is not unique: ${collisions} document(s) were overwritten by a later blob with the same content type. Index holds ${docCount} documents instead of ${indexed.length}.`
    : `${docCount} documents in the index (${toEmbed.length} with vectors).`,
    { documentCount: docCount, overwritten: collisions, sample: indexed.slice(0, 2).map(r => ({ id: p.keyField === 'path' ? 'aHR0cHM6Ly9zdGti…' : r.file.mime, contentType: r.file.mime, sourcePath: r.file.path })) },
    collisions ? 'warn' : 'ok'));

  // 7. Test query with a filter
  if (!p.ctFilterable) {
    steps.push(step('docs', 'Test filter query failed', "Query $filter=contentType eq 'video/mp4' returned HTTP 400: the field is not filterable. Changing an attribute like filterable on an existing field requires rebuilding the index.",
      { filter: "contentType eq 'video/mp4'", httpStatus: 400 }, 'error'));
  } else {
    const hit = indexed.filter(r => r.file.mime === 'video/mp4').length;
    steps.push(step('docs', 'Test filter query', `$filter=contentType eq 'video/mp4' → ${hit} result(s).`, { filter: "contentType eq 'video/mp4'", count: hit }, 'info'));
  }
  return finish(p, steps, schema, files, { rows, errors, warnings, docCount, toEmbed, stale, collisions });
}

function finish(p, steps, schema, files, ctx) {
  const output = [];
  const model = MODELS[p.embModel] || MODELS.te3small;
  if (ctx.rows) {
    output.push({ type: 'table', title: 'Blob → index document', columns: ['Blob', 'Kind', 'Result', 'Chars of text', 'Detail'],
      rows: ctx.rows.map(r => [r.file.path, r.file.kind, r.status, String(r.content), r.note]),
      tones: ctx.rows.map(r => r.status === 'indexed' || r.status === 'removed' ? 'ok' : r.status === 'skipped' ? 'info' : r.status === 'failed' ? 'error' : 'warn') });
  } else {
    output.push({ type: 'alert', tone: 'error', text: ctx.blocked === 'datasource' ? 'Nothing was ingested: the indexer cannot list blobs. Grant the search service identity Storage Blob Data Reader on the storage account (or container).' : 'Nothing was ingested: the index definition is invalid. Add a single Edm.String key field.' });
  }
  output.push({ type: 'json', title: 'Index definition (abridged, illustrative)', data: { name: 'kb-multimodal', fields: schema, vectorSearch: { algorithms: [{ name: 'hnsw-1', kind: 'hnsw' }], profiles: [{ name: 'hnsw-profile', algorithm: 'hnsw-1', vectorizer: 'aoai-vectorizer' }] } } });
  output.push({ type: 'json', title: 'Indexer definition (abridged, illustrative)', data: {
    name: 'kb-indexer', dataSourceName: 'kb-blob-ds', targetIndexName: 'kb-multimodal', skillsetName: 'kb-skillset', schedule: { interval: 'PT1H' },
    parameters: { maxFailedItems: p.maxFailed === 'unlimited' ? -1 : 0, configuration: { dataToExtract: 'contentAndMetadata', imageAction: p.imageAction, failOnUnsupportedContentType: !p.skipUnsupported } },
    fieldMappings: p.keyField === 'path' ? [{ sourceFieldName: 'metadata_storage_path', targetFieldName: 'id', mappingFunction: p.base64Key ? { name: 'base64Encode' } : null }] : [],
  } });
  if (ctx.errors && (ctx.errors.length || ctx.warnings.length)) output.push({ type: 'json', title: 'Indexer execution status (simulated shape)', data: { lastResult: { status: hasError({ steps }) ? 'transientFailure' : 'success', errors: ctx.errors, warnings: ctx.warnings } } });
  if (ctx.dimsMismatch) output.push({ type: 'alert', tone: 'error', text: `Make contentVector dimensions equal the embedding output (${model.dims} for ${model.label}). text-embedding-3 models can also be asked for fewer dimensions, but the request and the field must agree.` });
  if (ctx.stale) output.push({ type: 'alert', tone: 'warn', text: 'A deleted blob is still returned by search. Use a deletion detection policy that matches how your app deletes files (native soft delete requires blob soft delete enabled on the account).' });

  const rows = ctx.rows || [];
  const total = files.length;
  const withText = rows.filter(r => r.content > 0 && r.status !== 'removed').length;
  return {
    steps, output,
    metrics: [
      metric('Blobs with searchable content', `${withText}/${total}`, 'computed', 'Blobs whose text, OCR, caption or transcript reached the index.'),
      metric('Failed items', String(rows.filter(r => r.status === 'failed').length), 'computed'),
      metric('Stale documents', String(ctx.stale || 0), 'computed', 'Documents whose blob no longer exists.'),
      metric('Index documents', String(ctx.docCount ?? 0), 'computed'),
      metric('Relative enrichment cost', p.media === 'cu' && p.source !== 'docs' && p.source !== 'images' ? 'higher' : p.imageAction === 'generateNormalizedImages' ? 'medium' : 'lower', 'estimate', 'Media analysis and image skills are billed in addition to indexing. Check current pricing pages; no prices are reproduced here.'),
    ],
    summary: hasError({ steps }) ? `Failed at ${steps.at(-1).node}: ${steps.at(-1).title}` : `${SOURCES[p.source]}: ${withText}/${total} searchable, ${ctx.stale || 0} stale`,
  };
}

export default {
  id: '5.1.1',
  lab: 'Multimodal indexer console',
  services: [
    { name: 'Azure AI Search: indexers overview', url: 'https://learn.microsoft.com/en-us/azure/search/search-indexer-overview' },
    { name: 'Index data from Azure Blob Storage', url: 'https://learn.microsoft.com/en-us/azure/search/search-howto-indexing-azure-blob-storage' },
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
  ],
  prereqs: ['1.1.3'],
  next: ['5.1.3', '5.1.4', '1.3.3'],

  concept: {
    plain: 'Before an agent can search your company knowledge, every file has to be read, turned into text (and vectors), and stored as a document in a search index. PDFs and Word files have text inside. Images need OCR or a caption. Audio and video need a transcript. A scheduled "indexer" does this repeatedly, picking up new, changed and deleted files so the index stays in step with storage.',
    technical: 'In Azure AI Search, a data source (e.g. azureblob, authenticated with a managed identity) feeds an indexer that cracks documents (dataToExtract, imageAction, failOnUnsupportedContentType), optionally runs a skillset (OCR, image analysis, text split, Azure OpenAI embedding), and writes to an index whose schema declares one Edm.String key, field attributes (searchable, filterable, retrievable, facetable, sortable) and vector fields with fixed dimensions and a vector search profile. Blob indexers have built-in change detection; deletions need a deletion detection policy. Audio and video are usually analysed upstream (e.g. Content Understanding) and indexed as transcript text.',
    useCase: 'An HR team keeps policies (PDF/DOCX), scanned receipts and floor plans (images), and recorded town halls (MP3/MP4) in one storage account. An hourly indexer keeps a single multimodal index current so an employee agent can answer "where is the assembly point on floor 3?" or "what did the CFO say about travel budgets?".',
    terms: [
      ['Data source', 'Connection to the content store (type, container, credentials or managed identity).'],
      ['Indexer', 'Crawler that extracts content and metadata, applies field mappings and skills, and writes documents on a schedule.'],
      ['Document key', 'The single Edm.String field that uniquely identifies each search document; restricted character set.'],
      ['Vector field', 'Collection(Edm.Single) with fixed dimensions that must equal the embedding model output.'],
      ['Deletion detection policy', 'Tells the indexer how to recognise deleted source items (native blob soft delete or a soft-delete metadata column).'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'sources', label: p ? `Files: ${SOURCES[p.source]}` : 'Files', col: 0, row: 1, detail: 'Documents, images, audio and video. Each needs a different route to text.', substeps: ['PDF/DOCX → text', 'Images → OCR + caption', 'Audio/video → transcript'] },
          { id: 'datasource', label: 'Connect', col: 1, row: 1, detail: 'Where the files are and how the crawler is allowed to read them.' },
          { id: 'indexer', label: 'Crack & extract', col: 2, row: 1, detail: 'Opens each file, extracts text + metadata, generates normalized images.', substeps: ['List changed blobs', 'Extract text/metadata', 'Generate images'] },
          { id: 'skillset', label: 'Enrich & embed', col: 3, row: 0, detail: 'AI skills add OCR text, captions, chunks and vectors.', badge: p ? MODELS[p.embModel].label : undefined },
          { id: 'index', label: 'Index schema', col: 3, row: 2, detail: 'The shape of a search document: key, text fields, filterable fields, vector field.', badge: p ? `${p.vectorDims} dims` : undefined },
          { id: 'docs', label: 'Searchable documents', col: 4, row: 1, detail: 'Documents kept in sync on each run: new, changed, deleted.' },
        ],
        edges: [['sources', 'datasource'], ['datasource', 'indexer'], ['indexer', 'skillset'], ['skillset', 'docs'], ['index', 'docs', 'schema']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'sources', label: 'Azure Blob Storage (kb-content)', col: 0, row: 1, kind: 'store', detail: 'Container with mixed content. Enable blob soft delete if you use native soft-delete detection.' },
          { id: 'datasource', label: p && p.auth !== 'key' ? 'Data source (managed identity)' : 'Data source (account key)', col: 1, row: 1, kind: 'policy', detail: 'Keyless option: search service system- or user-assigned managed identity + Storage Blob Data Reader role on the account.', badge: p && p.auth === 'miNoRole' ? 'no role' : undefined },
          { id: 'cu', label: 'Content Understanding (media pre-processing)', col: 1, row: 3, kind: 'ai', disabled: p ? p.media !== 'cu' : false, detail: 'Optional upstream step: analyse audio/video into transcripts and segment descriptions, store as text next to the media, then index that text. Pattern is illustrative.' },
          { id: 'indexer', label: 'Azure AI Search indexer', col: 2, row: 1, kind: 'compute', detail: 'Runs on a schedule (e.g. PT1H). Built-in change detection for blobs via last-modified timestamps.' },
          { id: 'skillset', label: 'Skillset + Azure OpenAI embeddings', col: 3, row: 0, kind: 'ai', detail: 'OCR / Image Analysis skills, Text Split, Azure OpenAI Embedding skill calling a Foundry deployment (managed identity with Cognitive Services OpenAI User).' },
          { id: 'index', label: 'Search index kb-multimodal', col: 3, row: 2, kind: 'data', detail: 'Fields, vector profile (HNSW), vectorizer for query-time embedding.' },
          { id: 'docs', label: 'Agents / apps query the index', col: 4, row: 1, kind: 'app', detail: 'Consumers read with Search Index Data Reader.' },
        ],
        edges: [['sources', 'datasource'], ['sources', 'cu', 'media'], ['cu', 'sources', 'transcripts'], ['datasource', 'indexer'], ['indexer', 'skillset'], ['skillset', 'index'], ['index', 'docs']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'datasource', label: `SearchIndexerDataSourceConnection(type="azureblob", connection_string="ResourceId=…", container=…)`, col: 0, row: 0, kind: 'code', detail: 'azure-search-documents SearchIndexerClient.create_or_update_data_source_connection(). With managed identity the connection string is a ResourceId, no key. Illustrative.' },
          { id: 'index', label: `SearchField("contentVector", Collection(Single), vector_search_dimensions=${p ? p.vectorDims : 1536})`, col: 0, row: 1, kind: 'code', detail: 'SearchIndexClient.create_or_update_index(). One SimpleField(key=True). Dimensions must match the embedding model.' },
          { id: 'skillset', label: `AzureOpenAIEmbeddingSkill(deployment="${p ? MODELS[p.embModel].label : 'text-embedding-3-small'}")`, col: 0, row: 2, kind: 'code', detail: 'Part of SearchIndexerSkillset. Illustrative parameter names; check the SDK version.' },
          { id: 'indexer', label: `SearchIndexer(parameters={"configuration": {"imageAction": "${p ? p.imageAction : 'none'}", "failOnUnsupportedContentType": ${p ? !p.skipUnsupported : true}}})`, col: 0, row: 3, kind: 'code', detail: 'Also fieldMappings (base64Encode for blob path keys) and outputFieldMappings for enrichments.' },
          { id: 'docs', label: 'indexer_client.run_indexer("kb-indexer"); get_indexer_status(...)', col: 0, row: 4, kind: 'code', detail: 'Check last_result.errors / warnings after every run.' },
          { id: 'sources', label: 'Blob soft delete enabled on the storage account', col: 1, row: 0, kind: 'policy', detail: 'Required for NativeBlobSoftDeleteDeletionDetectionPolicy.' },
        ],
        edges: [['datasource', 'index'], ['index', 'skillset'], ['skillset', 'indexer'], ['indexer', 'docs'], ['sources', 'datasource']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'source', label: 'Content in the container', type: 'select', options: Object.entries(SOURCES), default: 'docs' },
      { id: 'auth', label: 'Data source authentication', type: 'select', options: [['mi', 'Managed identity + Storage Blob Data Reader'], ['miNoRole', 'Managed identity, no role assigned'], ['key', 'Account key connection string']], default: 'mi' },
      { id: 'keyField', label: 'Document key', type: 'select', options: [['path', 'id ← metadata_storage_path'], ['contentType', 'contentType (not unique)'], ['none', 'No key field']], default: 'path' },
      { id: 'base64Key', label: 'base64Encode mapping on the key', type: 'toggle', default: true, help: 'Blob paths contain characters not allowed in keys.' },
      { id: 'embModel', label: 'Embedding deployment', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, `${m.label} (${m.dims})`]), default: 'te3small' },
      { id: 'vectorDims', label: 'contentVector dimensions', type: 'select', options: [['768', '768'], ['1536', '1536'], ['3072', '3072']], default: '1536' },
      { id: 'imageAction', label: 'imageAction', type: 'select', options: [['none', 'none'], ['generateNormalizedImages', 'generateNormalizedImages']], default: 'none' },
      { id: 'media', label: 'Audio/video handling', type: 'select', options: [['none', 'Let the blob indexer handle it'], ['cu', 'Pre-process with Content Understanding']], default: 'none' },
      { id: 'skipUnsupported', label: 'Skip unsupported content types', type: 'toggle', default: true, help: 'failOnUnsupportedContentType: false' },
      { id: 'maxFailed', label: 'maxFailedItems', type: 'select', options: [['0', '0 (stop on first failure)'], ['unlimited', '-1 (no limit)']], default: '0' },
      { id: 'deletion', label: 'Deletion detection policy', type: 'select', options: [['none', 'None'], ['nativeSoftDelete', 'Native blob soft delete'], ['softDeleteColumn', 'Soft-delete metadata column (IsDeleted)']], default: 'none' },
      { id: 'run', label: 'Indexer run', type: 'select', options: [['initial', 'Initial run'], ['incremental', 'Next scheduled run (1 changed, 1 deleted blob)']], default: 'initial' },
      { id: 'ctFilterable', label: 'contentType is filterable', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Documents only, healthy', values: { source: 'docs', skipUnsupported: true } },
      { label: 'Images without normalized images', values: { source: 'images', imageAction: 'none' } },
      { label: 'Mixed container, fully configured', values: { source: 'mixed', imageAction: 'generateNormalizedImages', media: 'cu', skipUnsupported: true, deletion: 'nativeSoftDelete', run: 'incremental' } },
      { label: 'Switch to text-embedding-3-large', values: { source: 'docs', skipUnsupported: true, embModel: 'te3large' } },
    ],
    run: ingest,
  },

  compare: {
    suggestions: [
      'Run the mixed container with imageAction none, then generateNormalizedImages, and compare "Blobs with searchable content".',
      'Run the incremental run with deletion policy None, then Native blob soft delete, and watch the stale document disappear.',
      'Compare audio/video handled by the blob indexer vs pre-processed with Content Understanding.',
    ],
  },

  debug: [
    { id: 'rbac', title: 'Indexer cannot list the container', values: { auth: 'miNoRole' }, node: 'datasource',
      symptom: '403 when the indexer starts; zero documents processed.', cause: 'The search service managed identity has no data-plane role on the storage account. Owner/Contributor on the resource does not grant blob read.', fix: 'Assign Storage Blob Data Reader to the search service identity (Authentication → Managed identity + role).' },
    { id: 'dims', title: 'Every document fails after switching embedding model', values: { source: 'docs', skipUnsupported: true, embModel: 'te3large', vectorDims: '1536' }, node: 'skillset',
      symptom: 'Writes fail with a vector dimension error.', cause: 'text-embedding-3-large returns 3072 dimensions; the field was created for 1536.', fix: 'Use a model whose output matches the field (text-embedding-3-small), or create a new index/field with 3072 dimensions and re-index.' },
    { id: 'nokey', title: 'Index creation rejected', values: { keyField: 'none' }, node: 'index',
      symptom: 'HTTP 400 creating the index.', cause: 'No Edm.String key field.', fix: 'Add exactly one key field (id ← metadata_storage_path with base64Encode).' },
    { id: 'b64', title: 'Invalid document key', values: { source: 'docs', skipUnsupported: true, base64Key: false }, node: 'docs',
      symptom: 'All writes fail: key contains invalid characters.', cause: 'The blob URL contains "/" and ":".', fix: 'Turn on the base64Encode mapping function for the key field mapping.' },
    { id: 'unsupported', title: 'Run stops on a legacy file', values: { source: 'docs', skipUnsupported: false, maxFailed: '0' }, node: 'indexer',
      symptom: 'Status transientFailure; one .wpd file reported as unsupported.', cause: 'Unsupported content type with failOnUnsupportedContentType true and maxFailedItems 0.', fix: 'Skip unsupported content types (or exclude the extension), or tolerate failures with maxFailedItems.' },
    { id: 'media', title: 'Town hall recording is not searchable', values: { source: 'media', skipUnsupported: true, media: 'none' }, node: 'indexer',
      symptom: 'Only file names and dates are searchable for MP3/MP4.', cause: 'The blob indexer does not transcribe audio or describe video.', fix: 'Pre-process media with Content Understanding and index the transcript text.' },
    { id: 'stale', title: 'Deleted receipt still appears in answers', values: { source: 'images', imageAction: 'generateNormalizedImages', run: 'incremental', deletion: 'softDeleteColumn' }, node: 'docs',
      symptom: 'Incremental run reports success but the deleted blob is still in the index.', cause: 'Soft-delete column policy expects an IsDeleted metadata flag; the app hard-deleted the blob.', fix: 'Use native blob soft delete detection (with soft delete enabled on the account), or change the app to set the metadata flag.' },
    { id: 'filter', title: 'Filter on contentType fails', values: { source: 'docs', skipUnsupported: true, ctFilterable: false }, node: 'docs',
      symptom: 'HTTP 400: field is not filterable.', cause: 'Attribute not set at index creation.', fix: 'Mark contentType filterable (requires an index rebuild for existing fields).' },
  ],

  challenge: {
    task: 'Run the next scheduled indexer pass on the mixed container so every supported file is searchable by its content, unsupported files do not stop the run, and the deleted blob is gone.',
    condition: 'Source = Mixed, run = incremental, no warn or error steps, 0 stale documents.',
    hint: 'Images need normalized images, media needs a transcript route, and the deletion policy must match how the app deletes blobs.',
    check: (p, res) => p.source === 'mixed' && p.run === 'incremental' && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Source: Mixed container. Run: next scheduled run.', 'Authentication: managed identity + Storage Blob Data Reader.', 'Key: id ← metadata_storage_path with base64Encode.', 'Embedding model and vector dimensions must agree (e.g. text-embedding-3-small + 1536).', 'imageAction: generateNormalizedImages so OCR and captions run on images.', 'Audio/video: pre-process with Content Understanding.', 'Skip unsupported content types for the .wpd file.', 'Deletion detection: Native blob soft delete.'],
    solutionValues: { source: 'mixed', run: 'incremental', auth: 'mi', keyField: 'path', base64Key: true, embModel: 'te3small', vectorDims: '1536', imageAction: 'generateNormalizedImages', media: 'cu', skipUnsupported: true, deletion: 'nativeSoftDelete', ctFilterable: true, maxFailed: '0' },
  },

  quiz: [
    { q: 'Your indexer uses the search service system-assigned managed identity. It fails with 403 when listing blobs, although the identity is Contributor on the storage account. What fixes it?', options: ['Regenerate the storage account key', 'Assign Storage Blob Data Reader to the search service identity', 'Assign Search Index Data Contributor to the storage account', 'Enable public network access on the search service'], answer: 1, why: 'Contributor is a control-plane role. Reading blob data needs a data-plane role such as Storage Blob Data Reader.' },
    { q: 'You switch the embedding skill from text-embedding-3-small to text-embedding-3-large and every document now fails. What is the most likely cause?', options: ['The new model needs a different index name', 'The vector field dimensions no longer match the model output', 'Large models cannot be called from a skillset', 'The key field must be re-encoded'], answer: 1, why: 'Vector fields have fixed dimensions. 3-large returns 3072 by default; a 1536-dimension field rejects them. Create a matching field and re-index.' },
    { q: 'Users can still find a receipt that was deleted from Blob Storage yesterday. Change detection works for edits. What is missing?', options: ['A schedule on the indexer', 'A deletion detection policy that matches how blobs are deleted', 'A semantic configuration', 'A larger maxFailedItems'], answer: 1, why: 'Blob change detection is built in, but deletions are only removed when a deletion detection policy (native soft delete or soft-delete column) is configured and actually triggered.' },
    { q: 'You need recorded town halls (MP4) to be answerable by an agent. What is a sound ingestion approach?', options: ['Point the blob indexer at the MP4s with imageAction set', 'Analyse the media with Content Understanding (transcript, segments) and index the resulting text', 'Store MP4s in a vector field', 'Raise maxFailedItems so MP4s are skipped'], answer: 1, why: 'The blob indexer does not transcribe audio/video. Produce text (transcript and descriptions) upstream and index that.' },
  ],

  recap: 'Ingestion = data source (keyless with a data-plane role) → indexer (cracking, imageAction, unsupported handling, change and deletion detection) → skillset (OCR, captions, embeddings) → index (one valid key, correct attributes, vector dimensions that match the model). Media needs an upstream route to text. Always read indexer errors and warnings after each run.',
};
