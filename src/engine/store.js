// Learner progress, kept only in this browser. Every access is guarded because
// storage can be unavailable (private mode, blocked site data); the site works without it.
const KEY = 'ai103-lab-progress-v1';
let memory = {};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || memory; } catch { return memory; }
}
function save(data) {
  memory = data;
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* in-memory only */ }
}

export function getProgress(id) {
  return load()[id] || {};
}

export function setProgress(id, patch) {
  const all = load();
  all[id] = { ...(all[id] || {}), ...patch };
  save(all);
  window.dispatchEvent(new CustomEvent('progress', { detail: { id } }));
}

export function allProgress() { return load(); }

export function resetAll() { save({}); window.dispatchEvent(new CustomEvent('progress', { detail: {} })); }

// A subtopic counts as complete when the challenge is done, the quiz is fully answered
// with ≥ 2/3 correct, and at least one debug scenario is solved.
export function isComplete(p) {
  return !!(p.challenge && p.quizTotal && p.quizCorrect / p.quizTotal >= 2 / 3 && (p.debugSolved || []).length);
}
