// 5.2.2 Produce clean, grounded representations to use with agents and RAG by using Content Understanding
// Lab: Grounded markdown builder.
import { step, metric, estTokens } from '../src/engine/util.js';

// Sample documents as layout elements. role mirrors the paragraph roles a layout analysis returns
// (pageHeader, pageFooter, title/sectionHeading, table, figure). Content is invented for teaching.
const DOCS = {
  annual: {
    label: 'Annual report (3 pages, table + chart)',
    elements: [
      { page: 1, role: 'pageHeader', text: 'Contoso Ltd | Annual Report 2025' },
      { page: 1, role: 'title', text: 'Chair\'s letter' },
      { page: 1, role: 'para', text: 'Revenue grew 12% to 4.2 billion USD, driven by cloud services.' },
      { page: 1, role: 'pageFooter', text: 'Page 1 of 3 | CONFIDENTIAL' },
      { page: 2, role: 'pageHeader', text: 'Contoso Ltd | Annual Report 2025' },
      { page: 2, role: 'heading', text: 'Revenue by region (billion USD)' },
      { page: 2, role: 'table', id: 'table1', cells: [['Region', '2024', '2025'], ['Europe', '1.40', '1.55'], ['Americas', '1.70', '1.90'], ['Asia Pacific', '0.65', '0.75']] },
      { page: 2, role: 'pageFooter', text: 'Page 2 of 3 | CONFIDENTIAL' },
      { page: 3, role: 'pageHeader', text: 'Contoso Ltd | Annual Report 2025' },
      { page: 3, role: 'heading', text: 'Outlook' },
      { page: 3, role: 'figure', id: 'figure1', caption: 'Figure 3: Quarterly cloud revenue 2025', description: 'Line chart. Cloud revenue rises every quarter of 2025, from 0.30 to 0.42 billion USD; the steepest increase is from Q3 to Q4.' },
      { page: 3, role: 'para', text: 'We expect continued growth in 2026.' },
      { page: 3, role: 'pageFooter', text: 'Page 3 of 3 | CONFIDENTIAL' },
    ],
  },
  contract: {
    label: 'Services contract (2 pages, signature block)',
    elements: [
      { page: 1, role: 'pageHeader', text: 'DRAFT | Fabrikam / Contoso MSA' },
      { page: 1, role: 'title', text: 'Master services agreement' },
      { page: 1, role: 'para', text: 'This agreement is between Fabrikam Inc ("Customer") and Contoso Ltd ("Supplier").' },
      { page: 1, role: 'heading', text: '9. Termination' },
      { page: 1, role: 'para', text: '9.1 Either party may terminate for material breach not remedied within 30 days.' },
      { page: 1, role: 'pageFooter', text: 'Page 1 of 2' },
      { page: 2, role: 'pageHeader', text: 'DRAFT | Fabrikam / Contoso MSA' },
      { page: 2, role: 'para', text: '9.2 Either party may terminate for convenience with 90 days written notice.' },
      { page: 2, role: 'figure', id: 'figure1', caption: 'Signature block', description: 'Two handwritten signatures: J. Park for Fabrikam Inc and R. Diaz for Contoso Ltd, both dated 3 March 2026.' },
      { page: 2, role: 'pageFooter', text: 'Page 2 of 2' },
    ],
  },
};

const QUESTIONS = {
  apac: { doc: 'annual', label: 'Annual report: What was Asia Pacific revenue in 2025?', needs: 'table', evidence: 'table1', answer: 'Asia Pacific revenue in 2025 was 0.75 billion USD.' },
  chart: { doc: 'annual', label: 'Annual report: In which quarter did cloud revenue grow fastest?', needs: 'figure', evidence: 'figure1', answer: 'The steepest increase was from Q3 to Q4 2025.' },
  notice: { doc: 'contract', label: 'Contract: What notice applies to termination for convenience?', needs: 'text', evidence: '9.2', answer: '90 days written notice (clause 9.2).' },
  signer: { doc: 'contract', label: 'Contract: Who signed for Contoso?', needs: 'figure', evidence: 'figure1', answer: 'R. Diaz signed for Contoso Ltd on 3 March 2026.' },
};

