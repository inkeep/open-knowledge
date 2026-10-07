// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expression fixtures must remain literal.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  cacheModeProblems,
  cacheOps,
  effectiveMode,
  restoresNothingProblems,
} from './cache-mode-shape.test-helper.mjs';
import { credentialReasons } from './workflow-credentials.test-helper.mjs';

const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS = join(OK_ROOT, '.github', 'workflows');

const SHIPS = [
  'desktop-release.yml#build-linux',
  'desktop-release.yml#build-macos',
  'desktop-release.yml#build-windows',
  'desktop-release.yml#prepare',
  'native-config-prebuild.yml#build',
  'native-config-prebuild.yml#combine',
  'release.yml#build',
];

const QA_BUILDS = [
  'desktop-build-win-linux.yml#build-linux',
  'desktop-build-win-linux.yml#build-windows',
  'desktop-build-win-linux.yml#prepare',
  'desktop-build.yml#build-macos-dmg',
];

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
      'desktop-release-auto-retry.yml#rerun': 'none',
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

describe('jobs in public/open-knowledge/.github/workflows that build what ships restore nothing from the Actions cache', () => {
  test.each(SHIPS)(
    '%s declares cache-mode none, touches no cache and turns every setup cache off',
    (label) => {
      const entry = allJobs.find((candidate) => candidate.label === label);
      expect(entry, `${label} is missing`).toBeDefined();
      expect(restoresNothingProblems(entry.workflow, entry.job)).toEqual([]);
    },
  );
});

