// Concept explainer player: a sequence of animated scenes, one idea each.
// Works for learners (on-screen caption, "More detail") and presenters (Back/Next, keyboard,
// autoplay, full-screen presenter mode).
//
// A scene: { title, caption, notes?, dur?, draw(g, k) } where g is an SVG <g> on a 960×520 stage
// and k is the drawing kit below. Entrance animations use CSS classes with a --d delay (seconds).
import { h, s, clear } from '../engine/dom.js';

export const W = 960, H = 520;

// ---------- drawing kit ----------
export const kit = {
  s,
  // Fade/slide in after `d` seconds. anim: 'in' | 'pop' | 'draw' | 'grow' | 'slide'
  a(el, d = 0, anim = 'in') { el.classList.add(`ex-${anim}`); el.style.setProperty('--d', `${d}s`); return el; },
  text(x, y, str, { size = 18, weight = 500, cls = '', anchor = 'start', fill } = {}) {
    return s('text', { x, y, 'font-size': size, 'font-weight': weight, class: `ex-text ${cls}`, 'text-anchor': anchor, fill }, str);
  },
  box(x, y, w, h, { r = 10, cls = '', fill, stroke } = {}) { return s('rect', { x, y, width: w, height: h, rx: r, class: `ex-box ${cls}`, fill, stroke }); },
  arrow(x1, y1, x2, y2, { cls = '', curve = 0 } = {}) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - curve;
    return s('path', { d: curve ? `M${x1},${y1} Q${mx},${my} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`, class: `ex-arrow ${cls}`, 'marker-end': 'url(#ex-head)', pathLength: 100 });
  },
  chip(x, y, label, { tone = 'info', size = 13 } = {}) {
    const w = label.length * size * 0.58 + 18;
    const g = s('g', { class: `ex-chip tone-${tone}` });
    g.append(s('rect', { x, y: y - size - 3, width: w, height: size + 12, rx: (size + 12) / 2 }), s('text', { x: x + w / 2, y: y + 1, 'font-size': size, 'text-anchor': 'middle' }, label));
    return g;
  },
  // A stylised document page: lines of grey "text" bars, optional table and title.
  page(x, y, w, h, { title = true, table = false, lines = 9, cls = '', twoCol = false } = {}) {
    const g = s('g', { class: `ex-page ${cls}` });
    g.appendChild(s('rect', { x, y, width: w, height: h, rx: 6, class: 'ex-paper' }));
    let cy = y + 22;
    if (title) { g.appendChild(s('rect', { x: x + 16, y: cy, width: w * 0.45, height: 12, rx: 3, class: 'ex-ink strong' })); cy += 26; }
    const colW = twoCol ? (w - 44) / 2 : w - 32;
    for (let i = 0; i < lines; i++) {
      const lw = colW * (0.6 + ((i * 37) % 40) / 100);
      g.appendChild(s('rect', { x: x + 16, y: cy, width: lw, height: 7, rx: 3, class: 'ex-ink' }));
      if (twoCol) g.appendChild(s('rect', { x: x + 28 + colW, y: cy, width: colW * (0.55 + ((i * 53) % 40) / 100), height: 7, rx: 3, class: 'ex-ink' }));
      cy += 15;
    }
    if (table) {
      const ty = cy + 6, tw = w - 32, rows = 4, rh = 16;
      g.appendChild(s('rect', { x: x + 16, y: ty, width: tw, height: rh * rows, class: 'ex-table' }));
      for (let r = 1; r < rows; r++) g.appendChild(s('line', { x1: x + 16, x2: x + 16 + tw, y1: ty + r * rh, y2: ty + r * rh, class: 'ex-rule' }));
      for (const f of [0.5, 0.7, 0.85]) g.appendChild(s('line', { x1: x + 16 + tw * f, x2: x + 16 + tw * f, y1: ty, y2: ty + rh * rows, class: 'ex-rule' }));
    }
    return g;
  },
  // Horizontal score bar with optional threshold marker.
  bar(x, y, w, value, { label = '', tone = 'info', threshold = null, d = 0 } = {}) {
    const g = s('g', { class: 'ex-barg' });
    if (label) g.appendChild(s('text', { x: x - 10, y: y + 12, 'text-anchor': 'end', 'font-size': 15, class: 'ex-text' }, label));
    g.appendChild(s('rect', { x, y, width: w, height: 16, rx: 8, class: 'ex-track' }));
    const fill = s('rect', { x, y, width: w * value, height: 16, rx: 8, class: `ex-fill tone-${tone}` });
    kit.a(fill, d, 'grow');
    g.appendChild(fill);
    if (threshold != null) g.appendChild(s('line', { x1: x + w * threshold, x2: x + w * threshold, y1: y - 5, y2: y + 21, class: 'ex-threshold' }));
    g.appendChild(kit.a(s('text', { x: x + w + 10, y: y + 13, 'font-size': 14, class: 'ex-text mono' }, value.toFixed(2)), d + 0.5));
    return g;
  },
};

