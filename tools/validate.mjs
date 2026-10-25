// Validates agenda coverage and every lab module's contract.
// Usage: node tools/validate.mjs [agendaId ...]
// With no arguments, checks every topic in src/agenda.js and fails on gaps or orphans.
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AGENDA, findAgenda } from '../src/agenda.js';
import { findSubtopic } from '../src/syllabus.js';
import { BLOCK_SCHEMAS, MODES, defaultsOf } from '../src/engine/contract.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const contentDir = path.join(root, 'content');
const only = process.argv.slice(2);
const targets = only.length ? only : AGENDA.map(a => a.id);

const problems = [];
const warn = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);

if (!only.length) {
  const files = readdirSync(contentDir).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
  for (const f of files) if (!findAgenda(f)) fail(f, 'orphan content module (not in src/agenda.js)');
  for (const a of AGENDA) for (const o of a.objectives) if (!findSubtopic(o)) fail(a.id, `agenda maps to unknown AI-103 objective ${o}`);
}

const labs = new Map();

function checkView(id, name, fn, params) {
  let v;
  try { v = fn(params); } catch (e) { fail(id, `visual.views.${name}(${params ? 'params' : 'null'}) threw: ${e.message}`); return []; }
  if (!v || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) { fail(id, `visual.views.${name} must return {nodes, edges}`); return []; }
  if (v.nodes.length < 3) fail(id, `visual.views.${name} needs at least 3 nodes`);
  const ids = new Set();
  for (const n of v.nodes) {
    if (!n.id || !n.label || typeof n.col !== 'number' || typeof n.row !== 'number') fail(id, `visual.views.${name} node missing id/label/col/row: ${JSON.stringify(n).slice(0, 80)}`);
    if (!n.detail) fail(id, `visual.views.${name} node ${n.id} has no detail`);
    if (ids.has(n.id)) fail(id, `visual.views.${name} duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const e of v.edges) if (!ids.has(e[0]) || !ids.has(e[1])) fail(id, `visual.views.${name} edge ${e[0]}->${e[1]} references unknown node`);
  return [...ids];
}

function checkBlocks(id, where, blocks) {
  if (!Array.isArray(blocks) || !blocks.length) { fail(id, `${where}: output must be a non-empty array of blocks`); return; }
  for (const b of blocks) {
    const schema = BLOCK_SCHEMAS[b && b.type];
    if (!schema) { fail(id, `${where}: unknown block type ${b && b.type}`); continue; }
    for (const k of schema) if (b[k] === undefined) fail(id, `${where}: block ${b.type} missing "${k}"`);
  }
}

function checkResult(id, where, res, nodeIds) {
  if (!res || !Array.isArray(res.steps) || !res.steps.length) { fail(id, `${where}: run() must return steps[]`); return; }
  for (const s of res.steps) {
    if (!s.title || !s.status) fail(id, `${where}: step missing title/status`);
    if (!['ok', 'warn', 'error', 'info', 'skip'].includes(s.status)) fail(id, `${where}: bad step status ${s.status}`);
    if (s.node && !nodeIds.has(s.node)) fail(id, `${where}: step node "${s.node}" not in any view`);
  }
  checkBlocks(id, where, res.output);
  if (!Array.isArray(res.metrics)) fail(id, `${where}: metrics must be an array`);
  else for (const m of res.metrics) {
    if (!['computed', 'estimate'].includes(m.kind)) fail(id, `${where}: metric ${m.label} has bad kind ${m.kind}`);
    if (m.kind === 'estimate' && !m.note) fail(id, `${where}: estimate metric "${m.label}" must state its assumption in note`);
  }
  if (typeof res.summary !== 'string' || !res.summary) fail(id, `${where}: summary string required`);
  try {
    const json = JSON.stringify({ ...res, steps: res.steps.map(s => ({ ...s })) });
    if (/NaN|undefined/.test(json.replace(/"[^"]*"/g, '""'))) fail(id, `${where}: result contains NaN`);
  } catch (e) { fail(id, `${where}: result not serialisable: ${e.message}`); }
}

for (const id of targets) {
  const file = path.join(contentDir, `${id}.js`);
  if (!existsSync(file)) { fail(id, 'MISSING content module'); continue; }
  let m;
  try { m = (await import(pathToFileURL(file).href)).default; } catch (e) { fail(id, `import failed: ${e.stack.split('\n').slice(0, 3).join(' | ')}`); continue; }
  if (!m || m.id !== id) { fail(id, `default export id must be "${id}"`); continue; }
  if (!m.lab) fail(id, 'lab (simulator name) required');
  else if (labs.has(m.lab)) fail(id, `lab name "${m.lab}" duplicates ${labs.get(m.lab)}: every subtopic needs its own lab`);
  else labs.set(m.lab, id);
  if (!Array.isArray(m.services) || !m.services.length || m.services.some(s => !s.name || !/^https:\/\/learn\.microsoft\.com\//.test(s.url))) fail(id, 'services[] with name + learn.microsoft.com url required');
  for (const k of ['prereqs', 'next']) for (const r of m[k] || []) if (!findAgenda(r)) fail(id, `${k} references unknown agenda topic ${r}`);
  if (!m.workbench || !existsSync(path.join(root, 'src', 'workbenches', `${m.workbench}.js`))) fail(id, `workbench "${m.workbench}" needs src/workbenches/<name>.js`);
  const c = m.concept || {};
  for (const k of ['plain', 'technical', 'useCase']) if (!c[k] || c[k].length < 80) fail(id, `concept.${k} missing or too short`);
  if (!Array.isArray(c.terms) || c.terms.length < 2) fail(id, 'concept.terms needs at least 2 [term, definition] pairs');

  const sim = m.sim || {};
  if (!MODES[sim.mode]) fail(id, `sim.mode must be one of ${Object.keys(MODES).join(', ')}`);
  if (!Array.isArray(sim.controls) || sim.controls.length < 2) fail(id, 'sim.controls needs at least 2 controls');
  for (const ctl of sim.controls || []) {
    if (!ctl.id || !ctl.label || !['select', 'range', 'toggle', 'text', 'textarea', 'number'].includes(ctl.type)) fail(id, `bad control ${JSON.stringify(ctl).slice(0, 80)}`);
    if (ctl.default === undefined) fail(id, `control ${ctl.id} needs a default`);
    if (ctl.type === 'select' && !(ctl.options || []).some(o => o[0] === ctl.default)) fail(id, `control ${ctl.id} default not among options`);
  }
  if (typeof sim.run !== 'function') { fail(id, 'sim.run must be a function'); continue; }
  const defaults = defaultsOf(sim.controls || []);

  const views = (m.visual && m.visual.views) || {};
  const nodeIds = new Set();
  for (const v of ['conceptual', 'architectural', 'implementation']) {
    if (typeof views[v] !== 'function') { fail(id, `visual.views.${v} must be a function (params) => {nodes, edges}`); continue; }
    checkView(id, v, views[v], null);
    checkView(id, v, views[v], defaults).forEach(n => nodeIds.add(n));
  }

  const run = (values, where) => {
    try { const r = sim.run({ ...defaults, ...values }); checkResult(id, where, r, nodeIds); return r; }
    catch (e) { fail(id, `${where}: run threw ${e.stack.split('\n').slice(0, 2).join(' | ')}`); return null; }
  };
  const base = run({}, 'run(defaults)');
  if (base && base.steps.length < 3) fail(id, 'run(defaults) should expose at least 3 steps');
  for (const [i, s] of (sim.samples || []).entries()) run(s.values, `sample[${i}] "${s.label}"`);
  if (!sim.samples || sim.samples.length < 2) fail(id, 'sim.samples needs at least 2 sample inputs');

  if (!m.compare || !Array.isArray(m.compare.suggestions) || m.compare.suggestions.length < 2) fail(id, 'compare.suggestions needs at least 2 experiments');

  if (!Array.isArray(m.debug) || m.debug.length < 2) fail(id, 'debug needs at least 2 failure scenarios');
  for (const d of m.debug || []) {
    for (const k of ['id', 'title', 'symptom', 'cause', 'fix', 'node']) if (!d[k]) fail(id, `debug ${d.id || '?'} missing ${k}`);
    if (d.node && !nodeIds.has(d.node)) fail(id, `debug ${d.id} node ${d.node} not in any view`);
    const r = run(d.values || {}, `debug "${d.id}"`);
    if (r && !r.steps.some(s => s.status === 'error' || s.status === 'warn')) fail(id, `debug "${d.id}" scenario does not produce a warn/error step`);
  }

  const ch = m.challenge || {};
  for (const k of ['task', 'condition', 'hint']) if (!ch[k]) fail(id, `challenge.${k} required`);
  if (typeof ch.check !== 'function') fail(id, 'challenge.check(params, result) required');
  if (!Array.isArray(ch.solution) || !ch.solution.length) fail(id, 'challenge.solution steps required');
  if (!ch.solutionValues) fail(id, 'challenge.solutionValues required');
  if (typeof ch.check === 'function' && ch.solutionValues) {
    const pv = { ...defaults, ...ch.solutionValues };
    const r = run(ch.solutionValues, 'challenge solution');
    if (r) { try { if (!ch.check(pv, r)) fail(id, 'challenge.check is false for solutionValues'); } catch (e) { fail(id, `challenge.check threw: ${e.message}`); } }
    if (base) { try { if (ch.check(defaults, base)) fail(id, 'challenge is already complete with default settings'); } catch (e) { fail(id, `challenge.check(defaults) threw: ${e.message}`); } }
  }

  if (!Array.isArray(m.quiz) || m.quiz.length < 3) fail(id, 'quiz needs at least 3 questions');
  for (const [i, q] of (m.quiz || []).entries()) {
    if (!q.q || !Array.isArray(q.options) || q.options.length < 3 || typeof q.answer !== 'number' || !q.options[q.answer] || !q.why) fail(id, `quiz[${i}] malformed`);
  }
  if (!m.recap || m.recap.length < 60) fail(id, 'recap missing or too short');

  // Exam-style scenarios: each option runs in the lab; exactly one is correct and runs without errors;
  // wrong options must show a visible problem (warn/error) unless they explain why with cleanButWrong.
  if (!Array.isArray(m.scenarios) || m.scenarios.length < 4) fail(id, 'scenarios needs at least 4 exam-style scenarios');
  for (const sc of m.scenarios || []) {
    for (const k of ['id', 'title', 'stem', 'question', 'objective']) if (!sc[k]) fail(id, `scenario ${sc.id || '?'} missing ${k}`);
    if (sc.objective && !findSubtopic(sc.objective)) fail(id, `scenario ${sc.id} objective ${sc.objective} not in syllabus`);
    if (!Array.isArray(sc.options) || sc.options.length < 3) { fail(id, `scenario ${sc.id} needs at least 3 options`); continue; }
    if (sc.options.filter(o => o.correct).length !== 1) fail(id, `scenario ${sc.id} needs exactly one correct option`);
    for (const [oi, o] of sc.options.entries()) {
      if (!o.label || !o.why || !o.values) fail(id, `scenario ${sc.id} option ${oi} needs label, why, values`);
      const r = run(o.values || {}, `scenario ${sc.id} option ${oi}`);
      if (!r) continue;
      const bad = r.steps.some(st => st.status === 'error' || st.status === 'warn');
      if (o.correct && r.steps.some(st => st.status === 'error')) fail(id, `scenario ${sc.id}: correct option produces an error step`);
      if (!o.correct && !bad && !o.cleanButWrong) fail(id, `scenario ${sc.id} option ${oi}: wrong option runs clean; make the failure visible or set cleanButWrong`);
    }
  }
}

if (warn.length) console.log(warn.join('\n'));
if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):\n` + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`✓ ${targets.length} lab module(s) valid${only.length ? '' : ` — all ${AGENDA.length} agenda topics covered`}.`);
