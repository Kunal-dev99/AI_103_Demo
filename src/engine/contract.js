// Shared contract between content modules, the renderer and tools/validate.mjs. DOM-free.

// Where a simulator's results come from. Shown as a badge on every run so mocked
// results are never mistaken for live Azure responses.
export const MODES = {
  conceptual: { label: 'Conceptual demonstration', tone: 'info', text: 'Illustrates the idea. Values are chosen to teach the concept, not computed from a model.' },
  local: { label: 'Local simulation', tone: 'warn', text: 'Computed in your browser by simplified, deterministic logic. No Azure service is called.' },
  recorded: { label: 'Prerecorded sample data', tone: 'muted', text: 'Replays representative response shapes written for this lab. Not a live response.' },
  live: { label: 'Live Azure call', tone: 'ok', text: 'Response returned by a real Azure endpoint you configured.' },
};

// Required keys per output block type (rendered by src/engine/blocks.js).
export const BLOCK_SCHEMAS = {
  text: ['text'],
  alert: ['tone', 'text'],
  kv: ['items'],
  json: ['data'],
  code: ['text'],
  table: ['columns', 'rows'],
  bars: ['items'],
  doc: ['width', 'height', 'regions'],
  chat: ['turns'],
  timeline: ['items'],
  grid: ['cols', 'cells'],
  flow: ['items'],
  diff: ['before', 'after'],
  image: ['shapes'],
};

export const defaultsOf = controls => Object.fromEntries(controls.map(c => [c.id, c.default]));
