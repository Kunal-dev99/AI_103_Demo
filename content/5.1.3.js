// 5.1.3 Implement enrichment by using custom or built-in skills for text, images, and layout
// Lab: Skillset designer.
import { step, metric, hasError, hasWarn } from '../src/engine/util.js';

// Sample source documents. `content` = text the indexer cracks from the file's text layer.
// `images` = embedded images / scanned pages that only OCR (or the layout skill) can read.
// `entities` = toy entity dictionary the simulated recogniser can find; `en: false` marks names
// it misses when it runs with the wrong language code.
const DOCS = {
  scannedContract: {
    label: 'Contract PDF (page 2 is a scanned signature page)', lang: 'en', ext: 'pdf',
    content: 'Master Services Agreement between Contoso Ltd and the Supplier. Term: 24 months. Either party may terminate with 90 days written notice.',
    images: [{ ocr: 'Signed for and on behalf of Fabrikam Inc, Seattle. Liability is capped at twice the annual fees.', tags: ['text', 'signature', 'document'], caption: 'A signed signature block on a contract page' }],
    layoutSections: [['Master Services Agreement', 'Between Contoso Ltd and the Supplier. Term: 24 months. Either party may terminate with 90 days written notice.'], ['Signatures', 'Signed for and on behalf of Fabrikam Inc, Seattle. Liability is capped at twice the annual fees.']],
    entities: [['Contoso Ltd', 'Organization', true], ['Fabrikam Inc', 'Organization', true], ['Seattle', 'Location', true]],
    keyPhrases: ['Master Services Agreement', 'written notice', 'annual fees', 'signature block'],
  },
  productSheet: {
    label: 'Product sheet DOCX (embedded product photo)', lang: 'en', ext: 'docx',
    content: 'Contoso X200 router. Eight gigabit ports. Warranty: 3 years, provided by Contoso Ltd, Dublin. Warranty claims go to the reseller.',
    images: [{ ocr: 'MODEL X200  Made in Ireland', tags: ['router', 'electronics', 'indoor'], caption: 'A black network router on a white background' }],
    layoutSections: [['Contoso X200 router', 'Eight gigabit ports.'], ['Warranty', '3 years, provided by Contoso Ltd, Dublin. Warranty claims go to the reseller.']],
    entities: [['Contoso Ltd', 'Organization', true], ['Dublin', 'Location', true], ['Ireland', 'Location', true]],
    keyPhrases: ['X200 router', 'gigabit ports', 'warranty claims'],
  },
  frenchContract: {
    label: 'French service contract (text PDF)', lang: 'fr', ext: 'pdf',
    content: 'Contrat de service entre Contoso SA et Litware, Paris. Résiliation possible avec un préavis de 60 jours. Responsabilité limitée au montant annuel.',
    images: [],
    layoutSections: [['Contrat de service', 'Entre Contoso SA et Litware, Paris.'], ['Résiliation', 'Possible avec un préavis de 60 jours. Responsabilité limitée au montant annuel.']],
    entities: [['Contoso SA', 'Organization', false], ['Litware', 'Organization', true], ['Paris', 'Location', false]],
    keyPhrases: ['contrat de service', 'préavis', 'montant annuel'],
  },
};

// Toy custom skill: clause classifier hosted in an Azure Function (illustrative).
const CLAUSES = [['termination', /terminat|résiliation/i], ['liability', /liabilit|responsabilit/i], ['warranty', /warrant/i]];

