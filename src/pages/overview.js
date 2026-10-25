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

export function renderHome(root) {
  const prog = allProgress();
  const done = AGENDA.filter(a => isComplete(prog[a.id] || {})).length;
  root.append(
    h('header.hero.home-hero',
      h('div.hero-deco', { 'aria-hidden': 'true' }, AGENDA.map((a, i) => h(`span.float.f${i}`, a.emoji))),
      h('p.hero-eyebrow', 'Azure AI-103 · Document AI, hands-on'),
      h('h1', 'Watch AI read, sort and understand your documents'),
      h('p.hero-lead', 'Four interactive workbenches. Run a pipeline, watch every stage happen on the page, break it on purpose, then fix it.'),
      h('div.hero-cta',
        h('a.btn.cta', { href: `#/s/${AGENDA[0].id}` }, '▶ Start with topic 1'),
        h('span.hero-progress', h('strong', `${done}/${AGENDA.length}`), ' topics completed'))),
    h('section.section.agenda-section',
      h('h2.sec-title', h('span.sec-badge', { 'aria-hidden': 'true' }, '🗺️'), 'The agenda'),
      h('div.agenda-grid', AGENDA.map((a, i) => h('a.agenda-card', { href: `#/s/${a.id}`, style: `--topic:${a.color};--topic-2:${a.color2}` },
        h('div.agenda-top',
          h('span.agenda-emoji', { 'aria-hidden': 'true' }, a.emoji),
          h('span.agenda-num', `Topic ${i + 1}`),
          isComplete(prog[a.id] || {}) ? h('span.agenda-done', '★ done') : null),
        h('div.agenda-body',
          h('h3', a.title),
          h('p', a.summary),
          h('div.stage-chips', a.stages.map(s => h('span.stage-chip', s))),
          h('span.agenda-go', 'Open workbench →')))))),
    h('section.section',
      h('h2.sec-title', h('span.sec-badge', { 'aria-hidden': 'true' }, '🧭'), 'How each topic works'),
      h('ol.howto.steps-visual',
        h('li', h('span.step-ico', '💡'), h('strong', 'Understand'), h('span', 'Plain-language and technical explanation, key terms, a real use case.')),
        h('li', h('span.step-ico', '🧪'), h('strong', 'Watch it work'), h('span', 'The workbench shows the actual document, image, audio or video as each stage runs. Click anything to inspect it.')),
        h('li', h('span.step-ico', '⚖️'), h('strong', 'Compare'), h('span', 'Every run is recorded; diff two runs setting by setting.')),
        h('li', h('span.step-ico', '🐞'), h('strong', 'Debug'), h('span', 'Load a broken setup, find the cause, fix it.')),
        h('li', h('span.step-ico', '🏆'), h('strong', 'Challenge & quiz'), h('span', 'A checked challenge, a walkthrough after you try, and a scenario quiz.')))),
    h('section.section',
      h('h2.sec-title', h('span.sec-badge', { 'aria-hidden': 'true' }, '🔬'), 'Where results come from'),
      h('p', 'Nothing on this site calls Azure. Every run is labelled with where its results come from, and every number is tagged ', h('span.chip.tone-info', 'computed'), ' or ', h('span.chip.tone-warn', 'estimate'), '.'),
      h('div.card-grid', Object.values(MODES).filter(m => m !== MODES.live).map(m => h(`div.card.provenance.tone-${m.tone}`, h('strong', m.label), h('p.small', m.text))))),
    h('section.section',
      h('h2.sec-title', h('span.sec-badge', { 'aria-hidden': 'true' }, '📈'), 'Progress'),
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
  nav.appendChild(h('ol.nav-agenda', AGENDA.map((a, i) => h('li', h('a', { href: `#/s/${a.id}`, class: currentHash === `#/s/${a.id}` ? 'current' : null, style: `--topic:${a.color};--topic-2:${a.color2}` },
    h('span.nav-emoji', { 'aria-hidden': 'true' }, a.emoji), h('span.nav-text', h('small', `Topic ${i + 1}`), a.title), isComplete(p[a.id] || {}) ? ' ★' : '')))));
  nav.appendChild(h('a.nav-link', { href: '#/coverage' }, 'Agenda coverage'));
}
