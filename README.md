# Document AI Concept Lab

Interactive workbenches for a focused **Azure AI-103** agenda: how AI reads, structures, extracts,
classifies and understands content. There is one in-depth lab per agenda topic:

| # | Topic | Lab | What you watch happen |
| --- | --- | --- | --- |
| 1 | Document ingestion, OCR and layout analysis | Document ingestion workbench | The page is rotated upright and cleaned; an OCR sweep boxes every word by confidence; layout draws tables, roles, checkboxes and the reading-order path |
| 2 | Structured field extraction | Field extraction studio | Each schema field searches the page, locks onto its evidence, gets validated, and uncertain values drop into a review queue |
| 3 | Document classification and routing | Classification & routing simulator | An inbox of documents is scored, thresholded, split and routed into downstream lanes, with misroutes, reviews and dead-letters |
| 4 | Multimodal content understanding | Multimodal understanding workspace | Documents, images, audio and video are represented, segmented and turned into grounded fields |

The agenda lives in `src/agenda.js`. Each topic maps to the official AI-103 objectives it covers
([Microsoft Learn study guide](https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-103),
*Skills measured as of April 16, 2026*). The **Agenda coverage** page shows that mapping.

> Independent study aid, not affiliated with Microsoft. **Nothing on this site calls Azure.** Every
> run is labelled as a local simulation, a conceptual demonstration or prerecorded sample data.

## Run it

It is a static site with no dependencies and no build step:

```bash
python3 -m http.server 8080      # or: npm start
# open http://localhost:8080
```

`.github/workflows/pages.yml` validates every lab and publishes the site to GitHub Pages on each push to `main`.

## What each topic page contains

| Section | What the learner does |
| --- | --- |
| A. Understand | Plain-language and technical explanations, key terms, a real use case, the AI-103 objectives covered, service docs |
| B–C. Visualize & simulate | The **workbench** shows the actual document, inbox, image, audio or video as each stage runs. Run plays everything; Step advances one stage. Click anything in the workbench to inspect it. Controls, step log, measurements and result tables sit underneath; architecture and code views are in a collapsible panel |
| D. Experiment & compare | Suggested experiments; every run is recorded; diff any two runs |
| E. Debug | Deliberately broken configurations. Load one, see the symptom, fix it with the controls |
| Azure workflow | A guided click-through of the real sequence in Azure — create the Foundry resource, grant a data-plane role, connect model deployments, create or pick the analyzer, call it, read the result — with a simulated console and resource tree. Mistakes fail where they would for real (403, 409, unreadable blob). In the site's own style; nothing is created in Azure |
| F. Apply & assess | A challenge with a checked completion condition, a solution walkthrough after the first attempt, and a scenario quiz |

## Project layout

```
index.html                   entry point
assets/styles.css            shared styles (light + dark)
assets/wb-*.css              per-workbench styles
src/agenda.js                the agenda (topics, stages, AI-103 objective mapping)
src/syllabus.js              official AI-103 outline (objective text for the mapping)
src/workbenches/<id>.js      the visual workbench for each topic (+ page.js shared drawing helpers)
src/engine/                  simulator controller, architecture diagram, output renderers, contract
src/pages/                   home, topic and coverage pages
content/<id>.js              lab logic and content per topic (DOM-free; also run by the validator)
docs/CONTENT_GUIDE.md        authoring contract
tools/validate.mjs           agenda coverage + lab contract validator (Node)
tools/smoke.mjs              browser smoke test (Playwright)
```

## Quality gates

```bash
npm run validate   # every agenda topic has a valid lab
npm run smoke      # opens every page in Chromium and drives every lab, debug scenario, challenge and quiz
```

## Accuracy notes

- Simulators use simplified, deterministic logic, so the same input always gives the same result. They teach
  behaviour and trade-offs. They do not reproduce service internals. Classifiers in particular are demonstrations, not trained models.
- No exact prices, quotas or latencies are presented as facts; numbers are tagged *computed* or *estimate* (with the assumption stated).
- API details that may differ between versions are marked illustrative. Check the linked Microsoft Learn pages.
