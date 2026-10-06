// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expression fixtures must remain literal.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { credentialReasons } from './workflow-credentials.test-helper.mjs';

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const RELEASE_SIGNING_SECRETS = [
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK',
];
const OTHER_SECRETS = [
  'DISCORD_NOTIFY_TOKEN',
  'DISCORD_NOTIFY_URL',
  'DISCORD_WEBHOOK_URL',
  'INTERNAL_CI_APP_PRIVATE_KEY',
  'LINEAR_ACCESS_KEY',
  'LINEAR_API_KEY',
  'LINUX_REPO_GPG_PRIVATE_KEY',
  'LINUX_REPO_R2_ACCESS_KEY_ID',
  'LINUX_REPO_R2_ENDPOINT',
  'LINUX_REPO_R2_SECRET_ACCESS_KEY',
  'OK_RELEASE_BRIDGE_APP_ID',
  'OK_RELEASE_BRIDGE_APP_PRIVATE_KEY',
  'OSS_SYNC_APP_ID',
  'OSS_SYNC_APP_PRIVATE_KEY',
  'SLACK_RELEASES_WEBHOOK_URL',
  'SLACK_WEBHOOK_URL',
];
const SIGNING_ENVIRONMENT = 'release-signing';
const OTHER_ENVIRONMENTS = ['inkeep-oss-sync'];
const MAIN_ONLY = "${{ github.ref == 'refs/heads/main' && 'release-signing' || '' }}";
const EXPECTED = {
  'desktop-build-win-linux.yml#build-windows': MAIN_ONLY,
  'desktop-build.yml#build-macos-dmg': MAIN_ONLY,
  'desktop-release.yml#build-macos': SIGNING_ENVIRONMENT,
  'desktop-release.yml#build-windows': SIGNING_ENVIRONMENT,
};
const WHOLE_CONTEXT = '*';
const SECRET_READ = /(?<![\w.-])secrets\b(?:\s*\.\s*([A-Za-z_][\w-]*)|\s*\[\s*'([^']*)'\s*\])?/gi;

const JOBS = readdirSync(WORKFLOWS)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort()
  .flatMap((name) => {
    const workflow = parse(readFileSync(join(WORKFLOWS, name), 'utf8'));
    return Object.entries(workflow?.jobs ?? {}).map(([id, job]) => ({
      key: `${name}#${id}`,
      workflow,
      job,
    }));
  });

function secretReads(workflow, job) {
  const reads = [];
  for (const reason of credentialReasons(workflow, job)) {
    if (reason === 'secrets: inherit') reads.push(WHOLE_CONTEXT);
    if (!reason.startsWith('secret: ')) continue;
    for (const [, dotted, indexed] of reason.slice('secret: '.length).matchAll(SECRET_READ)) {
      const name = (dotted ?? indexed)?.toUpperCase() ?? WHOLE_CONTEXT;
      if (name !== 'GITHUB_TOKEN') reads.push(name);
    }
  }
  return reads;
}

const isSigningRead = (name) => name === WHOLE_CONTEXT || RELEASE_SIGNING_SECRETS.includes(name);

function environmentProblem(key, environment) {
  if (Object.hasOwn(EXPECTED, key)) {
    return environment === EXPECTED[key]
      ? null
      : `${key} must request environment ${EXPECTED[key]}, found ${JSON.stringify(environment)}`;
  }
  if (environment === undefined) return null;
  const name = typeof environment === 'string' ? environment : environment?.name;
  if (typeof name !== 'string' || name.includes('${{')) {
    return `${key} computes its environment name; only the two QA signing jobs may`;
  }
  return OTHER_ENVIRONMENTS.includes(name.toLowerCase())
    ? null
    : `${key} requests environment ${name}, which is not in OTHER_ENVIRONMENTS`;
}

