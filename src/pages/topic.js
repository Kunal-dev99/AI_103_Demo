// Agenda topic page: Understand → Workbench (visualize + simulate) → Compare → Debug → Apply & assess → Recap.
import { h, clear, append, fmtValue } from '../engine/dom.js';
import { createVisualizer } from '../engine/visualizer.js';
import { createLab } from '../engine/lab.js';
import { getProgress, setProgress, isComplete } from '../engine/store.js';
import { AGENDA, findAgenda, objectiveText } from '../agenda.js';
import { SOURCE } from '../syllabus.js';

const SECTIONS = [
  ['understand', 'A. Understand'], ['workbench', 'B–C. Visualize & simulate'],
  ['compare', 'D. Experiment & compare'], ['debug', 'E. Debug'], ['assess', 'F. Apply & assess'],
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
  };
}

export async function renderTopic(root, id) {
  const meta = findAgenda(id);
  if (!meta) { root.appendChild(h('p', 'Unknown topic.')); return; }
  let mod, wbMod;
  try {
    mod = (await import(`../../content/${id}.js`)).default;
    wbMod = await import(`../workbenches/${mod.workbench}.js`);
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
      isComplete(p) ? h('span.chip.tone-ok', '★ Complete') : null]);
  };
  window.addEventListener('progress', refreshProgress);
  refreshProgress();

  const header = h('header.page-head',
    h('nav.crumbs', { 'aria-label': 'Breadcrumb' }, h('a', { href: '#/' }, 'Home'), ' › ', `Topic ${idx + 1} of ${AGENDA.length}`),
    h('p.eyebrow', `Lab: ${mod.lab}`),
    h('h1', meta.title),
    h('p.lead', meta.summary),
    progressEl,
    h('nav.section-nav', { 'aria-label': 'Sections' }, SECTIONS.map(([a, l]) => h('a', { href: `#/s/${id}`, onclick: e => { e.preventDefault(); document.getElementById(`sec-${a}`).scrollIntoView({ behavior: 'smooth' }); } }, l))));

  const c = mod.concept;
  const understand = section('understand', 'A. Understand the concept',
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

  const workbench = section('workbench', `B–C. ${mod.lab}`,
    h('p.small', 'Configure the lab below, then Run (all stages) or Step (one stage at a time). The workbench shows each stage happening; click anything in it to inspect it.'),
    wb.el, lab.el,
    h('details.arch', h('summary', 'Architecture and code views'),
      h('p.small', 'The same pipeline as Azure resources and SDK calls. Nodes light up as the simulation runs.'), graph.el));

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
    h('h2', 'Recap'), h('p', mod.recap),
    h('div.two-col',
      h('div', h('h3', 'Build on'), mod.prereqs.length ? h('ul', mod.prereqs.map(p => h('li', link(p)))) : h('p.small', '—')),
      h('div', h('h3', 'Go further'), mod.next.length ? h('ul', mod.next.map(p => h('li', link(p)))) : h('p.small', '—'))),
    h('nav.pager', prev ? h('a.btn', { href: `#/s/${prev.id}` }, `‹ ${prev.short}`) : h('span'), next ? h('a.btn', { href: `#/s/${next.id}` }, `${next.short} ›`) : h('span')));

  root.append(header, understand, workbench, compare, debug, assess, recap);
  return () => window.removeEventListener('progress', refreshProgress);
}

function section(anchor, title, ...kids) {
  return h('section.section', { id: `sec-${anchor}`, 'aria-labelledby': `h-${anchor}` }, h('h2', { id: `h-${anchor}` }, title), kids);
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
