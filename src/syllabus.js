// Source of truth for the AI-103 syllabus hierarchy.
// Text below is copied verbatim from the official Microsoft Learn study guide,
// section "Skills measured as of April 16, 2026".
// To update for a new outline: edit this file, then run `npm run validate`.
// The validator reports any subtopic without a content module (and any orphan module).

export const SOURCE = {
  exam: 'AI-103: Developing AI Apps and Agents on Azure',
  certification: 'Microsoft Certified: Azure AI Apps and Agents Developer Associate',
  url: 'https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/ai-103',
  outlineVersion: 'Skills measured as of April 16, 2026',
  verifiedOn: '2026-10-24',
  passingScore: '700 / 1000',
};

const D = (id, title, weight, topics) => ({ id, title, weight, topics });
const T = (id, title, subtopics) => ({ id, title, subtopics });
const S = (id, text) => ({ id, text });

export const DOMAINS = [
  D('1', 'Plan and manage an Azure AI solution', '25–30%', [
    T('1.1', 'Choose the appropriate Foundry services for generative AI and agents', [
      S('1.1.1', 'Choose an appropriate model for each task, including large language models (LLMs), small language models, multimodal models, and Foundry Tools'),
      S('1.1.2', 'Choose the appropriate Foundry services for generative tasks, grounding, vector search, agent workflows, or multimodal processing'),
      S('1.1.3', 'Choose an appropriate method for retrieval and indexing'),
      S('1.1.4', 'Choose appropriate memory, tool, and knowledge integration services for agent solutions'),
    ]),
    T('1.2', 'Set up AI solutions in Foundry', [
      S('1.2.1', 'Design Azure infrastructure for AI apps and agent-based solutions'),
      S('1.2.2', 'Choose appropriate deployment options'),
      S('1.2.3', 'Configure model and agent deployments'),
      S('1.2.4', 'Integrate Foundry projects with continuous integration and continuous deployment (CI/CD) pipelines'),
    ]),
    T('1.3', 'Manage, monitor, and secure AI systems', [
      S('1.3.1', 'Manage quotas, scaling, rate limits, and cost footprints for model and agent workloads'),
      S('1.3.2', 'Monitor model performance, drift, safety events, and grounding quality'),
      S('1.3.3', 'Monitor data ingestion quality, search index health, and relevance performance'),
      S('1.3.4', 'Configure security, including managed identity, private networking, keyless credentials, and role policies'),
    ]),
    T('1.4', 'Implement responsible AI across generative AI and agentic systems', [
      S('1.4.1', 'Configure safety filters, guardrails, risk detection, and content moderation'),
      S('1.4.2', 'Apply responsible AI instrumentation, including evaluators, safety evaluations, and explanation tooling'),
      S('1.4.3', 'Implement auditing through trace logging, provenance metadata, and approval workflows'),
      S('1.4.4', 'Govern agent behavior with oversight modes, constraints, and tool-access controls'),
    ]),
  ]),
  D('2', 'Implement generative AI and agentic solutions', '30–35%', [
    T('2.1', 'Build generative applications by using Foundry', [
      S('2.1.1', 'Deploy and consume LLMs, small models, code models, and multimodal models'),
      S('2.1.2', 'Implement retrieval-augmented generation (RAG) in an application'),
      S('2.1.3', 'Design workflows, tool-augmented flows, and multistep reasoning pipelines'),
      S('2.1.4', 'Evaluate models and apps, including detecting fabrications, relevance, quality, and safety'),
      S('2.1.5', 'Integrate generative workflows into applications by using Foundry SDKs and connectors'),
      S('2.1.6', 'Configure an application to connect to a Foundry project'),
    ]),
    T('2.2', 'Build agents by using Foundry', [
      S('2.2.1', 'Define agent roles, goals, conversation-tracking approach, and tool schemas'),
      S('2.2.2', 'Build agents that integrate retrieval, function-calling, and conversation memory'),
      S('2.2.3', 'Integrate agent tools, including APIs, knowledge stores, search, content understanding, and custom functions'),
      S('2.2.4', 'Implement orchestrated multi-agent solutions'),
      S('2.2.5', 'Build autonomous or semiautonomous workflows with safeguards and approval flow controls'),
      S('2.2.6', 'Integrate monitoring into deployed agents, evaluate agent behavior, and perform error analysis'),
    ]),
    T('2.3', 'Optimize and operationalize generative AI systems', [
      S('2.3.1', 'Tune generation behavior, such as prompt engineering and adjusting model parameters'),
      S('2.3.2', 'Implement model reflection, chain-of-thought evaluations, and self-critique loops'),
      S('2.3.3', 'Set up observability by implementing tracing, token analytics, safety signals, and latency breakdowns'),
      S('2.3.4', 'Orchestrate multiple models, flows, or hybrid LLM and rules engines'),
    ]),
  ]),
  D('3', 'Implement computer vision solutions', '10–15%', [
    T('3.1', 'Design and implement image- and video-generation solutions', [
      S('3.1.1', 'Implement a solution that generates images from text prompts and reference media'),
      S('3.1.2', 'Implement a solution that generates videos from text prompts and reference media'),
      S('3.1.3', 'Configure image-editing workflows, including inpainting, mask‑based edits, and prompt‑driven modifications'),
      S('3.1.4', 'Implement workflows to edit generated videos'),
      S('3.1.5', 'Select and apply appropriate generation and editing controls provided by the platform'),
    ]),
    T('3.2', 'Design and implement multimodal understanding workflows', [
      S('3.2.1', 'Build a solution that analyzes visual context by using multimodal models'),
      S('3.2.2', 'Configure apps to produce concise or detailed captions for single or multiple images'),
      S('3.2.3', 'Implement a solution that enables question‑answering grounded in visual evidence'),
      S('3.2.4', 'Configure generation of alt‑text and extended image descriptions aligned to accessibility guidelines'),
      S('3.2.5', 'Implement visual understanding by configuring Azure Content Understanding in Foundry Tools to extract visual characteristics'),
      S('3.2.6', 'Implement video analysis workflows to process and interpret video segments'),
      S('3.2.7', 'Configure single‑task and pro‑mode Content Understanding pipelines'),
      S('3.2.8', 'Implement solutions that identify objects, components, or regions within images or video'),
    ]),
    T('3.3', 'Implement responsible AI for multimodal content', [
      S('3.3.1', 'Implement filters to classify unsafe or disallowed visual content'),
      S('3.3.2', 'Detect and mitigate indirect prompt injection by using embedded text in images'),
      S('3.3.3', 'Enforce visual policy rules, such as applying watermarks, flagging prohibited symbols, upholding brand usage requirements, and detecting potentially inappropriate content'),
    ]),
  ]),
  D('4', 'Implement text analysis solutions', '10–15%', [
    T('4.1', 'Apply language model text analysis', [
      S('4.1.1', 'Implement solutions to extract entities, topics, summaries, and structured JSON outputs by using generative prompting and Foundry Tools'),
      S('4.1.2', 'Configure detection of sentiment, tone, safety issues, and sensitive content'),
      S('4.1.3', 'Build solutions that translate text by using Azure Translator in Foundry Tools or LLM‑powered translation flows'),
      S('4.1.4', 'Customize language model outputs for domain tasks, such as compliance summarization and domain extraction'),
    ]),
    T('4.2', 'Implement speech solutions', [
      S('4.2.1', 'Implement workflows to convert speech to text and text to speech for agentic interactions'),
      S('4.2.2', 'Integrate speech as an agent modality, including custom speech models'),
      S('4.2.3', 'Enable multimodal reasoning from audio inputs'),
      S('4.2.4', 'Translate speech into other languages by using language models and Foundry Tools'),
    ]),
  ]),
  D('5', 'Implement information extraction solutions', '10–15%', [
    T('5.1', 'Build retrieval and grounding pipelines', [
      S('5.1.1', 'Ingest and index content, such as documents, images, audio, and video'),
      S('5.1.2', 'Configure semantic search, hybrid search, and vector search for grounding'),
      S('5.1.3', 'Implement enrichment by using custom or built-in skills for text, images, and layout'),
      S('5.1.4', 'Configure RAG ingestion flow, including documents and using optical character recognition (OCR)'),
      S('5.1.5', 'Connect retrieval pipelines directly to workflows and agent tools'),
    ]),
    T('5.2', 'Extract content from documents', [
      S('5.2.1', 'Extract information by using multimodal pipelines that combine OCR, layout analysis, and field extraction'),
      S('5.2.2', 'Produce clean, grounded representations to use with agents and RAG by using Content Understanding'),
      S('5.2.3', 'Implement analyzers for generating structured or markdown outputs for downstream reasoning by using Content Understanding'),
    ]),
  ]),
];

// Flattened lookup helpers.
export const ALL_SUBTOPICS = DOMAINS.flatMap(d => d.topics.flatMap(t => t.subtopics.map(s => ({ ...s, topic: t, domain: d }))));
export const ALL_TOPICS = DOMAINS.flatMap(d => d.topics.map(t => ({ ...t, domain: d })));
export const findSubtopic = id => ALL_SUBTOPICS.find(s => s.id === id);
export const findTopic = id => ALL_TOPICS.find(t => t.id === id);
export const findDomain = id => DOMAINS.find(d => d.id === id);
