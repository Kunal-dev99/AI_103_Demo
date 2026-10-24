# AI-103 Concept Lab

Interactive concept visualizers and simulators for **every objective** of Microsoft exam
**AI-103: Developing AI Apps and Agents on Azure** (certification: Azure AI Apps and Agents
Developer Associate).

Syllabus source: [Microsoft Learn study guide for AI-103](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-103),
section *Skills measured as of April 16, 2026* (checked 2026-10-24). It has 5 domains, 13 topics
and 64 objectives. Each objective has its own lab.

> Independent study aid, not affiliated with Microsoft. **Nothing on this site calls Azure.**
> Every simulator shows whether its results are a conceptual demonstration, a local
> simulation, or prerecorded sample data.

## Run it

It is a static site with no dependencies and no build step. Serve the folder with any static file server
(ES modules don't load from `file://`):

```bash
python3 -m http.server 8080      # or: npm start
# open http://localhost:8080
```

It deploys as-is to GitHub Pages, Azure Static Web Apps or any CDN.

## What every objective page contains

| Section | What the learner does |
| --- | --- |
| A. Understand | Plain-language and technical explanations, key terms, a real Azure use case, prerequisites, service docs |
| B. Visualize | Interactive diagram with **conceptual / architecture / implementation** views. Select nodes to inspect them, expand internal stages, watch data flow during a run, reset. The diagram updates when configuration changes |
| C. Simulate | Lab-specific controls and sample inputs. **Run** plays every step, **Step** advances one stage at a time. Inspect step data, outputs (JSON, tables, documents with bounding boxes, chat/agent traces, timelines, synthetic images, grids) and measurements tagged *computed* or *estimate* |
| D. Experiment & compare | Suggested experiments; every run is recorded; diff any two runs (changed settings, measurements, outcome, steps) |
| E. Debug | Deliberately broken configurations (invalid input, missing fields, malformed data, wrong config, permissions, unsuitable model, downstream failure). Load one, see the symptom and highlighted component, fix it. Solved when the rerun has no errors |
| F. Apply & assess | Mini-challenge with a machine-checked completion condition, a solution walkthrough that unlocks after the first attempt, and a scenario-based quiz |
| Recap | Summary and links to prerequisite and follow-on objectives |

Progress is stored in the browser's localStorage only. The **Syllabus coverage** page is
a traceability matrix: domain → topic → objective → lab → views / simulator mode / debug
scenarios / challenge / quiz / services.

## Project layout

```
index.html                 entry point
assets/styles.css          styles (light + dark)
src/syllabus.js            official outline: the single source of truth for coverage
src/app.js                 hash router
src/pages/                 home, domain, topic, coverage, objective pages
src/engine/                visualizer, simulator controller, output-block renderers, contract, utilities
content/<objectiveId>.js   one lab module per objective (64 files)
docs/CONTENT_GUIDE.md      authoring contract for lab modules
tools/validate.mjs         contract + coverage validator (Node)
tools/smoke.mjs            browser smoke test (Playwright)
```

## Quality gates

```bash
npm run validate   # every syllabus objective has a module; every module meets the contract
npm run smoke      # opens every page in Chromium, runs every lab, debug scenario, challenge solution and quiz
```

`validate` checks, for each objective: three diagram views with valid nodes/edges; at least two
controls and samples; `run()` works for defaults, every sample and every debug scenario; every
debug scenario actually produces a warning or error; the challenge is **not** complete with
defaults and **is** complete with its solution; estimates state their assumptions; there are
at least 3 quiz questions with valid answers; doc links point to learn.microsoft.com; lab names are
unique across the site.

## Updating when the official outline changes

1. Edit `src/syllabus.js` (keep IDs as `domain.topic.objective`, update `SOURCE.outlineVersion` and `verifiedOn`).
2. Run `npm run validate`. It lists every objective without a module (**MISSING**) and every module no longer in the outline (**orphan**).
3. Add or retire modules in `content/` following `docs/CONTENT_GUIDE.md`; rerun validation and the smoke test.

## Accuracy notes

- Simulators use simplified, deterministic logic (seeded randomness), so the same input always gives the
  same result. They teach behaviour and trade-offs. They do not reproduce service internals.
- No exact prices, quotas or latencies are presented as facts. Where a number appears it is either
  computed by the simulator's own logic or labelled as an estimate with its assumption. Check the linked
  Microsoft Learn pages for current limits and pricing.
- Azure product names change often (e.g. Azure AI Foundry → Microsoft Foundry, Azure AI services → Foundry Tools).
  Labs use the names in the current study guide.
- **Live Azure calls:** the provenance system includes a `live` mode, but no lab in this build uses it. Adding one
  would require a backend that holds credentials. Never put keys in browser code.
