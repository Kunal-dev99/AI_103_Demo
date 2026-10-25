// The learning agenda this site covers. Each agenda topic has one in-depth lab.
// `objectives` traces the topic back to the official AI-103 outline (src/syllabus.js).
// `stages` are the subtopics the lab's workbench lets learners explore one by one.
// `color`/`color2`/`emoji` give each topic its own visual identity across the site.
import { findSubtopic } from './syllabus.js';

export const AGENDA = [
  {
    id: 'ingestion',
    color: '#4f46e5', color2: '#06b6d4', emoji: '📄',
    title: 'Document ingestion, OCR and layout analysis',
    short: 'Ingestion, OCR & layout',
    summary: 'Upload a document, clean it up, read its text with OCR and recover its structure: tables, headings, reading order.',
    objectives: ['5.2.1', '5.1.4'],
    stages: ['Upload and validation', 'Pre-processing (rotation, noise)', 'OCR: lines, words, confidence', 'Layout: tables, roles, reading order', 'Structured output (JSON / markdown)'],
  },
  {
    id: 'fields',
    color: '#db2777', color2: '#8b5cf6', emoji: '🔎',
    title: 'Structured field extraction',
    short: 'Field extraction',
    summary: 'Define a schema, map every field to its evidence on the page, validate it, and send uncertain values to human review.',
    objectives: ['5.2.1', '5.2.3', '4.1.1'],
    stages: ['Field schema (names, types, required)', 'Evidence mapping (value ↔ source region)', 'Confidence thresholds', 'Validation rules', 'Human review queue'],
  },
  {
    id: 'classification',
    color: '#f97316', color2: '#eab308', emoji: '🗂️',
    title: 'Document classification and routing',
    short: 'Classification & routing',
    summary: 'Classify a mixed inbox of documents, apply thresholds, route each one to the right system and handle ambiguous or failed cases.',
    objectives: ['5.2.3', '3.2.7', '2.3.4'],
    stages: ['Classifier scores per document type', 'Confidence and margin thresholds', 'Splitting multi-document files', 'Routing to downstream systems', 'Manual review, unknowns and failures'],
  },
  {
    id: 'multimodal',
    color: '#059669', color2: '#3b82f6', emoji: '🎬',
    title: 'Multimodal content understanding',
    short: 'Multimodal understanding',
    summary: 'See how documents, images, audio and video are represented, which stages process each one, and how grounded fields come out.',
    objectives: ['3.2.5', '3.2.6', '4.2.3', '5.2.2', '5.1.1'],
    stages: ['Input representation per modality', 'Modality-specific processing stages', 'Segmentation (pages, regions, speaker turns, shots)', 'Grounded field extraction', 'Markdown / JSON for agents and RAG'],
  },
];

export const findAgenda = id => AGENDA.find(a => a.id === id);
export const objectiveText = id => (findSubtopic(id) || {}).text || id;
