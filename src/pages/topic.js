// Agenda topic page: Understand → Workbench (visualize + simulate) → Compare → Debug → Apply & assess → Recap.
import { h, clear, append, fmtValue, animationsSettled } from '../engine/dom.js';
import { createVisualizer } from '../engine/visualizer.js';
import { createLab } from '../engine/lab.js';
import { createExplainer } from '../explainer/engine.js';
import { getProgress, setProgress, isComplete } from '../engine/store.js';
import { AGENDA, findAgenda, objectiveText } from '../agenda.js';
import { SOURCE } from '../syllabus.js';

const SECTIONS = [
  ['explain', '🎞️ See the concept'], ['understand', '💡 Understand'], ['workbench', '🧪 Workbench'],
  ['scenarios', '🎓 Exam scenarios'], ['compare', '⚖️ Compare'], ['debug', '🐞 Debug'], ['assess', '🏆 Challenge & quiz'],
];

const link = id => {
  const a = findAgenda(id);
  return a ? h('a', { href: `#/s/${id}` }, a.title) : null;
};

// Forward lab events to every view that listens (workbench + architecture diagram).
function fanout(views) {
  const call = (fn, ...args) => views.forEach(v => v && v[fn] && v[fn](...args));
  return {
    setParams: p => call('setParams', p), setResult: r => call('setResult', r), setStep: st => call('setStep', st),
    clearRun: () => call('clearRun'), reset: () => call('reset'), flash: id => call('flash', id), select: id => call('select', id),
    // The first view is the workbench: wait for its own idle signal or for its animations to finish.
    idle: () => (views[0].idle ? views[0].idle() : animationsSettled(views[0].el)),
  };
}

