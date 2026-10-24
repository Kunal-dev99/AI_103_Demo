// 4.1.1 Implement solutions to extract entities, topics, summaries, and structured JSON outputs
// by using generative prompting and Foundry Tools.
// Lab: Text extraction workbench.
import { rng, round, step, metric, estTokens, words } from '../src/engine/util.js';

const SAMPLES = {
  support: 'Hi, this is Maria Lopez from Fabrikam Retail. On 2026-09-14 we ordered 40 Surface Laptop 7 units for our Seattle office, but only 25 arrived. Invoice INV-88231 still charges $38,000 for all 40. Please fix the billing and ship the remaining units before 2026-10-01. You can reach me at maria.lopez@fabrikam.example.',
  news: 'Contoso Pharmaceuticals announced on 2026-08-02 that its Dublin plant will double production of insulin pens. Chief executive Daniel Okafor said the €120 million expansion will add 300 jobs by 2027. Regulators at the European Medicines Agency approved the new production line in July. Shares rose after the announcement.',
  meeting: 'Action items from the Northwind Traders project sync. Priya Shah will migrate the order database to Azure SQL by 2026-11-15. Tom Becker owns the load test and needs a budget of $4,500. The team agreed to pause the Berlin rollout until the security review closes. Ticket PRJ-4410 tracks the open risks.',
};

// Tiny gazetteers for the toy named-entity recogniser.
const FIRST_NAMES = ['maria', 'daniel', 'priya', 'tom', 'anna', 'james', 'li', 'omar', 'sofia', 'david'];
const ORG_SUFFIX = ['retail', 'pharmaceuticals', 'agency', 'traders', 'inc', 'ltd', 'bank', 'corp', 'group', 'university'];
const CITIES = ['seattle', 'dublin', 'berlin', 'leeds', 'paris', 'madrid', 'london', 'tokyo', 'chicago'];
const PRODUCT_HINTS = ['surface', 'laptop', 'xbox', 'azure', 'teams', 'pens'];
const STOP = new Set('a an the and or but of to in on at for by with from this that is are was were be been will would can could our we you your i me my it its their they he she his her as all only still after before until new please hi also some any not than then there here about into over'.split(' '));
const TOPIC_RULES = {
  Billing: ['invoice', 'charges', 'billing', 'refund', 'payment', 'budget'],
  'Shipping & orders': ['ordered', 'ship', 'arrived', 'delivery', 'units', 'order'],
  Manufacturing: ['production', 'plant', 'line', 'pens'],
  Regulation: ['regulators', 'approved', 'agency', 'compliance', 'security', 'review'],
  'Finance & markets': ['shares', 'million', 'expansion', 'jobs'],
  'Project delivery': ['migrate', 'rollout', 'load', 'test', 'risks', 'ticket'],
};
// Entities an over-creative model tends to "add" from world knowledge.
const HALLUCINATIONS = [{ text: 'Microsoft', category: 'Organization' }, { text: 'Redmond', category: 'Location' }, { text: 'Q4 2026', category: 'DateTime' }];

const MODELS = {
  'gpt-4.1-mini': { label: 'gpt-4.1-mini', schema: true },
  'gpt-4.1': { label: 'gpt-4.1', schema: true },
  legacy: { label: 'gpt-35-turbo (older version)', schema: false },
};
const APPROACHES = {
  language: 'Azure Language (NER + key phrases + summarization)',
  prompt: 'LLM: "return JSON" in the prompt only',
  json_object: 'LLM: response_format json_object (JSON mode)',
  schema: 'LLM: response_format json_schema, strict: true',
};
const CUSTOM_FIELDS = ['customer', 'reference_id', 'amount', 'due_date'];
const CAT_TONE = { Person: 'info', Organization: 'ok', Location: 'warn', DateTime: 'muted', Quantity: 'muted', Email: 'error', Product: 'info' };

