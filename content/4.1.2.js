// 4.1.2 Configure detection of sentiment, tone, safety issues, and sensitive content
// Lab: Sentiment, tone & PII detector.
import { rng, round, step, metric } from '../src/engine/util.js';

const SAMPLES = {
  chat: 'Hi, I am Alex Turner and my order still has not arrived. Great, another delay, exactly what I needed. The delivery driver was polite but the tracking app is useless. My card 4111 1111 1111 1111 was charged twice. Call me on +44 7700 900123 or email alex.turner@contoso.example, Jordan from your team never replied.',
  review: 'The battery life is excellent and the screen is gorgeous. Support was slow, though, and the price feels too high. Overall I love this laptop.',
  spanish: 'El servicio fue terrible y la entrega llegó tarde otra vez. La pantalla es muy buena, pero el soporte no responde. Me llamo Lucía García, mi correo es lucia.garcia@fabrikam.example.',
  threat: 'This is the third time my refund was refused. If this is not fixed today I will come to your store and smash every screen in it. Thanks for nothing.',
};

const LEX = {
  en: { pos: { excellent: 2, gorgeous: 2, love: 2, great: 1.5, polite: 1, good: 1, fast: 1, helpful: 1.5, thanks: 0.5 }, neg: { useless: 2, slow: 1.5, terrible: 2, delay: 1, refused: 1.5, twice: 1, never: 1, high: 0.8, broken: 1.5, smash: 1.5, nothing: 0.8, not: 0.5 } },
  es: { pos: { buena: 1.5, excelente: 2, bien: 1, encanta: 2 }, neg: { terrible: 2, tarde: 1, 'no': 0.8, mala: 1.5, lento: 1.5 } },
};
const ASPECTS = { en: ['battery life', 'screen', 'support', 'price', 'delivery driver', 'tracking app', 'order', 'refund', 'laptop'], es: ['servicio', 'entrega', 'pantalla', 'soporte'] };
const STOPWORDS = { en: ['the', 'and', 'is', 'my', 'was', 'but', 'it', 'to', 'this', 'of'], es: ['el', 'la', 'de', 'que', 'y', 'es', 'muy', 'pero', 'mi', 'me', 'fue'] };
const SAFETY = { Violence: [[/\b(smash|kill|hurt|beat)\b/i, 4]], Hate: [], Sexual: [], SelfHarm: [[/\b(end it all|hurt myself)\b/i, 4]] };
const PII_RULES = [
  { cat: 'Email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, conf: 0.99 },
  { cat: 'CreditCardNumber', re: /\b(?:\d[ -]?){12,15}\d\b/g, conf: 0.95, luhn: true },
  { cat: 'PhoneNumber', re: /\+\d{1,3}[\s-]?\d{3,4}[\s-]?\d{3}[\s-]?\d{3,4}/g, conf: 0.85 },
  { cat: 'Person', re: /\b(?:Alex Turner|Lucía García|Maria Lopez)\b/g, conf: 0.93 },
  { cat: 'Person', re: /\bJordan\b/g, conf: 0.62 },
];
const AUTH = { entra: 'Entra ID (managed identity with role)', key: 'API key', 'key-disabled': 'API key, but local auth disabled on resource', 'entra-norole': 'Entra ID, identity has no role' };

const luhn = s => { const d = s.replace(/\D/g, '').split('').reverse().map(Number); return d.reduce((a, n, i) => a + (i % 2 ? (n * 2 > 9 ? n * 2 - 9 : n * 2) : n), 0) % 10 === 0; };
const detectLang = t => { const w = t.toLowerCase().match(/[a-záéíóúñ]+/g) || []; const s = l => w.filter(x => STOPWORDS[l].includes(x)).length; return s('es') > s('en') ? 'es' : 'en'; };

function sentiment(sentence, lang) {
  const lex = LEX[lang]; const w = sentence.toLowerCase().match(/[a-záéíóúñ]+/g) || [];
  let pos = 0, neg = 0;
  w.forEach((x, i) => { const negated = i > 0 && ['not', 'never', 'no'].includes(w[i - 1]); if (lex.pos[x]) negated ? (neg += lex.pos[x]) : (pos += lex.pos[x]); if (lex.neg[x]) neg += lex.neg[x]; });
  const tot = pos + neg + 1;
  const scores = { positive: round(pos / tot, 2), negative: round(neg / tot, 2), neutral: round(1 / tot, 2) };
  const label = pos > 0 && neg > 0 && Math.abs(pos - neg) < 1 ? 'mixed' : pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral';
  return { label, scores };
}

function run(p) {
  const steps = [];
  const text = String(p.text || '').trim();
  const r = rng(`${text}|${p.language}`);
  if (!text) {
    steps.push(step('input', 'Empty document', 'Nothing to analyse; the service returns an error for empty documents.', { code: 'InvalidDocument (illustrative)' }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Add text to analyse.' }], metrics: [], summary: 'Empty input', meta: {} };
  }
  steps.push(step('input', 'Document received', `${text.length} characters.`, { characters: text.length }));

  if (p.auth === 'key-disabled' || p.auth === 'entra-norole') {
    const kd = p.auth === 'key-disabled';
    steps.push(step('auth', kd ? '401: key authentication disabled' : '403: identity lacks a data-plane role', kd ? 'The resource has disableLocalAuth = true, so API keys are refused. Use Microsoft Entra ID.' : 'Token is valid but the identity has no role such as "Cognitive Services Language Reader" / "Cognitive Services User" on the Language and Content Safety resources.', { httpStatus: kd ? 401 : 403 }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Nothing was analysed. Fix authentication first.' }], metrics: [], summary: `Auth failure (${AUTH[p.auth]})`, meta: {} };
  }
  steps.push(step('auth', 'Authenticated', AUTH[p.auth] + (p.auth === 'key' ? ' (works, but prefer keyless Entra ID in production).' : '.'), { method: p.auth }, p.auth === 'key' ? 'info' : 'ok'));

  // Language detection / configuration
  const actual = detectLang(text);
  const used = p.language === 'auto' ? actual : p.language;
  const mismatch = used !== actual;
  steps.push(step('detect', p.language === 'auto' ? `Language detected: ${actual}` : mismatch ? `Configured language "${p.language}" does not match the text` : `Language: ${used}`,
    mismatch ? 'In this simulation the analysis runs with the wrong language model: sentiment collapses to neutral and aspect terms are missed. Real services degrade similarly; pass the correct language hint or detect it first.' : 'Language hint matches the text.',
    { configured: p.language, detected: actual, confidenceScore: p.language === 'auto' ? round(0.9 + r() * 0.09, 2) : null }, mismatch ? 'warn' : 'ok'));

  // Sentiment + opinion mining
  const sents = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const sres = sents.map(s => ({ text: s, ...(mismatch ? { label: 'neutral', scores: { positive: 0.05, neutral: 0.9, negative: 0.05 } } : sentiment(s, used)) }));
  const count = l => sres.filter(s => s.label === l).length;
  const docLabel = count('positive') && count('negative') ? 'mixed' : count('negative') ? 'negative' : count('positive') ? 'positive' : 'neutral';
  const opinions = [];
  if (p.opinionMining && !mismatch) {
    for (const s of sres) for (const a of ASPECTS[used]) if (s.text.toLowerCase().includes(a)) {
      const lex = LEX[used]; const w = s.text.toLowerCase().match(/[a-záéíóúñ]+/g) || [];
      const at = w.indexOf(a.split(' ')[0]);
      const cands = w.map((x, i) => [x, Math.abs(i - at) + (i < at ? 0.5 : 0)]).filter(([x]) => lex.pos[x] || lex.neg[x]).sort((x, y) => x[1] - y[1]);
      const ass = cands.length ? cands[0][0] : null;
      if (ass) opinions.push({ target: a, assessment: ass, sentiment: lex.pos[ass] ? 'positive' : 'negative' });
    }
  }
  steps.push(step('sentiment', `Document sentiment: ${docLabel}`, `${sres.length} sentences scored.${p.opinionMining ? ` Opinion mining found ${opinions.length} target/assessment pair(s).` : ' Opinion mining off (sentence level only).'}`,
    { documentSentiment: docLabel, sentences: sres.map(s => ({ text: s.text.slice(0, 50), sentiment: s.label, confidenceScores: s.scores })), opinions }));

  // Tone (LLM)
  const sarcastic = sres.filter(s => /\b(great|perfect|wonderful|thanks for nothing|exactly what i needed)\b/i.test(s.text) && /\b(delay|another|nothing|again|needed)\b/i.test(s.text));
  const tones = [];
  if (/\b(today|immediately|asap|urgent)\b/i.test(text)) tones.push('urgent');
  if (/\b(still|again|third time|twice|never)\b/i.test(text) || /otra vez/i.test(text)) tones.push('frustrated');
  if (sarcastic.length) tones.push('sarcastic');
  if (/\b(please|thank you)\b/i.test(text) && !sarcastic.length) tones.push('polite');
  const sarcasmMisread = sarcastic.filter(s => sres.find(x => x.text === s.text).label !== 'negative');
  if (p.tone) steps.push(step('tone', `Tone (LLM): ${tones.join(', ') || 'neutral'}`, `A small chat model classified tone with a fixed label set. ${sarcastic.length ? `It flagged sarcasm in "${sarcastic[0].text}" that sentence-level sentiment scored as ${sres.find(x => x.text === sarcastic[0].text).label}.` : ''}`, { labels: tones, prompt: 'Classify tone. Labels: urgent, frustrated, sarcastic, polite, neutral. Return JSON.' }));
  else steps.push(step('tone', 'Tone analysis off', sarcasmMisread.length ? `Sentiment scored the sarcastic sentence "${sarcasmMisread[0].text}" as ${sres.find(x => x.text === sarcasmMisread[0].text).label}, not negative. Nothing else in the pipeline catches it.` : 'Only lexical sentiment is available.', null, sarcasmMisread.length ? 'warn' : 'skip'));

  // Content Safety
  const cats = Object.entries(SAFETY).map(([c, rules]) => { let sev = 0; for (const [re, s] of rules) if (re.test(text)) sev = Math.max(sev, s); return { category: c, severity: sev }; });
  const blocked = cats.filter(c => c.severity >= p.safetyThreshold);
  const under = cats.filter(c => c.severity >= 2 && c.severity < p.safetyThreshold);
  steps.push(step('safety', blocked.length ? `Content Safety: blocked (${blocked.map(b => b.category).join(', ')})` : under.length ? `Content Safety: allowed despite ${under.map(u => `${u.category} severity ${u.severity}`).join(', ')}` : 'Content Safety: allowed',
    `Text categories analysed with severity levels 0/2/4/6; your policy blocks severity ≥ ${p.safetyThreshold}.${blocked.length ? ' Message is held and routed to the security queue.' : under.length ? ' Harmful content was detected but is below your blocking threshold, so it flows on to agents.' : ''}`,
    { categoriesAnalysis: cats }, blocked.length || under.length ? 'warn' : 'ok'));

  // PII detection & redaction
  const wanted = String(p.piiCategories || '').split(',').map(s => s.trim()).filter(Boolean);
  const found = [];
  for (const rule of PII_RULES) { rule.re.lastIndex = 0; let m; while ((m = rule.re.exec(text))) { if (rule.luhn && !luhn(m[0])) continue; found.push({ text: m[0], category: rule.cat, offset: m.index, confidence: rule.conf }); } }
  const redact = found.filter(f => (!wanted.length || wanted.includes(f.category)) && f.confidence >= p.piiThreshold);
  let red = text;
  for (const f of [...redact].sort((a, b) => b.offset - a.offset)) {
    const rep = p.redaction === 'entityMask' ? `[${f.category.toUpperCase()}]` : p.redaction === 'characterMask' ? '*'.repeat(f.text.length) : f.text;
    red = red.slice(0, f.offset) + rep + red.slice(f.offset + f.text.length);
  }
  steps.push(step('pii', `PII: ${found.length} found, ${p.redaction === 'noMask' ? 0 : redact.length} redacted`, `Categories: ${wanted.length ? wanted.join(', ') : 'all default categories'}; minimum confidence ${p.piiThreshold}; redaction policy ${p.redaction}.`,
    { entities: found.map(f => ({ ...f, redacted: redact.includes(f) && p.redaction !== 'noMask' })), redactionPolicy: { policyKind: p.redaction } }));

  // Leak scan (your own regression guard on the text that will be stored)
  const stored = p.redaction === 'noMask' ? text : red;
  const leaks = found.filter(f => stored.includes(f.text));
  const hardLeaks = leaks.filter(l => l.category !== 'Person' || l.confidence > 0.8);
  steps.push(step('store', leaks.length ? `Leak scan: ${leaks.length} PII value(s) in stored text` : 'Leak scan clean', leaks.length ? leaks.map(l => `${l.category} "${l.text}" (${!wanted.length || wanted.includes(l.category) ? (p.redaction === 'noMask' ? 'noMask policy' : `confidence ${l.confidence} < ${p.piiThreshold}`) : 'category not requested'})`).join('; ') : 'No detected PII remains in the text written to the analytics store.',
    { leaks }, hardLeaks.length ? 'error' : leaks.length ? 'warn' : 'ok'));

  // Output
  const cells = text.split(/\s+/).slice(0, 80).map(t => {
    const pii = found.find(f => f.text.split(/\s+/).some(x => x && t.includes(x)));
    const asp = opinions.find(o => o.target.split(' ').some(x => t.toLowerCase().includes(x)));
    if (pii) return { v: t, tone: 'error', label: pii.category };
    if (asp) return { v: t, tone: asp.sentiment === 'positive' ? 'ok' : 'warn', label: `aspect: ${asp.target}` };
    return { v: t };
  });
  const output = [
    { type: 'grid', title: 'Highlighted text', cols: 10, cells, caption: 'Red = PII, green/amber = aspect with positive/negative opinion.' },
    { type: 'table', title: `Sentence sentiment (document: ${docLabel})`, columns: ['Sentence', 'Label', 'pos / neu / neg'], rows: sres.map(s => [s.text, s.label + (sarcastic.some(x => x.text === s.text) && p.tone ? ' (sarcastic per LLM)' : ''), `${s.scores.positive} / ${s.scores.neutral} / ${s.scores.negative}`]), tones: sres.map(s => (s.label === 'positive' ? 'ok' : s.label === 'negative' ? 'warn' : undefined)).map(t => t || 'info') },
  ];
  if (opinions.length) output.push({ type: 'table', title: 'Opinion mining (aspect-based)', columns: ['Target', 'Assessment', 'Sentiment'], rows: opinions.map(o => [o.target, o.assessment, o.sentiment]), tones: opinions.map(o => (o.sentiment === 'positive' ? 'ok' : 'warn')) });
  if (p.tone) output.push({ type: 'kv', title: 'Tone (LLM classification)', items: [['Labels', tones.join(', ') || 'neutral'], ['Sarcasm', sarcastic.length ? 'yes' : 'no']] });
  output.push({ type: 'bars', title: 'Content Safety severity by category', threshold: p.safetyThreshold / 6, items: cats.map(c => ({ label: c.category, value: c.severity, max: 6, tone: c.severity >= p.safetyThreshold ? 'error' : 'ok', note: `severity ${c.severity}` })) });
  output.push({ type: 'diff', title: 'Stored text (after redaction)', before: text, after: stored });
  output.push({ type: 'alert', tone: hardLeaks.length ? 'error' : leaks.length ? 'warn' : 'ok', text: hardLeaks.length ? 'Sensitive data would be written to the analytics store.' : leaks.length ? 'A low-confidence name is still visible. Decide whether your threshold is too strict.' : 'No detected PII reaches storage.' });

  return {
    steps, output,
    metrics: [
      metric('Document sentiment', docLabel, 'computed'),
      metric('PII entities redacted', `${p.redaction === 'noMask' ? 0 : redact.length}/${found.length}`, 'computed'),
      metric('Safety categories over threshold', String(blocked.length), 'computed'),
      metric('Calls per message', String(2 + (p.tone ? 1 : 0)), 'estimate', 'Language (sentiment + PII, can be one analyze job) + Content Safety + optional LLM call. Each is billed separately; see pricing pages.'),
    ],
    summary: `${docLabel} • tone ${p.tone ? tones.join('/') || 'neutral' : 'off'} • ${leaks.length} PII leak(s) • ${blocked.length ? 'blocked' : 'allowed'}`,
    meta: { leaks: leaks.length, sarcasmFlagged: p.tone && sarcastic.length > 0, blocked: blocked.length > 0, mismatch },
  };
}

export default {
  id: '4.1.2',
  lab: 'Sentiment, tone & PII detector',
  services: [
    { name: 'Azure Language: sentiment analysis and opinion mining', url: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/sentiment-opinion-mining/overview' },
    { name: 'Azure Language: PII detection', url: 'https://learn.microsoft.com/en-us/azure/ai-services/language-service/personally-identifiable-information/overview' },
    { name: 'Azure AI Content Safety: harm categories', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/harm-categories' },
  ],
  prereqs: ['4.1.1', '1.4.1'],
  next: ['4.1.4', '1.4.2'],

  concept: {
    plain: 'Before you store or act on customer messages you usually want to know four things: is the person happy or unhappy (and about what), how are they saying it (urgent, sarcastic), is anything harmful in it, and does it contain personal data you must hide. Each question has its own detector and its own settings, and each can be wrong in its own way.',
    technical: 'Azure Language sentiment analysis returns document- and sentence-level labels (positive, neutral, negative, mixed) with confidence scores; opinionMining=true adds aspect-level targets and assessments. Tone beyond sentiment (sarcasm, urgency) is typically a constrained LLM classification. Azure AI Content Safety text analysis returns severities for Hate, Sexual, Violence and SelfHarm that you compare with your own thresholds. Language PII detection returns entities with category, offset and confidence plus redacted text; you can restrict piiCategories and choose a redaction policy (character mask, entity mask, or no mask; available options depend on API version). Pass the correct language or detect it first.',
    useCase: 'A telecom ingests chat transcripts into an analytics lake. Every message is scored for sentiment and aspects (billing, coverage), tone flags escalate sarcastic or urgent customers, Content Safety flags threats for the security team, and PII is redacted before the text is stored, with a leak scan as a final guard.',
    terms: [
      ['Opinion mining', 'Aspect-based sentiment: target (e.g. "battery life") plus assessment ("excellent") and its polarity.'],
      ['Severity', 'Content Safety score per harm category (0, 2, 4, 6 in the default output); you choose the blocking threshold.'],
      ['PII category', 'Type of personal data, e.g. Person, Email, PhoneNumber, CreditCardNumber.'],
      ['Redaction policy', 'How detected PII is masked: characters (****), entity type ([EMAIL]) or not at all.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: 'Message', col: 0, row: 1.5, kind: 'data', detail: 'Chat, review or email.' },
          { id: 'detect', label: 'Language', col: 1, row: 1.5, badge: p ? p.language : undefined, detail: 'Wrong language = wrong lexicons and models.' },
          { id: 'sentiment', label: 'Sentiment + opinions', col: 2, row: 0, kind: 'ai', badge: p && p.opinionMining ? 'aspects' : undefined, detail: 'Document, sentence and aspect level.' },
          { id: 'tone', label: 'Tone (LLM)', col: 2, row: 1, kind: 'ai', disabled: p && !p.tone, detail: 'Sarcasm, urgency, frustration.' },
          { id: 'safety', label: 'Content Safety', col: 2, row: 2, kind: 'policy', badge: p ? `≥${p.safetyThreshold}` : undefined, detail: 'Harm categories and severities.' },
          { id: 'pii', label: 'PII redaction', col: 2, row: 3, kind: 'policy', badge: p ? p.redaction : undefined, detail: 'Detect, then mask before storage.' },
          { id: 'store', label: 'Leak scan → store', col: 4, row: 1.5, kind: 'store', detail: 'Your final guard before persisting text.' },
        ],
        edges: [['input', 'detect'], ['detect', 'sentiment'], ['detect', 'tone'], ['detect', 'safety'], ['detect', 'pii'], ['sentiment', 'store'], ['tone', 'store'], ['safety', 'store'], ['pii', 'store']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'Event Hubs (chat stream)', col: 0, row: 1, kind: 'store', detail: 'Incoming messages.' },
          { id: 'auth', label: 'Microsoft Entra ID', col: 1, row: 0, kind: 'policy', badge: p ? p.auth : undefined, detail: 'Managed identity; prefer keyless and disable local auth.' },
          { id: 'detect', label: 'Azure Function', col: 1, row: 2, kind: 'compute', detail: 'Orchestrates the calls.' },
          { id: 'sentiment', label: 'Azure Language (sentiment + PII)', col: 2, row: 1, kind: 'ai', detail: 'One analyze-text job can run SentimentAnalysis and PiiEntityRecognition.' },
          { id: 'pii', label: 'PII task', col: 3, row: 0, kind: 'ai', detail: 'Part of the Language job.' },
          { id: 'safety', label: 'Azure AI Content Safety', col: 2, row: 3, kind: 'ai', detail: 'text:analyze.' },
          { id: 'tone', label: 'Foundry model (small)', col: 3, row: 3, kind: 'ai', disabled: p && !p.tone, detail: 'Tone classification with JSON output.' },
          { id: 'store', label: 'Data Lake (redacted)', col: 4, row: 1, kind: 'store', detail: 'Only redacted text is persisted.' },
        ],
        edges: [['input', 'detect'], ['detect', 'auth', 'token'], ['detect', 'sentiment'], ['sentiment', 'pii'], ['detect', 'safety'], ['detect', 'tone'], ['detect', 'store']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'auth', label: 'ta = TextAnalyticsClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'azure-ai-textanalytics. Illustrative.' },
          { id: 'sentiment', label: `ta.analyze_sentiment(docs, language="${p ? (p.language === 'auto' ? '<detected>' : p.language) : 'en'}", show_opinion_mining=${p ? (p.opinionMining ? 'True' : 'False') : 'True'})`, col: 0, row: 1, kind: 'code', detail: 'Sentence and aspect results.' },
          { id: 'pii', label: `ta.recognize_pii_entities(docs, categories_filter=[${p && p.piiCategories ? p.piiCategories.split(',').map(s => s.trim()).filter(Boolean).join(', ') : ''}])`, col: 0, row: 2, kind: 'code', detail: 'Returns entities and redacted_text. Newer REST API versions add redactionPolicy options (illustrative).' },
          { id: 'safety', label: 'cs.analyze_text(AnalyzeTextOptions(text=msg))', col: 0, row: 3, kind: 'code', detail: 'azure-ai-contentsafety; compare categories_analysis[i].severity to your threshold.' },
          { id: 'tone', label: 'chat.completions.create(..., response_format=json_schema(tone_labels))', col: 0, row: 4, kind: 'code', detail: 'LLM tone classifier.', disabled: p && !p.tone },
          { id: 'store', label: 'assert not leak_scan(redacted); lake.write(redacted)', col: 0, row: 5, kind: 'code', detail: 'Your guard.' },
        ],
        edges: [['auth', 'sentiment'], ['sentiment', 'pii'], ['pii', 'safety'], ['safety', 'tone'], ['tone', 'store']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'text', label: 'Message text', type: 'textarea', default: SAMPLES.chat },
      { id: 'language', label: 'Language hint', type: 'select', options: [['auto', 'Auto-detect first'], ['en', 'en'], ['es', 'es']], default: 'auto' },
      { id: 'opinionMining', label: 'Opinion mining (aspect level)', type: 'toggle', default: true },
      { id: 'tone', label: 'LLM tone classification', type: 'toggle', default: false },
      { id: 'safetyThreshold', label: 'Block at Content Safety severity ≥', type: 'select', options: [[2, '2 (strict)'], [4, '4 (medium)'], [6, '6 (permissive)']], default: 4 },
      { id: 'piiCategories', label: 'PII categories (empty = all)', type: 'text', default: '' },
      { id: 'piiThreshold', label: 'Minimum PII confidence to redact', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.8 },
      { id: 'redaction', label: 'Redaction policy', type: 'select', options: [['characterMask', 'Character mask (****)'], ['entityMask', 'Entity mask ([EMAIL])'], ['noMask', 'No mask (entities only)']], default: 'characterMask' },
      { id: 'auth', label: 'Authentication', type: 'select', options: Object.entries(AUTH), default: 'entra' },
    ],
    samples: [
      { label: 'Support chat (PII + sarcasm)', values: { text: SAMPLES.chat } },
      { label: 'Product review (aspects)', values: { text: SAMPLES.review, piiCategories: '' } },
      { label: 'Spanish complaint', values: { text: SAMPLES.spanish, language: 'auto' } },
      { label: 'Threatening message', values: { text: SAMPLES.threat, safetyThreshold: 4, tone: true } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Run the support chat with tone off and on: compare how the sarcastic sentence is labelled.',
      'Run the Spanish complaint with language "auto" and then "en": compare document sentiment and aspects.',
      'Run the support chat with PII categories empty, then "Person,Email,PhoneNumber": compare the leak scan.',
    ],
  },

  debug: [
    { id: 'leak-card', title: 'Card numbers appear in the analytics lake', values: { text: SAMPLES.chat, piiCategories: 'Person,Email,PhoneNumber' }, node: 'store',
      symptom: 'Leak scan finds CreditCardNumber "4111 1111 1111 1111" in stored text.', cause: 'piiCategories restricts detection to the listed categories; CreditCardNumber was not included.', fix: 'Add CreditCardNumber to the list or leave it empty to use all default categories.' },
    { id: 'lang', title: 'Spanish complaints all score neutral', values: { text: SAMPLES.spanish, language: 'en' }, node: 'detect',
      symptom: 'Document sentiment is neutral and no aspects are found, although the customer is angry.', cause: 'Language hint "en" does not match Spanish text.', fix: 'Use auto-detection (or pass "es").' },
    { id: 'sarcasm', title: '"Great, another delay" counted as positive', values: { text: SAMPLES.chat, tone: false }, node: 'tone',
      symptom: 'Dashboards show a positive sentence in an angry chat.', cause: 'Lexical sentiment does not model sarcasm.', fix: 'Add the LLM tone classifier for escalation decisions.' },
    { id: 'lowconf', title: 'Colleague name not redacted', values: { text: SAMPLES.chat, piiThreshold: 0.9 }, node: 'pii',
      symptom: '"Jordan" stays visible after redaction.', cause: 'The entity was detected with confidence 0.62, below the 0.9 threshold.', fix: 'Lower the minimum confidence for redaction (e.g. 0.6); for PII, false positives are usually cheaper than leaks.' },
    { id: 'auth', title: '401 after a security hardening change', values: { auth: 'key-disabled' }, node: 'auth',
      symptom: 'Every call fails with 401.', cause: 'Local (key) authentication was disabled on the resource, but the app still sends a key.', fix: 'Switch to Microsoft Entra ID with a managed identity that has the right role.' },
    { id: 'threat', title: 'Threat reaches the agent queue', values: { text: SAMPLES.threat, safetyThreshold: 6 }, node: 'safety',
      symptom: 'A message with violent intent is not flagged.', cause: 'Threshold 6 only blocks the highest severity; this message is severity 4 in this simulation.', fix: 'Use threshold 4 (or 2) for customer-facing channels.' },
  ],

  challenge: {
    task: 'Make the support-chat pipeline safe for storage and escalation: no PII at all in stored text (including the low-confidence name), entity-type masking for readability, and the sarcastic sentence flagged.',
    condition: 'Default support chat text; leak scan finds 0 values; redaction policy = entity mask; tone analysis flags sarcasm.',
    hint: 'Look at the confidence of the name that stays visible, and at which detector can see sarcasm.',
    check: (p, res) => !!(res.meta && res.meta.leaks === 0 && res.meta.sarcasmFlagged && p.redaction === 'entityMask' && /Alex Turner/.test(p.text)),
    solution: ['Keep PII categories empty (all categories).', 'Lower minimum PII confidence to 0.6 so "Jordan" (0.62) is redacted.', 'Choose Entity mask.', 'Turn on LLM tone classification.'],
    solutionValues: { text: SAMPLES.chat, piiCategories: '', piiThreshold: 0.6, redaction: 'entityMask', tone: true, language: 'auto', auth: 'entra' },
  },

  quiz: [
    { q: 'Product managers want to know which product features customers dislike, not just whether a review is negative. Which setting do you enable?', options: ['Opinion mining in sentiment analysis', 'Key phrase extraction only', 'Content Safety Violence category', 'PII entity mask'], answer: 0, why: 'Opinion mining returns targets (features) with assessments and their polarity.' },
    { q: 'After restricting PII detection to Person and Email, a compliance scan finds phone numbers in stored transcripts. Why?', options: ['Phone numbers are never detected', 'Only the requested categories are detected when you filter categories', 'Entity masking does not support phones', 'Content Safety removed the redaction'], answer: 1, why: 'A category filter limits detection to those categories. Include PhoneNumber or use the default set.' },
    { q: 'A moderation policy must block clear threats but allow mild frustration. Content Safety returns Violence severity 4 for "I will smash every screen". Which configuration fits?', options: ['Block at severity ≥ 6', 'Block at severity ≥ 4 for Violence', 'Disable Content Safety and rely on sentiment', 'Block any negative sentiment'], answer: 1, why: 'Thresholds are per category and set by you; ≥4 catches this threat while letting low-severity frustration through. Sentiment is not a safety signal.' },
    { q: 'Your sentiment dashboard shows "Great, another delay" as positive. What is the most targeted improvement?', options: ['Raise the PII threshold', 'Add an LLM tone classifier with a fixed label set (incl. sarcastic) for escalation', 'Use character masking', 'Switch the language hint to auto'], answer: 1, why: 'Lexicon/ML sentiment can miss sarcasm; a constrained LLM classification adds tone labels.' },
  ],

  recap: 'Sentiment (with opinion mining), tone, safety and PII are separate detectors with separate knobs: pass the right language, choose Content Safety thresholds per category, choose PII categories, confidence and redaction policy deliberately, and add a leak scan before anything is stored.',
};