function contractProblems(entries) {
  const problems = [];
  const signingReaders = [];
  for (const { key, workflow, job } of entries) {
    const reads = secretReads(workflow, job);
    for (const name of reads) {
      if (!isSigningRead(name) && !OTHER_SECRETS.includes(name)) {
        problems.push(
          `${key} reads secret ${name}, which is in neither RELEASE_SIGNING_SECRETS nor OTHER_SECRETS; classify it`,
        );
      }
    }
    if (reads.some(isSigningRead)) signingReaders.push(key);
    const environment = environmentProblem(key, job.environment);
    if (environment) problems.push(environment);
  }
  const expected = Object.keys(EXPECTED).sort();
  const readers = signingReaders.sort();
  if (readers.join('\n') !== expected.join('\n')) {
    problems.push(
      `jobs reading a release-signing secret are [${readers.join(', ')}]; expected exactly [${expected.join(', ')}]`,
    );
  }
  return problems;
}

const withJob = (job, workflow = {}) => [...JOBS, { key: 'fixture.yml#probe', workflow, job }];
const step = (run) => ({ steps: [{ run }] });

describe('release-signing environment', () => {
  test('every OK workflow job meets the release-signing contract', () => {
    expect(contractProblems(JOBS)).toEqual([]);
  });

  test('reordered jobs keep the contract and a membership change still breaks it', () => {
    const reordered = [...JOBS].reverse();
    expect(contractProblems(reordered)).toEqual([]);
    expect(
      contractProblems(reordered.filter(({ key }) => key !== 'desktop-release.yml#build-macos')),
    ).toContainEqual(expect.stringContaining('jobs reading'));
  });

  test('the secret lists are disjoint and no other environment is release-signing', () => {
    expect(RELEASE_SIGNING_SECRETS.filter((name) => OTHER_SECRETS.includes(name))).toEqual([]);
    expect(OTHER_ENVIRONMENTS.map((name) => name.toLowerCase())).not.toContain(SIGNING_ENVIRONMENT);
  });

  test.each([
    ['an indexed signing secret', withJob(step("${{ secrets['CSC_LINK'] }}")), 'jobs reading'],
    [
      'a signing secret in another casing',
      withJob(step('${{ SECRETS.csc_link }}')),
      'jobs reading',
    ],
    ['the whole secrets context', withJob(step('${{ toJSON(secrets) }}')), 'jobs reading'],
    [
      'a computed secret index',
      withJob(step("${{ secrets[format('{0}_LINK', 'CSC')] }}")),
      'jobs reading',
    ],
    [
      'inherited secrets',
      withJob({ uses: './.github/workflows/x.yml', secrets: 'inherit' }),
      'jobs reading',
    ],
    [
      'a workflow-level signing read',
      withJob({ steps: [] }, { env: { K: '${{ secrets.CSC_LINK }}' } }),
      'jobs reading',
    ],
    ['an unclassified secret', withJob(step('${{ secrets.NEW_SIGNING_KEY }}')), 'classify it'],
    [
      'a computed environment name',
      withJob({ environment: '${{ vars.SIGNING_ENV }}', steps: [] }),
      'computes its environment name',
    ],
    [
      'a computed environment object name',
      withJob({ environment: { name: '${{ vars.SIGNING_ENV }}' }, steps: [] }),
      'computes its environment name',
    ],
    [
      'release-signing in another casing',
      withJob({ environment: 'Release-Signing', steps: [] }),
      'not in OTHER_ENVIRONMENTS',
    ],
  ])('a fabricated job using %s breaks the contract', (_form, entries, problem) => {
    expect(contractProblems(entries)).toContainEqual(expect.stringContaining(problem));
  });

  test.each([
    ['GITHUB_TOKEN in another casing', withJob(step('${{ Secrets.github_token }}'))],
    ['a classified non-signing secret', withJob(step("${{ secrets['SLACK_WEBHOOK_URL'] }}"))],
    ['a property named secrets on another context', withJob(step('${{ inputs.secrets }}'))],
    ['an allowlisted environment', withJob({ environment: 'inkeep-oss-sync', steps: [] })],
  ])('a fabricated job using %s keeps the contract', (_form, entries) => {
    expect(contractProblems(entries)).toEqual([]);
  });
});
