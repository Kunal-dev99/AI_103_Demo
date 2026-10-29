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

const pad = n => String(n).padStart(2, '0');

export function renderHome(root) {
  const prog = allProgress();
  const done = AGENDA.filter(a => isComplete(prog[a.id] || {})).length;
  root.append(
    h('header.hero.home-hero',
      h('p.overline', 'Azure AI-103 · Information extraction & content understanding'),
      h('h1', 'See how AI reads, sorts and understands documents.'),
      h('p.hero-lead', 'Four focused topics. Each one explains the idea, lets you run the pipeline step by step on real-looking content, and checks your understanding with exam-style cases.'),
      h('div.hero-cta',
        h('a.btn.primary', { href: `#/s/${AGENDA[0].id}` }, 'Start with topic 01'),
        h('a.btn.ghost', { href: '#/coverage' }, 'How it maps to AI-103'),
        h('span.hero-progress', `${done} of ${AGENDA.length} topics completed`))),
    h('section.section.agenda-section',
      h('div.sec-head', h('p.overline', 'Agenda'), h('h2', 'Four topics')),
      h('div.agenda-grid', AGENDA.map((a, i) => h('a.agenda-card', { href: `#/s/${a.id}`, style: `--topic:${a.color};--topic-2:${a.color2}` },
        h('div.agenda-top',
          h('span.agenda-num', pad(i + 1)),
          isComplete(prog[a.id] || {}) ? h('span.agenda-done', 'Completed') : null),
        h('h3', a.title),
        h('p', a.summary),
        h('ul.agenda-stages', a.stages.map(st => h('li', st))),
        h('span.agenda-go', 'Open topic →'))))),
    h('section.section',
      h('div.sec-head', h('p.overline', 'Method'), h('h2', 'How each topic works')),
      h('ol.steps-visual',
        [['Concept', 'A short animated walkthrough of the core idea, one step at a time.'],
          ['Workbench', 'The actual document, image, audio or video, processed stage by stage. Click anything to inspect it.'],
          ['Exam-style cases', 'Business scenarios where each answer plays in the workbench, so you see why it is right or wrong.'],
          ['Compare & debug', 'Diff two runs, then fix deliberately broken setups.'],
          ['Assess', 'A checked challenge and a short quiz.']].map(([t, d], i) => h('li', h('span.step-num', pad(i + 1)), h('strong', t), h('span', d))))),
    h('section.section',
      h('div.sec-head', h('p.overline', 'Transparency'), h('h2', 'Where results come from')),
      h('p', 'Nothing on this site calls Azure. Every run is labelled with where its results come from, and every number is marked as ', h('em', 'computed'), ' or ', h('em', 'estimate'), '.'),
      h('div.card-grid', Object.values(MODES).filter(m => m !== MODES.live).map(m => h('div.card.mode-card', h('strong', m.label), h('p.small', m.text))))),
    h('section.section.quiet',
      h('p.small', 'Progress is stored only in this browser. ',
        h('button.linklike', { type: 'button', onclick: () => { if (confirm('Clear all progress stored in this browser?')) { resetAll(); location.reload(); } } }, 'Reset progress'))));
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
  
  nav.appendChild(h('p.nav-label', 'Topics'));
  nav.appendChild(h('ol.nav-agenda', AGENDA.map((a, i) => h('li', h('a', { href: `#/s/${a.id}`, class: currentHash === `#/s/${a.id}` ? 'current' : null, style: `--topic:${a.color};--topic-2:${a.color2}` },
    h('span.nav-num', String(i + 1).padStart(2, '0')), h('span.nav-text', a.title), isComplete(p[a.id] || {}) ? h('span.nav-done', { title: 'Completed' }, '✓') : null)))));
  nav.appendChild(h('p.nav-label', 'Reference'));
  nav.appendChild(h('a.nav-link', { href: '#/coverage', class: currentHash === '#/coverage' ? 'current' : null }, 'AI-103 coverage'));
}
