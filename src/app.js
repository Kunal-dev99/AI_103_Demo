// Hash router. Routes: #/  #/briefing  #/s/<agendaTopicId>  #/coverage
import { clear, h } from './engine/dom.js';
import { renderHome, renderCoverage, renderNav } from './pages/overview.js';
import { renderTopic } from './pages/topic.js';
import { renderBriefing } from './pages/briefing.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

async function route() {
  const hash = location.hash || '#/';
  if (cleanup) { cleanup(); cleanup = null; }
  clear(main);
  renderNav(nav, hash);
  document.body.classList.remove('nav-open');
  const [, kind, id] = hash.match(/^#\/(\w+)?\/?([\w-]+)?/) || [];
  try {
    if (!kind) renderHome(main);
    else if (kind === 's') cleanup = await renderTopic(main, id);
    else if (kind === 'coverage') await renderCoverage(main);
    else if (kind === 'briefing') cleanup = await renderBriefing(main);
    else main.appendChild(h('p', 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
  } catch (e) {
    console.error(e);
    main.appendChild(h('div.alert.tone-error', 'Something went wrong rendering this page: ' + e.message));
  }
  const title = main.querySelector('h1');
  document.title = title ? `${title.textContent.slice(0, 60)} · Document AI Concept Lab` : 'Document AI Concept Lab';
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

document.getElementById('nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
window.addEventListener('hashchange', route);
route();