function ner(text) {
  const ents = [];
  const add = (t, category, offset, conf) => {
    if (!ents.some(e => offset < e.offset + e.text.length && e.offset < offset + t.length)) ents.push({ text: t, category, offset, length: t.length, confidence: conf });
  };
  const scan = (re, cat, conf) => { let m; while ((m = re.exec(text))) add(m[0], cat, m.index, conf); };
  scan(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, 'Email', 0.99);
  scan(/\b\d{4}-\d{2}-\d{2}\b/g, 'DateTime', 0.97);
  scan(/[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s(?:million|billion))?/g, 'Quantity', 0.95);
  scan(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b(?:\s\d{1,2})?/g, 'DateTime', 0.9);
  scan(/\bby (20\d\d)\b/g, 'DateTime', 0.85);
  // Capitalised spans (2+ tokens), then single known cities.
  let m; const cap = /\b[A-Z][a-zA-Z]+(?:\s(?:[A-Z][a-zA-Z]+|\d+))+/g;
  while ((m = cap.exec(text))) {
    const toks = m[0].split(/\s+/); const low = toks.map(t => t.toLowerCase());
    let cat = null;
    if (ORG_SUFFIX.includes(low[low.length - 1])) cat = 'Organization';
    else if (FIRST_NAMES.includes(low[0])) cat = 'Person';
    else if (low.some(t => PRODUCT_HINTS.includes(t))) cat = 'Product';
    if (cat) add(m[0], cat, m.index, cat === 'Product' ? 0.82 : 0.93);
  }
  const city = /\b[A-Z][a-z]+\b/g;
  while ((m = city.exec(text))) if (CITIES.includes(m[0].toLowerCase())) add(m[0], 'Location', m.index, 0.9);
  return ents.sort((a, b) => a.offset - b.offset);
}

function keyPhrases(text) {
  const toks = words(text);
  const counts = new Map();
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (STOP.has(a) || a.length < 3 || /^\d+$/.test(a)) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
    if (b && !STOP.has(b) && b.length > 2 && !/^\d+$/.test(b)) counts.set(`${a} ${b}`, (counts.get(`${a} ${b}`) || 0) + 1.5);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length).slice(0, 6).map(e => e[0]);
}

function topics(text) {
  const W = words(text);
  return Object.entries(TOPIC_RULES).map(([t, kws]) => [t, W.filter(w => kws.includes(w)).length]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

function summarize(text, n, abstractive) {
  const sents = text.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const kp = new Set(keyPhrases(text).flatMap(k => k.split(' ')));
  const scored = sents.map((s, i) => ({ s, i, score: words(s).filter(w => kp.has(w)).length + (i === 0 ? 0.5 : 0) }));
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s);
  if (!abstractive) return top.join(' ');
  return top.map(s => s.replace(/^(Hi|Hello),?\s*this is [^.]+\.\s*/i, '').replace(/^Please\s+/i, '').replace(/\s+/g, ' ')).join(' ').trim();
}

function customFields(text, ents) {
  const id = text.match(/\b[A-Z]{2,5}-\d{3,6}\b/);
  const dates = ents.filter(e => e.category === 'DateTime');
  const org = ents.find(e => e.category === 'Organization');
  const money = ents.find(e => e.category === 'Quantity');
  return { customer: org ? org.text : null, reference_id: id ? id[0] : null, amount: money ? money.text : null, due_date: dates.length ? dates[dates.length - 1].text : null };
}

function buildSchema(required) {
  const props = { entities: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string' } }, required: ['text', 'category'], additionalProperties: false } },
    topics: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } };
  for (const f of CUSTOM_FIELDS) props[f] = { type: ['string', 'null'] };
  const used = Object.fromEntries(Object.entries(props).filter(([k]) => required.includes(k) || ['entities', 'topics', 'summary'].includes(k)));
  return { name: 'extraction', strict: true, schema: { type: 'object', properties: used, required: Object.keys(used), additionalProperties: false } };
}

function validateAgainst(obj, schema) {
  const errs = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['root is not an object'];
  for (const k of schema.required) if (!(k in obj)) errs.push(`missing required property "${k}"`);
  for (const k of Object.keys(obj)) if (!schema.properties[k]) errs.push(`unexpected property "${k}"`);
  if ('entities' in obj && !Array.isArray(obj.entities)) errs.push('"entities" must be an array');
  if ('summary' in obj && typeof obj.summary !== 'string') errs.push('"summary" must be a string');
  return errs;
}