export async function renderTopic(root, id) {
  const meta = findAgenda(id);
  if (!meta) { root.appendChild(h('p', 'Unknown topic.')); return; }
  let mod, wbMod, scenes = null;
  try {
    mod = (await import(`../../content/${id}.js`)).default;
    wbMod = await import(`../workbenches/${mod.workbench}.js`);
    scenes = (await import(`../explainer/${id}.js`).catch(() => ({ default: null }))).default;
  } catch (e) {
    root.appendChild(h('div.alert.tone-error', `The lab for ${id} could not be loaded: ${e.message}`));
    return;
  }

  const idx = AGENDA.findIndex(a => a.id === id);
  const prev = AGENDA[idx - 1], next = AGENDA[idx + 1];
  const progressEl = h('div.progress-pills');
  const refreshProgress = () => {
    const p = getProgress(id);
    append(clear(progressEl), [
      h(`span.chip.${p.challenge ? 'tone-ok' : 'tone-muted'}`, p.challenge ? '✓ Challenge' : 'Challenge'),
      h(`span.chip.${p.quizTotal ? 'tone-ok' : 'tone-muted'}`, p.quizTotal ? `Quiz ${p.quizCorrect}/${p.quizTotal}` : 'Quiz'),
      h(`span.chip.${(p.debugSolved || []).length ? 'tone-ok' : 'tone-muted'}`, `Debug ${(p.debugSolved || []).length}/${mod.debug.length}`),
      mod.scenarios ? h(`span.chip.${(p.scenariosCorrect || []).length ? 'tone-ok' : 'tone-muted'}`, `Scenarios ${(p.scenariosCorrect || []).length}/${mod.scenarios.length}`) : null,
      isComplete(p) ? h('span.chip.tone-ok', '★ Complete') : null]);
  };
  window.addEventListener('progress', refreshProgress);
  refreshProgress();

  root.style.setProperty('--topic', meta.color);
  root.style.setProperty('--topic-2', meta.color2);
  const header = h('header.hero.topic-hero',
    h('nav.crumbs', { 'aria-label': 'Breadcrumb' }, h('a', { href: '#/' }, 'Home'), ' › ', `Topic ${idx + 1} of ${AGENDA.length}`),
    h('div.hero-row',
      h('span.hero-emoji', { 'aria-hidden': 'true' }, meta.emoji),
      h('div',
        h('p.hero-eyebrow', `Topic ${idx + 1} · ${mod.lab}`),
        h('h1', meta.title),
        h('p.hero-lead', meta.summary))),
    progressEl,
    h('nav.section-nav', { 'aria-label': 'Sections' }, SECTIONS.map(([a, l]) => h('a', { href: `#/s/${id}`, onclick: e => { e.preventDefault(); document.getElementById(`sec-${a}`).scrollIntoView({ behavior: 'smooth' }); } }, l))));

  const explainer = scenes ? createExplainer(scenes, { title: `${meta.title}: concept explainer` }) : null;
  const explain = explainer ? section('explain', 'See the concept',
    h('p.small', 'A short animated walkthrough of the core idea, one step at a time. Use Next / Back or the arrow keys; Presenter mode fills the screen.'),
    explainer.el) : null;

  const c = mod.concept;
  const understand = section('understand', 'A. Understand the concept',
    meta.exam ? h('div.exam-box',
      h('h3', '🎯 What the AI-103 exam expects'),
      h('ul', meta.exam.map(([point, obj]) => h('li', h('span', point), ' ', h('span.exam-obj', { title: objectiveText(obj) }, obj)))),
      h('p.small', 'Summarised from the official objective wording (hover a number to read it). These are study pointers, not actual exam questions.')) : null,
    h('div.two-col',
      h('div', h('h3', 'In plain language'), h('p', c.plain), h('h3', 'Technical explanation'), h('p', c.technical)),
      h('div', h('h3', 'Real-world use case'), h('p', c.useCase),
        h('h3', 'Key terms'), h('dl.kv', c.terms.map(([t, d]) => [h('dt', t), h('dd', d)])))),
    h('div.two-col',
      h('div', h('h3', 'What this lab covers'), h('ol', meta.stages.map(x => h('li', x))),
        h('h3', 'Related AI-103 objectives'), h('ul.small', meta.objectives.map(o => h('li', h('strong', o), ' ', objectiveText(o)))),
        h('p.small', 'Source: ', h('a', { href: SOURCE.url, target: '_blank', rel: 'noopener' }, SOURCE.outlineVersion))),
      h('div', h('h3', 'Build on'), mod.prereqs.length ? h('ul', mod.prereqs.map(p => h('li', link(p)))) : h('p.small', 'Start here.'),
        h('h3', 'Azure services & documentation'), h('ul', mod.services.map(s => h('li', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name)))))));

  const wb = wbMod.createWorkbench(mod);
  const graph = createVisualizer(mod);
  const viz = fanout([wb, graph]);
  const lab = createLab(mod, viz);

  const workbench = section('workbench', mod.lab,
    h('p.small.wb-intro', 'Press ▶ Run to play every stage, or Next step to go one stage at a time while you explain. Click anything in the workbench to inspect it. Scenarios and ⚙ Settings change the input.'),
    lab.toolbarEl, lab.settingsEl,
    wb.el,
    lab.detailsEl,
    h('details.fold.arch', h('summary', 'Architecture and code views'),
      h('p.small', 'The same pipeline as Azure resources and SDK calls. Nodes light up as the simulation runs.'), graph.el));
  workbench.classList.add('lab');
  // One narration line: mirror the workbench's caption into the now bar above it.
  const wbCaption = wb.el.querySelector('.wb-caption');
  if (wbCaption) {
    wbCaption.classList.add('mirrored');
    const sync = () => lab.narrate(wbCaption.textContent);
    new MutationObserver(sync).observe(wbCaption, { childList: true, characterData: true, subtree: true });
    sync();
  }

  // ---- Exam-style scenarios: each option plays in the workbench ----
  const scenarioBanner = h('div.scenario-banner', { hidden: true, 'aria-live': 'polite' });
  workbench.insertBefore(scenarioBanner, lab.toolbarEl);
  let pendingScenario = null;
  const letter = i => String.fromCharCode(65 + i);
  const scenarioCards = (mod.scenarios || []).map((sc, si) => {
    const verdictEl = h('div.sc-verdict');
    const opts = sc.options.map((o, oi) => h('button.sc-opt', { type: 'button', onclick: () => play(sc, si, oi) },
      h('span.sc-letter', letter(oi)), h('span', o.label)));
    const card = h('article.sc-card', { id: `sc-${sc.id}` },
      h('div.sc-head', h('span.sc-num', `Scenario ${si + 1}`), h('span.exam-obj', { title: objectiveText(sc.objective) }, sc.objective)),
      h('h3', sc.title), h('p', sc.stem), h('p.sc-question', sc.question),
      h('div.sc-opts', opts),
      h('p.small.sc-hint', 'Pick an answer: the workbench above loads that choice and plays it, so you can see what would happen.'),
      verdictEl);
    if ((getProgress(id).scenariosCorrect || []).includes(sc.id)) card.classList.add('done');
    card._verdict = verdictEl; card._opts = opts;
    return card;
  });
  function play(sc, si, oi) {
    const o = sc.options[oi];
    const card = scenarioCards[si];
    card._opts.forEach((b, k) => b.classList.toggle('chosen', k === oi));
    pendingScenario = { sc, si, oi };
    scenarioBanner.hidden = false;
    clear(scenarioBanner).append(
      h('div.sb-main', h('strong', `🎓 Scenario ${si + 1}: ${sc.title}`), h('span', `Playing your choice ${letter(oi)}: “${o.label}”…`)),
      h('button.btn.ghost.small', { type: 'button', onclick: () => card.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, '↩ Back to the scenario'));
    lab.load(o.values || {});
    document.getElementById('sec-workbench').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => lab.run(), 450);
  }
  lab.onRun(() => {
    if (!pendingScenario) return;
    const { sc, si, oi } = pendingScenario;
    pendingScenario = null;
    const o = sc.options[oi], card = scenarioCards[si];
    const correctIdx = sc.options.findIndex(x => x.correct);
    const ok = !!o.correct;
    const verdict = [
      h('p', h('strong', ok ? '✓ Correct. ' : '✗ Not the best choice. '), o.why),
      ok ? null : h('p.small', `The best answer is ${letter(correctIdx)}: ${sc.options[correctIdx].why}`),
    ];
    clear(card._verdict).append(h(`div.alert.tone-${ok ? 'ok' : 'error'}`, verdict));
    card._opts.forEach((b, k) => { b.classList.toggle('right', k === correctIdx && ok); b.classList.toggle('wrong', k === oi && !ok); });
    clear(scenarioBanner).append(
      h(`div.sb-main.tone-${ok ? 'ok' : 'error'}`, h('strong', `${ok ? '✓ Correct' : '✗ Not the best choice'} · Scenario ${si + 1}, choice ${letter(oi)}`), h('span', o.why)),
      h('div.sb-actions',
        ok ? null : h('button.btn.small', { type: 'button', onclick: () => play(sc, si, correctIdx) }, `▶ Play the best answer (${letter(correctIdx)})`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => card.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, '↩ Back to the scenario')));
    if (ok) {
      card.classList.add('done');
      const done = new Set(getProgress(id).scenariosCorrect || []); done.add(sc.id);
      setProgress(id, { scenariosCorrect: [...done] });
    }
  });
  const scenarios = mod.scenarios ? section('scenarios', 'Exam-style scenarios',
    h('p.small', 'Short cases in the style of AI-103 questions, written for this site from the official objectives. They are not real exam questions. Each answer is wired to the workbench: choose one and watch what it does.'),
    h('div.sc-list', scenarioCards)) : null;

  // ---- D. compare ----
  const histEl = h('div');
  const compare = section('compare', 'D. Experiment and compare',
    h('h3', 'Try these experiments'), h('ol', mod.compare.suggestions.map(x => h('li', x))),
    h('h3', 'Run history'), h('p.small', 'Every run is recorded here (newest first). Pick two runs to see exactly which settings changed and how the results differ.'),
    histEl);
  let pickA = null, pickB = null;
  const drawHistory = () => {
    clear(histEl);
    const hist = lab.history;
    if (!hist.length) { histEl.appendChild(h('p.small.muted', 'No runs yet.')); return; }
    if (pickA == null || !hist.find(r => r.n === pickA)) pickA = hist[0].n;
    if (pickB == null || !hist.find(r => r.n === pickB)) pickB = (hist[1] || hist[0]).n;
    histEl.appendChild(h('div.table-wrap', h('table',
      h('thead', h('tr', h('th', 'Run'), h('th', 'Summary'), h('th', 'Errors / warnings'), h('th', 'Compare A'), h('th', 'Compare B'), h('th', ''))),
      h('tbody', hist.map(r => h('tr',
        h('td', '#' + r.n), h('td', r.result.summary),
        h('td', `${r.result.steps.filter(s => s.status === 'error').length} / ${r.result.steps.filter(s => s.status === 'warn').length}`),
        h('td', radio('A', r.n, pickA, v => { pickA = v; drawHistory(); })),
        h('td', radio('B', r.n, pickB, v => { pickB = v; drawHistory(); })),
        h('td', h('button.btn.small', { type: 'button', onclick: () => { lab.load(r.params); document.getElementById('sec-workbench').scrollIntoView({ behavior: 'smooth' }); } }, 'Restore settings'))))))));
    const A = hist.find(r => r.n === pickA), B = hist.find(r => r.n === pickB);
    if (A && B && A !== B) histEl.appendChild(diffRuns(mod, A, B));
  };
  lab.onRun(() => { if (lab.history.length > 1) { pickA = lab.history[1].n; pickB = lab.history[0].n; } drawHistory(); });
  drawHistory();

  // ---- E. debug ----
  const debugCards = mod.debug.map(d => {
    const out = h('div.debug-out');
    const card = h('article.card.debug-card',
      h('h3', d.title),
      h('div.btn-row',
        h('button.btn', { type: 'button', onclick: () => loadScenario(d, card, out) }, 'Load failing scenario'),
        h('button.btn.ghost', { type: 'button', onclick: e => { e.target.replaceWith(h('p', h('strong', 'Cause: '), d.cause)); } }, 'Reveal cause'),
        h('button.btn.ghost', { type: 'button', onclick: e => { e.target.replaceWith(h('p', h('strong', 'Fix: '), d.fix)); } }, 'Show fix')),
      out);
    if ((getProgress(id).debugSolved || []).includes(d.id)) card.classList.add('solved');
    return card;
  });
  let activeScenario = null;
  function loadScenario(d, card, out) {
    lab.load(d.values || {});
    lab.runInstant();
    const res = lab.result;
    activeScenario = { d, card, out, baseline: res.steps.filter(s => s.status === 'error' || s.status === 'warn').length };
    append(clear(out), [
      h('p', h('strong', 'Symptom: '), d.symptom),
      h('p.small', `The highlighted component is “${d.node}”. Now change the configuration in the simulator and run again. The scenario is solved when the run has no errors and fewer problems than now.`)]);
    viz.flash(d.node);
    document.getElementById('sec-workbench').scrollIntoView({ behavior: 'smooth' });
  }
  lab.onRun((p, res) => {
    if (!activeScenario) return;
    const problems = res.steps.filter(s => s.status === 'error' || s.status === 'warn').length;
    const errors = res.steps.some(s => s.status === 'error');
    if (!errors && problems < activeScenario.baseline) {
      const { d, card, out } = activeScenario;
      card.classList.add('solved');
      out.appendChild(h('p.alert.tone-ok', `Solved: the failure is gone. ${d.fix}`));
      const solved = new Set(getProgress(id).debugSolved || []); solved.add(d.id);
      setProgress(id, { debugSolved: [...solved] });
      activeScenario = null;
    }
  });
  const debug = section('debug', 'E. Debug and learn',
    h('p.small', 'Each scenario loads a deliberately broken configuration and runs it. Read the symptom, inspect the highlighted component and its step data, then fix it using the controls.'),
    h('div.card-grid', debugCards));

  // ---- F. assess ----
  const ch = mod.challenge;
  const chResult = h('div', { 'aria-live': 'polite' });
  const solutionEl = h('div');
  let attempted = !!getProgress(id).challengeAttempted;
  const showSolutionBtn = () => {
    clear(solutionEl);
    if (!attempted) { solutionEl.appendChild(h('p.small.muted', 'The solution walkthrough unlocks after your first attempt.')); return; }
    solutionEl.appendChild(h('details',
      h('summary', 'Solution walkthrough'),
      h('ol', ch.solution.map(x => h('li', x))),
      h('button.btn.small', { type: 'button', onclick: () => { lab.load(ch.solutionValues, true); document.getElementById('sec-workbench').scrollIntoView({ behavior: 'smooth' }); } }, 'Load the solution settings')));
  };
  showSolutionBtn();
  const checkChallenge = () => {
    attempted = true;
    setProgress(id, { challengeAttempted: true });
    showSolutionBtn();
    clear(chResult);
    const res = lab.result;
    if (!res) { chResult.appendChild(h('p.alert.tone-warn', 'Run the simulator with your settings first, then check.')); return; }
    let ok = false;
    try { ok = !!ch.check({ ...lab.params }, res); } catch { ok = false; }
    if (ok) { chResult.appendChild(h('p.alert.tone-ok', 'Challenge complete. Your latest run meets the completion condition.')); setProgress(id, { challenge: true }); }
    else chResult.appendChild(h('p.alert.tone-error', 'Not yet. Your latest run does not meet the completion condition. Re-read the condition, adjust, run, and check again.'));
  };

  const quizEl = h('div.quiz');
  const answers = {};
  mod.quiz.forEach((q, qi) => {
    const fb = h('div.quiz-feedback', { 'aria-live': 'polite' });
    const name = `q-${id}-${qi}`;
    quizEl.appendChild(h('fieldset.card.quiz-q',
      h('legend', `${qi + 1}. ${q.q}`),
      q.options.map((o, oi) => h('label.quiz-opt', h('input', { type: 'radio', name, value: oi, onchange: () => {
        answers[qi] = oi;
        const correct = oi === q.answer;
        clear(fb).appendChild(h(`p.alert.tone-${correct ? 'ok' : 'error'}`, correct ? 'Correct. ' : `Not quite — the answer is “${q.options[q.answer]}”. `, q.why));
        const vals = Object.entries(answers);
        if (vals.length === mod.quiz.length) setProgress(id, { quizTotal: mod.quiz.length, quizCorrect: vals.filter(([i, a]) => mod.quiz[i].answer === a).length });
      } }), ' ', o)),
      fb));
  });

  const assess = section('assess', 'F. Apply and assess',
    h('div.card.challenge',
      h('h3', 'Mini-challenge'),
      h('p', ch.task),
      h('p', h('strong', 'Completion condition: '), ch.condition),
      h('details', h('summary', 'Hint'), h('p', ch.hint)),
      h('div.btn-row', h('button.btn.primary', { type: 'button', onclick: checkChallenge }, 'Check my latest run')),
      chResult, solutionEl),
    h('h3', 'Scenario-based knowledge check'), quizEl);

  const recap = h('section.section.recap',
    h('h2.sec-title', h('span.sec-badge', { 'aria-hidden': 'true' }, '🎯'), 'Recap'), h('p', mod.recap),
    h('div.two-col',
      h('div', h('h3', 'Build on'), mod.prereqs.length ? h('ul', mod.prereqs.map(p => h('li', link(p)))) : h('p.small', '—')),
      h('div', h('h3', 'Go further'), mod.next.length ? h('ul', mod.next.map(p => h('li', link(p)))) : h('p.small', '—'))),
    h('nav.pager', prev ? h('a.btn', { href: `#/s/${prev.id}` }, `‹ ${prev.short}`) : h('span'), next ? h('a.btn', { href: `#/s/${next.id}` }, `${next.short} ›`) : h('span')));

  root.append(header, ...(explain ? [explain] : []), understand, workbench, ...(scenarios ? [scenarios] : []), compare, debug, assess, recap);
  return () => { window.removeEventListener('progress', refreshProgress); if (explainer) explainer.stop(); };
}

