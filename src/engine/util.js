// Pure helpers shared by the engine and by content modules.
// No DOM access here: content modules (and therefore this file) are also loaded by tools/validate.mjs in Node.

// Deterministic 32-bit string hash (FNV-1a). Used so simulations are reproducible:
// the same inputs always produce the same simulated output.
export function hash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Seeded PRNG (mulberry32). rng(seed)() -> float in [0, 1).
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash(seed);
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
export const pct = v => `${Math.round(v * 100)}%`;
export const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// Rough token estimate. This is a heuristic (~4 characters per English token),
// not a tokenizer. Always label results derived from it as estimates.
export const estTokens = text => Math.max(1, Math.ceil(String(text || '').length / 4));

// Lowercased word list without punctuation, for toy keyword matching.
export const words = text => String(text || '').toLowerCase().match(/[a-z0-9À-ɏ']+/g) || [];

// Jaccard overlap between two texts' word sets (0..1). Used by toy relevance scorers.
export function overlap(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

// Share of query words found in a text (0..1).
export function coverage(query, text) {
  const q = [...new Set(words(query))].filter(w => w.length > 2);
  if (!q.length) return 0;
  const T = new Set(words(text));
  return q.filter(w => T.has(w)).length / q.length;
}

// Build a simulator step. status: 'ok' | 'warn' | 'error' | 'info' | 'skip'.
export const step = (node, title, detail, data, status = 'ok') => ({ node, title, detail, data, status });

// Build a metric. kind: 'computed' (deterministic result of the simulator's own logic)
// or 'estimate' (illustrative, must give an assumption).
export const metric = (label, value, kind = 'computed', note = '') => ({ label, value, kind, note });

// Shorthand for "did this run contain an error step?"
export const hasError = result => !!(result && result.steps && result.steps.some(s => s.status === 'error'));
export const hasWarn = result => !!(result && result.steps && result.steps.some(s => s.status === 'warn'));
export const lastStatus = result => (result && result.steps && result.steps.length ? result.steps[result.steps.length - 1].status : null);
