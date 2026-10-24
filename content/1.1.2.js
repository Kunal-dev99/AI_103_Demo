// 1.1.2 Choose the appropriate Foundry services for generative tasks, grounding, vector search, agent workflows, or multimodal processing
// Lab: Foundry service mapper.
import { step, metric } from '../src/engine/util.js';

const SERVICES = {
  models: { label: 'Foundry Models (model deployments)', node: 'models', role: 'Generates text, calls tools, produces embeddings.' },
  agent: { label: 'Foundry Agent Service', node: 'agent', role: 'Hosted agent runtime: instructions, conversations/threads, tool-calling loop, built-in tools.' },
  search: { label: 'Azure AI Search', node: 'search', role: 'Keyword, vector, hybrid and semantic retrieval over your indexed content with filters and security trimming.' },
  fileSearch: { label: 'Agent file search tool (vector store)', node: 'filesearch', role: 'Upload files to an agent-managed vector store; quick grounding for a modest set of files.' },
  iq: { label: 'Foundry IQ knowledge base', node: 'iq', role: 'Agent-facing knowledge layer built on Azure AI Search agentic retrieval (query planning over one or more knowledge sources).' },
  cu: { label: 'Content Understanding (Foundry Tools)', node: 'cu', role: 'Turns documents, images, audio and video into structured fields and markdown.' },
  speech: { label: 'Azure Speech (Foundry Tools)', node: 'speech', role: 'Speech to text, text to speech, real-time voice.' },
};

const CHOICE_KEYS = { useModels: 'models', useAgent: 'agent', useSearch: 'search', useFileSearch: 'fileSearch', useIQ: 'iq', useCU: 'cu', useSpeech: 'speech' };

