// Hash router. Routes: #/  #/d/<domain>  #/t/<topic>  #/s/<subtopic>  #/coverage
import { clear, h } from './engine/dom.js';
import { renderHome, renderDomain, renderTopic, renderCoverage, renderNav } from './pages/overview.js';
import { renderSubtopic } from './pages/subtopic.js';

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;

async function route() {
  const hash = location.hash || '#/';
  if (cleanup) { cleanup(); cleanup = null; }
  clear(main);
  renderNav(nav, hash);
  document.body.classList.remove('nav-open');
  const [, kind, id] = hash.match(/^#\/(\w+)?\/?([\d.]+)?/) || [];
  try {
    if (!kind) renderHome(main);
    else if (kind === 'd') renderDomain(main, id);
    else if (kind === 't') renderTopic(main, id);
    else if (kind === 's') cleanup = await renderSubtopic(main, id);
    else if (kind === 'coverage') await renderCoverage(main);
    else main.appendChild(h('p', 'Page not found. ', h('a', { href: '#/' }, 'Go home')));
  } catch (e) {
    console.error(e);
    main.appendChild(h('div.alert.tone-error', 'Something went wrong rendering this page: ' + e.message));
  }
  const title = main.querySelector('h1');
  document.title = title ? `${title.textContent.slice(0, 60)} · AI-103 Concept Lab` : 'AI-103 Concept Lab';
  window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
}

document.getElementById('nav-toggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
window.addEventListener('hashchange', route);
route();
