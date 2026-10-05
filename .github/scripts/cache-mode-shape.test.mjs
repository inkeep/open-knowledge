// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expression fixtures must remain literal.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { credentialReasons } from './workflow-credentials.test-helper.mjs';

const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = join(OK_ROOT, '.github', 'workflows');
const MODES = ['none', 'read', 'write-only', 'write'];

const isFalse = (value) => /^false$/i.test(String(value));
const isLiteralTrue = (value) => String(value) === 'true';

const CACHE_FREE = () => [];
const ACTIONS = {
  'actions/checkout': CACHE_FREE,
  'actions/upload-artifact': CACHE_FREE,
  'actions/download-artifact': CACHE_FREE,
  'actions/create-github-app-token': CACHE_FREE,
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
  'mlugg/setup-zig': (inputs) => (isFalse(inputs['use-cache']) ? [] : ['incidental']),
  'actions/stale': () => ['incidental'],
};

function cacheOps(steps, root = OK_ROOT, seen = []) {
  const ops = [];
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
      ops.push(
        ...cacheOps(action.runs.steps, root, [...seen, uses]).map((op) => ({
          ...op,
          via: [uses, ...op.via],
        })),
      );
      continue;
    }
    const at = uses.indexOf('@');
    const classify = at === -1 ? undefined : ACTIONS[uses.slice(0, at)];
    if (classify === undefined) {
      throw new Error(
        `${uses} is not classified for cache access; add it to ACTIONS in cache-mode-shape.test.mjs`,
      );
    }
    for (const kind of classify(step.with ?? {}))
      ops.push({ kind, step: step.name ?? uses, via: [] });
  }
  return ops;
}

function narrowestMode(ops) {
  const reads = ops.some((op) => op.kind === 'lookup' || op.kind === 'extract');
  const writes = ops.some((op) => op.kind === 'save');
  if (reads && writes) return 'write';
  if (reads) return 'read';
  return writes ? 'write-only' : 'none';
}

const effectiveMode = (workflow, job) => job['cache-mode'] ?? workflow['cache-mode'] ?? null;

function cacheModeProblems(workflow, job, root = OK_ROOT) {
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

const workflows = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .map((file) => ({ file, workflow: parse(readFileSync(join(WORKFLOWS, file), 'utf8')) }));
const allJobs = workflows.flatMap(({ file, workflow }) =>
  Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({
    label: `${file}#${id}`,
    workflow,
    job,
  })),
);
const credentialed = allJobs.filter(
  ({ workflow, job }) => credentialReasons(workflow, job).length > 0,
);