function mapServices(p) {
  const chosen = Object.entries(CHOICE_KEYS).filter(([k]) => p[k]).map(([, v]) => v);
  const has = s => chosen.includes(s);
  const steps = [];
  const rows = [];
  const tones = [];
  const needs = [];
  const add = (need, wanted, verdict, tone, consequence) => { rows.push([need, wanted, verdict, consequence]); tones.push(tone); };

  needs.push(p.needGenerate && 'generate', p.needGrounding && 'ground', p.needAgent && 'agent', p.multimodal !== 'none' && 'multimodal', p.needVoice && 'voice');
  const activeNeeds = needs.filter(Boolean);
  steps.push(step('app', 'Requirements analysed', `Needs: ${activeNeeds.join(', ') || 'none'}. Corpus: ${p.corpus}. Multimodal input: ${p.multimodal}. Chosen services: ${chosen.map(s => SERVICES[s].label).join(', ') || 'none'}.`,
    { needs: activeNeeds, corpus: p.corpus, multimodal: p.multimodal, chosen: chosen.map(s => SERVICES[s].label) }, 'info'));

  const required = new Set();
  // 1. Generation
  if (p.needGenerate || p.needAgent) {
    required.add('models');
    if (has('models')) {
      steps.push(step('models', 'Model deployment present', 'A chat model deployment in the Foundry project generates answers (and drives tool calls for agents).', { required: true }));
      add('Generate answers', SERVICES.models.label, 'Covered', 'ok', '—');
    } else {
      steps.push(step('models', 'No model deployment', 'Nothing can generate text. Agents also need a model deployment to reason and call tools.', { required: true, missing: 'Foundry Models deployment' }, 'error'));
      add('Generate answers', SERVICES.models.label, 'Missing', 'error', 'No generation at all: requests fail or the agent cannot be created.');
    }
  }
  // 2. Agent workflow
  if (p.needAgent) {
    required.add('agent');
    if (has('agent')) {
      steps.push(step('agent', 'Agent runtime present', 'Foundry Agent Service hosts the agent, stores conversations and runs the tool-calling loop.', { required: true }));
      add('Multi-step actions with tools', SERVICES.agent.label, 'Covered', 'ok', '—');
    } else {
      steps.push(step('agent', 'No agent runtime', 'You would hand-build conversation storage, the tool-call loop, retries and tracing around a bare model deployment.', { required: true, missing: 'Foundry Agent Service' }, 'warn'));
      add('Multi-step actions with tools', SERVICES.agent.label, 'Missing', 'warn', 'Possible with your own orchestration code, but you rebuild what the managed runtime provides.');
    }
  }
  // 3. Grounding / vector search
  if (p.needGrounding) {
    const large = p.corpus === 'large';
    if (has('fileSearch') && !has('agent')) {
      steps.push(step('filesearch', 'File search without an agent', 'The file search tool is an Agent Service tool: it has nothing to attach to without an agent.', { tool: 'file_search', requires: 'Foundry Agent Service' }, 'error'));
      add('Ground answers in documents', SERVICES.fileSearch.label, 'Misconfigured', 'error', 'Tool cannot be attached: there is no agent.');
    }
    if (has('iq') && !has('search')) {
      steps.push(step('iq', 'Knowledge base without a search service', 'In this simulation a Foundry IQ knowledge base is backed by Azure AI Search (agentic retrieval); with no search service there is nothing to query.', { requires: 'Azure AI Search' }, 'error'));
      add('Ground answers in documents', SERVICES.iq.label, 'Misconfigured', 'error', 'Knowledge base has no retrieval engine behind it.');
    }
    const searchOk = has('search') || (has('iq') && has('search'));
    const fileOk = has('fileSearch') && has('agent');
    if (large) {
      required.add('search');
      if (searchOk) {
        steps.push(step('search', 'Scalable retrieval present', `Azure AI Search${has('iq') ? ' (exposed to agents through a Foundry IQ knowledge base)' : ''} handles a large, changing corpus: indexers or push API, hybrid + semantic ranking, filters, document-level security.`, { corpus: 'large', retrieval: has('iq') ? 'knowledge base → Azure AI Search' : 'Azure AI Search' }));
        add('Ground answers in a large corpus', has('iq') ? `${SERVICES.iq.label} + ${SERVICES.search.label}` : SERVICES.search.label, 'Covered', 'ok', '—');
      } else if (fileOk) {
        steps.push(step('search', 'File search used for a large corpus', 'Agent file search is convenient but gives you little control over chunking, ranking, filters, incremental indexing or per-user security trimming, and vector stores have size limits (check the docs). At this scale use Azure AI Search.', { corpus: 'large', retrieval: 'file_search' }, 'warn'));
        add('Ground answers in a large corpus', SERVICES.search.label, 'Weak fit', 'warn', 'Hard to keep fresh, tune or secure at scale.');
      } else {
        steps.push(step('search', 'No retrieval service', 'The model answers from its training data only: no citations, likely fabrications about your content.', { corpus: 'large', retrieval: null }, 'error'));
        add('Ground answers in a large corpus', SERVICES.search.label, 'Missing', 'error', 'Ungrounded answers; no citations.');
      }
    } else if (searchOk || fileOk) {
      steps.push(step(fileOk && !searchOk ? 'filesearch' : 'search', 'Retrieval present', fileOk && !searchOk ? 'A small, slowly changing file set: agent file search is the quickest grounding option.' : 'Azure AI Search works for a small corpus too; more setup than file search but more control.', { corpus: 'small', retrieval: fileOk && !searchOk ? 'file_search' : 'Azure AI Search' }));
      add('Ground answers in a small document set', fileOk && !searchOk ? SERVICES.fileSearch.label : SERVICES.search.label, 'Covered', 'ok', '—');
    } else {
      steps.push(step('search', 'No retrieval service', 'Nothing retrieves your documents, so answers cannot be grounded or cited.', { corpus: 'small', retrieval: null }, 'error'));
      add('Ground answers in a small document set', `${SERVICES.fileSearch.label} or ${SERVICES.search.label}`, 'Missing', 'error', 'Ungrounded answers; no citations.');
    }
    required.add(large ? 'search' : (has('fileSearch') ? 'fileSearch' : 'search'));
    if (has('iq')) required.add('iq');
    if (fileOk) required.add('fileSearch');
  }
  // 4. Multimodal processing
  if (p.multimodal !== 'none') {
    if (p.multimodal === 'images') {
      steps.push(step('cu', 'Images: multimodal model is enough', 'Questions about photos can go straight to a vision-capable chat model. Content Understanding helps when you need consistent structured fields from many images.', { input: 'images' }, has('cu') ? 'ok' : 'info'));
      add('Understand images', 'Vision-capable model (Content Understanding optional)', has('models') ? 'Covered' : 'Missing', has('models') ? 'ok' : 'error', has('models') ? '—' : 'No model to look at the images.');
      if (has('cu')) required.add('cu');
    } else {
      required.add('cu');
      if (has('cu')) {
        steps.push(step('cu', 'Content Understanding present', p.multimodal === 'documents' ? 'Analyzers extract layout, tables and typed fields with confidence from forms and contracts.' : 'Analyzers segment audio/video, transcribe and extract fields per segment so the model works on clean, timestamped text.', { input: p.multimodal }));
        add(p.multimodal === 'documents' ? 'Extract fields from forms' : 'Process audio / video', SERVICES.cu.label, 'Covered', 'ok', '—');
      } else if (p.multimodal === 'documents') {
        steps.push(step('cu', 'Documents sent raw to the model', 'A vision model can read pages, but you lose layout fidelity, per-field confidence and bounding regions, and pay per token for every page.', { input: 'documents' }, 'warn'));
        add('Extract fields from forms', SERVICES.cu.label, 'Weak fit', 'warn', 'No confidence scores for a review queue; higher token cost.');
      } else {
        steps.push(step('cu', 'No pipeline for audio/video', 'Hours of recordings cannot be pasted into a chat prompt. You need transcription and segmentation first.', { input: 'audio/video' }, 'error'));
        add('Process audio / video', SERVICES.cu.label, 'Missing', 'error', 'Recordings are never analysed.');
      }
    }
  }
  // 5. Voice
  if (p.needVoice) {
    required.add('speech');
    if (has('speech')) {
      steps.push(step('speech', 'Speech present', 'Speech to text in, text to speech out (or a real-time voice API) around the agent.', { required: true }));
      add('Talk to users by voice', SERVICES.speech.label, 'Covered', 'ok', '—');
    } else {
      steps.push(step('speech', 'No speech service', 'Users speak but nothing converts audio to text or replies with audio.', { required: true, missing: 'Azure Speech' }, 'error'));
      add('Talk to users by voice', SERVICES.speech.label, 'Missing', 'error', 'Voice channel does not work.');
    }
  }
  // 6. Extras
  const extras = chosen.filter(s => !required.has(s));
  for (const s of extras) {
    steps.push(step(SERVICES[s].node, `${SERVICES[s].label}: not needed`, 'Nothing in the requirements uses this service: extra cost, identities and network rules to manage.', { required: false }, 'warn'));
    add('(none)', SERVICES[s].label, 'Unnecessary', 'warn', 'Extra cost and operational surface.');
  }
  const errors = steps.filter(s => s.status === 'error').length;
  const warns = steps.filter(s => s.status === 'warn').length;
  steps.push(step('app', errors ? 'Architecture will fail' : warns ? 'Architecture works with caveats' : 'Architecture fits the requirements',
    `${rows.filter((r, i) => tones[i] === 'ok').length} need(s) covered, ${errors} blocking gap(s), ${warns} caveat(s).`, { required: [...required].map(s => SERVICES[s].label), extras: extras.map(s => SERVICES[s].label) }, errors ? 'error' : warns ? 'warn' : 'ok'));

  const flow = [{ label: 'User', note: p.needVoice ? 'voice' : 'text' }];
  if (p.needVoice) flow.push({ label: 'Speech to text', tone: has('speech') ? 'ok' : 'error' });
  if (p.needAgent) flow.push({ label: 'Agent Service', tone: has('agent') ? 'ok' : 'warn' });
  if (p.needGrounding) flow.push({ label: has('iq') ? 'Foundry IQ → AI Search' : has('search') ? 'Azure AI Search' : has('fileSearch') ? 'File search' : 'No retrieval', tone: tones.some(t => t === 'error') && !has('search') && !has('fileSearch') ? 'error' : 'ok' });
  if (p.multimodal === 'documents' || p.multimodal === 'av') flow.push({ label: 'Content Understanding', tone: has('cu') ? 'ok' : p.multimodal === 'av' ? 'error' : 'warn', note: 'ingestion path' });
  flow.push({ label: 'Model deployment', tone: has('models') ? 'ok' : 'error' });
  if (p.needVoice) flow.push({ label: 'Text to speech', tone: has('speech') ? 'ok' : 'error' });

  return {
    steps,
    output: [
      { type: 'table', title: 'Requirement → service map', columns: ['Need', 'Right service', 'Your design', 'Consequence if wrong'], rows, tones },
      { type: 'flow', title: 'Request path in your design', items: flow },
      { type: 'alert', tone: errors ? 'error' : warns ? 'warn' : 'ok', text: errors ? 'At least one requirement has no working service. Fix the red rows first.' : warns ? 'The design runs, but some choices are weak fits or add unused services.' : 'Every requirement maps to an appropriate service and nothing is redundant.' },
    ],
    metrics: [
      metric('Needs covered', `${rows.filter((r, i) => tones[i] === 'ok').length}/${rows.filter(r => r[0] !== '(none)').length}`, 'computed'),
      metric('Blocking gaps', String(errors), 'computed'),
      metric('Unneeded services', String(extras.length), 'computed'),
    ],
    summary: `${chosen.length} service(s): ${errors} gap(s), ${warns} caveat(s)`,
  };
}