function enrich(p) {
  const doc = DOCS[p.document] || DOCS.scannedContract;
  const steps = [];
  const tree = { content: doc.content };
  const issues = [];
  const normImgs = p.imageAction === 'generateNormalizedImages' ? doc.images : [];

  // 1. Document cracking
  steps.push(step('cracking', 'Document cracked', `/document/content has ${doc.content.length} characters from the text layer. ${doc.images.length} embedded image(s) or scanned page(s); ${normImgs.length} normalized image(s) generated (imageAction=${p.imageAction}).`,
    { '/document/content': doc.content.slice(0, 80) + '…', '/document/normalized_images': normImgs.length, imageAction: p.imageAction, allowSkillsetToReadFileData: !!p.fileData }, 'info'));

  // 2. Text from images / layout
  let text = doc.content;
  if (p.textPath === 'layout') {
    if (!p.fileData) {
      steps.push(step('ocr', 'Document Layout skill: missing input', '#Microsoft.Skills.Util.DocumentIntelligenceLayoutSkill reads /document/file_data, which only exists when the indexer sets allowSkillsetToReadFileData: true. The skill gets no input and the document fails.',
        { skill: '#Microsoft.Skills.Util.DocumentIntelligenceLayoutSkill', context: '/document', input: { name: 'file_data', source: '/document/file_data', present: false } }, 'error'));
      return finish(p, doc, steps, tree, issues);
    }
    tree.markdownDocument = doc.layoutSections.map(([h, c]) => ({ h1: h, content: c }));
    text = doc.layoutSections.map(([h, c]) => `# ${h}\n${c}`).join('\n');
    steps.push(step('ocr', 'Document Layout skill: markdown sections', `Layout ran its own OCR over every page (including scanned ones) and returned ${doc.layoutSections.length} markdown section(s) at /document/markdownDocument/*.`,
      { skill: '#Microsoft.Skills.Util.DocumentIntelligenceLayoutSkill', outputMode: 'oneToMany', markdownHeaderDepth: 'h3', sections: tree.markdownDocument }));
    steps.push(step('merge', 'Merge not needed', 'Layout output already contains text from scanned pages.', null, 'skip'));
  } else if (p.textPath === 'ocrMerge') {
    if (!doc.images.length) {
      steps.push(step('ocr', 'OCR: nothing to read', 'This document has no images; OCR adds nothing (and costs nothing).', null, 'skip'));
      steps.push(step('merge', 'Merge: content only', '/document/merged_content = /document/content.', null, 'skip'));
    } else if (!normImgs.length) {
      steps.push(step('ocr', 'OCR skill skipped: input not found', 'The OCR skill reads /document/normalized_images/*, but imageAction is none so that path does not exist. The indexer logs a warning and the scanned text never enters the pipeline.',
        { skill: '#Microsoft.Skills.Vision.OcrSkill', context: p.ocrContext, inputs: [{ name: 'image', source: '/document/normalized_images/*' }], warning: 'Skill input "image" was not found' }, 'warn'));
      issues.push('OCR had no normalized images');
      steps.push(step('merge', 'Merge: content only', 'No OCR text to insert.', null, 'warn'));
    } else if (p.ocrContext === '/document') {
      tree.text = '(one value at /document/text; per-image outputs lost)';
      steps.push(step('ocr', 'OCR skill: wrong context', 'Context /document runs the skill once per document, but the input /document/normalized_images/* is a collection. In this simulation the skill reports an invalid input and writes nothing usable; the Merge skill finds no /document/normalized_images/*/text.',
        { skill: '#Microsoft.Skills.Vision.OcrSkill', context: '/document', expectedContext: '/document/normalized_images/*', warning: 'Could not execute skill because one or more skill input was invalid.' }, 'warn'));
      issues.push('OCR context wrong');
      steps.push(step('merge', 'Merge: OCR text missing', '/document/merged_content contains only the text layer.', { itemsToInsert: [] }, 'warn'));
    } else {
      tree.normalized_images = normImgs.map(i => ({ text: i.ocr }));
      text = doc.content + ' ' + normImgs.map(i => i.ocr).join(' ');
      tree.merged_content = text;
      steps.push(step('ocr', 'OCR skill per image', `Context /document/normalized_images/*: ${normImgs.length} image(s) → /document/normalized_images/*/text.`,
        { skill: '#Microsoft.Skills.Vision.OcrSkill', context: '/document/normalized_images/*', outputs: normImgs.map((i, n) => ({ [`/document/normalized_images/${n}/text`]: i.ocr })) }));
      steps.push(step('merge', 'Merge skill', 'Inserted OCR text at each image offset → /document/merged_content.',
        { skill: '#Microsoft.Skills.Text.MergeSkill', inputs: ['/document/content', '/document/normalized_images/*/text', '/document/normalized_images/*/contentOffset'], output: '/document/merged_content' }));
    }
  } else {
    steps.push(step('ocr', 'No OCR or layout skill', doc.images.length ? 'Only the text layer is enriched. Anything printed in images or scanned pages is invisible to search.' : 'Text layer only; this document has no images.', null, doc.images.length ? 'warn' : 'skip'));
    if (doc.images.length) issues.push('Scanned/embedded text ignored');
    steps.push(step('merge', 'Merge not used', 'Downstream skills read /document/content.', null, 'skip'));
  }

  // 3. Language detection
  let langCode = 'en';
  if (p.langDetect) {
    langCode = doc.lang;
    tree.language = langCode;
    steps.push(step('lang', 'Language detection', `/document/language = "${langCode}", passed as languageCode to the text skills.`, { skill: '#Microsoft.Skills.Text.LanguageDetectionSkill', output: langCode }));
  } else {
    steps.push(step('lang', 'Language detection off', `Text skills use defaultLanguageCode "en".${doc.lang !== 'en' ? ' This document is French, so entity recognition is unreliable.' : ''}`, null, doc.lang !== 'en' && p.entities ? 'warn' : 'skip'));
    if (doc.lang !== 'en' && p.entities) issues.push('Wrong language code');
  }

  // 4. Entity recognition + key phrases
  const found = doc.entities.filter(([name, , okEn]) => text.includes(name) && (langCode === doc.lang || okEn));
  if (p.entities) {
    tree.organizations = found.filter(e => e[1] === 'Organization').map(e => e[0]);
    tree.locations = found.filter(e => e[1] === 'Location').map(e => e[0]);
    const missed = doc.entities.filter(e => !found.includes(e)).map(e => e[0]);
    steps.push(step('nlp', 'Entity recognition (V3)', `Organizations: ${tree.organizations.join(', ') || 'none'}. Locations: ${tree.locations.join(', ') || 'none'}.${missed.length ? ` Missed: ${missed.join(', ')}.` : ''}`,
      { skill: '#Microsoft.Skills.Text.V3.EntityRecognitionSkill', context: '/document', input: p.textPath === 'layout' ? '/document/markdownDocument/*/content' : p.textPath === 'ocrMerge' ? '/document/merged_content' : '/document/content', languageCode: langCode, categories: ['Organization', 'Location'] },
      missed.length ? 'warn' : 'ok'));
  } else steps.push(step('nlp', 'Entity recognition off', 'No organizations/locations enrichment.', null, 'skip'));
  if (p.keyPhrases) {
    tree.keyPhrases = doc.keyPhrases.filter(k => text.toLowerCase().includes(k.toLowerCase().split(' ')[0]));
    steps.push(step('nlp', 'Key phrase extraction', `${tree.keyPhrases.length} key phrase(s).`, { skill: '#Microsoft.Skills.Text.KeyPhraseExtractionSkill', output: tree.keyPhrases }));
  }

  // 5. Image analysis
  if (p.imageAnalysis) {
    if (!normImgs.length) {
      steps.push(step('image', 'Image analysis: no images', doc.images.length ? 'Needs normalized images (imageAction generateNormalizedImages).' : 'Document has no images.', null, doc.images.length ? 'warn' : 'skip'));
      if (doc.images.length) issues.push('Image analysis had no images');
    } else {
      tree.imageTags = [...new Set(normImgs.flatMap(i => i.tags))];
      tree.imageCaption = normImgs.map(i => i.caption);
      steps.push(step('image', 'Image analysis', `Tags: ${tree.imageTags.join(', ')}. Caption: "${tree.imageCaption[0]}".`, { skill: '#Microsoft.Skills.Vision.ImageAnalysisSkill', context: '/document/normalized_images/*', visualFeatures: ['tags', 'description'] }));
    }
  }

  // 6. Custom Web API skill
  if (p.custom !== 'off') {
    const latency = p.custom === 'slow' ? 60 : 2;
    const timeoutS = p.timeout === 'PT90S' ? 90 : 30;
    const request = { values: [{ recordId: '0', data: { text: text.slice(0, 60) + '…', language: langCode } }] };
    if (p.custom === 'malformed') {
      steps.push(step('custom', 'Custom skill returned an invalid response', 'The Azure Function answered HTTP 200 with {"result": {...}} instead of {"values": [{"recordId": "0", "data": {...}}]}. The indexer cannot match the record and fails the document.',
        { request, response: { result: { clauses: ['termination'] } }, expected: { values: [{ recordId: '0', data: { clauseTypes: ['…'] }, errors: [], warnings: [] }] } }, 'error'));
      return finish(p, doc, steps, tree, issues);
    }
    if (latency > timeoutS) {
      steps.push(step('custom', 'Custom skill timed out', `The function took ~${latency}s (simulated) but the skill timeout is ${p.timeout}. The indexer records "Could not execute skill because the Web Api request failed" for this document.`,
        { request, timeout: p.timeout, simulatedLatencySeconds: latency }, 'error'));
      return finish(p, doc, steps, tree, issues);
    }
    tree.clauseTypes = CLAUSES.filter(([, re]) => re.test(text)).map(([c]) => c);
    steps.push(step('custom', 'Custom Web API skill (clause classifier)', `clauseTypes = [${tree.clauseTypes.join(', ')}] in ~${latency}s (simulated).`,
      { skill: '#Microsoft.Skills.Custom.WebApiSkill', uri: 'https://func-clauses.azurewebsites.net/api/classify', timeout: p.timeout, batchSize: 1, request, response: { values: [{ recordId: '0', data: { clauseTypes: tree.clauseTypes }, errors: [], warnings: [] }] } }));
  } else steps.push(step('custom', 'No custom skill', 'Built-in skills only.', null, 'skip'));

  // 7. Embeddings
  if (p.embed) {
    const pages = Math.max(1, Math.ceil(text.length / 120));
    tree.pages = Array.from({ length: pages }, (_, i) => ({ vector: `[1536 floats] (page ${i})` }));
    steps.push(step('embed', 'Split + Azure OpenAI embedding', `Text Split produced ${pages} page(s) (toy 120-char pages); each got a vector at /document/pages/*/vector.`,
      { skills: ['#Microsoft.Skills.Text.SplitSkill', '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill'], context: '/document/pages/*' }));
  } else steps.push(step('embed', 'No embeddings', 'Index supports keyword search only.', null, 'skip'));

  // 8. Output field mappings
  const enriched = ['organizations', 'locations', 'keyPhrases', 'imageTags', 'clauseTypes'].filter(k => tree[k]);
  if (!p.mapOutputs && enriched.length) {
    steps.push(step('mapping', 'Enrichments not mapped to the index', `${enriched.join(', ')} exist in the enrichment tree but there are no outputFieldMappings, so they are discarded when the document is written.`, { outputFieldMappings: [] }, 'warn'));
    issues.push('Outputs not mapped');
  } else {
    steps.push(step('mapping', 'Output field mappings', enriched.length ? `Mapped ${enriched.length} enrichment(s) to index fields.` : 'Nothing to map.',
      { outputFieldMappings: enriched.map(k => ({ sourceFieldName: k === 'imageTags' ? '/document/normalized_images/*/tags/*/name' : `/document/${k}`, targetFieldName: k })) }));
  }
  return finish(p, doc, steps, tree, issues);
}

