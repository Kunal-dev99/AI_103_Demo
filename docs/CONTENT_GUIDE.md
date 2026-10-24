# Content authoring guide

Every agenda topic (see `src/agenda.js`) has exactly one content module at `content/<id>.js`
and one visual workbench at `src/workbenches/<workbench>.js`.

- The **content module** is plain data plus pure functions: **no DOM access, no network, no imports
  other than `../src/engine/util.js`**. It is also loaded by `tools/validate.mjs` in Node.
  It sets `workbench: '<name>'` and its `run()` result may carry a `view` object with whatever the
  workbench needs to draw.
- The **workbench** is DOM code. `createWorkbench(mod)` returns
  `{ el, setParams(p), setResult(result), setStep(step), clearRun(), reset(), flash(stageId), select(stageId) }`.
  `setParams` runs on every control change (preview the input there), `setResult` at the start of a run,
  `setStep` once per step as the run plays. Reuse `src/workbenches/page.js` helpers. Styles go in `assets/wb-<name>.css`.

The reference implementation is `content/ingestion.js` + `src/workbenches/ingestion.js`.

Run `node tools/validate.mjs <id> [<id> ...]` until it prints ✓.

## Design rules (non-negotiable)

1. **Tailored lab per topic.** Each module defines its own `lab` name (unique across the
   site), its own controls, its own data, and its own `run()` logic modelling *that* concept.
   Do not copy a generic "pipeline with N stages" between modules. Ask: what would an engineer
   actually configure and inspect for this skill? Model that.
2. **Honest provenance.** `sim.mode` is `'local'` (deterministic logic in the browser),
   `'conceptual'` (illustrative values chosen to teach), or `'recorded'` (replayed sample
   response shapes). Never claim or imply a live Azure call. Use phrases like "in this
   simulation" where a behaviour is simplified.
3. **No fabricated precision.** Metrics are either `kind: 'computed'` (a deterministic result of
   your own simulator logic, e.g. "3/5 fields valid") or `kind: 'estimate'` with a `note`
   stating the assumption. Do not invent exact Azure prices, latencies, quotas or limits.
   Prefer relative statements ("higher", "~2× tokens under the 4-chars-per-token heuristic")
   and point to the docs page. If you mention a real limit or price, say it can change and to
   check the docs.
4. **Technically accurate.** Use current Microsoft terminology: Microsoft Foundry (projects,
   hubs are legacy), Foundry Agent Service, Foundry Tools (formerly Azure AI services:
   Azure AI Search, Content Understanding, Document Intelligence, Language, Speech,
   Translator, Vision, Content Safety), Azure OpenAI models in Foundry, Microsoft Entra ID,
   managed identity, `DefaultAzureCredential`, RBAC roles such as "Azure AI User",
   "Cognitive Services OpenAI User", "Search Index Data Reader". Python SDK names:
   `azure-ai-projects` (`AIProjectClient`), `azure-ai-agents`, `azure-ai-inference`,
   `openai` (`AzureOpenAI` / OpenAI client against the Foundry endpoint), `azure-search-documents`,
   `azure-ai-documentintelligence`, `azure-ai-evaluation`, `azure-ai-contentsafety`,
   `azure-cognitiveservices-speech`, `azure-ai-translation-text`. When unsure of an exact
   API signature, keep code illustrative and say so in the node detail.
5. **Deterministic.** Use `rng(seedString)` from util.js, never `Math.random()`, so the same
   inputs always give the same result (needed for compare + challenges).
6. **Learner-facing text** is plain English, concise, no marketing.

## Module shape

```js
import { rng, clamp, round, step, metric, estTokens, overlap, coverage, hasError } from '../src/engine/util.js';

export default {
  id: 'fields',                         // must equal file name and an agenda id
  lab: 'RAG pipeline bench',            // unique name of this topic's simulator
  services: [{ name, url }],            // ≥1, url must start https://learn.microsoft.com/
  workbench: 'fields',                  // src/workbenches/fields.js
  prereqs: ['ingestion'], next: [],     // agenda ids (may be empty)

  concept: {
    plain: '…',        // ≥80 chars, plain-language explanation
    technical: '…',    // ≥80 chars, correct terminology
    useCase: '…',      // ≥80 chars, realistic Azure scenario
    terms: [['Term', 'definition'], …],   // ≥2
  },

  visual: {
    views: {           // all three required; each (params|null) => { nodes, edges }
      conceptual: p => ({ nodes: [...], edges: [...] }),
      architectural: p => ({ … }),       // Azure resources and how they connect
      implementation: p => ({ … }),      // SDK calls / config / code-level view
    },
  },
```