const BADGES = { explain: ['', '🎞️'], understand: ['A', '💡'], workbench: ['B', '🧪'], scenarios: ['', '🎓'], compare: ['D', '⚖️'], debug: ['E', '🐞'], assess: ['F', '🏆'] };

function section(anchor, title, ...kids) {
  const [letter, icon] = BADGES[anchor] || ['', ''];
  return h(`section.section.sec-${anchor}`, { id: `sec-${anchor}`, 'aria-labelledby': `h-${anchor}` },
    h('h2.sec-title', { id: `h-${anchor}` }, h('span.sec-badge', { 'aria-hidden': 'true' }, icon), title.replace(/^[A-F](–[A-F])?\. /, '')), kids);
}

function radio(group, n, current, on) {
  return h('input', { type: 'radio', name: `cmp-${group}`, 'aria-label': `Compare ${group}: run ${n}`, checked: n === current, onchange: () => on(n) });
}

function diffRuns(mod, A, B) {
  const changed = mod.sim.controls.filter(c => fmtValue(A.params[c.id]) !== fmtValue(B.params[c.id]));
  const mA = Object.fromEntries((A.result.metrics || []).map(m => [m.label, m]));
  const mB = Object.fromEntries((B.result.metrics || []).map(m => [m.label, m]));
  const labels = [...new Set([...Object.keys(mA), ...Object.keys(mB)])];
  const statuses = r => r.result.steps.map(s => `${s.title} (${s.status})`);
  return h('div.card.diff-card',
    h('h4', `Run #${A.n} (A) vs run #${B.n} (B)`),
    h('div.table-wrap', h('table',
      h('thead', h('tr', h('th', ''), h('th', 'A'), h('th', 'B'))),
      h('tbody',
        h('tr.group', h('td', { colspan: 3 }, changed.length ? 'Settings that differ' : 'Settings are identical')),
        changed.map(c => h('tr', h('th', { scope: 'row' }, c.label), h('td', fmtValue(A.params[c.id])), h('td', fmtValue(B.params[c.id])))),
        h('tr.group', h('td', { colspan: 3 }, 'Measurements')),
        labels.map(l => h(`tr${(mA[l] || {}).value !== (mB[l] || {}).value ? '.changed' : ''}`, h('th', { scope: 'row' }, l, mA[l] && mA[l].kind === 'estimate' ? ' (estimate)' : ''), h('td', (mA[l] || {}).value || '—'), h('td', (mB[l] || {}).value || '—'))),
        h('tr.group', h('td', { colspan: 3 }, 'Outcome')),
        h('tr', h('th', { scope: 'row' }, 'Summary'), h('td', A.result.summary), h('td', B.result.summary)),
        h('tr', h('th', { scope: 'row' }, 'Steps'), h('td', h('ol.small', statuses(A).map(x => h('li', x)))), h('td', h('ol.small', statuses(B).map(x => h('li', x)))))))));
}