// ---------- player ----------
export function createExplainer(scenes, { title = 'Concept explainer', topicColor } = {}) {
  let i = 0, playing = false, timer = null, notesOn = false;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ex-stage', role: 'img' });
  const titleEl = h('h3.ex-scene-title');
  const captionEl = h('p.ex-caption');
  const notesEl = h('div.ex-notes', { hidden: true });
  const counter = h('span.ex-counter');
  const progress = h('div.ex-progress', { role: 'tablist', 'aria-label': 'Scenes' });
  const backBtn = h('button.btn.ex-back', { type: 'button', 'aria-label': 'Previous scene', onclick: () => go(i - 1) }, '‹ Back');
  const nextBtn = h('button.btn.primary.ex-next', { type: 'button', 'aria-label': 'Next scene', onclick: () => go(i + 1) }, 'Next ›');
  const playBtn = h('button.btn.ghost.ex-play', { type: 'button', onclick: () => setPlaying(!playing) }, '▶ Auto-play');
  const notesBtn = h('button.btn.ghost.ex-notes-btn', { type: 'button', 'aria-pressed': 'false', onclick: () => setNotes(!notesOn) }, '📝 More detail');
  const fsBtn = h('button.btn.ghost.ex-fs', { type: 'button', onclick: () => toggleFullscreen() }, '⛶ Presenter mode');
  const replayBtn = h('button.btn.ghost', { type: 'button', 'aria-label': 'Replay scene', onclick: () => go(i, true) }, '↻');

  scenes.forEach((sc, k) => progress.appendChild(h('button.ex-seg', { type: 'button', role: 'tab', 'aria-label': `Scene ${k + 1}: ${sc.title}`, onclick: () => go(k) }, h('span'))));

  const el = h('div.explainer', { tabindex: 0, 'aria-roledescription': 'slideshow', 'aria-label': title },
    h('div.ex-frame', svg),
    h('div.ex-text-area', h('div.ex-head', counter, titleEl), captionEl, notesEl),
    progress,
    h('div.ex-controls', h('div.ex-left', backBtn, nextBtn, replayBtn), h('div.ex-right', playBtn, notesBtn, fsBtn)));
  if (topicColor) el.style.setProperty('--topic', topicColor);

  function render() {
    const sc = scenes[i];
    clear(svg);
    svg.appendChild(s('defs', {}, s('marker', { id: 'ex-head', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', class: 'ex-arrowhead' }))));
    const g = s('g', { class: 'ex-scene' });
    try { sc.draw(g, kit); } catch (e) { g.appendChild(kit.text(20, 40, 'Scene failed to draw: ' + e.message)); }
    svg.appendChild(g);
    svg.setAttribute('aria-label', `${sc.title}. ${sc.caption}`);
    titleEl.textContent = sc.title;
    captionEl.textContent = sc.caption;
    clear(notesEl);
    if (sc.notes) notesEl.append(...[].concat(sc.notes).map(n => h('p', n)));
    counter.textContent = `${i + 1} / ${scenes.length}`;
    progress.querySelectorAll('.ex-seg').forEach((b, k) => { b.classList.toggle('done', k < i); b.classList.toggle('cur', k === i); b.setAttribute('aria-selected', String(k === i)); });
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === scenes.length - 1 ? 'Start again ↺' : 'Next ›';
    if (playing) schedule();
  }
  function go(k, replay) {
    if (k >= scenes.length) k = 0;
    if (k < 0) return;
    if (k === i && !replay && svg.firstChild) return;
    i = k; render();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { if (i < scenes.length - 1) go(i + 1); else setPlaying(false); }, scenes[i].dur || 7000);
  }
  function setPlaying(on) {
    playing = on; playBtn.textContent = on ? '⏸ Pause' : '▶ Auto-play';
    if (on) schedule(); else clearTimeout(timer);
  }
  function setNotes(on) { notesOn = on; notesEl.hidden = !on; notesBtn.setAttribute('aria-pressed', String(on)); }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => el.classList.toggle('pseudo-fs'));
  }
  document.addEventListener('fullscreenchange', () => { fsBtn.textContent = document.fullscreenElement === el ? '✕ Exit presenter mode' : '⛶ Presenter mode'; });
  el.addEventListener('keydown', e => {
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(i - 1); }
    else if (e.key.toLowerCase() === 'f') toggleFullscreen();
    else if (e.key.toLowerCase() === 'n') setNotes(!notesOn);
    else if (e.key === 'Escape') el.classList.remove('pseudo-fs');
  });
  render();
  return { el, go, stop: () => setPlaying(false) };
}