describe('credentialed jobs in public/open-knowledge/.github/workflows declare the narrowest cache-mode their cache operations need', () => {
  test('the credentialed jobs and their modes are exactly these', () => {
    expect(
      Object.fromEntries(
        credentialed.map(({ label, workflow, job }) => [label, effectiveMode(workflow, job)]),
      ),
    ).toEqual({
      'bug-lane-verify.yml#bug-lane-verify': 'write',
      'bug-lane.yml#bug-lane': 'none',
      'desktop-build-win-linux.yml#build-windows': 'none',
      'desktop-build.yml#build-macos-dmg': 'none',
      'desktop-release-draft-janitor.yml#sweep': 'none',
      'desktop-release.yml#prepare': 'none',
      'desktop-release.yml#build-macos': 'none',
      'desktop-release.yml#build-windows': 'none',
      'desktop-release.yml#publish-assets': 'none',
      'desktop-release.yml#finalize': 'none',
      'desktop-release.yml#release-consumers': 'none',
      'desktop-release.yml#alert': 'none',
      'linear-pr-relay.yml#relay': 'none',
      'linear-release.yml#stamp': 'none',
      'monorepo-pr-bridge.yml#acknowledge': 'none',
      'monorepo-pr-bridge.yml#sync': 'none',
      'monorepo-pr-bridge.yml#close': 'none',
      'monorepo-pr-bridge.yml#refresh-cla': 'none',
      'point-release.yml#point-release': 'none',
      'promote-stable.yml#promote': 'none',
      'publish-linux-repo.yml#publish': 'none',
      'release.yml#read-releases': 'none',
      'release.yml#release': 'none',
      'release.yml#publish': 'none',
      'select-beta-to-promote.yml#evaluate': 'read',
      'select-beta-to-promote.yml#dispatch-fast-tier-candidate': 'none',
      'select-beta-to-promote.yml#page-smoke-incident': 'write-only',
      'share-contract-deployment-gate.yml#reader-contract': 'none',
      'share-contract-monitor.yml#probe': 'none',
      'stale.yml#stale': 'none',
      'write-back.yml#notify': 'none',
    });
  });

  test.each(credentialed.map(({ label, workflow, job }) => [label, workflow, job]))(
    '%s extracts no cache entry and its mode matches its operations',
    (_label, workflow, job) => {
      expect(cacheModeProblems(workflow, job)).toEqual([]);
    },
  );

  test('no credentialed job touches an ok-pnpm-store- cache key', () => {
    for (const { label, job } of credentialed) {
      const storeSteps = (job.steps ?? []).filter((step) =>
        /ok-pnpm-store-/.test(JSON.stringify(step.with ?? {})),
      );
      expect(storeSteps, label).toEqual([]);
    }
  });

  test('the lookup-only restores that read and write jobs keep never extract', () => {
    const lookups = credentialed.flatMap(({ label, job }) =>
      cacheOps(job.steps)
        .filter((op) => op.kind === 'lookup')
        .map((op) => `${label} ${op.step}`),
    );
    expect(lookups).toEqual([
      'bug-lane-verify.yml#bug-lane-verify Has this drop already been paged?',
      'bug-lane-verify.yml#bug-lane-verify Has this refusal already been paged?',
      'select-beta-to-promote.yml#evaluate Look up an earlier smoke failure for the fast-tier candidate',
    ]);
  });
});

