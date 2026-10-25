// Tiny DOM helpers. h('div.card#x', {onclick}, child, 'text', [children]).
export function h(sel, attrs, ...kids) {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k != null) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export const fmtValue = v => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Resolves once every finite CSS animation/transition inside `el` has finished,
// re-checking briefly afterwards in case finishing one stage started another.
export function animationsSettled(el, { gap = 150, rounds = 6 } = {}) {
  const active = () => (el.getAnimations ? el.getAnimations({ subtree: true }) : []).filter(a => {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    return t && Number.isFinite(t.endTime) && a.playState !== 'finished';
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return (async () => {
    for (let i = 0; i < rounds; i++) {
      await wait(gap);
      const list = active();
      if (!list.length) return;
      await Promise.all(list.map(a => a.finished.catch(() => {})));
    }
  })();
}