const svcNode = (p, key, base) => ({ ...base, disabled: p ? !p[key] : false, badge: p && p[key] ? 'chosen' : undefined });

export default {
  id: '1.1.2',
  lab: 'Foundry service mapper',
  services: [
    { name: 'What is Microsoft Foundry?', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/what-is-azure-ai-foundry' },
    { name: 'Foundry Agent Service overview', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview' },
    { name: 'Azure AI Search overview', url: 'https://learn.microsoft.com/en-us/azure/search/search-what-is-azure-search' },
    { name: 'Content Understanding in Foundry Tools', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/overview' },
  ],
  prereqs: ['1.1.1'],
  next: ['1.1.3', '1.1.4', '1.2.1'],

  concept: {
    plain: 'An AI app is usually several services working together: a model that writes the answer, something that finds the right documents, a runtime that lets an agent take actions, and converters that turn speech, video or forms into text the model can use. Picking the wrong piece, or missing one, shows up as made-up answers, a voice channel that does not work, or an agent with nowhere to run.',
    technical: 'In Microsoft Foundry: Foundry Models provide chat, reasoning and embedding deployments; Foundry Agent Service hosts agents (instructions, conversations, tool-calling loop, built-in tools such as file search, code interpreter, Azure AI Search, Bing grounding, OpenAPI, MCP); Azure AI Search provides keyword, vector, hybrid and semantic retrieval at scale; Foundry IQ exposes knowledge bases built on Azure AI Search agentic retrieval to agents; Foundry Tools such as Content Understanding, Document Intelligence and Speech handle multimodal processing. Map each requirement to the service designed for it and avoid services nothing uses.',
    useCase: 'An insurer builds a claims assistant: customers phone in (Speech), the agent looks up policy wording across 300k documents (Azure AI Search via a knowledge base), reads uploaded damage photos and claim forms (Content Understanding), and opens a claim through an API tool (Agent Service + a model deployment).',
    terms: [
      ['Foundry Agent Service', 'Managed runtime for agents: instructions, model deployment, tools, conversation state, tracing.'],
      ['Grounding', 'Supplying retrieved, authoritative content to the model so answers are based on it and can cite it.'],
      ['File search tool', 'Agent tool that indexes uploaded files into a managed vector store; quick but limited control.'],
      ['Foundry IQ', 'Knowledge bases for agents built on Azure AI Search agentic retrieval.'],
      ['Content Understanding', 'Foundry Tool that converts documents, images, audio and video into structured fields and markdown.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'app', label: 'Requirements', col: 0, row: 1.5, kind: 'user', detail: 'Generate? Ground? Act with tools? Multimodal input? Voice?' },
          svcNode(p, 'useModels', { id: 'models', label: 'Generate → model', col: 2, row: 0, kind: 'ai', detail: SERVICES.models.role }),
          svcNode(p, 'useAgent', { id: 'agent', label: 'Act → agent runtime', col: 2, row: 1, kind: 'compute', detail: SERVICES.agent.role }),
          svcNode(p, 'useSearch', { id: 'search', label: 'Ground at scale → search', col: 2, row: 2, kind: 'store', detail: SERVICES.search.role }),
          svcNode(p, 'useFileSearch', { id: 'filesearch', label: 'Ground (small) → file search', col: 3, row: 2, kind: 'store', detail: SERVICES.fileSearch.role }),
          svcNode(p, 'useIQ', { id: 'iq', label: 'Knowledge base → Foundry IQ', col: 3, row: 1, kind: 'data', detail: SERVICES.iq.role }),
          svcNode(p, 'useCU', { id: 'cu', label: 'Forms / AV → Content Understanding', col: 2, row: 3, kind: 'ai', detail: SERVICES.cu.role }),
          svcNode(p, 'useSpeech', { id: 'speech', label: 'Voice → Speech', col: 1, row: 3, kind: 'ai', detail: SERVICES.speech.role }),
        ],
        edges: [['app', 'models', 'generate'], ['app', 'agent', 'act'], ['app', 'search', 'ground'], ['app', 'cu', 'multimodal'], ['app', 'speech', 'voice'], ['agent', 'filesearch'], ['iq', 'search']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'app', label: 'Client app (web / phone)', col: 0, row: 1.5, kind: 'app', detail: 'Calls the agent or model endpoint with Entra ID credentials.' },
          svcNode(p, 'useSpeech', { id: 'speech', label: 'Speech', col: 1, row: 3, kind: 'ai', detail: 'Converts audio in/out around the conversation.' }),
          svcNode(p, 'useAgent', { id: 'agent', label: 'Foundry project: Agent Service', col: 1, row: 1, kind: 'compute', detail: 'Agent definition references a model deployment and tools.' }),
          svcNode(p, 'useModels', { id: 'models', label: 'Foundry project: model deployments', col: 2, row: 0, kind: 'ai', detail: 'Chat + embedding deployments.' }),
          svcNode(p, 'useFileSearch', { id: 'filesearch', label: 'Agent vector store', col: 2, row: 2, kind: 'store', detail: 'Managed by Agent Service for file search.' }),
          svcNode(p, 'useIQ', { id: 'iq', label: 'Foundry IQ knowledge base', col: 2, row: 1, kind: 'data', detail: 'Agent-facing knowledge source with agentic retrieval.' }),
          svcNode(p, 'useSearch', { id: 'search', label: 'Azure AI Search', col: 3, row: 1, kind: 'store', detail: 'Index with vector + text fields; semantic ranker.' }),
          svcNode(p, 'useCU', { id: 'cu', label: 'Content Understanding', col: 3, row: 3, kind: 'ai', detail: 'Analyzers process incoming files into markdown/fields before indexing.' }),
          { id: 'data', label: 'Blob Storage (source docs, media)', col: 4, row: 2, kind: 'store', detail: 'Where originals live; feeds indexing and analyzers.' },
        ],
        edges: [['app', 'speech', 'audio'], ['app', 'agent', 'messages'], ['agent', 'models', 'inference'], ['agent', 'filesearch', 'file_search'], ['agent', 'iq', 'knowledge'], ['iq', 'search', 'agentic retrieval'], ['data', 'cu', 'analyze'], ['cu', 'search', 'index'], ['data', 'search', 'indexer']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'app', label: 'project = AIProjectClient(endpoint, DefaultAzureCredential())', col: 0, row: 0, kind: 'code', detail: 'One project client is the entry point for agents and deployments (azure-ai-projects).' },
          svcNode(p, 'useModels', { id: 'models', label: 'openai = project.get_openai_client(); openai.responses.create(model=DEPLOYMENT, ...)', col: 0, row: 1, kind: 'code', detail: 'Illustrative: model calls go to a deployment name. Check the current SDK reference for exact method names.' }),
          svcNode(p, 'useAgent', { id: 'agent', label: 'agent = project.agents.create_agent(model=DEPLOYMENT, instructions=..., tools=[...])', col: 0, row: 2, kind: 'code', detail: 'Illustrative Agent Service call; tool definitions attach file search, Azure AI Search, OpenAPI, MCP, etc.' }),
          svcNode(p, 'useSearch', { id: 'search', label: 'SearchClient(endpoint, index, credential).search(text, vector_queries=[...])', col: 0, row: 3, kind: 'code', detail: 'azure-search-documents: direct hybrid query from app code.' }),
          svcNode(p, 'useCU', { id: 'cu', label: 'POST {endpoint}/contentunderstanding/analyzers/{id}:analyze', col: 0, row: 4, kind: 'code', detail: 'Illustrative REST shape for running a Content Understanding analyzer.' }),
          svcNode(p, 'useSpeech', { id: 'speech', label: 'speechsdk.SpeechRecognizer(...) / SpeechSynthesizer(...)', col: 0, row: 5, kind: 'code', detail: 'azure-cognitiveservices-speech.' }),
        ],
        edges: [['app', 'models'], ['app', 'agent'], ['agent', 'search'], ['app', 'cu'], ['app', 'speech']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'needGenerate', label: 'Need: generate natural-language answers', type: 'toggle', default: true },
      { id: 'needGrounding', label: 'Need: answers grounded in company documents', type: 'toggle', default: true },
      { id: 'corpus', label: 'Corpus', type: 'select', options: [['small', 'Small (a few dozen files, rarely changes)'], ['large', 'Large (100k+ docs, daily changes, per-user access)']], default: 'small' },
      { id: 'needAgent', label: 'Need: multi-step actions with tools', type: 'toggle', default: false },
      { id: 'multimodal', label: 'Need: multimodal input', type: 'select', options: [['none', 'None'], ['images', 'Photos (ask questions about them)'], ['documents', 'Forms / contracts (extract fields)'], ['av', 'Audio / video recordings']], default: 'none' },
      { id: 'needVoice', label: 'Need: voice conversation', type: 'toggle', default: false },
      { id: 'useModels', label: 'Use: Foundry Models deployment', type: 'toggle', default: true },
      { id: 'useAgent', label: 'Use: Foundry Agent Service', type: 'toggle', default: false },
      { id: 'useSearch', label: 'Use: Azure AI Search', type: 'toggle', default: true },
      { id: 'useFileSearch', label: 'Use: agent file search tool', type: 'toggle', default: false },
      { id: 'useIQ', label: 'Use: Foundry IQ knowledge base', type: 'toggle', default: false },
      { id: 'useCU', label: 'Use: Content Understanding', type: 'toggle', default: false },
      { id: 'useSpeech', label: 'Use: Azure Speech', type: 'toggle', default: false },
    ],
    samples: [
      { label: 'HR policy bot (small corpus)', values: { needAgent: true, useAgent: true, useFileSearch: true, useSearch: false, corpus: 'small' } },
      { label: 'Enterprise knowledge agent', values: { needAgent: true, corpus: 'large', useAgent: true, useSearch: true, useIQ: true, useFileSearch: false } },
      { label: 'Claims intake (forms)', values: { multimodal: 'documents', useCU: true, useSearch: true, useFileSearch: false } },
      { label: 'Over-engineered FAQ', values: { corpus: 'small', useSearch: true, useFileSearch: false, useCU: true, useSpeech: true } },
    ],
    run: mapServices,
  },

  compare: {
    suggestions: [
      'Large corpus: run once with only the agent file search tool, then with Azure AI Search, and compare the warnings.',
      'Forms input: run with and without Content Understanding and compare the consequence column.',
      'Turn on voice and agent needs, then add services one at a time until the run is clean.',
    ],
  },

  debug: [
    { id: 'filesearch-no-agent', title: 'File search tool cannot be attached', values: { useAgent: false, useFileSearch: true, useSearch: false, needAgent: false }, node: 'filesearch',
      symptom: 'Error: "File search without an agent".', cause: 'File search is a Foundry Agent Service tool; a bare model deployment has no tools runtime.', fix: 'Turn on Foundry Agent Service, or switch grounding to Azure AI Search.' },
    { id: 'scale', title: 'Answers miss recent documents at scale', values: { corpus: 'large', needAgent: true, useAgent: true, useFileSearch: true, useSearch: false }, node: 'search',
      symptom: 'Warning: file search used for a large corpus.', cause: 'Vector stores behind file search are not designed for 100k+ changing documents with filters and per-user security.', fix: 'Use Azure AI Search (optionally via a Foundry IQ knowledge base) and turn off file search.' },
    { id: 'voice', title: 'Phone channel is silent', values: { needVoice: true, useSpeech: false }, node: 'speech',
      symptom: 'Error: no speech service.', cause: 'Nothing converts the caller\'s audio to text or the reply to audio.', fix: 'Turn on Azure Speech.' },
    { id: 'iq-no-search', title: 'Knowledge base returns nothing', values: { corpus: 'large', needAgent: true, useAgent: true, useIQ: true, useSearch: false, useFileSearch: false }, node: 'iq',
      symptom: 'Error: knowledge base without a search service.', cause: 'Foundry IQ knowledge bases are built on Azure AI Search; there is no index to retrieve from.', fix: 'Add Azure AI Search.' },
    { id: 'no-model', title: 'Agent creation fails', values: { needAgent: true, useAgent: true, useModels: false }, node: 'models',
      symptom: 'Error: no model deployment.', cause: 'An agent definition must reference a model deployment that reasons and calls tools.', fix: 'Turn on Foundry Models deployment.' },
    { id: 'video', title: 'Training videos never get indexed', values: { multimodal: 'av', useCU: false }, node: 'cu',
      symptom: 'Error: no pipeline for audio/video.', cause: 'Recordings must be transcribed and segmented before a model or index can use them.', fix: 'Turn on Content Understanding.' },
  ],

  challenge: {
    task: 'Design the minimal correct stack for a voice-enabled support agent that books repairs through tools and answers from 200k service manuals that change daily.',
    condition: 'Needs: generate, grounding, large corpus, agent actions, voice. Run has no warnings or errors (no gaps, no unnecessary services).',
    hint: 'Each need maps to exactly one service family. File search is the wrong scale; an unused service counts as a warning.',
    check: (p, res) => p.needGenerate && p.needGrounding && p.corpus === 'large' && p.needAgent && p.needVoice && !res.steps.some(s => s.status === 'error' || s.status === 'warn'),
    solution: ['Set needs: generate, grounding, corpus Large, agent actions, voice; multimodal None.', 'Use: Foundry Models, Foundry Agent Service, Azure AI Search, Azure Speech.', 'Turn off file search; Foundry IQ is optional (on only with Search).', 'Run: every row green.'],
    solutionValues: { needGenerate: true, needGrounding: true, corpus: 'large', needAgent: true, multimodal: 'none', needVoice: true, useModels: true, useAgent: true, useSearch: true, useFileSearch: false, useIQ: false, useCU: false, useSpeech: true },
  },

  quiz: [
    { q: 'An agent must answer from 500,000 SharePoint-sourced documents that change daily, honouring per-user permissions. Which retrieval service fits?', options: ['Agent file search tool', 'Azure AI Search (optionally through a Foundry IQ knowledge base)', 'A larger model context window', 'Azure Translator'], answer: 1, why: 'Azure AI Search provides indexing at scale, incremental updates, filters and security trimming; knowledge bases expose it to agents.' },
    { q: 'You need an assistant that remembers the conversation, calls an order API and grounds on a dozen PDFs, with minimal code. What is the best fit?', options: ['A model deployment only', 'Foundry Agent Service with file search and an OpenAPI tool', 'Azure AI Search only', 'Content Understanding'], answer: 1, why: 'Agent Service supplies conversation state and the tool loop; file search suits a small file set; OpenAPI tools call the order API.' },
    { q: 'Hours of recorded training sessions must become searchable, timestamped segments. Which service should process them before indexing?', options: ['Content Understanding', 'An embedding model alone', 'Bing grounding', 'Key Vault'], answer: 0, why: 'Content Understanding analyzers transcribe and segment audio/video into structured, timestamped output that can then be indexed.' },
  ],

  recap: 'Map each requirement to the service built for it: model deployments generate, Agent Service runs tool-using agents, file search grounds small file sets, Azure AI Search (and Foundry IQ knowledge bases on top of it) grounds large corpora, Content Understanding processes forms and media, Speech handles voice. Missing pieces cause failures; unused pieces cost money.',
};
