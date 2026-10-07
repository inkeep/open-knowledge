import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { credentialReasons } from './workflow-credentials.test-helper.mjs';

const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODES = ['none', 'read', 'write-only', 'write'];

const isFalse = (value) => /^false$/i.test(String(value));
const isLiteralTrue = (value) => String(value) === 'true';

const CACHE_FREE = () => [];
const ACTIONS = {
  'actions/checkout': CACHE_FREE,
  'actions/upload-artifact': CACHE_FREE,
  'actions/download-artifact': CACHE_FREE,
  'actions/create-github-app-token': CACHE_FREE,
  'actions/github-script': CACHE_FREE,
  'dtolnay/rust-toolchain': CACHE_FREE,
  'taiki-e/install-action': CACHE_FREE,
  'linear/linear-release-action': CACHE_FREE,
  'actions/cache': () => ['extract', 'save'],
  'actions/cache/restore': (inputs) =>
    isLiteralTrue(inputs['lookup-only']) ? ['lookup'] : ['extract'],
  'actions/cache/save': () => ['save'],
  'actions/setup-node': (inputs) => {
    if (inputs.cache !== undefined) return ['extract', 'save'];
    return isFalse(inputs['package-manager-cache']) ? [] : ['incidental'];
  },
  'pnpm/action-setup': (inputs) =>
    inputs.cache === undefined || isFalse(inputs.cache) ? [] : ['extract', 'save'],
  'pnpm/setup': (inputs) =>
    inputs.cache === undefined || isFalse(inputs.cache) ? [] : ['extract', 'save'],
  'astral-sh/setup-uv': (inputs) => (isFalse(inputs['enable-cache']) ? [] : ['incidental']),
  'mlugg/setup-zig': (inputs) => [
    'extract',
    'save',
    ...(isFalse(inputs['use-cache']) ? [] : ['incidental']),
  ],
  'actions/stale': () => ['incidental'],
};

const OFF_SWITCHES = {
  'actions/setup-node': 'package-manager-cache',
  'pnpm/action-setup': 'cache',
  'pnpm/setup': 'cache',
  'astral-sh/setup-uv': 'enable-cache',
  'mlugg/setup-zig': 'use-cache',
};

const actionName = (uses) => (uses.includes('@') ? uses.slice(0, uses.indexOf('@')) : undefined);

function actionSteps(steps, root = OK_ROOT, seen = []) {
  const found = [];
  for (const step of steps ?? []) {
    const uses = step.uses;
    if (uses === undefined) continue;
    if (uses.startsWith('./')) {
      if (seen.includes(uses)) throw new Error(`composite cycle through ${uses}`);
      const dir = join(root, uses);
      const file = ['action.yml', 'action.yaml'].map((name) => join(dir, name)).find(existsSync);
      if (file === undefined) throw new Error(`local action ${uses} has no action.yml`);
      const action = parse(readFileSync(file, 'utf8'));
      if (action.runs?.using !== 'composite') {
        throw new Error(
          `local action ${uses} runs ${action.runs?.using}, not composite, so this sweep cannot see what cache it touches`,
        );
      }
      found.push(
        ...actionSteps(action.runs.steps, root, [...seen, uses]).map((inner) => ({
          ...inner,
          via: [uses, ...inner.via],
        })),
      );
      continue;
    }
    found.push({ step, via: [] });
  }
  return found;
}

export function cacheOps(steps, root = OK_ROOT) {
  return actionSteps(steps, root).flatMap(({ step, via }) => {
    const classify = ACTIONS[actionName(step.uses)];
    if (classify === undefined) {
      throw new Error(
        `${step.uses} is not classified for cache access; add it to ACTIONS in cache-mode-shape.test-helper.mjs`,
      );
    }
    return classify(step.with ?? {}).map((kind) => ({ kind, step: step.name ?? step.uses, via }));
  });
}

function narrowestMode(ops) {
  const reads = ops.some((op) => op.kind === 'lookup' || op.kind === 'extract');
  const writes = ops.some((op) => op.kind === 'save');
  if (reads && writes) return 'write';
  if (reads) return 'read';
  return writes ? 'write-only' : 'none';
}

export const effectiveMode = (workflow, job) => job['cache-mode'] ?? workflow['cache-mode'] ?? null;

export function cacheModeProblems(workflow, job, root = OK_ROOT) {
  if (credentialReasons(workflow, job).length === 0) return [];
  if (job.uses !== undefined)
    return [`calls the reusable workflow ${job.uses}, which this sweep does not trace`];
  const ops = cacheOps(job.steps, root);
  const mode = effectiveMode(workflow, job);
  const problems = [];
  for (const op of ops.filter((candidate) => candidate.kind === 'extract')) {
    problems.push(`extracts a cache entry at ${[...op.via, op.step].join(' > ')}`);
  }
  if (mode === null) problems.push('declares no cache-mode, so the trigger default applies');
  else if (!MODES.includes(mode))
    problems.push(`declares cache-mode ${mode}, which is not one of ${MODES.join(', ')}`);
  else if (mode !== narrowestMode(ops)) {
    problems.push(
      `declares cache-mode ${mode}, but its cache operations need exactly ${narrowestMode(ops)}`,
    );
  }
  if (mode === 'read' || mode === 'write') {
    for (const op of ops.filter((candidate) => candidate.kind === 'incidental')) {
      problems.push(
        `cache-mode ${mode} lets ${[...op.via, op.step].join(' > ')} restore its own cache`,
      );
    }
  }
  return problems;
}

export function restoresNothingProblems(workflow, job, root = OK_ROOT) {
  if (job.uses !== undefined)
    return [`calls the reusable workflow ${job.uses}, which this sweep does not trace`];
  const problems = [];
  const mode = effectiveMode(workflow, job);
  if (mode === null) problems.push('declares no cache-mode, so the trigger default applies');
  else if (mode !== 'none') problems.push(`declares cache-mode ${mode}, not none`);
  for (const op of cacheOps(job.steps, root)) {
    problems.push(`touches the cache (${op.kind}) at ${[...op.via, op.step].join(' > ')}`);
  }
  for (const { step, via } of actionSteps(job.steps, root)) {
    const input = OFF_SWITCHES[actionName(step.uses)];
    if (input !== undefined && !isFalse(step.with?.[input])) {
      problems.push(
        `does not set ${input}: false at ${[...via, step.name ?? step.uses].join(' > ')}`,
      );
    }
  }
  return problems;
}