function run(p) {
  const steps = [];
  const text = String(p.text || '').trim();
  const required = String(p.required || '').split(',').map(s => s.trim()).filter(Boolean);
  const isLLM = p.approach !== 'language';
  const model = MODELS[p.model] || MODELS['gpt-4.1-mini'];
  const r = rng(`${text}|${p.approach}|${p.temperature}|${p.model}`);
  const fail = (node, title, detail, data, out, summary) => {
    steps.push(step(node, title, detail, data, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: out }], metrics: [], summary, meta: { ok: false, ungrounded: 0 } };
  };

  if (!text) return fail('input', 'Empty document', 'The request contains no text. Both Azure Language and chat completions reject or return nothing useful for empty input.', { httpStatus: 400, code: 'InvalidDocument (illustrative)' }, 'Add text to analyse.', 'Rejected: empty input');
  steps.push(step('input', 'Document received', `${text.length} characters • ~${estTokens(text)} tokens (4-chars-per-token heuristic).`, { characters: text.length, approxTokens: estTokens(text) }));

  if (!p.role) return fail('auth', 'Authorization failed', `The app's managed identity has no data-plane role on the ${isLLM ? 'Foundry / Azure OpenAI' : 'Language'} resource. Key-less auth with DefaultAzureCredential needs a role such as ${isLLM ? '"Cognitive Services OpenAI User" (or "Azure AI User" on the Foundry project)' : '"Cognitive Services Language Reader" / "Cognitive Services User"'}.`,
    { httpStatus: 403, code: 'PermissionDenied', identity: 'app managed identity' }, 'The call was refused before any analysis. Assign the data-plane role to the identity (control-plane roles like Contributor are not enough).', 'Rejected: 403 missing role');
  steps.push(step('auth', 'Token acquired', 'DefaultAzureCredential → Microsoft Entra token; identity holds the required data-plane role.', { credential: 'DefaultAzureCredential' }));

  const ents = ner(text);
  const kps = keyPhrases(text);
  const tops = topics(text);
  const n = p.summaryLength === 'short' ? 1 : 2;
  const output = [];
  let finalObj = null, rawText = null, ungrounded = [], schemaErrs = [], parsed = true;

  if (!isLLM) {
    steps.push(step('language', 'Azure Language tasks', 'One analyze-text job ran three tasks: EntityRecognition, KeyPhraseExtraction and ExtractiveSummarization. Output shapes are fixed by the service.',
      { tasks: ['EntityRecognition', 'KeyPhraseExtraction', 'ExtractiveSummarization'], entities: ents.length, keyPhrases: kps }));
    finalObj = { entities: ents.map(e => ({ text: e.text, category: e.category })), topics: tops.length ? tops : kps.slice(0, 3), summary: summarize(text, n, false) };
    const missing = required.filter(f => CUSTOM_FIELDS.includes(f));
    steps.push(step('parse', 'Map service output to your contract', `Entities, key phrases (as topics) and summary sentences are mapped by your code. ${missing.length ? `Fields ${missing.join(', ')} have no equivalent in the prebuilt tasks.` : 'All requested fields have a prebuilt equivalent.'}`,
      { mapping: { entities: 'entities[].text/category', topics: 'keyPhrases (or your own topic rules)', summary: 'sentences[] (extractive)' } }, missing.length ? 'error' : 'ok'));
    if (missing.length) schemaErrs = missing.map(f => `"${f}" not produced by Azure Language prebuilt tasks`);
  } else {
    if (p.approach === 'schema' && !model.schema) {
      return fail('llm', 'Model rejected response_format', `${model.label} does not support structured outputs (json_schema). In this simulation the deployment returns HTTP 400. Structured outputs need a recent model version; check the model's capability list.`,
        { httpStatus: 400, param: 'response_format', model: model.label }, 'Choose a model version that supports structured outputs, or fall back to JSON mode + your own validation.', 'Rejected: model lacks structured outputs');
    }
    const schema = buildSchema(required);
    steps.push(step('llm', 'Chat completion', `${model.label} at temperature ${p.temperature}. ${APPROACHES[p.approach]}.`,
      { messages: [{ role: 'system', content: 'Extract entities, topics, summary and the requested fields. Use only facts in the text.' }, { role: 'user', content: text.slice(0, 80) + '…' }],
        response_format: p.approach === 'schema' ? { type: 'json_schema', json_schema: schema } : p.approach === 'json_object' ? { type: 'json_object' } : '(none)', temperature: p.temperature }));
    const obj = { entities: ents.map(e => ({ text: e.text, category: e.category })), topics: tops.length ? tops : kps.slice(0, 3), summary: summarize(text, n, true), ...customFields(text, ents) };
    if (p.temperature >= 1.0) {
      const h = HALLUCINATIONS.find(x => !text.toLowerCase().includes(x.text.toLowerCase()));
      if (h) obj.entities.push({ ...h });
    }
    for (const k of Object.keys(obj)) if (!schema.schema.properties[k]) delete obj[k];
    if (p.approach === 'prompt') {
      const broken = p.temperature >= 0.7 || r() < 0.4;
      const body = JSON.stringify(obj, null, 2);
      rawText = broken ? 'Sure! Here is the extracted data:\n```json\n' + body.replace(/\n}$/, ',\n}') + '\n```' : body;
    } else if (p.approach === 'json_object') {
      const drift = { ...obj };
      const victim = required.find(f => CUSTOM_FIELDS.includes(f)) || (p.temperature > 0.3 ? 'topics' : null);
      if (victim && (p.temperature > 0.3 || r() < 0.6)) { drift[victim.replace(/_(\w)/g, (_, c) => c.toUpperCase()) + (victim.includes('_') ? '' : 'List')] = drift[victim]; delete drift[victim]; }
      rawText = JSON.stringify(drift, null, 2);
    } else rawText = JSON.stringify(obj, null, 2);

    try { finalObj = JSON.parse(rawText); steps.push(step('parse', 'JSON.parse succeeded', p.approach === 'schema' ? 'Structured outputs constrain decoding to the schema, so the content is guaranteed to parse.' : 'The text happened to be valid JSON.', { characters: rawText.length })); }
    catch (e) {
      parsed = false;
      steps.push(step('parse', 'JSON.parse failed', `The model wrapped the JSON in prose / a code fence or left a trailing comma. Real error: ${e.message}. Without response_format nothing forces valid JSON.`, { error: e.message, firstChars: rawText.slice(0, 60) }, 'error'));
    }
    if (parsed) {
      schemaErrs = validateAgainst(finalObj, schema.schema);
      if (p.approach !== 'schema') steps.push(step('format', 'Schema validation (your code)', schemaErrs.length ? schemaErrs.join('; ') : 'Object matches the schema.', { errors: schemaErrs }, schemaErrs.length ? 'error' : 'ok'));
      else steps.push(step('format', 'Schema enforced by the service', 'strict: true requires every property to be listed in "required" and additionalProperties: false. Optional values are modelled as ["string","null"].', { required: schema.schema.required }));
    }
  }

  // Grounding check: every entity must have a span in the source text.
  if (finalObj && Array.isArray(finalObj.entities)) {
    const bad = finalObj.entities.filter(e => !text.toLowerCase().includes(String(e.text).toLowerCase()));
    if (p.groundCheck) {
      ungrounded = [];
      finalObj.entities = finalObj.entities.filter(e => !bad.includes(e));
      steps.push(step('ground', bad.length ? 'Ungrounded entities removed' : 'Grounding check passed', bad.length ? `Dropped ${bad.map(b => `"${b.text}"`).join(', ')}: no matching span in the source text.` : 'Every entity has a matching span in the source text.', { removed: bad }, bad.length ? 'info' : 'ok'));
    } else {
      ungrounded = bad;
      steps.push(step('ground', 'Grounding check off', 'Entities are trusted as returned.', null, 'skip'));
    }
  }

  // Final validation
  const problems = [...schemaErrs];
  if (!parsed) problems.push('output is not valid JSON');
  if (ungrounded.length) problems.push(`${ungrounded.length} entity value(s) with no support in the text: ${ungrounded.map(u => u.text).join(', ')}`);
  const vStatus = !parsed || schemaErrs.length ? 'error' : ungrounded.length ? 'warn' : 'ok';
  steps.push(step('validate', vStatus === 'ok' ? 'Ready for downstream system' : vStatus === 'warn' ? 'Passed schema, but content is unreliable' : 'Rejected by validation', problems.length ? problems.join('; ') : 'Valid, complete and grounded.', { problems }, vStatus));

  // Output blocks
  const shown = finalObj && Array.isArray(finalObj.entities) ? finalObj.entities : ents;
  const toks = text.split(/\s+/).slice(0, 90);
  let pos = 0;
  const cells = toks.map(t => {
    const off = text.indexOf(t, pos); pos = off + t.length;
    const e = ents.find(x => off >= x.offset && off < x.offset + x.length && shown.some(s => s.text === x.text));
    return { v: t, tone: e ? CAT_TONE[e.category] : undefined, label: e ? e.category : '' };
  }).map(c => (c.tone ? c : { v: c.v, label: c.label }));
  output.push({ type: 'grid', title: 'Source text with recognised entities', cols: 10, cells, caption: 'Blue = Person/Product, green = Organization, amber = Location, grey = Date/Quantity, red = Email. Hover a word for its category.' });
  output.push({ type: 'table', title: 'Entities', columns: ['Text', 'Category', 'Offset', isLLM ? 'Grounded in text?' : 'Confidence (simulated)'],
    rows: (finalObj && Array.isArray(finalObj.entities) ? finalObj.entities : ents).map(e => { const src = ents.find(x => x.text === e.text); return [e.text, e.category, src ? String(src.offset) : '—', isLLM ? (src ? 'yes' : 'NO') : (src ? src.confidence.toFixed(2) : '—')]; }),
    tones: (finalObj && Array.isArray(finalObj.entities) ? finalObj.entities : ents).map(e => (text.toLowerCase().includes(String(e.text).toLowerCase()) ? 'ok' : 'error')) });
  output.push({ type: 'kv', title: 'Topics and key phrases', items: [['Topics', tops.join(', ') || '—'], ['Key phrases', kps.join(', ') || '—'], ['Summary type', isLLM ? 'abstractive (model-written)' : 'extractive (selected source sentences)']] });
  if (finalObj && typeof finalObj.summary === 'string') output.push({ type: 'text', title: 'Summary', text: finalObj.summary });
  if (rawText != null) output.push({ type: 'code', title: 'Raw model output (message.content)', lang: 'json', text: rawText });
  if (finalObj) output.push({ type: 'json', title: isLLM ? 'Parsed object handed to your app' : 'Your contract, mapped from Language results', data: finalObj });
  output.push({ type: 'alert', tone: vStatus === 'ok' ? 'ok' : vStatus, text: vStatus === 'ok' ? 'Output is valid, complete and every entity is grounded in the source.' : problems.join(' • ') });

  const reqOk = required.filter(f => finalObj && f in finalObj && finalObj[f] != null).length;
  return {
    steps, output,
    metrics: [
      metric('Entities returned', String(shown.length), 'computed'),
      metric('Required fields present', `${reqOk}/${required.length}`, 'computed'),
      metric('Ungrounded entities', String(ungrounded.length), 'computed', 'Entities with no matching span in the input text.'),
      metric('Prompt size', `~${estTokens(text) + (isLLM ? 120 : 0)} tokens`, 'estimate', '4-chars-per-token heuristic; LLM adds ~120 tokens of instructions and schema in this simulation. Language bills per text record, not tokens; see pricing pages.'),
    ],
    summary: `${APPROACHES[p.approach]}${isLLM ? ' • ' + model.label + ' t=' + p.temperature : ''}: ${vStatus === 'ok' ? 'valid' : problems.length + ' problem(s)'}`,
    meta: { ok: vStatus === 'ok', ungrounded: ungrounded.length },
  };
}

