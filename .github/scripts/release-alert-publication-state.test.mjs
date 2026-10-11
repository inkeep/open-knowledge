import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function step(file, job, name) {
  const workflow = parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8'));
  const found = workflow.jobs[job].steps.find((entry) => entry.name === name);
  expect(found).toBeDefined();
  return found.run;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ok-release-alert-state-'));
  scratch.push(dir);
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      CAPTURE: join(dir, 'curl-args'),
      CALLS: join(dir, 'gh-calls'),
      GITHUB_OUTPUT: join(dir, 'outputs'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'test/release',
      GITHUB_RUN_ID: '123',
      GITHUB_EVENT_NAME: 'repository_dispatch',
      RELEASE_TAG: 'v1.2.3',
      VERSION: '1.2.3',
      CHANNEL: 'latest',
      SMOKE_VERDICT: 'pass',
      SMOKE_REASON: 'all smoke tests passed',
      REQUIRED_PLATFORMS: 'mac,windows,linux',
      RESULT_PREPARE: 'success',
      RESULT_MACOS: 'success',
      RESULT_WINDOWS: 'success',
      RESULT_LINUX: 'success',
      RESULT_PUBLISH: 'success',
      RESULT_FINALIZE: 'failure',
      SLACK_RELEASES_WEBHOOK_URL: 'https://example.test/slack',
    },
  };
}

function run(script, env, cwd = ROOT) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function alert(context, { fallback = false, curlStatus = 0, env = {} } = {}) {
  const result = run(
    `curl() { printf '%s\\0' "$@" > "$CAPTURE"; return ${curlStatus}; }\n${step('desktop-release.yml', 'alert', 'Alert on a blocked release (FR5c)')}`,
    { ...context.env, ...env },
    fallback ? context.dir : ROOT,
  );
  expect(result.status, result.stderr).toBe(0);
  const args = readFileSync(context.env.CAPTURE, 'utf8').split('\0');
  const payload = JSON.parse(args[args.indexOf('--data') + 1]);
  return { result, args, payload };
}

function expectUnknownPublication({ result, payload }) {
  const message = JSON.stringify(payload);
  expect(message).toContain('https://github.com/test/release/actions/runs/123');
  expect(message).toMatch(/publication may have completed/i);
  expect(message).not.toMatch(/nothing shipped|still a DRAFT|has NOT moved/);
  expect(result.stdout).not.toMatch(/stays a draft|npm latest is untouched|nothing shipped/);
}

test.each([false, true])(
  'a failed npm dispatch after the publication PATCH reports uncertainty with fallback %s',
  (fallback) => {
    const context = fixture();
    const gh = `gh() {
  printf '%s\\n' "$*" >> "$CALLS"
  if [[ "$1 $2" == 'release edit' ]]; then return 0; fi
  if [[ "$1 $2 $3" == 'api -X POST' ]]; then return 1; fi
  return 99
}`;
    const published = run(
      `${gh}\n${step('desktop-release.yml', 'finalize', 'Promote draft release to published')}`,
      context.env,
    );
    expect(published.status, published.stderr).toBe(0);
    expect(readFileSync(context.env.CALLS, 'utf8')).toContain(
      'release edit v1.2.3 --draft=false --latest',
    );
    expect(readFileSync(context.env.GITHUB_OUTPUT, 'utf8')).toBe('published=true\n');
    const dispatched = run(
      `${gh}\n${step('desktop-release.yml', 'finalize', 'Trigger release.yml to publish stable to npm')}`,
      context.env,
    );
    expect(dispatched.status).toBe(1);
    expect(readFileSync(context.env.CALLS, 'utf8')).toContain('api -X POST repos/test/release/dispatches');
    const observed = alert(context, { fallback });
    expect(observed.payload.text).toContain('finalize');
    if (fallback) expect(observed.result.stdout).toContain('payload builder unavailable');
    expectUnknownPublication(observed);
  },
);

test.each([0, 28])('an upstream packaging failure remains the diagnosis with webhook exit %s', (curlStatus) => {
  const observed = alert(fixture(), {
    curlStatus,
    env: { RESULT_LINUX: 'failure', RESULT_PUBLISH: 'skipped', RESULT_FINALIZE: 'skipped' },
  });
  expect(observed.payload.text).toContain('Linux packaging');
  expect(observed.payload.text).not.toContain('finalize');
  expect(JSON.stringify(observed.payload)).toContain('smoke itself passed');
  expectUnknownPublication(observed);
  expect(observed.args[observed.args.indexOf('--connect-timeout') + 1]).toBe('10');
  expect(observed.args[observed.args.indexOf('--max-time') + 1]).toBe('30');
  if (curlStatus === 28) expect(observed.result.stdout).toContain('delivery is unconfirmed');
});

test('a follower failure reports the failed retry without inferring publication state', () => {
  const context = fixture();
  const result = run(
    `curl() { printf '%s\\0' "$@" > "$CAPTURE"; return 0; }\n${step('desktop-release-auto-retry.yml', 'rerun', 'Alert when the automatic re-run could not start')}`,
    { ...context.env, RUN_URL: 'https://github.com/test/release/actions/runs/123', RUN_ID: '123' },
  );
  expect(result.status, result.stderr).toBe(0);
  const args = readFileSync(context.env.CAPTURE, 'utf8').split('\0');
  const payload = JSON.parse(args[args.indexOf('--data') + 1]);
  expect(payload.text).toContain('automatic re-run');
  expect(payload.text).toContain('could not start');
  expectUnknownPublication({ result, payload });
});

test.each([0, 28])('Discord reports only the request outcome with curl exit %s', (curlStatus) => {
  const context = fixture();
  const webhook = 'https://example.test/discord?thread_id=123&wait=false';
  const result = run(
    `gh() { printf 'release notes'; }
timeout() { shift 2; "$@"; }
curl() {
  printf 'attempt\\n' >> "$CALLS"
  printf '%s\\0' "$@" > "$CAPTURE"
  return ${curlStatus}
}
${step('desktop-release.yml', 'finalize', 'Announce stable release to Discord')}`,
    { ...context.env, DISCORD_WEBHOOK_URL: webhook },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(context.env.CALLS, 'utf8')).toBe('attempt\n');
  const args = readFileSync(context.env.CAPTURE, 'utf8').split('\0');
  expect(args).toContain(webhook);
  expect(JSON.parse(args[args.indexOf('--data') + 1]).content).toContain('1.2.3');
  if (curlStatus === 0) {
    expect(result.stdout).toContain('Discord announcement request completed for v1.2.3');
    expect(result.stdout).toContain('saved-message confirmation not checked');
  } else {
    expect(result.stdout).toContain('::warning::Discord announcement failed');
    expect(result.stdout).not.toContain('Discord announcement request completed');
  }
  expect(result.stdout).not.toContain('Posted stable-release announcement');
});
