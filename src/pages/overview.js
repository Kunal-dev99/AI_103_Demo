// Home, coverage and navigation for the agenda.
import { h, clear } from '../engine/dom.js';
import { AGENDA, objectiveText } from '../agenda.js';
import { SOURCE } from '../syllabus.js';
import { MODES } from '../engine/contract.js';
import { allProgress, isComplete, resetAll } from '../engine/store.js';

const modCache = {};
export function loadModule(id) {
  if (!modCache[id]) modCache[id] = import(`../../content/${id}.js`).then(m => m.default).catch(e => ({ error: e.message }));
  return modCache[id];
}

const ICONS = {
  ingestion: '▤', fields: '⌗', classification: '⇶', multimodal: '◫',
};

export function renderHome(root) {
  const prog = allProgress();
  const done = AGENDA.filter(a => isComplete(prog[a.id] || {})).length;
  root.append(
    h('header.page-head',
      h('p.eyebrow', 'Azure AI-103 · information extraction and content understanding'),
      h('h1', 'Document AI Concept Lab'),
      h('p.lead', `Four hands-on workbenches for the agenda: watch documents being read, structured, extracted, classified and understood — then break things on purpose and fix them.`),
      h('p', h('strong', `${done} of ${AGENDA.length}`), ' topics completed in this browser.')),
    h('section.section',
      h('h2', 'The agenda'),
      h('div.agenda-grid', AGENDA.map((a, i) => h('a.card.agenda-card', { href: `#/s/${a.id}` },
        h('span.agenda-icon', { 'aria-hidden': 'true' }, ICONS[a.id] || '•'),
        h('span.eyebrow', `Topic ${i + 1}${isComplete(prog[a.id] || {}) ? ' · ★ complete' : ''}`),
        h('h3', a.title),
        h('p.small', a.summary),
        h('ul.small.stage-list', a.stages.map(s => h('li', s))))))),
    h('section.section',
      h('h2', 'How each topic works'),
      h('ol.howto',
        h('li', h('strong', 'Understand'), ' — plain-language and technical explanation, key terms, a real use case.'),
        h('li', h('strong', 'Visualize & simulate'), ' — a workbench showing the actual document, image, audio or video as each stage runs. Run it all or step through; click anything to inspect it.'),
        h('li', h('strong', 'Compare'), ' — every run is recorded; diff two runs setting by setting.'),
        h('li', h('strong', 'Debug'), ' — load a broken configuration, find the cause, fix it.'),
        h('li', h('strong', 'Apply & assess'), ' — a checked challenge, a solution walkthrough after you try, and a scenario quiz.'))),
    h('section.section',
      h('h2', 'Where results come from'),
      h('p', 'Nothing on this site calls Azure. Every run is labelled with where its results come from, and every number is tagged ', h('span.chip.tone-info', 'computed'), ' or ', h('span.chip.tone-warn', 'estimate'), '.'),
      h('div.card-grid', Object.values(MODES).filter(m => m !== MODES.live).map(m => h(`div.card.provenance.tone-${m.tone}`, h('strong', m.label), h('p.small', m.text))))),
    h('section.section',
      h('h2', 'Progress'),
      h('p.small', 'Progress is stored only in this browser. '),
      h('button.btn.ghost', { type: 'button', onclick: () => { if (confirm('Clear all progress stored in this browser?')) { resetAll(); location.reload(); } } }, 'Reset my progress')));
}

export async function renderCoverage(root) {
  const tbody = h('tbody');
  root.append(
    h('header.page-head', h('nav.crumbs', h('a', { href: '#/' }, 'Home')), h('h1', 'Agenda coverage'),
      h('p', 'Each agenda topic, the stages its lab covers, what the lab contains, and the AI-103 objectives it maps to.'),
      h('p.small', 'Objective text from ', h('a', { href: SOURCE.url, target: '_blank', rel: 'noopener' }, `Microsoft Learn — ${SOURCE.outlineVersion}`), '.')),
    h('div.table-wrap', h('table.coverage',
      h('thead', h('tr', ['Topic', 'Stages covered', 'Lab contents', 'AI-103 objectives', 'You'].map(x => h('th', { scope: 'col' }, x)))),
      tbody)));
  const prog = allProgress();
  for (const a of AGENDA) {
    const m = await loadModule(a.id);
    tbody.appendChild(h('tr',
      h('td', h('a', { href: `#/s/${a.id}` }, a.title)),
      h('td', h('ol.small', a.stages.map(s => h('li', s)))),
      m.error ? h('td.no', 'MISSING: ' + m.error) : h('td.small', `${m.lab}: workbench + 3 diagram views, ${(MODES[m.sim.mode] || {}).label}, ${m.sim.samples.length} samples, ${m.debug.length} debug scenarios, challenge, ${m.quiz.length}-question quiz`),
      h('td', h('ul.small', a.objectives.map(o => h('li', h('strong', o), ' ', objectiveText(o))))),
      h('td', isComplete(prog[a.id] || {}) ? '★' : '')));
  }
}

export function renderNav(nav, currentHash) {
  clear(nav);
  const p = allProgress();
  nav.appendChild(h('a.nav-home', { href: '#/' }, 'Document AI Concept Lab'));
  nav.appendChild(h('ol.nav-agenda', AGENDA.map(a => h('li', h('a', { href: `#/s/${a.id}`, class: currentHash === `#/s/${a.id}` ? 'current' : null },
    h('span.nav-icon', { 'aria-hidden': 'true' }, ICONS[a.id]), ' ', a.title, isComplete(p[a.id] || {}) ? ' ★' : '')))));
  nav.appendChild(h('a.nav-link', { href: '#/coverage' }, 'Agenda coverage'));
}
