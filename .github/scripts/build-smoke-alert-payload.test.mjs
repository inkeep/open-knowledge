import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildSlackPayload,
  describeBlock,
  describeVerdict,
  parseArgs,
  recoveryCommand,
} from './build-smoke-alert-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRelease = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'desktop-release.yml'),
  'utf8',
);

const alertStep = (source = desktopRelease) => {
  const start = source.indexOf('- name: Alert on a blocked release');
  if (start === -1) throw new Error('desktop-release.yml has no "Alert on a blocked release" step');
  const rest = source.slice(start);
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};

const base = {
  tag: 'v1.2.3',
  verdict: 'fail',
  reason: '2 of 16 executed smoke tests failed against the packaged app',
  runUrl: 'https://github.com/inkeep/open-knowledge/actions/runs/999',
};

describe('alert content', () => {
  test('names the tag, verdict, run link, and recovery command', () => {
    const slack = JSON.stringify(buildSlackPayload(base));
    for (const needle of ['v1.2.3', 'fail', base.runUrl, 'event_type=desktop-release']) {
      expect(slack).toContain(needle);
    }
  });

  test('states that nothing shipped', () => {
    const slack = JSON.stringify(buildSlackPayload(base));
    expect(slack).toContain('nothing shipped');
    expect(slack).toContain('DRAFT');
    expect(slack).toContain('npm `latest` has NOT moved');
  });

  test('a genuine failure and an infrastructure error read differently', () => {
    const fail = JSON.stringify(buildSlackPayload({ ...base, verdict: 'fail' }));
    const error = JSON.stringify(buildSlackPayload({ ...base, verdict: 'error' }));
    expect(fail).not.toBe(error);
    expect(fail).toContain('FAILED');
    expect(error).toContain('ERRORED');
    expect(fail).toContain('real product regression');
    expect(error).toContain('never reached a verdict');
    expect(describeVerdict('fail').short).not.toBe(describeVerdict('error').short);
  });

  test('the recovery command re-fires the cascade for the right tag', () => {
    expect(recoveryCommand('v9.9.9')).toContain('client_payload[release_tag]=v9.9.9');
    expect(recoveryCommand('v9.9.9', 'acme/fork')).toContain('repos/acme/fork/dispatches');
  });

  test('recovery points at the cause instead of promising a repair-free retry', () => {
    const body = buildSlackPayload(base).blocks[1].text.text;
    expect(body).toContain('*Recovery');
    expect(body).toContain('fix the cause');
    expect(body).not.toContain('no manual repair needed');
  });
});