function treeText(tree) {
  const lines = ['/document'];
  for (const [k, v] of Object.entries(tree)) {
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object') { lines.push(`  /${k}/*`); v.forEach((o, i) => Object.entries(o).forEach(([kk, vv]) => lines.push(`    /${k}/${i}/${kk}: ${String(vv).slice(0, 70)}`))); }
      else lines.push(`  /${k}: [${v.join(', ')}]`);
    } else lines.push(`  /${k}: ${String(v).slice(0, 80)}${String(v).length > 80 ? '…' : ''}`);
  }
  return lines.join('\n');
}

function finish(p, doc, steps, tree, issues) {
  const failed = hasError({ steps });
  const mapped = p.mapOutputs && !failed;
  const indexDoc = failed ? null : {
    id: 'aHR0cHM6…', content: (tree.merged_content || doc.content).slice(0, 60) + '…',
    ...(mapped ? Object.fromEntries(['organizations', 'locations', 'keyPhrases', 'imageTags', 'clauseTypes'].filter(k => tree[k]).map(k => [k, tree[k]])) : {}),
  };
  const output = [
    { type: 'code', title: 'Enrichment tree after the skillset ran', lang: 'text', text: treeText(tree) },
    failed ? { type: 'alert', tone: 'error', text: 'The document failed in the skillset. With maxFailedItems 0 the indexer run stops; nothing for this document reaches the index.' }
      : { type: 'json', title: 'Search document written to the index', data: indexDoc },
    { type: 'json', title: 'Skillset definition (abridged, illustrative)', data: {
      name: 'contracts-skillset',
      skills: [
        p.textPath === 'ocrMerge' && { '@odata.type': '#Microsoft.Skills.Vision.OcrSkill', context: p.ocrContext, inputs: [{ name: 'image', source: '/document/normalized_images/*' }], outputs: [{ name: 'text', targetName: 'text' }] },
        p.textPath === 'ocrMerge' && { '@odata.type': '#Microsoft.Skills.Text.MergeSkill', context: '/document', inputs: [{ name: 'text', source: '/document/content' }, { name: 'itemsToInsert', source: '/document/normalized_images/*/text' }, { name: 'offsets', source: '/document/normalized_images/*/contentOffset' }], outputs: [{ name: 'mergedText', targetName: 'merged_content' }] },
        p.textPath === 'layout' && { '@odata.type': '#Microsoft.Skills.Util.DocumentIntelligenceLayoutSkill', context: '/document', outputMode: 'oneToMany', inputs: [{ name: 'file_data', source: '/document/file_data' }], outputs: [{ name: 'markdown_document', targetName: 'markdownDocument' }] },
        p.langDetect && { '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill', outputs: [{ name: 'languageCode', targetName: 'language' }] },
        p.entities && { '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill', categories: ['Organization', 'Location'], outputs: [{ name: 'organizations' }, { name: 'locations' }] },
        p.keyPhrases && { '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill', outputs: [{ name: 'keyPhrases' }] },
        p.imageAnalysis && { '@odata.type': '#Microsoft.Skills.Vision.ImageAnalysisSkill', context: '/document/normalized_images/*', visualFeatures: ['tags', 'description'] },
        p.custom !== 'off' && { '@odata.type': '#Microsoft.Skills.Custom.WebApiSkill', uri: 'https://func-clauses.azurewebsites.net/api/classify', timeout: p.timeout, outputs: [{ name: 'clauseTypes' }] },
        p.embed && { '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill', context: '/document/pages/*', deploymentId: 'text-embedding-3-small' },
      ].filter(Boolean),
      cognitiveServices: { '@odata.type': '#Microsoft.Azure.Search.AIServicesByIdentity (illustrative)', subdomainUrl: 'https://<foundry-resource>.cognitiveservices.azure.com' },
    } },
  ];
  if (issues.length && !failed) output.push({ type: 'alert', tone: 'warn', text: `Enrichment gaps: ${issues.join('; ')}.` });
  const orgs = indexDoc && indexDoc.organizations ? indexDoc.organizations.join(', ') : 'none';
  const skillsRun = steps.filter(s => s.status === 'ok').length;
  return {
    steps, output,
    metrics: [
      metric('Organizations in index', orgs, 'computed'),
      metric('Clause types in index', indexDoc && indexDoc.clauseTypes ? indexDoc.clauseTypes.join(', ') || 'none' : 'none', 'computed'),
      metric('Skills that produced output', String(skillsRun), 'computed'),
      metric('Text characters enriched', String((tree.merged_content || (tree.markdownDocument ? tree.markdownDocument.map(s => s.content).join(' ') : doc.content)).length), 'computed', 'Characters the text skills actually saw.'),
      metric('Relative enrichment cost', p.textPath === 'layout' ? 'higher (layout per page)' : p.textPath === 'ocrMerge' || p.imageAnalysis ? 'medium (per-image skills)' : 'lower', 'estimate', 'Built-in AI skills are billed through the attached Foundry resource beyond a small free allowance; custom skills cost whatever your function costs. Check current pricing.'),
    ],
    summary: failed ? `Failed: ${steps.at(-1).title}` : `${doc.label.split(' (')[0]}: orgs ${orgs}${hasWarn({ steps }) ? ' (warnings)' : ''}`,
  };
}

