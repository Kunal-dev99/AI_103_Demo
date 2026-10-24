// 1.2.4 Integrate Foundry projects with CI/CD pipelines
// Lab: Foundry CI/CD pipeline simulator.
import { rng, round, step, metric } from '../src/engine/util.js';

const CHANGES = {
  prompt: { label: 'Prompt / agent instructions change', evaluated: true, roleAssignment: false },
  model: { label: 'Model version bump (deployment update)', evaluated: true, roleAssignment: false },
  infra: { label: 'Bicep: add Azure AI Search connection + role assignment', evaluated: false, roleAssignment: true },
  app: { label: 'App code only (API bug fix)', evaluated: false, roleAssignment: false },
};

const ROLES = {
  contributor: { label: 'Contributor on the resource group', write: true, rbac: false, broad: false },
  contribRbac: { label: 'Contributor + Role Based Access Control Administrator (constrained)', write: true, rbac: true, broad: false },
  owner: { label: 'Owner on the subscription', write: true, rbac: true, broad: true },
  reader: { label: 'Reader', write: false, rbac: false, broad: false },
};

const DATASET_ROWS = 50;

function pipeline(p) {
  const steps = [];
  const ch = CHANGES[p.change];
  const role = ROLES[p.role];
  const r = rng(`${p.change}|${p.quality}`);
  const gates = [];
  const times = [];
  let clock = 0;
  const stage = (label, mins, tone, lane) => { times.push({ label, start: clock, end: clock + mins, tone, lane }); clock += mins; };
  const gh = p.platform === 'github';
  let halted = false;
  const halt = () => { halted = true; };

  steps.push(step('trigger', 'Pipeline triggered', `${gh ? 'GitHub Actions workflow' : 'Azure Pipelines run'} on merge to main: ${ch.label}.`, { platform: p.platform, change: p.change, target: p.target }, 'info'));
  stage('checkout', 1, 'ok', 'build');

  // Lint / validate
  steps.push(step('lint', 'Lint and validate', 'Python lint, Bicep build (bicep build / lint), and schema validation of the agent definition YAML (instructions, model deployment name, tools).', { checks: ['ruff', 'bicep lint', 'agent.yaml schema'] }));
  stage('lint', 2, 'ok', 'build'); gates.push(['Lint / validate', 'pass', 'ok']);

  // Unit tests
  if (!p.testsPass) {
    steps.push(step('unit', 'Unit tests failed', '3 of 120 tests failed (tool output parser). The pipeline stops: nothing is deployed.', { failed: 3, total: 120 }, 'error'));
    stage('unit tests', 4, 'error', 'build'); gates.push(['Unit tests', 'fail', 'error']); halt();
  } else {
    steps.push(step('unit', 'Unit tests passed', 'Tool functions, prompt templates and parsers tested with mocked model responses (no live model calls in unit tests).', { passed: 120 }));
    stage('unit tests', 4, 'ok', 'build'); gates.push(['Unit tests', 'pass', 'ok']);
  }

  // Azure login
  if (!halted) {
    if (p.auth === 'none') {
      steps.push(step('login', 'Azure login failed', 'No credentials configured for the pipeline identity.', { error: 'No subscription found / not logged in' }, 'error'));
      stage('azure login', 1, 'error', 'deploy'); gates.push(['Azure login', 'fail', 'error']); halt();
    } else if (p.auth === 'oidc' && p.subject === 'mismatch') {
      steps.push(step('login', 'OIDC token exchange rejected', `AADSTS70021: No matching federated identity record found for presented assertion. The workflow presented subject "repo:contoso/support-agent:${gh ? 'ref:refs/heads/main' : 'sc://contoso/support/prod-conn'}" but the federated credential expects "${gh ? 'repo:contoso/support-agent:environment:prod' : 'sc://contoso/support/dev-conn'}".`, { code: 'AADSTS70021', fix: 'Match the federated credential subject to the branch/environment (GitHub) or service connection (Azure DevOps).' }, 'error'));
      stage('azure login', 1, 'error', 'deploy'); gates.push(['Azure login (OIDC)', 'fail', 'error']); halt();
    } else if (p.auth === 'secret') {
      steps.push(step('login', 'Logged in with a client secret', 'Works, but a long-lived secret is stored in the CI system: it can leak, must be rotated, and expires. Prefer workload identity federation (OIDC): no secret at all.', { method: 'service principal + client secret' }, 'warn'));
      stage('azure login', 1, 'warn', 'deploy'); gates.push(['Azure login', 'pass (secret)', 'warn']);
    } else {
      steps.push(step('login', 'Logged in with workload identity federation', gh ? 'azure/login exchanged the GitHub OIDC token for an Entra ID token (permissions: id-token: write). No stored secret.' : 'The Azure Resource Manager service connection uses workload identity federation. No stored secret.', { method: 'OIDC federated credential' }));
      stage('azure login', 1, 'ok', 'deploy'); gates.push(['Azure login (OIDC)', 'pass', 'ok']);
    }
  }

  // IaC
  if (!halted) {
    if (!role.write) {
      steps.push(step('iac', 'Bicep deployment forbidden', 'AuthorizationFailed: the pipeline identity (Reader) cannot write Microsoft.Resources/deployments.', { code: 'AuthorizationFailed', role: role.label }, 'error'));
      stage('bicep deploy (dev)', 2, 'error', 'deploy'); gates.push(['IaC deploy', 'fail', 'error']); halt();
    } else if (ch.roleAssignment && !role.rbac) {
      steps.push(step('iac', 'Role assignment in template forbidden', 'The template assigns "Search Index Data Reader" to the project identity. Contributor cannot write Microsoft.Authorization/roleAssignments.', { code: 'AuthorizationFailed', action: 'Microsoft.Authorization/roleAssignments/write' }, 'error'));
      stage('bicep deploy (dev)', 3, 'error', 'deploy'); gates.push(['IaC deploy', 'fail', 'error']); halt();
    } else {
      const notes = [];
      let status = 'ok';
      if (role.broad) { notes.push('Owner on the subscription is far more than this pipeline needs: scope roles to the resource group and constrain role-assignment rights.'); status = 'warn'; }
      if (p.change === 'infra' && !p.whatIf) { notes.push('Infra change deployed without a what-if preview: reviewers never saw what would be modified or deleted.'); status = 'warn'; }
      steps.push(step('iac', status === 'ok' ? 'Infrastructure deployed to dev' : 'Infrastructure deployed with caveats', `az deployment group ${p.whatIf ? 'what-if, then create' : 'create'} with main.bicep + dev.bicepparam. ${notes.join(' ') || 'Idempotent: unchanged resources are left as they are.'}`, { whatIf: p.whatIf, role: role.label, changes: p.change === 'infra' ? ['+ connection: search', '+ roleAssignment: Search Index Data Reader'] : p.change === 'model' ? ['~ deployment chat: version'] : [] }, status));
      stage('bicep deploy (dev)', p.whatIf ? 5 : 3, status, 'deploy'); gates.push(['IaC deploy (dev)', status === 'ok' ? 'pass' : 'pass with caveats', status]);
    }
  }

  // Deploy app + agent to dev
  if (!halted) {
    steps.push(step('dev', 'App and agent deployed to dev', 'Container image pushed and rolled out; agent definition created/updated in the dev Foundry project from agent.yaml, referencing the dev deployment name.', { environment: 'dev', agentVersion: `returns-assistant@${(r() * 1000).toFixed(0)}` }));
    stage('deploy dev', 3, 'ok', 'deploy');
  }

  // Evaluation gate
  let score = null;
  let regressionShipped = false;
  if (!halted) {
    const base = { prompt: p.quality === 'improved' ? 0.88 : 0.7, model: p.quality === 'improved' ? 0.86 : 0.72, infra: 0.85, app: 0.85 }[p.change];
    score = round(base + (r() - 0.5) * 0.04, 2);
    const passed = Math.round(score * DATASET_ROWS);
    const below = score < p.threshold;
    if (!p.evalGate) {
      steps.push(step('eval', 'No evaluation gate', `Batch evaluation ran (groundedness pass rate ${score}) but nothing blocks the pipeline on the result.${below ? ' This change is a regression and will continue to the next stage.' : ''}`, { groundedness: score, threshold: null }, 'warn'));
      stage('evaluation', 6, 'warn', 'quality'); gates.push(['Evaluation gate', 'not enforced', 'warn']);
      regressionShipped = below;
    } else if (below) {
      steps.push(step('eval', 'Evaluation gate failed', `Groundedness pass rate ${score} (${passed}/${DATASET_ROWS} rows) is below the threshold ${p.threshold}. ${p.quality === 'regressed' && ch.evaluated ? 'The new prompt/model answers without citing retrieved policy text.' : 'The threshold may be stricter than the current baseline can reach; set it from a measured baseline.'}`, { evaluators: ['groundedness', 'relevance', 'coherence'], groundedness: score, threshold: p.threshold, dataset: `${DATASET_ROWS} rows` }, 'error'));
      stage('evaluation', 6, 'error', 'quality'); gates.push(['Evaluation gate', `fail (${score} < ${p.threshold})`, 'error']); halt();
    } else {
      steps.push(step('eval', 'Evaluation gate passed', `Groundedness pass rate ${score} (${passed}/${DATASET_ROWS} rows) ≥ ${p.threshold}. Relevance and coherence within baseline.`, { groundedness: score, threshold: p.threshold }));
      stage('evaluation', 6, 'ok', 'quality'); gates.push(['Evaluation gate', `pass (${score})`, 'ok']);
    }
  }

  // Test environment
  if (!halted) {
    steps.push(step('test', 'Promoted to test', 'Same artifacts (image digest, agent.yaml, Bicep) deployed with test.bicepparam; integration tests call the agent end to end.', { environment: 'test', integrationTests: 'passed' }));
    stage('deploy test', 4, 'ok', 'deploy');
  }

  // Approval + prod
  if (!halted && p.target === 'prod') {
    if (p.approval) {
      steps.push(step('approval', 'Manual approval granted', `${gh ? 'GitHub environment "prod" protection rule' : 'Azure Pipelines environment approval check'}: a reviewer saw the evaluation report and approved.`, { reviewer: 'release-manager', waited: 'manual' }));
      stage('approval', 8, 'ok', 'quality');
    } else {
      steps.push(step('approval', 'No approval before production', 'Nothing stops an automated run from changing production; add an environment protection rule / approval check.', null, 'warn'));
    }
    if (regressionShipped) {
      steps.push(step('prod', 'Regression reached production', `Production agent now has groundedness ≈${score}. Users get uncited answers; rollback needed.`, { environment: 'prod', groundedness: score }, 'error'));
      stage('deploy prod', 4, 'error', 'deploy');
    } else {
      steps.push(step('prod', 'Deployed to production', 'Deployment to prod with prod.bicepparam and the prod Foundry project; post-deploy smoke test passed. Previous agent version kept for rollback.', { environment: 'prod' }));
      stage('deploy prod', 4, 'ok', 'deploy');
    }
  } else if (!halted) {
    steps.push(step('prod', 'Stopped at test', 'Target is test; production untouched.', null, 'skip'));
  }

  const yaml = gh ? [
    'name: foundry-agent-cicd',
    'on: { push: { branches: [main] } }',
    'permissions: { id-token: write, contents: read }',
    'jobs:',
    '  build: { runs-on: ubuntu-latest, steps: [checkout, lint, "pytest"] }',
    '  deploy-dev:',
    '    needs: build',
    '    environment: dev',
    '    steps:',
    p.auth === 'oidc' ? '      - uses: azure/login@v2  # client-id, tenant-id, subscription-id (OIDC, no secret)' : p.auth === 'secret' ? '      - uses: azure/login@v2  # creds: ${{ secrets.AZURE_CREDENTIALS }}  (client secret)' : '      # (no azure/login step)',
    `      - run: az deployment group ${p.whatIf ? 'what-if' : 'create'} -g rg-dev -f infra/main.bicep -p infra/dev.bicepparam`,
    '      - run: python deploy_agent.py --env dev   # create/update agent from agent.yaml',
    p.evalGate ? `      - run: python run_eval.py --data eval/golden.jsonl --min-groundedness ${p.threshold}  # exits non-zero below threshold` : '      - run: python run_eval.py --data eval/golden.jsonl   # report only',
    '  deploy-test: { needs: deploy-dev, environment: test, ... }',
    `  deploy-prod: { needs: deploy-test, environment: prod${p.approval ? '  # environment has required reviewers' : ''}, ... }`,
  ] : [
    'trigger: [main]',
    'stages:',
    '- stage: Build   # lint + pytest',
    '- stage: Dev',
    '  jobs:',
    '  - deployment: dev',
    '    environment: dev',
    '    strategy: { runOnce: { deploy: { steps: [',
    `      AzureCLI@2 (azureSubscription: sc-dev ${p.auth === 'oidc' ? '/* workload identity federation */' : p.auth === 'secret' ? '/* SP secret */' : '/* missing */'}) → az deployment group ${p.whatIf ? 'what-if' : 'create'} ...,`,
    '      python deploy_agent.py --env dev,',
    p.evalGate ? `      python run_eval.py --min-groundedness ${p.threshold}   # fails the stage` : '      python run_eval.py   # report only',
    '    ] } } }',
    '- stage: Test',
    `- stage: Prod   # environment: prod${p.approval ? ' with approval check' : ''}`,
  ];

  const fails = steps.filter(s => s.status === 'error').length;
  const warns = steps.filter(s => s.status === 'warn').length;
  const reached = halted ? steps.filter(s => s.status === 'error').map(s => s.node)[0] : p.target;
  return {
    steps,
    output: [
      { type: 'timeline', title: 'Pipeline run (simulated durations)', unit: 'min', items: times },
      { type: 'table', title: 'Gates', columns: ['Gate', 'Result'], rows: gates.map(g => [g[0], g[1]]), tones: gates.map(g => g[2]) },
      ...(score !== null ? [{ type: 'bars', title: 'Evaluation on golden dataset', threshold: p.evalGate ? p.threshold : undefined, items: [
        { label: 'Groundedness pass rate', value: score, tone: score >= p.threshold ? 'ok' : 'error' },
        { label: 'Baseline (current prod)', value: 0.85, tone: 'info', note: 'last release' },
      ] }] : []),
      { type: 'code', title: gh ? '.github/workflows/foundry.yml (abridged, illustrative)' : 'azure-pipelines.yml (abridged, illustrative)', lang: 'yaml', text: yaml.join('\n') },
      { type: 'alert', tone: fails ? 'error' : warns ? 'warn' : 'ok', text: fails ? `Pipeline stopped or shipped a problem at "${reached}".` : warns ? `Pipeline succeeded with ${warns} caveat(s).` : `Change promoted to ${p.target} with every gate enforced.` },
    ],
    metrics: [
      metric('Furthest stage', halted ? `${reached} (failed)` : p.target, 'computed'),
      metric('Groundedness', score === null ? 'not run' : String(score), 'computed', 'Simulated pass rate on a 50-row golden dataset.'),
      metric('Pipeline duration', `≈${clock} min`, 'estimate', 'Illustrative stage durations, not measured.'),
    ],
    summary: `${CHANGES[p.change].label}: ${halted ? 'stopped' : `reached ${p.target}`}, ${fails} error(s), ${warns} warning(s)`,
  };
}

