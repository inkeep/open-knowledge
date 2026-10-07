import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { classifyFailedJob, decideRetry, RETRYABLE_OUTCOMES } from './decide-release-retry.mjs';
import { STOP_OUTCOMES } from './retry-transient.mjs';

const failure = (message) => ({ level: 'failure', message });
const notice = (message) => ({ level: 'notice', message });
const EXIT_1 = failure('Process completed with exit code 1.');
const stop = (outcome, reason = 'rule:timestamp-missing') =>
  failure(
    `electron-builder (macOS) decision=stop reason=${reason} outcome=${outcome} attempt=3/3 code=1 signal=none`,
  );

const stable = {
  tag: 'v0.83.0',
  channel: 'latest',
  runAttempt: 1,
  smokeVerdict: '',
  latestStable: 'v0.82.3',
};
const macFailed = (annotations) => [
  { name: 'prepare', conclusion: 'success', annotations: [] },
  { name: 'build-macos (stable)', conclusion: 'failure', annotations },
  { name: 'build-windows (stable)', conclusion: 'success', annotations: [] },
  { name: 'publish-assets', conclusion: 'skipped', annotations: [] },
];

describe('classifyFailedJob', () => {
  test.each([
    [
      'an Apple notarization attempt timeout',
      [EXIT_1, stop('attempt-timeout', 'control:attempt-timeout')],
    ],
    ['an exhausted transient Apple error', [EXIT_1, stop('transient-exhausted')]],
    ['a wrapper deadline', [EXIT_1, stop('deadline', 'control:deadline')]],
    ['a corrupted download', [EXIT_1, stop('terminal', 'rule:download-integrity')]],
    [
      'a lost hosted runner',
      [
        failure(
          'The hosted runner lost communication with the server. Anything in your workflow that terminates the runner process can cause this error.',
        ),
      ],
    ],
    [
      'an artifact upload timeout',
      [failure('Failed to FinalizeArtifact: Unable to make request: ETIMEDOUT')],
    ],
    ['a release upload outage', [failure('gh release upload failed after 3 attempts.')]],
    [
      'a job timeout',
      [
        failure('The job has exceeded the maximum execution time of 45m0s'),
        failure('The operation was canceled.'),
      ],
    ],
  ])('re-runs %s', (_label, annotations) => {
    expect(classifyFailedJob(annotations).retryable).toBe(true);
  });

  test.each([
    ['a terminal packaging error', [EXIT_1, stop('terminal', 'rule:missing-executable')]],
    [
      'an unknown error that already used its retry',
      [EXIT_1, stop('unknown-exhausted', 'diagnostic:unknown')],
    ],
    [
      'a failure with no recognized cause',
      [EXIT_1, notice('Signing creds present — running signed build.')],
    ],
    [
      'a broken toolchain step',
      [
        failure(
          'Error: The requested pnpm version "10.33.0" resolved to 10.33.0, but this action only installs pnpm v11 or newer.',
        ),
      ],
    ],
    [
      'a retryable cause beside an unrecognized error',
      [
        stop('transient-exhausted'),
        failure('No .dmg found under packages/desktop/dist-desktop for v0.83.0'),
      ],
    ],
    [
      'a human cancellation',
      [failure('The run was canceled by @someone.'), failure('The operation was canceled.')],
    ],
  ])('pages on %s', (_label, annotations) => {
    expect(classifyFailedJob(annotations).retryable).toBe(false);
  });

  test('every wrapper stop outcome is either re-run or deliberately paged', () => {
    const paged = STOP_OUTCOMES.filter((outcome) => !RETRYABLE_OUTCOMES.includes(outcome));
    expect(paged).toEqual([
      'terminal',
      'unknown-exhausted',
      'child-signal',
      'spawn-failure',
      'cleanup-failure',
    ]);
    expect(RETRYABLE_OUTCOMES.every((outcome) => STOP_OUTCOMES.includes(outcome))).toBe(true);
  });
});

