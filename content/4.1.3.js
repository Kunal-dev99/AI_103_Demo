// 4.1.3 Build solutions that translate text by using Azure Translator in Foundry Tools or LLM-powered translation flows
// Lab: Translation router.
import { round, step, metric, estTokens, overlap } from '../src/engine/util.js';

// Pre-written translations ("recorded"). {0},{1} = glossary term slots, {P} = profanity slot.
// For each term: gen = what a general MT model produces, llm = what an LLM produces without a glossary, tgt = approved glossary term.
// ja entries also carry romaji (r*) used by the transliteration step.
const SEGMENTS = {
  ui: {
    label: 'UI string (brand + IT term)', lang: 'en',
    source: 'Sign in to the Contoso Portal and open your tenant settings to rotate the API key.',
    terms: [
      { src: 'Contoso Portal', note: 'brand: do not translate', de: { gen: 'Contoso Portal', llm: 'Contoso Portal', tgt: 'Contoso Portal' }, fr: { gen: 'Portail Contoso', llm: 'Contoso Portal', tgt: 'Contoso Portal' }, ja: { gen: 'Contoso ポータル', llm: 'Contoso ポータル', tgt: 'Contoso Portal', rgen: 'Contoso pōtaru', rllm: 'Contoso pōtaru', rtgt: 'Contoso Portal' } },
      { src: 'tenant', note: 'Entra ID tenant', de: { gen: 'Mieter', llm: 'Mandanten', tgt: 'Mandanten' }, fr: { gen: 'locataire', llm: 'locataire', tgt: 'locataire' }, ja: { gen: '賃借人', llm: 'テナント', tgt: 'テナント', rgen: 'chinshakunin', rllm: 'tenanto', rtgt: 'tenanto' } },
    ],
    tr: { de: 'Melden Sie sich beim {0} an und öffnen Sie Ihre {1}einstellungen, um den API-Schlüssel zu rotieren.', fr: 'Connectez-vous au {0} et ouvrez les paramètres de votre {1} pour faire pivoter la clé API.', ja: '{0}にサインインし、{1}の設定を開いて API キーをローテーションします。', jaR: '{0} ni sain\'in shi, {1} no settei o hiraite API kī o rōtēshon shimasu.' },
    llm: {
      de: { formal: 'Melden Sie sich im {0} an und öffnen Sie Ihre {1}einstellungen, um den API-Schlüssel zu rotieren.', informal: 'Melde dich im {0} an und öffne deine {1}einstellungen, um den API-Schlüssel zu rotieren.' },
      fr: { formal: 'Connectez-vous au {0} et ouvrez les paramètres de votre {1} pour effectuer la rotation de la clé API.', informal: 'Connecte-toi au {0} et ouvre les paramètres de ton {1} pour effectuer la rotation de la clé API.' },
      ja: { formal: '{0}にサインインし、{1}の設定を開いて API キーをローテーションしてください。', informal: '{0}にサインインして、{1}の設定を開いて API キーをローテーションしてね。' },
      jaR: { formal: '{0} ni sain\'in shi, {1} no settei o hiraite API kī o rōtēshon shite kudasai.', informal: '{0} ni sain\'in shite, {1} no settei o hiraite API kī o rōtēshon shite ne.' },
    },
  },
  legal: {
    label: 'Contract clause (legal term)', lang: 'en',
    source: 'The supplier shall indemnify the customer against all third-party claims.',
    terms: [
      { src: 'indemnify', note: 'legal: approved rendering', de: { gen: 'entschädigen', llm: 'schadlos halten', tgt: 'freistellen' }, fr: { gen: 'indemnisera', llm: 'indemnisera', tgt: 'garantira' }, ja: { gen: '賠償する', llm: '補償する', tgt: '補償する', rgen: 'baishō suru', rllm: 'hoshō suru', rtgt: 'hoshō suru' } },
    ],
    tr: { de: 'Der Lieferant wird den Kunden von allen Ansprüchen Dritter {0}.', fr: 'Le fournisseur {0} le client contre toute réclamation de tiers.', ja: 'サプライヤーは、第三者からのあらゆる請求について顧客を{0}ものとする。', jaR: 'Sapuraiyā wa, daisansha kara no arayuru seikyū ni tsuite kokyaku o {0} mono to suru.' },
    llm: {
      de: { formal: 'Der Lieferant wird den Kunden von sämtlichen Ansprüchen Dritter {0}.', informal: 'Der Lieferant muss den Kunden von allen Ansprüchen Dritter {0}.' },
      fr: { formal: 'Le fournisseur {0} le client contre toute réclamation émanant de tiers.', informal: 'Le fournisseur {0} le client contre toute réclamation de tiers.' },
      ja: { formal: '供給者は、第三者からの一切の請求について顧客を{0}ものとする。', informal: '供給者は、第三者からの請求について顧客を{0}。' },
      jaR: { formal: 'Kyōkyūsha wa, daisansha kara no issai no seikyū ni tsuite kokyaku o {0} mono to suru.', informal: 'Kyōkyūsha wa, daisansha kara no seikyū ni tsuite kokyaku o {0}.' },
    },
  },
  profanity: {
    label: 'User comment (profanity)', lang: 'en',
    source: 'This damn update broke the checkout page again.',
    profanity: { de: 'verdammte', fr: 'foutue', ja: 'クソ', jaR: 'kuso' },
    terms: [
      { src: 'checkout page', note: 'UI term', de: { gen: 'Kassenseite', llm: 'Checkout-Seite', tgt: 'Checkout-Seite' }, fr: { gen: 'page de caisse', llm: 'page de paiement', tgt: 'page de paiement' }, ja: { gen: 'レジページ', llm: 'チェックアウトページ', tgt: 'チェックアウトページ', rgen: 'reji pēji', rllm: 'chekkuauto pēji', rtgt: 'chekkuauto pēji' } },
    ],
    tr: { de: 'Dieses {P} Update hat die {0} schon wieder kaputt gemacht.', fr: 'Cette {P} mise à jour a encore cassé la {0}.', ja: 'この{P}アップデートのせいで、また{0}が壊れた。', jaR: 'Kono {P} appudēto no sei de, mata {0} ga kowareta.' },
    llm: {
      de: { formal: 'Dieses Update hat die {0} leider erneut beschädigt.', informal: 'Dieses {P} Update hat die {0} schon wieder kaputt gemacht.' },
      fr: { formal: 'Cette mise à jour a de nouveau endommagé la {0}.', informal: 'Cette {P} mise à jour a encore cassé la {0}.' },
      ja: { formal: 'このアップデートにより、再び{0}が動作しなくなりました。', informal: 'この{P}アップデートのせいで、また{0}が壊れた。' },
      jaR: { formal: 'Kono appudēto ni yori, futatabi {0} ga dōsa shinaku narimashita.', informal: 'Kono {P} appudēto no sei de, mata {0} ga kowareta.' },
    },
  },
  german: {
    label: 'German email line (source is not English)', lang: 'de',
    source: 'Bitte senden Sie die Rechnung bis Freitag an unsere Buchhaltung.',
    terms: [],
    fixed: { en: 'Please send the invoice to our accounting department by Friday.', fr: 'Veuillez envoyer la facture à notre service comptable d\'ici vendredi.', ja: '金曜日までに請求書を経理部へお送りください。', jaR: 'Kin\'yōbi made ni seikyūsho o keiribu e ookuri kudasai.' },
  },
};
const LANGS = { de: 'German (de)', fr: 'French (fr)', ja: 'Japanese (ja)', en: 'English (en)', zz: 'zz (invalid code)' };

