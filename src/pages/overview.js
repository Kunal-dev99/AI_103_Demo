// Home, domain, topic and coverage pages.
import { h, clear } from '../engine/dom.js';
import { DOMAINS, ALL_SUBTOPICS, SOURCE, findDomain, findTopic } from '../syllabus.js';
import { MODES } from '../engine/contract.js';
import { allProgress, isComplete, resetAll } from '../engine/store.js';

const modCache = {};
export async function loadModule(id) {
  if (!modCache[id]) modCache[id] = import(`../../content/${id}.js`).then(m => m.default).catch(e => ({ error: e.message }));
  return modCache[id];
}

const doneCount = ids => { const p = allProgress(); return ids.filter(id => isComplete(p[id] || {})).length; };

export function renderHome(root) {
  const total = ALL_SUBTOPICS.length;
  root.append(
    h('header.page-head',
      h('p.eyebrow', SOURCE.exam),
      h('h1', 'AI-103 Concept Lab'),
      h('p.lead', `An interactive visualizer and simulator for every one of the ${total} objectives in the official AI-103 skills outline. Each objective has its own lab, failure scenarios to debug, a measurable challenge and a scenario-based knowledge check.`),
      h('p.small', 'Syllabus source: ', h('a', { href: SOURCE.url, target: '_blank', rel: 'noopener' }, `Microsoft Learn study guide — ${SOURCE.outlineVersion}`), `, checked ${SOURCE.verifiedOn}. Passing score ${SOURCE.passingScore}.`),
      h('p', h('strong', `${doneCount(ALL_SUBTOPICS.map(s => s.id))} of ${total}`), ' objectives completed in this browser.')),
    h('section.section',
      h('h2', 'How each lab works'),
      h('ol.howto',
        h('li', h('strong', 'Understand'), ' — plain-language and technical explanations, key terms, a real use case.'),
        h('li', h('strong', 'Visualize'), ' — an interactive diagram with conceptual, architecture and implementation views. Select nodes, expand stages.'),
        h('li', h('strong', 'Simulate'), ' — configure, run or step through, and inspect every intermediate result.'),
        h('li', h('strong', 'Compare'), ' — every run is recorded; diff two runs setting by setting.'),
        h('li', h('strong', 'Debug'), ' — load a broken configuration, find the cause, fix it.'),
        h('li', h('strong', 'Apply & assess'), ' — a challenge with a checkable completion condition, a solution walkthrough after you try, and a quiz.'))),
    h('section.section',
      h('h2', 'Where results come from'),
      h('p', 'Every simulator shows a provenance badge. Nothing on this site calls Azure: results are either computed locally by simplified logic or replay sample data, and they are labelled as such. Measurements are tagged ', h('span.chip.tone-info', 'computed'), ' (produced by the simulator\'s own logic) or ', h('span.chip.tone-warn', 'estimate'), ' (illustrative, with the assumption stated).'),
      h('div.card-grid', Object.values(MODES).map(m => h(`div.card.provenance.tone-${m.tone}`, h('strong', m.label), h('p.small', m.text), m === MODES.live ? h('p.small', 'Not used by any lab in this build.') : null)))),
    h('section.section',
      h('h2', 'Exam domains'),
      h('div.card-grid', DOMAINS.map(d => {
        const ids = d.topics.flatMap(t => t.subtopics.map(s => s.id));
        return h('a.card.domain-card', { href: `#/d/${d.id}` },
          h('span.eyebrow', `Domain ${d.id} • ${d.weight}`),
          h('h3', d.title),
          h('p.small', `${d.topics.length} topics • ${ids.length} objectives • ${doneCount(ids)} completed`));
      }))),
    h('section.section',
      h('h2', 'Progress'),
      h('p.small', 'Progress is stored only in this browser. '),
      h('button.btn.ghost', { type: 'button', onclick: () => { if (confirm('Clear all progress stored in this browser?')) { resetAll(); location.reload(); } } }, 'Reset my progress')));
}

export function renderDomain(root, id) {
  const d = findDomain(id);
  if (!d) { root.appendChild(h('p', 'Unknown domain.')); return; }
  root.append(
    h('header.page-head', h('nav.crumbs', h('a', { href: '#/' }, 'Home')), h('p.eyebrow', `Domain ${d.id} • ${d.weight} of the exam`), h('h1', d.title)),
    ...d.topics.map(t => topicBlock(t)));
}