describe('QA desktop build jobs in public/open-knowledge/.github/workflows, which can produce production-signed installers, restore nothing from the Actions cache', () => {
  test.each(QA_BUILDS)(
    '%s declares cache-mode none, touches no cache and turns every setup cache off',
    (label) => {
      const entry = allJobs.find((candidate) => candidate.label === label);
      expect(entry, `${label} is missing`).toBeDefined();
      expect(restoresNothingProblems(entry.workflow, entry.job)).toEqual([]);
    },
  );
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
      'the secrets context in another casing': [
        {},
        { permissions: {}, steps: [{ run: '${{ SECRETS.pat }}' }] },
      ],
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
      'GITHUB_TOKEN in another casing': [
        {},
        {
          permissions: { contents: 'read' },
          steps: [{ env: { GH_TOKEN: '${{ Secrets.github_token }}' } }],
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
      'extract',
      'save',
      'incidental',
    ]);
    expect(
      kinds({
        uses: 'mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29',
        with: { 'use-cache': false },
      }),
    ).toEqual(['extract', 'save']);
    expect(kinds({ uses: 'actions/stale@b5d41d4e1d5dceea10e7104786b73624c18a190f' })).toEqual([
      'incidental',
    ]);
    expect(
      kinds({ uses: 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3' }),
    ).toEqual([]);
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

  test('a job that must restore nothing is accepted only at none, touching no cache, with every setup cache off', () => {
    const offNode = {
      ...implicitNode,
      with: { 'node-version': '24', 'package-manager-cache': false },
    };
    const actionSetup = { uses: 'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86' };
    const pnpmSetup = { uses: 'pnpm/setup@84cb39b217b10273981911c288cd62326dc7c6d2' };
    const uv = { uses: 'astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990' };
    const zig = { uses: 'mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29' };
    const checkout = { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' };
    const buildJob = (mode, ...steps) => ({
      permissions: { contents: 'read' },
      ...(mode === undefined ? {} : { 'cache-mode': mode }),
      steps: [checkout, { run: 'pnpm install --frozen-lockfile' }, ...steps],
    });
    const accepted = {
      'none with setup-node and pnpm/action-setup off': [
        {},
        buildJob('none', offNode, { ...actionSetup, with: { cache: false } }),
      ],
      'none with pnpm/setup and setup-uv off, spelled as strings': [
        {},
        buildJob(
          'none',
          { ...pnpmSetup, with: { install: false, cache: 'false' } },
          { ...uv, with: { 'enable-cache': 'FALSE' } },
        ),
      ],
      'none inherited from the workflow': [{ 'cache-mode': 'none' }, buildJob(undefined, offNode)],
      'none with no action that has a cache': [{}, buildJob('none')],
    };
    for (const [form, [workflow, job]] of Object.entries(accepted)) {
      expect(restoresNothingProblems(workflow, job), form).toEqual([]);
    }
    const refused = {
      'no mode, so the trigger default applies': [
        {},
        buildJob(undefined, offNode),
        /declares no cache-mode/,
      ],
      write: [{}, buildJob('write', offNode), /declares cache-mode write, not none/],
      read: [{}, buildJob('read', offNode), /declares cache-mode read, not none/],
      'write-only': [
        {},
        buildJob('write-only', offNode),
        /declares cache-mode write-only, not none/,
      ],
      'a workflow write the job inherits': [
        { 'cache-mode': 'write' },
        buildJob(undefined, offNode),
        /declares cache-mode write, not none/,
      ],
      'a job mode overriding a workflow none': [
        { 'cache-mode': 'none' },
        buildJob('read', offNode),
        /declares cache-mode read, not none/,
      ],
      'an extracting restore under none': [
        {},
        buildJob('none', restore),
        /touches the cache \(extract\) at restore/,
      ],
      'a lookup-only restore under none': [
        {},
        buildJob('none', lookup),
        /touches the cache \(lookup\) at lookup/,
      ],
      'a save under none': [{}, buildJob('none', save), /touches the cache \(save\) at save/],
      'the combined cache action under none': [
        {},
        buildJob('none', { uses: `actions/cache@${sha}`, with: { path: 'p', key: 'k' } }),
        /touches the cache \(extract\).*touches the cache \(save\)/s,
      ],
      'setup-node with its package-manager cache left to its default': [
        {},
        buildJob('none', implicitNode),
        /touches the cache \(incidental\) at node.*does not set package-manager-cache: false at node/s,
      ],
      'setup-node with package-manager-cache set by an expression': [
        {},
        buildJob('none', {
          ...implicitNode,
          with: { 'package-manager-cache': '${{ inputs.package-manager-cache }}' },
        }),
        /does not set package-manager-cache: false/,
      ],
      'setup-node with a cache input beside package-manager-cache false': [
        {},
        buildJob('none', {
          ...implicitNode,
          with: { cache: 'pnpm', 'package-manager-cache': false },
        }),
        /touches the cache \(extract\) at node/,
      ],
      'pnpm/action-setup with its cache left to its default': [
        {},
        buildJob('none', offNode, actionSetup),
        /does not set cache: false at pnpm\/action-setup/,
      ],
      'pnpm/setup with its cache on': [
        {},
        buildJob('none', offNode, { ...pnpmSetup, with: { cache: true } }),
        /touches the cache \(extract\)/,
      ],
      'setup-zig, whose compiler tarball is cached whatever use-cache says': [
        {},
        buildJob('none', { ...zig, with: { 'use-cache': false } }),
        /touches the cache \(extract\) at mlugg\/setup-zig/,
      ],
      'actions/stale, which has no off switch': [
        {},
        buildJob('none', { uses: 'actions/stale@b5d41d4e1d5dceea10e7104786b73624c18a190f' }),
        /touches the cache \(incidental\)/,
      ],
      'a setup cache inside a local composite': [
        {},
        buildJob('none', { uses: './.github/composite-actions/share-contract-reader-gate' }),
        /share-contract-reader-gate > Set up Node/,
      ],
      'a reusable workflow call': [
        {},
        {
          permissions: { contents: 'read' },
          'cache-mode': 'none',
          uses: './.github/workflows/x.yml',
        },
        /reusable workflow/,
      ],
    };
    for (const [form, [workflow, job, reason]] of Object.entries(refused)) {
      expect(restoresNothingProblems(workflow, job).join('\n'), form).toMatch(reason);
    }
    expect(() =>
      restoresNothingProblems({}, buildJob('none', { uses: 'someone/cache@v1' })),
    ).toThrow(/not classified/);
  });

  test('the real ships jobs turn red when a cache comes back', () => {
    const real = (label) => allJobs.find((candidate) => candidate.label === label);
    const store = {
      uses: `actions/cache@${sha}`,
      with: { path: '${{ env.STORE_PATH }}', key: 'Linux-ok-pnpm-store-k' },
    };
    const release = real('release.yml#build');
    expect(
      restoresNothingProblems(release.workflow, {
        ...release.job,
        steps: [...release.job.steps, store],
      }).join('\n'),
    ).toMatch(/touches the cache \(extract\)/);
    const linux = real('desktop-release.yml#build-linux');
    expect(
      restoresNothingProblems(linux.workflow, { ...linux.job, 'cache-mode': 'write' }).join('\n'),
    ).toMatch(/declares cache-mode write, not none/);
    const prebuild = real('native-config-prebuild.yml#build');
    const withNode = (inputs) =>
      prebuild.job.steps.map((step) =>
        step.uses?.startsWith('actions/setup-node@') ? { ...step, with: inputs } : step,
      );
    expect(
      restoresNothingProblems(prebuild.workflow, {
        ...prebuild.job,
        steps: withNode({ 'node-version': '24' }),
      }).join('\n'),
    ).toMatch(/does not set package-manager-cache: false at Setup Node/);
    expect(
      restoresNothingProblems(prebuild.workflow, {
        ...prebuild.job,
        steps: [
          ...prebuild.job.steps,
          {
            uses: 'mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29',
            with: { 'use-cache': false },
          },
        ],
      }).join('\n'),
    ).toMatch(/touches the cache \(extract\) at mlugg\/setup-zig/);
    const combine = real('native-config-prebuild.yml#combine');
    const { 'cache-mode': _mode, ...combineAtDefault } = combine.job;
    expect(restoresNothingProblems(combine.workflow, combineAtDefault).join('\n')).toMatch(
      /declares no cache-mode/,
    );
  });

  test('the real QA desktop build jobs turn red when a cache comes back', () => {
    const real = (label) => allJobs.find((candidate) => candidate.label === label);
    const store = {
      uses: `actions/cache@${sha}`,
      with: { path: '${{ env.STORE_PATH }}', key: 'Linux-ok-pnpm-store-k' },
    };
    const prepare = real('desktop-build-win-linux.yml#prepare');
    expect(
      restoresNothingProblems(prepare.workflow, {
        ...prepare.job,
        steps: [...prepare.job.steps, store],
      }).join('\n'),
    ).toMatch(/touches the cache \(extract\)/);
    const { 'cache-mode': _mode, ...prepareAtDefault } = prepare.job;
    expect(restoresNothingProblems(prepare.workflow, prepareAtDefault).join('\n')).toMatch(
      /declares no cache-mode/,
    );
    const windows = real('desktop-build-win-linux.yml#build-windows');
    expect(
      restoresNothingProblems(windows.workflow, {
        ...windows.job,
        steps: windows.job.steps.map((step) =>
          step.uses?.startsWith('pnpm/setup@') ? { ...step, with: { install: false } } : step,
        ),
      }).join('\n'),
    ).toMatch(/does not set cache: false at pnpm\/setup/);
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
