// Concept explainer: Multimodal content understanding.
// One parcel-damage case seen through four kinds of content (claim form, parcel photo,
// customer call, warehouse video), matching the lab in content/multimodal.js.
const SPK = { 1: '#8b5cf6', 2: '#f59e0b' };             // Speaker 1 / Speaker 2
const SHOT = ['#38bdf8', '#f97316', '#f472b6', '#a78bfa']; // shot tints
const INK = '#1b1d3a';                                    // text on light "paper" surfaces
const ink = el => { el.style.fill = INK; return el; };   // inline style beats .ex-text in dark mode
const TOPIC = 'fill: var(--topic)';
const TOPIC_STROKE = 'fill: none; stroke: var(--topic); stroke-width: 3';

// Deterministic waveform heights (0..1).
const wave = n => Array.from({ length: n }, (_, i) => 0.18 + 0.82 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.37 + 1)));

// ---------- small reusable pictures ----------
// Parcel photo: sky, floor, a cardboard box with a crushed corner. Returns { g, dent } (dent = crushed area box).
function photo(k, x, y, w, h) {
  const g = k.s('g');
  g.appendChild(k.s('rect', { x, y, width: w, height: h, rx: 10, fill: '#dbeafe', stroke: '#9aa1b0', 'stroke-width': 1.2 }));
  g.appendChild(k.s('path', { d: `M${x},${y + h * 0.66} L${x + w},${y + h * 0.66} L${x + w},${y + h - 10} Q${x + w},${y + h} ${x + w - 10},${y + h} L${x + 10},${y + h} Q${x},${y + h} ${x},${y + h - 10} Z`, fill: '#d6c7a8' }));
  const bx = x + w * 0.28, by = y + h * 0.3, bw = w * 0.44, bh = h * 0.5;
  g.appendChild(k.s('rect', { x: bx, y: by, width: bw, height: bh, rx: 3, fill: '#c08a4b' }));
  g.appendChild(k.s('rect', { x: bx + bw * 0.42, y: by, width: bw * 0.16, height: bh, fill: '#e8d9b5' })); // tape
  // crushed top-right corner
  const cx = bx + bw, cy = by;
  g.appendChild(k.s('path', { d: `M${cx - bw * 0.3},${cy} L${cx},${cy} L${cx},${cy + bh * 0.38} Z`, fill: '#dbeafe' }));
  g.appendChild(k.s('path', { d: `M${cx - bw * 0.3},${cy} L${cx - bw * 0.2},${cy + bh * 0.1} L${cx - bw * 0.12},${cy + bh * 0.08} L${cx - bw * 0.06},${cy + bh * 0.22} L${cx},${cy + bh * 0.38}`, fill: '#8a5a2b', stroke: '#5c3a17', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  return { g, dent: { x: cx - bw * 0.36, y: cy - 8, w: bw * 0.36 + 10, h: bh * 0.38 + 16 } };
}

// Film strip with sprocket holes; frames tinted by shot. Returns { g, fx(i), fw }.
function film(k, x, y, w, h, shotOf) {
  const n = shotOf.length, g = k.s('g');
  g.appendChild(k.s('rect', { x, y, width: w, height: h, rx: 6, fill: '#1f2328' }));
  const pad = 8, fw = (w - pad * 2) / n, hy = 4;
  for (let i = 0; i < n * 2; i++) {
    const hx = x + pad + i * (fw / 2) + fw / 4 - 3;
    g.appendChild(k.s('rect', { x: hx, y: y + hy, width: 6, height: 4, rx: 1, fill: '#9aa1b0' }));
    g.appendChild(k.s('rect', { x: hx, y: y + h - hy - 4, width: 6, height: 4, rx: 1, fill: '#9aa1b0' }));
  }
  const fy = y + 13, fh = h - 26;
  shotOf.forEach((sh, i) => {
    const fx = x + pad + i * fw;
    g.appendChild(k.s('rect', { x: fx + 2, y: fy, width: fw - 4, height: fh, rx: 3, fill: SHOT[sh], opacity: 0.85 }));
    // a simple subject in each frame (box or figure), shifted a little frame to frame
    const sx = fx + fw * (0.3 + (i % 3) * 0.12), sy = fy + fh * 0.45;
    if (sh % 2 === 0) g.appendChild(k.s('rect', { x: sx, y: sy, width: fw * 0.3, height: fh * 0.35, rx: 2, fill: '#7c4a1e', opacity: 0.8 }));
    else g.appendChild(k.s('circle', { cx: sx + fw * 0.12, cy: sy + fh * 0.12, r: fh * 0.16, fill: '#1f2328', opacity: 0.55 }));
  });
  return { g, fx: i => x + pad + i * fw, fw, fy, fh };
}

// Waveform bars in a lane. Returns array of bar elements with their x.
function bars(k, x, cy, w, amp, n, { fill = '#9aa1b0', style } = {}) {
  const hs = wave(n), bw = w / n;
  return hs.map((v, i) => k.s('rect', { x: x + i * bw + bw * 0.2, y: cy - v * amp, width: bw * 0.6, height: v * amp * 2, rx: bw * 0.3, fill, style }));
}

// A labelled field card: name (muted), value (big), source line.
function fieldCard(k, x, y, w, name, value, source) {
  const g = k.s('g');
  g.appendChild(k.box(x, y, w, 92, { cls: 'ex-card', r: 12 }));
  g.appendChild(k.text(x + 18, y + 26, name, { size: 14, cls: 'muted', weight: 600 }));
  g.appendChild(k.text(x + 18, y + 56, value, { size: 24, weight: 800 }));
  g.appendChild(k.text(x + 18, y + 80, source, { size: 13, cls: 'mono muted' }));
  return g;
}

export default [
  {
    title: 'Four kinds of content, one question',
    caption: 'Evidence about the same parcel arrives as a claim form, a photo, a phone call and a warehouse video. We want the same answers from all of them: what happened, how much, and who?',
    notes: ['Azure Content Understanding handles all four modalities with analyzers: each one turns a file (or URL) into structured output you define.', 'The value is one consistent result format, whatever the input looked like.'],
    dur: 7000,
    draw(g, k) {
      const X = [70, 290, 510, 730], Y = 50, TW = 160, TH = 190;
      const tiles = [
        () => k.page(X[0] + 10, Y, TW - 20, TH, { table: true, lines: 4 }),
        () => photo(k, X[1], Y + 25, TW, TH - 50).g,
        () => {
          const t = k.s('g');
          t.appendChild(k.box(X[2], Y + 25, TW, TH - 50, { cls: 'ex-card', r: 12 }));
          bars(k, X[2] + 14, Y + TH / 2, TW - 28, 46, 18, { style: TOPIC }).forEach(b => t.appendChild(b));
          return t;
        },
        () => {
          const t = k.s('g');
          t.appendChild(film(k, X[3], Y + 40, TW, 100, [0, 1, 2]).g);
          t.appendChild(k.s('circle', { cx: X[3] + TW / 2, cy: Y + 90, r: 22, fill: '#ffffff', opacity: 0.92 }));
          t.appendChild(k.s('path', { d: `M${X[3] + TW / 2 - 7},${Y + 78} L${X[3] + TW / 2 + 11},${Y + 90} L${X[3] + TW / 2 - 7},${Y + 102} Z`, fill: '#1f2328' }));
          return t;
        },
      ];
      const names = ['Document', 'Image', 'Audio', 'Video'];
      tiles.forEach((make, i) => {
        g.appendChild(k.a(make(), i * 0.3, 'pop'));
        g.appendChild(k.a(k.text(X[i] + TW / 2, Y + TH + 36, names[i], { size: 20, weight: 700, anchor: 'middle' }), i * 0.3 + 0.2));
      });
      // the shared question
      const qx = 210, qy = 360, qw = 540, qh = 74;
      [0, 1, 2, 3].forEach(i => g.appendChild(k.a(k.arrow(qx + qw / 2 + (i - 1.5) * 90, qy - 6, X[i] + TW / 2, Y + TH + 50, { curve: 0 }), 1.6 + i * 0.12, 'draw')));
      const q = k.s('g');
      q.appendChild(k.s('rect', { x: qx, y: qy, width: qw, height: qh, rx: 37, style: 'fill: color-mix(in srgb, var(--topic) 14%, var(--surface)); stroke: var(--topic); stroke-width: 2.5' }));
      q.appendChild(k.text(qx + qw / 2, qy + 47, 'What happened?  How much?  Who?', { size: 26, weight: 800, anchor: 'middle' }));
      g.appendChild(k.a(q, 1.3, 'pop'));
    },
  },
  {
    title: 'Everything becomes something a model can read',
    caption: 'Each kind of content is turned into a representation the model can reason over: text and layout for documents, a description and detected text for images, a timed transcript for audio, and shots plus transcript for video.',
    notes: ['Behind the scenes this uses document layout/OCR, image description and OCR, speech-to-text (with word timestamps and optional speaker diarization) and video shot detection with keyframes.', 'The prebuilt analyzer per modality (named like prebuilt-document, prebuilt-audio, prebuilt-video; exact IDs vary by API version, so treat them as illustrative) produces this content before any field is extracted.'],
    dur: 8000,
    draw(g, k) {
      const rows = [
        ['', 'Document', ['text', 'layout: title · table · ☑']],
        ['', 'Image', ['caption', 'objects', 'text in image']],
        ['', 'Audio', ['transcript', 'timestamps']],
        ['', 'Video', ['shots · keyframes', 'transcript']],
      ];
      const Y0 = 52, RH = 108;
      rows.forEach(([emo, name, chips], r) => {
        const cy = Y0 + r * RH + 40, d = r * 0.45;
        const icon = k.s('g');
        icon.appendChild(k.box(40, cy - 34, 170, 68, { cls: 'ex-card', r: 14 }));
        icon.appendChild(k.text(125, cy + 7, name, { size: 19, weight: 600, anchor: 'middle' }));
        g.appendChild(k.a(icon, d, 'slide'));
        g.appendChild(k.a(k.arrow(222, cy, 270, cy), d + 0.25, 'draw'));
        let cx = 284;
        chips.forEach((c, j) => {
          const chip = k.chip(cx, cy + 6, c, { tone: 'info', size: 16 });
          g.appendChild(k.a(chip, d + 0.4 + j * 0.15, 'pop'));
          cx += c.length * 16 * 0.58 + 18 + 12;
        });
        g.appendChild(k.a(k.arrow(615, cy, 762, 260 + (r - 1.5) * 26, { curve: 0 }), 2.2 + r * 0.08, 'draw'));
      });
      const brain = k.s('g');
      brain.appendChild(k.s('circle', { cx: 840, cy: 260, r: 72, style: 'fill: color-mix(in srgb, var(--topic) 16%, var(--surface)); stroke: var(--topic); stroke-width: 3' }));
      brain.appendChild(k.text(840, 254, '', { size: 40, anchor: 'middle' }));
      brain.appendChild(k.text(840, 290, 'model', { size: 18, weight: 800, anchor: 'middle' }));
      g.appendChild(k.a(brain, 2.6, 'pop'));
    },
  },
  {
    title: 'Split long content into meaningful parts',
    caption: 'A long call or video is easier to understand in pieces. Audio is split into speaker turns, so you know who said what. Video is split into shots, each with a keyframe that represents it.',
    notes: ['Speaker diarization labels phrases Speaker 1 / Speaker 2 (not names); consecutive phrases from one speaker form a turn.', 'For video, shot detection finds the cuts and keyframes are sampled per shot; segments let fields be answered per part instead of for the whole file.'],
    dur: 8000,
    draw(g, k) {
      const X = 150, WD = 740;
      // ---- audio ----
      g.appendChild(k.a(k.text(40, 152, 'Call', { size: 18, weight: 700 }), 0));
      const N = 60, grey = bars(k, X, 146, WD, 46, N);
      grey.forEach((b, i) => g.appendChild(k.a(b, i * 0.008, 'in')));
      const turns = [[0, 0.24, 1], [0.24, 0.52, 2], [0.52, 0.7, 1], [0.7, 1, 2]];
      turns.forEach(([a, b, spk], t) => {
        const d = 0.8 + t * 0.35, lo = Math.round(a * N), hi = Math.round(b * N);
        const seg = k.s('g');
        seg.appendChild(k.s('rect', { x: X + a * WD + 2, y: 92, width: (b - a) * WD - 4, height: 108, rx: 10, fill: SPK[spk], opacity: 0.12 }));
        bars(k, X, 146, WD, 46, N, { fill: SPK[spk] }).slice(lo, hi).forEach(el => seg.appendChild(el));
        g.appendChild(k.a(seg, d, 'in'));
        const lbl = k.s('g');
        const lx = X + ((a + b) / 2) * WD;
        lbl.appendChild(k.s('rect', { x: lx - 50, y: 52, width: 100, height: 28, rx: 14, fill: SPK[spk] }));
        lbl.appendChild(k.text(lx, 72, `Speaker ${spk}`, { size: 15, weight: 800, anchor: 'middle', cls: 'on-dot' }));
        g.appendChild(k.a(lbl, d + 0.1, 'pop'));
      });
      // ---- video ----
      g.appendChild(k.a(k.text(40, 322, 'Video', { size: 18, weight: 700 }), 0.2));
      const shotOf = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3];
      const f = film(k, X, 272, WD, 92, shotOf);
      g.appendChild(k.a(f.g, 0.2, 'in'));
      const cuts = [3, 6, 10];
      cuts.forEach((c, i) => {
        const cx = f.fx(c);
        g.appendChild(k.a(k.s('line', { x1: cx, x2: cx, y1: 260, y2: 376, stroke: '#ef4444', 'stroke-width': 4, 'stroke-linecap': 'round' }), 2.0 + i * 0.15, 'pop'));
      });
      const bounds = [0, 3, 6, 10, 12], keyF = [1, 4, 8, 11];
      for (let s = 0; s < 4; s++) {
        const x0 = f.fx(bounds[s]) + 4, x1 = f.fx(bounds[s + 1]) - 4, d = 2.5 + s * 0.2;
        const br = k.s('g');
        br.appendChild(k.s('path', { d: `M${x0},388 L${x0},396 L${x1},396 L${x1},388`, fill: 'none', stroke: SHOT[s], 'stroke-width': 3, 'stroke-linejoin': 'round' }));
        br.appendChild(k.text((x0 + x1) / 2, 422, `Shot ${s + 1}`, { size: 16, weight: 700, anchor: 'middle' }));
        g.appendChild(k.a(br, d, 'in'));
        // keyframe ring
        g.appendChild(k.a(k.s('rect', { x: f.fx(keyF[s]) - 1, y: f.fy - 5, width: f.fw + 2, height: f.fh + 10, rx: 6, fill: 'none', style: 'stroke: var(--topic); stroke-width: 4' }), d + 0.1, 'pop'));
      }
      const leg = k.s('g');
      leg.appendChild(k.s('rect', { x: X, y: 452, width: 26, height: 20, rx: 5, fill: 'none', style: 'stroke: var(--topic); stroke-width: 4' }));
      leg.appendChild(k.text(X + 38, 468, '= keyframe', { size: 15, cls: 'muted' }));
      leg.appendChild(k.s('line', { x1: X + 180, x2: X + 180, y1: 450, y2: 474, stroke: '#ef4444', 'stroke-width': 4, 'stroke-linecap': 'round' }));
      leg.appendChild(k.text(X + 194, 468, '= cut between shots', { size: 15, cls: 'muted' }));
      g.appendChild(k.a(leg, 3.3));
    },
  },
  {
    title: 'Every answer points to where it came from',
    caption: 'Each extracted field comes with its source: a box on the image or page, or a time range in the audio or video. You can always check the answer.',
    notes: ['This is grounding: with source estimation enabled, a field’s result carries a source reference (page/region coordinates, or start and end time in milliseconds) plus a confidence score.', 'Grounding is what makes review fast and lets an agent cite evidence instead of just asserting it.'],
    dur: 8000,
    draw(g, k) {
      const CX = 560, CW = 340;
      // row 1: image with box
      const p = photo(k, 60, 30, 300, 130);
      g.appendChild(k.a(p.g, 0, 'in'));
      g.appendChild(k.a(k.s('rect', { x: p.dent.x, y: p.dent.y, width: p.dent.w, height: p.dent.h, rx: 6, class: 'ex-region' }), 0.5, 'pop'));
      g.appendChild(k.a(fieldCard(k, CX, 40, CW, 'Damage type', 'Crushed', 'box on parcel photo'), 0.8, 'slide'));
      g.appendChild(k.a(k.arrow(CX - 8, 86, p.dent.x + p.dent.w + 10, p.dent.y + p.dent.h / 2, { curve: 10 }), 1.0, 'draw'));

      // row 2: audio with time range
      const AY = 255, AX = 60, AW = 300;
      g.appendChild(k.a(k.box(AX, AY - 50, AW, 100, { cls: 'ex-card', r: 12 }), 0.2, 'in'));
      const N = 30, hl = [22, 27];
      bars(k, AX + 12, AY, AW - 24, 34, N, { fill: '#9aa1b0' }).forEach((b, i) => g.appendChild(k.a(b, 0.2, 'in')));
      const bw = (AW - 24) / N, rx0 = AX + 12 + hl[0] * bw, rw = (hl[1] - hl[0]) * bw;
      const range = k.s('g');
      range.appendChild(k.s('rect', { x: rx0, y: AY - 44, width: rw, height: 88, rx: 6, style: 'fill: color-mix(in srgb, var(--topic) 22%, transparent); stroke: var(--topic); stroke-width: 2.5' }));
      bars(k, AX + 12, AY, AW - 24, 34, N, { style: TOPIC }).slice(hl[0], hl[1]).forEach(b => range.appendChild(b));
      g.appendChild(k.a(range, 1.3, 'pop'));
      g.appendChild(k.a(fieldCard(k, CX, 209, CW, 'Refund offered', '£120', 'call 00:59 – 01:11'), 1.5, 'slide'));
      g.appendChild(k.a(k.arrow(CX - 8, 255, rx0 + rw + 10, AY, { curve: 0 }), 1.7, 'draw'));

      // row 3: video with time range
      const shotOf = [0, 0, 1, 1, 1, 2, 2, 3];
      const f = film(k, 60, 380, 300, 80, shotOf);
      g.appendChild(k.a(f.g, 0.4, 'in'));
      const vx = f.fx(5) - 2, vw = f.fw * 2 + 4;
      g.appendChild(k.a(k.s('rect', { x: vx, y: 372, width: vw, height: 96, rx: 6, style: 'fill: color-mix(in srgb, var(--topic) 20%, transparent); stroke: var(--topic); stroke-width: 3' }), 2.0, 'pop'));
      g.appendChild(k.a(fieldCard(k, CX, 376, CW, 'What happened', 'Parcel dropped', 'video 00:29 – 00:36'), 2.2, 'slide'));
      g.appendChild(k.a(k.arrow(CX - 8, 422, vx + vw + 10, 420, { curve: 0 }), 2.4, 'draw'));
    },
  },
  {
    title: 'Three ways to get a value',
    caption: 'You decide how each field is filled. Extract copies a value that is there, classify picks one of your categories, and generate writes something new, like a summary.',
    notes: ['In the analyzer’s field schema each field has a type and a method: extract, classify (with an enum of categories) or generate.', 'Extract is the easiest to verify, because the value is literally in the source; generated values need the most review.'],
    dur: 8000,
    draw(g, k) {
      const COLS = [40, 345, 650], W = 270;
      const head = (x, d, title, sub) => {
        g.appendChild(k.a(k.text(x + W / 2, 52, title, { size: 28, weight: 800, anchor: 'middle' }), d));
        g.appendChild(k.a(k.text(x + W / 2, 78, sub, { size: 16, anchor: 'middle', cls: 'muted' }), d + 0.1));
      };
      // ---- extract ----
      let x = COLS[0], d = 0;
      head(x, d, '✂️ Extract', 'copy what’s there');
      const src1 = k.s('g');
      src1.appendChild(k.s('rect', { x, y: 100, width: W, height: 130, rx: 8, class: 'ex-paper' }));
      src1.appendChild(k.s('rect', { x: x + 18, y: 122, width: 160, height: 8, rx: 3, class: 'ex-ink' }));
      src1.appendChild(ink(k.text(x + 18, 165, 'Tracking ref:', { size: 16 })));
      src1.appendChild(ink(k.text(x + 128, 165, 'PX-48213', { size: 18, weight: 800 })));
      src1.appendChild(k.s('rect', { x: x + 18, y: 190, width: 210, height: 8, rx: 3, class: 'ex-ink' }));
      g.appendChild(k.a(src1, d + 0.2, 'pop'));
      g.appendChild(k.a(k.s('rect', { x: x + 120, y: 144, width: 104, height: 30, rx: 5, class: 'ex-region' }), d + 0.7, 'pop'));
      g.appendChild(k.a(k.arrow(x + W / 2, 240, x + W / 2, 290), d + 0.9, 'draw'));
      g.appendChild(k.a(fieldCard(k, x, 300, W, 'trackingRef', 'PX-48213', 'copied as-is'), d + 1.1, 'pop'));

      // ---- classify ----
      x = COLS[1]; d = 0.8;
      head(x, d, 'Classify', 'pick from categories');
      const ph = photo(k, x + 45, 100, 180, 70);
      g.appendChild(k.a(ph.g, d + 0.2, 'pop'));
      const cats = ['crushed', 'wet', 'torn', 'none'];
      let cx = x + 2;
      cats.forEach((c, i) => {
        const chip = k.chip(cx, 210, c, { tone: c === 'crushed' ? 'ok' : 'muted', size: 15 });
        g.appendChild(k.a(chip, d + 0.4 + i * 0.1, 'pop'));
        cx += c.length * 15 * 0.58 + 18 + 8;
      });
      g.appendChild(k.a(k.s('rect', { x: x - 4, y: 186, width: 85, height: 36, rx: 18, fill: 'none', stroke: '#10b981', 'stroke-width': 3 }), d + 0.9, 'pop'));
      g.appendChild(k.a(k.arrow(x + W / 2, 240, x + W / 2, 290), d + 1.0, 'draw'));
      g.appendChild(k.a(fieldCard(k, x, 300, W, 'damageType', 'crushed', 'one of 4 categories'), d + 1.2, 'pop'));

      // ---- generate ----
      x = COLS[2]; d = 1.6;
      head(x, d, '✍️ Generate', 'write something new');
      const src3 = k.s('g');
      src3.appendChild(k.box(x, 100, W, 130, { cls: 'ex-card', r: 12 }));
      [[1, 0.7], [2, 0.9], [1, 0.55], [2, 0.8]].forEach(([spk, f], i) => {
        src3.appendChild(k.s('circle', { cx: x + 24, cy: 124 + i * 28, r: 7, fill: SPK[spk] }));
        src3.appendChild(k.s('rect', { x: x + 40, y: 120 + i * 28, width: (W - 60) * f, height: 8, rx: 4, class: 'ex-ink' }));
      });
      g.appendChild(k.a(src3, d + 0.2, 'pop'));
      g.appendChild(k.a(k.arrow(x + W / 2, 240, x + W / 2, 290), d + 0.6, 'draw'));
      const sum = k.s('g');
      sum.appendChild(k.box(x, 300, W, 120, { cls: 'ex-card', r: 12 }));
      sum.appendChild(k.text(x + 18, 326, 'summary', { size: 14, cls: 'muted', weight: 600 }));
      ['Parcel arrived crushed;', 'agent refunds £120 and', 'opens a claim.'].forEach((t, i) => sum.appendChild(k.text(x + 18, 356 + i * 24, t, { size: 18, weight: 700 })));
      g.appendChild(k.a(sum, d + 0.8, 'pop'));
      g.appendChild(k.a(k.text(480, 470, 'easiest to check  ◀────────────────▶  needs most review', { size: 15, anchor: 'middle', cls: 'muted' }), 2.8));
    },
  },
  {
    title: 'Ready for agents and search',
    caption: 'The result is markdown plus JSON fields, each with its source. An agent or a RAG index can use it to answer questions and cite exactly where the answer came from.',
    notes: ['Content Understanding returns markdown content (good for chunking and indexing) and a fields object; grounded fields keep their source references.', 'Treat everything read from content as data, not instructions: text inside an image or a call is never a command for the agent.'],
    dur: 8000,
    draw(g, k) {
      // outputs
      const md = k.s('g');
      md.appendChild(k.box(40, 50, 290, 170, { cls: 'ex-card', r: 12 }));
      md.appendChild(k.text(58, 78, 'markdown', { size: 14, cls: 'muted', weight: 600 }));
      ['# Parcel Damage Claim', '**Speaker 1:** I can refund', '£120 today…', '| Item | Value |'].forEach((t, i) => md.appendChild(k.text(58, 108 + i * 28, t, { size: 14, cls: 'mono' })));
      g.appendChild(k.a(md, 0, 'pop'));
      const js = k.s('g');
      js.appendChild(k.box(40, 250, 290, 200, { cls: 'ex-card', r: 12 }));
      js.appendChild(k.text(58, 278, 'JSON fields', { size: 14, cls: 'muted', weight: 600 }));
      ['"refund": {', '\u00a0\u00a0"value": 120,', '\u00a0\u00a0"source": "00:59–01:11"', '},', '"damageType": "crushed"'].forEach((t, i) => js.appendChild(k.text(58, 308 + i * 28, t, { size: 14, cls: 'mono' })));
      g.appendChild(k.a(js, 0.2, 'pop'));
      g.appendChild(k.a(k.arrow(340, 140, 418, 230), 0.6, 'draw'));
      g.appendChild(k.a(k.arrow(340, 350, 418, 270), 0.7, 'draw'));
      // agent
      const ag = k.s('g');
      ag.appendChild(k.s('circle', { cx: 480, cy: 250, r: 56, style: 'fill: color-mix(in srgb, var(--topic) 16%, var(--surface)); stroke: var(--topic); stroke-width: 3' }));
      ag.appendChild(k.text(480, 256, '', { size: 40, anchor: 'middle' }));
      ag.appendChild(k.text(480, 334, 'agent / RAG', { size: 17, weight: 800, anchor: 'middle' }));
      g.appendChild(k.a(ag, 0.9, 'pop'));
      // chat
      const q = k.s('g');
      q.appendChild(k.s('rect', { x: 600, y: 60, width: 320, height: 58, rx: 18, style: 'fill: var(--surface-2); stroke: var(--border); stroke-width: 1.5' }));
      q.appendChild(k.text(620, 96, '“How much was refunded?”', { size: 19, weight: 600 }));
      g.appendChild(k.a(q, 1.3, 'slide'));
      g.appendChild(k.a(k.arrow(545, 220, 596, 180, { curve: 0 }), 1.8, 'draw'));
      const ans = k.s('g');
      ans.appendChild(k.s('rect', { x: 600, y: 150, width: 320, height: 90, rx: 18, style: 'fill: color-mix(in srgb, var(--topic) 14%, var(--surface)); stroke: var(--topic); stroke-width: 2' }));
      ans.appendChild(k.text(620, 186, '£120, offered by the agent', { size: 19, weight: 700 }));
      ans.appendChild(k.text(620, 216, 'on the customer call.', { size: 19, weight: 700 }));
      g.appendChild(k.a(ans, 2.0, 'pop'));
      g.appendChild(k.a(k.text(620, 280, 'Sources', { size: 15, cls: 'muted', weight: 700 }), 2.4));
      g.appendChild(k.a(k.chip(620, 318, 'call-0193.wav · 00:59–01:11', { tone: 'ok', size: 15 }), 2.5, 'pop'));
      g.appendChild(k.a(k.chip(620, 362, 'claim form · p.1 · amount box', { tone: 'ok', size: 15 }), 2.7, 'pop'));
    },
  },
];
