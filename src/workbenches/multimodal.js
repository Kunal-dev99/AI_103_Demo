// Multimodal understanding workspace: the visual changes with the modality.
// Document: the claim page with OCR, layout, regions and grounded field boxes.
// Image: a parcel photo that dissolves into pixels, then objects, OCR text and region masks appear.
// Audio: a waveform with a sweeping playhead, transcript phrases landing in speaker lanes, turns, time-range grounding.
// Video: a monitor, a filmstrip, shot cuts, segments, keyframes, on-screen text, narration and the incident marker.
import { h, s, clear } from '../engine/dom.js';
import { drawPage, stageRail, tabs, confTone, PAGE_W, PAGE_H } from './page.js';
import { rng } from '../engine/util.js';

const STAGES = [['ingest', 'Ingest'], ['represent', 'Represent'], ['process', 'Process'], ['segment', 'Segment'], ['extract', 'Grounded fields'], ['output', 'Markdown / JSON']];
const MODS = [['document', '▤', 'Document'], ['image', '◩', 'Image'], ['audio', '∿', 'Audio'], ['video', '▶', 'Video']];
const PALETTE = ['#2f80ed', '#e67e22', '#27ae60', '#8e44ad', '#d81b60', '#16a085', '#c0392b', '#7f8c8d'];
const SWEEP = 1.15; // seconds for playhead sweeps
const fmtT = sec => { const m = Math.floor(sec / 60); const x = sec - m * 60; return `${String(m).padStart(2, '0')}:${x.toFixed(1).padStart(4, '0')}`; };
const delay = sec => `animation-delay:${sec.toFixed(2)}s`;