**Views** are called with the current control values (`p`) whenever a control changes, and with
`null` by the validator, so guard `p && …`. Use `p` to make the diagram react to configuration
(change labels, set `disabled: true` on unused nodes, add/remove nodes, show `badge` text).
Node: `{ id, label, col, row, detail, kind?, substeps?, props?, disabled?, badge? }`.
`col`/`row` are grid positions (0-based; about 5 columns × 4 rows fits well; fractional rows allowed).
`kind` ∈ `store | compute | ai | data | app | code | user | policy | external` (styling only).
`substeps` (array of strings) are revealed when the learner expands stages.
`props` (object) is shown in the inspector. Edge: `[fromId, toId, optionalLabel]`.
Step `node` ids in `run()` must exist in at least one view (ideally the same ids across views so
highlights work in every view).

```js
  sim: {
    mode: 'local',                 // 'local' | 'conceptual' | 'recorded'
    controls: [                    // ≥2
      { id, label, type: 'select', options: [[value, label], …], default },
      { id, label, type: 'range', min, max, step, default },
      { id, label, type: 'number', min, max, step, default },
      { id, label, type: 'toggle', default: true },
      { id, label, type: 'text' | 'textarea', default: '…' },
      // optional on any control: help: 'tooltip text'
    ],
    samples: [{ label, values: { …partial control values } }],   // ≥2
    run: p => ({ steps, output, metrics, summary }),
  },
```

`run(p)` receives every control value. It must not throw for any combination of control values.
Return:

- `steps`: ≥3 for default params. `step(nodeId, title, detail, data, status)`; status ∈
  `ok | warn | error | info | skip`. Steps are played one by one in the UI, highlighting the
  node; `data` is shown as JSON in the inspector. An `error` step normally ends the run.
- `output`: array of blocks (see below), ≥1.
- `metrics`: array of `metric(label, valueString, 'computed'|'estimate', note)`.
- `summary`: one line used in the comparison table.

### Output blocks

| type | required keys | optional |
| --- | --- | --- |
| `text` | `text` | `title` |
| `alert` | `tone` (ok/warn/error/info), `text` | |
| `kv` | `items: [[k, v], …]` | `title` |
| `json` | `data` | `title` |
| `code` | `text` | `title`, `lang` |
| `table` | `columns`, `rows` (arrays of strings) | `title`, `tones` (per row), `links` (per row region id for a `doc` block) |
| `bars` | `items: [{ label, value (0..1 or number), max?, note?, tone? }]` | `title`, `threshold` (0..1, draws a line) |
| `doc` | `width`, `height`, `regions: [{ id, x, y, w, h, text, conf?, label?, order?, tone? }]` | `title`, `rotated`, `showBoxes`, `showOrder` |
| `chat` | `turns: [{ role: 'user'|'assistant'|'tool'|'system'|'agent:<name>', text, meta? }]` | `title` |
| `timeline` | `items: [{ label, start, end, tone?, lane? }]` | `title`, `unit` (e.g. 'ms', 's') |
| `grid` | `cols`, `cells: [{ v?, tone?, label? }]` (row-major) | `title`, `caption` (heatmaps, masks, token grids) |
| `flow` | `items: [{ label, tone?, note? }]` | `title` (routing chain / decision path) |
| `diff` | `before`, `after` (strings) | `title` |
| `image` | `shapes: [{ kind: 'rect'|'circle'|'text'|'box'|'line', x, y, w?, h?, r?, x2?, y2?, fill?, label?, tone?, dashed?, text? }]` | `title`, `width` (default 100), `height` (default 70), `background` | 

`image` draws a synthetic scene on a 100×70 canvas (use it for generated images, masks,
detections; `box` is an outlined detection box with a label). `tone` colours: ok, warn, error, info, muted.

```js
  compare: { suggestions: ['Run X with A then B and compare …', …] },  // ≥2

  debug: [   // ≥2 deliberate failure scenarios
    { id, title, values: {…partial control values that cause the failure}, node: 'nodeId',
      symptom: 'what the learner sees', cause: 'why', fix: 'what to change' },
  ],
```

Each debug scenario, run with its `values`, **must** produce at least one `warn` or `error` step.
The UI marks a scenario solved when the learner reruns after loading it and the run has no error
step, so the fix must be achievable through the controls. Cover the relevant failure families:
invalid input, missing fields, malformed data, wrong configuration, permission problems,
unsuitable model choice, downstream integration failure.

```js
  challenge: {
    task: 'what to achieve',
    condition: 'measurable completion condition, in words',
    hint: '…',
    check: (p, result) => boolean,     // must be false for defaults, true for solutionValues
    solution: ['step 1', 'step 2', …], // walkthrough, shown after an attempt
    solutionValues: { … },             // control values that satisfy check
  },
  quiz: [ { q, options: [≥3], answer: index, why }, … ],   // ≥3 scenario-based questions
  recap: '≥60 chars',
};
```

## Checklist before you finish a module

- `node tools/validate.mjs <id>` prints ✓.
- The lab would make sense to an Azure engineer: controls are real knobs (or clearly labelled
  conceptual ones), outputs look like the real artefacts (JSON shapes, traces, tables).
- At least one debug scenario per relevant failure family; fixes reachable via controls.
- Quiz questions are scenario-based ("You need… which…"), not trivia.
