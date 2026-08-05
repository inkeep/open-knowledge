import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildSlackPayload,
  describeVerdict,
  parseArgs,
  recoveryCommand,
} from './build-smoke-alert-payload.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRelease = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'desktop-release.yml'),
  'utf8',
);

/**
 * Exact bounds of the alert step: its `- name:` up to the next sibling step.
 * The fixed-length slices this replaces (400 / 4000 / 5000 chars) could run
 * past the step and assert against a neighbouring step's shell.
 */
const alertStep = () => {
  const rest = desktopRelease.slice(desktopRelease.indexOf('- name: Alert on a blocked release'));
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
    // The responder does different things in each case: a fail is a product
    // regression to investigate; an error may just need a re-run.
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
    });
  });

  test('rejects a missing tag', () => {
    expect(() => parseArgs(argv('--verdict', 'fail'))).toThrow(/--tag/);
  });

  test('defaults an absent verdict to error rather than silently claiming a pass', () => {
    expect(parseArgs(argv('--tag', 'v1')).verdict).toBe('error');
  });
});

describe('workflow wiring', () => {
  test('the alert job fires on a blocked release, never on success', () => {
    // The blocked-release predicate lives at the ALERT JOB level (a failed
    // packaging job skips finalize, so a failure()-step inside finalize
    // could never fire). It keys on finalize's result rather than bare
    // failure() so a degraded-mode cut that still publishes does not page;
    // the step keeps only the stable-only channel gate.
    const alertJob = desktopRelease.slice(
      desktopRelease.indexOf('\n  alert:'),
      desktopRelease.indexOf('- name: Alert on a blocked release'),
    );
    expect(alertJob).toContain("needs.finalize.result != 'success'");
    expect(alertJob).not.toContain('if: success()');
    expect(alertStep()).not.toContain('if: success()');
  });

  test('the alert reads its builder from the workflow commit, not the release tag', () => {
    // On repository_dispatch the workflow runs from the default branch while
    // the packaging jobs check out client_payload.ref — a tag that can predate
    // this script. v0.41.0 lost its Slack announcement to exactly that. The
    // alert job therefore checks out $GITHUB_SHA (a bare checkout, no `ref:`
    // override) and reads the builder from the working tree, degrading to the
    // plain-text payload when even that copy is missing.
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
    // "Introduces none" is a claim about THIS step, so it has to be measured at
    // step scope: every secret the step names must already be consumed
    // elsewhere in the workflow. Scanning the whole file for the secret the
    // step uses proves nothing — the announcement steps reference it too, so
    // the assertion holds even if this step is deleted outright.
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
    // Unset secret: annotate and return 0 — never fail the step.
    expect(step).toContain('::notice::${label} webhook not set');
    expect(step).toMatch(/if \[\[ -z "\$webhook" \]\]; then[\s\S]{0,200}?return 0/);
    // A dead webhook warns; it must not mask the smoke failure that caused it.
    expect(step).toContain('::warning::${label} smoke alert failed to POST');
    // The channel is actually driven, and through the releases-first
    // resolution rather than straight at the shared secret.
    expect(step).toContain('post "${SLACK_RELEASES_WEBHOOK_URL:-${SLACK_WEBHOOK_URL:-}}" Slack');
  });

  test('a blocked release never pages Discord', () => {
    // Rationale: this module's docstring. This test is the ratchet for it.
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