const ANALYZERS = {
  'prebuilt-read': { label: 'prebuilt-read (text only)', layout: false, figures: false },
  'prebuilt-layout': { label: 'prebuilt-layout (markdown, tables, roles)', layout: true, figures: false },
  'prebuilt-documentSearch': { label: 'prebuilt-documentSearch (layout + figure descriptions, RAG-oriented)', layout: true, figures: true },
};

function tableText(cells, fmt) {
  if (fmt === 'flatten') return cells.map(r => r.join(' ')).join('\n');
  if (fmt === 'pipe') return [`| ${cells[0].join(' | ')} |`, `|${cells[0].map(() => ' --- ').join('|')}|`, ...cells.slice(1).map(r => `| ${r.join(' | ')} |`)].join('\n');
  return '<table>\n' + cells.map((r, i) => '<tr>' + r.map(c => i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`).join('') + '</tr>').join('\n') + '\n</table>';
}

// Build the markdown + span map for a given configuration.
function render(doc, p, strip) {
  const a = ANALYZERS[p.analyzer];
  let md = '';
  const spans = [];
  let lastPage = 1;
  for (const el of doc.elements) {
    if (a.layout && el.page !== lastPage) { md += '<!-- PageBreak -->\n\n'; lastPage = el.page; }
    let piece = '';
    const isHF = el.role === 'pageHeader' || el.role === 'pageFooter';
    if (isHF) {
      if (strip && a.layout) continue;
      piece = a.layout ? `<!-- ${el.role === 'pageHeader' ? 'PageHeader' : 'PageFooter'}="${el.text}" -->` : el.text;
    } else if (el.role === 'title') piece = a.layout ? `# ${el.text}` : el.text;
    else if (el.role === 'heading') piece = a.layout ? `## ${el.text}` : el.text;
    else if (el.role === 'para') piece = el.text;
    else if (el.role === 'table') piece = tableText(el.cells, a.layout ? p.tableFormat : 'flatten');
    else if (el.role === 'figure') {
      if (!a.layout) continue;
      const desc = a.figures && p.figures ? `\n${el.description}` : '';
      piece = `<figure>\n<figcaption>${el.caption}</figcaption>${desc}\n</figure>`;
    }
    const offset = md.length;
    md += piece + '\n\n';
    spans.push({ el, offset, length: piece.length, page: el.page });
  }
  return { md: md.trim() + '\n', spans };
}

function build(p) {
  const q = QUESTIONS[p.question] || QUESTIONS.apac;
  const doc = DOCS[q.doc];
  const a = ANALYZERS[p.analyzer] || ANALYZERS['prebuilt-layout'];
  const steps = [];
  const pages = Math.max(...doc.elements.map(e => e.page));

  steps.push(step('source', 'Document submitted', `${doc.label} → analyzer ${p.analyzer}.`, { analyzerId: p.analyzer, pages, operation: 'POST …/analyzers/{analyzerId}:analyze (long-running; poll the operation)' }, 'info'));

  // Analyzer
  const counts = { tables: doc.elements.filter(e => e.role === 'table').length, figures: doc.elements.filter(e => e.role === 'figure').length };
  steps.push(step('analyze', a.layout ? 'Layout analysis' : 'Read (OCR) only', a.layout
    ? `Headings, ${counts.tables} table(s), ${counts.figures} figure(s), page header/footer roles detected.${a.figures ? ' Figures can be described in text.' : ''}`
    : 'Lines and paragraphs only: no headings, no table structure, no figure regions, no header/footer roles.',
    { contents: [{ kind: 'document', startPageNumber: 1, endPageNumber: pages, tables: a.layout ? counts.tables : 0, figures: a.layout ? counts.figures : 0 }] }, 'ok'));

  // Clean-up
  const raw = render(doc, p, false);
  const out = render(doc, p, !!p.stripHeaders);
  const hfCount = doc.elements.filter(e => e.role === 'pageHeader' || e.role === 'pageFooter').length;
  if (p.stripHeaders && !a.layout) {
    steps.push(step('clean', 'Cannot remove headers/footers reliably', 'prebuilt-read output has no paragraph roles, so repeated page headers and footers are indistinguishable from body text. They stay in the markdown.', { removed: 0, repeatedLines: hfCount }, 'warn'));
  } else if (p.stripHeaders) {
    steps.push(step('clean', 'Removed page headers and footers', `Dropped ${hfCount} pageHeader/pageFooter elements by role. Body text is continuous across page breaks.`, { removed: hfCount, tokensSaved: estTokens(raw.md) - estTokens(out.md) }));
  } else {
    steps.push(step('clean', 'Headers and footers kept', `${hfCount} repeated header/footer lines remain. They add noise to every chunk and can sit between a heading and its continuation on the next page.`, { repeatedLines: hfCount }, 'warn'));
  }

  // Tables / figures
  const tableEl = doc.elements.find(e => e.role === 'table');
  if (tableEl) {
    const flat = !a.layout || p.tableFormat === 'flatten';
    steps.push(step('structure', flat ? 'Table structure lost' : `Table kept as ${p.tableFormat === 'html' ? 'HTML in markdown' : 'pipe table'}`, flat
      ? 'Rows became plain lines ("Asia Pacific 0.65 0.75"). Which number belongs to which year is now implicit.'
      : 'Header row and cells preserved, so row/column relationships survive into the prompt.', { format: flat ? 'flattened' : p.tableFormat }, flat ? 'warn' : 'ok'));
  }
  const figEl = doc.elements.find(e => e.role === 'figure');
  if (figEl) {
    const described = a.figures && p.figures;
    steps.push(step('structure', described ? 'Figure described in text' : a.layout ? 'Figure placeholder only' : 'Figure invisible', described
      ? `"${figEl.description.slice(0, 80)}…"`
      : a.layout ? 'A <figure> with a caption is emitted, but no description of what it shows.' + (p.figures && !a.figures ? ' This analyzer does not generate figure descriptions.' : '') : 'Read output contains no figure regions.',
      { figure: figEl.id, page: figEl.page, description: described }, described || q.needs !== 'figure' ? (described ? 'ok' : 'info') : 'warn'));
  }

  // Grounding
  const evSpan = out.spans.find(s => (s.el.id && s.el.id === q.evidence) || (s.el.text && s.el.text.startsWith(q.evidence)));
  steps.push(step('ground', p.grounding ? 'Source grounding attached' : 'No grounding kept', p.grounding
    ? `${out.spans.length} elements carry page numbers and spans (offset/length into the markdown). Chunks inherit them.`
    : 'Only the markdown text is stored. Chunks lose page numbers and spans.', { elementsWithSpans: p.grounding ? out.spans.length : 0 }, p.grounding ? 'ok' : 'warn'));

  // Agent answer
  let answer, status = 'ok', reason = '';
  const flatTable = !a.layout || p.tableFormat === 'flatten';
  if (q.needs === 'table' && flatTable) { answer = 'Asia Pacific revenue was 0.65 or 0.75 billion USD (the columns are unclear).'; status = 'warn'; reason = 'Flattened table: the model cannot tell which value is 2025.'; }
  else if (q.needs === 'figure' && !(a.figures && p.figures)) { answer = 'The document does not state this in text.'; status = 'warn'; reason = 'The answer lives only in the figure, which has no text description.'; }
  else answer = q.answer;
  const cite = p.grounding && evSpan && status === 'ok' ? ` [page ${evSpan.page}, span ${evSpan.offset}+${evSpan.length}]` : '';
  if (status === 'ok' && !cite && p.citeRequired) {
    steps.push(step('agent', 'Answer rejected: no citation', 'The agent found the answer, but the app requires each claim to cite a page/span and the representation has no grounding. The citation validator blocks the response.', { citationRequired: true, sources: [] }, 'error'));
  } else {
    steps.push(step('agent', status === 'ok' ? (cite ? 'Grounded answer with citation' : 'Answer without citation') : 'Agent answer is unreliable', status === 'ok' ? `${answer}${cite}` : reason,
      { answer, citation: cite || null }, status === 'ok' && !cite ? 'warn' : status));
  }

  // Output
  const output = [
    { type: 'code', title: 'Markdown representation (what the agent or chunker sees)', lang: 'markdown', text: out.md },
  ];
  if (p.stripHeaders && a.layout) output.push({ type: 'diff', title: 'Before / after header-footer removal', before: raw.md, after: out.md });
  if (p.grounding) output.push({ type: 'table', title: 'Grounding map (element → page, span in markdown)', columns: ['Element', 'Role', 'Page', 'Offset', 'Length'],
    rows: out.spans.map(s => [s.el.id || (s.el.text || '').slice(0, 40), s.el.role, String(s.page), String(s.offset), String(s.length)]),
    tones: out.spans.map(s => (evSpan && s === evSpan ? 'ok' : s.el.role === 'pageHeader' || s.el.role === 'pageFooter' ? 'warn' : 'muted')) });
  output.push({ type: 'chat', title: 'Agent using this representation (simulated)', turns: [
    { role: 'user', text: q.label.split(': ')[1] },
    { role: 'tool', text: `retrieve → ${evSpan ? out.md.slice(evSpan.offset, evSpan.offset + Math.min(evSpan.length, 180)) : '(evidence not present in the representation)'}`, meta: p.grounding && evSpan ? `page ${evSpan.page}` : 'no grounding' },
    { role: 'assistant', text: steps.at(-1).status === 'error' ? '(blocked: citation required)' : answer + cite },
  ] });
  output.push({ type: 'json', title: 'Analyze result (abridged, simulated shape)', data: {
    analyzerId: p.analyzer, status: 'Succeeded',
    result: { contents: [{ kind: 'document', markdown: out.md.slice(0, 90) + '…', startPageNumber: 1, endPageNumber: pages,
      pages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1 })), tables: a.layout ? counts.tables : 0,
      figures: a.layout ? doc.elements.filter(e => e.role === 'figure').map(f => ({ id: f.id, caption: f.caption, description: a.figures && p.figures ? f.description : undefined })) : [] }] },
  } });

  return {
    steps, output,
    metrics: [
      metric('Markdown tokens', String(estTokens(out.md)), 'estimate', '~4 characters per token heuristic.'),
      metric('Header/footer noise remaining', String(out.spans.filter(s => s.el.role === 'pageHeader' || s.el.role === 'pageFooter').length), 'computed', 'Repeated page furniture left in the representation.'),
      metric('Answer quality', steps.at(-1).status === 'ok' ? 'correct + cited' : steps.at(-1).status === 'error' ? 'blocked' : 'unreliable or uncited', 'computed'),
      metric('Grounded elements', p.grounding ? String(out.spans.length) : '0', 'computed'),
    ],
    summary: `${p.analyzer} • table ${p.tableFormat} • ${p.stripHeaders ? 'clean' : 'noisy'} • ${steps.at(-1).title}`,
  };
}