function render(seg, to, engine, useGlossary, tone, translit, profanityAction) {
  if (to === seg.lang) return { text: seg.source, latin: null, terms: [] };
  if (seg.fixed) return { text: seg.fixed[to] || seg.source, latin: to === 'ja' ? seg.fixed.jaR : null, terms: [] };
  const tpl = engine === 'llm' ? seg.llm[to][tone] : seg.tr[to];
  const tplR = to === 'ja' ? (engine === 'llm' ? seg.llm.jaR[tone] : seg.tr.jaR) : null;
  const pick = t => (useGlossary ? 'tgt' : engine === 'llm' ? 'llm' : 'gen');
  let text = tpl, latin = tplR;
  const terms = seg.terms.map((t, i) => {
    const k = pick(t); const val = t[to][k];
    text = text.replace(`{${i}}`, val);
    if (latin) latin = latin.replace(`{${i}}`, t.ja['r' + k]);
    return { src: t.src, note: t.note, expected: t[to].tgt, got: val, ok: val === t[to].tgt };
  });
  if (seg.profanity) {
    const word = seg.profanity[to];
    const repl = engine === 'llm' ? word : profanityAction === 'Marked' ? '***' : profanityAction === 'Deleted' ? '' : word;
    text = text.replace('{P}', repl).replace(/\s{2,}/g, ' ');
    if (latin) latin = latin.replace('{P}', repl === '***' ? '***' : repl ? seg.profanity.jaR : '').replace(/\s{2,}/g, ' ');
  }
  return { text, latin: translit ? latin : null, terms };
}