export function renderTopic(root, id) {
  const t = findTopic(id);
  if (!t) { root.appendChild(h('p', 'Unknown topic.')); return; }
  root.append(
    h('header.page-head', h('nav.crumbs', h('a', { href: '#/' }, 'Home'), ' › ', h('a', { href: `#/d/${t.domain.id}` }, `${t.domain.id}. ${t.domain.title}`)), h('p.eyebrow', `Topic ${t.id}`), h('h1', t.title)),
    topicBlock(t, true));
}

function topicBlock(t, standalone) {
  const p = allProgress();
  const list = h('div.card-grid');
  for (const s of t.subtopics) {
    const card = h('a.card.sub-card', { href: `#/s/${s.id}` },
      h('span.eyebrow', `${s.id}${isComplete(p[s.id] || {}) ? ' • ★ complete' : ''}`),
      h('p', s.text),
      h('p.small.lab-name', 'Loading lab…'));
    loadModule(s.id).then(m => { card.querySelector('.lab-name').textContent = m.error ? 'Lab unavailable' : `Lab: ${m.lab}`; });
    list.appendChild(card);
  }
  return h('section.section', standalone ? null : h('h2', h('a', { href: `#/t/${t.id}` }, `${t.id} ${t.title}`)), list);
}

export async function renderCoverage(root) {
  const tbody = h('tbody');
  root.append(
    h('header.page-head', h('nav.crumbs', h('a', { href: '#/' }, 'Home')), h('h1', 'Syllabus coverage & traceability'),
      h('p', 'One row per official objective. Each row links the objective to its lab and lists what the lab contains. A missing lab or section shows in red.'),
      h('p.small', 'Source: ', h('a', { href: SOURCE.url, target: '_blank', rel: 'noopener' }, SOURCE.outlineVersion), `. To update for a new outline, edit src/syllabus.js and run npm run validate (see README).`)),
    h('div.table-wrap', h('table.coverage',
      h('thead', h('tr', ['Objective', 'Official text', 'Lab', 'Views', 'Simulator', 'Debug', 'Challenge', 'Quiz', 'Services', 'You'].map(x => h('th', { scope: 'col' }, x)))),
      tbody)));
  const prog = allProgress();
  for (const d of DOMAINS) {
    tbody.appendChild(h('tr.group', h('td', { colspan: 10 }, `Domain ${d.id}: ${d.title} (${d.weight})`)));
    for (const t of d.topics) {
      tbody.appendChild(h('tr.subgroup', h('td', { colspan: 10 }, `${t.id} ${t.title}`)));
      for (const s of t.subtopics) {
        const m = await loadModule(s.id);
        const ok = v => h(`td.${v ? 'yes' : 'no'}`, v || '✗');
        tbody.appendChild(h('tr',
          h('td', h('a', { href: `#/s/${s.id}` }, s.id)), h('td', s.text),
          m.error ? h('td.no', { colspan: 7 }, 'MISSING: ' + m.error) : [
            h('td', m.lab),
            ok(m.visual && Object.keys(m.visual.views).length === 3 && '3'),
            ok(m.sim && (MODES[m.sim.mode] || {}).label),
            ok(m.debug && m.debug.length),
            ok(m.challenge && '✓'),
            ok(m.quiz && m.quiz.length),
            h('td', m.services.map(x => x.name).join('; ')),
          ],
          h('td', isComplete(prog[s.id] || {}) ? '★' : '')));
      }
    }
  }
}

export function renderNav(nav, currentHash) {
  clear(nav);
  const p = allProgress();
  nav.appendChild(h('a.nav-home', { href: '#/' }, 'AI-103 Concept Lab'));
  nav.appendChild(h('a.nav-link', { href: '#/coverage' }, 'Syllabus coverage'));
  for (const d of DOMAINS) {
    const open = currentHash.includes(`/${d.id}`) || currentHash.startsWith(`#/d/${d.id}`);
    nav.appendChild(h('details.nav-domain', { open: open || null },
      h('summary', h('span', `${d.id}. ${d.title}`), h('span.small', d.weight)),
      d.topics.map(t => h('div.nav-topic',
        h('a.nav-topic-link', { href: `#/t/${t.id}` }, `${t.id} ${t.title}`),
        h('ul', t.subtopics.map(s => h('li', h('a', { href: `#/s/${s.id}`, class: currentHash === `#/s/${s.id}` ? 'current' : null, title: s.text },
          h('span.nav-id', s.id), ' ', s.text.length > 58 ? s.text.slice(0, 56) + '…' : s.text, isComplete(p[s.id] || {}) ? ' ★' : ''))))))));
  }
}