export function createWorkbench(mod) {
  const rail = stageRail(STAGES);
  const headEl = h('div.mm-head');
  const stageEl = h('div.mm-stage');
  const caption = h('p.wb-caption', { 'aria-live': 'polite' }, 'Choose an input and press Run. Each stage animates on the content itself.');
  const repEl = h('section.mm-rep', { 'aria-label': 'How the analyzer represents this input' });
  const detail = h('div.wb-detail.mm-detail', { 'aria-live': 'polite' });
  const tb = tabs([['fields', 'Fields'], ['segments', 'Segments'], ['output', 'Output']]);
  const el = h('div.workbench.wb-mm',
    rail.el,
    h('div.wb-grid',
      h('div.wb-main', headEl, stageEl, caption, repEl),
      h('aside.wb-side', detail, tb.el)));

  let res = null, params = null, media = null, R = null, timers = [], lab = null;
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const stopTimers = () => { timers.forEach(clearTimeout); timers = []; };

  function idleDetail() { clear(detail).append(h('p.small', 'Click a field card, a region, a transcript phrase or a video segment to inspect it.')); }
  function inspect(title, ...kids) { clear(detail).append(h('h4', title), h('div', kids)); }

  // ---------------- head: modality pills + file + analyzer ----------------
  function drawHead() {
    clear(headEl);
    if (!res) return;
    const v = res.view;
    headEl.append(
      h('div.mm-mods', { role: 'group', 'aria-label': 'Switch modality' }, MODS.map(([id, icon, label]) => {
        const input = (mod.modalityInputs || {})[id];
        return h(`button.mm-mod${id === v.modality ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(id === v.modality), disabled: !input || !lab,
          title: `Switch the input to the ${label.toLowerCase()} sample`,
          onclick: () => { if (id !== v.modality) lab.set({ input }); } }, h('b', icon), ' ', label);
      })),
      h('div.mm-chips',
        h('span.mm-file', { title: 'Input file' }, '📄 ', v.file),
        h(`span.mm-analyzer${v.custom ? '.custom' : ''}`, { title: 'Analyzer (illustrative id)' }, v.analyzerId)));
  }

  // ---------------- shared overlays for box-grounded modalities ----------------
  function boxPins(layer, fields, pad = 1) {
    clear(layer);
    fields.forEach((f, i) => {
      if (!f.source || f.source.kind !== 'box' || f.synth) return;
      f.source.spans.forEach((sp, k) => {
        const g = s('g', { class: 'mm-pin', 'data-field': f.name, style: delay(i * 0.12 + k * 0.05) });
        g.appendChild(s('rect', { x: sp.box.x - pad, y: sp.box.y - pad, width: sp.box.w + pad * 2, height: sp.box.h + pad * 2, rx: 1.2, class: 'mm-pin-box' }));
        const r = pad * 3.2;
        g.appendChild(s('circle', { cx: sp.box.x - pad, cy: sp.box.y - pad, r, class: 'mm-pin-dot' }));
        g.appendChild(s('text', { x: sp.box.x - pad, y: sp.box.y - pad + r * 0.38, 'text-anchor': 'middle', 'font-size': r * 1.1, class: 'mm-pin-num' }, String(i + 1)));
        g.addEventListener('click', () => selectField(f, i));
        layer.appendChild(g);
      });
    });
  }
  function boxHighlight(layer, f, pad = 1.5) {
    clear(layer);
    if (!f || !f.source) return;
    for (const sp of f.source.spans) layer.appendChild(s('rect', { x: sp.box.x - pad, y: sp.box.y - pad, width: sp.box.w + pad * 2, height: sp.box.h + pad * 2, rx: 1.5, class: 'mm-hl' }));
  }

  // ======================= DOCUMENT =======================
  function docRenderer(v, live) {
    const svg = s('svg', { viewBox: `-10 -10 ${PAGE_W + 20} ${PAGE_H + 20}`, class: 'mm-svg mm-doc', role: 'img', 'aria-label': 'Claim form page' });
    const pageG = drawPage(v.page, { quality: 1, seed: 'claim' });
    const ov = s('g'), segL = s('g'), pinL = s('g'), hlL = s('g');
    svg.append(pageG, ov, segL, pinL, hlL);
    if (!live) pageG.classList.add('mm-dim');
    const wrap = h('div.mm-docwrap', svg);
    return {
      el: wrap,
      stage(node) {
        if (node === 'ingest') svg.classList.add('mm-arrive');
        if (node === 'represent') {
          const g = s('g', { class: 'mm-pixgrid' });
          for (let x = 0; x <= PAGE_W; x += 7) g.appendChild(s('line', { x1: x, y1: 0, x2: x, y2: PAGE_H }));
          for (let y = 0; y <= PAGE_H; y += 7) g.appendChild(s('line', { x1: 0, y1: y, x2: PAGE_W, y2: y }));
          ov.appendChild(g);
          ov.appendChild(s('text', { x: PAGE_W / 2, y: 150, 'text-anchor': 'middle', 'font-size': 7, class: 'mm-ghost-label' }, '1654 × 2339 px · 200 dpi'));
        }
        if (node === 'process') {
          clear(ov);
          ov.appendChild(s('rect', { x: -4, y: 0, width: PAGE_W + 8, height: 6, class: 'scan-beam' }));
          for (const l of v.lines) {
            const r = s('rect', { x: l.box.x, y: l.box.y, width: l.box.w, height: l.box.h, rx: 0.6, class: `mm-ocr tone-${confTone(l.conf, 0.85)}`, style: delay((l.box.y / PAGE_H) * 1.05) });
            r.addEventListener('click', () => inspect('OCR line', h('p.wb-quote', `“${l.text}”`), confMeter(l.conf), h('p.small', `Confidence ${l.conf.toFixed(2)}${l.hand ? ' · handwritten' : ''}${l.role && l.role !== 'text' ? ` · role ${l.role}` : ''}`)));
            ov.appendChild(r);
          }
          const t = v.table.box;
          ov.appendChild(s('rect', { x: t.x - 1, y: t.y - 1, width: t.w + 2, height: t.h + 2, class: 'tbl-outline', pathLength: 100 }));
          ov.appendChild(s('text', { x: t.x + t.w, y: t.y - 2.4, 'text-anchor': 'end', 'font-size': 3.4, class: 'mm-tag' }, `table ${v.table.rows}×${v.table.cols}`));
          for (const m of v.marks) {
            ov.appendChild(s('rect', { x: m.box.x, y: m.box.y, width: 5.6, height: 5.6, class: `mark-box ${m.state}` }));
          }
        }
        if (node === 'segment') {
          ov.classList.add('mm-fade');
          (res.view.segments || []).forEach((sg, i) => {
            const col = PALETTE[i % PALETTE.length];
            const g = s('g', { class: 'mm-region', style: `--c:${col};${delay(i * 0.1)}` });
            g.appendChild(s('rect', { x: sg.box.x - 2, y: sg.box.y - 2, width: sg.box.w + 4, height: sg.box.h + 4, rx: 2 }));
            g.appendChild(s('text', { x: sg.box.x - 1, y: sg.box.y - 3, 'font-size': 3.6 }, `${sg.n} ${sg.label}`));
            g.addEventListener('click', () => { boxHighlight(hlL, { source: { spans: [{ box: sg.box }] } }); inspect(`Region ${sg.n}: ${sg.label}`, h('p.small', 'A region is a chunk boundary: everything inside stays together when the markdown is split for search.'), h('p.small.mono', `box ≈ [${sg.box.x}, ${sg.box.y}, ${sg.box.w}, ${sg.box.h}]`)); });
            segL.appendChild(g);
          });
        }
        if (node === 'extract') { segL.classList.add('mm-quiet'); boxPins(pinL, res.view.fields); }
      },
      highlight(f) { boxHighlight(hlL, f); },
      highlightBox(box) { boxHighlight(hlL, { source: { spans: [{ box }] } }); },
    };
  }

  // ======================= IMAGE =======================
  function sceneColor(x, y) {
    const inPoly = (pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; };
    if (x >= 206 && x <= 304 && y >= 166 && y <= 204) return '#f3e07a';
    if (x >= 84 && x <= 130 && y >= 160 && y <= 178) return '#d63a3a';
    if (x >= 84 && x <= 162 && y >= 104 && y <= 152) return y > 138 && y < 150 ? '#555' : '#f7f5ef';
    if (inPoly([[200, 80], [214, 70], [230, 74], [240, 62], [240, 90], [222, 98], [206, 104]])) return '#7d5630';
    if (x >= 70 && x <= 200 && y >= 80 && y <= 190) return '#c8965a';
    if (inPoly([[70, 80], [110, 50], [240, 50], [200, 80]])) return '#ddb070';
    if (inPoly([[200, 80], [240, 50], [240, 160], [200, 190]])) return '#a97a45';
    if (y > 150) return '#b9b1a2';
    return '#d9d3c6';
  }
  function drawParcel(img) {
    const g = s('g', { class: 'mm-scene' });
    g.appendChild(s('rect', { x: 0, y: 0, width: 320, height: 150, fill: '#d9d3c6' }));
    for (let x = 0; x < 320; x += 40) g.appendChild(s('line', { x1: x, y1: 0, x2: x, y2: 150, stroke: '#cbc4b5', 'stroke-width': 1 }));
    g.appendChild(s('rect', { x: 0, y: 150, width: 320, height: 70, fill: '#b9b1a2' }));
    for (const x of [-60, 40, 140, 240, 340]) g.appendChild(s('line', { x1: x, y1: 220, x2: 160 + (x - 160) * 0.4, y2: 150, stroke: '#a8a091', 'stroke-width': 1 }));
    g.appendChild(s('ellipse', { cx: 156, cy: 194, rx: 100, ry: 9, fill: 'rgba(0,0,0,.18)' }));
    g.appendChild(s('polygon', { points: '70,80 200,80 200,190 70,190', fill: '#c8965a', stroke: '#8a6232', 'stroke-width': 1 }));
    g.appendChild(s('polygon', { points: '70,80 110,50 240,50 200,80', fill: '#ddb070', stroke: '#8a6232', 'stroke-width': 1 }));
    g.appendChild(s('polygon', { points: '200,80 240,50 240,160 200,190', fill: '#a97a45', stroke: '#8a6232', 'stroke-width': 1 }));
    g.appendChild(s('polygon', { points: '125,80 165,50 180,50 140,80', fill: '#efe2bd', opacity: 0.85 }));
    g.appendChild(s('rect', { x: 125, y: 80, width: 15, height: 20, fill: '#efe2bd', opacity: 0.85 }));
    // crushed corner
    g.appendChild(s('polygon', { points: '200,80 214,70 230,74 240,62 240,90 222,98 206,104', fill: '#7d5630', opacity: 0.9 }));
    g.appendChild(s('path', { d: 'M203,84 L216,78 L226,86 L238,72 M208,96 L220,88 L232,92', fill: 'none', stroke: '#4b3216', 'stroke-width': 1.2 }));
    // shipping label + barcode
    g.appendChild(s('rect', { x: 84, y: 104, width: 78, height: 48, fill: '#f7f5ef', stroke: '#9a9a9a', 'stroke-width': 0.6 }));
    const fonts = { o1: 7.2, o4: 6, o2: 7.6 };
    for (const o of img.ocr.filter(x => fonts[x.id])) g.appendChild(s('text', { x: o.box.x + 1, y: o.box.y + o.box.h - 1.6, 'font-size': fonts[o.id], textLength: o.box.w - 2, lengthAdjust: 'spacingAndGlyphs', class: 'mm-label-text' }, o.text));
    const br = rng('barcode');
    for (let x = 88; x < 156; x += 1.6) if (br() > 0.35) g.appendChild(s('rect', { x, y: 140, width: br() > 0.5 ? 1 : 0.6, height: 9, fill: '#222' }));
    // fragile sticker
    g.appendChild(s('rect', { x: 84, y: 160, width: 46, height: 18, rx: 2, fill: '#d63a3a' }));
    g.appendChild(s('text', { x: 88, y: 173, 'font-size': 9.6, textLength: 38, lengthAdjust: 'spacingAndGlyphs', fill: '#fff', 'font-weight': 700, 'font-family': 'Arial, sans-serif' }, 'FRAGILE'));
    // note on the floor
    g.appendChild(s('rect', { x: 206, y: 166, width: 98, height: 38, fill: '#f3e07a', stroke: '#c9b44a', 'stroke-width': 0.6 }));
    for (const o of img.ocr.filter(x => x.injection)) g.appendChild(s('text', { x: o.box.x + 1, y: o.box.y + o.box.h - 2, 'font-size': 7.6, textLength: o.box.w - 2, lengthAdjust: 'spacingAndGlyphs', class: 'mm-note-text' }, o.text));
    return g;
  }
  function imageRenderer(v, live) {
    const img = v.image;
    const svg = s('svg', { viewBox: '0 0 320 220', class: 'mm-svg mm-img', role: 'img', 'aria-label': 'Photo of a damaged parcel' });
    const scene = drawParcel(img);
    if (!live) scene.classList.add('mm-dim');
    const ov = s('g'), segL = s('g'), pinL = s('g'), hlL = s('g');
    svg.append(scene, ov, segL, pinL, hlL);
    const cap = h('p.mm-imgcap', h('span.mm-k', 'caption'), ' ', h('span.mm-captext', '…'));
    const wrap = h('div.mm-imgwrap', svg, cap);
    return {
      el: wrap,
      stage(node) {
        if (node === 'ingest') svg.classList.add('mm-arrive');
        if (node === 'represent') {
          const g = s('g', { class: 'mm-mosaic' });
          for (let y = 0; y < 220; y += 10) for (let x = 0; x < 320; x += 10) g.appendChild(s('rect', { x, y, width: 10.4, height: 10.4, fill: sceneColor(x + 5, y + 5), style: delay(0.15 + ((x + y) / 540) * 0.9) }));
          ov.appendChild(g);
          ov.appendChild(s('text', { x: 160, y: 22, 'text-anchor': 'middle', 'font-size': 11, class: 'mm-ghost-label', style: 'animation-delay:.2s' }, '1280 × 880 × RGB'));
        }
        if (node === 'process') {
          clear(ov);
          ov.appendChild(s('rect', { x: 0, y: 0, width: 8, height: 220, class: 'mm-vbeam' }));
          img.objects.forEach((o, i) => {
            const g = s('g', { class: 'mm-obj', style: delay(0.25 + i * 0.13) });
            g.appendChild(s('rect', { x: o.box.x, y: o.box.y, width: o.box.w, height: o.box.h, rx: 2 }));
            const tag = `${o.label.split(' (')[0]} ${o.conf.toFixed(2)}`;
            g.appendChild(s('rect', { x: o.box.x, y: o.box.y - 9, width: tag.length * 4 + 4, height: 9, class: 'mm-obj-tag' }));
            g.appendChild(s('text', { x: o.box.x + 2, y: o.box.y - 2.4, 'font-size': 6.6, class: 'mm-obj-tagtext' }, tag));
            g.addEventListener('click', () => { boxHighlight(hlL, { source: { spans: [{ box: o.box }] } }, 1); inspect(`Object: ${o.label}`, confMeter(o.conf), h('p.small', `Detection confidence ${o.conf.toFixed(2)}. Regions like this are what image fields are grounded to.`), h('p.small.mono', `box ≈ [${o.box.x}, ${o.box.y}, ${o.box.w}, ${o.box.h}]`)); });
            ov.appendChild(g);
          });
          img.ocr.forEach((o, i) => {
            const r = s('rect', { x: o.box.x - 1, y: o.box.y - 1, width: o.box.w + 2, height: o.box.h + 2, rx: 1, class: `mm-ocrbox${o.injection ? ' inj' : ''}`, style: delay(0.8 + i * 0.07) });
            r.addEventListener('click', () => { boxHighlight(hlL, { source: { spans: [{ box: o.box }] } }, 1); inspect('Text read from the image (OCR)', h('p.wb-quote', `“${o.text}”`), confMeter(o.conf), o.injection ? h('p.alert.tone-warn', 'This text looks like an instruction. The analyzer returns it as content and does not act on it. Downstream, keep extracted text out of your system prompt and treat it as untrusted data.') : h('p.small', `Confidence ${o.conf.toFixed(2)}`)); });
            ov.appendChild(r);
          });
          const n = img.ocr.find(o => o.id === 'o5');
          const t = s('g', { class: 'mm-injtag', style: 'animation-delay:1.25s' });
          t.appendChild(s('rect', { x: 206, y: 207, width: 98, height: 11, rx: 5.5 }));
          t.appendChild(s('text', { x: 255, y: 214.6, 'text-anchor': 'middle', 'font-size': 6.4 }, '⚠ content, not instruction'));
          if (n) ov.appendChild(t);
          later(() => { cap.querySelector('.mm-captext').textContent = res.view.caption; cap.classList.add('on'); }, 700);
        }
        if (node === 'segment') {
          ov.classList.add('mm-fade');
          (res.view.segments || []).forEach((sg, i) => {
            const g = s('g', { class: 'mm-mask', style: `--c:${PALETTE[i % PALETTE.length]};${delay(i * 0.12)}` });
            g.appendChild(s('rect', { x: sg.box.x, y: sg.box.y, width: sg.box.w, height: sg.box.h, rx: 3 }));
            g.appendChild(s('circle', { cx: sg.box.x + sg.box.w - 6, cy: sg.box.y + 6, r: 5 }));
            g.appendChild(s('text', { x: sg.box.x + sg.box.w - 6, y: sg.box.y + 8.2, 'text-anchor': 'middle', 'font-size': 6.4 }, String(sg.n)));
            segL.appendChild(g);
          });
        }
        if (node === 'extract') { segL.classList.add('mm-quiet'); boxPins(pinL, res.view.fields, 1.5); }
      },
      highlight(f) { boxHighlight(hlL, f, 2); },
      highlightBox(box) { boxHighlight(hlL, { source: { spans: [{ box }] } }, 2); },
    };
  }

  // ======================= AUDIO =======================
  function audioRenderer(v, live) {
    const A = v.audio, D = A.duration, X0 = 60, W = 452;
    const X = t => X0 + (t / D) * W;
    const diar = A.diarization;
    const lanes = diar ? [['S1', 'Speaker 1', 128], ['S2', 'Speaker 2', 170]] : [[null, 'Unattributed', 128]];
    const laneH = diar ? 34 : 76;
    const svg = s('svg', { viewBox: '0 0 520 232', class: 'mm-svg mm-audio', role: 'img', 'aria-label': 'Waveform and transcript lanes' });
    if (!live) svg.classList.add('mm-dimsvg');
    const r = rng('wave-call-0193');
    const bars = s('g', { class: 'mm-wave' });
    const phraseAt = t => A.phrases.find(p => t >= p.t0 && t <= p.t1);
    for (let x = 0; x < W; x += 2.2) {
      const t = (x / W) * D, ph = phraseAt(t);
      const env = ph ? Math.sin(Math.PI * Math.min(1, (t - ph.t0) / 0.6)) * 0 + 0.35 + 0.65 * Math.abs(Math.sin(t * 2.3 + r() * 3)) * (0.6 + 0.4 * r()) : 0.04 + r() * 0.05;
      const a = env * 40;
      bars.appendChild(s('rect', { x: X0 + x, y: 58 - a, width: 1.5, height: a * 2 + 0.6, rx: 0.7, class: `mm-bar ${ph ? `sp-${ph.spk || 'x'}` : 'sil'}`, style: delay((x / W) * 0.9) }));
    }
    const axis = s('g', { class: 'mm-axis' });
    axis.appendChild(s('line', { x1: X0, y1: 108, x2: X0 + W, y2: 108 }));
    for (let t = 0; t <= D; t += 10) { axis.appendChild(s('line', { x1: X(t), y1: 106, x2: X(t), y2: 111 })); axis.appendChild(s('text', { x: X(t), y: 120, 'text-anchor': 'middle', 'font-size': 8 }, fmtT(t).replace(/\.0$/, ''))); }
    const laneG = s('g');
    for (const [spk, label, y] of lanes) {
      laneG.appendChild(s('rect', { x: X0, y, width: W, height: laneH, rx: 4, class: `mm-lane sp-${spk || 'x'}` }));
      laneG.appendChild(s('text', { x: 4, y: y + laneH / 2 + 3, 'font-size': 9, class: `mm-lane-label sp-${spk || 'x'}` }, label));
    }
    laneG.appendChild(s('text', { x: 4, y: 62, 'font-size': 9, class: 'mm-lane-label' }, 'Waveform'));
    const phrG = s('g'), turnG = s('g'), pinL = s('g'), hlL = s('g');
    const head = s('g', { class: 'mm-playhead', style: `--w:${W}px` });
    head.appendChild(s('line', { x1: X0, y1: 10, x2: X0, y2: 216 }));
    head.appendChild(s('path', { d: `M${X0 - 5},6 L${X0 + 5},6 L${X0},13 Z` }));
    svg.append(bars, axis, laneG, turnG, phrG, hlL, pinL, head);
    const list = h('ol.mm-transcript', { 'aria-label': 'Transcript' });
    const wrap = h('div.mm-audiowrap', h('div.mm-svgbox', svg), list);

    function selectPhrase(ph) {
      hlSpan(ph.t0, ph.t1, 'mm-hl-soft');
      list.querySelectorAll('li').forEach(li => li.classList.toggle('hl', li.dataset.id === ph.id));
      inspect(`Phrase · ${fmtT(ph.t0)}–${fmtT(ph.t1)}`, h('p', h(`span.mm-spk.sp-${ph.spk || 'x'}`, ph.speaker)), h('p.wb-quote', ph.text), confMeter(ph.conf),
        ph.text !== ph.truth ? h('p.alert.tone-error', h('strong', 'Actually said: '), ph.truth) : null,
        ph.spoken && ph.text === ph.truth ? h('p.small', `Spoken as “${ph.spoken}”; inverse text normalisation wrote “£120”.`) : null,
        h('p.small.mono', `startTimeMs ${Math.round(ph.t0 * 1000)} · endTimeMs ${Math.round(ph.t1 * 1000)}`));
    }
    function hlSpan(t0, t1, cls = 'mm-hl-span') {
      clear(hlL);
      hlL.appendChild(s('rect', { x: X(t0), y: 8, width: Math.max(2, X(t1) - X(t0)), height: 210, rx: 3, class: cls }));
      const lbl = `${fmtT(t0)}–${fmtT(t1)}`;
      const lx = Math.min(Math.max(X(t0), X0), X0 + W - lbl.length * 4.6);
      hlL.appendChild(s('text', { x: lx, y: 8, 'font-size': 8, class: 'mm-span-label' }, lbl));
    }
    return {
      el: wrap,
      stage(node) {
        if (node === 'ingest') svg.classList.add('mm-arrive');
        if (node === 'represent') svg.classList.add('mm-grow');
        if (node === 'process') {
          svg.classList.add('mm-grow');
          head.classList.add('go');
          for (const ph of A.phrases) {
            const lane = lanes.find(l => l[0] === ph.spk) || lanes[0];
            const x = X(ph.t0), w = X(ph.t1) - x, y = lane[2] + 3, hgt = laneH - 6;
            const g = s('g', { class: `mm-phrase sp-${ph.spk || 'x'}${ph.text !== ph.truth ? ' bad' : ''}`, style: delay((ph.t0 / D) * SWEEP) });
            g.appendChild(s('rect', { x, y, width: w, height: hgt, rx: 3 }));
            const max = Math.floor((w - 4) / 4.6);
            const txt = ph.text.length > max ? ph.text.slice(0, Math.max(0, max - 1)) + '…' : ph.text;
            if (max > 2) g.appendChild(s('text', { x: x + 2.5, y: y + hgt / 2 + 3, 'font-size': 8 }, txt));
            g.addEventListener('click', () => selectPhrase(ph));
            phrG.appendChild(g);
          }
          clear(list);
          A.phrases.forEach(ph => {
            const li = h(`li.mm-tline${ph.text !== ph.truth ? '.bad' : ''}`, { 'data-id': ph.id, tabindex: 0, style: { animationDelay: ((ph.t0 / D) * SWEEP).toFixed(2) + 's' } },
              h('span.mm-time', fmtT(ph.t0)), h(`span.mm-spk.sp-${ph.spk || 'x'}`, ph.speaker), h('span.mm-ttext', ph.text), h(`span.chip.tone-${confTone(ph.conf, 0.8)}`, ph.conf.toFixed(2)));
            li.addEventListener('click', () => selectPhrase(ph));
            li.addEventListener('keydown', e => { if (e.key === 'Enter') selectPhrase(ph); });
            list.appendChild(li);
          });
        }
        if (node === 'segment') {
          svg.classList.add('mm-colored');
          (res.view.segments || []).forEach((sg, i) => {
            const lane = lanes.find(l => l[0] === sg.spk) || lanes[0];
            const g = s('g', { class: `mm-turn sp-${sg.spk || 'x'}`, style: delay(i * 0.07) });
            g.appendChild(s('rect', { x: X(sg.t0) - 1, y: lane[2] + 0.5, width: X(sg.t1) - X(sg.t0) + 2, height: laneH - 1, rx: 4 }));
            g.appendChild(s('line', { x1: X(sg.t0), y1: 14, x2: X(sg.t0), y2: lane[2] }));
            g.addEventListener('click', () => { hlSpan(sg.t0, sg.t1, 'mm-hl-soft'); inspect(sg.label, h('p.small', `${fmtT(sg.t0)}–${fmtT(sg.t1)} · ${sg.ids.length} phrase(s)`), h('p.small', sg.spk ? 'A speaker turn: consecutive phrases from one speaker.' : 'Without diarization each phrase is its own unattributed segment.')); });
            turnG.appendChild(g);
          });
        }
        if (node === 'extract') {
          clear(pinL);
          res.view.fields.forEach((f, i) => {
            if (!f.source || f.synth) return;
            f.source.spans.forEach(sp => {
              const g = s('g', { class: 'mm-tpin', style: delay(i * 0.12) });
              g.appendChild(s('rect', { x: X(sp.t0), y: 99, width: Math.max(3, X(sp.t1) - X(sp.t0)), height: 4, rx: 2 }));
              g.appendChild(s('circle', { cx: X(sp.t0), cy: 101, r: 5.5 }));
              g.appendChild(s('text', { x: X(sp.t0), y: 103.6, 'text-anchor': 'middle', 'font-size': 7 }, String(i + 1)));
              g.addEventListener('click', () => selectField(f, i));
              pinL.appendChild(g);
            });
          });
        }
      },
      highlight(f) {
        clear(hlL);
        list.querySelectorAll('li').forEach(li => li.classList.remove('hl'));
        if (!f || !f.source) return;
        for (const sp of f.source.spans) {
          hlL.appendChild(s('rect', { x: X(sp.t0), y: 8, width: Math.max(2, X(sp.t1) - X(sp.t0)), height: 210, rx: 3, class: 'mm-hl-span' }));
          list.querySelector(`li[data-id="${sp.ref}"]`)?.classList.add('hl');
        }
        const sp = f.source.spans[0], lbl = `${fmtT(sp.t0)}–${fmtT(sp.t1)}`;
        hlL.appendChild(s('text', { x: Math.min(X(sp.t0), X0 + W - lbl.length * 4.6), y: 8, 'font-size': 8, class: 'mm-span-label' }, lbl));
        list.querySelector('li.hl')?.scrollIntoView({ block: 'nearest' });
      },
      highlightTime(t0, t1) { hlSpan(t0, t1, 'mm-hl-soft'); },
    };
  }

  // ======================= VIDEO =======================
  const shotAt = (V, t) => V.shots.find(x => t >= x.t0 && t < x.t1) || V.shots[V.shots.length - 1];
  function drawScene(V, t, { w = 160, overlay = true } = {}) {
    const sc = shotAt(V, t).scene;
    const g = s('g', { transform: `scale(${w / 160})` });
    const R = (x, y, ww, hh, fill, extra = {}) => g.appendChild(s('rect', { x, y, width: ww, height: hh, fill, ...extra }));
    const T = (x, y, txt, size, fill, extra = {}) => g.appendChild(s('text', { x, y, 'font-size': size, fill, 'font-family': 'Arial, sans-serif', 'font-weight': 700, ...extra }, txt));
    const belt = () => {
      R(0, 0, 160, 66, '#cfd6dc'); R(0, 66, 160, 24, '#8b9299');
      R(8, 40, 144, 6, '#3d4248'); R(8, 58, 144, 5, '#3d4248');
      for (let x = 12; x < 150; x += 12) g.appendChild(s('circle', { cx: x, cy: 43, r: 2.2, fill: '#6b7178' }));
      R(14, 46, 3, 20, '#565c63'); R(143, 46, 3, 20, '#565c63');
    };
    if (sc === 'title' || sc === 'end') {
      R(0, 0, 160, 90, '#1d2733');
      for (let x = -10; x < 170; x += 14) g.appendChild(s('polygon', { points: `${x},80 ${x + 7},80 ${x + 15},90 ${x + 8},90`, fill: '#f5c542' }));
      if (sc === 'title') { T(80, 40, 'SAFE HANDLING', 15, '#ffffff', { 'text-anchor': 'middle' }); T(80, 58, 'DEPOT 4', 11, '#f5c542', { 'text-anchor': 'middle' }); }
      else { T(80, 38, 'REPORT INCIDENTS', 12, '#ffffff', { 'text-anchor': 'middle' }); T(80, 56, 'WITHIN 1 HOUR', 12, '#f5c542', { 'text-anchor': 'middle' }); }
    } else if (sc === 'belt') {
      belt();
      const off = ((t - 9) * 7) % 40;
      for (const x0 of [10, 50, 90, 130]) { const x = 8 + ((x0 + off) % 140); R(x, 28, 16, 12, '#c8965a', { stroke: '#8a6232', 'stroke-width': 0.6 }); }
    } else if (sc === 'forklift') {
      R(0, 0, 160, 60, '#d5d9dd'); R(0, 60, 160, 30, '#9aa0a6');
      g.appendChild(s('path', { d: 'M0,74 L160,70 M0,86 L160,82', stroke: '#f5c542', 'stroke-width': 2.4 }));
      const fx = 18 + (t - 21) * 9;
      R(fx, 44, 30, 18, '#e8892b', { rx: 2 }); R(fx + 30, 22, 4, 40, '#444'); R(fx + 33, 58, 16, 3, '#444'); R(fx + 4, 34, 16, 10, 'none', { stroke: '#444', 'stroke-width': 2 });
      g.appendChild(s('circle', { cx: fx + 8, cy: 64, r: 5, fill: '#222' })); g.appendChild(s('circle', { cx: fx + 25, cy: 64, r: 5, fill: '#222' }));
      g.appendChild(s('circle', { cx: 132, cy: 24, r: 11, fill: '#fff', stroke: '#d0342c', 'stroke-width': 3 }));
      T(132, 28.5, '5', 12, '#111', { 'text-anchor': 'middle' });
    } else if (sc === 'fall') {
      belt();
      const k = Math.max(0, Math.min(1, (t - 29) / 6));
      R(62, 28, 16, 12, '#c8965a', { stroke: '#8a6232', 'stroke-width': 0.6 }); R(62, 16, 16, 12, '#c8965a', { stroke: '#8a6232', 'stroke-width': 0.6 });
      if (k < 0.85) g.appendChild(s('rect', { x: 62 + k * 22, y: 4 + k * 58, width: 16, height: 12, fill: '#c8965a', stroke: '#8a6232', 'stroke-width': 0.6, transform: `rotate(${k * 80} ${70 + k * 22} ${10 + k * 58})` }));
      else g.appendChild(s('polygon', { points: '80,82 100,80 102,74 92,72 84,76 78,75', fill: '#a8783f', stroke: '#6e4a24', 'stroke-width': 0.6 }));
      g.appendChild(s('path', { d: 'M90,20 l6,8 M96,16 l6,8 M84,24 l6,8', stroke: '#d0342c', 'stroke-width': 1.2, opacity: 0.8 }));
    } else if (sc === 'scan') {
      R(0, 0, 160, 64, '#d0d6db'); R(0, 64, 160, 26, '#8b9299');
      g.appendChild(s('circle', { cx: 54, cy: 22, r: 7, fill: '#d9a777' }));
      R(45, 30, 18, 24, '#c6e83a', { rx: 2 }); R(45, 40, 18, 3, '#e6e6e6'); R(47, 54, 6, 20, '#2d3540'); R(56, 54, 6, 20, '#2d3540');
      g.appendChild(s('path', { d: 'M62,34 L80,40', stroke: '#c6e83a', 'stroke-width': 4 }));
      R(78, 36, 9, 6, '#222', { rx: 1 });
      g.appendChild(s('path', { d: 'M87,40 L106,64', stroke: '#ff3b30', 'stroke-width': 1, opacity: 0.85 }));
      g.appendChild(s('polygon', { points: '98,74 128,72 130,62 116,58 102,62 96,64', fill: '#a8783f', stroke: '#6e4a24', 'stroke-width': 0.6 }));
    }
    if (overlay) {
      const ost = V.onscreen.find(x => (x.id === 'x3' || x.id === 'x5') && t >= x.t0 && t <= x.t1);
      if (ost) { R(10, 72, 140, 13, 'rgba(0,0,0,.72)', { rx: 2 }); T(80, 81.5, ost.text, 7.4, '#fff', { 'text-anchor': 'middle', textLength: Math.min(132, ost.text.length * 4.8), lengthAdjust: 'spacingAndGlyphs' }); }
    }
    return g;
  }
  function videoRenderer(v, live) {
    const V = v.video, D = V.duration, X0 = 62, W = 450;
    const X = t => X0 + (t / D) * W;
    // monitor
    const monSvg = s('svg', { viewBox: '0 0 160 90', class: 'mm-monitor-svg', role: 'img', 'aria-label': 'Current video frame' });
    const monTc = h('span.mm-tc', '00:00.0');
    const monCap = h('p.mm-moncap', 'Frame preview. Click a frame, keyframe or segment.');
    const monitor = h('div.mm-monitor', h('div.mm-screen', monSvg, monTc), monCap);
    const showFrame = (t, note) => { clear(monSvg).appendChild(drawScene(V, t)); monTc.textContent = fmtT(t); if (note) monCap.textContent = note; };
    showFrame(15, `${v.file} · ${D} s · ${V.fps} fps`);
    // timeline
    const svg = s('svg', { viewBox: '0 0 520 226', class: 'mm-svg mm-video', role: 'img', 'aria-label': 'Video timeline with frames, shots, segments, keyframes, on-screen text and narration' });
    if (!live) svg.classList.add('mm-dimsvg');
    const lanesDef = [['Frames', 6, 30], ['Shots', 44, 14], ['Segments', 64, 20], ['Keyframes', 90, 30], ['On-screen', 126, 16], ['Narration', 148, 16], ['Event', 170, 16]];
    const LY = Object.fromEntries(lanesDef.map(([n, y, hh]) => [n, { y, h: hh }]));
    const labels = s('g', { class: 'mm-lane-labels' });
    for (const [n, y, hh] of lanesDef) { labels.appendChild(s('text', { x: 4, y: y + hh / 2 + 3, 'font-size': 8.4, class: 'mm-lane-label' }, n)); if (n !== 'Frames') svg.appendChild(s('rect', { x: X0, y, width: W, height: hh, rx: 3, class: 'mm-lane' })); }
    svg.appendChild(labels);
    // filmstrip
    const film = s('g', { class: 'mm-film' });
    film.appendChild(s('rect', { x: X0 - 2, y: LY.Frames.y, width: W + 4, height: LY.Frames.h, rx: 3, class: 'mm-filmbg' }));
    const N = 16, fw = W / N;
    for (let i = 0; i < N; i++) {
      for (const hy of [LY.Frames.y + 1.6, LY.Frames.y + LY.Frames.h - 4]) for (let k = 0; k < 2; k++) film.appendChild(s('rect', { x: X0 + i * fw + 5 + k * 13, y: hy, width: 5, height: 2.4, rx: 0.8, class: 'mm-hole' }));
      const t = (i + 0.5) * (D / N);
      const frOuter = s('g', { class: 'mm-frame', style: delay(i * 0.04) });
      const fr = s('g', { transform: `translate(${X0 + i * fw + 1.5},${LY.Frames.y + (LY.Frames.h - (fw - 3) * 9 / 16) / 2})` });
      frOuter.appendChild(fr);
      const fwid = fw - 3;
      fr.appendChild(s('clipPath', { id: `mmclip${i}` }, s('rect', { x: 0, y: 0, width: fwid, height: fwid * 9 / 16 })));
      const inner = s('g', { 'clip-path': `url(#mmclip${i})` });
      inner.appendChild(drawScene(V, t, { w: fwid, overlay: true }));
      fr.appendChild(inner);
      frOuter.addEventListener('click', () => { showFrame(t, `Frame at ${fmtT(t)} · shot ${V.shots.indexOf(shotAt(V, t)) + 1}`); inspect(`Frame ${Math.round(t * V.fps)} · ${fmtT(t)}`, h('p.small', `One of ${(D * V.fps).toLocaleString('en-GB')} frames. ${shotAt(V, t).desc}`)); });
      film.appendChild(frOuter);
    }
    svg.appendChild(film);
    const axis = s('g', { class: 'mm-axis' });
    axis.appendChild(s('line', { x1: X0, y1: 194, x2: X0 + W, y2: 194 }));
    for (let t = 0; t <= D; t += 10) { axis.appendChild(s('line', { x1: X(t), y1: 192, x2: X(t), y2: 197 })); axis.appendChild(s('text', { x: X(t), y: 206, 'text-anchor': 'middle', 'font-size': 8 }, fmtT(t).replace(/\.0$/, ''))); }
    svg.appendChild(axis);
    const shotG = s('g'), segG = s('g'), cutG = s('g'), kfG = s('g'), ostG = s('g'), narG = s('g'), evG = s('g'), pinL = s('g'), hlL = s('g');
    const head = s('g', { class: 'mm-playhead', style: `--w:${W}px` });
    head.appendChild(s('line', { x1: X0, y1: 2, x2: X0, y2: 190 }));
    head.appendChild(s('path', { d: `M${X0 - 5},0 L${X0 + 5},0 L${X0},6 Z` }));
    svg.append(shotG, segG, kfG, ostG, narG, evG, cutG, hlL, pinL, head);
    const legend = h('p.mm-vlegend.small', 'Click any frame, segment, keyframe, caption or phrase to inspect it.');
    const wrap = h('div.mm-videowrap', monitor, h('div.mm-svgbox', svg), legend);

    function hlSpan(t0, t1, cls = 'mm-hl-span') {
      clear(hlL);
      hlL.appendChild(s('rect', { x: X(t0), y: 2, width: Math.max(2, X(t1) - X(t0)), height: 188, rx: 3, class: cls }));
      const lbl = `${fmtT(t0)}–${fmtT(t1)}`;
      hlL.appendChild(s('text', { x: Math.min(X(t0), X0 + W - lbl.length * 4.6), y: 212, 'font-size': 8.4, class: 'mm-span-label' }, lbl));
    }
    function selectSeg(sg) {
      hlSpan(sg.t0, sg.t1, 'mm-hl-soft');
      showFrame(sg.keyframes[0], `${sg.label} · keyframe ${fmtT(sg.keyframes[0])} · ${sg.desc}`);
      const ost = V.onscreen.filter(x => x.captured && sg.keyframes.some(t => t >= x.t0 && t <= x.t1));
      inspect(`${sg.label} · ${fmtT(sg.t0)}–${fmtT(sg.t1)}`, h('p', sg.desc), h('p.small', `Keyframes: ${sg.keyframes.map(fmtT).join(', ')}`),
        ost.length ? h('p.small', 'On-screen text: ', ost.map(x => h('span.mm-ost', x.text))) : h('p.small', 'No on-screen text read from this segment\'s keyframes.'),
        sg.shots.length > 1 ? h('p.alert.tone-warn', `This segment spans ${sg.shots.length} shots, so its description mixes them.`) : null);
    }
    return {
      el: wrap,
      stage(node) {
        if (node === 'ingest') svg.classList.add('mm-arrive');
        if (node === 'represent') { svg.classList.add('mm-filmin'); showFrame(4.5, `${(D * V.fps).toLocaleString('en-GB')} frames + ${D} s audio track`); }
        if (node === 'process') {
          head.classList.add('go');
          V.shots.forEach((sh, i) => {
            const g = s('g', { class: `mm-shot ${i % 2 ? 'odd' : ''}`, style: delay((sh.t0 / D) * SWEEP) });
            g.appendChild(s('rect', { x: X(sh.t0) + 0.5, y: LY.Shots.y + 1, width: X(sh.t1) - X(sh.t0) - 1, height: LY.Shots.h - 2, rx: 2 }));
            g.appendChild(s('text', { x: X(sh.t0) + 3, y: LY.Shots.y + 10, 'font-size': 7 }, `shot ${i + 1}`));
            g.addEventListener('click', () => { hlSpan(sh.t0, sh.t1, 'mm-hl-soft'); showFrame((sh.t0 + sh.t1) / 2, `Shot ${i + 1}: ${sh.desc}`); inspect(`Shot ${i + 1} · ${fmtT(sh.t0)}–${fmtT(sh.t1)}`, h('p', sh.desc), h('p.small', 'Shot detection finds the cuts between camera takes.')); });
            shotG.appendChild(g);
            if (i) cutG.appendChild(s('line', { x1: X(sh.t0), y1: LY.Shots.y - 2, x2: X(sh.t0), y2: LY.Shots.y + LY.Shots.h + 2, class: 'mm-shotcut', style: delay((sh.t0 / D) * SWEEP) }));
          });
          V.narration.forEach(n => {
            const g = s('g', { class: `mm-nar${n.text !== n.truth ? ' bad' : ''}`, style: delay((n.t0 / D) * SWEEP) });
            const x = X(n.t0), w = X(n.t1) - x;
            g.appendChild(s('rect', { x, y: LY.Narration.y + 2, width: w, height: LY.Narration.h - 4, rx: 3 }));
            const max = Math.floor((w - 4) / 3.8);
            g.appendChild(s('text', { x: x + 2, y: LY.Narration.y + 11, 'font-size': 6.6 }, n.text.length > max ? n.text.slice(0, Math.max(0, max - 1)) + '…' : n.text));
            g.addEventListener('click', () => { hlSpan(n.t0, n.t1, 'mm-hl-soft'); inspect(`Narration · ${fmtT(n.t0)}–${fmtT(n.t1)}`, h('p', h('span.mm-spk.sp-S1', n.speaker)), h('p.wb-quote', n.text), confMeter(n.conf), n.text !== n.truth ? h('p.alert.tone-error', h('strong', 'Actually said: '), n.truth) : null); });
            narG.appendChild(g);
          });
          // monitor plays through the shots
          V.shots.forEach((sh, i) => later(() => showFrame((sh.t0 + sh.t1) / 2, `Playing · shot ${i + 1}`), (sh.t0 / D) * SWEEP * 1000));
        }
        if (node === 'segment') {
          const segs = res.view.segments || [];
          segs.forEach((sg, i) => {
            const g = s('g', { class: 'mm-seg', style: `--c:${PALETTE[i % PALETTE.length]};${delay(0.2 + i * 0.08)}` });
            g.appendChild(s('rect', { x: X(sg.t0) + 1, y: LY.Segments.y + 1, width: X(sg.t1) - X(sg.t0) - 2, height: LY.Segments.h - 2, rx: 3 }));
            g.appendChild(s('text', { x: X(sg.t0) + 4, y: LY.Segments.y + 13, 'font-size': 7.4 }, segs.length > 6 ? `${sg.n}` : `seg ${sg.n}`));
            g.addEventListener('click', () => selectSeg(sg));
            segG.appendChild(g);
            if (i) cutG.appendChild(s('line', { x1: X(sg.t0), y1: 2, x2: X(sg.t0), y2: 190, class: 'mm-segcut', style: delay(0.1 + i * 0.08) }));
            const all = segs.flatMap(x => x.keyframes);
            const gap = all.length > 1 ? Math.min(...all.slice(1).map((t, j) => X(t) - X(all[j]))) : 60;
            const tw = Math.max(14, Math.min(44, gap - 2)), th = tw * 9 / 16;
            sg.keyframes.forEach((t, k) => {
              const kg = s('g', { class: 'mm-kf', style: delay(0.4 + i * 0.08 + k * 0.04) });
              const x = X(t) - tw / 2, y = LY.Keyframes.y + (LY.Keyframes.h - th) / 2;
              kg.appendChild(s('line', { x1: X(t), y1: LY.Segments.y + LY.Segments.h, x2: X(t), y2: y, class: 'mm-kf-stem' }));
              const tg = s('g', { transform: `translate(${x},${y})` });
              tg.appendChild(drawScene(V, t, { w: tw }));
              kg.appendChild(tg);
              kg.appendChild(s('rect', { x, y, width: tw, height: th, class: 'mm-kf-frame' }));
              kg.addEventListener('click', () => { showFrame(t, `Keyframe ${fmtT(t)} of ${sg.label}`); hlSpan(sg.t0, sg.t1, 'mm-hl-soft'); inspect(`Keyframe · ${fmtT(t)}`, h('p.small', `Sampled from ${sg.label}. Vision and OCR read this frame; anything between keyframes is not seen.`), h('p', sg.desc)); });
              kfG.appendChild(kg);
            });
          });
          V.onscreen.forEach((x, i) => {
            const g = s('g', { class: `mm-ostx${x.captured ? '' : ' missed'}`, style: delay(0.6 + i * 0.1) });
            g.appendChild(s('rect', { x: X(x.t0), y: LY['On-screen'].y + 2, width: X(x.t1) - X(x.t0), height: LY['On-screen'].h - 4, rx: 3 }));
            const max = Math.floor((X(x.t1) - X(x.t0) - 4) / 3.7);
            const label = x.captured ? x.text : `missed: ${x.text}`;
            g.appendChild(s('text', { x: X(x.t0) + 2, y: LY['On-screen'].y + 10.6, 'font-size': 6.4 }, label.length > max ? label.slice(0, Math.max(0, max - 1)) + '…' : label));
            g.addEventListener('click', () => { hlSpan(x.t0, x.t1, 'mm-hl-soft'); showFrame((x.t0 + x.t1) / 2); inspect('On-screen text', h('p.wb-quote', x.text), x.captured ? h('p.small', 'Read with OCR from a keyframe inside this time range.') : h('p.alert.tone-warn', 'No keyframe fell inside this caption\'s time range, so OCR never saw it. Add keyframes or segment by shots.')); });
            ostG.appendChild(g);
          });
          const ev = V.event;
          const eg = s('g', { class: `mm-event st-${ev.state}`, style: 'animation-delay:.9s' });
          eg.appendChild(s('rect', { x: X(ev.t0), y: LY.Event.y + 2, width: X(ev.t1) - X(ev.t0), height: LY.Event.h - 4, rx: 3 }));
          const evLabel = { captured: '✓ fall captured', merged: '≈ fall merged', missed: '✗ fall missed' }[ev.state];
          eg.appendChild(s('text', { x: X(ev.t1) + 4, y: LY.Event.y + 11, 'font-size': 7.6 }, `${evLabel} (truth ${fmtT(ev.t0)}–${fmtT(ev.t1)})`));
          eg.addEventListener('click', () => { hlSpan(ev.t0, ev.t1, 'mm-hl-soft'); showFrame(32, 'Ground truth: the parcel falls (00:29–00:36)'); inspect('Incident (ground truth, hidden from the analyzer)', h('p', `${ev.label}, ${fmtT(ev.t0)}–${fmtT(ev.t1)}.`), h('p.small', { captured: 'Shot-based segmentation gave the event its own segment and keyframe.', merged: 'A fixed window cuts through the shot, so the event shares a segment with other content and its time is approximate.', missed: 'One long segment: the brief event is folded away and never described.' }[ev.state])); });
          evG.appendChild(eg);
          const evSeg = segs.find(x => x.id === ev.seg);
          const kfT = evSeg ? (evSeg.keyframes.find(t => t >= ev.t0 && t <= ev.t1) ?? evSeg.keyframes[0]) : segs[0].keyframes[0];
          later(() => showFrame(kfT, ev.state === 'missed' ? `No keyframe shows the fall · nearest keyframe ${fmtT(kfT)}` : `Keyframe ${fmtT(kfT)} · ${evSeg.label}: ${evSeg.desc}`), 900);
        }
        if (node === 'extract') {
          clear(pinL);
          res.view.fields.forEach((f, i) => {
            if (!f.source || f.synth) return;
            f.source.spans.forEach(sp => {
              const g = s('g', { class: 'mm-tpin', style: delay(i * 0.12) });
              g.appendChild(s('rect', { x: X(sp.t0), y: 187, width: Math.max(3, X(sp.t1) - X(sp.t0)), height: 4, rx: 2 }));
              g.appendChild(s('circle', { cx: X(sp.t0), cy: 189, r: 5.5 }));
              g.appendChild(s('text', { x: X(sp.t0), y: 191.6, 'text-anchor': 'middle', 'font-size': 7 }, String(i + 1)));
              g.addEventListener('click', () => selectField(f, i));
              pinL.appendChild(g);
            });
          });
        }
      },
      highlight(f) {
        clear(hlL);
        if (!f || !f.source) return;
        for (const sp of f.source.spans) hlL.appendChild(s('rect', { x: X(sp.t0), y: 2, width: Math.max(2, X(sp.t1) - X(sp.t0)), height: 188, rx: 3, class: 'mm-hl-span' }));
        const sp = f.source.spans[0], lbl = `${fmtT(sp.t0)}–${fmtT(sp.t1)}`;
        hlL.appendChild(s('text', { x: Math.min(X(sp.t0), X0 + W - lbl.length * 4.6), y: 212, 'font-size': 8.4, class: 'mm-span-label' }, lbl));
        const kf = sp.kf != null ? sp.kf : (sp.t0 + sp.t1) / 2;
        showFrame(kf, `${f.name} → ${sp.kf != null ? `keyframe ${fmtT(sp.kf)}` : `${fmtT(sp.t0)}–${fmtT(sp.t1)}`} · ${sp.label}`);
      },
      highlightTime(t0, t1) { hlSpan(t0, t1, 'mm-hl-soft'); },
    };
  }

  // ---------------- failed ingest card ----------------
  function failedOverlay(st) {
    stageEl.appendChild(h('div.mm-reject', h('strong', '✕ Rejected at ingest'), h('span', st.title)));
  }

  // ---------------- representation panel ----------------
  function repCard(cls, title, visual, body) {
    return h(`div.mm-repcard.${cls}`, h('div.mm-repvis', visual), h('div.mm-repbody', h('h5', title), body));
  }
  function miniPixels(cols, rows, colorAt) {
    const g = s('svg', { viewBox: `0 0 ${cols} ${rows}`, class: 'mm-mini', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) g.appendChild(s('rect', { x, y, width: 1.02, height: 1.02, fill: colorAt(x, y) }));
    return g;
  }
  function drawRep(stageId) {
    const v = media;
    if (!v || !v.modality) return;
    const order = ['ingest', 'represent', 'process', 'segment', 'extract', 'output'];
    const k = stageId ? order.indexOf(stageId) : -1;
    clear(repEl).append(h('h4', 'Representation · how the analyzer sees this input'));
    const row = h('div.mm-reprow');
    repEl.appendChild(row);
    if (k < 1) { row.appendChild(h('p.small.mm-repidle', res && res.view.failed ? 'Nothing was represented: the request was rejected before analysis.' : 'Run to watch the input turn into pixels, samples or frames, then text, segments and markdown.')); return; }
    const r = rng('rep' + v.modality);
    // raw
    if (v.modality === 'document') row.appendChild(repCard('raw', 'Raw: page raster', miniPixels(18, 24, (x, y) => { const ink = v.lines.some(l => y * 12.4 >= l.box.y && y * 12.4 <= l.box.y + l.box.h + 4 && x * 11.7 >= l.box.x && x * 11.7 <= l.box.x + l.box.w); const g = ink ? 60 + r() * 80 : 235 + r() * 20; return `rgb(${g},${g},${g - 4})`; }),
      h('p.mono.small', `${v.rep.raster} · ${v.rep.pages} page`, h('br'), `row 412: 255 254 251 38 31 44 252 …`)));
    if (v.modality === 'image') row.appendChild(repCard('raw', 'Raw: pixel tensor', miniPixels(32, 22, (x, y) => sceneColor(x * 10 + 5, y * 10 + 5)), h('p.mono.small', `${v.rep.pixels} × ${v.rep.channels} = ${v.rep.values} values`, h('br'), 'px(120,140) = (247, 245, 239)')));
    if (v.modality === 'audio') { const A = v.audio; row.appendChild(repCard('raw', 'Raw: samples → frames', miniPixels(46, 12, (x, y) => { const t = (x / 46) * A.duration; const on = A.phrases.some(p => t >= p.t0 && t <= p.t1); const e = on ? Math.max(0, 1 - y / 12 - r() * 0.5) : r() * 0.15; return `hsl(${220 - e * 180},80%,${18 + e * 52}%)`; }), h('p.mono.small', `${v.rep.samples} samples · ${v.rep.sampleRate}`, h('br'), 'x[0..5] = 0.000 0.012 -0.031 0.044 -0.019 …'))); }
    if (v.modality === 'video') { const V = v.video; const sheet = s('svg', { viewBox: '0 0 162 60', class: 'mm-mini', 'aria-hidden': 'true' }); [3, 15, 25, 32, 43, 57].forEach((t, i) => { const g = s('g', { transform: `translate(${(i % 3) * 54 + 1},${Math.floor(i / 3) * 30 + 1})` }); g.appendChild(s('clipPath', { id: `mmsheet${i}` }, s('rect', { x: 0, y: 0, width: 52, height: 29.25 }))); const inner = s('g', { 'clip-path': `url(#mmsheet${i})` }); inner.appendChild(drawScene(V, t, { w: 52 })); g.appendChild(inner); sheet.appendChild(g); }); row.appendChild(repCard('raw', 'Raw: frames + audio', sheet, h('p.mono.small', `${v.rep.frames} frames @ ${v.rep.fps} fps`, h('br'), v.rep.audio))); }
    if (k < 2) return;
    // recognised
    let recog;
    if (v.modality === 'document') recog = h('pre.mm-snip', v.lines.slice(0, 6).map(l => `${l.conf.toFixed(2)}  ${l.text}`).join('\n'));
    if (v.modality === 'image') recog = h('pre.mm-snip', [`caption: ${v.caption.slice(0, 70)}…`, ...v.objects.slice(0, 3).map(o => `object: ${o.label} (${o.conf})`), ...v.ocr.slice(0, 3).map(o => `ocr: "${o.text}"`)].join('\n'));
    if (v.modality === 'audio') recog = h('pre.mm-snip', v.audio.phrases.slice(0, 4).map(p => `${fmtT(p.t0)} <v ${p.speaker}> ${p.text}`).join('\n'));
    if (v.modality === 'video') recog = h('pre.mm-snip', [...v.video.shots.slice(0, 3).map((x, i) => `shot ${i + 1} ${fmtT(x.t0)}–${fmtT(x.t1)}`), ...v.video.narration.slice(0, 2).map(n => `${fmtT(n.t0)} ${n.text}`)].join('\n'));
    row.appendChild(repCard('rec', { document: 'Recognised: lines + layout', image: 'Recognised: caption, objects, text', audio: 'Recognised: transcript', video: 'Recognised: shots + transcript' }[v.modality], h('span.mm-repicon', { document: 'Aa', image: '◎', audio: '“ ”', video: '⧉' }[v.modality]), recog));
    if (k < 3) return;
    const segs = res.view.segments || [];
    const bar = h('div.mm-segbar');
    const total = v.modality === 'audio' ? v.audio.duration : v.modality === 'video' ? v.video.duration : null;
    segs.forEach((sg, i) => bar.appendChild(h('span', { title: sg.label, style: { flex: total ? `${sg.t1 - sg.t0} 0 0` : '1 0 0', background: v.modality === 'audio' ? (sg.spk === 'S1' ? 'var(--mm-s1)' : sg.spk === 'S2' ? 'var(--mm-s2)' : 'var(--mm-s0)') : PALETTE[i % PALETTE.length] } })));
    row.appendChild(repCard('seg', `Segmented: ${segs.length} ${v.modality === 'audio' ? (v.audio.diarization ? 'speaker turns' : 'phrases') : v.modality === 'video' ? 'segments' : 'regions'}`, h('span.mm-repicon', '▦'), [bar, h('p.small', segs.slice(0, 4).map(x => x.label).join(' · ') + (segs.length > 4 ? ' …' : ''))]));
    if (k < 5) return;
    row.appendChild(repCard('md', 'Markdown for agents and RAG', h('span.mm-repicon', 'M↓'), h('pre.mm-snip', res.view.markdown.split('\n').slice(0, 7).join('\n') + '\n…')));
  }

  // ---------------- side panel ----------------
  function confMeter(c, th = 0.7) {
    return h('div.conf-meter', h('span', { class: `tone-${confTone(c, th)}`, style: { width: c * 100 + '%' } }), h('i', { style: { left: th * 100 + '%' }, title: 'review threshold 0.7' }));
  }
  const spanLabel = (sp, modality) => (sp.box ? `${modality === 'document' ? 'p1 · ' : ''}box ${sp.label.length > 22 ? sp.label.slice(0, 21) + '…' : sp.label}` : `${fmtT(sp.t0)}–${fmtT(sp.t1)}${sp.kf != null ? ` · kf ${fmtT(sp.kf)}` : ''}`);
  function selectField(f, i) {
    tb.panel('fields').querySelectorAll('.mm-field').forEach((c, j) => c.classList.toggle('sel', j === i));
    if (R && R.highlight) R.highlight(f);
    const v = res.view;
    inspect(`Field ${i + 1}: ${f.name}`,
      h('p', h(`span.mm-meth.m-${f.method}`, f.method), ' ', h('span.chip.muted', f.type), f.categories.length ? [' ', h('span.small', `[${f.categories.join(' | ')}]`)] : null),
      h('p.wb-quote', f.value === null ? 'null (no value)' : f.display),
      f.conf != null ? [confMeter(f.conf), h('p.small', `Confidence ${f.conf.toFixed(2)} (review threshold 0.7 in this lab)`)] : null,
      f.source ? h('div', h('p.small', h('strong', 'Sources (click to show)')), h('ul.mm-srcs', f.source.spans.map(sp => h('li', h('button.chip-btn', { type: 'button', onclick: () => { if (sp.box) R.highlightBox && R.highlightBox(sp.box); else R.highlightTime && R.highlightTime(sp.t0, sp.t1); } }, '⌖ ', spanLabel(sp, v.modality)), ' ', h('span.small', sp.label))))) : h('p.alert.tone-warn', f.value === null ? 'No value, so nothing to ground.' : 'No source returned: this value cannot be cited or checked.'),
      f.notes.map(n => h('p.small.mm-note', n)));
  }
  function drawFields(animate) {
    const p = clear(tb.panel('fields'));
    const v = res.view;
    if (!v.fields.length) { p.append(h('p.small', v.failed ? 'No fields: the analyzer or file was rejected.' : 'Fields appear at the "Grounded fields" stage.')); return; }
    p.append(h('p.small', `${v.custom ? 'Custom schema' : 'Prebuilt analyzer'} · ${v.fields.filter(f => f.value !== null).length}/${v.fields.length} filled · ${v.fields.filter(f => f.source).length} grounded. Click a card to see its evidence.`));
    v.fields.forEach((f, i) => {
      const tone = f.status === 'ok' ? 'ok' : f.status === 'warn' ? 'warn' : 'error';
      const card = h(`button.mm-field.tone-${tone}${animate ? '.pop' : ''}`, { type: 'button', style: { animationDelay: (i * 0.12).toFixed(2) + 's' }, onclick: () => selectField(f, i) },
        h('span.mm-fhead', h('span.mm-fnum', String(i + 1)), h('span.mm-fname', f.name), h(`span.mm-meth.m-${f.method}`, f.method)),
        h('span.mm-fval', f.value === null ? 'null' : f.display),
        f.conf != null ? h('span.mm-fconf', h('span.mm-ftrack', h('span', { class: `tone-${confTone(f.conf, 0.7)}`, style: { width: (f.conf * 100).toFixed(0) + '%' } })), h('em', f.conf.toFixed(2))) : null,
        h(`span.mm-ground${f.source ? '.on' : '.off'}`, f.source ? `⌖ ${f.source.spans.length > 1 ? `${f.source.spans.length} sources · ` : ''}${spanLabel(f.source.spans[0], v.modality)}` : f.value === null ? 'not found' : '⚠ no source'));
      p.appendChild(card);
    });
  }
  function drawPendingFields() {
    const p = clear(tb.panel('fields'));
    const v = res.view;
    if (v.failed) { p.append(h('p.small', 'No fields: the run stopped at ingest.')); return; }
    p.append(h('p.small', 'Schema loaded. Values arrive at the "Grounded fields" stage.'), h('ul.mm-schema', v.fields.map(f => h('li', h('span.mono', f.name), ' ', h(`span.mm-meth.m-${f.method}`, f.method), ' ', h('span.small', f.type)))));
  }
  function drawSegments() {
    const p = clear(tb.panel('segments'));
    const v = res.view;
    if (!v.segments || !v.segments.length) { p.append(h('p.small', 'Segments appear at the Segment stage.')); return; }
    const ul = h('ol.mm-seglist');
    v.segments.forEach((sg, i) => {
      const li = h('li', { tabindex: 0 }, h('span.mm-segsw', { style: { background: v.modality === 'audio' ? (sg.spk === 'S1' ? 'var(--mm-s1)' : sg.spk === 'S2' ? 'var(--mm-s2)' : 'var(--mm-s0)') : PALETTE[i % PALETTE.length] } }),
        h('span', h('strong', sg.label), sg.t0 != null ? h('span.small.mono', ` ${fmtT(sg.t0)}–${fmtT(sg.t1)}`) : null, sg.desc ? h('span.small.mm-segdesc', sg.desc) : null));
      const go = () => {
        if (sg.box) R.highlightBox && R.highlightBox(sg.box); else R.highlightTime && R.highlightTime(sg.t0, sg.t1);
        inspect(sg.label, sg.desc ? h('p', sg.desc) : null, sg.t0 != null ? h('p.small.mono', `${fmtT(sg.t0)}–${fmtT(sg.t1)}${sg.keyframes ? ` · keyframes ${sg.keyframes.map(fmtT).join(', ')}` : ''}`) : h('p.small.mono', `box ≈ [${sg.box.x}, ${sg.box.y}, ${sg.box.w}, ${sg.box.h}]`));
      };
      li.addEventListener('click', go); li.addEventListener('keydown', e => e.key === 'Enter' && go());
      ul.appendChild(li);
    });
    p.append(h('p.small', `${v.segments.length} segment(s). Click to locate.`), ul);
  }
  function drawOutput() {
    const p = clear(tb.panel('output'));
    const v = res.view;
    if (!v.output) { p.append(h('p.small', v.failed ? 'No output: the run was rejected at ingest.' : 'Output appears at the last stage.')); return; }
    p.append(h('p.small', v.output.format === 'markdown' ? 'Markdown content (send to a chunker / AI Search index, or straight to an agent):' : 'JSON result (abridged, illustrative shape):'), h('pre.code', v.output.text));
  }

  // ---------------- build ----------------
  function build(live) {
    stopTimers();
    clear(stageEl);
    R = null;
    if (!res) return;
    const v = res.view;
    media = v.failed ? (() => { try { return mod.sim.run({ ...params, format: 'native', analyzer: 'prebuilt' }).view; } catch { return null; } })() : v;
    drawHead();
    if (media && media.modality) {
      R = ({ document: docRenderer, image: imageRenderer, audio: audioRenderer, video: videoRenderer })[media.modality](media, live && !v.failed);
      stageEl.className = `mm-stage mm-is-${media.modality}`;
      stageEl.appendChild(R.el);
    }
  }

  const CAPTIONS = {
    ingest: (st, m) => st.status === 'error' ? `Stopped at ingest: ${st.title}. Nothing below runs.` : `${res.view.file} accepted. ${res.view.custom ? 'The custom analyzer (your field schema) was created first.' : 'Using the prebuilt analyzer.'} Analyze runs as a long-running operation.`,
    represent: (st, m) => ({ document: 'The page becomes a raster grid of pixels, plus any PDF text layer.', image: 'The photo dissolves into what the model actually receives: a grid of RGB pixels.', audio: 'The recording becomes a waveform: thousands of samples per second, grouped into short frames.', video: 'The clip becomes frames (25 per second) plus an audio track. Too many to read one by one.' })[m],
    process: (st, m) => ({ document: 'OCR sweeps the page: each line gets a box coloured by confidence; layout finds the table and the ticked checkbox.', image: 'Vision finds objects, reads text from pixels (OCR) and writes a caption. The note on the floor is read as content only.', audio: st.status === 'warn' ? 'The playhead sweeps, but with the wrong locale the phrases land as gibberish (red outline).' : `The playhead sweeps; phrases land ${res.view.audio && res.view.audio.diarization ? 'in each speaker\'s lane' : 'in one unattributed lane'} with timestamps.`, video: 'The playhead sweeps: cuts between shots are detected and the narration is transcribed.' })[m],
    segment: (st, m) => ({ document: 'The page splits into regions: these become chunk boundaries.', image: 'One frame, so segmentation means regions of interest.', audio: res.view.audio && res.view.audio.diarization ? 'Phrases group into speaker turns: colour shows who spoke.' : 'No diarization: phrases stay grey and unattributed.', video: `Segments and keyframes drop onto the timeline. Incident: ${res.view.video ? res.view.video.event.state : ''}.` })[m],
    extract: st => `Fields filled and pinned to their evidence (numbered). ${res.view.grounding ? 'Click a field card to light up its source.' : 'Grounding is off, so there is nothing to pin.'}`,
    output: st => `Result ready as ${res.view.output ? res.view.output.format.toUpperCase() : '—'}. See the Output tab and the markdown card below.`,
  };

  const api = {
    el,
    setParams(p) {
      params = p;
      try { res = mod.sim.run({ ...p }); } catch { res = null; }
      build(true);
      rail.reset();
      drawRep(null);
      idleDetail();
      if (res) { drawPendingFields(); drawSegments(); drawOutput(); tb.show('fields'); }
      caption.textContent = 'Press Run (or Step) to process this input stage by stage.';
    },
    setResult(r) {
      res = r;
      build(true);
      rail.reset();
      drawRep(null);
      idleDetail();
      drawPendingFields(); clear(tb.panel('segments')).append(h('p.small', 'Segments appear at the Segment stage.')); clear(tb.panel('output')).append(h('p.small', 'Output appears at the last stage.'));
      tb.show('fields');
    },
    setStep(st) {
      if (!res || !st.node) return;
      rail.set(st.node, st.status); rail.active(st.node);
      const m = media && media.modality;
      caption.textContent = (CAPTIONS[st.node] || (() => st.title))(st, m) || st.title;
      caption.className = `wb-caption${st.status === 'warn' ? ' mm-cap-warn' : st.status === 'error' ? ' mm-cap-error' : ''}`;
      if (st.status === 'error') { failedOverlay(st); drawFields(false); drawOutput(); return; }
      if (R) R.stage(st.node, st);
      drawRep(st.node);
      if (st.node === 'segment') drawSegments();
      if (st.node === 'extract') { drawFields(true); tb.show('fields'); }
      if (st.node === 'output') drawOutput();
    },
    clearRun() { if (params) api.setParams(params); else { res = null; rail.reset(); build(true); } },
    reset() { api.clearRun(); },
    flash(id) { rail.active(id); el.querySelector(`[data-stage="${id}"]`)?.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    select(id) { rail.active(id); },
    bindLab(l) { lab = l; drawHead(); },
  };
  idleDetail();
  return api;
}