export default {
  id: '5.1.3',
  lab: 'Skillset designer',
  services: [
    { name: 'AI enrichment in Azure AI Search', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-concept-intro' },
    { name: 'Built-in skills reference', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-predefined-skills' },
    { name: 'Custom Web API skill', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-custom-skill-web-api' },
    { name: 'Document Layout skill', url: 'https://learn.microsoft.com/en-us/azure/search/cognitive-search-skill-document-intelligence-layout' },
  ],
  prereqs: ['5.1.1'],
  next: ['5.1.4', '5.2.1'],

  concept: {
    plain: 'Raw files often hide the most useful information: a company name only appears on a scanned signature page, a model number only on a product photo. Enrichment adds AI steps during indexing that read images, detect language, pull out names and phrases, or call your own code, and then save those results as extra searchable fields.',
    technical: 'A skillset attached to an Azure AI Search indexer runs built-in skills (OcrSkill, ImageAnalysisSkill, MergeSkill, LanguageDetectionSkill, V3.EntityRecognitionSkill, KeyPhraseExtractionSkill, SplitSkill, AzureOpenAIEmbeddingSkill, DocumentIntelligenceLayoutSkill) and custom skills (WebApiSkill, or an Azure ML/Foundry model skill). Each skill has a context (the node it runs once per, e.g. /document or /document/normalized_images/*), inputs and outputs that read and write nodes in the enrichment tree. outputFieldMappings (or index projections) copy enriched nodes into index fields. Billable built-in skills use an attached Foundry resource.',
    useCase: 'A legal team indexes supplier contracts where the counterparty and liability terms are often on scanned signature pages. OCR + Merge put that text in the pipeline, entity recognition fills an organizations facet, and a custom clause-classifier function tags each contract so lawyers can filter "liability clauses with Fabrikam".',
    terms: [
      ['Enrichment tree', 'In-memory document structure (/document/...) that skills read from and write to during indexing.'],
      ['Context', 'The node a skill runs for; /document/normalized_images/* runs once per image.'],
      ['Normalized images', 'Images extracted by the indexer when imageAction = generateNormalizedImages; inputs for OCR and image analysis.'],
      ['Output field mapping', 'Copies an enrichment node into an index field; unmapped enrichments are discarded.'],
      ['WebApiSkill', 'Calls your HTTPS endpoint with {values:[{recordId,data}]} and expects the same shape back.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'cracking', label: 'Crack document', col: 0, row: 1, detail: '/document/content from the text layer; /document/normalized_images/* from images if requested.', badge: p ? p.imageAction : undefined },
          { id: 'ocr', label: p && p.textPath === 'layout' ? 'Document Layout skill' : 'OCR skill', col: 1, row: 0, disabled: p ? p.textPath === 'content' : false, detail: 'Reads text from images (OCR) or full layout as markdown sections (Layout skill).', substeps: ['Per image (OCR) or per document (Layout)', 'Writes text / markdown nodes'] },
          { id: 'merge', label: 'Merge skill', col: 2, row: 0, disabled: p ? p.textPath !== 'ocrMerge' : false, detail: 'Inserts OCR text back into the content at each image offset → merged_content.' },
          { id: 'image', label: 'Image analysis', col: 1, row: 2, disabled: p ? !p.imageAnalysis : false, detail: 'Tags and captions per normalized image.' },
          { id: 'lang', label: 'Language detection', col: 2, row: 1, disabled: p ? !p.langDetect : false, detail: 'Feeds languageCode to text skills.' },
          { id: 'nlp', label: 'Entities + key phrases', col: 3, row: 0, detail: 'Organizations, locations, key phrases from the merged text.' },
          { id: 'custom', label: 'Custom Web API skill', col: 3, row: 1, disabled: p ? p.custom === 'off' : false, detail: 'Your code: e.g. a clause classifier in an Azure Function.' },
          { id: 'embed', label: 'Split + embed', col: 3, row: 2, disabled: p ? !p.embed : false, detail: 'Chunks and vectors for vector search.' },
          { id: 'mapping', label: 'Output field mappings → index', col: 4, row: 1, detail: 'Only mapped enrichments survive.' },
        ],
        edges: [['cracking', 'ocr'], ['ocr', 'merge'], ['cracking', 'image'], ['merge', 'lang'], ['lang', 'nlp'], ['merge', 'custom'], ['merge', 'embed'], ['nlp', 'mapping'], ['custom', 'mapping'], ['image', 'mapping'], ['embed', 'mapping']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'cracking', label: 'Blob Storage → AI Search indexer', col: 0, row: 1, kind: 'store', detail: 'Indexer cracks files; parameters.configuration controls imageAction and allowSkillsetToReadFileData.' },
          { id: 'ocr', label: 'Foundry resource (Vision / Document Intelligence skills)', col: 1, row: 0, kind: 'ai', detail: 'Built-in OCR, Image Analysis, Layout and Language skills are billed through the Foundry resource attached to the skillset (key or managed identity).' },
          { id: 'nlp', label: 'Language skills (same Foundry resource)', col: 2, row: 0, kind: 'ai', detail: 'Entity recognition, key phrases, language detection.' },
          { id: 'custom', label: 'Azure Function (custom skill)', col: 2, row: 2, kind: 'compute', disabled: p ? p.custom === 'off' : false, detail: 'HTTPS endpoint; can be secured with Entra ID authentication using the search service identity (authResourceId). Respect the timeout and batch size.', badge: p && p.custom !== 'off' ? p.timeout : undefined },
          { id: 'embed', label: 'Azure OpenAI embedding deployment', col: 3, row: 2, kind: 'ai', disabled: p ? !p.embed : false, detail: 'Search service identity needs Cognitive Services OpenAI User.' },
          { id: 'mapping', label: 'Search index (contracts)', col: 4, row: 1, kind: 'data', detail: 'organizations, locations, keyPhrases, imageTags, clauseTypes fields (filterable/facetable collections).' },
        ],
        edges: [['cracking', 'ocr'], ['ocr', 'nlp'], ['cracking', 'custom'], ['nlp', 'mapping'], ['custom', 'mapping'], ['cracking', 'embed'], ['embed', 'mapping']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'cracking', label: `indexer.parameters.configuration = {"imageAction": "${p ? p.imageAction : 'none'}", "allowSkillsetToReadFileData": ${p ? !!p.fileData : false}}`, col: 0, row: 0, kind: 'code', detail: 'Set on the indexer, not the skillset.' },
          { id: 'ocr', label: p && p.textPath === 'layout' ? 'DocumentIntelligenceLayoutSkill(inputs=[file_data], output_mode="oneToMany")' : `OcrSkill(context="${p ? p.ocrContext : '/document/normalized_images/*'}", inputs=[image ← /document/normalized_images/*])`, col: 0, row: 1, kind: 'code', detail: 'azure-search-documents skill classes; names illustrative of the REST @odata.type values.' },
          { id: 'merge', label: 'MergeSkill(inputs=[text ← content, itemsToInsert ← normalized_images/*/text, offsets ← …/contentOffset])', col: 0, row: 2, kind: 'code', detail: 'Produces merged_content.' },
          { id: 'nlp', label: 'EntityRecognitionSkill(inputs=[text ← merged_content, languageCode ← language])', col: 0, row: 3, kind: 'code', detail: 'V3 entity recognition.' },
          { id: 'custom', label: `WebApiSkill(uri=…, timeout="${p ? p.timeout : 'PT30S'}", batch_size=1)`, col: 0, row: 4, kind: 'code', detail: 'Function must return {"values":[{"recordId", "data", "errors", "warnings"}]}.' },
          { id: 'mapping', label: `output_field_mappings=[${p && p.mapOutputs ? 'FieldMapping("/document/organizations", "organizations"), …' : ''}]`, col: 0, row: 5, kind: 'code', detail: 'On the indexer.' },
        ],
        edges: [['cracking', 'ocr'], ['ocr', 'merge'], ['merge', 'nlp'], ['nlp', 'custom'], ['custom', 'mapping']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Sample document', type: 'select', options: Object.entries(DOCS).map(([v, d]) => [v, d.label]), default: 'scannedContract' },
      { id: 'imageAction', label: 'Indexer imageAction', type: 'select', options: [['none', 'none'], ['generateNormalizedImages', 'generateNormalizedImages']], default: 'none' },
      { id: 'textPath', label: 'Text from images/layout', type: 'select', options: [['content', 'Text layer only'], ['ocrMerge', 'OCR skill + Merge skill'], ['layout', 'Document Layout skill (markdown)']], default: 'ocrMerge' },
      { id: 'ocrContext', label: 'OCR skill context', type: 'select', options: [['/document/normalized_images/*', '/document/normalized_images/*'], ['/document', '/document']], default: '/document/normalized_images/*' },
      { id: 'fileData', label: 'allowSkillsetToReadFileData', type: 'toggle', default: false, help: 'Needed by the Document Layout skill (reads /document/file_data).' },
      { id: 'langDetect', label: 'Language detection skill', type: 'toggle', default: true },
      { id: 'entities', label: 'Entity recognition skill', type: 'toggle', default: true },
      { id: 'keyPhrases', label: 'Key phrase skill', type: 'toggle', default: true },
      { id: 'imageAnalysis', label: 'Image analysis skill', type: 'toggle', default: false },
      { id: 'custom', label: 'Custom Web API skill (clause classifier)', type: 'select', options: [['off', 'Not used'], ['ok', 'Healthy (~2 s)'], ['slow', 'Slow (~60 s)'], ['malformed', 'Returns wrong JSON shape']], default: 'off' },
      { id: 'timeout', label: 'Custom skill timeout', type: 'select', options: [['PT30S', 'PT30S'], ['PT90S', 'PT90S']], default: 'PT30S' },
      { id: 'embed', label: 'Split + Azure OpenAI embedding', type: 'toggle', default: false },
      { id: 'mapOutputs', label: 'Output field mappings defined', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Scanned contract, images not generated', values: { document: 'scannedContract', imageAction: 'none', textPath: 'ocrMerge' } },
      { label: 'Scanned contract, OCR + Merge + clause skill', values: { document: 'scannedContract', imageAction: 'generateNormalizedImages', textPath: 'ocrMerge', custom: 'ok' } },
      { label: 'Product sheet with image analysis', values: { document: 'productSheet', imageAction: 'generateNormalizedImages', textPath: 'ocrMerge', imageAnalysis: true } },
      { label: 'Layout skill path', values: { document: 'scannedContract', textPath: 'layout', fileData: true, custom: 'ok' } },
      { label: 'French contract without language detection', values: { document: 'frenchContract', langDetect: false } },
    ],
    run: enrich,
  },

  compare: {
    suggestions: [
      'Run the scanned contract with the text layer only, then OCR + Merge (with normalized images), then the Layout skill: compare "Organizations in index".',
      'Run the French contract with language detection off and on and compare which entities are found.',
      'Run the clause classifier with Slow + PT30S, then Slow + PT90S.',
    ],
  },

  debug: [
    { id: 'noimages', title: 'Scanned page text never appears', values: { document: 'scannedContract', imageAction: 'none', textPath: 'ocrMerge' }, node: 'ocr',
      symptom: 'Fabrikam Inc is missing from organizations; indexer warning that the OCR input was not found.', cause: 'imageAction is none, so /document/normalized_images/* does not exist for the OCR skill.', fix: 'Set imageAction to generateNormalizedImages on the indexer.' },
    { id: 'context', title: 'OCR runs but merged_content has no OCR text', values: { document: 'scannedContract', imageAction: 'generateNormalizedImages', textPath: 'ocrMerge', ocrContext: '/document' }, node: 'ocr',
      symptom: 'Warning "one or more skill input was invalid"; merged_content equals content.', cause: 'Wrong context: /document instead of /document/normalized_images/*.', fix: 'Set the OCR skill context to /document/normalized_images/* so it runs per image and writes …/text.' },
    { id: 'malformed', title: 'Custom skill breaks every document', values: { document: 'scannedContract', imageAction: 'generateNormalizedImages', custom: 'malformed' }, node: 'custom',
      symptom: 'Document fails with an invalid Web API response.', cause: 'The function returns its own JSON shape instead of {"values":[{"recordId", "data"}]}.', fix: 'Fix the function contract (choose "Healthy" here) and echo each recordId.' },
    { id: 'timeout', title: 'Custom skill timeouts', values: { document: 'scannedContract', imageAction: 'generateNormalizedImages', custom: 'slow', timeout: 'PT30S' }, node: 'custom',
      symptom: 'Web API request failed after the timeout.', cause: 'Function latency exceeds the skill timeout (default 30 s).', fix: 'Raise the timeout (PT90S here; there is a documented maximum), reduce batchSize, or speed up the function.' },
    { id: 'unmapped', title: 'Enrichments computed but not searchable', values: { document: 'productSheet', imageAction: 'generateNormalizedImages', imageAnalysis: true, mapOutputs: false }, node: 'mapping',
      symptom: 'Skills succeed but the index fields are empty.', cause: 'No outputFieldMappings from enrichment nodes to index fields.', fix: 'Add outputFieldMappings (or index projections) for each enrichment.' },
    { id: 'filedata', title: 'Layout skill fails immediately', values: { document: 'scannedContract', textPath: 'layout', fileData: false }, node: 'ocr',
      symptom: 'Layout skill reports a missing file_data input.', cause: 'allowSkillsetToReadFileData is false on the indexer.', fix: 'Set allowSkillsetToReadFileData: true.' },
    { id: 'lang', title: 'French entities missing', values: { document: 'frenchContract', langDetect: false }, node: 'lang',
      symptom: 'Contoso SA and Paris not recognised.', cause: 'Text skills ran with defaultLanguageCode en on French text.', fix: 'Add language detection and pass /document/language as languageCode.' },
  ],

  challenge: {
    task: 'Index the scanned contract so the counterparty from the scanned signature page (Fabrikam Inc) and the "liability" clause type are both searchable, with no warnings or errors.',
    condition: 'Document = Contract PDF, Organizations in index includes Fabrikam Inc, Clause types include liability, run has no warn/error steps.',
    hint: 'Scanned text must reach the text skills, and your custom skill must answer in time with the right shape.',
    check: (p, res) => p.document === 'scannedContract' && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.metrics.some(m => m.label === 'Organizations in index' && /Fabrikam/.test(m.value)) && res.metrics.some(m => m.label === 'Clause types in index' && /liability/.test(m.value)),
    solution: ['imageAction = generateNormalizedImages.', 'Text path: OCR skill + Merge skill with context /document/normalized_images/* (or Layout skill with allowSkillsetToReadFileData on).', 'Keep entity recognition and language detection on.', 'Custom skill: Healthy (or Slow with PT90S).', 'Keep output field mappings on.'],
    solutionValues: { document: 'scannedContract', imageAction: 'generateNormalizedImages', textPath: 'ocrMerge', ocrContext: '/document/normalized_images/*', langDetect: true, entities: true, custom: 'ok', mapOutputs: true },
  },

  quiz: [
    { q: 'Supplier names appear only on scanned pages inside PDFs. Your skillset has an OCR skill, but no OCR text appears. What is the most likely missing setting?', options: ['A semantic configuration', 'imageAction = generateNormalizedImages on the indexer', 'A larger vector dimension', 'A key phrase skill'], answer: 1, why: 'OCR reads /document/normalized_images/*, which the indexer only creates when imageAction is set.' },
    { q: 'You need a proprietary clause classifier during indexing. Which approach fits?', options: ['A WebApiSkill calling your Azure Function that returns {values:[{recordId, data}]}', 'An outputFieldMapping with a regex', 'A semantic ranker', 'A synonym map'], answer: 0, why: 'Custom Web API skills let you plug your own code into the enrichment pipeline using a fixed request/response contract.' },
    { q: 'Entity recognition runs successfully but the organizations field in the index is empty. What should you check?', options: ['The indexer schedule', 'outputFieldMappings from /document/organizations to the index field', 'The analyzer on the content field', 'The vector profile'], answer: 1, why: 'Enrichments live in the enrichment tree; only mapped nodes are written to the index.' },
    { q: 'You want structure-aware markdown sections (headings, tables) from PDFs inside a search skillset. Which skill and setting?', options: ['OcrSkill with context /document', 'DocumentIntelligenceLayoutSkill with allowSkillsetToReadFileData enabled', 'KeyPhraseExtractionSkill', 'MergeSkill'], answer: 1, why: 'The Document Layout skill reads the original file (file_data) and returns markdown sections; the indexer must allow skillsets to read file data.' },
  ],

  recap: 'Skills read and write nodes in the enrichment tree. Generate normalized images for OCR and image analysis, run per-image skills with context /document/normalized_images/*, merge OCR text back, pass the detected language, keep custom skills inside the Web API contract and timeout, and map every enrichment you want to search.',
};