function run(p) {
  const seg = SEGMENTS[p.segment] || SEGMENTS.ui;
  const steps = [];
  const isLLM = p.engine === 'llm';
  const chars = seg.source.length;
  steps.push(step('input', 'Source text', `"${seg.source}" (${chars} characters).`, { text: seg.source, characters: chars }));

  // Auth / request
  if (!isLLM && !p.regionHeader) {
    steps.push(step('auth', '401: missing region header', 'This Translator resource is regional / multi-service. Key-based requests must include Ocp-Apim-Subscription-Region (with Entra ID, use the resource\'s custom endpoint and a role such as "Cognitive Services User").', { httpStatus: 401, headers: { 'Ocp-Apim-Subscription-Key': '***', 'Ocp-Apim-Subscription-Region': '(missing)' } }, 'error'));
    return { steps, output: [{ type: 'alert', tone: 'error', text: 'Request rejected before translation. Send the region header (or use Entra ID auth).' }], metrics: [], summary: 'Translator: 401 (no region header)', meta: {} };
  }
  steps.push(step('auth', 'Request authorised', isLLM ? 'Foundry model deployment called with an Entra ID token.' : 'Translator call with key + Ocp-Apim-Subscription-Region header.', null));

  // Target validation
  if (p.toLang === 'zz') {
    if (!isLLM) {
      steps.push(step('route', '400: invalid target language', 'Translator validates "to" against its supported languages (GET /languages?scope=translation). "zz" is not a language code.', { httpStatus: 400, error: { code: '400xxx (illustrative)', message: 'The target language is not valid.' } }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: 'Use a supported language code. Cache the /languages list and validate input before calling.' }], metrics: [], summary: 'Translator: 400 invalid target', meta: {} };
    }
    steps.push(step('route', 'LLM accepted an invalid target code', 'Nothing validates "zz": in this simulation the model guesses and replies in English with a note. LLM flows need your own language-code validation.', { target: 'zz' }, 'warn'));
    const out = { text: `(The model could not identify language "zz" and returned the source.) ${seg.source}`, latin: null, terms: [] };
    return { steps, output: [{ type: 'text', title: 'LLM output', text: out.text }, { type: 'alert', tone: 'warn', text: 'Validate language codes before calling an LLM.' }], metrics: [], summary: 'LLM: unvalidated target code', meta: {} };
  }

  // Source language
  const declared = p.fromLang === 'auto' ? null : p.fromLang;
  const wrongSource = declared && declared !== seg.lang;
  if (p.fromLang === 'auto') steps.push(step('detect', `Detected source: ${seg.lang}`, 'Translator detects the language when "from" is omitted and returns detectedLanguage {language, score}.', { detectedLanguage: { language: seg.lang, score: 1.0 } }));
  else steps.push(step('detect', wrongSource ? `Declared source "${declared}" but the text is ${seg.lang}` : `Declared source: ${declared}`, wrongSource ? (isLLM ? 'The LLM reads the text itself and ignores the wrong hint in this simulation.' : 'Translator trusts "from". Words it cannot map pass through untranslated.') : 'Declared source matches.', { from: declared }, wrongSource ? (isLLM ? 'info' : 'warn') : 'ok'));

  // Glossary configuration
  let useGlossary = p.glossary !== 'none';
  if (p.glossary === 'custom') {
    if (isLLM) { steps.push(step('glossary', 'Custom Translator category ignored', 'A Custom Translator category applies to Translator requests only. The LLM flow translated without a glossary.', { category: 'ignored' }, 'warn')); useGlossary = false; }
    else if (!p.customDeployed) {
      steps.push(step('glossary', '400: custom model not deployed', 'The request used category=<your-category-id>, but that Custom Translator model is not deployed (or not in this region). Translator rejects the request in this simulation.', { httpStatus: 400, category: 'a1b2c3…-GENERAL (illustrative)' }, 'error'));
      return { steps, output: [{ type: 'alert', tone: 'error', text: 'Deploy (publish) the Custom Translator model to the region of your resource, or use a dynamic dictionary.' }], metrics: [], summary: 'Translator: custom category not deployed', meta: {} };
    } else steps.push(step('glossary', 'Custom Translator model (category)', 'A deployed custom model trained with parallel documents and a phrase dictionary enforces approved terminology.', { category: '<category-id>' }));
  } else if (p.glossary === 'dynamic') {
    steps.push(step('glossary', isLLM ? 'Glossary in the prompt' : 'Dynamic dictionary markup', isLLM ? 'Terms are listed in the system prompt: "Always translate X as Y. Never translate brand names."' : 'Terms wrapped in <mstrans:dictionary translation="…">term</mstrans:dictionary>. Best for a few terms such as names and product codes.', { terms: seg.terms.map(t => ({ source: t.src, target: t[p.toLang] ? t[p.toLang].tgt : t.src })) }));
  } else steps.push(step('glossary', 'No glossary', 'General translation; terminology depends on the model.', null, 'skip'));

  // LLM temperature can make it ignore glossary terms.
  if (isLLM && useGlossary && p.temperature > 0.8 && seg.terms.length) {
    steps.push(step('llm', 'Glossary partially ignored', `At temperature ${p.temperature} the model paraphrased one approved term (simulated). Prompt glossaries are instructions, not constraints.`, { temperature: p.temperature }, 'warn'));
  }

  // Translate
  let res;
  if (!isLLM && wrongSource) res = { text: seg.source, latin: null, terms: [] };
  else res = render(seg, p.toLang, p.engine, useGlossary, p.tone, p.transliterate, p.profanity);
  if (isLLM && useGlossary && p.temperature > 0.8 && res.terms.length) {
    const t = seg.terms[seg.terms.length - 1][p.toLang];
    const i = res.terms.length - 1;
    res.text = res.text.replace(t.tgt, t.gen === t.tgt ? t.llm : t.gen);
    res.terms[i] = { ...res.terms[i], got: t.gen === t.tgt ? t.llm : t.gen, ok: (t.gen === t.tgt ? t.llm : t.gen) === t.tgt };
  }
  const passthrough = p.toLang !== seg.lang && overlap(res.text, seg.source) > 0.6;
  if (isLLM) steps.push(step('llm', `LLM translation (${p.tone})`, `System prompt sets tone "${p.tone}"${useGlossary ? ' and the glossary' : ''}. Billed by tokens: ~${estTokens(seg.source) * 3 + 60} (estimate).`, { temperature: p.temperature, tone: p.tone }));
  else steps.push(step('translator', 'Translator text translation', `POST /translate?api-version=3.0&to=${p.toLang}${declared ? '&from=' + declared : ''}&profanityAction=${p.profanity}${p.glossary === 'custom' ? '&category=<id>' : ''}${p.transliterate && p.toLang === 'ja' ? '&toScript=Latn' : ''}`, { profanityAction: p.profanity, tone: 'Translator has no tone parameter here' }));
  if (passthrough) steps.push(step('translator', 'Output almost identical to source', `Word overlap with the source is ${round(overlap(res.text, seg.source), 2)}. The text was not really translated.`, null, 'warn'));
  if (p.toLang === seg.lang) steps.push(step('translator', 'Source and target are the same language', 'Nothing to translate; the text is returned unchanged.', null, 'info'));

  // Transliteration
  if (p.transliterate) {
    if (p.toLang === 'ja' && res.latin) steps.push(step('translit', 'Transliterated to Latin script', 'Translator can return a Latin-script transliteration of the translation (toScript=Latn) or you can call /transliterate.', { script: 'Latn', text: res.latin }));
    else steps.push(step('translit', 'Transliteration not applicable', 'Target already uses Latin script.', null, 'skip'));
  }

  // Profanity
  if (seg.profanity && p.toLang !== 'en') steps.push(step(isLLM ? 'llm' : 'translator', 'Profanity handling', isLLM ? `No profanity parameter: the outcome depends on the prompt. Here the "${p.tone}" tone ${p.tone === 'formal' ? 'softened' : 'kept'} the swear word.` : `profanityAction=${p.profanity}${p.profanity === 'Marked' ? ' (profanityMarker=Asterisk)' : ''}.`, null, isLLM && p.tone === 'informal' ? 'info' : 'ok'));

  // Terminology check
  const termsOk = res.terms.filter(t => t.ok).length;
  const termAcc = res.terms.length ? termsOk / res.terms.length : 1;
  steps.push(step('check', res.terms.length ? `Terminology check: ${termsOk}/${res.terms.length}` : 'Terminology check: no glossary terms in segment', res.terms.map(t => `${t.src} → "${t.got}" ${t.ok ? '✓' : `✗ (expected "${t.expected}")`}`).join('; ') || 'Nothing to check.', { terms: res.terms }, termAcc < 1 ? 'warn' : 'ok'));

  // Comparison with the other engine (same settings)
  const other = !isLLM ? render(seg, p.toLang, 'llm', p.glossary === 'dynamic', p.tone, false, p.profanity) : wrongSource ? null : render(seg, p.toLang, 'translator', p.glossary !== 'none', 'formal', false, p.profanity);
  const output = [
    { type: 'kv', title: 'Translation', items: [['Source', seg.source], [`Output (${LANGS[p.toLang]})`, res.text], ...(res.latin ? [['Latin script', res.latin]] : [])] },
  ];
  if (res.terms.length) output.push({ type: 'table', title: 'Terminology check', columns: ['Source term', 'Note', 'Expected', 'Got', 'Pass'], rows: res.terms.map(t => [t.src, t.note, t.expected, t.got, t.ok ? 'yes' : 'no']), tones: res.terms.map(t => (t.ok ? 'ok' : 'warn')) });
  if (other) output.push({ type: 'diff', title: `This engine vs ${isLLM ? 'Translator' : 'LLM'} (same glossary setting)`, before: other.text, after: res.text });
  output.push(isLLM
    ? { type: 'code', title: 'LLM request (illustrative)', lang: 'json', text: JSON.stringify({ messages: [{ role: 'system', content: `Translate from ${declared || 'the detected language'} to ${p.toLang}. Tone: ${p.tone}.${useGlossary ? ' Glossary: ' + seg.terms.map(t => `${t.src} => ${t[p.toLang] ? t[p.toLang].tgt : t.src}`).join('; ') + '.' : ''} Output only the translation.` }, { role: 'user', content: seg.source }], temperature: p.temperature }, null, 2) }
    : { type: 'json', title: 'Translator response (shape)', data: [{ ...(p.fromLang === 'auto' ? { detectedLanguage: { language: seg.lang, score: 1.0 } } : {}), translations: [{ text: res.text, to: p.toLang, ...(res.latin ? { transliteration: { script: 'Latn', text: res.latin } } : {}) }] }] });
  output.push({ type: 'alert', tone: passthrough || termAcc < 1 ? 'warn' : 'ok', text: passthrough ? 'The output is the source text. Fix the source language.' : termAcc < 1 ? 'Approved terminology was not used. Add or enforce a glossary.' : 'Translation uses approved terminology.' });

  return {
    steps, output,
    metrics: [
      metric('Terminology accuracy', `${termsOk}/${res.terms.length}`, 'computed'),
      metric('Characters (Translator billing unit)', String(chars), 'computed', 'Translator bills by characters; see the pricing page for rates.'),
      metric('LLM tokens', `~${estTokens(seg.source) * 3 + 60}`, 'estimate', 'Input + output + ~60 instruction tokens, 4-chars-per-token heuristic (non-Latin scripts use more tokens).'),
      metric('Relative latency', isLLM ? 'higher' : 'lower', 'estimate', 'Dedicated MT is usually faster per segment than generative decoding; measure in your region.'),
    ],
    summary: `${isLLM ? 'LLM (' + p.tone + ')' : 'Translator'} → ${p.toLang} • glossary ${p.glossary} • terms ${termsOk}/${res.terms.length}${passthrough ? ' • passthrough' : ''}`,
    meta: { termAcc, passthrough },
  };
}

