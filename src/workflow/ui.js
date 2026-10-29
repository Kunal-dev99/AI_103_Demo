// Guided Azure workflow player: stepper + form + simulated console + resource tree.
import { h, clear, append } from '../engine/dom.js';

export function createWorkflow(wf, { onComplete } = {}) {
  const outcomes = [];          // outcome per completed step
  const values = [];            // form values per step
  let current = 0;
  let state = {};

  const stepList = h('ol.wf-steps');
  const panel = h('div.wf-panel');
  const consoleEl = h('div.wf-console', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Simulated console' });
  const resEl = h('div.wf-resources');
  const doneEl = h('div.wf-done', { hidden: true });
  const el = h('div.workflow',
    h('div.wf-goal', h('span.overline', 'Goal'), h('p', wf.goal)),
    h('div.wf-grid',
      h('nav.wf-nav', { 'aria-label': 'Workflow steps' }, stepList),
      h('div.wf-main', panel, doneEl),
      h('div.wf-side',
        h('div.wf-box', h('div.wf-box-head', 'Console', h('span.chip.muted', 'simulated')), consoleEl),
        h('div.wf-box', h('div.wf-box-head', 'Your resources'), resEl))));

  function recompute() {
    state = {};
    outcomes.forEach(o => { if (o && o.ok) Object.assign(state, o.set || {}); });
  }

  function drawSteps() {
    clear(stepList);
    wf.steps.forEach((st, i) => {
      const o = outcomes[i];
      const status = i === current ? 'cur' : o && o.ok ? 'done' : o ? 'failed' : i < current ? 'done' : 'todo';
      const reachable = i <= outcomes.filter(x => x && x.ok).length;
      stepList.appendChild(h(`li.wf-step.${status}`,
        h('button', { type: 'button', disabled: !reachable, onclick: () => { current = i; draw(); } },
          h('span.wf-num', o && o.ok && i !== current ? '✓' : String(i + 1)), h('span', st.title))));
    });
  }

  function drawResources() {
    clear(resEl);
    const all = [];
    outcomes.forEach(o => { if (o && o.ok) (o.resources || []).forEach(r => { const k = all.findIndex(x => x.id === r.id); if (k >= 0) all[k] = r; else all.push(r); }); });
    if (!all.length) { resEl.appendChild(h('p.small', 'Nothing created yet.')); return; }
    const tree = h('ul.wf-tree');
    const add = (parent, ul, depth) => all.filter(r => (r.parent || null) === parent).forEach(r => {
      const li = h('li', h('span.wf-rtype', r.type), h('span.wf-rname', r.name), r.meta ? h('span.wf-rmeta', r.meta) : null);
      ul.appendChild(li);
      const kids = h('ul');
      add(r.id, kids, depth + 1);
      if (kids.childNodes.length) li.appendChild(kids);
    });
    add(null, tree, 0);
    resEl.appendChild(tree);
  }

  function printLogs(outcome, title) {
    consoleEl.appendChild(h('div.wf-log-head', `— ${title}`));
    outcome.logs.forEach((l, n) => {
      const line = h(`pre.wf-log.${l.kind}`, { style: `animation-delay:${n * 0.12}s` }, l.kind === 'cmd' ? `$ ${l.text}` : l.text);
      consoleEl.appendChild(line);
    });
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function drawPanel() {
    clear(panel);
    const st = wf.steps[current];
    const vals = { ...Object.fromEntries((st.fields || []).map(f => [f.id, f.default])), ...(values[current] || {}) };
    const form = h('form.wf-form', { onsubmit: e => { e.preventDefault(); submit(); } });
    for (const f of st.fields || []) {
      const id = `wf-${st.id}-${f.id}`;
      let input;
      if (f.type === 'select') input = h('select', { id }, f.options.map(([v, l]) => h('option', { value: v, selected: v === vals[f.id] }, l)));
      else if (f.type === 'toggle') input = h('input', { id, type: 'checkbox', checked: !!vals[f.id] });
      else if (f.type === 'textarea') { input = h('textarea', { id, rows: f.rows || 6, spellcheck: 'false' }); input.value = vals[f.id] ?? ''; }
      else input = h('input', { id, type: 'text', value: vals[f.id] ?? '', spellcheck: 'false' });
      input.dataset.field = f.id;
      form.appendChild(h(`div.wf-field.wf-${f.type}`,
        f.type === 'toggle' ? h('label', { for: id }, input, ' ', f.label) : [h('label', { for: id }, f.label), input],
        f.help ? h('p.help', f.help) : null));
    }
    const msg = h('div.wf-msg', { 'aria-live': 'polite' });
    const o = outcomes[current];
    if (o) msg.appendChild(o.ok
      ? h('div.alert.tone-ok', h('strong', 'Done. '), current < wf.steps.length - 1 ? 'Continue to the next step, or change something here (later steps will reset).' : 'This was the last step.')
      : h('div.alert.tone-error', h('strong', o.error.title + '. '), o.error.fix));
    append(form, [h('div.wf-actions',
      h('button.btn.primary', { type: 'submit' }, st.action || 'Run step'),
      o && o.ok && current < wf.steps.length - 1 ? h('button.btn', { type: 'button', onclick: () => { current++; draw(); } }, 'Next step →') : null,
      st.hint ? h('details.wf-hint', h('summary', 'Hint'), h('p.small', st.hint)) : null), msg]);
    append(panel, [
      h('p.overline', `Step ${current + 1} of ${wf.steps.length}`),
      h('h3', st.title), h('p.wf-why', st.why), form,
      st.docs && st.docs.length ? h('p.small.wf-docs', 'Real-world reference: ', st.docs.map((d, i) => [i ? ' · ' : '', h('a', { href: d.url, target: '_blank', rel: 'noopener' }, d.name)])) : null]);
    panel.querySelector('input, select, textarea')?.focus({ preventScroll: true });

    function submit() {
      const v = {};
      for (const f of st.fields || []) {
        const inp = form.querySelector(`[data-field="${f.id}"]`);
        v[f.id] = f.type === 'toggle' ? inp.checked : inp.value;
        if (f.required && v[f.id] === '') { clear(msg).appendChild(h('div.alert.tone-warn', `Choose: ${f.label}`)); inp.focus(); return; }
      }
      values[current] = v;
      outcomes.length = current; // changing a step resets everything after it
      recompute();
      let res;
      try { res = st.run({ ...state }, v); } catch (e) { res = { ok: false, logs: [{ kind: 'err', text: e.message }], error: { title: 'Simulation error', fix: e.message } }; }
      outcomes[current] = res;
      recompute();
      printLogs(res, st.title);
      if (res.ok && current === wf.steps.length - 1) finish();
      draw();
    }
  }

  function finish() {
    doneEl.hidden = false;
    append(clear(doneEl), [h('div.alert.tone-ok', h('strong', 'Workflow complete. '), wf.goal),
      h('p.small', 'In a real subscription, delete the resource group when you finish to stop charges: ', h('code', `az group delete --name ${state.rg || '<rg>'}`))]);
    if (onComplete) onComplete();
  }

  function draw() { drawSteps(); drawPanel(); drawResources(); if (outcomes.length < wf.steps.length || !outcomes.every(o => o && o.ok)) doneEl.hidden = true; }

  const api = {
    el,
    reset() { outcomes.length = 0; values.length = 0; current = 0; state = {}; clear(consoleEl); doneEl.hidden = true; draw(); },
  };
  clear(consoleEl).appendChild(h('p.small', 'Commands and responses appear here as you complete each step. They are illustrative, not live.'));
  draw();
  return api;
}