describe('cache-mode sweep self-tests', () => {
  const sha = '668228422ae6a00e4ad889ee87cd7109ec5666a7';
  const nodeSha = '48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
  const save = { name: 'save', uses: `actions/cache/save@${sha}`, with: { path: 'p', key: 'k' } };
  const lookup = {
    name: 'lookup',
    uses: `actions/cache/restore@${sha}`,
    with: { path: 'p', key: 'k', 'lookup-only': true },
  };
  const restore = {
    name: 'restore',
    uses: `actions/cache/restore@${sha}`,
    with: { path: 'p', key: 'k' },
  };
  const implicitNode = {
    name: 'node',
    uses: `actions/setup-node@${nodeSha}`,
    with: { 'node-version': '24' },
  };
  const slack = { name: 'page', run: 'post', env: { HOOK: '${{ secrets.SLACK_WEBHOOK_URL }}' } };
  const credentialedJob = (mode, ...steps) => ({
    permissions: { contents: 'read' },
    ...(mode === undefined ? {} : { 'cache-mode': mode }),
    steps: [slack, ...steps],
  });
  const kinds = (step) => cacheOps([step]).map((op) => op.kind);

  test('a credential is a non-GITHUB_TOKEN secret, an App token, or any write scope, wherever it is declared', () => {
    const fires = {
      'a secret in step env': [{}, { permissions: {}, steps: [slack] }],
      'a secret in a run script': [
        {},
        { permissions: {}, steps: [{ run: 'curl "${{ secrets.TOKEN }}"' }] },
      ],
      'a secret in job env': [
        {},
        { permissions: {}, env: { T: '${{ secrets.TOKEN }}' }, steps: [] },
      ],
      'a secret in workflow env': [
        { env: { T: '${{ secrets.TOKEN }}' } },
        { permissions: {}, steps: [] },
      ],
      'a secret beside GITHUB_TOKEN': [
        {},
        { permissions: {}, steps: [{ run: '${{ secrets.GITHUB_TOKEN || secrets.PAT }}' }] },
      ],
      'the whole secrets context': [
        {},
        { permissions: {}, steps: [{ run: '${{ toJSON(secrets) }}' }] },
      ],
      'an indexed secret': [{}, { permissions: {}, steps: [{ run: "${{ secrets['PAT'] }}" }] }],
      'a secret in a bare if': [
        {},
        { permissions: {}, steps: [{ if: "secrets.PAT != ''", run: 'true' }] },
      ],
      'a job write scope': [{}, { permissions: { contents: 'write' }, steps: [] }],
      'an inherited workflow write scope': [{ permissions: { issues: 'write' } }, { steps: [] }],
      'id-token write': [{}, { permissions: { 'id-token': 'write' }, steps: [] }],
      'write-all': [{}, { permissions: 'write-all', steps: [] }],
      'no permissions anywhere': [{}, { steps: [] }],
      'an App token step': [
        {},
        {
          permissions: {},
          steps: [
            { uses: 'actions/create-github-app-token@1b10c78c7865c340bc4f6099eb2f838309f1e8c3' },
          ],
        },
      ],
      'inherited secrets on a reusable call': [
        {},
        { permissions: {}, uses: './.github/workflows/x.yml', secrets: 'inherit' },
      ],
    };
    for (const [form, [workflow, job]] of Object.entries(fires)) {
      expect(credentialReasons(workflow, job), form).not.toEqual([]);
    }
    const quiet = {
      'GITHUB_TOKEN only': [
        {},
        {
          permissions: { contents: 'read' },
          steps: [{ env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' } }],
        },
      ],
      'github.token': [
        {},
        {
          permissions: { contents: 'read' },
          steps: [{ env: { GH_TOKEN: '${{ github.token }}' } }],
        },
      ],
      'an empty permissions map': [{}, { permissions: {}, steps: [] }],
      'a job read scope over a workflow write scope': [
        { permissions: { contents: 'write' } },
        { permissions: { contents: 'read' }, steps: [] },
      ],
      'read-all': [{}, { permissions: 'read-all', steps: [] }],
      'a bare if that reads no secret': [
        {},
        { permissions: {}, steps: [{ if: "github.event_name == 'push'", run: 'true' }] },
      ],
      'the word secrets outside an expression': [
        {},
        { permissions: {}, steps: [{ run: 'echo secrets.TOKEN' }] },
      ],
    };
    for (const [form, [workflow, job]] of Object.entries(quiet)) {
      expect(credentialReasons(workflow, job), form).toEqual([]);
    }
  });

  test('cache steps classify by what they restore and save', () => {
    expect(kinds(save)).toEqual(['save']);
    expect(kinds(lookup)).toEqual(['lookup']);
    expect(kinds({ ...lookup, with: { ...lookup.with, 'lookup-only': 'true' } })).toEqual([
      'lookup',
    ]);
    expect(kinds({ ...lookup, with: { ...lookup.with, 'lookup-only': false } })).toEqual([
      'extract',
    ]);
    expect(
      kinds({ ...lookup, with: { ...lookup.with, 'lookup-only': '${{ inputs.lookup }}' } }),
    ).toEqual(['extract']);
    expect(kinds(restore)).toEqual(['extract']);
    expect(
      kinds({ uses: `actions/cache@${sha}`, with: { path: 'p', key: 'k', 'lookup-only': true } }),
    ).toEqual(['extract', 'save']);
    expect(kinds(implicitNode)).toEqual(['incidental']);
    expect(kinds({ ...implicitNode, with: { 'package-manager-cache': 'FALSE' } })).toEqual([]);
    expect(
      kinds({ ...implicitNode, with: { cache: 'pnpm', 'package-manager-cache': false } }),
    ).toEqual(['extract', 'save']);
    expect(kinds({ uses: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86' })).toEqual(
      [],
    );
    expect(
      kinds({
        uses: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86',
        with: { cache: true },
      }),
    ).toEqual(['extract', 'save']);
    expect(
      kinds({
        uses: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2',
        with: { cache: 'true' },
      }),
    ).toEqual(['extract', 'save']);
    expect(
      kinds({
        uses: 'astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990',
        with: { 'enable-cache': false },
      }),
    ).toEqual([]);
    expect(kinds({ uses: 'astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990' })).toEqual([
      'incidental',
    ]);
    expect(kinds({ uses: 'mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29' })).toEqual([
      'incidental',
    ]);
    expect(kinds({ uses: 'actions/stale@b5d41d4e1d5dceea10e7104786b73624c18a190f' })).toEqual([
      'incidental',
    ]);
    expect(kinds({ run: 'pnpm install' })).toEqual([]);
  });

  test('composites are traced, and an unclassified or missing action fails the sweep', () => {
    const composite = cacheOps([
      { uses: './.github/composite-actions/share-contract-reader-gate' },
    ]);
    expect(composite.map((op) => op.kind)).toEqual(['incidental']);
    expect(composite[0].via).toEqual(['./.github/composite-actions/share-contract-reader-gate']);
    expect(() => cacheOps([{ uses: 'someone/cache@v1' }])).toThrow(/not classified/);
    expect(() => cacheOps([{ uses: 'docker://alpine:3' }])).toThrow(/not classified/);
    expect(() => cacheOps([{ uses: './.github/composite-actions/does-not-exist' }])).toThrow(
      /no action\.yml/,
    );
  });

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cache-mode-local-actions-'));
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const localAction = (name, runs) => {
    const dir = join(fixtureRoot, '.github', 'actions', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'action.yml'), JSON.stringify({ name, runs }));
    return `./.github/actions/${name}`;
  };

  test('a local action that is not a composite fails the sweep, at any depth', () => {
    const node = localAction('node-action', { using: 'node20', main: 'index.js' });
    const docker = localAction('docker-action', { using: 'docker', image: 'Dockerfile' });
    const noRuns = localAction('no-runs', undefined);
    const wrapsNode = localAction('wraps-node', { using: 'composite', steps: [{ uses: node }] });
    const saves = localAction('saves', { using: 'composite', steps: [save] });
    expect(() => cacheOps([{ uses: node }], fixtureRoot)).toThrow(
      /node-action runs node20, not composite/,
    );
    expect(() => cacheOps([{ uses: docker }], fixtureRoot)).toThrow(
      /docker-action runs docker, not composite/,
    );
    expect(() => cacheOps([{ uses: noRuns }], fixtureRoot)).toThrow(
      /no-runs runs undefined, not composite/,
    );
    expect(() => cacheOps([{ uses: wrapsNode }], fixtureRoot)).toThrow(/node-action runs node20/);
    expect(cacheOps([{ uses: saves }], fixtureRoot).map((op) => op.kind)).toEqual(['save']);
    expect(() =>
      cacheModeProblems({}, credentialedJob('none', { uses: node }), fixtureRoot),
    ).toThrow(/node-action runs node20/);
    expect(() =>
      cacheModeProblems({}, credentialedJob('write-only', save, { uses: docker }), fixtureRoot),
    ).toThrow(/docker-action runs docker/);
    expect(
      cacheModeProblems({}, { permissions: {}, steps: [{ uses: node }] }, fixtureRoot),
    ).toEqual([]);
  });

  test('each mode is accepted exactly where the operations need it', () => {
    const accepted = {
      'none with no cache step': [{}, credentialedJob('none')],
      'none with an implicit setup-node cache': [{}, credentialedJob('none', implicitNode)],
      'read with a lookup-only restore': [{}, credentialedJob('read', lookup)],
      'write-only with a save': [{}, credentialedJob('write-only', save)],
      'write-only with a save and an implicit setup-node cache': [
        {},
        credentialedJob('write-only', save, implicitNode),
      ],
      'write with a lookup-only restore and a save': [{}, credentialedJob('write', lookup, save)],
      'none inherited from the workflow': [{ 'cache-mode': 'none' }, credentialedJob(undefined)],
      'a job mode overriding the workflow mode': [
        { 'cache-mode': 'write' },
        credentialedJob('none'),
      ],
      'an uncredentialed job at the default': [{}, { permissions: {}, steps: [restore, save] }],
    };
    for (const [form, [workflow, job]] of Object.entries(accepted)) {
      expect(cacheModeProblems(workflow, job), form).toEqual([]);
    }
    const refused = {
      'no mode, so the trigger default applies': [
        {},
        credentialedJob(undefined),
        /declares no cache-mode/,
      ],
      'write with no cache step': [{}, credentialedJob('write'), /need exactly none/],
      'read with no cache step': [{}, credentialedJob('read'), /need exactly none/],
      'write-only with no cache step': [{}, credentialedJob('write-only'), /need exactly none/],
      'none with a save that would be dropped': [
        {},
        credentialedJob('none', save),
        /need exactly write-only/,
      ],
      'read with a save that would be dropped': [
        {},
        credentialedJob('read', lookup, save),
        /need exactly write/,
      ],
      'write for a lookup alone': [{}, credentialedJob('write', lookup), /need exactly read/],
      'write for a save alone': [{}, credentialedJob('write', save), /need exactly write-only/],
      'an extracting restore under none': [
        {},
        credentialedJob('none', restore),
        /extracts a cache entry at restore/,
      ],
      'the combined cache action': [
        {},
        credentialedJob('none', { uses: `actions/cache@${sha}`, with: { path: 'p', key: 'k' } }),
        /extracts/,
      ],
      'an implicit setup-node cache under read': [
        {},
        credentialedJob('read', lookup, implicitNode),
        /lets node restore/,
      ],
      'an implicit setup-node cache in a composite under write': [
        {},
        credentialedJob('write', lookup, save, {
          uses: './.github/composite-actions/share-contract-reader-gate',
        }),
        /share-contract-reader-gate > Set up Node restore/,
      ],
      'a misspelt mode': [{}, credentialedJob('read-only'), /not one of/],
      'a workflow write that the job inherits': [
        { 'cache-mode': 'write' },
        credentialedJob(undefined),
        /need exactly none/,
      ],
      'a reusable workflow call': [
        {},
        { permissions: { contents: 'write' }, uses: './.github/workflows/x.yml' },
        /reusable workflow/,
      ],
    };
    for (const [form, [workflow, job, reason]] of Object.entries(refused)) {
      expect(cacheModeProblems(workflow, job).join('\n'), form).toMatch(reason);
    }
  });

  test('the real signing jobs turn red at the default or at write', () => {
    const { workflow } = workflows.find(({ file }) => file === 'desktop-release.yml');
    for (const id of ['build-macos', 'build-windows', 'prepare']) {
      const { 'cache-mode': _mode, ...atDefault } = workflow.jobs[id];
      expect(cacheModeProblems(workflow, atDefault).join('\n'), `${id} at the default`).toMatch(
        /declares no cache-mode/,
      );
      expect(
        cacheModeProblems(workflow, { ...atDefault, 'cache-mode': 'write' }).join('\n'),
        `${id} at write`,
      ).toMatch(/need exactly none/);
    }
    const selector = workflows.find(({ file }) => file === 'select-beta-to-promote.yml').workflow;
    expect(
      cacheModeProblems(selector, { ...selector.jobs.evaluate, 'cache-mode': 'write' }).join('\n'),
    ).toMatch(/need exactly read/);
    expect(
      cacheModeProblems(selector, {
        ...selector.jobs['page-smoke-incident'],
        'cache-mode': 'write',
      }).join('\n'),
    ).toMatch(/need exactly write-only/);
  });
});