export default {
  id: '4.1.3',
  lab: 'Translation router',
  services: [
    { name: 'Azure Translator in Foundry Tools: text translation', url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/overview' },
    { name: 'Translator: dynamic dictionary', url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/how-to/use-dynamic-dictionary' },
    { name: 'Custom Translator', url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/custom-translator/overview' },
  ],
  prereqs: ['4.1.1'],
  next: ['4.2.4', '4.1.4'],

  concept: {
    plain: 'Machine translation can be done by a dedicated translation service or by a general language model. The dedicated service is fast, cheap per character and predictable; a language model can follow instructions about tone and style. Either way, company terms (brand names, legal words, UI labels) must come out the same every time, so you add a glossary and check the result.',
    technical: 'Azure Translator text translation (REST v3 /translate, SDK azure-ai-translation-text) supports auto-detection when "from" is omitted, multiple "to" targets per call, profanityAction (NoAction/Marked/Deleted), toScript transliteration, dynamic dictionary markup for a few forced terms, and Custom Translator models addressed with a category ID once deployed. Regional or multi-service resources with key auth need the Ocp-Apim-Subscription-Region header. LLM translation flows use a prompt with tone, glossary and output rules; they have no built-in language-code validation or profanity parameter and should run at low temperature with a terminology check afterwards.',
    useCase: 'A SaaS vendor localises 30,000 UI strings and support macros into German, French and Japanese. UI strings go through Translator with a Custom Translator model that enforces product terminology; marketing copy that needs a friendly tone goes through an LLM flow with a glossary in the prompt; a terminology check flags any string that misses an approved term.',
    terms: [
      ['Dynamic dictionary', 'Inline markup that forces a translation for a specific term in one request.'],
      ['Custom Translator', 'Train and deploy a translation model on your parallel data and phrase dictionaries; requests use its category ID.'],
      ['Transliteration', 'Converting text from one script to another (e.g. Japanese to Latin script) without translating it.'],
      ['profanityAction', 'Translator option: leave, mark (asterisks or tags) or delete profanity in the output.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'input', label: 'Source segment', col: 0, row: 1, kind: 'data', detail: 'Sentence or UI string.' },
          { id: 'detect', label: 'Source language', col: 1, row: 1, badge: p ? p.fromLang : undefined, detail: 'Declared or auto-detected.' },
          { id: 'route', label: 'Router', col: 2, row: 1, kind: 'policy', detail: 'Pick MT or LLM per content type; validate target codes.' },
          { id: 'translator', label: 'Translator (MT)', col: 3, row: 0, kind: 'ai', disabled: p && p.engine === 'llm', detail: 'Fast, per-character billing, glossary via dictionary / custom model.', substeps: ['Detect', 'Translate', 'Profanity handling', 'Transliterate'] },
          { id: 'llm', label: 'LLM translation', col: 3, row: 2, kind: 'ai', disabled: p && p.engine !== 'llm', detail: 'Tone and style via prompt; glossary in prompt.', substeps: ['System prompt', 'Glossary', 'Generate'] },
          { id: 'glossary', label: 'Glossary', col: 2, row: 2.5, kind: 'data', badge: p ? p.glossary : undefined, detail: 'Approved terminology.' },
          { id: 'translit', label: 'Transliterate', col: 4, row: 0, disabled: p && !p.transliterate, detail: 'Latin script for non-Latin targets.' },
          { id: 'check', label: 'Terminology check', col: 4, row: 2, kind: 'policy', detail: 'Expected term present in output?' },
        ],
        edges: [['input', 'detect'], ['detect', 'route'], ['route', 'translator'], ['route', 'llm'], ['glossary', 'translator'], ['glossary', 'llm'], ['translator', 'translit'], ['translator', 'check'], ['llm', 'check']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'input', label: 'Localization pipeline (Function)', col: 0, row: 1, kind: 'compute', detail: 'Reads strings from the repo / CMS.' },
          { id: 'auth', label: 'Key + region header / Entra ID', col: 1, row: 0, kind: 'policy', badge: p && !p.regionHeader && p.engine !== 'llm' ? 'no region' : undefined, detail: 'Regional/multi-service Translator resources need Ocp-Apim-Subscription-Region with key auth.' },
          { id: 'translator', label: 'Azure Translator resource', col: 2, row: 0.5, kind: 'ai', disabled: p && p.engine === 'llm', detail: 'Text translation v3.' },
          { id: 'glossary', label: 'Custom Translator workspace', col: 3, row: 0, kind: 'store', disabled: p && p.glossary !== 'custom', badge: p && p.glossary === 'custom' ? (p.customDeployed ? 'deployed' : 'not deployed') : undefined, detail: 'Trained model, published to regions; called by category ID.' },
          { id: 'llm', label: 'Foundry model deployment', col: 2, row: 2, kind: 'ai', disabled: p && p.engine !== 'llm', detail: 'Chat completions.' },
          { id: 'check', label: 'Terminology QA + TMS', col: 4, row: 1, kind: 'app', detail: 'Translation management system receives checked output.' },
        ],
        edges: [['input', 'auth'], ['input', 'translator'], ['translator', 'glossary', 'category'], ['input', 'llm'], ['translator', 'check'], ['llm', 'check']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'auth', label: 'client = TextTranslationClient(credential=AzureKeyCredential(key), region="<region>")', col: 0, row: 0, kind: 'code', detail: 'azure-ai-translation-text; Entra ID auth also possible. Illustrative.' },
          { id: 'translator', label: `client.translate(body=[text], to_language=["${p ? p.toLang : 'de'}"]${p && p.fromLang !== 'auto' ? `, from_language="${p.fromLang}"` : ''}, profanity_action="${p ? p.profanity : 'NoAction'}"${p && p.glossary === 'custom' ? ', category="<id>"' : ''}${p && p.transliterate ? ', to_script="Latn"' : ''})`, col: 0, row: 1, kind: 'code', detail: 'Parameter names follow the SDK; check the version you use.' },
          { id: 'glossary', label: 'text = text.replace(term, f\'<mstrans:dictionary translation="{tgt}">{term}</mstrans:dictionary>\')', col: 0, row: 2, kind: 'code', detail: 'Dynamic dictionary markup.' },
          { id: 'llm', label: 'chat.completions.create(model=..., messages=[system(tone, glossary), user(text)], temperature=0.2)', col: 0, row: 3, kind: 'code', detail: 'LLM flow.' },
          { id: 'check', label: 'assert all(tgt in out for tgt in expected_terms)', col: 0, row: 4, kind: 'code', detail: 'Terminology QA.' },
        ],
        edges: [['auth', 'translator'], ['glossary', 'translator'], ['translator', 'check'], ['llm', 'check']],
      }),
    },
  },

  sim: {
    mode: 'recorded',
    controls: [
      { id: 'segment', label: 'Source segment', type: 'select', options: Object.entries(SEGMENTS).map(([k, s]) => [k, s.label]), default: 'ui' },
      { id: 'engine', label: 'Engine', type: 'select', options: [['translator', 'Azure Translator'], ['llm', 'LLM translation flow']], default: 'translator' },
      { id: 'fromLang', label: 'Source language', type: 'select', options: [['auto', 'auto-detect'], ['en', 'en'], ['de', 'de']], default: 'auto' },
      { id: 'toLang', label: 'Target language', type: 'select', options: Object.entries(LANGS), default: 'de' },
      { id: 'glossary', label: 'Glossary', type: 'select', options: [['none', 'None'], ['dynamic', 'Dynamic dictionary / prompt glossary'], ['custom', 'Custom Translator category']], default: 'none' },
      { id: 'customDeployed', label: 'Custom Translator model deployed', type: 'toggle', default: true },
      { id: 'tone', label: 'Tone (LLM only)', type: 'select', options: [['formal', 'Formal'], ['informal', 'Informal']], default: 'formal' },
      { id: 'temperature', label: 'Temperature (LLM only)', type: 'range', min: 0, max: 1.5, step: 0.1, default: 0.2 },
      { id: 'profanity', label: 'profanityAction (Translator)', type: 'select', options: [['NoAction', 'NoAction'], ['Marked', 'Marked'], ['Deleted', 'Deleted']], default: 'NoAction' },
      { id: 'transliterate', label: 'Latin-script transliteration', type: 'toggle', default: false },
      { id: 'regionHeader', label: 'Send Ocp-Apim-Subscription-Region', type: 'toggle', default: true },
    ],
    samples: [
      { label: 'UI string → German, no glossary', values: { segment: 'ui', toLang: 'de', glossary: 'none' } },
      { label: 'Legal clause → French with custom model', values: { segment: 'legal', toLang: 'fr', glossary: 'custom' } },
      { label: 'Comment → Japanese, profanity marked', values: { segment: 'profanity', toLang: 'ja', profanity: 'Marked', transliterate: true } },
      { label: 'UI string → German via LLM, informal', values: { segment: 'ui', engine: 'llm', toLang: 'de', tone: 'informal', glossary: 'dynamic' } },
    ],
    run,
  },

  compare: {
    suggestions: [
      'Translate the UI string to German with Translator, glossary none vs dynamic: compare the tenant term.',
      'Translate the legal clause to German with Translator and with the LLM (no glossary): both are fluent, but which uses the approved term?',
      'Translate the user comment to French with profanityAction NoAction, Marked and Deleted, then with the LLM in formal tone.',
    ],
  },

  debug: [
    { id: 'wrongsource', title: 'German email "translated" into the same German text', values: { segment: 'german', engine: 'translator', fromLang: 'en', toLang: 'fr' }, node: 'detect',
      symptom: 'The French output is the original German sentence.', cause: 'from=en was hard-coded, but the text is German.', fix: 'Omit "from" so Translator detects the language (choose auto-detect), or pass the correct code.' },
    { id: 'invalidcode', title: '400 for a new market', values: { toLang: 'zz', engine: 'translator' }, node: 'route',
      symptom: 'Translator returns 400: target language not valid.', cause: 'Unsupported / mistyped language code.', fix: 'Validate codes against the /languages endpoint; pick a supported target.' },
    { id: 'glossaryignored', title: 'LLM ignores the approved legal term', values: { segment: 'legal', engine: 'llm', toLang: 'de', glossary: 'dynamic', temperature: 1.2 }, node: 'llm',
      symptom: 'Terminology check fails: "entschädigen" instead of "freistellen".', cause: 'A prompt glossary is an instruction; high temperature increases paraphrasing.', fix: 'Lower temperature (≤ 0.5), keep the terminology check, or use Translator with a custom model for strict terms.' },
    { id: 'region', title: '401 from Translator after moving to a regional resource', values: { regionHeader: false, engine: 'translator' }, node: 'auth',
      symptom: 'Every call returns 401.', cause: 'Key auth against a regional/multi-service resource without Ocp-Apim-Subscription-Region.', fix: 'Send the region header (or use Entra ID).' },
    { id: 'notdeployed', title: 'Custom model category rejected', values: { glossary: 'custom', customDeployed: false, engine: 'translator', segment: 'legal' }, node: 'glossary',
      symptom: '400 when the category parameter is added.', cause: 'The Custom Translator model was trained but not deployed to this region.', fix: 'Deploy the model (toggle "deployed"), or use a dynamic dictionary meanwhile.' },
  ],

  challenge: {
    task: 'Ship the UI string to the Japanese app with Azure Translator: approved terminology for both the brand and "tenant", plus a Latin-script version for the support team.',
    condition: 'Segment = UI string, engine = Translator, target = ja, terminology 2/2, transliteration present, no errors or warnings.',
    hint: 'General MT renders "tenant" as "lessee". Something must force the approved terms.',
    check: (p, res) => p.segment === 'ui' && p.engine === 'translator' && p.toLang === 'ja' && p.transliterate && res.meta && res.meta.termAcc === 1 && !res.steps.some(s => s.status === 'error' || s.status === 'warn'),
    solution: ['Segment UI string, engine Translator, target Japanese.', 'Glossary: dynamic dictionary (few terms) or a deployed Custom Translator category.', 'Turn on Latin-script transliteration.', 'Run and confirm terminology 2/2.'],
    solutionValues: { segment: 'ui', engine: 'translator', toLang: 'ja', fromLang: 'auto', glossary: 'dynamic', transliterate: true, regionHeader: true },
  },

  quiz: [
    { q: 'Five product names must never be translated in Translator output, and you need this today without training a model. What do you use?', options: ['Dynamic dictionary markup (or notranslate markup) in the request', 'A Custom Translator model', 'profanityAction=Deleted', 'An LLM at temperature 1.2'], answer: 0, why: 'Dynamic dictionary is meant for a small number of forced terms per request. Custom Translator needs training and deployment.' },
    { q: 'Marketing wants German copy in informal "du" form with a brand voice; legal clauses must use approved terms exactly. Which design fits?', options: ['Translator for everything', 'LLM flow (tone in prompt) for marketing; Translator with a Custom Translator model for legal, both followed by a terminology check', 'LLM flow for everything at high temperature', 'Transliteration for marketing'], answer: 1, why: 'Route by content type: LLM for style control, MT with a custom model for strict, consistent terminology; always check terms.' },
    { q: 'Support emails arrive in many languages and your code calls Translator with from=en. Non-English emails come back unchanged. Fix?', options: ['Add the region header', 'Omit "from" so the service auto-detects the source language', 'Use profanityAction=Marked', 'Switch to toScript=Latn'], answer: 1, why: 'When "from" is omitted Translator detects the language and returns detectedLanguage with a score.' },
  ],

  recap: 'Translator gives fast, per-character, predictable MT with auto-detection, multiple targets, profanity handling, transliteration, dynamic dictionaries and Custom Translator models. LLM flows add tone and style control but need code validation, low temperature and a terminology check. Route content by requirement and always verify approved terms.',
};