describe('a passing smoke is never rendered as a smoke failure', () => {
  const linuxBlocked = {
    ...base,
    verdict: 'pass',
    reason: 'all 13 executed smoke tests passed against the packaged app (0 flaky, 3 skipped)',
    blockedBy: 'Linux packaging',
  };

  test('the headline names the failing stage, not the smoke', () => {
    const text = buildSlackPayload(linuxBlocked).text;
    expect(text).toContain('Linux packaging');
    expect(text).not.toContain('DMG smoke ERRORED');
    expect(text).not.toContain('DMG smoke FAILED');
    expect(text).toContain('RELEASE BLOCKED');
    expect(text).toContain('nothing shipped');
  });

  test('the body does not pair an error verdict with a passing reason', () => {
    const body = buildSlackPayload(linuxBlocked).blocks[1].text.text;
    expect(body).toContain('Linux packaging failed');
    expect(body).toContain('NOT an app regression');
    expect(body).toContain('smoke itself passed');
  });

  test('the verdict line is labelled as the smoke’s, not the release’s', () => {
    const body = buildSlackPayload(linuxBlocked).blocks[1].text.text;
    expect(body).toContain('*Smoke verdict:*');
  });

  test('a genuine smoke failure is unaffected by the blocking-stage plumbing', () => {
    const failed = buildSlackPayload({ ...base, verdict: 'fail', blockedBy: 'macOS packaging' });
    expect(failed.text).toContain('DMG smoke FAILED');
    expect(JSON.stringify(failed)).toContain('real product regression');
  });

  test('a pass with no known blocking stage still reads as blocked, not as a pass', () => {
    const vague = buildSlackPayload({ ...base, verdict: 'pass', blockedBy: '' });
    expect(vague.text).toContain('RELEASE BLOCKED');
    expect(vague.text).toContain('nothing shipped');
    expect(JSON.stringify(vague)).toContain('NOT an app regression');
  });

  test('a no-verdict blocked release still names the job that failed', () => {
    const noVerdict = buildSlackPayload({
      ...base,
      verdict: 'error',
      reason: 'the release pipeline failed before completing — see the run',
      blockedBy: 'macOS packaging',
    });
    expect(noVerdict.text).toContain('macOS packaging');
    expect(noVerdict.text).not.toContain('DMG smoke ERRORED');
    const body = noVerdict.blocks[1].text.text;
    expect(body).toContain('macOS packaging failed');
    expect(body).toContain('never reached a verdict');
    expect(body).not.toContain('smoke itself passed');
  });

  test('an error with no known stage keeps the original gate wording', () => {
    const vague = buildSlackPayload({ ...base, verdict: 'error', blockedBy: '' });
    expect(vague.text).toContain('DMG smoke ERRORED');
  });

  test('describeBlock separates the smoke verdict from the release outcome', () => {
    expect(describeBlock({ verdict: 'pass', blockedBy: 'Linux packaging' }).smokePassed).toBe(true);
    expect(describeBlock({ verdict: 'fail' }).smokePassed).toBe(false);
    expect(describeBlock({ verdict: 'error' }).smokePassed).toBe(false);
    expect(describeBlock({}).smokePassed).toBe(false);
    expect(describeBlock({}).subject).toContain('ERRORED');
  });
});

describe('distinctness from the routine release announcement', () => {
  test('does not reuse the celebratory headline', () => {
    const slack = JSON.stringify(buildSlackPayload(base));
    expect(slack).not.toContain('🎉');
    expect(slack).not.toContain('released');
    expect(slack).toContain('🚨');
    expect(slack).toContain('RELEASE BLOCKED');
  });

  test('uses Slack mrkdwn bold', () => {
    expect(buildSlackPayload(base).blocks[1].text.text).toContain('*Tag:*');
  });
});

describe('escaping', () => {
  test('quotes and newlines in interpolated values cannot corrupt the JSON', () => {
    const nasty = {
      ...base,
      tag: 'v1.0.0"; rm -rf /; echo "',
      reason: 'line one\nline "two" \\ backslash',
    };
    const slack = buildSlackPayload(nasty);
    const roundTripped = JSON.parse(JSON.stringify(slack));
    expect(roundTripped.text).toContain('v1.0.0"; rm -rf /; echo "');
    expect(JSON.stringify(slack)).toContain('line one\\nline');
  });
});

describe('parseArgs', () => {
  const argv = (...rest) => ['node', 'x', ...rest];

  test('reads every flag the workflow step passes', () => {
    const parsed = parseArgs(
      argv(
        '--tag',
        'v1.2.3',
        '--verdict',
        'error',
        '--reason',
        'mount failed',
        '--run-url',
        'https://example.test/run',
      ),
    );
    expect(parsed).toEqual({
      tag: 'v1.2.3',
      verdict: 'error',
      reason: 'mount failed',
      runUrl: 'https://example.test/run',
      repo: 'inkeep/open-knowledge',
      blockedBy: '',
    });
  });

  test('reads the blocking-stage list', () => {
    const parsed = parseArgs(argv('--tag', 'v1', '--blocked-by', 'Linux packaging'));
    expect(parsed.blockedBy).toBe('Linux packaging');
  });

  test('rejects a missing tag', () => {
    expect(() => parseArgs(argv('--verdict', 'fail'))).toThrow(/--tag/);
  });

  test('defaults an absent verdict to error rather than silently claiming a pass', () => {
    expect(parseArgs(argv('--tag', 'v1')).verdict).toBe('error');
  });
});