describe('decideRetry', () => {
  const timedOut = macFailed([EXIT_1, stop('attempt-timeout', 'control:attempt-timeout')]);

  test('re-runs a first stable attempt whose every failure is retryable', () => {
    expect(decideRetry({ ...stable, jobs: timedOut })).toEqual({
      action: 'retry',
      reason: 'build-macos (stable): outcome=attempt-timeout reason=control:attempt-timeout',
    });
  });

  test('re-runs when several platforms each failed retryably', () => {
    const jobs = [
      ...timedOut,
      {
        name: 'build-linux (stable, ubuntu-latest)',
        conclusion: 'failure',
        annotations: [failure('Failed to FinalizeArtifact: Unable to make request: ETIMEDOUT')],
      },
    ];
    expect(decideRetry({ ...stable, jobs }).action).toBe('retry');
  });

  test('pages when any one failed job is not retryable, and names it', () => {
    const jobs = [
      ...timedOut,
      {
        name: 'build-windows (stable)',
        conclusion: 'failure',
        annotations: [EXIT_1, stop('terminal', 'rule:missing-executable')],
      },
    ];
    expect(decideRetry({ ...stable, jobs })).toEqual({
      action: 'page',
      reason: 'build-windows (stable): outcome=terminal reason=rule:missing-executable',
    });
  });

  test('pages on the second attempt, so the automatic re-run happens once', () => {
    expect(decideRetry({ ...stable, runAttempt: 2, jobs: timedOut })).toEqual({
      action: 'page',
      reason: 'attempt 2 is already a re-run',
    });
  });

  test('names a newer stable or a failed smoke on attempt 2 instead of the attempt count', () => {
    expect(
      decideRetry({ ...stable, runAttempt: 2, latestStable: 'v0.84.0', jobs: timedOut }).reason,
    ).toBe('a newer stable v0.84.0 has already shipped');
    expect(
      decideRetry({ ...stable, runAttempt: 2, smokeVerdict: 'fail', jobs: timedOut }).reason,
    ).toBe('the packaged app failed the DMG smoke');
  });

  test('pages on a real smoke failure even beside a retryable cause', () => {
    expect(decideRetry({ ...stable, smokeVerdict: 'fail', jobs: timedOut }).action).toBe('page');
  });

  test('never re-runs a tag a newer stable has superseded', () => {
    expect(decideRetry({ ...stable, latestStable: 'v0.84.0', jobs: timedOut })).toEqual({
      action: 'page',
      reason: 'a newer stable v0.84.0 has already shipped',
    });
  });

  test('re-runs when no stable has shipped yet', () => {
    expect(decideRetry({ ...stable, latestStable: null, jobs: timedOut }).action).toBe('retry');
  });

  test('leaves beta cuts alone', () => {
    expect(decideRetry({ ...stable, channel: 'beta', jobs: timedOut }).action).toBe('page');
  });

  test('pages when finalize did not succeed but no job failed', () => {
    expect(decideRetry({ ...stable, jobs: macFailed([]).slice(0, 1) })).toEqual({
      action: 'page',
      reason: 'no failed job to re-run',
    });
  });

  test('ignores a failed platform the cut does not require', () => {
    const jobs = [
      ...timedOut,
      {
        name: 'build-windows (stable)',
        conclusion: 'failure',
        annotations: [EXIT_1, stop('terminal', 'rule:missing-executable')],
      },
    ];
    expect(decideRetry({ ...stable, jobs, requiredPlatforms: ['mac', 'linux'] }).action).toBe(
      'retry',
    );
    expect(decideRetry({ ...stable, jobs }).action).toBe('page');
  });

  test('re-runs a timed-out job, which GitHub reports as cancelled', () => {
    const jobs = [
      {
        name: 'build-linux (stable, ubuntu-latest)',
        conclusion: 'cancelled',
        annotations: [
          failure('The job has exceeded the maximum execution time of 45m0s'),
          failure('The operation was canceled.'),
        ],
      },
    ];
    expect(decideRetry({ ...stable, jobs }).action).toBe('retry');
  });

  test('counts a cancelled job as failed', () => {
    const jobs = [{ name: 'build-macos (stable)', conclusion: 'cancelled', annotations: [EXIT_1] }];
    expect(decideRetry({ ...stable, jobs }).action).toBe('page');
  });
});

describe('finalize refuses to promote a superseded stable on a re-run', () => {
  const finalize = parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'desktop-release.yml'),
      'utf8',
    ),
  ).jobs.finalize;
  const step = finalize.steps.find(
    (candidate) => candidate.name === 'Refuse to promote a superseded stable on a re-run',
  );
  const dir = mkdtempSync(join(tmpdir(), 'ok-supersede-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'gh'),
    '#!/usr/bin/env bash\nif [[ -n "$STUB_ERR" ]]; then echo "$STUB_ERR" >&2; exit 1; fi\necho "$STUB_LATEST"\n',
    { mode: 0o755 },
  );
  const run = (env) =>
    spawnSync('bash', ['-c', step.run], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        RUNNER_TEMP: dir,
        GITHUB_REPOSITORY: 'inkeep/open-knowledge',
        GITHUB_RUN_ATTEMPT: '2',
        RELEASE_TAG: 'v0.83.0',
        STUB_LATEST: '',
        STUB_ERR: '',
        ...env,
      },
      encoding: 'utf8',
    });

  test('only guards re-runs that can stamp Latest', () => {
    expect(step.if).toContain("github.run_attempt != '1'");
    expect(step.if).toContain("github.event_name != 'workflow_dispatch'");
  });

  test.each([
    ['the tag is the latest stable', { STUB_LATEST: 'v0.83.0' }, 0],
    ['an older stable is latest', { STUB_LATEST: 'v0.82.9' }, 0],
    ['no stable has shipped', { STUB_ERR: 'gh: Not Found (HTTP 404)' }, 0],
    ['a newer stable shipped', { STUB_LATEST: 'v0.83.1' }, 1],
    ['a newer minor shipped', { STUB_LATEST: 'v0.100.0' }, 1],
    ['the lookup failed', { STUB_ERR: 'gh: Server Error (HTTP 502)' }, 1],
  ])('exits %#: %s', (_label, env, status) => {
    expect(run(env).status).toBe(status);
  });
});
