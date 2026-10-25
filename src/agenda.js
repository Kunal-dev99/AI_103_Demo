// The learning agenda this site covers. Each agenda topic has one in-depth lab.
// `objectives` traces the topic back to the official AI-103 outline (src/syllabus.js).
// `stages` are the subtopics the lab's workbench lets learners explore one by one.
// `color`/`color2`/`emoji` give each topic its own visual identity across the site.
// `exam` lists what the AI-103 objectives emphasise for this topic: [point, objective id].
import { findSubtopic } from './syllabus.js';

export const AGENDA = [
  {
    id: 'ingestion',
    color: '#4f46e5', color2: '#06b6d4', emoji: '📄',
    title: 'Document ingestion, OCR and layout analysis',
    short: 'Ingestion, OCR & layout',
    summary: 'Upload a document, clean it up, read its text with OCR and recover its structure: tables, headings, reading order.',
    objectives: ['5.2.1', '5.1.4'],
    exam: [
      ['Know what a Content Understanding document analyzer returns: text with confidence and position, layout (tables, checkboxes, roles, reading order) and markdown.', '5.2.1'],
      ['Pick a layout-capable analyzer when tables, checkboxes or columns matter; OCR-only output loses that structure.', '5.2.1'],
      ['In a RAG ingestion flow, OCR comes first: scanned PDFs have no text layer, so without OCR nothing gets indexed.', '5.1.4'],
      ['Expect scenarios about poor input (rotated photos, noisy scans) and about using confidence to decide what needs review.', '5.2.1'],
    ],
    stages: ['Upload and validation', 'Pre-processing (rotation, noise)', 'OCR: lines, words, confidence', 'Layout: tables, roles, reading order', 'Structured output (JSON / markdown)'],
  },
  {
    id: 'fields',
    color: '#db2777', color2: '#8b5cf6', emoji: '🔎',
    title: 'Structured field extraction',
    short: 'Field extraction',
    summary: 'Define a schema, map every field to its evidence on the page, validate it, and send uncertain values to human review.',
    objectives: ['5.2.1', '5.2.3', '4.1.1'],
    exam: [
      ['Design a Content Understanding analyzer field schema: names, types, descriptions, and a method per field (extract, classify with categories, or generate).', '5.2.3'],
      ['Use confidence and grounding (the source location of each value) to drive human review and citations.', '5.2.1'],
      ['Know when a prebuilt model, a custom analyzer, or an LLM with structured JSON output (json_schema) is the right tool.', '4.1.1'],
      ['Structured or markdown output is what downstream reasoning (agents, business systems) consumes.', '5.2.3'],
    ],
    stages: ['Field schema (names, types, required)', 'Evidence mapping (value ↔ source region)', 'Confidence thresholds', 'Validation rules', 'Human review queue'],
  },
  {
    id: 'classification',
    color: '#f97316', color2: '#eab308', emoji: '🗂️',
    title: 'Document classification and routing',
    short: 'Classification & routing',
    summary: 'Classify a mixed inbox of documents, apply thresholds, route each one to the right system and handle ambiguous or failed cases.',
    objectives: ['5.2.3', '3.2.7', '2.3.4'],
    exam: [
      ['Classify with Content Understanding by defining categories with clear descriptions, including an “other” category for documents that fit none.', '5.2.3'],
      ['Combine model scores with rules (confidence threshold, margin, human review): a hybrid of model and rules engine.', '2.3.4'],
      ['Know when a single-task pipeline is enough and when pro mode (several inputs, cross-document checks) is needed.', '3.2.7'],
      ['Return classification results as structured output that downstream workflows and agents can route on.', '5.2.3'],
    ],
    stages: ['Classifier scores per document type', 'Confidence and margin thresholds', 'Splitting multi-document files', 'Routing to downstream systems', 'Manual review, unknowns and failures'],
  },
  {
    id: 'multimodal',
    color: '#059669', color2: '#3b82f6', emoji: '🎬',
    title: 'Multimodal content understanding',
    short: 'Multimodal understanding',
    summary: 'See how documents, images, audio and video are represented, which stages process each one, and how grounded fields come out.',
    objectives: ['3.2.5', '3.2.6', '4.2.3', '5.2.2', '5.1.1'],
    exam: [
      ['Content Understanding has analyzers for documents, images, audio and video; choose the one that matches the input.', '3.2.5'],
      ['Video analysis works on segments (shots, keyframes, transcript); audio on transcripts with speakers and timestamps.', '3.2.6'],
      ['Reason over audio directly when tone, speakers or timing matter, not only over a plain transcript.', '4.2.3'],
      ['Produce grounded markdown/JSON so agents and RAG can cite the exact page region or time range.', '5.2.2'],
      ['Ingest and index documents, images, audio and video so they can be retrieved for grounding.', '5.1.1'],
    ],
    stages: ['Input representation per modality', 'Modality-specific processing stages', 'Segmentation (pages, regions, speaker turns, shots)', 'Grounded field extraction', 'Markdown / JSON for agents and RAG'],
  },
];

export const findAgenda = id => AGENDA.find(a => a.id === id);
export const objectiveText = id => (findSubtopic(id) || {}).text || id;
