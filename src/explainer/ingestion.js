// Concept explainer: Document ingestion, OCR and layout analysis.
const PX = ['#1f2328', '#3b4048', '#e9e6dc', '#fffefa', '#cfc9b8', '#7a8089'];

export default [
  {
    title: 'To a computer, a scan is just pixels',
    caption: 'A photo or scan of a page is a grid of coloured dots. Nothing in it says “this is a word” or “this is a table” — software has to work that out.',
    notes: ['A typical A4 scan at 300 dpi is about 2,500 × 3,500 pixels. The first job of ingestion is to turn those pixels into text and structure that other systems can use.', 'Everything later — extraction, search, agents — depends on how well this first step goes.'],
    dur: 7000,
    draw(g, k) {
      g.appendChild(k.a(k.page(90, 70, 260, 360, { table: true }), 0, 'pop'));
      g.appendChild(k.a(k.arrow(380, 250, 470, 250), 0.6, 'draw'));
      g.appendChild(k.a(k.text(425, 232, 'zoom in', { size: 14, anchor: 'middle', cls: 'muted' }), 0.6));
      const grid = k.s('g');
      for (let r = 0; r < 14; r++) for (let c = 0; c < 18; c++) {
        const v = (r * 7 + c * 13 + (r * c) % 5) % 11;
        const fill = (r === 4 || r === 5 || r === 9) && c > 1 && c < 15 && v > 3 ? PX[v % 2] : PX[2 + (v % 3)];
        grid.appendChild(k.a(k.s('rect', { x: 500 + c * 20, y: 110 + r * 20, width: 19, height: 19, fill }), 0.9 + (r + c) * 0.025, 'pop'));
      }
      g.appendChild(grid);
      g.appendChild(k.a(k.text(680, 410, 'Just numbers: colour values per pixel', { size: 16, anchor: 'middle', cls: 'muted' }), 1.8));
    },
  },
  {
    title: 'OCR step 1: find where the text is',
    caption: 'Optical character recognition first detects regions that contain text — every line and every word gets a box (a polygon on the page).',
    notes: ['Detection is separate from reading: the model first finds text-like shapes, including small print, rotated text and handwriting.', 'Each detected item gets a polygon so you can always point back to where it came from.'],
    draw(g, k) {
      g.appendChild(k.page(330, 50, 300, 410, { lines: 11 }));
      const scan = k.s('rect', { x: 320, y: 50, width: 320, height: 10, class: 'ex-scan' });
      g.appendChild(scan);
      let y = 72;
      for (let i = 0; i < 12; i++) {
        const w = i === 0 ? 135 : 268 * (0.6 + ((i * 37) % 40) / 100);
        g.appendChild(k.a(k.s('rect', { x: 342, y: y - 4, width: w + 8, height: i === 0 ? 20 : 15, rx: 3, class: 'ex-detect' }), 0.3 + i * 0.12, 'pop'));
        y += i === 0 ? 26 : 15;
      }
      g.appendChild(k.a(k.chip(660, 120, '12 text regions found', { tone: 'info' }), 1.8, 'pop'));
    },
  },
  {
    title: 'OCR step 2: read each word — with a confidence',
    caption: 'Then each word is recognised. Every word comes with a confidence score between 0 and 1. Clean print scores high; smudges and handwriting score lower.',
    notes: ['Confidence is the model’s own estimate of how sure it is. It is not a guarantee, but it is the signal you use to decide what to trust automatically and what a person should check.'],
    draw(g, k) {
      const words = [['INVOICE', 0.99, 'ok'], ['INV-10442', 0.98, 'ok'], ['Total:', 0.97, 'ok'], ['1,24O.5O', 0.61, 'error'], ['Ana Ruiz', 0.74, 'warn']];
      words.forEach(([w, c, tone], i) => {
        const y = 90 + i * 74;
        const row = k.s('g');
        row.appendChild(k.box(150, y, 260, 50, { cls: `ex-word tone-${tone}`, r: 8 }));
        row.appendChild(k.text(170, y + 33, w, { size: 24, weight: 700, cls: i === 4 ? 'hand' : '' }));
        row.appendChild(k.bar(470, y + 17, 260, c, { tone, threshold: 0.8, d: 0.4 + i * 0.35 }));
        g.appendChild(k.a(row, i * 0.35));
      });
      g.appendChild(k.a(k.text(600, 470, '│ = your confidence threshold (0.80)', { size: 14, anchor: 'middle', cls: 'muted' }), 2));
    },
  },
  {
    title: 'Layout: the structure a person sees at a glance',
    caption: 'Layout analysis groups text into structure: title, headings, paragraphs, page header and footer, tables with rows and cells, and checkboxes with their state.',
    notes: ['In Azure Content Understanding (Foundry Tools) a document analyzer does OCR and layout together and returns markdown plus structure. Document Intelligence offers the same as prebuilt-layout; its prebuilt-read model gives text only, with no tables, roles or selection marks.', 'Structure is what keeps a total next to its label and a table row together.'],
    draw(g, k) {
      g.appendChild(k.page(260, 40, 360, 440, { table: true, lines: 8 }));
      // page footer text + a checkbox with its label
      g.appendChild(k.s('rect', { x: 276, y: 452, width: 150, height: 7, rx: 3, class: 'ex-ink' }));
      g.appendChild(k.s('rect', { x: 278, y: 300, width: 14, height: 14, class: 'ex-check on' }));
      g.appendChild(k.s('path', { d: 'M281,307 L285,311 L291,302', fill: 'none', stroke: '#10b981', 'stroke-width': 2.5 }));
      g.appendChild(k.s('rect', { x: 300, y: 304, width: 70, height: 7, rx: 3, class: 'ex-ink' }));
      // regions: [x, y, w, h, label, delay]
      const tags = [[268, 56, 186, 26, 'title', 0.2], [268, 84, 344, 128, 'paragraph', 0.6], [270, 210, 340, 72, 'table · 4 rows × 4 columns', 1.0], [268, 294, 110, 26, 'checkbox · selected', 1.4], [268, 444, 344, 24, 'pageFooter', 1.8]];
      tags.forEach(([x, y, w, hh, label, d]) => {
        g.appendChild(k.a(k.s('rect', { x, y, width: w, height: hh, rx: 6, class: 'ex-region' }), d, 'pop'));
        g.appendChild(k.a(k.s('line', { x1: x + w, y1: y + hh / 2, x2: 650, y2: y + hh / 2, class: 'ex-leader' }), d + 0.1, 'in'));
        g.appendChild(k.a(k.chip(656, y + hh / 2 + 5, label, { tone: label.startsWith('checkbox') ? 'ok' : 'info', size: 14 }), d + 0.15, 'pop'));
      });
    },
  },
  {
    title: 'Reading order: which text comes first?',
    caption: 'On a two-column page, reading straight across mixes the columns into nonsense. Layout follows the columns, so sentences stay whole.',
    notes: ['This matters most for RAG: if the text is out of order before chunking, every chunk is wrong and no retriever can fix it.'],
    dur: 8000,
    draw(g, k) {
      const panel = (x, label, good) => {
        const pg = k.s('g');
        pg.appendChild(k.page(x, 70, 300, 330, { twoCol: true, lines: 8, title: false }));
        const pts = [];
        for (let r = 0; r < 4; r++) {
          if (good) { pts.push([x + 30, 92 + r * 30]); }
          else { pts.push([x + 30, 92 + r * 30]); pts.push([x + 175, 92 + r * 30]); }
        }
        if (good) for (let r = 0; r < 4; r++) pts.push([x + 175, 92 + r * 30]);
        const d = 'M' + pts.map(p => p.join(',')).join(' L');
        pg.appendChild(k.a(k.s('path', { d, class: `ex-order ${good ? 'good' : 'bad'}`, pathLength: 100 }), good ? 2.2 : 0.4, 'draw'));
        pts.forEach((p, n) => {
          const dot = k.s('g');
          dot.append(k.s('circle', { cx: p[0], cy: p[1], r: 10, class: `ex-dot ${good ? 'good' : 'bad'}` }), k.text(p[0], p[1] + 5, String(n + 1), { size: 12, weight: 800, anchor: 'middle', cls: 'on-dot' }));
          pg.appendChild(k.a(dot, (good ? 2.2 : 0.4) + n * 0.12, 'pop'));
        });
        pg.appendChild(k.a(k.chip(x + 70, 440, label, { tone: good ? 'ok' : 'error', size: 15 }), good ? 2.4 : 0.6, 'pop'));
        return pg;
      };
      g.append(panel(110, '✗ straight across', false), panel(550, '✓ follows columns', true));
    },
  },
  {
    title: 'The result: structured output, ready to use',
    caption: 'Content Understanding returns the document as markdown (headings and tables kept) plus JSON detail: words with positions and confidence, tables and roles. That feeds extraction, search indexes and agents.',
    notes: ['Content Understanding returns the document as markdown plus structured content; Document Intelligence returns an AnalyzeResult (and markdown with outputContentFormat=markdown). Either way analysis is asynchronous: submit the file, then poll for the result.', 'Markdown is handy for chunking in RAG pipelines because headings and tables survive.'],
    draw(g, k) {
      g.appendChild(k.a(k.page(60, 120, 180, 240, { table: true, lines: 6 }), 0, 'pop'));
      g.appendChild(k.a(k.arrow(255, 240, 330, 170, { curve: 10 }), 0.4, 'draw'));
      g.appendChild(k.a(k.arrow(255, 240, 330, 330, { curve: -10 }), 0.6, 'draw'));
      const json = k.s('g');
      json.appendChild(k.box(340, 80, 260, 170, { cls: 'ex-card' }));
      ['{ "pages": [{', '    "words": [{', '      "content": "Total",', '      "confidence": 0.97 }] }],', '  "tables": [{ "rowCount": 4 }] }'].forEach((t, n) => json.appendChild(k.text(354, 110 + n * 26, t, { size: 12, cls: 'mono' })));
      g.appendChild(k.a(json, 0.7, 'pop'));
      const md = k.s('g');
      md.appendChild(k.box(340, 270, 260, 150, { cls: 'ex-card' }));
      ['# Supplier invoice', '| Item | Qty | Amount |', '| --- | --- | --- |', '| Toner | 2 | 180.00 |'].forEach((t, n) => md.appendChild(k.text(355, 300 + n * 28, t, { size: 13, cls: 'mono' })));
      g.appendChild(k.a(md, 0.9, 'pop'));
      [['Field extraction', 140], ['Search index (RAG)', 250], ['Agents', 360]].forEach(([label, y], n) => {
        g.appendChild(k.a(k.arrow(610, y < 250 ? 170 : y > 300 ? 340 : 250, 680, y - 6), 1.3 + n * 0.2, 'draw'));
        g.appendChild(k.a(k.chip(690, y, label, { tone: 'ok', size: 15 }), 1.4 + n * 0.2, 'pop'));
      });
    },
  },
];