describe('workflow wiring', () => {
  test('alertStep() throws on a missing step instead of slicing one character', () => {
    expect(() => alertStep('name: nothing that matches\n')).toThrow(
      /has no "Alert on a blocked release" step/,
    );
  });

  test('the alert job fires on a blocked release, never on success', () => {
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alertJob).toContain("needs.finalize.result != 'success'");
    expect(alertJob).not.toContain('if: success()');
    expect(alertStep()).not.toContain('if: success()');
  });

  test('the alert reads its builder from the workflow commit, not the release tag', () => {
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alertJob).toContain('actions/checkout');
    expect(alertJob).not.toContain('ref: ${{ github.event.client_payload.ref');
    const step = alertStep();
    expect(step).toContain('-f .github/scripts/build-smoke-alert-payload.mjs');
    expect(step).toContain('node .github/scripts/build-smoke-alert-payload.mjs --tag');
  });

  test('the alert reuses the existing webhook secret and introduces none', () => {
    expect(alertStep()).toContain('secrets.SLACK_WEBHOOK_URL');
    const secretsIn = (yaml) =>
      new Set([...yaml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    const stepSecrets = secretsIn(alertStep());
    const elsewhere = secretsIn(desktopRelease.split(alertStep()).join(''));
    expect(stepSecrets.size).toBeGreaterThan(0);
    for (const name of stepSecrets) {
      expect(elsewhere.has(name), `${name} is introduced by the alert step`).toBe(true);
    }
  });

  test('an unset webhook is a notice-level skip, and a failed POST is a warning', () => {
    const step = alertStep();
    expect(step).toContain('::notice::${label} webhook not set');
    expect(step).toMatch(/if \[\[ -z "\$webhook" \]\]; then[\s\S]{0,200}?return 0/);
    expect(step).toContain('::warning::${label} smoke alert failed to POST');
    expect(step).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
  });

  test('a passing smoke verdict is not coerced into an error', () => {
    const step = alertStep();
    expect(step).not.toMatch(/if \[\[ "\$VERDICT" != "fail" \]\]/);
    expect(step).toContain('VERDICT="${SMOKE_VERDICT:-error}"');
    expect(step).toMatch(/skipped.*\]\]; then\s*\n\s*VERDICT="error"/);
  });

  test('the alert tells the payload builder which jobs actually failed', () => {
    const step = alertStep();
    expect(step).toContain('--blocked-by "$BLOCKED_BY"');
    for (const src of ['RESULT_LINUX', 'RESULT_WINDOWS', 'RESULT_MACOS', 'RESULT_PUBLISH']) {
      expect(step).toContain(src);
    }
    expect(step).toContain('== "failure"');
  });

  test('only REQUIRED platforms count as blockers', () => {
    const step = alertStep();
    expect(step).toContain('REQUIRED_PLATFORMS');
    expect(step).toContain('is_required()');
    for (const platform of ['mac', 'windows', 'linux']) {
      expect(step).toContain(`is_required ${platform}`);
    }
    expect(step).toMatch(/RESULT_PREPARE.*==\s*"failure".*\]\]\s*&&\s*blocked\+=/);
  });

  test('the alert job can see every packaging job it reports on', () => {
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    for (const job of ['build-macos', 'build-windows', 'build-linux', 'publish-assets']) {
      expect(alertJob).toContain(job);
    }
  });

  test('a blocked release never pages Discord', () => {
    const step = alertStep();
    expect(step).not.toMatch(/^\s*post\s+.*Discord\s*$/m);
    expect(step).not.toContain('DISCORD_WEBHOOK_URL');
  });

  test('the annotation is emitted in addition to the page, not instead of it', () => {
    const step = alertStep();
    const slackAt = step.indexOf('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
    const annotationAt = step.indexOf('::error::RELEASE BLOCKED');
    expect(slackAt).toBeGreaterThan(-1);
    expect(annotationAt).toBeGreaterThan(slackAt);
  });
});