export default {
  id: '5.2.2',
  lab: 'Grounded markdown builder',
  services: [
    { name: 'Azure Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
    { name: 'Content Understanding document analysis', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/document/overview' },
    { name: 'Document Intelligence markdown output (layout)', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout' },
  ],
  prereqs: ['5.2.1'],
  next: ['5.2.3', '5.1.4', '2.1.2'],

  concept: {
    plain: 'Agents and RAG pipelines work best on clean text that keeps the document\'s structure: headings, tables that still look like tables, a sentence describing each chart, and none of the repeated "Page 3 of 10 | CONFIDENTIAL" lines. Every piece should also remember where it came from (page and position) so the agent can cite it and a person can check it.',
    technical: 'Content Understanding analyzers return contents[] with a markdown representation plus structure: pages, paragraphs with roles (pageHeader, pageFooter, title, sectionHeading), tables, figures and spans (offset/length into the markdown) that map back to page regions. Layout-based analyzers emit headings, tables (HTML tables in markdown) and comments for page breaks and page furniture; RAG-oriented prebuilt analyzers can add figure descriptions and summaries. Post-processing removes headers/footers by role, chooses a table format, and carries page numbers and spans into chunk metadata so answers can cite sources. Analyzer IDs and options shown here are illustrative; check the current list for your API version.',
    useCase: 'An investor-relations agent answers analyst questions from annual reports. Converting each report to clean markdown with tables intact, chart descriptions and page/span grounding lets the agent answer "what was APAC revenue in 2025?" and link straight to page 2 of the PDF.',
    terms: [
      ['Markdown representation', 'Text form of a document that keeps headings, lists and tables, suited to LLM prompts and chunking.'],
      ['Span', 'Offset + length into the markdown that maps an element back to its source.'],
      ['Paragraph role', 'Layout label such as pageHeader, pageFooter, title or sectionHeading; lets you filter page furniture.'],
      ['Figure description', 'Generated text explaining a chart/image so its content becomes searchable and answerable.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'source', label: p ? DOCS[QUESTIONS[p.question].doc].label.split(' (')[0] : 'Document', col: 0, row: 1, kind: 'data', detail: 'PDF / image / Office document.' },
          { id: 'analyze', label: p ? `Analyzer: ${p.analyzer}` : 'Analyzer', col: 1, row: 1, kind: 'ai', detail: 'OCR + layout (+ figure descriptions).', substeps: ['OCR', 'Layout roles', 'Tables', 'Figures'] },
          { id: 'clean', label: 'Remove page furniture', col: 2, row: 0, disabled: p ? !p.stripHeaders : false, detail: 'Drop pageHeader/pageFooter/pageNumber by role.' },
          { id: 'structure', label: p ? `Tables: ${p.tableFormat}; figures: ${p.figures ? 'described' : 'placeholder'}` : 'Tables & figures', col: 2, row: 2, detail: 'Keep tables as tables; turn charts into sentences.' },
          { id: 'ground', label: 'Attach grounding', col: 3, row: 1, disabled: p ? !p.grounding : false, detail: 'Page numbers and spans travel with each chunk.' },
          { id: 'agent', label: 'Agent / RAG answer', col: 4, row: 1, kind: 'user', detail: 'Answers and cites page + span.', badge: p && p.citeRequired ? 'citations required' : undefined },
        ],
        edges: [['source', 'analyze'], ['analyze', 'clean'], ['analyze', 'structure'], ['clean', 'ground'], ['structure', 'ground'], ['ground', 'agent']],
      }),
      architectural: () => ({
        nodes: [
          { id: 'source', label: 'Blob Storage (reports)', col: 0, row: 1, kind: 'store', detail: 'Event Grid trigger on upload.' },
          { id: 'analyze', label: 'Content Understanding (Foundry resource)', col: 1, row: 1, kind: 'ai', detail: 'Analyzer call with managed identity (Cognitive Services User / Azure AI User role).' },
          { id: 'clean', label: 'Azure Function: post-process', col: 2, row: 1, kind: 'compute', detail: 'Strips furniture by role, normalises tables, chunks by heading, carries page/span metadata.' },
          { id: 'structure', label: 'Blob: cleaned .md + .json sidecar', col: 2, row: 2, kind: 'store', detail: 'Markdown plus grounding map stored next to the source for indexing.' },
          { id: 'ground', label: 'Azure AI Search index (chunks + page/span)', col: 3, row: 1, kind: 'data', detail: 'Fields: chunk, page, spanOffset, spanLength, sourceUrl.' },
          { id: 'agent', label: 'Foundry agent with search tool', col: 4, row: 1, kind: 'app', detail: 'Cites page and links to the PDF.' },
        ],
        edges: [['source', 'analyze'], ['analyze', 'clean', 'markdown + roles + spans'], ['clean', 'structure'], ['structure', 'ground'], ['ground', 'agent']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'analyze', label: `poller = cu_client.begin_analyze("${p ? p.analyzer : 'prebuilt-layout'}", url=blob_url)`, col: 0, row: 0, kind: 'code', detail: 'Content Understanding SDK/REST; method names illustrative. Long-running operation.' },
          { id: 'source', label: 'content = poller.result().contents[0]', col: 0, row: 1, kind: 'code', detail: 'markdown, pages, paragraphs (role), tables, figures, spans.' },
          { id: 'clean', label: 'body = [x for x in content.paragraphs if x.role not in ("pageHeader", "pageFooter", "pageNumber")]', col: 0, row: 2, kind: 'code', detail: 'Filter by role (or strip the matching HTML comments from the markdown).' },
          { id: 'structure', label: `tables → ${p ? p.tableFormat : 'html'}; figures → description`, col: 0, row: 3, kind: 'code', detail: 'Keep tables structured; add figure descriptions where enabled.' },
          { id: 'ground', label: 'chunk.metadata = {"page": span.page, "offset": span.offset, "length": span.length}', col: 0, row: 4, kind: 'code', detail: 'Grounding travels into the index.' },
          { id: 'agent', label: 'answer must cite chunk.metadata → reject if missing', col: 0, row: 5, kind: 'code', detail: 'Citation validator in your app.' },
        ],
        edges: [['analyze', 'source'], ['source', 'clean'], ['clean', 'structure'], ['structure', 'ground'], ['ground', 'agent']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'question', label: 'Document + question', type: 'select', options: Object.entries(QUESTIONS).map(([v, q]) => [v, q.label]), default: 'apac' },
      { id: 'analyzer', label: 'Analyzer (illustrative IDs)', type: 'select', options: Object.entries(ANALYZERS).map(([v, a]) => [v, a.label]), default: 'prebuilt-layout' },
      { id: 'stripHeaders', label: 'Remove page headers/footers', type: 'toggle', default: false },
      { id: 'tableFormat', label: 'Table format in markdown', type: 'select', options: [['html', 'HTML table (as returned)'], ['pipe', 'Pipe table (converted)'], ['flatten', 'Flattened text']], default: 'html' },
      { id: 'figures', label: 'Include figure descriptions', type: 'toggle', default: false },
      { id: 'grounding', label: 'Keep page + span grounding', type: 'toggle', default: true },
      { id: 'citeRequired', label: 'App requires citations', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Table question, layout, noisy', values: { question: 'apac', analyzer: 'prebuilt-layout' } },
      { label: 'Table question, flattened', values: { question: 'apac', tableFormat: 'flatten', stripHeaders: true } },
      { label: 'Chart question, figure descriptions', values: { question: 'chart', analyzer: 'prebuilt-documentSearch', figures: true, stripHeaders: true } },
      { label: 'Contract clause, read only', values: { question: 'notice', analyzer: 'prebuilt-read' } },
      { label: 'Signature block, clean + grounded', values: { question: 'signer', analyzer: 'prebuilt-documentSearch', figures: true, stripHeaders: true } },
    ],
    run: build,
  },

  compare: {
    suggestions: [
      'Ask the APAC question with HTML, pipe and flattened tables. Compare answer quality.',
      'Ask the chart question with prebuilt-layout, then prebuilt-documentSearch with figure descriptions.',
      'Toggle header removal on the annual report and compare markdown tokens and the diff.',
    ],
  },

  debug: [
    { id: 'flat', title: 'Wrong year in table answers', values: { question: 'apac', analyzer: 'prebuilt-layout', tableFormat: 'flatten', stripHeaders: true }, node: 'structure',
      symptom: 'Agent says "0.65 or 0.75" for APAC 2025.', cause: 'The table was flattened into lines, losing the header-to-cell relationship.', fix: 'Keep tables as HTML or pipe tables in the markdown.' },
    { id: 'nogrounding', title: 'Correct answer blocked by the citation check', values: { question: 'notice', analyzer: 'prebuilt-layout', stripHeaders: true, grounding: false, citeRequired: true }, node: 'agent',
      symptom: 'Response rejected: no citation.', cause: 'Spans and page numbers were dropped during conversion, so chunks cannot be cited.', fix: 'Keep page + span grounding and store it as chunk metadata.' },
    { id: 'figure', title: 'Chart question unanswerable', values: { question: 'chart', analyzer: 'prebuilt-layout', stripHeaders: true }, node: 'structure',
      symptom: 'Agent says the document does not state it.', cause: 'The information exists only in a chart; the analyzer emits a placeholder without a description.', fix: 'Use an analyzer that generates figure descriptions (prebuilt-documentSearch here) and enable them.' },
    { id: 'noise', title: 'Every chunk starts with "Contoso Ltd | Annual Report 2025"', values: { question: 'apac', stripHeaders: false }, node: 'clean',
      symptom: 'Repeated header/footer lines throughout the markdown.', cause: 'Page furniture was not removed.', fix: 'Remove pageHeader/pageFooter elements by role.' },
    { id: 'readroles', title: 'Header removal has no effect', values: { question: 'notice', analyzer: 'prebuilt-read', stripHeaders: true }, node: 'analyze',
      symptom: '"DRAFT | Fabrikam / Contoso MSA" still appears on every page.', cause: 'Read output has no paragraph roles, so headers cannot be identified. Unsuitable analyzer for this job.', fix: 'Use a layout-capable analyzer.' },
  ],

  challenge: {
    task: 'Answer the chart question from the annual report with a page/span citation, using clean markdown (no headers or footers).',
    condition: 'Question = chart, header/footer noise = 0, answer quality = correct + cited, no warn/error steps.',
    hint: 'The answer is only in a chart. Then make sure page furniture and grounding are handled.',
    check: (p, res) => p.question === 'chart' && !res.steps.some(s => s.status === 'warn' || s.status === 'error') && res.metrics.some(m => m.label === 'Answer quality' && m.value === 'correct + cited'),
    solution: ['Analyzer: prebuilt-documentSearch (generates figure descriptions).', 'Turn on figure descriptions.', 'Remove page headers/footers.', 'Keep page + span grounding and citations required.'],
    solutionValues: { question: 'chart', analyzer: 'prebuilt-documentSearch', figures: true, stripHeaders: true, tableFormat: 'html', grounding: true, citeRequired: true },
  },

  quiz: [
    { q: 'Your RAG answers about financial tables mix up years. The markdown shows rows as plain lines. What should you change?', options: ['Increase top-k', 'Keep tables structured (HTML or pipe tables) in the representation', 'Use a bigger chat model', 'Remove the page numbers'], answer: 1, why: 'Structure lost at conversion cannot be recovered by retrieval or a bigger model. Keep table structure in the markdown.' },
    { q: 'Compliance requires every agent answer to link to the exact page of the source PDF. What must your representation include?', options: ['Only the markdown text', 'Page numbers and spans for each element, carried into chunk metadata', 'A document summary', 'Figure captions'], answer: 1, why: 'Spans and page numbers are the grounding that lets you cite and highlight the source.' },
    { q: 'Many chunks are dominated by repeated lines like "Page 4 of 80 | CONFIDENTIAL". What is the best fix?', options: ['Use smaller chunks', 'Remove paragraphs with pageHeader/pageFooter roles from layout output', 'Lower the embedding dimensions', 'Switch to keyword search'], answer: 1, why: 'Layout roles identify page furniture so it can be removed before chunking.' },
  ],

  recap: 'Clean, grounded representations = layout-aware markdown, tables kept as tables, charts turned into text descriptions, page furniture removed by role, and page/span grounding preserved into chunks so agents can cite and humans can verify.',
};