export default {
  id: '4.1.1',
  lab: 'Text extraction workbench',
  services: [
    { name: 'Azure Language in Foundry Tools: named entity recognition', url: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/named-entity-recognition/overview' },
    { name: 'Azure Language: summarization', url: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/summarization/overview' },
    { name: 'Azure OpenAI structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
  ],
  prereqs: ['2.1.1', '2.3.1'],
  next: ['4.1.2', '4.1.4', '5.2.3'],

  concept: {
    plain: 'Software needs facts from free text in a predictable shape: who, which company, what date, how much, what it is about, and a short summary. You can ask a ready-made language service that always returns the same shape, or ask a language model, which is more flexible but must be forced to return valid JSON and checked so it does not invent facts that are not in the text.',
    technical: 'Azure Language in Foundry Tools offers prebuilt tasks (EntityRecognition, KeyPhraseExtraction, extractive/abstractive summarization) with fixed output shapes, offsets and confidence scores. With Azure OpenAI models in Foundry you prompt for extraction and constrain the output: response_format {type: "json_object"} guarantees parseable JSON but not your schema; {type: "json_schema", json_schema: {strict: true, schema}} (structured outputs) constrains decoding to the schema, which requires all properties in "required" and additionalProperties: false. Either way, validate in code and check that extracted values are grounded in the source.',
    useCase: 'A retailer routes 20,000 support emails a day. Each email is turned into JSON {customer, reference_id, amount, due_date, entities, topics, summary} that a Logic App writes to Dynamics. Prebuilt NER covers names, dates and money; the custom fields come from a structured-outputs call; a grounding check drops any value that does not appear in the email.',
    terms: [
      ['NER', 'Named entity recognition: finding spans such as Person, Organization, Location, DateTime, Quantity, with category and offset.'],
      ['Key phrases', 'Salient noun phrases in a document; a cheap proxy for topics.'],
      ['JSON mode', 'response_format json_object: the model must emit syntactically valid JSON; keys and types are not enforced.'],
      ['Structured outputs', 'response_format json_schema with strict: true: output conforms to the supplied JSON Schema.'],
      ['Grounding check', 'Your own post-check that each extracted value has evidence in the input text.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: 'Free text', col: 0, row: 1, kind: 'data', detail: 'Email, article or meeting notes.' },
          { id: 'language', label: 'Prebuilt NLP tasks', col: 1, row: 0, kind: 'ai', disabled: p && p.approach !== 'language', detail: 'Fixed-shape results: entities with offsets, key phrases, summary sentences.', substeps: ['Entity recognition', 'Key phrase extraction', 'Summarization'] },
          { id: 'llm', label: 'Prompted LLM', col: 1, row: 2, kind: 'ai', disabled: p && p.approach === 'language', badge: p && p.approach !== 'language' ? `t=${p.temperature}` : undefined, detail: 'Flexible fields defined by your instructions and schema.', substeps: ['System prompt', 'Schema', 'Decode'] },
          { id: 'parse', label: 'Parse / map', col: 2, row: 1, detail: 'Turn the response into your object.' },
          { id: 'format', label: 'Schema check', col: 3, row: 0, kind: 'policy', detail: 'Enforced by the service (strict json_schema) or by your code.' },
          { id: 'ground', label: 'Grounding check', col: 3, row: 2, kind: 'policy', disabled: p && !p.groundCheck, detail: 'Each value must appear in the source text.' },
          { id: 'validate', label: 'Downstream system', col: 4, row: 1, kind: 'app', detail: 'CRM, ticketing, analytics.' },
        ],
        edges: [['input', 'language'], ['input', 'llm'], ['language', 'parse'], ['llm', 'parse'], ['parse', 'format'], ['parse', 'ground'], ['format', 'validate'], ['ground', 'validate']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'Service Bus queue (emails)', col: 0, row: 1, kind: 'store', detail: 'Messages to process.' },
          { id: 'auth', label: 'Microsoft Entra ID', col: 1, row: 0, kind: 'policy', badge: p && !p.role ? 'no role' : undefined, detail: 'Managed identity token. Needs a data-plane role on the target resource.' },
          { id: 'parse', label: 'Azure Function', col: 1, row: 2, kind: 'compute', detail: 'Calls the extraction service, parses and validates.' },
          { id: 'language', label: 'Azure Language (Foundry Tools)', col: 2, row: 1, kind: 'ai', disabled: p && p.approach !== 'language', detail: 'analyze-text jobs.' },
          { id: 'llm', label: `Foundry model deployment: ${p ? (MODELS[p.model] || {}).label : 'gpt-4.1-mini'}`, col: 2, row: 3, kind: 'ai', disabled: p && p.approach === 'language', detail: 'Chat completions with response_format.' },
          { id: 'validate', label: 'Dynamics / Cosmos DB', col: 4, row: 2, kind: 'store', detail: 'Validated records only; failures to a dead-letter queue.' },
        ],
        edges: [['input', 'parse'], ['parse', 'auth', 'token'], ['parse', 'language'], ['parse', 'llm'], ['parse', 'validate']],
      }),
      implementation: p => ({
        nodes: p && p.approach === 'language' ? [
          { id: 'auth', label: 'client = TextAnalyticsClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'azure-ai-textanalytics. Illustrative.' },
          { id: 'language', label: 'poller = client.begin_analyze_actions(docs, [RecognizeEntitiesAction(), ExtractKeyPhrasesAction(), ExtractiveSummaryAction()])', col: 0, row: 1, kind: 'code', detail: 'Multiple tasks in one long-running job.' },
          { id: 'parse', label: 'for r in poller.result(): map entities / key_phrases / sentences', col: 0, row: 2, kind: 'code', detail: 'Each entity has text, category, offset, confidence_score.' },
          { id: 'validate', label: 'if missing_fields: send_to_llm_or_review()', col: 0, row: 3, kind: 'code', detail: 'Your rules.' },
        ] : [
          { id: 'auth', label: 'client = AzureOpenAI(azure_endpoint, azure_ad_token_provider=token_provider, api_version=...)', col: 0, row: 0, kind: 'code', detail: 'openai package against the Foundry endpoint; token from DefaultAzureCredential.' },
          { id: 'llm', label: `r = client.chat.completions.create(model="${p ? p.model : 'gpt-4.1-mini'}", messages=..., response_format=${p && p.approach === 'schema' ? '{"type":"json_schema", ...strict}' : p && p.approach === 'json_object' ? '{"type":"json_object"}' : 'None'})`, col: 0, row: 1, kind: 'code', detail: 'The SDK also offers client.beta.chat.completions.parse(response_format=PydanticModel). Illustrative.' },
          { id: 'parse', label: 'data = json.loads(r.choices[0].message.content)', col: 0, row: 2, kind: 'code', detail: 'Check finish_reason and refusal first.' },
          { id: 'format', label: 'jsonschema.validate(data, SCHEMA)', col: 0, row: 3, kind: 'code', detail: 'Needed unless strict structured outputs are used.' },
          { id: 'ground', label: 'data["entities"] = [e for e in data["entities"] if e["text"] in source]', col: 0, row: 4, kind: 'code', detail: 'Cheap grounding check.' },
          { id: 'validate', label: 'crm.upsert(data)', col: 0, row: 5, kind: 'code', detail: 'Only validated, grounded data.' },
        ],
        edges: p && p.approach === 'language' ? [['auth', 'language'], ['language', 'parse'], ['parse', 'validate']] : [['auth', 'llm'], ['llm', 'parse'], ['parse', 'format'], ['format', 'ground'], ['ground', 'validate']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'text', label: 'Input text', type: 'textarea', default: SAMPLES.support },
      { id: 'approach', label: 'Extraction approach', type: 'select', options: Object.entries(APPROACHES), default: 'schema' },
      { id: 'model', label: 'Model deployment (LLM approaches)', type: 'select', options: Object.entries(MODELS).map(([v, m]) => [v, m.label]), default: 'gpt-4.1-mini' },
      { id: 'temperature', label: 'Temperature', type: 'range', min: 0, max: 1.5, step: 0.1, default: 0.2 },
      { id: 'required', label: 'Required fields (entities, topics, summary, customer, reference_id, amount, due_date)', type: 'text', default: 'entities,topics,summary' },
      { id: 'summaryLength', label: 'Summary length', type: 'select', options: [['short', '1 sentence'], ['medium', '2 sentences']], default: 'short' },
      { id: 'groundCheck', label: 'Grounding check on entities', type: 'toggle', default: false },
      { id: 'role', label: 'Identity has data-plane role', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'Support email → schema JSON', values: { text: SAMPLES.support, approach: 'schema', required: 'entities,topics,summary,customer,reference_id,amount,due_date' } },
      { label: 'News article → Azure Language', values: { text: SAMPLES.news, approach: 'language', required: 'entities,topics,summary' } },
      { label: 'Meeting notes → JSON mode', values: { text: SAMPLES.meeting, approach: 'json_object', required: 'entities,summary,due_date' } },
      { label: 'Prompt-only JSON, creative temperature', values: { text: SAMPLES.support, approach: 'prompt', temperature: 0.9 } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the support email with each approach (prompt-only, JSON mode, json_schema) and compare whether the raw output parses and validates.',
      'Run the news article with Azure Language and with structured outputs: compare the summary (extractive vs abstractive) and entity offsets.',
      'Raise temperature to 1.2 with json_schema and compare grounding check off vs on.',
    ],
  },

  debug: [
    { id: 'invalidjson', title: 'JSON.parse throws in production', values: { approach: 'prompt', temperature: 0.9, text: SAMPLES.support }, node: 'parse',
      symptom: 'SyntaxError: the response starts with "Sure! Here is…" and has a trailing comma.', cause: 'JSON was requested only in the prompt. Nothing constrains the decoder.', fix: 'Use response_format json_schema with strict: true (or at least json_object) and validate.' },
    { id: 'missingprop', title: 'Valid JSON, but the CRM insert fails', values: { approach: 'json_object', required: 'entities,summary,due_date', text: SAMPLES.meeting, temperature: 0.7 }, node: 'format',
      symptom: 'Validation error: missing required property "due_date" (the model returned "dueDate").', cause: 'JSON mode guarantees syntax, not your keys or types.', fix: 'Switch to json_schema with strict: true so the schema is enforced during generation.' },
    { id: 'hallucinated', title: 'Entity that is not in the email', values: { approach: 'schema', temperature: 1.2, groundCheck: false, text: SAMPLES.support }, node: 'ground',
      symptom: 'Entities include "Microsoft", which the customer never mentioned. Schema validation still passes.', cause: 'Structured outputs fix the shape, not the truth. High temperature encourages world-knowledge additions.', fix: 'Turn on the grounding check (and lower temperature for extraction).' },
    { id: 'oldmodel', title: 'HTTP 400 on response_format', values: { approach: 'schema', model: 'legacy' }, node: 'llm',
      symptom: 'The deployment rejects the json_schema response format.', cause: 'Unsuitable model: older model versions do not support structured outputs.', fix: 'Deploy a model version that supports structured outputs (e.g. gpt-4.1-mini).' },
    { id: 'language-custom', title: 'Language results lack business fields', values: { approach: 'language', required: 'entities,customer,amount' }, node: 'parse',
      symptom: '"customer" and "amount" are not produced.', cause: 'Prebuilt tasks have fixed output shapes; custom business fields need mapping code, custom NER, or an LLM.', fix: 'Use structured outputs for custom fields (or keep only prebuilt fields as required).' },
    { id: 'role', title: '403 from the extraction endpoint', values: { role: false }, node: 'auth',
      symptom: 'PermissionDenied before any analysis.', cause: 'The managed identity has no data-plane role on the resource.', fix: 'Assign the data-plane role (here: switch "Identity has data-plane role" on).' },
  ],

  challenge: {
    task: 'Produce a fully valid, grounded JSON record for the support email, including customer, reference_id, amount and due_date, while keeping temperature at 1.0 or higher (a team wants more fluent summaries).',
    condition: 'Required fields include customer, reference_id, amount and due_date; temperature ≥ 1.0; the final step is "Ready for downstream system" with no warnings.',
    hint: 'One control fixes the shape, another removes facts that are not in the text.',
    check: (p, res) => ['customer', 'reference_id', 'amount', 'due_date'].every(f => String(p.required).includes(f)) && p.temperature >= 1 && res.meta && res.meta.ok && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Approach: json_schema with strict: true on gpt-4.1-mini.', 'Required: entities,topics,summary,customer,reference_id,amount,due_date.', 'Temperature 1.0+ adds a world-knowledge entity, so turn the grounding check on.', 'Run: the invented entity is dropped and the record validates.'],
    solutionValues: { text: SAMPLES.support, approach: 'schema', model: 'gpt-4.1-mini', temperature: 1.1, required: 'entities,topics,summary,customer,reference_id,amount,due_date', groundCheck: true, role: true },
  },

  quiz: [
    { q: 'Your Function parses LLM output with json.loads and fails about 3% of the time because of prose around the JSON. You need syntactically valid JSON that also matches your Pydantic schema. What do you change?', options: ['Add "ONLY JSON!" to the prompt', 'Use response_format json_schema with strict: true', 'Use response_format json_object and hope keys match', 'Lower max_tokens'], answer: 1, why: 'Strict structured outputs constrain generation to the schema. JSON mode only guarantees syntax; prompt wording guarantees neither.' },
    { q: 'You need entity offsets and confidence scores for Person, Organization and DateTime in 50 languages at low cost, with no custom fields. Which option fits best?', options: ['Azure Language named entity recognition', 'A fine-tuned LLM', 'gpt-4.1 with a long few-shot prompt', 'Azure AI Search semantic ranker'], answer: 0, why: 'Prebuilt NER returns exactly that shape (category, offset, length, confidence) without prompt engineering.' },
    { q: 'Structured outputs return schema-valid JSON, but auditors find organisation names that never appear in the source emails. What is the most direct mitigation?', options: ['Increase temperature', 'Add a grounding check that drops values without a matching span, and lower temperature', 'Switch to JSON mode', 'Remove the schema'], answer: 1, why: 'Schemas constrain shape, not truth. Verify values against the source and keep extraction temperature low.' },
    { q: 'You define a strict json_schema with an optional "due_date". The request is rejected. What is the likely cause?', options: ['Strict mode needs every property in "required"; model optionality as type ["string","null"]', 'due_date must be a number', 'Strict mode allows only one property', 'You must also set temperature to 0'], answer: 0, why: 'Strict structured outputs require all properties listed as required and additionalProperties: false; nullable types express optional values.' },
  ],

  recap: 'Use Azure Language prebuilt tasks when their fixed shapes (entities, key phrases, summaries with offsets and confidence) cover your needs. Use an LLM for custom fields, but constrain it with strict json_schema, validate in code, keep temperature low, and check that every value is grounded in the source text.',
};
