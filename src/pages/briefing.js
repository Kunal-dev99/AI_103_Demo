// 60-minute exam briefing: the opening questions (#/start), then the question archetypes in presenting order.
import { h, clear, append } from '../engine/dom.js';

const MODULES = ['a1-model', 'a5-cu', 'a2-ingestion', 'a3-security', 'a4-troubleshoot'];
const pad = n => String(n).padStart(2, '0');

export async function renderBriefing(root) {
  const mods = await Promise.all(MODULES.map(f => import(`../briefing/${f}.js`).then(m => m.default).catch(() => null)));
  const agenda = [['intro', 'Opening', 9], ...mods.map((m, i) => [`a${i + 1}`, m ? m.title.split(':')[0] : `Archetype ${i + 1}`, m ? m.minutes : 12]), ['wrap', 'Recap', 6]];
  const total = agenda.reduce((a, x) => a + x[2], 0);

  // ---- agenda bar with presenter timer ----
  let timer = null, startedAt = 0, elapsed = 0;   // elapsed: ms accumulated before the current run
  const clock = h('span.bf-clock', '00:00');
  const startBtn = h('button.btn.small', { type: 'button', onclick: () => {
    if (timer) { elapsed += Date.now() - startedAt; clearInterval(timer); timer = null; startBtn.textContent = 'Resume timer'; return; }
    startedAt = Date.now(); timer = setInterval(tick, 500); tick(); startBtn.textContent = 'Pause timer';
  } }, 'Start timer');
  const tick = () => {
    const sec = Math.floor((elapsed + Date.now() - startedAt) / 1000);
    clock.textContent = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
    const min = sec / 60;
    let acc = 0;
    bar.querySelectorAll('.bf-seg').forEach((seg, i) => {
      const m = agenda[i][2];
      seg.classList.toggle('past', min >= acc + m);
      seg.classList.toggle('now', min >= acc && min < acc + m);
      acc += m;
    });
    clock.classList.toggle('over', min > total);
  };
  const bar = h('div.bf-bar', agenda.map(([id, label, m]) => h('a.bf-seg', { href: '#/briefing', style: `flex:${m}`, onclick: e => { e.preventDefault(); document.getElementById(`bf-${id}`)?.scrollIntoView({ behavior: 'smooth' }); } },
    h('span.bf-seg-label', label), h('span.bf-seg-min', `${m} min`))));
  const agendaEl = h('div.bf-agenda', bar, h('div.bf-timer', clock, h('span.small', `/ ${total} min`), startBtn));

  // ---- intro ----
  const intro = h('section.section', { id: 'bf-intro' },
    h('div.sec-head', h('p.overline', '00 · 9 min'), h('h2', 'Opening, then how these questions work')),
    h('div.bf-crux', h('span.overline', 'Minutes 0–8'), h('p', 'Run the six opening questions first: document vs content, how people read, what a computer sees, and why these services exist.'),
      h('p', h('a.btn.small.primary', { href: '#/start' }, 'Open the opening questions →'))),
    h('p', h('span.overline', 'Minute 8–9 · bridge'), ' In the AI-103 domain ', h('em', 'Implement information extraction solutions'), ', Document Intelligence and Content Understanding questions are not trivia. Each one is a short scenario with a constraint, and you are asked for the design choice, the integration step or the fix.'),
    h('div.bf-anatomy',
      [['Scenario', 'What documents, what system, who uses it.'], ['Constraint', 'No labelled data, this sprint, tables needed, users upload files, 429 errors…'], ['Crux', 'The one fact that decides the answer.'], ['Answer', 'The least-effort option that satisfies the constraint.']]
        .map(([t, d], i) => h('div', h('span.step-num', pad(i + 1)), h('strong', t), h('span.small', d)))),
    h('p.small', 'Questions below are written for this briefing in the style of the exam. They are not real exam questions.'));

  // ---- archetype modules ----
  const sections = mods.map((m, i) => {
    const id = `bf-a${i + 1}`;
    if (!m) return h('section.section', { id }, h('div.sec-head', h('p.overline', `${pad(i + 1)}`), h('h2', `Archetype ${i + 1}`)), h('p.small', 'This module is not available yet.'));
    let vizEl;
    try { vizEl = m.viz(); } catch (e) { vizEl = h('div.alert.tone-error', 'Visual failed to load: ' + e.message); }
    return h('section.section.bf-module', { id },
      h('div.sec-head', h('p.overline', `${pad(i + 1)} · ${m.minutes} min`), h('h2', m.title)),
      h('div.bf-crux', h('span.overline', 'The crux'), h('p', m.crux)),
      h('h3', 'Decision rules'),
      h('div.table-wrap', h('table.bf-rules', h('thead', h('tr', h('th', 'When the scenario says…'), h('th', 'Choose'), h('th', 'Because'))),
        h('tbody', m.rules.map(([w, c, y]) => h('tr', h('td', w), h('td', h('strong', c)), h('td.small', y)))))),
      h('h3', 'See it'),
      vizEl,
      h('h3', 'Exam-style questions'),
      h('div.bf-questions', m.questions.map((q, qi) => question(q, `${i + 1}.${qi + 1}`))),
      m.live && m.live.length ? h('p.bf-live', h('span.overline', 'Show it live'), m.live.map(l => h('a.btn.small', { href: l.href }, l.label + ' →'))) : null,
      h('div.bf-takeaway', h('span.overline', 'Takeaway'), h('p', m.takeaway)));
  });

  // ---- wrap-up ----
  const wrap = h('section.section', { id: 'bf-wrap' },
    h('div.sec-head', h('p.overline', `${pad(mods.length + 1)} · ${agenda[agenda.length - 1][2]} min`), h('h2', 'Checklist & recap')),
    h('div.table-wrap', h('table.bf-rules',
      h('thead', h('tr', h('th', 'Area'), h('th', 'What you must be able to do'))),
      h('tbody', [
        ['Model selection', 'Pick prebuilt vs custom template vs custom neural vs generative from document type, layout variability, labelled data and implied values.'],
        ['Content Understanding', 'Define an analyzer per modality with a field schema; choose extract, classify (with categories) or generate; turn on grounding for citations; use pro mode for cross-document checks.'],
        ['Data types', 'Tell structured (forms, tables) from semi-structured (invoices, manifests) from unstructured (contracts, reports).'],
        ['Search ingestion', 'Extract text and tables → chunk on layout boundaries → tag metadata → index in Azure AI Search for grounded RAG.'],
        ['Security & safety', 'Recognise indirect prompt injection in uploaded files; filter extracted text with Prompt Shields (document attacks) before an LLM or tool sees it.'],
        ['Troubleshooting', 'Map symptoms to the broken layer; handle 429s with Retry-After, exponential backoff and jitter.'],
      ].map(([a, b]) => h('tr', h('td', h('strong', a)), h('td', b)))))),
    h('h3', 'One line per archetype'),
    h('ol.bf-recap', mods.filter(Boolean).map(m => h('li', h('strong', m.title.split(':')[0] + ': '), m.takeaway))));

  root.append(
    h('header.hero', h('p.overline', 'Exam briefing · 60 minutes'),
      h('h1', 'Document Intelligence and Content Understanding on the AI-103 exam'),
      h('p.hero-lead', 'The six opening questions, then five question archetypes, each with its decision rules, a visual you can drive live, and practice questions. Follow the agenda bar; start the timer when you begin.')),
    agendaEl, intro, ...sections, wrap);
  return () => { if (timer) clearInterval(timer); };
}

function question(q, num) {
  const fb = h('div.bf-fb', { 'aria-live': 'polite' });
  const opts = q.options.map((o, oi) => h('button.sc-opt', { type: 'button', onclick: () => {
    opts.forEach((b, k) => { b.classList.toggle('right', k === q.answer); b.classList.toggle('wrong', k === oi && oi !== q.answer); b.classList.toggle('chosen', k === oi); });
    append(clear(fb), [h(`div.alert.tone-${oi === q.answer ? 'ok' : 'error'}`, h('strong', oi === q.answer ? 'Correct. ' : `Not quite — the answer is ${String.fromCharCode(65 + q.answer)}. `), q.why)]);
  } }, h('span.sc-letter', String.fromCharCode(65 + oi)), h('span', o)));
  return h('article.sc-card', h('div.sc-head', h('span.sc-num', `Question ${num}`)), h('p.sc-question', q.q), h('div.sc-opts', opts), fb);
}