export default {
  id: '1.2.4',
  lab: 'Foundry CI/CD pipeline simulator',
  services: [
    { name: 'Use GitHub Actions to connect to Azure (OIDC)', url: 'https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect' },
    { name: 'Azure DevOps: workload identity federation service connections', url: 'https://learn.microsoft.com/en-us/azure/devops/pipelines/library/connect-to-azure' },
    { name: 'Evaluate generative AI apps in CI (Foundry evaluation)', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/how-to/evaluation-github-action' },
    { name: 'Bicep deployment what-if', url: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-what-if' },
  ],
  prereqs: ['1.2.1', '1.2.3'],
  next: ['2.1.4', '1.4.2', '1.3.4'],

  concept: {
    plain: 'A CI/CD pipeline turns every change (a prompt edit, a model upgrade, new infrastructure) into the same repeatable path: check it, test it, deploy it to a dev copy, measure answer quality, then promote it through test to production. For AI apps the special step is an evaluation gate: a change that makes answers worse should stop the pipeline, just like a failing unit test.',
    technical: 'GitHub Actions or Azure Pipelines authenticate to Azure with workload identity federation (OIDC federated credentials on an Entra app or user-assigned managed identity; the subject must match the repo/branch/environment or service connection). Infrastructure is deployed with Bicep (what-if preview, per-environment .bicepparam files) by an identity scoped to the resource group; templates that create role assignments need rights such as Role Based Access Control Administrator. Agent definitions and prompts are versioned as code and applied with the azure-ai-projects SDK. Batch evaluations (azure-ai-evaluation / Foundry evaluations) on a golden dataset gate promotion, and environment approvals protect production.',
    useCase: 'A support team edits agent instructions in a pull request. On merge, GitHub Actions lints, runs unit tests, logs in with OIDC, deploys Bicep and the agent to dev, runs groundedness and relevance evaluators on 200 golden questions, blocks below baseline, promotes to test, and waits for a release manager to approve production.',
    terms: [
      ['Workload identity federation', 'OIDC trust between the CI system and Entra ID; no stored secret.'],
      ['Federated credential subject', 'The claim (repo/branch/environment or service connection) that must match exactly.'],
      ['Evaluation gate', 'A pipeline step that fails when evaluation scores fall below a threshold.'],
      ['what-if', 'Bicep/ARM preview of the changes a deployment would make.'],
    ],
  },

  visual: {
    views: {
      conceptual: p => ({
        nodes: [
          { id: 'trigger', label: p ? `Change: ${CHANGES[p.change].label.split(' (')[0]}` : 'Change merged', col: 0, row: 1, kind: 'user', detail: 'Prompt, model, infra or code change in Git.' },
          { id: 'lint', label: 'Lint / validate', col: 1, row: 0, kind: 'code', detail: 'Static checks incl. agent definition schema.' },
          { id: 'unit', label: 'Unit tests', col: 1, row: 2, kind: 'code', detail: 'Deterministic tests with mocked model output.' },
          { id: 'login', label: 'Azure login', col: 2, row: 0, kind: 'policy', badge: p ? p.auth : undefined, detail: 'OIDC (preferred) or secret.' },
          { id: 'iac', label: 'IaC (Bicep)', col: 2, row: 2, kind: 'compute', detail: 'what-if + deploy per environment.' },
          { id: 'dev', label: 'Dev', col: 3, row: 0, kind: 'app', detail: 'First deployed environment.' },
          { id: 'eval', label: 'Evaluation gate', col: 3, row: 1, kind: 'policy', disabled: p && !p.evalGate, detail: 'Blocks quality regressions.' },
          { id: 'test', label: 'Test', col: 3, row: 2, kind: 'app', detail: 'Integration tests on the same artifacts.' },
          { id: 'approval', label: 'Approval', col: 4, row: 0.5, kind: 'user', disabled: p && !p.approval, detail: 'Human sign-off before prod.' },
          { id: 'prod', label: 'Production', col: 4, row: 1.5, kind: 'app', disabled: p && p.target !== 'prod', detail: 'Promoted artifacts; rollback ready.' },
        ],
        edges: [['trigger', 'lint'], ['lint', 'unit'], ['unit', 'login'], ['login', 'iac'], ['iac', 'dev'], ['dev', 'eval'], ['eval', 'test'], ['test', 'approval'], ['approval', 'prod']],
      }),
      architectural: p => ({
        nodes: [
          { id: 'trigger', label: p && p.platform === 'ado' ? 'Azure Repos / Pipelines' : 'GitHub repo + Actions', col: 0, row: 1, kind: 'app', detail: 'Source of truth: code, prompts, agent.yaml, Bicep, eval datasets.' },
          { id: 'login', label: 'Entra ID app / UAMI + federated credential', col: 1, row: 0, kind: 'policy', detail: 'Trusts tokens from the CI system for a specific subject.' },
          { id: 'iac', label: p ? `Pipeline identity: ${ROLES[p.role].label}` : 'Pipeline identity RBAC', col: 1, row: 2, kind: 'policy', detail: 'Least privilege per resource group.' },
          { id: 'dev', label: 'rg-dev: Foundry project + app', col: 2, row: 0, kind: 'compute', detail: 'Dev environment.' },
          { id: 'test', label: 'rg-test: Foundry project + app', col: 2, row: 1, kind: 'compute', detail: 'Test environment.' },
          { id: 'prod', label: 'rg-prod: Foundry project + app', col: 2, row: 2, kind: 'compute', detail: 'Production environment.' },
          { id: 'eval', label: 'Foundry evaluations', col: 3, row: 0.5, kind: 'ai', detail: 'Batch evaluators on the golden dataset; results logged to the project.' },
          { id: 'approval', label: 'Environment protection / approvals', col: 3, row: 2, kind: 'user', detail: 'Required reviewers before prod.' },
        ],
        edges: [['trigger', 'login', 'OIDC token'], ['login', 'iac'], ['iac', 'dev'], ['dev', 'eval'], ['eval', 'test'], ['test', 'approval'], ['approval', 'prod']],
      }),
      implementation: p => ({
        nodes: [
          { id: 'trigger', label: 'on: push: branches: [main]', col: 0, row: 0, kind: 'code', detail: 'Trigger.' },
          { id: 'login', label: p && p.auth === 'secret' ? 'azure/login@v2 with creds secret' : 'azure/login@v2 (client-id, tenant-id, subscription-id) + id-token: write', col: 0, row: 1, kind: 'code', detail: 'OIDC needs the id-token permission.' },
          { id: 'iac', label: 'az deployment group what-if/create -f main.bicep -p dev.bicepparam', col: 0, row: 2, kind: 'code', detail: 'Per-environment parameters.' },
          { id: 'dev', label: 'project.agents.create_agent(...) / update from agent.yaml', col: 0, row: 3, kind: 'code', detail: 'Illustrative: agent definition applied as code.' },
          { id: 'eval', label: 'evaluate(data="golden.jsonl", evaluators={"groundedness": GroundednessEvaluator(...)})', col: 0, row: 4, kind: 'code', detail: 'azure-ai-evaluation; script exits non-zero below threshold. Signature illustrative.' },
          { id: 'approval', label: 'environment: prod  # required reviewers', col: 0, row: 5, kind: 'code', detail: 'Protection rule.' },
        ],
        edges: [['trigger', 'login'], ['login', 'iac'], ['iac', 'dev'], ['dev', 'eval'], ['eval', 'approval']],
      }),
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'platform', label: 'CI/CD platform', type: 'select', options: [['github', 'GitHub Actions'], ['ado', 'Azure DevOps Pipelines']], default: 'github' },
      { id: 'change', label: 'Change in this commit', type: 'select', options: Object.entries(CHANGES).map(([v, c]) => [v, c.label]), default: 'prompt' },
      { id: 'quality', label: 'Effect of the change on answers (hidden truth)', type: 'select', options: [['improved', 'Improves or keeps quality'], ['regressed', 'Regresses grounding']], default: 'improved', help: 'In real life you do not know this: that is why you evaluate.' },
      { id: 'testsPass', label: 'Unit tests pass', type: 'toggle', default: true },
      { id: 'auth', label: 'Pipeline authentication', type: 'select', options: [['oidc', 'Workload identity federation (OIDC)'], ['secret', 'Service principal client secret'], ['none', 'Not configured']], default: 'secret' },
      { id: 'subject', label: 'Federated credential subject', type: 'select', options: [['match', 'Matches branch/environment'], ['mismatch', 'Does not match']], default: 'match' },
      { id: 'role', label: 'Pipeline identity role', type: 'select', options: Object.entries(ROLES).map(([v, r]) => [v, r.label]), default: 'contributor' },
      { id: 'whatIf', label: 'Run Bicep what-if before deploy', type: 'toggle', default: true },
      { id: 'evalGate', label: 'Enforce evaluation gate', type: 'toggle', default: true },
      { id: 'threshold', label: 'Groundedness threshold', type: 'range', min: 0.6, max: 0.95, step: 0.05, default: 0.8 },
      { id: 'approval', label: 'Manual approval before prod', type: 'toggle', default: false },
      { id: 'target', label: 'Promote as far as', type: 'select', options: [['test', 'Test'], ['prod', 'Production']], default: 'prod' },
    ],
    samples: [
      { label: 'Good prompt change, OIDC, approval', values: { auth: 'oidc', approval: true } },
      { label: 'Regressed prompt caught by gate', values: { auth: 'oidc', quality: 'regressed' } },
      { label: 'Infra change with role assignment', values: { auth: 'oidc', change: 'infra', role: 'contribRbac', approval: true } },
      { label: 'Azure DevOps, model bump', values: { platform: 'ado', auth: 'oidc', change: 'model', approval: true } },
    ],
    run: pipeline,
  },

  compare: {
    suggestions: [
      'Regressed prompt: run with the evaluation gate on, then off, and compare where the pipeline ends.',
      'Infra change: compare Contributor vs Contributor + RBAC Administrator vs Owner.',
      'Compare auth = client secret vs OIDC (and OIDC with a mismatched subject).',
    ],
  },

  debug: [
    { id: 'aadsts', title: 'azure/login fails with AADSTS70021', values: { auth: 'oidc', subject: 'mismatch' }, node: 'login',
      symptom: 'No matching federated identity record found for presented assertion.', cause: 'The federated credential subject does not match the branch/environment (or service connection) the run presents.', fix: 'Fix the subject so it matches (set subject to "Matches").' },
    { id: 'no-gate', title: 'Users report uncited answers after release', values: { auth: 'oidc', quality: 'regressed', evalGate: false, approval: true }, node: 'eval',
      symptom: 'Regression reached production.', cause: 'Evaluation ran but nothing blocked the pipeline on its result.', fix: 'Enforce the evaluation gate: the regression is now stopped in dev (gate fails). Then fix the prompt itself (set the change effect to "Improves") so the gate passes.' },
    { id: 'rbac-assign', title: 'Bicep fails on role assignment', values: { auth: 'oidc', change: 'infra', role: 'contributor', approval: true }, node: 'iac',
      symptom: 'AuthorizationFailed: Microsoft.Authorization/roleAssignments/write.', cause: 'Contributor cannot create role assignments.', fix: 'Add Role Based Access Control Administrator (constrained) to the pipeline identity, not subscription Owner.' },
    { id: 'reader', title: 'Every deployment fails', values: { auth: 'oidc', role: 'reader', approval: true }, node: 'iac',
      symptom: 'AuthorizationFailed on Microsoft.Resources/deployments.', cause: 'The pipeline identity only has Reader.', fix: 'Grant Contributor on the target resource group.' },
    { id: 'tests', title: 'Nothing deploys after a refactor', values: { testsPass: false }, node: 'unit',
      symptom: 'Unit tests failed; pipeline stopped.', cause: 'A parser change broke tool output handling.', fix: 'Fix the code so tests pass (turn Unit tests pass on).' },
    { id: 'threshold', title: 'Gate fails even for good changes', values: { auth: 'oidc', threshold: 0.95, approval: true }, node: 'eval',
      symptom: 'Evaluation gate failed for an improving change.', cause: 'The threshold is above what the baseline reaches.', fix: 'Set the threshold from a measured baseline (e.g. 0.8).' },
    { id: 'secret', title: 'Security review flags the pipeline', values: { auth: 'secret', approval: false }, node: 'login',
      symptom: 'Warnings: client secret login, no approval before prod.', cause: 'Long-lived secret stored in CI; production unprotected.', fix: 'Use OIDC and require approval for prod.' },
  ],

  challenge: {
    task: 'Promote a prompt change to production through a pipeline with no stored secrets, an enforced evaluation gate of at least 0.8, and a human approval, with zero warnings.',
    condition: 'Change = prompt, target = prod, auth = OIDC, evaluation gate on with threshold ≥ 0.8, approval on, and no warn/error steps.',
    hint: 'Defaults use a client secret and no approval. Check the federated subject too.',
    check: (p, res) => p.change === 'prompt' && p.target === 'prod' && p.auth === 'oidc' && p.evalGate && p.threshold >= 0.8 && p.approval && !res.steps.some(s => s.status === 'warn' || s.status === 'error'),
    solution: ['Auth: workload identity federation (OIDC), subject matches.', 'Role: Contributor on the resource group (enough for a prompt change).', 'Evaluation gate on, threshold 0.8.', 'Manual approval before prod on; target Production.'],
    solutionValues: { platform: 'github', change: 'prompt', quality: 'improved', testsPass: true, auth: 'oidc', subject: 'match', role: 'contributor', whatIf: true, evalGate: true, threshold: 0.8, approval: true, target: 'prod' },
  },

  quiz: [
    { q: 'Your security team bans long-lived secrets in CI. How should GitHub Actions authenticate to Azure to deploy a Foundry project?', options: ['Store a client secret in repository secrets', 'Workload identity federation (OIDC) with a federated credential and id-token: write', 'Use a personal access token', 'Use the Foundry resource API key'], answer: 1, why: 'OIDC exchanges a short-lived GitHub token for an Entra token; no secret is stored.' },
    { q: 'A prompt change passes unit tests but lowers groundedness. What stops it reaching production?', options: ['A linter', 'An evaluation step on a golden dataset that fails the pipeline below a threshold', 'Bicep what-if', 'More replicas'], answer: 1, why: 'Only an enforced evaluation gate measures answer quality; unit tests with mocked responses cannot.' },
    { q: 'Bicep that adds a Search connection and a role assignment fails with AuthorizationFailed on roleAssignments/write for the pipeline identity (Contributor). Least-privilege fix?', options: ['Make it subscription Owner', 'Add Role Based Access Control Administrator with conditions limiting assignable roles, scoped to the resource group', 'Remove the role assignment and use keys', 'Run the pipeline as a user'], answer: 1, why: 'Contributor cannot assign roles; a constrained RBAC Administrator assignment adds exactly that right.' },
  ],

  recap: 'Treat prompts, agent definitions, Bicep and evaluation datasets as code. Authenticate the pipeline with OIDC, give its identity least-privilege roles (plus constrained role-assignment rights when templates assign roles), preview infra with what-if, deploy to dev, gate on evaluations, promote the same artifacts to test, and require approval before production.',
};
