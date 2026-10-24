// Simulator controller: controls, run / step / reset, provenance, step log, output, metrics,
// run history for comparison, and hooks used by the debug and challenge sections.
import { h, clear, fmtValue } from './dom.js';
import { renderBlocks } from './blocks.js';
import { MODES, defaultsOf } from './contract.js';

export function createLab(mod, viz) {
  const sim = mod.sim;
  const defaults = defaultsOf(sim.controls);
  const state = { params: { ...defaults }, result: null, played: 0, timer: null, history: [], runNo: 0, listeners: [] };
  const inputs = {};

  // ---- controls ----
  const controlsEl = h('div.controls');
  for (const c of sim.controls) {
    const id = `ctl-${mod.id}-${c.id}`;
    let input, out = null;
    if (c.type === 'select') input = h('select', { id }, c.options.map(([v, l]) => h('option', { value: v }, l)));
    else if (c.type === 'range') { input = h('input', { id, type: 'range', min: c.min, max: c.max, step: c.step || 1 }); out = h('output', { for: id }); }
    else if (c.type === 'number') input = h('input', { id, type: 'number', min: c.min, max: c.max, step: c.step || 1 });
    else if (c.type === 'toggle') input = h('input', { id, type: 'checkbox', role: 'switch' });
    else if (c.type === 'textarea') input = h('textarea', { id, rows: 4 });
    else input = h('input', { id, type: 'text', spellcheck: 'false' });
    input.addEventListener(c.type === 'select' || c.type === 'toggle' ? 'change' : 'input', () => {
      state.params[c.id] = read(c, input);
      if (out) out.textContent = state.params[c.id];
      paramsChanged();
    });
    inputs[c.id] = { input, out, c };
    controlsEl.appendChild(h(`div.control.control-${c.type}`,
      c.type === 'toggle' ? h('label', { for: id }, input, ' ', c.label) : [h('label', { for: id }, c.label, out ? [' ', out] : null), input],
      c.help ? h('p.help', c.help) : null));
  }

  function read(c, input) {
    if (c.type === 'toggle') return input.checked;
    if (c.type === 'range' || c.type === 'number') return input.value === '' ? c.default : Number(input.value);
    return input.value;
  }
  function write(values) {
    for (const [k, v] of Object.entries(values)) {
      const it = inputs[k];
      if (!it) continue;
      state.params[k] = v;
      if (it.c.type === 'toggle') it.input.checked = !!v; else it.input.value = v;
      if (it.out) it.out.textContent = v;
    }
  }

  // ---- samples + buttons ----
  const sampleSel = h('select', { 'aria-label': 'Load sample input' },
    h('option', { value: '' }, 'Load a sample input…'),
    (sim.samples || []).map((smp, i) => h('option', { value: i }, smp.label)));
  sampleSel.addEventListener('change', () => {
    if (sampleSel.value === '') return;
    api.load(sim.samples[+sampleSel.value].values, true);
    sampleSel.value = '';
  });
  const speedSel = h('select', { 'aria-label': 'Animation speed' }, h('option', { value: 1300 }, 'Normal speed'), h('option', { value: 2600 }, 'Slow'), h('option', { value: 0 }, 'Instant'));
  const runBtn = h('button.btn.primary', { type: 'button', onclick: () => api.run() }, '▶ Run');
  const stepBtn = h('button.btn', { type: 'button', onclick: () => api.step() }, 'Step ›');
  const resetBtn = h('button.btn.ghost', { type: 'button', onclick: () => api.reset() }, 'Reset');

  const mode = MODES[sim.mode] || MODES.local;
  const provenance = h(`div.provenance.tone-${mode.tone}`, h('strong', mode.label), ' — ', mode.text);

  const status = h('p.run-status', { 'aria-live': 'polite' }, 'Not run yet. Choose settings, then Run (all steps) or Step (one at a time).');
  const stepsEl = h('ol.steps');
  const outEl = h('div.sim-output');
  const metricsEl = h('div.metrics');

  const el = h('div.lab',
    provenance,
    h('div.lab-grid',
      h('div.lab-left', h('h4', 'Configuration'), sampleSel, controlsEl, h('div.btn-row', runBtn, stepBtn, resetBtn, speedSel)),
      h('div.lab-right', status, h('h4', 'Execution steps'), stepsEl, metricsEl)),
    h('h4', 'Results'), outEl);

  function paramsChanged() {
    stop();
    viz.setParams({ ...state.params });
    if (state.result) status.textContent = 'Settings changed — run again to see the effect.';
    state.result = null; state.played = 0;
  }

  function compute() {
    try { return sim.run({ ...state.params }); }
    catch (e) { return { steps: [{ node: null, title: 'Simulator error', detail: e.message, status: 'error' }], output: [{ type: 'alert', tone: 'error', text: 'The simulator itself failed: ' + e.message }], metrics: [], summary: 'simulator error' }; }
  }

  function renderStep(st, i) {
    const li = h(`li.step.st-${st.status}`, { tabindex: 0 },
      h('span.step-n', i + 1),
      h('div', h('strong', st.title), st.detail ? h('p.small', st.detail) : null),
      h(`span.chip.tone-${st.status === 'skip' ? 'muted' : st.status}`, st.status));
    li.addEventListener('click', () => st.node && viz.select(st.node));
    li.addEventListener('keydown', e => e.key === 'Enter' && st.node && viz.select(st.node));
    return li;
  }

  function showStep(i) {
    const st = state.result.steps[i];
    stepsEl.appendChild(renderStep(st, i));
    viz.setStep(st);
    status.textContent = `Step ${i + 1} of ${state.result.steps.length}: ${st.title}`;
  }

  function finish() {
    const res = state.result;
    clear(outEl).appendChild(renderBlocks(res.output));
    clear(metricsEl);
    if (res.metrics && res.metrics.length) {
      metricsEl.appendChild(h('h4', 'Measurements'));
      metricsEl.appendChild(h('div.metric-grid', res.metrics.map(m => h('div.metric',
        h('span.metric-label', m.label), h('span.metric-value', m.value),
        h(`span.chip.${m.kind === 'estimate' ? 'tone-warn' : 'tone-info'}`, { title: m.kind === 'estimate' ? 'Illustrative estimate' : 'Computed by this simulator' }, m.kind === 'estimate' ? 'estimate' : 'computed'),
        m.note ? h('span.metric-note', m.note) : null))));
    }
    const errs = res.steps.filter(s => s.status === 'error').length, warns = res.steps.filter(s => s.status === 'warn').length;
    status.textContent = `Run #${state.runNo} finished: ${errs ? errs + ' error(s)' : 'no errors'}${warns ? ', ' + warns + ' warning(s)' : ''}. ${res.summary || ''}`;
    state.history.unshift({ n: state.runNo, params: { ...state.params }, result: res });
    state.history = state.history.slice(0, 8);
    state.listeners.forEach(fn => fn(state.params, res));
  }

  function stop() { if (state.timer) { clearTimeout(state.timer); state.timer = null; } }

  function begin() {
    stop();
    viz.clearRun();
    clear(stepsEl); clear(outEl); clear(metricsEl);
    state.result = compute();
    if (viz.setResult) viz.setResult(state.result);
    state.played = 0;
    state.runNo++;
  }

  const api = {
    el,
    get params() { return state.params; },
    get result() { return state.result; },
    get history() { return state.history; },
    defaults,
    onRun(fn) { state.listeners.push(fn); },
    run() {
      begin();
      const delay = +speedSel.value;
      const tick = () => {
        if (state.played < state.result.steps.length) { showStep(state.played++); state.timer = delay ? setTimeout(tick, delay) : null; if (!delay) tick(); }
        else finish();
      };
      tick();
    },
    step() {
      if (!state.result || state.played >= state.result.steps.length) begin();
      stop();
      showStep(state.played++);
      if (state.played >= state.result.steps.length) finish();
      else status.textContent += ' — press Step for the next stage.';
    },
    reset() {
      stop();
      write(defaults);
      state.result = null; state.played = 0;
      viz.setParams({ ...state.params });
      viz.clearRun();
      clear(stepsEl); clear(outEl); clear(metricsEl);
      status.textContent = 'Reset to default settings.';
    },
    load(values, run = false) {
      write({ ...defaults, ...values });
      paramsChanged();
      if (run) api.run();
    },
    runInstant() { const prev = speedSel.value; speedSel.value = 0; api.run(); speedSel.value = prev; },
    describeParams(p) { return sim.controls.map(c => [c.label, fmtValue(p[c.id])]); },
  };
  write(defaults);
  viz.setParams({ ...state.params });
  return api;
}
